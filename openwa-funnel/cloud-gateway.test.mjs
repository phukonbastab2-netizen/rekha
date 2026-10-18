import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Engine} from './engine.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,description){
 for(let n=0;n<120;n++){const result=await read();if(predicate(result))return result;await wait(30);}
 assert.fail(description);
}
async function fixture(t,respond,{mobile=true,seedCount=1}={}){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-cloud-gateway-'));
 const db=new Engine(path.join(temp,'funnel.sqlite'));
 for(let n=0;n<seedCount;n++)db.put({key:'cloud-quota-test-'+n,kind:'settings',ownerNote:'local-only-test-data'});db.close();
 const requests=[],children=[];
 const api=http.createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer private-test-backup-token');
  let raw='';for await(const chunk of req)raw+=chunk;
  const call={route:req.url,body:raw?JSON.parse(raw):null};requests.push(call);
  const response=await respond(call);
  res.writeHead(response?.status||200,{'Content-Type':'application/json',...(response?.headers||{})});
  res.end(JSON.stringify(response?.body??(req.url==='/sync'?{acknowledged:call.body.changes.at(-1).seq}:{commands:[]})));
 });
 await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const cloud='http://127.0.0.1:'+api.address().port,base='http://127.0.0.1:14350';
 async function stop(child){
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
 }
 t.after(async()=>{
  for(const child of children)await stop(child);
  api.closeAllConnections();await new Promise(resolve=>api.close(resolve));
  fs.rmSync(temp,{recursive:true,force:true});
 });
 async function start(){
  const child=spawn(process.execPath,['gateway.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),windowsHide:true,env:{...process.env,PORT:'14350',OWNER_TUNNEL_PORT:'',REKHA_DATA_DIR:temp,AUTO_CONNECT:'false',WHATSAPP_PROVIDER:'openwa-gateway',OPENWA_RECOVER_MISSED_LEADS:'false',CLOUD_BACKUP_URL:cloud,CLOUD_BACKUP_TOKEN:'private-test-backup-token',MOBILE_ADMIN_ENABLED:mobile?'true':'false'},stdio:['ignore','pipe','pipe']});
  children.push(child);let logs='';child.stderr.on('data',chunk=>logs+=chunk);child.stdout.resume();
  let page;
  for(let n=0;n<120;n++){
   if(child.exitCode!==null)assert.fail('Gateway stopped '+child.exitCode+' '+logs);
   try{page=await fetch(base);if(page.ok)break;}catch{}
   await wait(30);
  }
  assert.ok(page?.ok,'Gateway startup timed out '+logs);
  const cookie=page.headers.get('set-cookie').split(';')[0];
  const get=async route=>(await fetch(base+route,{headers:{Cookie:cookie}})).json();
  const post=(route,origin=base,authenticated=true)=>fetch(base+route,{method:'POST',headers:{Origin:origin,Cookie:authenticated?cookie:'','Content-Type':'application/json'},body:'{}'});
  return{child,get,post,stop:()=>stop(child)};
 }
 return{start,temp,cloud,requests,marker:path.join(temp,'cloud-quota.json')};
}

test('D1 quota pauses all cloud writes, persists across restart, and owner retry replays only unacknowledged changes',async t=>{
 const retryAt=Date.now()+15*60000;
 let quota=true;
 const f=await fixture(t,async call=>{
  if(call.route==='/sync'&&quota)return{status:503,headers:{'Retry-After':'900'},body:{code:'D1_WRITE_QUOTA',retryAt,error:'provider-secret-must-not-be-exposed'}};
  if(call.route==='/bridge/poll')await wait(70); // A stale success must not clear the concurrent quota failure.
 });
 let gateway=await f.start();
 let status=await until(()=>gateway.get('/api/status'),s=>s.cloud==='quota_paused','Quota state was not surfaced');
 assert.equal(status.cloudRetryAt,retryAt);assert.equal(status.cloudErrorCode,'D1_WRITE_QUOTA');assert.equal(status.cloudPausePersisted,true);
 assert.equal(status.lastBackup,null);assert.ok(status.backupPending>0);assert.equal(status.mobileAdminEnabled,true);
 assert.doesNotMatch(JSON.stringify(status),/provider-secret|private-test-backup-token|local-only-test-data/);
 const monitor=await gateway.get('/api/monitor');
 assert.equal(monitor.cloud.state,'quota_paused');assert.equal(monitor.cloud.retryAt,retryAt);assert.equal(monitor.cloud.errorCode,'D1_WRITE_QUOTA');assert.equal(monitor.cloud.pausePersisted,true);
 const original=f.requests.find(r=>r.route==='/sync').body.changes;
 const marker=JSON.parse(fs.readFileSync(f.marker,'utf8'));
 assert.equal(marker.retryAt,retryAt);assert.doesNotMatch(JSON.stringify(marker),/Bearer|private-test-backup-token|local-only-test-data/);
 await wait(5300); // Covers the five-second mobile poll without letting it hammer D1.
 assert.equal(f.requests.filter(r=>r.route==='/sync').length,1);
 assert.equal(f.requests.filter(r=>r.route==='/bridge/poll').length,1);
 assert.equal((await gateway.get('/api/status')).cloud,'quota_paused');
 await gateway.stop();
 const beforeRestart=f.requests.length;
 gateway=await f.start();status=await gateway.get('/api/status');
 assert.equal(status.cloud,'quota_paused');assert.equal(status.cloudRetryAt,retryAt);assert.equal(f.requests.length,beforeRestart);
 assert.equal((await gateway.post('/api/cloud-retry','https://foreign.test')).status,403);
 assert.equal((await gateway.post('/api/cloud-retry',undefined,false)).status,401);
 assert.equal(f.requests.length,beforeRestart);
 quota=false;
 assert.equal((await gateway.post('/api/cloud-retry')).status,200);
 status=await until(()=>gateway.get('/api/status'),s=>s.cloud==='synced'&&s.backupPending===0,'Backup did not resume');
 const resumed=f.requests.filter(r=>r.route==='/sync').at(-1).body.changes;
 assert.deepEqual(resumed,original);assert.equal(status.cloudRetryAt,null);assert.equal(status.cloudErrorCode,null);assert.ok(status.lastBackup);
 assert.equal(fs.existsSync(f.marker),false);
});

test('expired quota retries on startup without owner action and disabled mobile admin makes no cloud bridge calls',async t=>{
 let allowAck=false;
 const f=await fixture(t,async call=>{
  if(call.route==='/sync'&&!allowAck)return{status:503,body:{error:'Temporary outage'}};
 },{mobile:false});
 const now=Date.now();
 fs.writeFileSync(f.marker,JSON.stringify({version:1,endpointHash:createHash('sha256').update(f.cloud).digest('hex'),code:'D1_WRITE_QUOTA',observedAt:now-120000,retryAt:now-60000}));
 let gateway=await f.start();
 let status=await until(()=>gateway.get('/api/status'),s=>s.cloud==='retrying','Expired quota was not retried');
 assert.ok(status.backupPending>0);assert.equal(status.lastBackup,null);assert.equal(status.mobileAdminEnabled,false);
 assert.equal((await gateway.post('/api/mobile-link')).status,409);
 await wait(5300);
 assert.equal(f.requests.some(r=>r.route.startsWith('/bridge/')),false);
 await gateway.stop();allowAck=true;
 gateway=await f.start();
 status=await until(()=>gateway.get('/api/status'),s=>s.cloud==='synced'&&s.backupPending===0,'Expired quota did not recover after restart');
 assert.equal(status.cloudRetryAt,null);assert.equal(status.cloudErrorCode,null);assert.equal(fs.existsSync(f.marker),false);
 assert.equal(f.requests.some(r=>r.route.startsWith('/bridge/')),false);
});

test('only typed quota failures persist a bounded pause; Retry-After is supported and endpoint changes do not inherit the pause',async t=>{
 let mode='generic';
 const f=await fixture(t,call=>{
  if(call.route!=='/sync')return;
  if(mode==='generic')return{status:503,headers:{'Retry-After':'99999999'},body:{code:'UNRELATED_FAILURE',retryAt:Date.now()+999999999,error:'Do not copy provider data'}};
  if(mode==='header')return{status:503,headers:{'Retry-After':'120'},body:{code:'D1_WRITE_QUOTA'}};
  if(mode==='far')return{status:503,body:{code:'D1_WRITE_QUOTA',retryAt:Date.now()+365*86400000}};
 },{mobile:false});
 let gateway=await f.start();
 let status=await until(()=>gateway.get('/api/status'),s=>s.cloud==='retrying','Generic failure should be retrying');
 assert.equal(status.cloudErrorCode,null);assert.equal(fs.existsSync(f.marker),false);assert.ok(status.backupPending>0);
 mode='header';const before=Date.now();await gateway.post('/api/cloud-retry');
 status=await until(()=>gateway.get('/api/status'),s=>s.cloud==='quota_paused','Retry-After was not honored');
 assert.ok(status.cloudRetryAt>=before+120000&&status.cloudRetryAt<=Date.now()+120000);
 mode='far';await gateway.post('/api/cloud-retry');
 status=await until(()=>gateway.get('/api/status'),s=>s.cloud==='quota_paused','Bounded quota pause was not set');
 assert.ok(status.cloudRetryAt<=Date.now()+25*60*60*1000);
 const saved=JSON.parse(fs.readFileSync(f.marker,'utf8'));assert.equal(saved.retryAt-saved.observedAt,25*60*60*1000);
 await gateway.stop();
 fs.writeFileSync(f.marker,JSON.stringify({...saved,endpointHash:'different-cloud-endpoint'}));mode='accept';
 gateway=await f.start();
 status=await until(()=>gateway.get('/api/status'),s=>s.cloud==='synced'&&s.backupPending===0,'Another endpoint inherited a stale quota pause');
 assert.equal(status.cloudErrorCode,null);
});

test('a successful partial sync ACK keeps backup catching up until every pending batch is acknowledged',async t=>{
 let release;const held=new Promise(resolve=>{release=resolve;});let batches=0;
 const f=await fixture(t,async call=>{if(call.route==='/sync'&&++batches===2)await held;},{mobile:false,seedCount:80});
 const gateway=await f.start();
 try{
  const partial=await until(()=>gateway.get('/api/status'),s=>s.cloud==='catching_up','Partial ACK was incorrectly marked fully synced');
  assert.ok(partial.backupPending>0);assert.ok(partial.lastBackup);assert.equal(partial.cloudErrorCode,null);
  const monitor=await gateway.get('/api/monitor');assert.equal(monitor.cloud.state,'catching_up');
 }finally{release();}
 const status=await until(()=>gateway.get('/api/status'),s=>s.cloud==='synced'&&s.backupPending===0,'Remaining changes were not acknowledged');
 assert.equal(status.cloudErrorCode,null);assert.equal(batches,2);
});
