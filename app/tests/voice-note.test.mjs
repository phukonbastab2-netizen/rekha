import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceTime,voiceProgress,voiceWaveformPeaks,voiceNoteBody,createVoiceNotePlayer} from '../public/voice-note.js';
import {messageBody} from '../public/media.js';
import {DONATION_INTEREST_TEXT,donationInterestState} from '../public/customer-followup.js';

const url='/api/media/12345678-1234-4234-8234-123456789abc',tick=()=>new Promise(resolve=>setImmediate(resolve));
class Node extends EventTarget {constructor(){super();this.attributes={};this.textContent='';this.innerHTML='';this.value='0';this.disabled=false;this.classList={toggle:()=>{}};}setAttribute(key,value){this.attributes[key]=String(value);}getAttribute(key){return this.attributes[key]??null;}}
function fixture(options={}){
  const audio=new Node();Object.assign(audio,{paused:true,ended:false,duration:60,currentTime:0,plays:0,pauses:0});audio.setAttribute('src',url);
  audio.play=async()=>{audio.plays++;if(options.reject)throw Object.assign(new Error('permission'),{name:'NotAllowedError'});audio.paused=false;audio.dispatchEvent(new Event('play'));};audio.pause=()=>{audio.pauses++;audio.paused=true;audio.dispatchEvent(new Event('pause'));};
  const nodes=Object.fromEntries(['[data-voice-toggle]','[data-voice-seek]','[data-voice-time]','[data-voice-duration]','[data-voice-status]'].map(selector=>[selector,new Node()]));nodes.audio=audio;
  const calls=[],canvas={width:216,height:34,getContext:()=>({clearRect:()=>{},fillRect:(...values)=>calls.push(values)})};nodes['[data-voice-waveform]']=canvas;
  const root={isConnected:true,querySelector:selector=>nodes[selector],classList:{toggle:()=>{}}},frames=new Map();let serial=0,fetches=0,closes=0;
  const player=createVoiceNotePlayer(root,{fetcher:async()=>{fetches++;return{ok:true,headers:{get:()=>null},arrayBuffer:async()=>new ArrayBuffer(4)};},createDecoder:()=>({decodeAudioData:async()=>({numberOfChannels:1,getChannelData:()=>new Float32Array([.1,.8,.2,.6])}),close:async()=>closes++}),setFrame:callback=>{const id=++serial;frames.set(id,callback);return id;},clearFrame:id=>frames.delete(id)});
  return {player,root,audio,nodes,frames,calls,fetches:()=>fetches,closes:()=>closes};
}

test('voice player markup is scoped to explicit private audio and never autoplays or claims live recording',()=>{
  const markup=voiceNoteBody({url,title:'Owned voice " & <script>'});assert.match(markup,/data-recorded-voice/);assert.match(markup,/type="range".*aria-label="Seek voice message"/);assert.match(markup,/Owned voice &quot; &amp; &lt;script&gt;/);assert.doesNotMatch(markup,/<script|autoplay|getUserMedia|Recording/);
  assert.match(voiceNoteBody({url:'https://example.com/audio.mp3'}),/unavailable/);
  const normal=messageBody({kind:'media',body:JSON.stringify({items:[{type:'audio',url,title:'Normal'}]})});assert.match(normal,/<audio controls preload="none"/);assert.doesNotMatch(normal,/data-recorded-voice/);
  const recorded=messageBody({kind:'media',body:JSON.stringify({items:[{type:'audio',url,presentation:'voice-note'}]})});assert.match(recorded,/data-recorded-voice/);assert.doesNotMatch(recorded,/autoplay/);
});

test('duration/progress and waveform bars use actual finite samples without fictional amplitude',()=>{
  assert.equal(voiceTime(69.8),'1:09');assert.equal(voiceTime(Infinity),'0:00');assert.equal(voiceProgress(30,60),.5);assert.equal(voiceProgress(90,60),1);assert.equal(voiceProgress(-2,60),0);assert.equal(voiceProgress(5,Infinity),0);
  assert.deepEqual(voiceWaveformPeaks([new Float32Array([0,.25,-.5,1])],2),[.25,1]);assert.deepEqual(voiceWaveformPeaks([]),[]);assert.deepEqual(voiceWaveformPeaks([new Float32Array([NaN,Infinity,0,0])],2),[0,0]);
});

test('play/pause, seek and waveform decode require interaction, then stop cleanly on removal',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());assert.equal(f.audio.plays,0);assert.equal(f.fetches(),0);assert.equal(f.nodes['[data-voice-duration]'].textContent,'1:00');
  f.nodes['[data-voice-toggle]'].dispatchEvent(new Event('click'));await tick();assert.equal(f.audio.plays,1);assert.equal(f.audio.paused,false);assert.equal(f.fetches(),1);assert.equal(f.closes(),1);assert.equal(f.frames.size,1);assert.equal(f.nodes['[data-voice-toggle]'].getAttribute('aria-label'),'Pause voice message');
  f.nodes['[data-voice-seek]'].value='500';f.nodes['[data-voice-seek]'].dispatchEvent(new Event('input'));assert.equal(f.audio.currentTime,30);assert.equal(f.nodes['[data-voice-time]'].textContent,'0:30');
  f.player.refresh();assert.equal(f.audio.plays,1);assert.equal(f.audio.pauses,0);assert.equal(f.fetches(),1);
  f.nodes['[data-voice-toggle]'].dispatchEvent(new Event('click'));assert.equal(f.audio.paused,true);assert.equal(f.frames.size,0);
  f.nodes['[data-voice-toggle]'].dispatchEvent(new Event('click'));await tick();assert.equal(f.fetches(),1);f.root.isConnected=false;const callback=[...f.frames.values()][0];f.frames.clear();callback();assert.equal(f.audio.paused,true);assert.equal(f.frames.size,0);
});

test('declined playback or media errors leave accessible retry feedback without automatic replays',async t=>{
  const denied=fixture({reject:true});t.after(()=>denied.player.destroy());denied.nodes['[data-voice-toggle]'].dispatchEvent(new Event('click'));await tick();assert.match(denied.nodes['[data-voice-status]'].textContent,/Tap play again/);assert.equal(denied.audio.plays,1);assert.equal(denied.fetches(),0);assert.equal(denied.frames.size,0);
  const failed=fixture();t.after(()=>failed.player.destroy());failed.audio.dispatchEvent(new Event('error'));assert.match(failed.nodes['[data-voice-status]'].textContent,/Retry below/);assert.equal(failed.audio.plays,0);failed.audio.dispatchEvent(new Event('loadedmetadata'));assert.equal(failed.nodes['[data-voice-status]'].textContent,'');
});

test('donation interest CTA is one exact bilingual button with no URL or payment action',()=>{
  const body={items:[{type:'audio',url,presentation:'voice-note'}],donation:{label:'untrusted replacement',action:'interest-v1',url:'https://example.com/ignored'}},message={id:38,role:'assistant',kind:'media',body:JSON.stringify(body)},chat={id:'fixture',messages:[message]},interest=donationInterestState(chat,message);
  const markup=messageBody(message,{donationInterest:interest});assert.equal(markup.match(/data-donation-interest/g)?.length,1);assert.match(markup,/data-donation-interest="38" data-interest-state="available"/);assert(markup.includes(`>${DONATION_INTEREST_TEXT}</button>`));assert.doesNotMatch(markup,/data-donation-link|href=|example\.com|payment success|untrusted replacement|onclick=/i);
  assert.doesNotMatch(messageBody(message),/data-donation-interest/);
  assert.match(messageBody(message,{donationInterest:{...interest,state:'pending',disabled:true}}),/data-interest-state="pending" disabled/);
  for(const old of [{url:'https://rekhaastrology.in/donate/'},{action:'javascript:alert(1)'}])assert.doesNotMatch(messageBody({...message,body:JSON.stringify({...body,donation:old})},{donationInterest:interest}),/data-donation-interest|data-donation-link|href=/);
});
