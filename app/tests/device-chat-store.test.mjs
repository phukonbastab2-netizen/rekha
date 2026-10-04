import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange,IDBCursor,IDBObjectStore} from 'fake-indexeddb';
import {createDeviceChatStore} from '../public/device-chat-store.js';

const id='private-local-customer',other='other-private-local-customer';
const message=(n,extra={})=>({id:n,role:n%2?'user':'assistant',kind:'customer',body:'Local message '+n,status:'sent',created:n,changeRevision:n,...extra});
const view=(messages,extra={})=>({id,name:'Local fixture',dob:'1990-01-01',language:'en',version:1,updated:1,inboxRevision:1,blocked:false,locked:false,messages,historyComplete:false,...extra});
const history=(extra={})=>({id,revision:250,oldestId:171,hasOlder:true,...extra});

test('hold boundaries and confirmed Yes survive sparse offline reopen without freezing sampled active state',async t=>{
  const f=fixture(t),store=f.create(),startsAt=Date.parse('2026-10-04T01:00:00Z'),endsAt=startsAt+145000;
  await store.merge(view([message(35,{role:'assistant',kind:'kundli-followup-choice',created:endsAt,deliveryAt:endsAt})],{customerSendHold:{startsAt,endsAt,active:true},kundliChoiceAnswered:true,clockOffsetMs:-120000}));
  await store.savePending(id,{draft:{body:'Keep this question',replyTo:7,attachments:[]},records:[{conversationId:id,clientId:'kundli-followup-yes-v1-35',created:endsAt,snapshot:{body:'Yes',clientId:'kundli-followup-yes-v1-35'},state:'queued'}]});
  await store.merge(view([],{customerSendHold:{startsAt,endsAt,active:false},kundliChoiceAnswered:false,version:2}));store.close();const cached=await f.create().read({id});
  assert.deepEqual(cached.chat.customerSendHold,{startsAt,endsAt});assert.equal(cached.chat.kundliChoiceAnswered,true);assert.equal(cached.chat.clockOffsetMs,-120000);assert.equal(cached.pending.draft.body,'Keep this question');assert.equal(cached.pending.draft.replyTo,7);assert.equal(cached.pending.records[0].clientId,'kundli-followup-yes-v1-35');assert.equal(cached.pending.records[0].snapshot.body,'Yes');
});

test('startup deadlines and safe clock offset persist while hidden rows and drafts remain available offline',async t=>{
  const f=fixture(t),store=f.create(),created=Date.parse('2026-10-04T01:00:00Z');
  const startup=[1,2,3,4].map(n=>message(n,{role:'assistant',created:created+n*5000,deliveryAt:created+n*5000,kind:n===4?'kundli-wait':'owner-message'}));
  await store.merge(view([...startup,message(5,{deliveryAt:created+99999}),message(6,{deliveryAt:Infinity})],{clockOffsetMs:-120000,serverTime:created,typing:{owner:true}}));
  await store.savePending(id,{draft:{body:'Keep my unsent draft',attachments:[]},clockOffsetMs:-125000});store.close();
  const cached=await f.create().read({id});assert.equal(cached.chat.messages.length,6);assert.deepEqual(cached.chat.messages.slice(0,4).map(row=>row.deliveryAt),startup.map(row=>row.deliveryAt));
  assert.equal(cached.chat.messages[3].created,created+20000);assert.equal(cached.chat.clockOffsetMs,-125000);assert.equal(cached.chat.serverTime,undefined);assert.equal(cached.chat.typing.owner,false);assert.equal(cached.chat.messages[4].deliveryAt,undefined);assert.equal(cached.chat.messages[5].deliveryAt,undefined);assert.equal(cached.pending.draft.body,'Keep my unsent draft');
});

test('all thirty-four scheduled assistant rows fit in one bounded cache page with unchanged IDs and deadlines',async t=>{
  const f=fixture(t),store=f.create({pageSize:80}),created=Date.parse('2026-10-04T01:00:00Z');
  const scheduled=Array.from({length:34},(_,index)=>{const due=index<4?created+(index+1)*5000:created+320000+(index-4)*5000;return message(index+1,{role:'assistant',kind:index<4?'owner-message':'kundli-review-line',created:due,deliveryAt:due});});
  await store.merge(view(scheduled,{clockOffsetMs:-120000}),{kind:'initial',history:history({revision:34,oldestId:1,hasOlder:false})});store.close();const cached=await f.create().read({id});
  assert.equal(cached.chat.messages.length,34);assert.equal(cached.hasOlderLocal,false);assert.deepEqual(cached.chat.messages.map(row=>[row.id,row.created,row.deliveryAt]),scheduled.map(row=>[row.id,row.created,row.deliveryAt]));assert.equal(cached.history.revision,34);assert.equal(cached.chat.clockOffsetMs,-120000);
});
function fixture(t){const indexedDB=new IDBFactory(),options={indexedDB,IDBKeyRange,dbName:'local-fixture'},stores=[];const create=extra=>{const store=createDeviceChatStore({...options,...extra});stores.push(store);return store;};t.after(()=>stores.forEach(store=>store.close()));return{create,indexedDB};}
const request=q=>new Promise((resolve,reject)=>{q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
async function rawDatabase(indexedDB){return request(indexedDB.open('local-fixture',1));}
function queued(clientId,extra={}){return{clientId,conversationId:id,created:99,baseVersion:1,state:'queued',attempts:0,snapshot:{body:'Unsent local text',clientId,editId:null,replyTo:2,attachments:[],previewRevoked:false,finished:false},...extra};}

test('restart reads bounded recent/older IndexedDB pages and keeps the genuine server cursor',async t=>{
  const f=fixture(t),store=f.create();assert.equal(await store.merge(view(Array.from({length:250},(_,i)=>message(i+1)),{version:3,updated:100}),{kind:'initial',history:history()}),true);await store.flush();store.close();
  const reopened=f.create(),recent=await reopened.read();assert.equal(recent.chat.id,id);assert.deepEqual(recent.chat.messages.map(m=>m.id),Array.from({length:80},(_,i)=>i+171));assert.equal(recent.hasOlderLocal,true);assert.equal(recent.oldestId,171);assert.deepEqual(recent.history,history());
  const second=await reopened.read({id,beforeId:recent.oldestId});assert.deepEqual(second.chat.messages.map(m=>m.id),Array.from({length:80},(_,i)=>i+91));assert.deepEqual(second.history,history(),'A local older page cannot move the server cursor.');
  const final=await reopened.read({id,beforeId:11});assert.deepEqual(final.chat.messages.map(m=>m.id),Array.from({length:10},(_,i)=>i+1));assert.equal(final.hasOlderLocal,false);assert.equal(final.chat.page.hasOlder,true,'The genuine server still has older history to fetch.');
  assert.equal(recent.chat.typing.owner,false);assert.equal(await reopened.read({id:'unknown-private-chat'}),null);
  const normalNow=Date.now;Date.now=()=>normalNow()+365*24*3600000;try{assert.equal((await reopened.read({id})).chat.messages.length,80,'There is no timed device expiry.');}finally{Date.now=normalNow;}
});

test('local page reads touch at most limit+1 message rows, independent of archive length',async t=>{
  const f=fixture(t),store=f.create();await store.merge(view(Array.from({length:1200},(_,i)=>message(i+1))));
  const previous=IDBCursor.prototype.continue;let advances=0;IDBCursor.prototype.continue=function(...args){advances++;return previous.apply(this,args);};
  try{const result=await store.read({id,limit:30});assert.equal(result.chat.messages.length,30);assert.equal(result.hasOlderLocal,true);assert.equal(advances,30);assert.equal(result.chat.messages[0].id,1171);}finally{IDBCursor.prototype.continue=previous;}
});

test('stale pages/ACKs cannot restore deletions, rewind row edits, read receipts or owner blocking',async t=>{
  const f=fixture(t),store=f.create();await store.merge(view([message(1),message(2)],{version:5,updated:50,inboxRevision:8,blocked:true,receiptCursors:{ownerRead:1,customerRead:2}}),{kind:'initial',history:history({revision:2,oldestId:1,hasOlder:false})});
  await store.merge(view([message(1,{body:'Edited text',changeRevision:10,readByOther:true}),message(2,{body:'',deleted:true,changeRevision:11})],{version:6,updated:60,inboxRevision:8,blocked:true}),{kind:'delta',history:history({revision:11,oldestId:1,hasOlder:false})});
  await store.merge(view([message(1),message(2)],{version:6,updated:60,inboxRevision:7,blocked:false,receiptCursors:{ownerRead:0,customerRead:0}}),{kind:'mutation',history:history({revision:2})});
  const result=await store.read({id});assert.equal(result.chat.blocked,true);assert.equal(result.chat.inboxRevision,8);assert.equal(result.chat.messages[0].body,'Edited text');assert.equal(result.chat.messages[0].readByOther,true);assert.equal(result.chat.messages[1].deleted,true);assert.equal(result.chat.messages[1].body,'');assert.deepEqual(result.chat.messages[1].reactions,[]);assert.equal(result.history.revision,11);
  await store.merge(view([message(3)],{version:2,updated:20,inboxRevision:50,blocked:false}),{kind:'older'});assert.equal((await store.read({id})).chat.blocked,true,'Older pages only merge rows.');
  await store.merge(view([],{version:3,updated:30,inboxRevision:9,blocked:false}),{kind:'delta'});const after=await store.read({id});assert.equal(after.chat.version,6);assert.equal(after.chat.blocked,false);assert.equal(after.chat.inboxRevision,9);
});

test('two instances serialize durable merges and maintain per-conversation isolation',async t=>{
  const f=fixture(t),a=f.create(),b=f.create();await a.merge(view([message(1)]));
  await Promise.all([a.merge(view([message(1,{body:'Newer edit',changeRevision:10})],{version:3,updated:3,inboxRevision:10,blocked:true})),b.merge(view([message(2)],{version:2,updated:2,inboxRevision:9,blocked:false}))]);
  const current=await a.read({id});assert.deepEqual(current.chat.messages.map(m=>m.id),[1,2]);assert.equal(current.chat.messages[0].body,'Newer edit');assert.equal(current.chat.blocked,true);
  await b.merge(view([message(3,{body:'Other local text'})],{id:other,name:'Other fixture'}));assert.equal((await a.read()).chat.id,other);assert.deepEqual((await a.read({id})).chat.messages.map(m=>m.id),[1,2]);assert.equal((await a.read({id:other})).chat.messages[0].body,'Other local text');
});

test('pending text/File drafts survive restart with the same clientId, without objectURLs or runtime/auth fields',async t=>{
  const f=fixture(t),store=f.create();await store.merge(view([message(1)]));const file=new File(['local file bytes'],'local-photo.jpg',{type:'image/jpeg',lastModified:123});
  const record=queued('same-send-id',{state:'sending',attempts:1,controller:new AbortController(),prepare:()=>{},snapshot:{...queued('same-send-id').snapshot,attachments:[{file,preview:'blob:secret-object-url',uploaded:{id:'11111111-1111-4111-8111-111111111111',type:'image',title:'Uploaded photo',url:'/api/attachments/11111111-1111-4111-8111-111111111111',token:'never-cache'}}],uploadPromise:Promise.resolve(),auth:'never-cache'}});
  await store.savePending(id,{records:[record,record,queued('wrong-customer',{conversationId:other})],draft:{body:'Draft text',editId:1,replyTo:2,editBackup:{body:'Original draft',replyTo:1},attachments:[{file,preview:'blob:discard-me'}],cookie:'never-cache'}});await store.flush();store.close();
  const pending=(await f.create().read({id})).pending;assert.equal(pending.records.length,1);const restored=pending.records[0];assert.equal(restored.clientId,'same-send-id');assert.equal(restored.state,'queued');assert.equal(restored.uncertain,true);assert.equal(restored.snapshot.previewRevoked,true);assert.equal(restored.snapshot.finished,false);assert.equal(restored.snapshot.attachments[0].file.name,'local-photo.jpg');assert.equal(await restored.snapshot.attachments[0].file.text(),'local file bytes');assert.equal(restored.snapshot.attachments[0].file.lastModified,123);assert.equal(restored.snapshot.attachments[0].preview,undefined);assert.equal(restored.snapshot.attachments[0].uploaded.token,undefined);assert.equal(restored.prepare,undefined);assert.equal(restored.controller,undefined);assert.equal(restored.snapshot.uploadPromise,undefined);assert.equal(restored.snapshot.auth,undefined);assert.equal(pending.draft.cookie,undefined);assert.equal(pending.draft.body,'Draft text');assert.equal(pending.draft.editId,1);assert.deepEqual(pending.draft.editBackup,{body:'Original draft',replyTo:1});
});

test('a saved server ACK reconciles pending sends in either persistence order, retaining unmatched sends',async t=>{
  const f=fixture(t),store=f.create();await store.merge(view([message(1)]));await store.savePending(id,{records:[queued('confirmed'),queued('still-unsent')],draft:{body:'Keep composer',attachments:[]}});
  await store.merge(view([message(2,{role:'user',clientId:'confirmed'})],{version:2,updated:2}));let current=await store.read({id});assert.deepEqual(current.pending.records.map(r=>r.clientId),['still-unsent']);assert.equal(current.pending.draft.body,'Keep composer');
  await store.savePending(id,{records:[queued('confirmed'),queued('still-unsent')]});assert.deepEqual((await store.read({id})).pending.records.map(r=>r.clientId),['still-unsent'],'A stale outbox save after an ACK cannot resurrect a confirmed send.');
  const edit=queued('edit-client',{snapshot:{...queued('edit-client').snapshot,editId:1,body:'Updated local text'},baseVersion:2});await store.savePending(id,{records:[edit]});await store.merge(view([message(1,{body:'Updated local text',changeRevision:3})],{version:3,updated:3}));assert.deepEqual((await store.read({id})).pending.records,[]);
});

test('customer cache excludes owner fields, auth secrets, unsafe media URLs and local optimistic rows',async t=>{
  const f=fixture(t),store=f.create();const media=message(2,{kind:'media',body:JSON.stringify({text:'Shared photo',title:'Collection',adminToken:'never-cache',items:[{id:'11111111-1111-4111-8111-111111111111',type:'image',title:'Private photo',url:'/api/media/11111111-1111-4111-8111-111111111111',token:'never-cache'},{type:'image',url:'https://secret.invalid/picture?signature=never-cache'},{type:'link',url:'https://example.test/public-video'}]})});
  await store.merge(view([media,{id:'local-pending',role:'user',body:'Do not duplicate the outbox'}],{cookie:'never-cache',token:'never-cache',mode:'manual',notes:'Owner private note',draft:{body:'Owner private draft'},labels:['Owner label'],preferences:{remember:true,location:{latitude:26.1,longitude:91.7},consentVersion:'fixture',secret:'never-cache'}}));
  const local=(await store.read({id})).chat;assert.equal(local.messages.length,1);for(const key of ['cookie','token','mode','notes','draft','labels'])assert.equal(local[key],undefined);assert.equal(local.preferences.secret,undefined);assert.equal(local.messages[0].body.includes('never-cache'),false);assert.equal(JSON.parse(local.messages[0].body).items[1].url,undefined);assert.equal(local.messages[0].body.includes('/api/media/'),true,'A private relative reference remains guarded by the server session.');
});

test('erase deletes device content and pending rows atomically and rejects late/cross-tab resurrection',async t=>{
  const f=fixture(t),a=f.create(),b=f.create();await a.merge(view([message(1)]));await a.savePending(id,{records:[queued('delete-me')],draft:{body:'Delete private draft'}});await b.merge(view([message(2)],{id:other}));
  const erased=a.erase(id),late=a.merge(view([message(3)]));assert.equal(await erased,true);assert.equal(await late,false);assert.equal(await b.merge(view([message(4)])),false);assert.equal(await b.savePending(id,{records:[queued('late')]}),false);assert.equal(await b.read({id}),null);assert.equal((await b.read()).chat.id,other,'Deleting an inactive chat leaves another customer archive isolated.');
  const raw=await rawDatabase(f.indexedDB);const tx=raw.transaction(['messages','metadata','pending']);assert.deepEqual(await request(tx.objectStore('messages').getAll()),[{conversationId:other,...(await b.read({id:other})).chat.messages[0]}]);assert.equal(await request(raw.transaction('pending').objectStore('pending').get(id)),undefined);assert.equal(await request(raw.transaction('metadata').objectStore('metadata').get('chat:'+id)),undefined);const marker=await request(raw.transaction('metadata').objectStore('metadata').get('erased:'+id));assert.deepEqual(marker,{key:'erased:'+id});raw.close();
  await b.erase();assert.equal(await a.read(),null);assert.equal(await a.read({id:other}),null);assert.equal(await a.merge(view([message(5)],{id:other})),false);
});

test('quota failure aborts the whole merge and preserves the prior snapshot and pending draft',async t=>{
  const errors=[],f=fixture(t),store=f.create({onError:error=>errors.push(error)});await store.merge(view([message(1)]));await store.savePending(id,{records:[queued('keep-me')],draft:{body:'Keep this draft'}});
  const previous=IDBObjectStore.prototype.put;let written=0;IDBObjectStore.prototype.put=function(value,...args){if(this.name==='messages'&&++written===2)throw new DOMException('Local fixture quota exhausted','QuotaExceededError');return previous.call(this,value,...args);};
  try{assert.equal(await store.merge(view([message(2),message(3)],{version:2,updated:2})),false);}finally{IDBObjectStore.prototype.put=previous;}
  assert.equal(store.status().state,'full');assert.deepEqual(errors.map(error=>error.state),['full']);assert.equal(JSON.stringify(errors).includes('Local message'),false);const saved=await store.read({id});assert.equal(saved.chat.version,1);assert.deepEqual(saved.chat.messages.map(m=>m.id),[1]);assert.equal(saved.pending.draft.body,'Keep this draft');
  assert.equal(await store.merge(view([message(2)],{version:2,updated:2})),true);assert.equal(store.status().available,true);
});

test('only explicit successful restore unblocks the selected erased UUID; failure keeps it blocked',async t=>{
  const f=fixture(t),a=f.create(),b=f.create();await a.merge(view([message(1)]));await a.merge(view([message(2)],{id:other}));await a.erase(id);await a.erase(other);
  assert.equal(await a.merge(view([message(3)])),false);assert.equal(await b.merge(view([message(3)])),false);
  assert.equal(await a.allowRestore(id),true);assert.equal(await a.read({id}),null,'Restore does not invent or recover erased content.');
  assert.equal(await a.merge(view([message(4,{body:'Fresh authenticated history'})],{version:4,updated:4}),{kind:'initial',history:history({revision:4,oldestId:4,hasOlder:false})}),true);assert.equal(await a.savePending(id,{records:[queued('restored-queue')],draft:{body:'Fresh local draft'}}),true);
  const restored=await b.read({id});assert.equal(restored.chat.messages[0].body,'Fresh authenticated history');assert.equal(restored.pending.draft.body,'Fresh local draft');assert.equal(restored.pending.records[0].clientId,'restored-queue');assert.equal(await b.merge(view([message(5)],{id:other})),false,'Other erased UUIDs remain protected.');
  await a.erase(id);const previous=IDBObjectStore.prototype.delete;IDBObjectStore.prototype.delete=function(key){if(this.name==='metadata'&&key==='erased:'+id)throw new DOMException('Local restore transaction failed','AbortError');return previous.call(this,key);};
  try{assert.equal(await a.allowRestore(id),false);}finally{IDBObjectStore.prototype.delete=previous;}
  assert.equal(await a.merge(view([message(6)])),false,'An unsuccessful restore leaves the in-memory erase guard intact.');assert.equal(await b.merge(view([message(6)])),false,'An unsuccessful restore leaves the persisted erase guard intact.');assert.equal(await a.read({id}),null);
});

test('unavailable/blocked storage fails gracefully without losing caller-owned state',async t=>{
  const notices=[],store=createDeviceChatStore({indexedDB:null,IDBKeyRange,onError:error=>notices.push(error)});t.after(()=>store.close());assert.equal(await store.merge(view([message(1)])),false);assert.equal(await store.read(),null);assert.equal(await store.savePending(id,{records:[queued('caller-keeps-this')]}),false);assert.equal(await store.erase(id),false);await store.flush();assert.equal(store.status().available,false);assert.ok(notices.every(error=>error.state==='unavailable'));
  const blocked=createDeviceChatStore({indexedDB:{open(){const request={};queueMicrotask(()=>request.onblocked());return request;}},IDBKeyRange});t.after(()=>blocked.close());assert.equal(await blocked.read(),null);assert.equal(blocked.status().state,'blocked');
});

test('closing during an outstanding open settles pending reads and flush rather than hanging',async()=>{
  let opening,connectionClosed=false;const store=createDeviceChatStore({indexedDB:{open(){opening={};return opening;}},IDBKeyRange});const read=store.read();await new Promise(resolve=>setImmediate(resolve));store.close();opening.result={close(){connectionClosed=true;}};opening.onsuccess();assert.equal(await read,null);await store.flush();assert.equal(connectionClosed,true);
});
