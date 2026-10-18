import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createOpenwaProvider,openwaMessage,verifyOpenwaWebhook} from './openwa-provider.mjs';
import {Engine} from './engine.mjs';
import {normalizeIncoming,normalizeOutgoing} from './inbox-sync.mjs';
import {enrollNamaste} from './lead-enrollment.mjs';

const now=1800000000000,peer='919876543210@c.us',owner='919876548973',sessionId='session-uuid',secret='private-test-signing-key';
const row=(n,extra={})=>({id:'db-'+n,waMessageId:'false_'+peer+'_'+n,chatId:peer,from:peer,to:owner+'@c.us',direction:'incoming',timestamp:now/1000+n,body:'hi '+n,type:'text',status:'sent',...extra});
function setup(overrides={}){
 const saved=new Map(),requests=[],seen=[];
 const provider=createOpenwaProvider({baseUrl:'http://127.0.0.1:2785/api',apiKey:'private-test-key',sessionId,webhookSecret:secret,get:k=>saved.get(k),put:v=>saved.set(v.key,structuredClone(v)),onMessage:(m,flags)=>seen.push({m,flags}),now:()=>now,
  fetchImpl:async(url,options)=>{requests.push({url,options});if(url.endsWith('/'+sessionId))return Response.json({id:sessionId,status:'ready',phone:owner});if(url.includes('/chats?'))return Response.json([]);return Response.json({messages:[],total:0});},...overrides});
 return{provider,saved,requests,seen};
}
const signed=value=>{const raw=Buffer.from(JSON.stringify({timestamp:new Date(now).toISOString(),...value}));return[raw,'sha256='+createHmac('sha256',secret).update(raw).digest('hex')];};

test('stored UUID is not used as WhatsApp identity; outgoing phone, LID, media and ACK map correctly',()=>{
 const m=openwaMessage(row(1,{direction:'outgoing',from:owner+'@c.us',to:peer,type:'voice',status:'read',metadata:{media:{mimetype:'audio/ogg',omitted:true}},chatName:'Client'}),{ownerPhone:owner});
 assert.equal(m.id,row(1).waMessageId);assert.equal(m.fromMe,true);assert.equal(m.type,'ptt');assert.equal(m.ack,3);assert.equal(m.to,peer);assert.equal(m.sender.pushname,'Client');assert.equal(m.isSelf,false);
 assert.equal(openwaMessage({...row(1),waMessageId:null}),null);
 assert.equal(openwaMessage(row(1,{chatId:'123456789012345@lid'})).chatId,'123456789012345@lid');
 assert.equal(openwaMessage(row(1,{chatId:'12345@g.us'})),null);
 assert.equal(openwaMessage(row(1,{chatId:owner+'@c.us'}),{ownerPhone:owner}).isSelf,true);
});

test('only correctly signed webhook for configured session is processed',async()=>{
 const{provider,seen}=setup();const value={sessionId,event:'message.received',data:{...row(1),id:row(1).waMessageId}};delete value.data.waMessageId;delete value.data.direction;
 assert.equal((await provider.webhook(...signed(value))).status,200);assert.equal(seen.length,1);
 assert.equal((await provider.webhook(Buffer.from('{}'),'sha256='+'0'.repeat(64))).status,401);
 assert.equal((await provider.webhook(...signed({...value,sessionId:'wrong'}))).status,403);
 assert.equal(seen.length,1);assert.equal(verifyOpenwaWebhook(Buffer.from('{}'),'bad',secret),false);
});

test('original funnel starts once for new messages; historical import does not replay, Namaste remains explicit exception',async t=>{
 const engine=new Engine(':memory:',()=>now+100000);t.after(()=>engine.close());engine.put({...engine.settings(),namasteLeads:true});
 const{provider}=setup({get:k=>engine.get(k),put:v=>engine.put(v),onMessage:(m,{historical})=>{
  if(m.fromMe){const n=normalizeOutgoing(m,0,now+100000);if(!n.reason)engine.captureOutgoing(n.input);return;}
  const n=normalizeIncoming(m,0,now+100000);if(n.reason)return;
  if(historical)engine.importHistory(n.input);else engine.inbound(n.input);enrollNamaste(engine,'in:'+m.id);
 }});
 const event=(n,body,timestamp,chatId=peer)=>signed({sessionId,event:'message.received',data:{id:'false_'+chatId+'_'+n,chatId,from:chatId,to:owner+'@c.us',type:'text',body,timestamp,fromMe:false}});
 await provider.webhook(...event('old','Hi',now/1000-3600));assert.equal(engine.stats().queued,0);
 await provider.webhook(...event('new','Hi',now/1000+1));assert.equal(engine.stats().queued,5);
 await provider.webhook(...event('new','Hi',now/1000+1));assert.equal(engine.stats().queued,5);
 await provider.webhook(...event('namaste','Namaste',now/1000-3600,'919876543211@c.us'));assert.equal(engine.stats().queued,10);
 await provider.webhook(...event('namaste','Namaste',now/1000-3600,'919876543211@c.us'));assert.equal(engine.stats().queued,10);
});

test('durable keyset cursor does not advance after failed persistence, and replay processes every row',async()=>{
 const saved=new Map(),processed=[],rows=Array.from({length:100},(_,i)=>row(200-i));let failing=true;
 const options={get:k=>saved.get(k),put:v=>saved.set(v.key,structuredClone(v)),onMessage:m=>{if(failing&&m.body==='hi 140')throw Error('database busy');processed.push(m.id);},fetchImpl:async url=>url.endsWith('/'+sessionId)?Response.json({status:'ready'}):url.includes('/chats?')?Response.json([]):Response.json({messages:url.includes('after=')?[row(1)]:rows,total:101})};
 const first=setup(options).provider;await assert.rejects(first.scan(),/database busy/);assert.equal([...saved.values()][0].cursor,'');
 failing=false;const second=setup(options).provider;await second.scan();assert.equal(new Set(processed).size,101);assert.equal(second.status.completedPasses,1);
});

test('steady recent polling and persisted sweep together cover more than one page without truncation',async()=>{
 const all=Array.from({length:330},(_,i)=>row(400-i)),seen=new Set(),requests=[];
 const{provider}=setup({onMessage:m=>seen.add(m.id),fetchImpl:async url=>{
  requests.push(url);
  if(url.endsWith('/'+sessionId))return Response.json({status:'ready'});if(url.includes('/chats?'))return Response.json([]);
  const cursor=new URL(url).searchParams.get('after'),offset=cursor?all.findIndex(r=>r.id===cursor)+1:0;return Response.json({messages:all.slice(offset,offset+100),total:all.length});
 }});
 await provider.scan();await provider.scan();assert.equal(seen.size,330);assert.equal(provider.status.total,330);assert.equal(provider.status.mobileHistoryComplete,false);
 assert.ok(requests.some(url=>url.includes('after=db-301')));
});

test('missing/stale cursor resets safely and retry does not silently declare full coverage',async()=>{
 const saved=new Map([['openwa-rest-cursor:'+sessionId,{key:'openwa-rest-cursor:'+sessionId,kind:'settings',activatedAt:now,cursor:'gone',completedPasses:0}]]);
 const{provider}=setup({get:k=>saved.get(k),put:v=>saved.set(v.key,v),fetchImpl:async url=>url.endsWith('/'+sessionId)?Response.json({status:'ready'}):url.includes('/chats?')?Response.json([]):url.includes('after=')?Response.json({}, {status:400}):Response.json({messages:[row(1)],total:1})});
 await provider.scan();assert.equal(saved.get('openwa-rest-cursor:'+sessionId).cursor,'');assert.equal(provider.status.completedPasses,0);
});

test('native history rotation resumes unfinished chats after restart and respects the cutover boundary',async()=>{
 const saved=new Map(),seen=[],chats=Array.from({length:6},(_,n)=>({id:String(919876540000+n)+'@c.us',name:'Client '+n}));
 const options={activatedAt:now-60000,get:k=>saved.get(k),put:v=>saved.set(v.key,structuredClone(v)),onMessage:(m,flags)=>seen.push({m,flags}),fetchImpl:async url=>{
  if(url.endsWith('/'+sessionId))return Response.json({status:'ready'});
  if(url.includes('/chats?'))return Response.json(chats);
  if(url.includes('/history?')){const p=decodeURIComponent(new URL(url).pathname.split('/').at(-2));return Response.json([{id:'false_'+p+'_history',chatId:p,from:p,to:owner+'@c.us',body:'during switch',type:'text',timestamp:now/1000-30,fromMe:false}]);}
  return Response.json({messages:[],total:0});
 }};
 await setup(options).provider.scan();assert.equal(seen.length,4);assert.equal([...saved.values()][0].pendingChats.length,2);
 await setup(options).provider.scan();assert.equal(seen.length,6);assert.equal(new Set(seen.map(s=>s.m.chatId)).size,6);assert.ok(seen.every(s=>s.flags.historical===false));
});

test('send contract uses serialized returned ID and correct media route; failures are never retried',async()=>{
 const calls=[];const{provider}=setup({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({messageId:'true_'+peer+'_send',timestamp:now/1000});}});
 assert.equal(await provider.sendText(peer,'Original words'),'true_'+peer+'_send');
 assert.deepEqual(JSON.parse(calls[0].options.body),{chatId:peer,text:'Original words'});
 await provider.sendFile(peer,'https://media.test/qr.png','qr.png',{type:'image',caption:'₹29'});assert.ok(calls[1].url.endsWith('/send-image'));
 assert.equal(calls[1].options.headers['X-API-Key'],'private-test-key');
 let attempts=0;const failed=setup({fetchImpl:async()=>{attempts++;throw Error('Connection reset after send');}}).provider;
 await assert.rejects(failed.sendText(peer,'hello'));assert.equal(attempts,1);
 const noId=setup({fetchImpl:async()=>Response.json({success:true})}).provider;await assert.rejects(noId.sendText(peer,'hello'),/trackable/);
});

test('ACK and mutation webhooks use original message identities and never become new leads',async()=>{
 const acks=[],mutations=[];const{provider,seen}=setup({onAck:(...x)=>acks.push(x),onMutation:(...x)=>mutations.push(x)});
 await provider.webhook(...signed({sessionId,event:'message.ack',data:{messageId:'original-id',status:'read'}}));
 await provider.webhook(...signed({sessionId,event:'message.revoked',data:{id:'notice',revokedId:'original-id',chatId:peer}}));
 assert.deepEqual(acks,[['original-id',3]]);assert.equal(mutations[0][1].revokedId,'original-id');assert.equal(mutations[0][2].observedAt,now);assert.equal(seen.length,0);
});

test('snapshot and immutable webhook provenance stay distinct; location coordinates survive normalization',async()=>{
 const{provider,seen}=setup({fetchImpl:async url=>url.endsWith('/'+sessionId)?Response.json({status:'ready'}):url.includes('/chats?')?Response.json([]):Response.json({messages:[row(1,{type:'location',location:{latitude:27.58,longitude:77.7,description:'Meeting point'}})],total:1})});
 await provider.scan();assert.equal(seen[0].flags.source,'rest');assert.equal(seen[0].flags.observedAt,now);
 const normalized=normalizeIncoming(seen[0].m,0,now+5000);assert.equal(normalized.input.sharedLocation.latitude,27.58);assert.equal(normalized.input.sharedLocation.longitude,77.7);
 await provider.webhook(...signed({sessionId,event:'message.received',data:{id:'live',chatId:peer,from:peer,to:owner+'@c.us',body:'old create text',type:'text',timestamp:now/1000}}));
 assert.equal(seen.at(-1).flags.source,'webhook');
});

test('native payment triggers original delayed stage once and remains pending; historical payment is passive',async t=>{
 const engine=new Engine(':memory:',()=>now+100000);t.after(()=>engine.close());
 const{provider}=setup({get:k=>engine.get(k),put:v=>engine.put(v),onMessage:(m,{historical})=>{const n=normalizeIncoming(m,0,now+100000);if(n.reason)return;if(historical)engine.importHistory(n.input);else engine.inbound(n.input);}});
 const payment=(id,timestamp,p=peer)=>signed({sessionId,event:'message.received',data:{id,chatId:p,from:p,to:owner+'@c.us',type:'payment',body:'',timestamp,fromMe:false}});
 await provider.webhook(...payment('old-payment',now/1000-3600,'919876543211@c.us'));assert.equal(engine.stats().queued,0);
 await provider.webhook(...payment('new-payment',now/1000+1));assert.equal(engine.stats().queued,9);assert.equal(engine.contact(peer).payment,'pending');
 const media=engine.db.prepare("SELECT json FROM records WHERE kind='job' AND json_extract(json,'$.phase')='media'").all().map(r=>JSON.parse(r.json));assert.equal(media.length,4);assert.equal(media.find(m=>m.step===0).dueAt,now+100000+3600000);
 await provider.webhook(...payment('new-payment',now/1000+1));assert.equal(engine.stats().queued,9);assert.equal(engine.contact(peer).payment,'pending');
});

test('API credentials cannot be forwarded to external origins or through redirects',async()=>{
 assert.throws(()=>setup({baseUrl:'https://external.test/api'}),/loopback/);
 const{provider}=setup({fetchImpl:async(_url,options)=>{assert.equal(options.redirect,'error');return Response.json({status:'ready'});}});await provider.checkSession();
});

test('session READY alone never reports healthy before successful inbox read; failed scans recover and stopped adapter stays unready',async()=>{
 let failed=true;
 const{provider}=setup({fetchImpl:async url=>url.endsWith('/'+sessionId)?Response.json({status:'ready'}):url.includes('/chats?')?Response.json([]):failed?Response.json({}, {status:503}):Response.json({messages:[],total:0})});
 await provider.checkSession();assert.equal(provider.getState(),'ready');assert.equal(provider.getReadiness().ready,false);
 await assert.rejects(provider.scan());assert.equal(provider.getReadiness().ready,false);
 failed=false;await provider.scan();assert.equal(provider.getReadiness().ready,true);
 failed=true;await assert.rejects(provider.scan());assert.equal(provider.getReadiness().ready,false);
 failed=false;await provider.scan();assert.equal(provider.getReadiness().ready,true);
 await provider.stop();assert.equal(provider.getReadiness().ready,false);assert.equal(provider.getState(),'stopped');await provider.scan();assert.equal(provider.getReadiness().ready,false);
});

test('graceful stop aborts pending reads, rejects new work and preserves an in-flight POST response',async()=>{
 let releaseSend,postSignal,readSignal,requests=0,stopped=false;
 const {provider}=setup({fetchImpl:async(_url,options)=>{
  requests++;
  if(options.method==='POST'){
   postSignal=options.signal;
   return new Promise((resolve,reject)=>{releaseSend=()=>resolve(Response.json({messageId:'accepted-real-id'}));options.signal.addEventListener('abort',()=>reject(Error('POST aborted')),{once:true});});
  }
  readSignal=options.signal;
  return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('read aborted')),{once:true}));
 }});
 const send=provider.sendText(peer,'Original text'),read=provider.checkSession().catch(error=>error.message);
 const stop=provider.stop().then(()=>{stopped=true;});
 assert.equal(readSignal.aborted,true);assert.equal(postSignal.aborted,false);assert.equal(await read,'read aborted');assert.equal(stopped,false);
 assert.equal(provider.getState(),'stopped');assert.equal(provider.getReadiness().ready,false);
 await assert.rejects(provider.sendText(peer,'Must not start'),/stopped/);assert.equal(requests,2);
 releaseSend();assert.equal(await send,'accepted-real-id');await stop;assert.equal(stopped,true);assert.equal(postSignal.aborted,false);
});

test('stop waits for a genuine pending POST failure without masking it or retrying the send',async()=>{
 let failSend,signal,attempts=0,stopped=false;
 const {provider}=setup({fetchImpl:async(_url,options)=>{attempts++;signal=options.signal;return new Promise((_resolve,reject)=>{failSend=()=>reject(Error('Connection lost after upload'));});}});
 const send=provider.sendText(peer,'Original text').catch(error=>error.message),stop=provider.stop().then(()=>{stopped=true;});
 await Promise.resolve();assert.equal(stopped,false);assert.equal(signal.aborted,false);
 failSend();assert.equal(await send,'Connection lost after upload');await stop;assert.equal(stopped,true);assert.equal(attempts,1);assert.equal(signal.aborted,false);
});
