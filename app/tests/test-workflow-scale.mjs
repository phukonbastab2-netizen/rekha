import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
import {workflowDefaults} from '../cloudflare/workflow.mjs';

const source=readFileSync(new URL('../cloudflare/workflow.mjs',import.meta.url),'utf8').replace(/export (async function|function|const)/g,'$1');
const fixture=`
export default {async fetch(request,env){const db=env.DB,route=new URL(request.url).pathname,method=request.method;
let used=0;const budgetLimit=Number(request.headers.get('X-Query-Budget')||0),queryBudget=budgetLimit?{get used(){return used;},limit:budgetLimit,can:reserve=>used+reserve<=budgetLimit}:undefined;
const stmt=(sql,...args)=>{used++;return db.prepare(sql).bind(...args);},one=(sql,...args)=>stmt(sql,...args).first(),all=async(sql,...args)=>(await stmt(sql,...args).all()).results;
const fail=(status,message)=>Object.assign(Error(message),{status}),result=data=>Response.json(budgetLimit?{...data,queries:used}:data),get=id=>one('SELECT * FROM conversations WHERE id=?',id);
let paused=false;const wrappedOne=async(sql,...args)=>{if(request.headers.get('X-Pause-On-Media')&&sql.startsWith('SELECT * FROM media_items')&&!paused){paused=true;await stmt("UPDATE chat_workflow SET status='paused' WHERE conversation_id=?",request.headers.get('X-Pause-On-Media')).run();}return one(sql,...args);};
const ctx={request,env,route,method,stmt,one:wrappedOne,all,fail,result,get,owner:async()=>{},body:()=>request.json(),now:()=>1000000,queryBudget};
try{if(route==='/recover'){const data=await request.json();return result(await workflowRecoverMessages(ctx,data.chatId??null,data.limit??20));}
if(route==='/process'){const data=await request.json();return result(await workflowProcessDue(ctx,data));}
return await workflowRoutes(ctx)??Response.json({error:'fixture route'}, {status:404});
}catch(error){return Response.json({error:error.message},{status:error.status||500});}}};`;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:source+'\n'+fixture,compatibilityDate:'2026-09-24',d1Databases:{DB:'workflow-scale-test'}}));
const db=await mf.getD1Database('DB'),stmt=(sql,...args)=>db.prepare(sql).bind(...args),one=(sql,...args)=>stmt(sql,...args).first();
async function apply(file){for(const sql of splitSqlStatements(readFileSync(new URL('../cloudflare/'+file,import.meta.url),'utf8')))await db.prepare(sql).run();}
async function api(route,data={},headers={}){const response=await mf.dispatchFetch('http://localhost'+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
const assets={};for(const [key,type]of Object.entries({firstVideo:'video',testimonials:'video',kundli:'image',solution:'image',puja:'image',voice:'audio',qr:'image'}))assets[key]={id:randomUUID(),type};
const config={...structuredClone(workflowDefaults),enabled:true,assets:Object.fromEntries(Object.entries(assets).map(([k,v])=>[k,v.id])),timings:{firstDelayMs:5000,itemGapMs:5000,reminderDelayMs:60000,mediaDelayMs:3600000}};
async function chat({mode='ai',paused=false,enrolled=true}={}){const id=randomUUID();await stmt('INSERT INTO conversations(id,token_hash,name,dob,language,preferences,mode,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',id,randomUUID(),'Scale fixture','1990-01-01','en','{}',mode,0,0).run();if(enrolled)await stmt('INSERT INTO chat_workflow(conversation_id,status,config,started_at,updated) VALUES(?,?,?,?,?)',id,paused?'paused':'armed',JSON.stringify(config),0,0).run();return id;}
async function inbound(id,n=1){const ids=[];for(let i=0;i<n;i++)ids.push((await stmt("INSERT INTO messages(conversation_id,role,kind,body,status,created) VALUES(?,'user','customer','hello','pending',?) RETURNING id",id,i+1).first()).id);return ids;}
async function job(id,{kind='first',status='pending',generation=1,media=false,due=1}={}){const key=randomUUID();await stmt('INSERT INTO workflow_jobs(id,conversation_id,generation,kind,status,due,lease_until,payload,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)',key,id,generation,kind,status,due,status==='processing'?999999:null,JSON.stringify({steps:[media?{text:'video',asset:'firstVideo'}:{text:'Scale reply'}],assets:config.assets,timings:config.timings}),0,0).run();return key;}
try{
  await apply('schema.sql');await apply('migration-workflow-scale.sql');
  for(const {id,type}of Object.values(assets))await stmt('INSERT INTO media_items(id,title,type,object_key,mime,size,created) VALUES(?,?,?,?,?,?,?)',id,'fixture',type,'fixture/'+id,'application/octet-stream',1,0).run();
  await stmt("INSERT OR REPLACE INTO workflow_settings(key,value) VALUES('config',?)",JSON.stringify(config)).run();
  const absent=await chat({enrolled:false});await inbound(absent);assert.equal((await one('SELECT COUNT(*) n FROM workflow_recovery')).n,0);
  const first=await chat(),ids=await inbound(first,3);assert.equal((await one('SELECT COUNT(*) n FROM workflow_recovery')).n,3);
  assert.deepEqual(await api('/recover',{limit:2}),{recovered:2,examined:2});assert.equal((await one('SELECT MIN(message_id) id FROM workflow_recovery')).id,ids[2]);
  assert.equal((await one('SELECT COUNT(*) n FROM workflow_events')).n,2);assert.equal((await one('SELECT COUNT(*) n FROM workflow_jobs WHERE conversation_id=?',first)).n,1);
  assert.deepEqual(await api('/recover',{chatId:first}),{recovered:1,examined:1});assert.equal((await one('SELECT COUNT(*) n FROM workflow_recovery')).n,0);
  await inbound(first);await stmt('DELETE FROM conversations WHERE id=?',first).run();assert.equal((await one('SELECT COUNT(*) n FROM workflow_recovery')).n,0);
  // Simulate an existing database before queue migration: legacy cursor work is
  // fixed at 200 user rows, and reapplying the migration cannot reset progress.
  const legacy=await chat();const legacyIds=await inbound(legacy,450);await stmt('DELETE FROM workflow_recovery').run();await stmt("UPDATE workflow_settings SET value=? WHERE key='recovery-legacy-max'",String(legacyIds.at(-1))).run();
  await api('/recover',{limit:1});let cursor=Number((await one("SELECT value FROM workflow_settings WHERE key='recovery-cursor'")).value);assert.ok(cursor>0&&cursor<legacyIds.at(-1));assert.ok((await one('SELECT COUNT(*) n FROM workflow_recovery')).n<=199);
  await apply('migration-workflow-scale.sql');assert.equal(Number((await one("SELECT value FROM workflow_settings WHERE key='recovery-cursor'")).value),cursor);
  for(let i=0;i<3;i++)await api('/recover',{limit:40});assert.equal(Number((await one("SELECT value FROM workflow_settings WHERE key='recovery-cursor'")).value),legacyIds.at(-1));
  await stmt('DELETE FROM conversations WHERE id=?',legacy).run();
  // More paused jobs than a cron page must not hide an eligible due job.
  const heldIds=[];for(let i=0;i<55;i++){const id=await chat({paused:true});heldIds.push(await job(id));}
  assert.equal((await one("SELECT COUNT(*) n FROM workflow_jobs WHERE status='held'")).n,55);
  const active=await chat();await job(active);assert.equal((await api('/process',{limit:20})).sent,1);assert.equal((await one("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND role='assistant'",active)).n,1);
  const manual=await chat({mode:'manual'}),manualJob=await job(manual);assert.equal((await one('SELECT status FROM workflow_jobs WHERE id=?',manualJob)).status,'held');
  await stmt("UPDATE chat_workflow SET status='paused' WHERE conversation_id=?",manual).run();await stmt("UPDATE conversations SET mode='ai' WHERE id=?",manual).run();assert.equal((await one('SELECT status FROM workflow_jobs WHERE id=?',manualJob)).status,'held');
  await stmt("UPDATE chat_workflow SET status='active' WHERE conversation_id=?",manual).run();assert.deepEqual(await one('SELECT status,due FROM workflow_jobs WHERE id=?',manualJob),{status:'pending',due:1});
  await stmt('INSERT INTO chat_messaging(conversation_id,blocked) VALUES(?,1)',manual).run();assert.equal((await one('SELECT status FROM workflow_jobs WHERE id=?',manualJob)).status,'held');
  await stmt("UPDATE conversations SET mode='manual' WHERE id=?",manual).run();await stmt('UPDATE chat_messaging SET blocked=0 WHERE conversation_id=?',manual).run();assert.equal((await one('SELECT status FROM workflow_jobs WHERE id=?',manualJob)).status,'held');
  await stmt("UPDATE conversations SET mode='ai' WHERE id=?",manual).run();assert.equal((await one('SELECT status FROM workflow_jobs WHERE id=?',manualJob)).status,'pending');
  const race=await chat(),raceJob=await job(race,{media:true});assert.equal((await api('/process',{chatId:race},{'X-Pause-On-Media':race})).sent,0);assert.equal((await one('SELECT status FROM workflow_jobs WHERE id=?',raceJob)).status,'held');assert.equal((await one('SELECT COUNT(*) n FROM messages WHERE conversation_id=?',race)).n,0);
  const concurrent=await chat();await job(concurrent);const delivered=await Promise.all([api('/process',{chatId:concurrent}),api('/process',{chatId:concurrent})]);assert.equal(delivered.reduce((n,r)=>n+r.sent,0),1);
  const budgeted=await chat();await inbound(budgeted,4);const limitedRecovery=await api('/recover',{chatId:budgeted,limit:40},{'X-Query-Budget':'20'});assert.equal(limitedRecovery.examined,1);assert.ok(limitedRecovery.queries<=20);assert.equal((await one('SELECT COUNT(*) n FROM workflow_recovery WHERE conversation_id=?',budgeted)).n,3);
  const limitedDelivery=await api('/process',{chatId:budgeted},{'X-Query-Budget':'30'});assert.equal(limitedDelivery.sent,1);assert.ok(limitedDelivery.queries<=30);
  const restart=await chat({paused:true}),oldJob=await job(restart);const response=await mf.dispatchFetch('http://localhost/api/admin/conversations/'+restart+'/workflow',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'restart'})});assert.equal(response.status,200);assert.equal((await one('SELECT status FROM workflow_jobs WHERE id=?',oldJob)).status,'cancelled');
  await stmt("UPDATE workflow_settings SET value=json_set(value,'$.enabled',0) WHERE key='config'").run();assert.equal((await api('/process')).sent,0);
  console.log('Workflow scale checks passed: FIFO durable recovery; atomic event/queue removal; scoped and resumable 200-row legacy backfill; repeated migration; cascade cleanup; paused backlog beyond page cap; manual/block/resume eligibility; preserved due times; takeover during processing; concurrent dedup; held generation restart; global disable.');
}finally{await mf.dispose();}
