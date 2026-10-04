import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

function browserSource(path){return readFileSync(new URL(path,import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');}
const messaging=browserSource('../public/messaging-ui.js');
const {createVoiceRecorder,voiceRecordingFile}=new Function('File',messaging+'\nreturn {createVoiceRecorder,voiceRecordingFile};')(File);
const calls=browserSource('../public/calls.js');
const {playCallMedia}=new Function(calls+'\nreturn {playCallMedia};')();

test('Safari recorder without isTypeSupported records MP4 and creates an M4A audio file',async()=>{
  class Recorder{constructor(stream,options){this.stream=stream;this.mimeType=options?.mimeType||'audio/mp4';}}
  const stream={getAudioTracks:()=>[{kind:'audio'}]},recorder=createVoiceRecorder(stream,Recorder);
  assert.equal(recorder.stream,stream);assert.equal(recorder.mimeType,'audio/mp4');
  const payload=Uint8Array.from([0,0,0,20,102,116,121,112,77,52,65,32]),file=voiceRecordingFile([new Blob([payload],{type:'audio/mp4'})],recorder.mimeType);
  assert.equal(file.type,'audio/mp4');assert.match(file.name,/\.m4a$/);assert.deepEqual(new Uint8Array(await file.arrayBuffer()),payload);
});
test('Safari default recorder fallback uses its actual MP4 chunk MIME rather than pretending WebM',()=>{
  class Recorder{constructor(stream,options){if(options)throw new DOMException('No MIME options','NotSupportedError');this.mimeType='';}}
  const recorder=createVoiceRecorder({},Recorder),file=voiceRecordingFile([new Blob(['voice'],{type:'video/mp4'})],recorder.mimeType);
  assert.equal(recorder.mimeType,'');assert.equal(file.type,'audio/mp4');assert.match(file.name,/\.m4a$/);
});
test('recorder falls back to supported WebM or Ogg when MP4 is unavailable',()=>{
  for(const mime of ['audio/webm;codecs=opus','audio/ogg;codecs=opus']){
    class Recorder{static isTypeSupported(type){return type===mime;}constructor(stream,options){this.mimeType=options?.mimeType||'';}}
    const recorder=createVoiceRecorder({},Recorder),file=voiceRecordingFile([new Blob(['voice'],{type:mime})],recorder.mimeType);
    assert.equal(recorder.mimeType,mime);assert.equal(file.type,mime.split(';')[0]);assert.match(file.name,mime.includes('ogg')?/\.ogg$/:/\.webm$/);
  }
});
test('a failed supported constructor still permits a default recorder instead of losing microphone access',()=>{
  class Recorder{static isTypeSupported(type){return type==='audio/mp4';}constructor(stream,options){if(options)throw Error('Unsupported encoding options');this.mimeType='audio/webm;codecs=opus';}}
  const recorder=createVoiceRecorder({},Recorder);assert.equal(recorder.mimeType,'audio/webm;codecs=opus');
  assert.equal(voiceRecordingFile([new Blob(['voice'])],recorder.mimeType).type,'audio/webm');
});
test('voice files reject empty or unknown container output instead of uploading a false MIME type',()=>{
  assert.throws(()=>voiceRecordingFile([], 'audio/mp4'),/No audio was recorded/);
  assert.throws(()=>voiceRecordingFile([new Blob(['voice'])],''),/recording format/);
  assert.throws(()=>voiceRecordingFile([new Blob(['voice'],{type:'application/octet-stream'})]),/recording format/);
  assert.throws(()=>createVoiceRecorder({},undefined),/unavailable/);
});
test('call playback rejection exposes a tap retry without automatically playing a recorded voice note',async()=>{
  let attempts=0,blocked=0;const media={play(){attempts++;return attempts===1?Promise.reject(new DOMException('Tap required','NotAllowedError')):Promise.resolve();}};
  const first=playCallMedia(media,()=>blocked++);assert.equal(attempts,1,'play() must run synchronously on the gesture');assert.equal(await first,false);assert.equal(blocked,1);
  const retry=playCallMedia(media,()=>blocked++);assert.equal(attempts,2);assert.equal(await retry,true);assert.equal(blocked,1);assert.equal(await playCallMedia(null),false);
});

test('text chat can install and destroy its call controls without WebRTC APIs',async()=>{
  for(const enabled of [false,true]){
    const notices=[],window=new EventTarget(),buttons=[],document={hidden:false,querySelectorAll:()=>[],createElement:()=>({dataset:{},setAttribute(){}})},navigator={onLine:true};
    let pollOptions,starts=0,captureRequests=0;const poll={start(){starts++;},destroy(){},poke(){}};
    navigator.mediaDevices={getUserMedia(){captureRequests++;throw Error('Capture must not begin without WebRTC.');}};
    const install=new Function('window','document','navigator','MediaStream','RTCPeerConnection','createAdaptivePoll','chatIcon',calls+'\nreturn installCalls;')(window,document,navigator,undefined,undefined,options=>{pollOptions=options;return poll;},()=>'<svg></svg>');
    const controls=install({role:'customer',getConversationId:()=> 'private-chat',notify:value=>notices.push(value),getAppSettings:()=>({chat:{voiceCallsEnabled:enabled,videoCallsEnabled:enabled}})});
    assert.equal(starts,1);assert.equal(pollOptions.canRun(),false);await pollOptions.task();
    controls.mount({querySelector:()=>null,append:button=>buttons.push(button)});assert.equal(buttons.length,2);assert.ok(buttons.every(button=>button.hidden===!enabled));
    await buttons[0].onclick();assert.match(notices[0],enabled?/Calls are unavailable.*Text chat/:/currently paused/);assert.equal(captureRequests,0);
    await controls.destroy();assert.equal(pollOptions.canRun(),false);
  }
});

const effectsSource=browserSource('../public/voice-effects.js').replaceAll('import.meta.url',JSON.stringify('https://example.test/voice-effects.js'));
function effectsFixture({cannotResume=false}={}){
  const contexts=[],nodes=[],processedTrack={kind:'audio',enabled:true,stopped:false,stop(){this.stopped=true;}};
  class Stream{constructor(tracks=[]){this.tracks=tracks;}getTracks(){return this.tracks;}getAudioTracks(){return this.tracks.filter(track=>track.kind==='audio');}getVideoTracks(){return this.tracks.filter(track=>track.kind==='video');}}
  const parameter=()=>({value:0,setTargetAtTime(){}});
  class Node{constructor(){this.connections=[];this.frequency=parameter();this.Q=parameter();this.gain=parameter();nodes.push(this);}connect(node){this.connections.push(node);}disconnect(){this.disconnected=true;}}
  class Context{constructor(){this.state='suspended';this.sampleRate=48000;this.currentTime=0;this.resumes=0;this.audioWorklet={addModule:async()=>{}};contexts.push(this);}async resume(){this.resumes++;if(!cannotResume)this.state='running';}async close(){this.state='closed';}createMediaStreamSource(){return new Node();}createBiquadFilter(){return new Node();}createMediaStreamDestination(){const node=new Node();node.stream=new Stream([processedTrack]);return node;}}
  class Worklet extends Node{constructor(){super();this.parameters=new Map([['pitch',parameter()],['robot',parameter()]]);this.port={close(){}};}}
  const window={webkitAudioContext:Context},create=new Function('window','MediaStream','AudioWorkletNode',effectsSource+'\nreturn createVoiceEffectsSession;')(window,Stream,Worklet);
  return {create,contexts,nodes,processedTrack,Stream};
}
test('voice effects re-resume a WebKit audio context interrupted by microphone capture and preserve video',async()=>{
  const f=effectsFixture(),session=f.create(),context=f.contexts[0],audio={kind:'audio',enabled:true},video={kind:'video'};
  assert.equal(context.resumes,1,'initial resume happens on the call tap');context.state='interrupted';
  const stream=await session.attach(new f.Stream([audio,video]));assert.equal(context.resumes,2);assert.equal(context.state,'running');assert.deepEqual(stream.getVideoTracks(),[video]);
  session.setMuted(true);assert.equal(f.processedTrack.enabled,false);session.destroy();assert.equal(f.processedTrack.stopped,true);assert.equal(context.state,'closed');assert.ok(f.nodes.every(node=>node.disconnected||node.stream));
});
test('voice effects that cannot resume reject instead of sending a silent processed stream',async()=>{
  const f=effectsFixture({cannotResume:true}),session=f.create();await assert.rejects(session.attach(new f.Stream([{kind:'audio'}])),/could not resume/);assert.equal(f.nodes.length,0);session.destroy();
});
test('ending a call while its worklet loads prevents a late processed stream',async()=>{
  const f=effectsFixture(),session=f.create();session.destroy();await assert.rejects(session.attach(new f.Stream([{kind:'audio'}])),/call has ended/);assert.equal(f.nodes.length,0);
});
