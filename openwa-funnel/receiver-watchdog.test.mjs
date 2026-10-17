import test from 'node:test';
import assert from 'node:assert/strict';
import {createReceiverWatchdog} from './receiver-watchdog.mjs';

test('a quiet but connected receiver never restarts or asks for another link',async()=>{
 let calls=0,time=0;
 const w=createReceiverWatchdog({probe:async()=>({ready:true,socket:'CONNECTED'}),reconnect:async()=>calls++,now:()=>time});
 for(let i=0;i<100;i++){time+=3000;await w.tick();}
 assert.equal(calls,0);assert.equal(w.status.healthy,true);assert.equal(w.status.consecutiveFailures,0);
});

test('short interruptions do not restart; sustained failures recover only when idle',async()=>{
 let calls=0,time=0,allowed=false;
 const w=createReceiverWatchdog({probe:async()=>({ready:true,socket:'DISCONNECTED'}),reconnect:async()=>calls++,canReconnect:()=>allowed,now:()=>time});
 await w.tick();time=3000;await w.tick();time=6000;await w.tick();assert.equal(calls,0);
 time=31000;await w.tick();assert.equal(calls,0);
 allowed=true;await w.tick();assert.equal(calls,1);
 time+=3000;await w.tick();assert.equal(calls,1);
 time+=30000;await w.tick();assert.equal(calls,2);
});

test('a successful probe resets the failure window and retries use backoff',async()=>{
 let time=0,ready=false,calls=0;
 const w=createReceiverWatchdog({probe:async()=>({ready,socket:'CONNECTED'}),reconnect:async()=>{calls++;throw Error('failure');},now:()=>time});
 for(const t of [0,15000,30000]){time=t;await w.tick();}
 assert.equal(calls,1);assert.equal(w.status.nextRetryAt,60000);
 ready=true;time=31000;await w.tick();assert.equal(w.status.error,'');assert.equal(w.status.nextRetryAt,0);
 ready=false;for(const t of [32000,35000,38000]){time=t;await w.tick();}
 assert.equal(calls,1);time=62000;await w.tick();assert.equal(calls,2);
 assert.equal(w.status.nextRetryAt,122000);
});

test('only one probe/recovery runs at a time and owner-disabled recovery stays disabled',async()=>{
 let release,calls=0;
 const w=createReceiverWatchdog({probe:()=>new Promise(resolve=>{release=resolve;}),reconnect:async()=>calls++,canReconnect:()=>false,recoveryDelayMs:0});
 const running=w.tick();await w.tick();assert.equal(w.busy,true);release({ready:false});await running;
 assert.equal(w.busy,false);assert.equal(w.status.consecutiveFailures,1);assert.equal(calls,0);
});
