import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Inbox} from './inbox.mjs';
const id='a'.repeat(64),phone='1418201524705343';
function setup(t,mutate=()=>{},send){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-manual-'));const opened=[];
 const state={found:true,phoneNumberId:phone,waId:'919999007353',lastInboundAt:Date.now(),optedOut:false,restricted:false,jobs:Array.from({length:5},(_,n)=>({id:'first:'+n,stage:'first',state:'accepted',messageId:'wamid.auto'+n,acceptedAt:Date.now()-10000+n,delivery:'delivered',step:{type:'text',body:'Original '+n}})),records:[['inbound:one',{type:'text',text:'Hi',eventAt:Date.now()-20000}]],next:null};mutate(state);
 const index={phoneNumberId:phone,ownerTestOnly:false,account:{paused:false,ingestion:{lastWebhookAt:1,recentConversationIds:[id]}}};let sends=0;
 const env={WA_PHONE_NUMBER_ID:phone,GRAPH_VERSION:'v23.0',META_ACCESS_TOKEN:'test-only',ADMIN_TOKEN:'test-only-admin',FUNNEL_ORIGIN:'https://worker.test'};
 const open=()=>{const inbox=new Inbox(path.join(dir,'inbox.sqlite'),env,{fetchImpl:async url=>Response.json(url.includes('inbox-index')?index:state),send:send||(async()=>{sends++;return {messageId:'wamid.manual'};})});opened.push(inbox);return inbox;};
 t.after(()=>{for(const inbox of opened)try{inbox.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
 return {inbox:open(),open,state,index,sends:()=>sends};
}
test('read sync shows original incoming and funnel messages and never sends',async t=>{
 const f=setup(t);await f.inbox.sync();await f.inbox.sync({force:true});assert.equal(f.sends(),0);assert.equal(f.inbox.chats().length,1);assert.equal(f.inbox.messages(id).length,6);assert.equal(f.inbox.status().automaticFunnel,'Cloudflare (unchanged)');
});
test('manual reply is journaled locally and the same request cannot send twice, including after restart',async t=>{
 const f=setup(t);await f.inbox.sync();const request={id,text:'Namaste',requestId:randomUUID()};
 assert.equal((await f.inbox.manualReply(request)).state,'accepted');assert.equal((await f.inbox.manualReply(request)).duplicate,true);
 f.inbox.close();const reopened=f.open();assert.equal((await reopened.manualReply(request)).duplicate,true);assert.equal(f.sends(),1);assert.equal(reopened.messages(id).filter(m=>m.payload.source==='you').length,1);
});
test('concurrent double-clicks send one reply',async t=>{
 const f=setup(t);const request={id,text:'Hello',requestId:randomUUID()};await Promise.all([f.inbox.manualReply(request),f.inbox.manualReply(request)]);assert.equal(f.sends(),1);
});
test('24-hour window, opt out, pending first sequence, and paused accounts block manual sends',async t=>{
 for(const change of [s=>s.lastInboundAt=Date.now()-86401000,s=>s.optedOut=true,s=>s.jobs[0].state='pending',s=>s.restricted=true]){
  const f=setup(t,change);await assert.rejects(f.inbox.manualReply({id,text:'Blocked',requestId:randomUUID()}));assert.equal(f.sends(),0);
 }
 const f=setup(t);f.index.account.paused=true;await assert.rejects(f.inbox.manualReply({id,text:'Blocked',requestId:randomUUID()}));assert.equal(f.sends(),0);
});
test('owner test gate applies equally to manual replies',async t=>{
 const f=setup(t);f.index.ownerTestOnly=true;f.index.testConversationId='b'.repeat(64);await assert.rejects(f.inbox.manualReply({id,text:'Blocked',requestId:randomUUID()}));assert.equal(f.sends(),0);
});
test('ambiguous send is retained as uncertain and never retried',async t=>{
 let calls=0;const f=setup(t,()=>{},async()=>{calls++;throw Object.assign(Error('timeout'),{uncertain:true});});const request={id,text:'Maybe sent',requestId:randomUUID()};
 assert.equal((await f.inbox.manualReply(request)).state,'uncertain');assert.equal((await f.inbox.manualReply(request)).duplicate,true);
 await assert.rejects(f.inbox.manualReply({id,text:'Another reply',requestId:randomUUID()}));assert.equal(calls,1);
});
test('a crashed manual send is uncertain after restart',async t=>{
 const f=setup(t);await f.inbox.sync();const requestId=randomUUID();f.inbox.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?,?)').run(requestId,id,'Interrupted','sending',null,null,Date.now());f.inbox.close();const reopened=f.open();
 assert.equal((await reopened.manualReply({id,text:'Interrupted',requestId})).state,'uncertain');assert.equal(f.sends(),0);
});
test('failed contact sync is retried even if the source watermark did not advance',async t=>{
 const f=setup(t);const original=f.inbox.syncContact.bind(f.inbox);let first=true;f.inbox.syncContact=async target=>{if(first){first=false;throw Error('offline');}return original(target);};
 await assert.rejects(f.inbox.sync());await f.inbox.sync();assert.equal(f.inbox.chats().length,1);assert.equal(f.inbox.status().error,null);
});
test('request id cannot be reused for different text',async t=>{
 const f=setup(t);const requestId=randomUUID();await f.inbox.manualReply({id,text:'One',requestId});await assert.rejects(f.inbox.manualReply({id,text:'Two',requestId}));assert.equal(f.sends(),1);
});
