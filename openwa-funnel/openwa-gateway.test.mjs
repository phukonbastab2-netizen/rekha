import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Engine} from './engine.mjs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('gateway REST mode recovers an unavailable upstream at boot, receives both directions and preserves funnel without a second browser',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-rest-test-')),peer='919876543210@c.us',secret='signed-test-secret',rows=[],sends=[];
 let firstSessionFailure=true;
 const api=http.createServer(async(req,res)=>{
  assert.equal(req.headers['x-api-key'],'private-test-key');
  let raw='';for await(const chunk of req)raw+=chunk;
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/sessions/test-session'){
   if(firstSessionFailure){firstSessionFailure=false;res.writeHead(503);return res.end('{}');}
   return res.end(JSON.stringify({id:'test-session',status:'ready',phone:'919876548973'}));
  }
  if(req.url.includes('/chats?'))return res.end('[]');
  if(req.url.includes('/messages?'))return res.end(JSON.stringify({messages:rows,total:rows.length}));
  if(req.url.endsWith('/messages/send-text')){sends.push(JSON.parse(raw));return res.end(JSON.stringify({messageId:'true_'+peer+'_test-send',timestamp:Math.floor(Date.now()/1000)}));}
  res.writeHead(404);res.end('{}');
 });
 await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const providerPort=api.address().port,port=14347,base='http://127.0.0.1:'+port;
 rows.push({id:'db-old',waMessageId:'false_'+peer+'_old',chatId:peer,from:peer,to:'919876548973@c.us',direction:'incoming',timestamp:Math.floor(Date.now()/1000)-3600,body:'Old message',type:'text',status:'sent'});
 const child=spawn(process.execPath,['gateway.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),windowsHide:true,env:{...process.env,PORT:String(port),REKHA_DATA_DIR:temp,AUTO_CONNECT:'true',WHATSAPP_PROVIDER:'openwa-gateway',OPENWA_API_URL:'http://127.0.0.1:'+providerPort+'/api',OPENWA_API_KEY:'private-test-key',OPENWA_SESSION_ID:'test-session',OPENWA_WEBHOOK_SECRET:secret,CLOUD_BACKUP_URL:'',CLOUD_BACKUP_TOKEN:'',CHROME_PATH:'/never-launch-browser'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stderr.on('data',chunk=>logs+=chunk);
 t.after(async()=>{if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}await new Promise(resolve=>api.close(resolve));fs.rmSync(temp,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Gateway startup timed out '+logs)),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(Error('Gateway stopped '+code+' '+logs));});});
 const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];
 const get=async route=>await(await fetch(base+route,{headers:{Cookie:cookie}})).json();
 let status=await get('/api/status');assert.notEqual(status.connection,'connected');assert.equal((await get('/api/runtime-status')).ready,false);
 for(let n=0;n<160;n++){status=await get('/api/status');if(status.connection==='connected')break;await wait(50);}
 assert.equal(status.connection,'connected');assert.equal(status.provider,'rmyndharis/OpenWA');assert.equal(status.contacts,1);assert.equal(status.queued,0);assert.equal(sends.length,0);
 assert.equal((await get('/api/sender-capacity')).observed.activeOperations,0);
 assert.equal((await get('/api/session-status')).managedBy,'OpenWA dashboard');
 const hook=async(event,data,occurredAt=Date.now())=>{const raw=JSON.stringify({sessionId:'test-session',event,timestamp:new Date(occurredAt).toISOString(),data}),signature='sha256='+createHmac('sha256',secret).update(raw).digest('hex');return fetch(base+'/api/provider/openwa',{method:'POST',headers:{'Content-Type':'application/json','X-OpenWA-Signature':signature},body:raw});};
 const live={id:'false_'+peer+'_new',chatId:peer,from:peer,to:'919876548973@c.us',fromMe:false,type:'text',timestamp:Date.now()/1000,body:'New enquiry'};
 assert.equal((await hook('message.received',live)).status,200);assert.equal((await hook('message.received',live)).status,200);
 status=await get('/api/status');assert.equal(status.queued,5);assert.equal(status.messages,2);
 await fetch(base+'/api/enabled',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:'{"enabled":true}'});
 for(let n=0;n<40&&sends.length===0;n++)await wait(50);
 assert.equal(sends.length,1);assert.equal(sends[0].chatId,peer);assert.match(sends[0].text,/नमस्ते|राधे|जय|नमस्कार|🔱/);
 await hook('message.ack',{messageId:'true_'+peer+'_test-send',status:'read'});
 const ownerReply={...live,id:'true_'+peer+'_phone',fromMe:true,body:'Reply from owner phone'};await hook('message.sent',ownerReply);
 let messages=(await get('/api/messages?peer='+encodeURIComponent(peer))).messages;
 assert.equal(messages.filter(m=>m.providerId==='true_'+peer+'_test-send').length,1);
 assert.equal(messages.find(m=>m.providerId==='true_'+peer+'_test-send').status,'read');
 assert.ok(messages.some(m=>m.body==='Reply from owner phone'));
 const edit1=Date.now()+20,edit2=edit1+20;
 await hook('message.edited',{messageId:ownerReply.id,chatId:peer,body:'First edit',timestamp:ownerReply.timestamp},edit1);
 await hook('message.edited',{messageId:ownerReply.id,chatId:peer,body:'Second edit',timestamp:ownerReply.timestamp},edit2);
 await hook('message.sent',ownerReply);
 await hook('message.edited',{messageId:ownerReply.id,chatId:peer,body:'First edit',timestamp:ownerReply.timestamp},edit1);
 messages=(await get('/api/messages?peer='+encodeURIComponent(peer))).messages;
 assert.equal(messages.find(m=>m.providerId===ownerReply.id).body,'Second edit');
 assert.equal(messages.find(m=>m.providerId===ownerReply.id).editedAtSource,'observed');
 assert.equal(messages.find(m=>m.providerId===ownerReply.id).editedAt,edit2);
 await hook('message.edited',{messageId:ownerReply.id,chatId:peer,body:'Second edit',timestamp:ownerReply.timestamp},edit2+40);
 await hook('message.edited',{messageId:ownerReply.id,chatId:peer,body:'Delayed intermediate edit',timestamp:ownerReply.timestamp},edit2+20);
 messages=(await get('/api/messages?peer='+encodeURIComponent(peer))).messages;
 assert.equal(messages.find(m=>m.providerId===ownerReply.id).body,'Second edit');
 // An edit webhook is dispatched even when upstream's DB write failed. A
 // subsequent unversioned REST row must not undo that already-confirmed edit.
 rows.push({...ownerReply,id:'db-owner',waMessageId:ownerReply.id,direction:'outgoing',status:'sent'});
 await wait(60);
 await fetch(base+'/api/sync-inbox',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:'{}'});
 messages=(await get('/api/messages?peer='+encodeURIComponent(peer))).messages;
 assert.equal(messages.find(m=>m.providerId===ownerReply.id).body,'Second edit');
 await hook('message.revoked',{id:'revoke-notice',revokedId:ownerReply.id,chatId:peer});
 messages=(await get('/api/messages?peer='+encodeURIComponent(peer))).messages;assert.equal(messages.find(m=>m.providerId===ownerReply.id).revoked,true);
 assert.equal((await get('/api/status')).queued,4);
 const capacity=await get('/api/sender-capacity');assert.equal(capacity.observed.acceptedOperations,1);assert.equal(capacity.observed.uncertainOperations,0);
});

test('gateway opt-in recovery promotes missed passive leads once and catches later history without changing activation',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-recovery-test-')),now=Date.now(),since=now-3600000,cutover=now-60000;
 const peer='919876543211@lid',blocked='919876543212@lid',outside='919876543213@lid',late='919876543214@lid';
 const row=(id,p,body,at)=>({id:'db-'+id,waMessageId:'false_'+p+'_'+id,chatId:p,from:p,to:'919876548973@c.us',direction:'incoming',timestamp:at/1000,type:'text',body,status:'sent'});
 const rows=[row('outside',outside,'Old contact',since-1000),row('missing',peer,'Please help',cutover-1000),row('blocked',blocked,'Hello',cutover-2000),row('stop',blocked,'STOP',cutover-500)];
 const seed=new Engine(path.join(temp,'funnel.sqlite'));seed.put({key:'inbox-recovery',kind:'settings',since});seed.importHistory({peer,id:rows[1].waMessageId,type:'text',body:rows[1].body,at:cutover-1000});seed.close();
 let sends=0;
 const api=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method==='POST'){sends++;res.writeHead(500);return res.end('{}');}
  if(req.url==='/api/sessions/recovery-session')return res.end(JSON.stringify({id:'recovery-session',status:'ready',phone:'919876548973'}));
  if(req.url.includes('/chats?'))return res.end('[]');
  if(req.url.includes('/messages?'))return res.end(JSON.stringify({messages:[...rows].sort((a,b)=>b.timestamp-a.timestamp),total:rows.length}));
  res.writeHead(404);res.end('{}');
 });
 await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const port=14348,base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['gateway.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),windowsHide:true,env:{...process.env,PORT:String(port),REKHA_DATA_DIR:temp,AUTO_CONNECT:'true',WHATSAPP_PROVIDER:'openwa-gateway',OPENWA_API_URL:'http://127.0.0.1:'+api.address().port+'/api',OPENWA_API_KEY:'private-test-key',OPENWA_SESSION_ID:'recovery-session',OPENWA_WEBHOOK_SECRET:'test-only',OPENWA_ACTIVE_SINCE:String(cutover),OPENWA_RECOVER_MISSED_LEADS:'true',CLOUD_BACKUP_URL:'',CLOUD_BACKUP_TOKEN:'',CHROME_PATH:'/never-launch-browser'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stderr.on('data',chunk=>logs+=chunk);
 t.after(async()=>{if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}await new Promise(resolve=>api.close(resolve));fs.rmSync(temp,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Gateway startup timed out '+logs)),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(Error('Gateway stopped '+code+' '+logs));});});
 const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0],get=async route=>await(await fetch(base+route,{headers:{Cookie:cookie}})).json();
 let status;
 for(let n=0;n<100;n++){status=await get('/api/status');if(status.connection==='connected')break;await wait(50);}
 assert.equal(status.connection,'connected');assert.equal(status.queued,5);assert.equal(status.missedLeadRecovery.started,1);assert.equal(status.missedLeadRecovery.since,since);assert.equal(status.missedLeadRecovery.before,cutover);assert.equal(status.inboxSync.activatedAt,cutover);
 const sync=()=>fetch(base+'/api/sync-inbox',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:'{}'});
 rows.push(row('arrived-late',late,'I wrote overnight',cutover-3000));await sync();await sync();
 status=await get('/api/status');assert.equal(status.queued,10);assert.equal(status.missedLeadRecovery.started,2);assert.equal(status.inboxSync.activatedAt,cutover);assert.equal(sends,0);
 assert.equal((await get('/api/messages?peer='+encodeURIComponent(peer))).messages.length,1);
 assert.equal((await get('/api/messages?peer='+encodeURIComponent(late))).messages.length,1);
});

test('completed sends refill other customers promptly while typed refusal, concurrency and per-chat spacing stay safe',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-refill-test-')),peers=['919876543221@lid','919876543222@lid','919876543223@lid'];
 const seed=new Engine(path.join(temp,'funnel.sqlite'));seed.enable(true);peers.forEach((peer,n)=>seed.inbound({peer,id:'seed-'+n,type:'text',body:'Hello',at:Date.now()-60000}));seed.close();
 const posts=[],activePeers=new Set();let active=0,peak=0;
 const api=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/sessions/refill-session')return res.end(JSON.stringify({id:'refill-session',status:'ready',phone:'919876548973'}));
  if(req.url.includes('/chats?'))return res.end('[]');
  if(req.url.includes('/messages?'))return res.end('{"messages":[],"total":0}');
  if(req.url.endsWith('/messages/send-text')){
   let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw);assert.equal(activePeers.has(payload.chatId),false);activePeers.add(payload.chatId);active++;peak=Math.max(peak,active);posts.push({peer:payload.chatId,at:Date.now()});
   await wait(100);active--;activePeers.delete(payload.chatId);
   if(payload.chatId===peers[0]){res.writeHead(429);return res.end(JSON.stringify({statusCode:429,code:'SEND_PACING_LIMITED',message:'Test policy refusal'}));}
   return res.end(JSON.stringify({messageId:'true_'+payload.chatId+'_accepted',timestamp:Date.now()/1000}));
  }
  res.writeHead(404);res.end('{}');
 });
 await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
 const port=14349,base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['gateway.mjs'],{cwd:path.dirname(fileURLToPath(import.meta.url)),windowsHide:true,env:{...process.env,PORT:String(port),REKHA_DATA_DIR:temp,AUTO_CONNECT:'true',WHATSAPP_PROVIDER:'openwa-gateway',OPENWA_API_URL:'http://127.0.0.1:'+api.address().port+'/api',OPENWA_API_KEY:'private-test-key',OPENWA_SESSION_ID:'refill-session',OPENWA_RECOVER_MISSED_LEADS:'false',CLOUD_BACKUP_URL:'',CLOUD_BACKUP_TOKEN:'',CHROME_PATH:'/never-launch-browser'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stderr.on('data',chunk=>logs+=chunk);
 t.after(async()=>{if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}await new Promise(resolve=>api.close(resolve));fs.rmSync(temp,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Gateway startup timed out '+logs)),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(Error('Gateway stopped '+code+' '+logs));});});
 const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0],get=async route=>await(await fetch(base+route,{headers:{Cookie:cookie}})).json();
 for(let n=0;n<70&&posts.length<3;n++)await wait(25);
 assert.equal(posts.length,3);assert.ok(posts[2].at-posts[0].at<1700,'The next customer should not wait for another one-second timer tick');assert.equal(new Set(posts.map(p=>p.peer)).size,3);assert.ok(peak<=2);
 for(let n=0;n<30&&active;n++)await wait(20);await wait(100);
 const status=await get('/api/status'),capacity=await get('/api/sender-capacity');
 assert.equal(status.uncertain,0);assert.equal(status.queued,13);assert.equal(capacity.observed.deferredOperations,1);assert.equal(capacity.observed.acceptedOperations,2);assert.equal(capacity.observed.uncertainOperations,0);assert.equal(capacity.observed.activeOperations,0);
 const chat=await get('/api/messages?peer='+encodeURIComponent(peers[0]));assert.equal(chat.messages.length,1);assert.equal(chat.jobs.length,0);
 await wait(150);assert.equal(posts.length,3,'No peer may bypass the actual-send gap or refusal backoff');
 const diagnostic=JSON.parse(fs.readFileSync(path.join(temp,'outbound-error.json'),'utf8'));assert.equal(diagnostic.phase,'outbound');assert.equal(diagnostic.status,429);assert.equal(diagnostic.providerCode,'SEND_PACING_LIMITED');assert.doesNotMatch(JSON.stringify(diagnostic),/Test policy refusal/);
});
