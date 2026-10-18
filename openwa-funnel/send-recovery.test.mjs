import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from './engine.mjs';
import {createOpenwaProvider,classifySendFailure} from './openwa-provider.mjs';

const peer='919876543210@c.us',at=1800000000000;
const readyBody={statusCode:409,error:'Conflict',code:'ENGINE_NOT_READY',message:'Session is not connected. The WhatsApp client is not ready.'};
const notReady={category:'engine_not_ready',status:409,providerCode:'ENGINE_NOT_READY',providerReason:'not_connected',outcome:'not_sent',automaticRetry:true,retryAfterSeconds:null};
function setup(t){let now=at;const e=new Engine(':memory:',()=>now);t.after(()=>e.close());e.enable(true);e.inbound({id:'first',peer,body:'Hello',type:'text',at:now});return{e,advance:ms=>{now+=ms;},now:()=>now};}
function provider(fetchImpl,now=()=>at){const saved=new Map();return createOpenwaProvider({baseUrl:'http://127.0.0.1:2785/api',apiKey:'private-test-key',sessionId:'test',get:k=>saved.get(k),put:v=>saved.set(v.key,v),onMessage:()=>{},fetchImpl,now});}

test('only typed, exact pre-send readiness/pacing contracts are eligible for automatic deferral',async()=>{
 const cases=[
  [409,readyBody,true,'engine_not_ready'],
  [409,{...readyBody,message:'WhatsApp Web is reloading its page and the session is re-injecting. Retry in a few seconds.'},true,'engine_not_ready'],
  [409,{...readyBody,code:undefined},false,'api_http_error'],
  [409,{...readyBody,message:'A different conflict occurred'},false,'api_http_error'],
  [409,{...readyBody,statusCode:500},false,'api_http_error'],
  [400,readyBody,false,'api_request_rejected'],
  [500,readyBody,false,'api_http_error'],
  [429,{code:'SEND_PACING_LIMITED',message:'Internal context must not be retained'},true,'send_pacing_rejected'],
  [429,{code:'OTHER_LIMIT'},false,'api_rate_limited'],
 ];
 for(const [status,body,retry,category] of cases){
  let attempts=0;const p=provider(async()=>{attempts++;return Response.json(body,{status,headers:{'Retry-After':'12'}});});
  let error;try{await p.sendText(peer,'Hello');}catch(e){error=e;}
  const failure=classifySendFailure(error);assert.equal(failure.automaticRetry,retry);assert.equal(failure.outcome,retry?'not_sent':'unknown');assert.equal(failure.category,category);assert.equal(failure.status,status);assert.equal(failure.retryAfterSeconds,12);assert.equal(attempts,1);
  assert.doesNotMatch(JSON.stringify(failure),/Internal context/);
 }
});

test('verified readiness refusal holds readiness false for ten seconds even while session reports READY',async()=>{
 let now=at;
 const p=provider(async(url,options)=>options.method==='POST'?Response.json(readyBody,{status:409}):url.endsWith('/test')?Response.json({status:'ready'}):url.includes('/chats?')?Response.json([]):Response.json({messages:[],total:0}),()=>now);
 await p.scan();assert.equal(p.getReadiness().ready,true);
 await assert.rejects(p.sendText(peer,'Hello'));assert.equal(p.getReadiness().ready,false);assert.deepEqual(p.getReadiness().pending,['provider readiness grace']);
 now+=9999;await p.scan();assert.equal(p.getReadiness().ready,false);now++;await p.scan();assert.equal(p.getReadiness().ready,true);
});

test('verified refusal requeues the identical step with bounded backoff and never writes a fake outgoing message',t=>{
 const{e,advance,now}=setup(t);const first=e.reserve();assert.equal(e.reserve(),null);
 const result=e.deferReserved(first.key,notReady);assert.equal(result.retryAt,now()+5000);assert.equal(result.deferred,true);assert.equal(e.contact(peer).paused,false);assert.equal(e.stats().uncertain,0);assert.equal(e.stats().sending,0);assert.equal(e.stats().messages,1);assert.equal(e.contact(peer).lastSentAt,0);assert.equal(e.reserve(),null);
 advance(5000);const retry=e.reserve();assert.equal(retry.key,first.key);assert.deepEqual(retry.payload,first.payload);assert.equal(e.reserve(),null);
 assert.equal(e.deferReserved(retry.key,notReady).retryAt,now()+10000);
 advance(10000);const secondRetry=e.reserve();assert.equal(secondRetry.key,first.key);e.finish(secondRetry.key,'real-provider-id');assert.equal(e.stats().uncertain,0);assert.equal(e.get(first.key).state,'accepted');assert.equal(e.get('out:'+first.key).providerId,'real-provider-id');assert.equal(e.stats().messages,2);
});

test('deferral honors server Retry-After, caps repeat attempts and permits explicit owner retry without restarting the funnel',t=>{
 const{e,advance,now}=setup(t);let job=e.reserve();const key=job.key;
 const pacing={...notReady,status:429,providerCode:'SEND_PACING_LIMITED',providerReason:null,retryAfterSeconds:600};
 let result=e.deferReserved(key,pacing);assert.equal(result.retryAt,now()+600000);advance(600000);
 for(let attempt=2;attempt<=12;attempt++){
  job=e.reserve();assert.equal(job.key,key);result=e.deferReserved(key,notReady);assert.equal(result.attempt,attempt);
  assert.ok(result.retryAt-now()<=300000);advance(result.retryAt-now());
 }
 assert.equal(result.blocked,true);assert.equal(e.get(key).state,'blocked');assert.equal(e.get(key).failure.outcome,'not_sent');assert.equal(e.get(key).failure.automaticRetry,false);assert.equal(e.stats().blocked,1);assert.equal(e.stats().uncertain,0);assert.equal(e.contact(peer).paused,true);assert.equal(e.reserve(),null);assert.equal(e.stats().messages,1);
 assert.throws(()=>e.resolveUnknown(key,'sent'),/Invalid resolution/);e.resolveUnknown(key,'retry');assert.equal(e.get(key).deferAttempts,0);assert.equal(e.contact(peer).paused,false);assert.equal(e.reserve().key,key);
});

test('resolving a blocked send never clears a separate manual owner pause',t=>{
 const{e,advance,now}=setup(t);let job;
 for(let attempt=1;attempt<=12;attempt++){
  job=e.reserve();if(attempt===12)e.pauseContact(peer,true);const result=e.deferReserved(job.key,notReady);advance(result.retryAt-now());
 }
 assert.equal(e.contact(peer).pauseReason,'owner');e.resolveUnknown(job.key,'retry');assert.equal(e.contact(peer).paused,true);assert.equal(e.reserve(),null);
});

test('generic conflicts, network failures and already-unknown sends are never automatically requeued',t=>{
 const{e}=setup(t),job=e.reserve();
 assert.throws(()=>e.deferReserved(job.key,{...notReady,outcome:'unknown'}),/verified pre-send/);
 assert.throws(()=>e.deferReserved(job.key,{...notReady,providerCode:'OTHER'}),/verified pre-send/);
 const failure=classifySendFailure(Object.assign(Error('network lost'),{status:500}));e.finish(job.key,null,'Check WhatsApp',failure);
 assert.equal(e.deferReserved(job.key,notReady).ignored,true);assert.equal(e.get(job.key).state,'unknown');assert.equal(e.contact(peer).paused,true);assert.equal(e.reserve(),null);assert.equal(e.get(job.key).failure.status,500);
});

test('owner STOP during the request cancels a proven-unsent reservation rather than retrying it',t=>{
 const{e}=setup(t),job=e.reserve();e.inbound({id:'stop',peer,body:'STOP',type:'text',at:at+1});
 const result=e.deferReserved(job.key,notReady);assert.equal(result.cancelled,true);assert.equal(e.get(job.key).state,'cancelled');assert.equal(e.stats().queued,0);assert.equal(e.reserve(),null);
});

test('shutdown retains the existing send deadline instead of aborting a pending POST immediately',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let signal,stopped=false;
 const p=provider(async(_url,options)=>{signal=options.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('deadline'),{name:'AbortError'})),{once:true}));});
 const send=p.sendText(peer,'Hello').catch(error=>error),stop=p.stop().then(()=>{stopped=true;});
 t.mock.timers.tick(54999);await Promise.resolve();assert.equal(signal.aborted,false);assert.equal(stopped,false);
 t.mock.timers.tick(1);const error=await send;await stop;assert.equal(signal.aborted,true);assert.equal(stopped,true);assert.equal(classifySendFailure(error).category,'request_timeout');assert.equal(classifySendFailure(error).automaticRetry,false);
});

test('a send accepted during graceful stop is durably finished with its real ID instead of becoming unknown',async t=>{
 const{e}=setup(t),job=e.reserve();let release,signal;
 const p=provider(async(_url,options)=>{signal=options.signal;return new Promise(resolve=>{release=()=>resolve(Response.json({messageId:'actual-accepted-id'}));});});
 const work=p.sendText(peer,'Hello').then(id=>e.finish(job.key,id),error=>e.finish(job.key,null,'Uncertain',classifySendFailure(error)));
 const stop=p.stop();assert.equal(signal.aborted,false);release();await stop;await work;
 assert.equal(e.get(job.key).state,'accepted');assert.equal(e.get(job.key).providerId,'actual-accepted-id');assert.equal(e.get('out:'+job.key).providerId,'actual-accepted-id');assert.equal(e.stats().uncertain,0);assert.equal(e.contact(peer).paused,false);
});
