import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceEffect,voiceChoices} from '../shared/voice-effects.js';

function fixture(options={}) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'AudioContext');
  const contexts=[],nodes=[];
  const inputTrack={stops:0,stop(){this.stops++;}};
  const outputTrack={stops:0,stop(){this.stops++;}};
  const microphone={getTracks:()=>[inputTrack],getAudioTracks:()=>[inputTrack]};
  const resumes=[...(options.resumes||['running'])];
  function node(kind) {
    const current={kind,gain:{value:0},frequency:{value:0},Q:{value:0},connections:[],disconnects:0,starts:0,stops:0,
      connect(to){if(options.graphFailure==='connect'&&kind==='source')throw Error('Graph connection failed');this.connections.push(to);},
      disconnect(){this.disconnects++;if(options.disconnectFailure&&kind==='source')throw Error('Disconnect failed');},
      start(){this.starts++;},
      stop(){this.stops++;}};
    nodes.push(current);return current;
  }
  class Context extends EventTarget {
    constructor(){super();this.state='suspended';this.resumeCalls=0;this.closeCalls=0;this.added=0;this.removed=0;this.gains=0;contexts.push(this);}
    addEventListener(type,listener){this.added++;super.addEventListener(type,listener);}
    removeEventListener(type,listener){this.removed++;super.removeEventListener(type,listener);}
    change(value){this.state=value;this.dispatchEvent(new Event('statechange'));}
    resume(){
      this.resumeCalls++;const action=resumes.shift()||'running';
      if(action==='pending')return new Promise(resolve=>{this.resolvePendingResume=resolve;});
      if(action==='reject')return Promise.reject(Error('Browser refused resume'));
      if(action==='suspended')return Promise.resolve();
      this.change('running');return Promise.resolve();
    }
    createMediaStreamSource(stream){assert.equal(stream,microphone);return node('source');}
    createBiquadFilter(){return node('filter');}
    createGain(){this.gains++;if(options.graphFailure==='create'&&this.gains===2)throw Error('Graph creation failed');return node('gain');}
    createMediaStreamDestination(){const output=node('destination');output.stream={getAudioTracks:()=>[outputTrack],getTracks:()=>[outputTrack]};return output;}
    createOscillator(){return node('oscillator');}
    close(){this.closeCalls++;if(options.closePending)return new Promise(()=>{});this.change('closed');if(options.closeReject)return Promise.reject(Error('Browser refused close'));return Promise.resolve();}
  }
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,writable:true,value:Context});
  return {contexts,nodes,microphone,inputTrack,outputTrack,restore(){if(previous)Object.defineProperty(globalThis,'AudioContext',previous);else delete globalThis.AudioContext;}};
}

test('effects route the microphone through presets and idempotently release only owned output resources',async()=>{
  const f=fixture();
  try {
    const effect=await createVoiceEffect(f.microphone,'warm',{timeoutMs:40});
    assert.equal(effect.track,f.outputTrack);assert.equal(effect.state,'running');
    assert.equal(f.contexts[0].resumeCalls,1);
    assert.equal(f.nodes[1].type,'lowpass');
    assert.equal(f.nodes[0].connections[0],f.nodes[1]);
    assert.equal(f.nodes[2].connections[0],f.nodes[3]);
    for(const [value]of voiceChoices)effect.set(value);
    assert.equal(f.nodes[5].gain.value,0.4);
    const firstClose=effect.close();assert.equal(firstClose,effect.close());await firstClose;
    assert.equal(effect.state,'closed');assert.equal(f.contexts[0].closeCalls,1);
    assert.equal(f.contexts[0].added,1);assert.equal(f.contexts[0].removed,1);
    assert.equal(f.outputTrack.stops,1);assert.equal(f.inputTrack.stops,0);
    assert.equal(f.nodes[4].stops,1);assert.ok(f.nodes.every(n=>n.disconnects===1));
  } finally {f.restore();}
});

test('a never-resolving startup resume rejects within its deadline and closes the context', {timeout:1000},async()=>{
  const f=fixture({resumes:['pending']});const started=performance.now();
  try {
    await assert.rejects(createVoiceEffect(f.microphone,'warm',{timeoutMs:40}),error=>error.code==='VOICE_AUDIO_TIMEOUT');
    assert.ok(performance.now()-started<500,'startup must not remain pending');
    assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.contexts[0].removed,1);
    assert.equal(f.nodes.length,0);assert.equal(f.inputTrack.stops,0);
    f.contexts[0].resolvePendingResume();await Promise.resolve();
    assert.equal(f.contexts[0].closeCalls,1,'late resolution must not reopen resources');
  } finally {f.restore();}
});

test('a rejected startup resume releases the context without stopping the microphone',async()=>{
  const f=fixture({resumes:['reject']});
  try {
    await assert.rejects(createVoiceEffect(f.microphone,'radio',{timeoutMs:40}),error=>error.code==='VOICE_AUDIO_RESUME_FAILED'&&error.cause.message==='Browser refused resume');
    assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.contexts[0].removed,1);assert.equal(f.inputTrack.stops,0);
  } finally {f.restore();}
});

test('a resolved resume must actually reach the running state before creating a graph',async()=>{
  const f=fixture({resumes:['suspended']});
  try {
    await assert.rejects(createVoiceEffect(f.microphone,'bright',{timeoutMs:40}),error=>error.code==='VOICE_AUDIO_NOT_RUNNING');
    assert.equal(f.nodes.length,0);assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.inputTrack.stops,0);
  } finally {f.restore();}
});

for(const failure of ['create','connect'])test('graph '+failure+' failure cleans every created node, output and oscillator',async()=>{
  const f=fixture({graphFailure:failure,disconnectFailure:true});
  try {
    await assert.rejects(createVoiceEffect(f.microphone,'robot',{timeoutMs:40}),/Graph/);
    assert.ok(f.nodes.length>=5);assert.ok(f.nodes.every(n=>n.disconnects===1));
    assert.equal(f.nodes.find(n=>n.kind==='oscillator').stops,1);
    assert.equal(f.outputTrack.stops,1);assert.equal(f.inputTrack.stops,0);
    assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.contexts[0].removed,1);
  } finally {f.restore();}
});

test('runtime interruption notifies subscribers and bounded resume restores running audio',async()=>{
  const f=fixture({resumes:['running','running']});
  try {
    const effect=await createVoiceEffect(f.microphone,'radio',{timeoutMs:40}),states=[];
    const unsubscribe=effect.subscribeState(value=>states.push(value));
    f.contexts[0].change('interrupted');assert.equal(effect.state,'interrupted');assert.deepEqual(states,['interrupted']);
    await effect.resume();assert.equal(effect.state,'running');assert.deepEqual(states,['interrupted','running']);
    unsubscribe();unsubscribe();f.contexts[0].change('suspended');assert.deepEqual(states,['interrupted','running']);
    let afterClose=0;effect.subscribeState(()=>afterClose++);await effect.close();f.contexts[0].change('running');
    assert.equal(afterClose,0);assert.equal(effect.state,'closed');assert.equal(f.inputTrack.stops,0);
    await assert.rejects(effect.resume(),error=>error.code==='VOICE_AUDIO_CLOSED');
  } finally {f.restore();}
});

test('a never-resolving runtime resume is bounded and leaves explicit recovery or close available', {timeout:1000},async()=>{
  const f=fixture({resumes:['running','pending','running']});
  try {
    const effect=await createVoiceEffect(f.microphone,'warm',{timeoutMs:40});
    f.contexts[0].change('suspended');
    await assert.rejects(effect.resume(),error=>error.code==='VOICE_AUDIO_TIMEOUT');
    assert.equal(effect.state,'suspended');assert.equal(f.contexts[0].closeCalls,0);
    await effect.resume();assert.equal(effect.state,'running');
    await effect.close();assert.equal(f.inputTrack.stops,0);assert.equal(f.outputTrack.stops,1);
  } finally {f.restore();}
});

test('closing during a pending runtime resume cancels it and invalidates subscriptions',async()=>{
  const f=fixture({resumes:['running','pending']});
  try {
    const effect=await createVoiceEffect(f.microphone,'bright',{timeoutMs:40});let notified=0;
    effect.subscribeState(()=>notified++);f.contexts[0].change('suspended');assert.equal(notified,1);
    const rejected=assert.rejects(effect.resume(),error=>error.code==='VOICE_AUDIO_CLOSED');
    await effect.close();await rejected;
    f.contexts[0].resolvePendingResume();f.contexts[0].change('running');await Promise.resolve();
    assert.equal(notified,1);assert.equal(effect.state,'closed');
    assert.equal(f.outputTrack.stops,1);assert.equal(f.inputTrack.stops,0);assert.equal(f.contexts[0].closeCalls,1);
  } finally {f.restore();}
});

test('an unresponsive browser close still releases owned nodes immediately and resolves within a deadline', {timeout:1000},async()=>{
  const f=fixture({closePending:true});
  try {
    const effect=await createVoiceEffect(f.microphone,'robot',{timeoutMs:40});
    const closing=effect.close();
    assert.equal(effect.state,'closed');assert.equal(f.outputTrack.stops,1);assert.ok(f.nodes.every(n=>n.disconnects===1));
    const started=performance.now();await closing;assert.ok(performance.now()-started<500);
    assert.equal(effect.close(),closing);assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.inputTrack.stops,0);
  } finally {f.restore();}
});

