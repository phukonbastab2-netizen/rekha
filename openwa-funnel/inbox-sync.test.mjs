import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {Engine,isSensitive} from './engine.mjs';
import {createInboxSync,normalizeIncoming,normalizeOutgoing,readProviderInbox,installFastInboxBridge,serializeNativeMessage} from './inbox-sync.mjs';
import {MEDIA_DELAY} from './funnel.mjs';
const peer='919876543210@c.us';
const message=(id,at,extra={})=>({id,from:peer,type:'chat',timestamp:at/1000,body:'Hi',...extra});
test('reception boundary survives restart and recovers missed messages without duplicate replies',async t=>{
 const e=new Engine(':memory:',()=>1000000);t.after(()=>e.close());e.enable(true);
 e.inbound({peer,id:'first',type:'text',body:'Hi',at:900000});
 const page={total:1,eligible:1,next:1,chats:[{messages:[message('first',900000),message('missed',1050000)]}]};
 let now=1100000;
 const build=()=>createInboxSync({engine:e,now:()=>now,evaluate:async()=>page,onIncoming:async m=>{
  const n=normalizeIncoming(m,1000000,now);return n.input?e.inbound(n.input).accepted:false;
 }});
 const a=build();assert.equal(a.since,1000000);assert.equal(e.get('inbox-recovery').kind,'settings');await a.scan();assert.equal(a.status.recovered,1);assert.equal(e.stats().messages,2);
 const queued=e.stats().queued;now=1200000;const b=build();assert.equal(b.since,1000000);await b.scan();assert.equal(b.status.recovered,0);assert.equal(e.stats().queued,queued);
});
test('old chat history appears without starting the funnel; future customer message starts it once',t=>{
 const e=new Engine(':memory:',()=>1000000);t.after(()=>e.close());
 const input={peer,id:'old',type:'text',body:'Hello',name:'Customer',at:100000};
 assert.equal(e.importHistory(input),true);assert.equal(e.importHistory(input),false);
 assert.equal(e.stats().contacts,1);assert.equal(e.stats().queued,0);assert.equal(e.contact(peer).stage,'history_only');
 e.inbound({...input,id:'new',at:1000000});assert.equal(e.stats().queued,5);
 e.importHistory({...input,id:'another-old',body:'START'});assert.equal(e.stats().queued,5);
});
test('recovery rejects service, group, outgoing, missing timestamps and pre-boundary messages',()=>{
 assert.equal(normalizeIncoming(message('a',1000000,{sender:{pushname:'Facebook Business'}}),0,1000000).reason,'service');
 for(const extra of [{fromMe:true},{id:{_serialized:'a',fromMe:true}},{isGroupMsg:true},{isNotification:true}])assert.ok(normalizeIncoming(message('a',1000000,extra),0,1000000).reason);
 assert.equal(normalizeIncoming(message('a',900000),1000000,1100000).reason,'older_than_start');
 assert.equal(normalizeIncoming(message('a',0),0,1100000).reason,'timestamp');
 assert.ok(normalizeIncoming(message('pay',1000000,{type:'payment',isNotification:true}),0,1100000).input);
 assert.equal(isSensitive('12345 is your Facebook confirmation code'),true);
});
test('provider snapshot supports modern collections and history loader without sending or marking read',async()=>{
 const m={id:{_serialized:'a',fromMe:false},from:{_serialized:peer},type:'chat',body:'Hi',t:1000};
 const chat={id:{_serialized:peer},t:1000,contact:{pushname:'Customer'},msgs:{_models:[]}};
 let loads=0;
 const context={Store:{Chat:{_models:[chat]}},require:n=>{assert.equal(n,'WAWebChatLoadMessages');return{loadEarlierMsgs:async({chat:c})=>{loads++;assert.equal(c,chat);return[m];}};},setTimeout,clearTimeout};
 const fn=vm.runInNewContext('('+readProviderInbox.toString()+')',context);
 const result=await fn({after:0,offset:0,limit:10});assert.equal(result.total,1);assert.equal(result.chats[0].messages[0].body,'Hi');assert.equal(loads,1);
});
test('recovered photo keeps the one-hour delay from its original receipt time',t=>{
 const e=new Engine(':memory:',()=>1000000);t.after(()=>e.close());
 e.inbound({peer,id:'missed-photo',type:'image',body:'',at:900000,recovered:true});
 assert.equal(e.get('job:'+peer+':media:0').dueAt,900000+MEDIA_DELAY);
});
test('background recovery does not restore history the owner deleted',t=>{
 const e=new Engine(':memory:',()=>1000000);t.after(()=>e.close());
 e.inbound({peer,id:'first',type:'text',body:'Hi',at:900000});e.deleteContent(peer);
 assert.equal(e.importHistory({peer,id:'unloaded-old',type:'text',body:'Old history',at:900000}),false);
 assert.equal(e.inbound({peer,id:'missed-before-delete',type:'text',body:'Old history',at:950000,recovered:true}).ignored,true);
 assert.equal(e.stats().messages,0);assert.equal(e.stats().queued,0);assert.equal(e.contact(peer).paused,true);
});
test('live bridge receives new and decrypted messages even when the SDK new-message flag is false',async()=>{
 const collection=new EventEmitter(),received=[];
 const context={Store:{Msg:collection},WAPI:{_serializeMessageObj:async()=>{throw Error('Broken legacy serializer must not be called');}},OpenWA_RuntimeMessageReceived:async m=>received.push(m)};
 const install=vm.runInNewContext('('+installFastInboxBridge.toString()+')',context);
 assert.equal(install({since:1000000}).ready,true);install({since:1000000});
 assert.equal(collection.listenerCount('add'),1);
 const fresh={id:{_serialized:'incoming-id',fromMe:false,remote:{_serialized:peer}},t:1001,type:'chat',body:'Hi',isNewMsg:false};collection.emit('add',fresh);
 collection.emit('change:type',{...fresh,type:'image'});
 collection.emit('add',{...fresh,t:900});collection.emit('add',{...fresh,id:{fromMe:true}});
 assert.equal(received.length,2);
 assert.equal(received[0].from,peer);assert.equal(received[0].id,'incoming-id');assert.equal(received[0].body,'Hi');
 const replacement=new EventEmitter();context.Store.Msg=replacement;install({since:1000000});
 assert.equal(collection.listenerCount('add'),0);assert.equal(replacement.listenerCount('add'),1);
});
test('another customer can send while a media job is in flight without overlapping the same customer',t=>{
 const e=new Engine(':memory:',()=>1000000);t.after(()=>e.close());e.enable(true);
 for(const p of [peer,'919876543211@c.us'])e.inbound({peer:p,id:p,type:'text',body:'Hi',at:1000000});
 const a=e.reserve(),b=e.reserve();assert.ok(a&&b);assert.notEqual(a.peer,b.peer);assert.equal(e.reserve(),null);
 assert.equal(e.stats().sending,2);e.finish(b.key,'provider-b');assert.equal(e.stats().sending,1);assert.equal(e.get(a.key).state,'sending');
});

test('native delivery receipts forward only outgoing acknowledgements and replace stale listeners',()=>{
 const collection=new EventEmitter(),acks=[];
 const context={Store:{Msg:collection,State:{Socket:{state:'CONNECTED'}}},OpenWA_RuntimeMessageReceived:async()=>{},OpenWA_RuntimeAckChanged:m=>acks.push(m)};
 const install=vm.runInNewContext('('+installFastInboxBridge.toString()+')',context);
 assert.equal(install({since:0}).socket,'CONNECTED');install({since:0});assert.equal(collection.listenerCount('change:ack'),1);
 collection.emit('change:ack',{id:{_serialized:'outgoing',fromMe:true},ack:3,t:1000});
 collection.emit('change:ack',{id:{_serialized:'incoming',fromMe:false},ack:3});
 collection.emit('change:ack',{id:{_serialized:'invalid',fromMe:true},ack:'invalid'});
 assert.equal(acks.length,1);assert.equal(acks[0].id,'outgoing');assert.equal(acks[0].ack,3);
 const replacement=new EventEmitter();context.Store.Msg=replacement;install({since:0});
 assert.equal(collection.listenerCount('change:ack'),0);assert.equal(replacement.listenerCount('change:ack'),1);
});

test('phone-sent messages use the all-message bridge and preserve the customer identity',()=>{
 const collection=new EventEmitter(),outgoing=[];
 const context={Store:{Msg:collection,Chat:{get:()=>({contact:{pushname:'Customer'}})}},OpenWA_RuntimeMessageReceived:async()=>{},OpenWA_RuntimeAnyMessage:m=>outgoing.push(m)};
 const install=vm.runInNewContext('('+installFastInboxBridge.toString()+')',context);install({since:1000000});
 collection.emit('add',{id:{_serialized:'phone-reply',fromMe:true,remote:{_serialized:peer}},senderObj:{pushname:'Owner'},t:1001,type:'chat',body:'My phone reply',ack:2});
 assert.equal(outgoing.length,1);assert.equal(outgoing[0].to,peer);assert.equal(outgoing[0].fromMe,true);assert.equal(outgoing[0].sender.pushname,'Customer');
 assert.equal(normalizeOutgoing(outgoing[0],1000000,1100000).input.body,'My phone reply');
 assert.equal(normalizeOutgoing({...outgoing[0],fromMe:false},1000000,1100000).reason,'incoming');
 assert.equal(normalizeOutgoing({...outgoing[0],to:'12345@g.us'},1000000,1100000).reason,'peer');
 assert.equal(normalizeOutgoing(outgoing[0],1100000,1200000).reason,'older_than_start');
});

test('global message fallback includes orphan messages and fresh messages with stale chat timestamps',async()=>{
 const fresh={id:{_serialized:'orphan',fromMe:false,remote:{_serialized:peer}},t:1001,type:'chat',body:'New customer message'};
 const phone={...fresh,id:{_serialized:'outgoing-phone',fromMe:true,remote:{_serialized:peer}},t:1002,body:'Phone reply'};
 const stale={id:{_serialized:peer},t:100,contact:{pushname:'Customer'},msgs:{_models:[]}};
 const context={Store:{Chat:{_models:[stale],get:()=>stale},Msg:{_models:[fresh,phone]}}};
 const read=vm.runInNewContext('('+readProviderInbox.toString()+')',context);
 const page=await read({after:1000000,recentAfter:1000000,offset:0,limit:10,messageOffset:0});
 assert.equal(page.chats.length,0);assert.equal(page.recentMessages.length,2);assert.equal(page.messageTotal,2);
 assert.equal(page.recentMessages[1].to,peer);assert.equal(page.recentMessages[1].fromMe,true);
 const e=new Engine(':memory:',()=>1100000);let received=0,sent=0;
 try{
  e.put({key:'inbox-recovery',kind:'settings',since:1000000});
  const sync=createInboxSync({engine:e,evaluate:async()=>page,onIncoming:async()=>{received++;return true;},onOutgoing:async()=>{sent++;return true;},now:()=>1100000});
  await sync.scan();assert.equal(received,1);assert.equal(sent,1);assert.equal(sync.status.outgoingMirrored,1);
 }finally{e.close();}
});

test('live and recovery snapshots retain media download fields without putting encryption keys in normalized records',async()=>{
 const collection=new EventEmitter(),live=[];
 const model={id:{_serialized:'media-id',fromMe:false,remote:{_serialized:peer}},t:1001,type:'image',caption:'Actual photo',mimetype:'image/jpeg',mediaKey:'test-only-key',clientUrl:'https://media.example.test/file',deprecatedMms3Url:'https://media.example.test/old',filehash:'test-filehash',encFilehash:'test-encrypted-hash',directPath:'/media/path',size:200,filename:'photo.jpg'};
 const chat={id:{_serialized:peer},t:1001,contact:{pushname:'Customer'},msgs:{_models:[model,model]}};
 const context={Store:{Msg:collection,Chat:{_models:[chat],get:()=>chat}},OpenWA_RuntimeMessageReceived:m=>live.push(m),setTimeout,clearTimeout};
 const install=vm.runInNewContext('('+installFastInboxBridge.toString()+')',context);install({since:1000000});collection.emit('add',model);
 context.Store.Msg._models=[model];
 const read=vm.runInNewContext('('+readProviderInbox.toString()+')',context),page=await read({after:0,recentAfter:0});
 const snapshot=page.recentMessages[0];
 for(const key of ['mimetype','mediaKey','clientUrl','deprecatedMms3Url','filehash','encFilehash','directPath','size','filename'])assert.equal(snapshot[key],live[0][key],key);
 const normalized=normalizeIncoming(snapshot,1000000,1100000).input;assert.equal(normalized.body,'Actual photo');assert.equal(normalized.filename,'photo.jpg');
 assert.equal(normalized.mediaKey,undefined);assert.equal(normalized.clientUrl,undefined);
});

test('native edit metadata is forwarded only as a mutation on edit events, and stale listeners are removed',()=>{
 const collection=new EventEmitter(),received=[];
 const context={Store:{Msg:collection},OpenWA_RuntimeMessageReceived:m=>received.push(m)};
 const install=vm.runInNewContext('('+installFastInboxBridge.toString()+')',context);install({since:1000000});install({since:1000000});
 const model={id:{_serialized:'edited',fromMe:false,remote:{_serialized:peer}},t:1001,type:'chat',body:'Current text',latestEditSenderTimestampMs:1050000,latestEditMsgKey:{_serialized:'edit-key'}};
 collection.emit('add',model);collection.emit('change:body',model);collection.emit('change:caption',model);
 assert.equal(received[0].mutation,undefined);assert.equal(received[1].mutation,'edit');assert.equal(received[2].mutation,'edit');
 assert.equal(normalizeIncoming(received[1],1000000,1100000).input.editedAt,1050000);
 assert.equal(collection.listenerCount('change:caption'),1);
 const replacement=new EventEmitter();context.Store.Msg=replacement;install({since:1000000});
 for(const event of ['add','change:type','change:body','change:caption','change:latestEditMsgKey','change:latestEditSenderTimestampMs'])assert.equal(collection.listenerCount(event),0,event);
 assert.equal(replacement.listenerCount('change:caption'),1);
});

test('revocations target the actual protocol message and edits require a valid provider timestamp',()=>{
 const revoked=normalizeIncoming(message('revoke-event',900000,{type:'revoked',protocolMessageKey:{_serialized:'original-message'},isNotification:true}),1000000,1100000).input;
 assert.equal(revoked.id,'original-message');assert.equal(revoked.mutation,'revoke');assert.equal(revoked.observedAt,1100000);
 const oldEdit=normalizeIncoming(message('old',900000,{body:'Actual edit',latestEditSenderTimestampMs:1050000}),1000000,1100000).input;
 assert.equal(oldEdit.mutation,'edit');
 assert.equal(normalizeIncoming(message('invalid',1000000,{mutation:'edit',latestEditSenderTimestampMs:900000}),0,1100000).reason,'mutation_timestamp');
 assert.equal(normalizeIncoming(message('future',1000000,{mutation:'edit',latestEditSenderTimestampMs:1400001}),0,1100000).reason,'mutation_timestamp');
});

test('owner phone and LID self notes are identified for read-only outgoing mirrors and excluded from incoming automation',async()=>{
 const collection=new EventEmitter(),out=[];
 const ownerPn='919000008973@c.us',ownerLid='12345678061@lid',model={id:{_serialized:'self-message',fromMe:true,remote:{_serialized:ownerLid}},t:1001,type:'chat',body:'A message to myself'};
 const context={Store:{Msg:collection,Chat:{_models:[],get:()=>undefined}},require:n=>{assert.equal(n,'WAWebUserPrefsMeUser');return{getMaybeMePnUser:()=>({_serialized:ownerPn}),getMaybeMeLidUser:()=>({_serialized:ownerLid})};},OpenWA_RuntimeMessageReceived:()=>{},OpenWA_RuntimeAnyMessage:m=>out.push(m)};
 const install=vm.runInNewContext('('+installFastInboxBridge.toString()+')',context);install({since:0});collection.emit('add',model);
 assert.equal(out[0].isSelf,true);assert.equal(normalizeOutgoing(out[0],0,1100000).input.isSelf,true);
 assert.equal(normalizeIncoming({...out[0],fromMe:false},0,1100000).reason,'self');
 context.Store.Msg._models=[model];const read=vm.runInNewContext('('+readProviderInbox.toString()+')',context),snapshot=(await read({recentAfter:0})).recentMessages[0];
 assert.equal(snapshot.isSelf,true);assert.equal(normalizeOutgoing(snapshot,0,1100000).input.isSelf,true);
});

test('the shared standalone native serializer preserves the live snapshot contract for journal hydration',()=>{
 const peer='919876543210@c.us',model={id:{_serialized:'shared',fromMe:true,remote:{_serialized:peer}},t:1000,type:'document',body:'Actual body',mimetype:'application/pdf',mediaKey:'test-key',caption:'Actual caption',latestEditSenderTimestampMs:1050000,protocolMessageKey:{_serialized:'target'}};
 const standalone=vm.runInNewContext('('+serializeNativeMessage.toString()+')',{}),snapshot=standalone(model,{name:'Chosen name',ownIds:[peer]});
 assert.equal(snapshot.id,'shared');assert.equal(snapshot.from,peer);assert.equal(snapshot.to,peer);assert.equal(snapshot.isSelf,true);assert.equal(snapshot.sender.pushname,'Chosen name');assert.equal(snapshot.mediaKey,'test-key');assert.equal(snapshot.protocolMessageKey,'target');
 assert.equal(snapshot.body,'Actual body');assert.equal(snapshot.caption,'Actual caption');assert.equal(snapshot.latestEditSenderTimestampMs,1050000);
 const plain=standalone({id:'plain-outgoing',fromMe:true,to:peer,type:'chat',timestamp:1000,body:'Actual phone text'});
 assert.equal(plain.fromMe,true);assert.equal(plain.to,peer);assert.equal(plain.timestamp,1000);
});

test('recovery applies a known old edit through the mutation callback without replaying its historical funnel',async t=>{
 const e=new Engine(':memory:',()=>1200000);t.after(()=>e.close());e.put({key:'inbox-recovery',kind:'settings',since:1000000});
 e.importHistory({peer,id:'old-edit',at:900000,type:'text',body:'Old text'});
 const edited=message('old-edit',900000,{body:'Actual corrected text',latestEditSenderTimestampMs:1100000});
 let mutations=0;
 const sync=createInboxSync({engine:e,evaluate:async()=>({total:1,eligible:1,next:1,chats:[{messages:[edited]}],recentMessages:[edited]}),now:()=>1200000,onIncoming:async m=>{const normalized=normalizeIncoming(m,1000000,1200000);const result=e.inbound(normalized.input);if(result.mutated)mutations++;return !!result.accepted;}});
 await sync.scan();assert.equal(mutations,1);assert.equal(e.get('in:old-edit').body,'Actual corrected text');assert.equal(e.stats().queued,0);assert.equal(e.stats().contacts,1);
 await sync.scan();assert.equal(mutations,1);assert.equal(e.stats().queued,0);
});
