import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const root=path.resolve('.');
const source=['cloudflare/messaging.mjs','cloudflare/owner.mjs','cloudflare/workflow.mjs'].map(file=>readFileSync(path.join(root,file),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export (async function|function|const)/g,'$1')).join('\n');
// Clock and local auth fixtures exist only inside this test Worker.
const fixture=`
let fixtureNow=Date.now();
export default {async fetch(request,env){const route=new URL(request.url).pathname,method=request.method,db=env.DB;
if(request.headers.has('X-Fixture-Now'))fixtureNow=Number(request.headers.get('X-Fixture-Now'));
const stmt=(sql,...args)=>db.prepare(sql).bind(...args),one=(sql,...args)=>stmt(sql,...args).first(),all=async(sql,...args)=>(await stmt(sql,...args).all()).results;
const fail=(status,message)=>Object.assign(Error(message),{status}),result=(data,status=200)=>Response.json(data,{status}),body=()=>request.json(),get=id=>one('SELECT * FROM conversations WHERE id=?',id);
const cookie=request.headers.get('Cookie')||'',owner=async()=>{if(cookie!=='fixture-owner')throw fail(401,'Owner fixture required.');},customer=async()=>{const chat=await get(cookie.replace('fixture-customer:',''));if(!cookie.startsWith('fixture-customer:')||!chat)throw fail(401,'Customer fixture required.');return chat;};
const ctx={request,env,route,method,stmt,one,all,fail,result,body,get,owner,customer,now:()=>fixtureNow};
try{const handled=await workflowRoutes(ctx);if(handled)return handled;
if(route.startsWith('/api/media/'))return await mediaResponse(ctx);
const match=route.match(/^\\/fixture\\/(enroll|inbound|process|state)\\/([a-f0-9-]{36})$/);if(!match)throw fail(404,'Not found.');const chat=await get(match[2]);if(!chat)throw fail(404,'Not found.');if(cookie!=='fixture-owner'&&(await customer()).id!==chat.id)throw fail(404,'Not found.');
if(match[1]==='enroll')return result({enrolled:await flowOnStart(ctx,chat)});
if(match[1]==='inbound'){const data=await body(),existing=await one('SELECT * FROM messages WHERE conversation_id=? AND client_id=?',chat.id,data.clientId);let message=existing;if(!message){const inserted=await stmt("INSERT INTO messages(conversation_id,role,kind,body,status,client_id,created) VALUES(?,'user',?,?,'pending',?,?) RETURNING *",chat.id,data.kind||'customer',data.text||'Fixture question',data.clientId,fixtureNow).first();message=inserted;}return result({processed:await flowOnCustomer(ctx,chat,message),messageId:message.id});}
if(match[1]==='process')return result(await workflowProcessDue(ctx,{chatId:chat.id,limit:10}));
return result({workflow:await workflowChatView(ctx,chat.id),messages:await all('SELECT * FROM messages WHERE conversation_id=? ORDER BY id',chat.id)});
}catch(error){return result({error:error.message},error.status||503);}}};`;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:source+'\n'+fixture,compatibilityDate:'2026-09-24',d1Databases:{DB:'workflow-test'},r2Buckets:{MEDIA:'workflow-media'}}));
const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('MEDIA');
for(const file of ['schema.sql','migration-workflow.sql'])for(const sql of splitSqlStatements(readFileSync(path.join(root,'cloudflare',file),'utf8')))await db.prepare(sql).run();
let clock=Date.now();const owner='fixture-owner';
async function api(route,method='GET',data,cookie=owner){const response=await mf.dispatchFetch('https://workflow.test'+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie,'X-Fixture-Now':String(clock)},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:response.status,data:await response.json()};}
async function makeChat(language='en'){const id=randomUUID();await db.prepare('INSERT INTO conversations(id,token_hash,name,dob,language,preferences,created,updated) VALUES(?,?,?,?,?,?,?,?)').bind(id,randomUUID(),'Workflow fixture','1990-01-01',language,'{}',clock,clock).run();return id;}
const state=id=>api('/fixture/state/'+id),process=id=>api('/fixture/process/'+id,'POST',{},'fixture-customer:'+id),inbound=(id,kind='customer',clientId=randomUUID())=>api('/fixture/inbound/'+id,'POST',{kind,clientId},'fixture-customer:'+id),control=(id,action)=>api('/api/admin/conversations/'+id+'/workflow','PATCH',{action});
try{
  const initial=await api('/api/admin/workflow/settings');assert.equal(initial.data.enabled,false);assert.equal((await api('/api/admin/workflow/settings','GET',undefined,'')).status,401);
  const old=await makeChat();assert.equal((await api('/fixture/enroll/'+old,'POST',{})).data.enrolled,false);
  assert.equal((await api('/api/admin/workflow/settings','PATCH',{enabled:true})).status,400);assert.equal((await api('/api/admin/workflow/settings','PATCH',{paymentEnabled:true})).status,409);
  const assets={};for(const [key,type]of Object.entries({firstVideo:'video',testimonials:'video',kundli:'image',solution:'image',puja:'image',voice:'audio',qr:'image'})){const id=randomUUID();assets[key]=id;const mime=type==='video'?'video/mp4':type==='audio'?'audio/mpeg':'image/png';await db.prepare('INSERT INTO media_items(id,title,type,object_key,mime,size,archived,created) VALUES(?,?,?,?,?,?,?,?)').bind(id,key,type,'fixture/'+id,mime,20,key==='qr'?1:0,clock).run();await bucket.put('fixture/'+id,new Uint8Array(20));}
  const config=await api('/api/admin/workflow/settings','PATCH',{enabled:true,assets,translations:{en:{greeting:'Namaste fixture',final:'Share your question. ₹49 preview only; no real charge.',reminder:'Please share your question. ₹49 preview only; no real charge.'}}});assert.equal(config.status,200,JSON.stringify(config.data));
  assert.equal((await state(old)).data.workflow.enrolled,false);assert.equal((await inbound(old)).data.processed,false);assert.equal((await process(old)).data.sent,0);
  const id=await makeChat(),other=await makeChat();assert.equal((await api('/fixture/enroll/'+id,'POST',{})).data.enrolled,true);assert.equal((await process(id)).data.sent,0);assert.equal((await state(id)).data.messages.length,0);assert.equal((await state(id)).data.workflow.status,'armed');
  const firstId=randomUUID();assert.equal((await inbound(id,'customer',firstId)).data.processed,true);assert.equal((await inbound(id,'customer',firstId)).data.processed,false);
  const concurrent=await Promise.all([process(id),process(id)]);assert.equal(concurrent.reduce((sum,r)=>sum+r.data.sent,0),1);let snapshot=(await state(id)).data;assert.equal(snapshot.messages.filter(m=>m.role==='assistant').length,1);assert.equal(snapshot.messages.at(-1).body,'Namaste fixture');assert.equal(snapshot.workflow.nextDue,clock+5000);
  assert.equal((await process(id)).data.sent,0);clock+=5000;assert.equal((await process(id)).data.sent,1);snapshot=(await state(id)).data;const video=JSON.parse(snapshot.messages.at(-1).body).items[0];assert.equal(video.id,assets.firstVideo);
  assert.equal((await api('/api/media/'+video.id,'GET',undefined,'fixture-customer:'+other)).status,404);assert.equal((await mf.dispatchFetch('https://workflow.test/api/media/'+video.id,{headers:{Cookie:'fixture-customer:'+id}})).status,200);
  // A late scheduler sends one next step; the following step still waits five seconds.
  clock+=7200000;assert.equal((await process(id)).data.sent,1);assert.equal((await process(id)).data.sent,0);snapshot=(await state(id)).data;assert.equal(snapshot.workflow.nextDue,clock+5000);clock+=5000;assert.equal((await process(id)).data.sent,1);snapshot=(await state(id)).data;assert.equal(snapshot.workflow.stage,'WAITING_FOR_DETAILS');assert.equal(snapshot.messages.filter(m=>m.role==='assistant').length,4);assert.ok(snapshot.messages.at(-1).body.includes('₹49'));assert.ok(snapshot.messages.every(m=>!m.body.includes(assets.qr)));
  assert.equal((await db.prepare('SELECT free_used FROM conversations WHERE id=?').bind(id).first()).free_used,0);
  assert.equal((await inbound(id)).data.processed,true);snapshot=(await state(id)).data;assert.equal(snapshot.workflow.stage,'REMINDER_SCHEDULED');assert.equal(snapshot.workflow.nextDue,clock+60000);assert.equal((await process(id)).data.sent,0);clock+=60000;assert.equal((await process(id)).data.sent,1);assert.equal((await state(id)).data.workflow.stage,'REMINDER_SENT');await inbound(id);assert.equal((await state(id)).data.workflow.jobs.filter(j=>j.kind==='reminder').length,1);
  await inbound(id,'media');snapshot=(await state(id)).data;assert.equal(snapshot.workflow.campaign,'SCHEDULED');assert.equal(snapshot.workflow.nextDue,clock+3600000);await inbound(id,'media');assert.equal((await state(id)).data.workflow.jobs.filter(j=>j.kind==='media').length,1);
  clock+=3600000;await control(id,'pause');assert.equal((await process(id)).data.sent,0);assert.equal((await state(id)).data.workflow.pauseReason,'owner-paused');await control(id,'resume');
  await db.prepare("UPDATE conversations SET mode='manual' WHERE id=?").bind(id).run();assert.equal((await process(id)).data.sent,0);assert.equal((await state(id)).data.workflow.pauseReason,'reply-mode-manual');await db.prepare("UPDATE conversations SET mode='assist' WHERE id=?").bind(id).run();assert.equal((await process(id)).data.sent,0);
  await db.prepare("UPDATE conversations SET mode='ai' WHERE id=?").bind(id).run();await db.prepare('INSERT OR REPLACE INTO chat_messaging(conversation_id,blocked) VALUES(?,1)').bind(id).run();assert.equal((await process(id)).data.sent,0);await db.prepare('UPDATE chat_messaging SET blocked=0 WHERE conversation_id=?').bind(id).run();
  for(let n=0;n<4;n++){assert.equal((await process(id)).data.sent,1);if(n<3){assert.equal((await process(id)).data.sent,0);clock+=5000;}}snapshot=(await state(id)).data;assert.equal(snapshot.workflow.campaign,'SENT');assert.equal(JSON.parse(snapshot.messages.at(-1).body).items[0].type,'audio');
  assert.equal((await control(id,'start')).status,409);const before=snapshot.messages.length;assert.equal((await control(id,'restart')).status,200);assert.equal((await state(id)).data.workflow.generation,2);assert.equal((await process(id)).data.sent,1);assert.equal((await state(id)).data.messages.length,before+1);
  await api('/api/admin/workflow/settings','PATCH',{enabled:false});clock+=5000;assert.equal((await process(id)).data.sent,0);assert.equal((await state(id)).data.workflow.pauseReason,'global-disabled');await api('/api/admin/workflow/settings','PATCH',{enabled:true});
  await db.prepare('UPDATE media_items SET archived=1 WHERE id=?').bind(assets.firstVideo).run();for(let n=0;n<5;n++){assert.equal((await process(id)).data.sent,0);clock+=3600001;}snapshot=(await state(id)).data;assert.equal(snapshot.workflow.jobs.find(j=>j.kind==='first').status,'failed');await db.prepare('UPDATE media_items SET archived=0 WHERE id=?').bind(assets.firstVideo).run();await control(id,'resume');assert.equal((await process(id)).data.sent,1);assert.equal((await state(id)).data.workflow.jobs.find(j=>j.kind==='first').attempts,0);
  assert.equal((await api('/api/admin/workflow/settings','PATCH',{assets:{firstVideo:assets.kundli}})).status,400);assert.equal((await api('/api/admin/workflow/settings','PATCH',{translations:{en:{greeting:'x'.repeat(4001)}}})).status,400);
  assert.equal((await api('/api/admin/conversations/'+id+'/workflow','GET',undefined,'fixture-customer:'+id)).status,401);
  await db.prepare('DELETE FROM conversations WHERE id=?').bind(id).run();assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workflow_jobs WHERE conversation_id=?').bind(id).first()).n,0);
  console.log('Workflow runtime checks passed: disabled-until-valid setup, no retroactive sends, armed first inbound, concurrent dedup, delivery-relative gaps, private media grants, one reminder/media campaign, no QR/payment activation, translations, free credit preservation, owner pause/restart/resume, AI-only mode, block/global holds, retry recovery, cascade deletion.');
}finally{await mf.dispose();}
