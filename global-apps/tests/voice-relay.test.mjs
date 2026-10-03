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

function clientFixture(options={}) {
  const saved=new Map(),contexts=[],sockets=[],nodes=[],streams=[];
  const replace=(key,value)=>{saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
  const stream=()=>{const track={stops:0,stop(){this.stops++;}},value={track,getAudioTracks:()=>[track],getTracks:()=>[track]};streams.push(value);return value;};
  const input=stream(),resumes=[...(options.resumes||['running'])],modulePending=options.modulePending?deferred():null;
  replace('location',{href:options.location||'https://owned.example/admin'});
  class Context extends EventTarget {
    constructor(){super();this.state='suspended';this.destination={};this.closeCalls=0;this.sources=[];this.audioWorklet={addModule:url=>{this.moduleUrl=String(url);return modulePending?.promise||Promise.resolve();}};contexts.push(this);}
    change(value){this.state=value;this.dispatchEvent(new Event('statechange'));}
    resume(){const action=resumes.shift()||'running';if(action==='pending')return new Promise(()=>{});if(action==='reject')return Promise.reject(Error('Refused'));this.change('running');return Promise.resolve();}
    createMediaStreamSource(value){const node={input:value,connect(){this.connected=true;},disconnect(){this.disconnected=true;}};this.sources.push(node);return node;}
    close(){this.closeCalls++;this.change('closed');return Promise.resolve();}
  }
  class Socket {
    constructor(url){if(options.socketThrow)throw Error('Blocked');this.url=url;this.readyState=0;this.bufferedAmount=0;this.sent=[];this.closeCalls=0;sockets.push(this);}
    open(){this.readyState=1;this.onopen?.();}
    control(data){this.onmessage?.({data:JSON.stringify(data)});}
    receive(data){this.onmessage?.({data});}
    send(value){this.sent.push(value);}
    close(){this.closeCalls++;this.readyState=3;this.onclose?.();}
  }
  class Worklet {
    constructor(){this.port={messages:[],onmessage:null,postMessage(value){this.messages.push(value);},close(){this.closed=true;}};nodes.push(this);}
    connect(){this.connected=true;}disconnect(){this.disconnected=true;}
  }
  replace('AudioContext',Context);replace('WebSocket',Socket);replace('AudioWorkletNode',Worklet);
  return {contexts,sockets,nodes,streams,input,stream,modulePending,restore(){for(const [key,value]of saved)if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}};
}
const relayOptions=f=>({stream:f.input,url:'wss://owned.example/api/admin/calls/test-call/audio',timeoutMs:40});

test('relay uses only the private authenticated socket, peer controls, bounded send backpressure and supplied input',async()=>{
  const f=clientFixture(),states=[],errors=[];let relay;
  try {
    relay=createVoiceRelay({...relayOptions(f),onState:value=>states.push(value),onError:value=>errors.push(value)});f.sockets[0].open();await relay.readyPromise;
    assert.equal(relay.state,'running');assert.equal(f.sockets[0].binaryType,'arraybuffer');assert.equal(f.contexts[0].sources[0].input,f.input);
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
    const f=clientFixture(options),errors=[];let relay;
    try{relay=createVoiceRelay({...relayOptions(f),onError:value=>errors.push(value)});f.sockets[0]?.open();await assert.rejects(relay.readyPromise,/could not start/);await settle();assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.nodes.length,0);assert.equal(f.input.track.stops,0);assert.equal(errors.length,1);}finally{await relay?.close();f.restore();}
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
