import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createVoiceRelay} from '../shared/voice-relay.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
const workletSource=fs.readFileSync(new URL('../shared/voice-relay-worklet.js',import.meta.url),'utf8');
function processorFixture(rate=48000){
  const sent=[];let Processor;
  const scope={sampleRate:rate,AudioWorkletProcessor:class {constructor(){this.port={postMessage:message=>sent.push(message),onmessage:null};}},registerProcessor:(name,value)=>{assert.equal(name,'rekha-voice-relay');Processor=value;}};
  vm.runInNewContext(workletSource,scope);
  const processor=new Processor();
  const state=(active=true,paused=false)=>processor.port.onmessage({data:{type:'state',active,paused}});
  const frame=(value,frequency=0)=>{const pcm=new ArrayBuffer(1280),view=new DataView(pcm);for(let i=0;i<640;i++)view.setInt16(i*2,Math.round((frequency?Math.sin(2*Math.PI*frequency*i/16000):1)*value*32767),true);return pcm;};
  const receive=pcm=>processor.port.onmessage({data:{type:'playback',pcm}});
  const run=(input,length=input.length)=>{const output=new Float32Array(length);processor.process([[input]],[[output]]);return output;};
  const captureTone=(frequency,amplitude=0.8,duration=0.04)=>{const count=Math.round(rate*duration);for(let offset=0;offset<count;offset+=128){const size=Math.min(128,count-offset),input=new Float32Array(size);for(let i=0;i<size;i++)input[i]=amplitude*Math.sin(2*Math.PI*frequency*(offset+i)/rate);run(input);}};
  return {processor,sent,state,frame,receive,run,captureTone};
}
const rms=values=>Math.sqrt(values.reduce((sum,value)=>sum+value*value,0)/values.length);
const decoded=pcm=>{const view=new DataView(pcm);return Array.from({length:640},(_,i)=>view.getInt16(i*2,true)/32768);};

test('worklet downsamples native audio to exact 16k PCM16LE frames and never monitors the local microphone',()=>{
  const f=processorFixture();f.state();f.captureTone(1000);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].pcm.byteLength,1280);assert.equal(decoded(f.sent[0].pcm).length,640);
  const amplitude=rms(decoded(f.sent[0].pcm));assert.ok(amplitude>0.5&&amplitude<0.6);
  assert.ok(f.run(new Float32Array(128).fill(0.9)).every(value=>value===0),'local input must not reach speaker output');
});
test('capture lowpass rejects above-Nyquist energy before downsampling',()=>{
  const f=processorFixture();f.state();f.captureTone(12000);
  assert.equal(f.sent.length,1);assert.ok(rms(decoded(f.sent[0].pcm))<0.08,'12kHz native tone must not alias into the 16k voice frame');
});
test('native 44.1k capture maintains 25 exact 40ms frames per second and muted samples encode as zero',()=>{
  const f=processorFixture(44100);f.state();f.captureTone(1000,0.6,1);
  assert.equal(f.sent.length,25);assert.ok(f.sent.every(message=>message.pcm.byteLength===1280));
  const silent=processorFixture();silent.state();for(let i=0;i<15;i++)silent.run(new Float32Array(128));assert.equal(silent.sent.length,1);assert.ok(decoded(silent.sent[0].pcm).every(value=>value===0));
});
test('playback decodes little-endian voice and resamples 16k to native output without a local loopback',()=>{
  const f=processorFixture();f.state();f.receive(f.frame(0.8,1000));const rendered=[];
  for(let i=0;i<15;i++)rendered.push(...f.run(new Float32Array(128)));
  assert.equal(rendered.length,1920);assert.ok(rms(rendered)>0.5&&rms(rendered)<0.6);assert.equal(f.processor.queuedSamples,0);
});
test('paused playback keeps only the newest 240ms, stops capture, and close clears the worklet',()=>{
  const f=processorFixture();f.state(true,true);for(let i=1;i<=10;i++)f.receive(f.frame(i/20));
  assert.equal(f.processor.queuedSamples,3840);assert.ok(f.run(new Float32Array(128).fill(1)).every(value=>value===0));assert.equal(f.sent.length,0);
  f.state(true,false);const output=f.run(new Float32Array(128));assert.ok(Math.abs(output[0]-0.25)<0.001,'four oldest frames must be dropped');
  f.processor.port.onmessage({data:{type:'close'}});assert.equal(f.processor.queuedSamples,0);assert.equal(f.processor.process([],[[new Float32Array(128)]]),false);
});
test('lost peer state clears pending playback and partially captured audio before a new peer joins',()=>{
  const f=processorFixture();f.state();f.receive(f.frame(0.8));f.run(new Float32Array(128).fill(0.7));
  assert.ok(f.processor.queuedSamples>0);assert.ok(f.processor.frameSamples>0);f.state(false);
  assert.equal(f.processor.queuedSamples,0);assert.equal(f.processor.frameSamples,0);f.state();
  const output=f.run(new Float32Array(128));assert.ok(output.every(value=>value===0));assert.equal(f.sent.length,0,'a partial old capture must not finish on the new connection');
});

function clientFixture(options={}) {
  const saved=new Map(),contexts=[],sockets=[],nodes=[],streams=[],gains=[];let attempts=0,maxLiveSockets=0;
  const replace=(key,value)=>{saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
  let clock=null;
  if(options.clock){
    let now=100000,id=0;const timers=new Map(),NativeDate=Date;
    const schedule=(callback,delay,args,interval=0)=>{const token=++id;timers.set(token,{callback,args,at:now+Math.max(0,Number(delay)||0),interval});return token;};
    replace('Date',class extends NativeDate {static now(){return now;}});
    replace('performance',{now:()=>now});
    replace('setTimeout',(callback,delay,...args)=>schedule(callback,delay,args));replace('clearTimeout',token=>timers.delete(token));
    replace('setInterval',(callback,delay,...args)=>schedule(callback,delay,args,Math.max(1,Number(delay)||1)));replace('clearInterval',token=>timers.delete(token));
    clock={get now(){return now;},get timers(){return timers.size;},async tick(ms){
      const until=now+ms;let runs=0;
      while(true){const next=[...timers].filter(([,timer])=>timer.at<=until).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;
        if(++runs>2000)throw Error('Fixture timer did not settle');const [token,timer]=next;now=timer.at;
        if(timer.interval)timer.at+=timer.interval;else timers.delete(token);timer.callback(...timer.args);await settle();
      }now=until;await settle();
    }};
  }
  const stream=()=>{const track={enabled:true,stops:0,stop(){this.stops++;}},value={track,getAudioTracks:()=>[track],getTracks:()=>[track]};streams.push(value);return value;};
  const input=stream(),resumes=[...(options.resumes||['running'])],modulePending=options.modulePending?deferred():null;
  replace('location',{href:options.location||'https://owned.example/admin'});
  class Context extends EventTarget {
    constructor(){super();this.state='suspended';this.destination={};this.closeCalls=0;this.sources=[];this.audioWorklet={addModule:url=>{this.moduleUrl=String(url);return modulePending?.promise||Promise.resolve();}};contexts.push(this);}
    change(value){this.state=value;this.dispatchEvent(new Event('statechange'));}
    resume(){const action=resumes.shift()||'running';if(action==='pending')return new Promise(()=>{});if(action==='reject')return Promise.reject(Error('Refused'));this.change('running');return Promise.resolve();}
    createMediaStreamSource(value){const node={input:value,connect(target){this.connected=target;},disconnect(){this.disconnected=true;}};this.sources.push(node);return node;}
    createGain(){const node={gain:{value:1},connect(target){this.connected=target;},disconnect(){this.disconnected=true;}};gains.push(node);return node;}
    close(){this.closeCalls++;this.change('closed');return Promise.resolve();}
  }
  class Socket {
    constructor(url){attempts++;if(options.socketThrow||options.failAttempts?.includes(attempts))throw Error('Blocked');this.url=url;this.readyState=0;this.bufferedAmount=0;this.sent=[];this.closeCalls=0;sockets.push(this);maxLiveSockets=Math.max(maxLiveSockets,sockets.filter(value=>value.readyState!==3).length);}
    open(){this.readyState=1;this.onopen?.();}
    control(data){this.onmessage?.({data:JSON.stringify(data)});}
    receive(data){this.onmessage?.({data});}
    send(value){if(this.sendThrow)throw Error('Network failed');this.sent.push(value);}
    fail(){this.onerror?.({});}
    drop(code=1006){this.readyState=3;this.onclose?.({code});}
    close(code=1000){this.closeCalls++;this.closeCode=code;this.readyState=2;if(!options.deferClose)this.finishClose();}
    finishClose(code=this.closeCode||1000){this.readyState=3;this.onclose?.({code});}
  }
  class Worklet {
    constructor(){this.port={messages:[],onmessage:null,postMessage(value){this.messages.push(value);},close(){this.closed=true;}};nodes.push(this);}
    connect(target){this.connected=target;}disconnect(){this.disconnected=true;}
  }
  replace('AudioContext',Context);replace('WebSocket',Socket);replace('AudioWorkletNode',Worklet);
  return {contexts,sockets,nodes,streams,gains,input,stream,modulePending,clock,get attempts(){return attempts;},get maxLiveSockets(){return maxLiveSockets;},restore(){for(const [key,value]of saved)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}};
}
const relayOptions=f=>({stream:f.input,url:'wss://owned.example/api/admin/calls/test-call/audio',timeoutMs:40});

test('relay uses only the private authenticated socket, peer controls, bounded send backpressure and supplied input',async()=>{
  const f=clientFixture(),states=[],errors=[];let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),onState:value=>states.push(value),onError:value=>errors.push(value)});f.sockets[0].open();await relay.readyPromise;
    assert.equal(relay.state,'running');assert.equal(f.sockets[0].binaryType,'arraybuffer');assert.equal(f.contexts[0].sources[0].input,f.input);assert.equal(f.gains[0].gain.value,1);
    f.sockets[0].control({type:'peer',connected:true});assert.deepEqual(states,['waiting','connected']);
    const frame=new ArrayBuffer(1280);f.nodes[0].port.onmessage({data:{type:'capture',pcm:frame}});assert.equal(f.sockets[0].sent.length,1);
    f.sockets[0].bufferedAmount=65500;f.nodes[0].port.onmessage({data:{type:'capture',pcm:frame}});assert.equal(f.sockets[0].sent.length,1);
    f.sockets[0].control({type:'peer',connected:false});f.nodes[0].port.onmessage({data:{type:'capture',pcm:frame}});assert.equal(f.sockets[0].sent.length,1);assert.equal(states.at(-1),'waiting');
    await relay.close();assert.equal(states.at(-1),'disconnected');assert.deepEqual(errors,[]);assert.equal(f.input.track.stops,0);assert.equal(f.nodes[0].disconnected,true);
  } finally {await relay?.close();f.restore();}
});
test('cross-origin, insecure remote and credential-bearing socket URLs are rejected before audio or network starts',async()=>{
  for(const url of ['wss://outside.example/api/calls/a/audio','ws://owned.example/api/calls/a/audio','wss://secret:password@owned.example/api/calls/a/audio','wss://owned.example/api/calls/a/audio?secret=private']){
    const f=clientFixture(),errors=[];let relay;
    try{relay=createVoiceRelay({...relayOptions(f),url,onError:value=>errors.push(value)});await assert.rejects(relay.readyPromise,error=>error.code==='VOICE_RELAY_ORIGIN');assert.equal(f.contexts.length,0);assert.equal(f.sockets.length,0);assert.ok(errors.every(value=>!value.includes('secret')&&!value.includes('password')&&!value.includes('private')));}finally{await relay?.close();f.restore();}
  }
});
test('localhost HTTP development may use only its matching local ws origin',async()=>{
  const f=clientFixture({location:'http://localhost:4318/'});let relay;
  try{relay=createVoiceRelay({...relayOptions(f),url:'ws://localhost:4318/api/calls/test-call/audio'});f.sockets[0].open();await relay.readyPromise;assert.equal(f.sockets[0].url,'ws://localhost:4318/api/calls/test-call/audio');}finally{await relay?.close();f.restore();}
});
test('blocked socket or Web Audio startup reaches a deadline and releases context without stopping input', {timeout:1000},async()=>{
  for(const mode of ['socket','audio']){
    const f=clientFixture(mode==='audio'?{resumes:['pending']}:{ });let relay;
    try{relay=createVoiceRelay(relayOptions(f));if(mode==='audio')f.sockets[0].open();await assert.rejects(relay.readyPromise,/could not start|did not start/);assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.sockets[0].closeCalls,1);assert.equal(f.input.track.stops,0);}finally{await relay?.close();f.restore();}
  }
});
test('rejected AudioContext startup or a synchronous socket failure rejects ready and releases only owned resources',async()=>{
  for(const options of [{resumes:['reject']},{socketThrow:true}]){
    const f=clientFixture(options),errors=[],states=[];let relay;
    try{relay=createVoiceRelay({...relayOptions(f),onError:value=>errors.push(value),onState:value=>states.push(value)});f.sockets[0]?.open();await assert.rejects(relay.readyPromise,error=>error.code===(options.socketThrow?'VOICE_RELAY_SOCKET':'VOICE_RELAY_AUDIO'));await settle();assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.nodes.length,0);assert.equal(f.input.track.stops,0);assert.equal(errors.length,1);assert.equal(states.at(-1),'disconnected');assert.equal(states.filter(value=>value==='disconnected').length,1);}finally{await relay?.close();f.restore();}
  }
});
test('runtime context resume cannot remain pending forever and close invalidates subsequent attempts', {timeout:1000},async()=>{
  const f=clientFixture({resumes:['running','pending']});let relay;
  try{relay=createVoiceRelay(relayOptions(f));f.sockets[0].open();await relay.readyPromise;f.contexts[0].change('suspended');await assert.rejects(relay.resume(),error=>error.code==='VOICE_RELAY_AUDIO');assert.equal(relay.state,'suspended');await relay.close();await assert.rejects(relay.resume(),error=>error.code==='VOICE_RELAY_CLOSED');assert.equal(f.input.track.stops,0);}finally{await relay?.close();f.restore();}
});
test('close during module loading cancels ready and pending stream replacement; late module success creates no graph',async()=>{
  const f=clientFixture({modulePending:true});let relay;
  try {
    relay=createVoiceRelay(relayOptions(f));f.sockets[0].open();const replacement=f.stream(),ready=assert.rejects(relay.readyPromise,error=>error.code==='VOICE_RELAY_CLOSED'),swapping=assert.rejects(relay.setStream(replacement),error=>error.code==='VOICE_RELAY_CLOSED');
    await relay.close();await ready;await swapping;f.modulePending.resolve();await settle();assert.equal(f.nodes.length,0);assert.ok(f.streams.every(value=>value.track.stops===0));assert.equal(f.contexts[0].closeCalls,1);
  } finally {await relay?.close();f.restore();}
});
test('runtime pause bounds received queue and resume/stream replacement preserve input ownership',async()=>{
  const f=clientFixture(),audioStates=[];let relay;
  try {
    relay=createVoiceRelay(relayOptions(f));f.sockets[0].open();await relay.readyPromise;f.sockets[0].control({type:'peer',connected:true});const unsubscribe=relay.subscribeState(value=>audioStates.push(value));
    f.contexts[0].change('interrupted');const before=f.nodes[0].port.messages.length;for(let i=0;i<20;i++)f.sockets[0].receive(new ArrayBuffer(1280));assert.equal(f.nodes[0].port.messages.length,before,'paused incoming frames stay in a capped main-thread queue');
    await relay.resume();assert.deepEqual(audioStates,['interrupted','running']);assert.equal(f.nodes[0].port.messages.filter(value=>value.type==='playback').length,6);
    const original=f.contexts[0].sources[0],replacement=f.stream();await relay.setStream(replacement);assert.equal(original.disconnected,true);assert.equal(f.contexts[0].sources.at(-1).input,replacement);unsubscribe();
    await relay.close();f.contexts[0].change('running');assert.deepEqual(audioStates,['interrupted','running']);assert.ok(f.streams.every(value=>value.track.stops===0));await assert.rejects(relay.resume(),error=>error.code==='VOICE_RELAY_CLOSED');
  } finally {await relay?.close();f.restore();}
});
test('invalid binary audio closes safely with descriptive errors that contain no media data',async()=>{
  const f=clientFixture(),errors=[];let relay;
  try{relay=createVoiceRelay({...relayOptions(f),onError:value=>errors.push(value)});f.sockets[0].open();await relay.readyPromise;f.sockets[0].control({type:'peer',connected:true});f.sockets[0].receive(new ArrayBuffer(2048));assert.deepEqual(errors,['The call relay received an invalid audio frame.']);assert.equal(relay.state,'closed');assert.equal(f.input.track.stops,0);}finally{await relay?.close();f.restore();}
});

test('receive volume is stored before ready, clamps safely, and affects only the remote playback path',async()=>{
  const f=clientFixture(),states=[];let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),onState:value=>states.push(value)});assert.equal(relay.setVolume(0.25),0.25);
    f.sockets[0].open();await relay.readyPromise;f.sockets[0].control({type:'peer',connected:true});
    assert.equal(f.gains.length,1);const gain=f.gains[0];assert.equal(gain.gain.value,0.25);
    assert.equal(f.nodes[0].connected,gain);assert.equal(gain.connected,f.contexts[0].destination);assert.equal(f.contexts[0].sources[0].connected,f.nodes[0]);
    assert.equal(relay.setVolume(-1),0);assert.equal(gain.gain.value,0);const pcm=new ArrayBuffer(1280);
    f.nodes[0].port.onmessage({data:{type:'capture',pcm}});assert.equal(f.sockets[0].sent[0],pcm,'speaker volume must not suppress or modify outgoing microphone frames');
    assert.equal(relay.setVolume(3),1);assert.equal(relay.setVolume(0.6),0.6);for(const value of [NaN,Infinity,'0.4',null])assert.throws(()=>relay.setVolume(value),TypeError);
    await relay.close();assert.equal(gain.disconnected,true);assert.equal(relay.setVolume(0),0.6);assert.equal(gain.gain.value,0.6);assert.equal(f.input.track.stops,0);assert.equal(states.filter(value=>value==='disconnected').length,1);
  } finally {await relay?.close();f.restore();}
});

test('transient reconnect reuses audio graph, muted input and volume, discards old audio, and ignores stale socket events',async()=>{
  const f=clientFixture({clock:true}),states=[],errors=[];let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000,onState:value=>states.push(value),onError:value=>errors.push(value)});
    const old=f.sockets[0];old.open();await relay.readyPromise;old.control({type:'peer',connected:true});relay.setVolume(0.35);f.input.track.enabled=false;
    f.contexts[0].change('interrupted');for(let i=0;i<6;i++)old.receive(new ArrayBuffer(1280));const staleMessage=old.onmessage,staleOpen=old.onopen;
    old.drop(1006);assert.equal(states.at(-1),'waiting');assert.equal(f.nodes[0].port.messages.at(-1).active,false);
    const capture=new ArrayBuffer(1280);f.nodes[0].port.onmessage({data:{type:'capture',pcm:capture}});assert.equal(old.sent.length,0);
    await f.clock.tick(249);assert.equal(f.sockets.length,1);await f.clock.tick(1);const next=f.sockets[1];assert.equal(next.url,old.url);next.open();
    f.nodes[0].port.onmessage({data:{type:'capture',pcm:capture}});assert.equal(next.sent.length,0,'wait for authenticated peer presence before sending');
    next.control({type:'peer',connected:true});await relay.resume();assert.equal(f.nodes[0].port.messages.filter(value=>value.type==='playback').length,0,'queued old PCM must not play after recovery');
    staleMessage({data:JSON.stringify({type:'peer',connected:false})});staleMessage({data:new ArrayBuffer(1280)});staleOpen();assert.equal(states.at(-1),'connected');
    const incoming=new ArrayBuffer(1280);next.receive(incoming);assert.equal(f.nodes[0].port.messages.at(-1).pcm,incoming);
    f.nodes[0].port.onmessage({data:{type:'capture',pcm:capture}});assert.equal(next.sent[0],capture);assert.equal(old.sent.length,0);
    assert.equal(f.contexts.length,1);assert.equal(f.nodes.length,1);assert.equal(f.contexts[0].sources.length,1);assert.equal(f.gains.length,1);assert.equal(f.gains[0].gain.value,0.35);assert.equal(f.input.track.enabled,false);assert.equal(f.maxLiveSockets,1);
    assert.deepEqual(states,['waiting','connected','waiting','connected']);assert.deepEqual(errors,[]);assert.equal(f.contexts[0].closeCalls,0);
    await relay.close();assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.input.track.stops,0);assert.equal(f.clock.timers,0);
  } finally {await relay?.close();f.restore();}
});

test('peer departure clears paused receive buffers even while the caller socket stays open',async()=>{
  const f=clientFixture();let relay;
  try {
    relay=createVoiceRelay(relayOptions(f));const socket=f.sockets[0];socket.open();await relay.readyPromise;socket.control({type:'peer',connected:true});f.contexts[0].change('suspended');
    for(let i=0;i<6;i++)socket.receive(new ArrayBuffer(1280));socket.control({type:'peer',connected:false});socket.receive(new ArrayBuffer(1280));socket.control({type:'peer',connected:true});await relay.resume();
    assert.equal(f.nodes[0].port.messages.filter(value=>value.type==='playback').length,0);assert.equal(f.sockets.length,1);
  } finally {await relay?.close();f.restore();}
});

test('socket error waits for old CLOSED before replacing it and successful recovery never overlaps roles',async()=>{
  const f=clientFixture({clock:true,deferClose:true}),states=[];let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000,onState:value=>states.push(value)});const old=f.sockets[0];old.open();await relay.readyPromise;old.control({type:'peer',connected:true});
    old.fail();assert.equal(old.readyState,2);await f.clock.tick(1000);assert.equal(f.sockets.length,1,'closing sockets must not have a successor');old.finishClose();await f.clock.tick(250);
    assert.equal(f.sockets.length,2);const next=f.sockets[1];next.open();next.control({type:'peer',connected:true});assert.equal(f.maxLiveSockets,1);assert.equal(states.at(-1),'connected');assert.equal(states.includes('disconnected'),false);
    await relay.close();next.finishClose();assert.equal(f.clock.timers,0);
  } finally {await relay?.close();f.restore();}
});

test('send failure drops unsent audio and resumes with new live frames rather than replaying a queue',async()=>{
  const f=clientFixture({clock:true});let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000});const old=f.sockets[0];old.open();await relay.readyPromise;old.control({type:'peer',connected:true});old.sendThrow=true;
    const failed=new ArrayBuffer(1280);f.nodes[0].port.onmessage({data:{type:'capture',pcm:failed}});await f.clock.tick(250);const next=f.sockets[1];next.open();next.control({type:'peer',connected:true});assert.equal(next.sent.length,0);
    const fresh=new ArrayBuffer(1280);f.nodes[0].port.onmessage({data:{type:'capture',pcm:fresh}});assert.deepEqual(next.sent,[fresh]);
  } finally {await relay?.close();f.restore();}
});

test('failed reconnect attempts have increasing delays, a four-attempt limit and one final failure',async()=>{
  const f=clientFixture({clock:true,failAttempts:[2,3,4,5]}),states=[],errors=[];let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000,onState:value=>states.push(value),onError:value=>errors.push(value)});f.sockets[0].open();await relay.readyPromise;f.sockets[0].control({type:'peer',connected:true});f.sockets[0].drop();
    for(const [delay,count]of [[250,2],[750,3],[1500,4],[3000,5]]){await f.clock.tick(delay-1);assert.equal(f.attempts,count-1);await f.clock.tick(1);assert.equal(f.attempts,count);}
    assert.equal(relay.state,'closed');assert.equal(errors.length,1);assert.match(errors[0],/could not reconnect/);assert.equal(states.filter(value=>value==='disconnected').length,1);assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.clock.timers,0);assert.equal(f.input.track.stops,0);
    await f.clock.tick(60000);assert.equal(f.attempts,5);
  } finally {await relay?.close();f.restore();}
});

test('stalled reconnect handshakes cannot keep an ended recovery alive beyond 15 seconds',async()=>{
  const f=clientFixture({clock:true}),states=[],errors=[];let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000,onState:value=>states.push(value),onError:value=>errors.push(value)});f.sockets[0].open();await relay.readyPromise;f.sockets[0].control({type:'peer',connected:true});f.sockets[0].drop();
    await f.clock.tick(14999);assert.equal(relay.state,'running');assert.equal(states.at(-1),'waiting');await f.clock.tick(1);
    assert.equal(relay.state,'closed');assert.equal(errors.length,1);assert.equal(states.filter(value=>value==='disconnected').length,1);assert.ok(f.attempts<=5);assert.equal(f.maxLiveSockets,1);assert.equal(f.clock.timers,0);
  } finally {await relay?.close();f.restore();}
});

test('a socket that never acknowledges close fails without creating a second role connection',async()=>{
  const f=clientFixture({clock:true,deferClose:true}),errors=[];let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000,onError:value=>errors.push(value)});f.sockets[0].open();await relay.readyPromise;f.sockets[0].control({type:'peer',connected:true});f.sockets[0].fail();await f.clock.tick(3000);
    assert.equal(relay.state,'closed');assert.equal(f.sockets.length,1);assert.equal(errors.length,1);assert.match(errors[0],/stopped responding/);assert.equal(f.clock.timers,0);
  } finally {await relay?.close();f.restore();}
});

test('normal call end, policy, framing and authorization close codes are fatal without automatic retries',async()=>{
  for(const mode of ['ended',1000,1002,1003,1007,1008,1009,4009]){
    const f=clientFixture({clock:true}),states=[];let relay;
    try {
      relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000,onState:value=>states.push(value)});const socket=f.sockets[0];socket.open();await relay.readyPromise;socket.control({type:'peer',connected:true});
      if(mode==='ended')socket.control({type:'ended',reason:'Call ended'});else socket.drop(mode);await f.clock.tick(16000);
      assert.equal(relay.state,'closed',String(mode));assert.equal(f.attempts,1,String(mode));assert.equal(states.filter(value=>value==='disconnected').length,1);assert.equal(f.clock.timers,0);
    } finally {await relay?.close();f.restore();}
  }
});

test('transient network and service restart close codes allow the existing call to recover',async()=>{
  for(const code of [1001,1005,1006,1011,1012,1013]){
    const f=clientFixture({clock:true});let relay;
    try {
      relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000});f.sockets[0].open();await relay.readyPromise;f.sockets[0].control({type:'peer',connected:true});f.sockets[0].drop(code);await f.clock.tick(250);assert.equal(f.sockets.length,2,String(code));f.sockets[1].open();f.sockets[1].control({type:'peer',connected:true});assert.equal(relay.state,'running');
    } finally {await relay?.close();f.restore();}
  }
});

test('rapid successful reconnects cannot exceed six socket joins per minute',async()=>{
  const f=clientFixture({clock:true}),errors=[];let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000,onError:value=>errors.push(value)});f.sockets[0].open();await relay.readyPromise;f.sockets[0].control({type:'peer',connected:true});
    for(let i=1;i<=5;i++){f.sockets.at(-1).drop();await f.clock.tick(250);assert.equal(f.sockets.length,i+1);f.sockets.at(-1).open();f.sockets.at(-1).control({type:'peer',connected:true});}
    f.sockets.at(-1).drop();await f.clock.tick(250);assert.equal(relay.state,'closed');assert.equal(f.attempts,6);assert.equal(errors.length,1);assert.match(errors[0],/changed too often/);assert.equal(f.maxLiveSockets,1);assert.equal(f.clock.timers,0);
  } finally {await relay?.close();f.restore();}
});

test('ending a call during retry backoff cancels reconnects, timers, stale events and audio resources once',async()=>{
  const f=clientFixture({clock:true}),states=[],errors=[];let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000,onState:value=>states.push(value),onError:value=>errors.push(value)});const socket=f.sockets[0];socket.open();await relay.readyPromise;socket.control({type:'peer',connected:true});const stale=socket.onmessage;
    socket.drop();await relay.close();await relay.close();stale({data:JSON.stringify({type:'peer',connected:true})});await f.clock.tick(60000);
    assert.equal(f.attempts,1);assert.equal(f.clock.timers,0);assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.nodes[0].disconnected,true);assert.equal(f.gains[0].disconnected,true);assert.equal(f.input.track.stops,0);assert.deepEqual(errors,[]);assert.equal(states.filter(value=>value==='disconnected').length,1);
  } finally {await relay?.close();f.restore();}
});

test('server call-end controls report safe reasons before disconnected and stop without errors or retries',async()=>{
  for(const reason of ['completed','cancelled','declined','expired','blocked','connection-failed']){
    const f=clientFixture({clock:true}),events=[],errors=[];let relay;
    try {
      relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000,onEnded:value=>events.push('ended:'+value),onState:value=>events.push(value),onError:value=>errors.push(value)});const socket=f.sockets[0];socket.open();await relay.readyPromise;socket.control({type:'peer',connected:true});const stale=socket.onmessage;
      socket.control({type:'ended',reason});stale({data:JSON.stringify({type:'ended',reason})});await settle();await f.clock.tick(16000);
      assert.deepEqual(events,['waiting','connected','ended:'+reason,'disconnected']);assert.deepEqual(errors,[]);assert.equal(relay.state,'closed');assert.equal(f.attempts,1);assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.input.track.stops,0);assert.equal(f.clock.timers,0);
    } finally {await relay?.close();f.restore();}
  }
});

test('unknown or malformed server end reasons never reach the call UI verbatim',async()=>{
  for(const reason of [undefined,null,{},7,'<script>private media</script>','completed\nprivate']){
    const f=clientFixture({clock:true}),reasons=[];let relay;
    try {
      relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000,onEnded:value=>reasons.push(value)});f.sockets[0].open();await relay.readyPromise;f.sockets[0].control({type:'ended',reason});await settle();
      assert.deepEqual(reasons,['completed']);assert.equal(relay.state,'closed');assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.clock.timers,0);
    } finally {await relay?.close();f.restore();}
  }
});

test('call-end callback can close reentrantly or throw without duplicate callbacks or incomplete teardown',async()=>{
  for(const mode of ['reentrant','throws']){
    const f=clientFixture({clock:true}),reasons=[],errors=[],states=[],callbackStates=[];let relay;
    try {
      relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000,onState:value=>states.push(value),onError:value=>errors.push(value),onEnded:reason=>{
        reasons.push(reason);callbackStates.push(relay.state);if(mode==='throws')throw Error('UI callback failed');
        f.sockets[0].control({type:'ended',reason:'declined'});relay.close();
      }});f.sockets[0].open();await relay.readyPromise;f.sockets[0].control({type:'peer',connected:true});f.sockets[0].control({type:'ended',reason:'completed'});await settle();await f.clock.tick(16000);
      assert.deepEqual(reasons,['completed']);assert.deepEqual(callbackStates,['running']);assert.deepEqual(errors,[]);assert.equal(states.filter(value=>value==='disconnected').length,1);assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.sockets[0].closeCalls,1);assert.equal(f.nodes[0].disconnected,true);assert.equal(f.gains[0].disconnected,true);assert.equal(f.attempts,1);assert.equal(f.clock.timers,0);
    } finally {await relay?.close();f.restore();}
  }
});

test('queued capture bursts are dropped under a monotonic 30ms send floor and never replay later',async()=>{
  const f=clientFixture({clock:true});let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000});const socket=f.sockets[0];socket.open();await relay.readyPromise;socket.control({type:'peer',connected:true});
    const send=pcm=>f.nodes[0].port.onmessage({data:{type:'capture',pcm}}),first=new ArrayBuffer(1280);send(first);
    for(let i=0;i<100;i++)send(new ArrayBuffer(1280));assert.deepEqual(socket.sent,[first]);await f.clock.tick(29);send(new ArrayBuffer(1280));assert.equal(socket.sent.length,1);
    await f.clock.tick(1);const fresh=new ArrayBuffer(1280);send(fresh);assert.deepEqual(socket.sent,[first,fresh]);await f.clock.tick(2000);assert.equal(socket.sent.length,2,'discarded captures must not be replayed by a timer');
    const window=f.clock.now;for(let i=0;i<100;i++){send(new ArrayBuffer(1280));await f.clock.tick(10);}assert.equal(f.clock.now-window,1000);assert.equal(socket.sent.length-2,34,'even a sustained 100fps callback burst stays below the server 40fps limit');
  } finally {await relay?.close();f.restore();}
});

test('ordinary 40ms microphone cadence passes every frame unchanged through capture pacing',async()=>{
  const f=clientFixture({clock:true});let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000});const socket=f.sockets[0];socket.open();await relay.readyPromise;socket.control({type:'peer',connected:true});const frames=[];
    for(let i=0;i<25;i++){const pcm=new ArrayBuffer(1280);new DataView(pcm).setInt16(0,i+1,true);frames.push(pcm);f.nodes[0].port.onmessage({data:{type:'capture',pcm}});await f.clock.tick(40);}
    assert.deepEqual(socket.sent,frames);assert.equal(socket.sent.length,25);
  } finally {await relay?.close();f.restore();}
});

test('peer loss and reconnect reset capture pacing without transmitting waiting or old frames',async()=>{
  const f=clientFixture({clock:true});let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),timeoutMs:5000});const old=f.sockets[0];old.open();await relay.readyPromise;old.control({type:'peer',connected:true});const send=pcm=>f.nodes[0].port.onmessage({data:{type:'capture',pcm}});
    send(new ArrayBuffer(1280));old.control({type:'peer',connected:false});send(new ArrayBuffer(1280));assert.equal(old.sent.length,1);old.control({type:'peer',connected:true});send(new ArrayBuffer(1280));assert.equal(old.sent.length,2,'a newly joined peer begins a fresh capture cadence');
    old.drop();send(new ArrayBuffer(1280));await f.clock.tick(250);const next=f.sockets[1];next.open();send(new ArrayBuffer(1280));assert.equal(next.sent.length,0);next.control({type:'peer',connected:true});const fresh=new ArrayBuffer(1280);send(fresh);assert.deepEqual(next.sent,[fresh]);assert.equal(old.sent.length,2);
  } finally {await relay?.close();f.restore();}
});
