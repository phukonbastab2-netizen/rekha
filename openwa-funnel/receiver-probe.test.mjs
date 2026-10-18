import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {createReceiverProbe,emitReceiverProbe,readMirrorSnapshot} from './receiver-probe.mjs';

test('functional receiver probe requires both SDK gateway callbacks, not just callable bindings',async()=>{
 const probe=createReceiverProbe({timeoutMs:30,intervalMs:0});let calls=0;
 const evaluate=async(fn,arg)=>{calls++;probe.consume({__rekhaReceiverProbe:arg.token,__rekhaProbeDirection:'in'},'in');return true;};
 assert.equal((await probe.check(evaluate)).ready,false);assert.equal(calls,1);
 assert.equal((await probe.check(async(fn,arg)=>{for(const direction of ['in','out'])assert.equal(probe.consume({__rekhaReceiverProbe:arg.token,__rekhaProbeDirection:direction},direction),true);return true;})).ready,true);
});
test('probe control cannot consume a customer message and overlapping checks share one operation',async()=>{
 const probe=createReceiverProbe({timeoutMs:100});let release,calls=0;
 const evaluate=async(fn,arg)=>{calls++;await new Promise(resolve=>release=resolve);for(const direction of ['in','out'])probe.consume({__rekhaReceiverProbe:arg.token,__rekhaProbeDirection:direction},direction);return true;};
 const a=probe.check(evaluate),b=probe.check(evaluate);await Promise.resolve();
 assert.equal(probe.consume({body:'Hi'},'in'),false);assert.equal(probe.consume({__rekhaReceiverProbe:'wrong',__rekhaProbeDirection:'in'},'in'),false);
 release();assert.equal((await a).ready,true);assert.equal((await b).ready,true);assert.equal(calls,1);
 await probe.check(evaluate);assert.equal(calls,1);
});
test('probe emits only local controls with no real peer, message ID or body',async()=>{
 const seen=[],context={OpenWA_RuntimeMessageReceived:m=>seen.push(m),OpenWA_RuntimeAnyMessage:m=>seen.push(m)};
 const emit=vm.runInNewContext('('+emitReceiverProbe.toString()+')',context);
 assert.equal(await emit({token:'private-test'}),true);assert.equal(seen.length,2);
 for(const m of seen){assert.equal(m.from,undefined);assert.equal(m.to,undefined);assert.equal(m.id,undefined);assert.equal(m.body,undefined);}
 delete context.OpenWA_RuntimeAnyMessage;assert.equal(await emit({token:'private-test'}),false);
});
test('mirror timestamps reflect actual native messages, not connection probes or protocol notices',()=>{
 const at=Date.now()-10000,context={Store:{Chat:{_models:[{}]},Msg:{_models:[{type:'chat',t:at/1000,id:{fromMe:false}},{type:'chat',t:(at+1000)/1000,id:{fromMe:true}},{type:'e2e_notification',t:Date.now()/1000},{type:'chat',t:Date.now()/1000,isNotification:true}]}}};
 const snapshot=vm.runInNewContext('('+readMirrorSnapshot.toString()+')',context)();
 assert.equal(snapshot.lastIncomingAt,at);assert.equal(snapshot.lastOutgoingAt,at+1000);assert.equal(snapshot.lastProviderMessageAt,at+1000);assert.equal(snapshot.providerChats,1);
});
