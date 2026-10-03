import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatSounds} from '../public/chat-sounds.js';

class DocumentFixture{
  hidden=false;visibilityState='visible';media=[];listeners=new Map();
  addEventListener(type,listener){const listeners=this.listeners.get(type)||new Set();listeners.add(listener);this.listeners.set(type,listeners);}
  removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
  querySelectorAll(){return this.media;}
  emit(type,isTrusted=true){for(const listener of this.listeners.get(type)||[])listener({type,isTrusted});}
  listenerCount(){return [...this.listeners.values()].reduce((count,listeners)=>count+listeners.size,0);}
}
function fixture({scope='customer',incomingRole='assistant',storage=new Map(),initialState='suspended',resumeError=false,contextError=false}={}){
  const document=new DocumentFixture(),contexts=[],starts=[],gains=[],frequencies=[];let clock=1000,allowed=true;
  const audioParam=records=>({setValueAtTime(value,time){records.push({kind:'set',value,time});},linearRampToValueAtTime(value,time){records.push({kind:'linear',value,time});},exponentialRampToValueAtTime(value,time){records.push({kind:'exponential',value,time});}});
  const createAudioContext=()=>{
    if(contextError)throw new Error('Audio unavailable');
    const context={state:initialState,currentTime:clock/1000,destination:{},closed:false,resumes:0,oscillators:[],resume(){this.resumes++;if(resumeError)return Promise.reject(new Error('Autoplay denied'));this.state='running';return Promise.resolve();},close(){this.closed=true;this.state='closed';return Promise.resolve();},
      createOscillator(){const parameter=[];frequencies.push(parameter);const oscillator={frequency:audioParam(parameter),disconnected:false,connect(){},disconnect(){this.disconnected=true;},start(at){starts.push({oscillator,at});},stop(at){this.stopAt=at;}};this.oscillators.push(oscillator);return oscillator;},
      createGain(){const parameter=[];gains.push(parameter);return{gain:audioParam(parameter),connect(){},disconnect(){}};},
    };contexts.push(context);return context;
  };
  const store=storage instanceof Map?{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}:storage;
  const sounds=createChatSounds({scope,incomingRole,documentTarget:document,storage:store,createAudioContext,now:()=>clock,canPlay:()=>allowed});
  return{sounds,document,contexts,starts,gains,frequencies,storage,prime:(event='pointerdown',trusted=true)=>document.emit(event,trusted),allow:value=>allowed=value,
    advance(ms=250){clock+=ms;for(const context of contexts){context.currentTime=clock/1000;for(const oscillator of context.oscillators)if(oscillator.stopAt<=context.currentTime&&!oscillator.disconnected)oscillator.onended?.();}},
  };
}
const incoming=(id,extra={})=>({id,role:'assistant',status:'sent',...extra});
const user=(id,extra={})=>({id,role:'user',status:'sent',...extra});
const thread=(messages,id=1)=>({id,messages});

test('autoplay stays silent until a trusted pointer or keyboard gesture and never queues old cues',()=>{
  const f=fixture();assert.equal(f.sounds.play('sent'),false);assert.equal(f.contexts.length,0);
  f.prime('pointerdown',false);assert.equal(f.sounds.play('received'),false);assert.equal(f.contexts.length,0);
  f.sounds.observe(thread([incoming(1)]),{kind:'initial'});f.sounds.observe(thread([incoming(1),incoming(2)]));
  f.prime('keydown');assert.equal(f.contexts.length,1);assert.equal(f.starts.length,0);assert.equal(f.sounds.observe(thread([incoming(1),incoming(2)])),false);
  assert.equal(f.sounds.play('sent'),true);assert.equal(f.starts.length,1);f.sounds.destroy();
});
test('original sent and received contours are distinct, quiet and shorter than 220 ms',()=>{
  const f=fixture();f.prime();assert.equal(f.sounds.play('sent'),true);assert.equal(f.sounds.play('received'),true);assert.equal(f.starts.length,3);
  assert.equal(f.starts[0].oscillator.type,'triangle');assert.deepEqual(f.starts.slice(1).map(note=>note.oscillator.type),['sine','sine']);
  assert.notDeepEqual(f.frequencies[0],f.frequencies[1]);assert.ok(f.gains.flat().every(point=>point.value<=.045));assert.ok(f.starts.every(note=>note.oscillator.stopAt-note.at<.22));
  assert.ok(f.starts[2].oscillator.stopAt-f.starts[1].at<.22);f.sounds.destroy();
});
test('each cue has its own overlap guard while a simultaneous send and new reply remain audible',()=>{
  const f=fixture();f.prime();assert.equal(f.sounds.play('received'),true);assert.equal(f.sounds.play('received'),false);assert.equal(f.sounds.play('sent'),true);assert.equal(f.sounds.play('sent'),false);
  f.advance(150);assert.equal(f.sounds.play('received'),false);assert.equal(f.sounds.play('sent'),true);f.advance();assert.equal(f.sounds.play('received'),true);f.sounds.destroy();
});
test('thread snapshots seed silently and one new incoming batch plays once despite edits, deletes and repeat polls',()=>{
  const f=fixture();f.prime();assert.equal(f.sounds.observe(thread([incoming(1)])),false);
  assert.equal(f.sounds.observe(thread([incoming(1),incoming(2),incoming(3)])),true);assert.equal(f.starts.length,2);f.advance();
  assert.equal(f.sounds.observe(thread([incoming(1),incoming(2,{edited:true,body:'updated'}),incoming(3,{deleted:true})])),false);
  assert.equal(f.sounds.observe(thread([incoming(1),incoming(2),incoming(3)])),false);assert.equal(f.starts.length,2);f.sounds.destroy();
});
test('initial and older history advance the baseline without sounding or replaying',()=>{
  const f=fixture();f.prime();f.sounds.observe(thread([incoming(10)]),{kind:'initial'});
  assert.equal(f.sounds.observe(thread([incoming(1),incoming(11)]),{kind:'older'}),false);assert.equal(f.sounds.observe(thread([incoming(11)])),false);
  assert.equal(f.sounds.observe(thread([incoming(12)]),{kind:'initial'}),false);assert.equal(f.sounds.observe(thread([incoming(12)])),false);
  assert.equal(f.sounds.observe(thread([incoming(13)])),true);f.sounds.destroy();
});
test('system, outgoing, pending, failed, deleted and nonpersisted messages never chirp',()=>{
  const f=fixture();f.prime();f.sounds.observe(thread([]),{kind:'initial'});
  const messages=[user(1),{id:2,role:'system'},incoming(3,{status:'pending'}),incoming(4,{status:'failed'}),incoming(5,{deleted:true}),incoming(6,{sendState:'queued'}),incoming(7,{sendState:'failed'}),incoming('local-abc'),incoming(-1),incoming(0),incoming(1.5)];
  assert.equal(f.sounds.observe(thread(messages)),false);assert.equal(f.starts.length,0);
  assert.equal(f.sounds.observe(thread([incoming(3),incoming(4),incoming(5),incoming(6),incoming(7)])),false);
  assert.equal(f.sounds.observe(thread([incoming(8,{kind:'media'})])),true);f.sounds.destroy();
});
test('customer and admin observers only sound their configured incoming role',()=>{
  const f=fixture({scope:'admin',incomingRole:'user'});f.prime();f.sounds.observe(thread([]),{kind:'initial'});
  assert.equal(f.sounds.observe(thread([incoming(1)])),false);assert.equal(f.sounds.observe(thread([incoming(1),user(2,{status:'pending'})])),true);f.advance();
  assert.equal(f.sounds.observe(thread([user(2,{status:'failed'})])),false);assert.equal(f.sounds.observe(thread([user(2),user(3,{status:'failed'})])),true);f.advance();
  assert.equal(f.sounds.observe(thread([user(4,{sendState:'failed'})])),false);assert.equal(f.sounds.observe(thread([user(4)])),false);f.sounds.destroy();
});
test('hidden, media, call and mute suppression consume new IDs without replay when re-enabled',()=>{
  const f=fixture();f.prime();f.sounds.observe(thread([]),{kind:'initial'});
  const cases=[()=>{f.document.hidden=true;},()=>{f.document.visibilityState='hidden';},()=>{f.document.media=[{paused:false,ended:false}];},()=>f.allow(false),()=>f.sounds.setEnabled(false)];
  for(let index=0;index<cases.length;index++){
    cases[index]();assert.equal(f.sounds.play('sent'),false);assert.equal(f.sounds.observe(thread([incoming(index+1)])),false);
    f.document.hidden=false;f.document.visibilityState='visible';f.document.media=[];f.allow(true);f.sounds.setEnabled(true);f.advance();assert.equal(f.sounds.observe(thread([incoming(index+1)])),false);
  }
  f.document.media=[{paused:true,ended:false},{paused:false,ended:true}];assert.equal(f.sounds.observe(thread([incoming(6)])),true);f.sounds.destroy();
});
test('mute persists separately for customer and admin, while storage denial cannot break playback',()=>{
  const storage=new Map(),customer=fixture({storage}),admin=fixture({scope:'admin',storage});customer.sounds.setEnabled(false);assert.equal(customer.sounds.enabled(),false);assert.equal(admin.sounds.enabled(),true);
  const reopened=fixture({storage});assert.equal(reopened.sounds.enabled(),false);assert.equal(storage.get('rekha:customer:chat-sounds'),'0');
  const denied=fixture({storage:{getItem(){throw new Error('Denied');},setItem(){throw new Error('Quota');}}});denied.prime();assert.equal(denied.sounds.play('sent'),true);assert.doesNotThrow(()=>denied.sounds.setEnabled(false));assert.equal(denied.sounds.enabled(),false);
  for(const f of[customer,admin,reopened,denied])f.sounds.destroy();
});
test('turning a saved mute off primes audio on that same trusted tap without playing a queued cue',()=>{
  const f=fixture({storage:new Map([['rekha:customer:chat-sounds','0']])});f.sounds.observe(thread([]),{kind:'initial'});
  f.sounds.observe(thread([incoming(1)]));f.prime();assert.equal(f.contexts.length,0);
  f.sounds.setEnabled(true);assert.equal(f.contexts.length,1);assert.equal(f.contexts[0].state,'running');assert.equal(f.starts.length,0);
  assert.equal(f.sounds.observe(thread([incoming(1)])),false);assert.equal(f.sounds.observe(thread([incoming(2)])),true);f.sounds.destroy();
  const untouched=fixture({storage:new Map([['rekha:customer:chat-sounds','0']])});untouched.sounds.setEnabled(true);assert.equal(untouched.contexts.length,0);assert.equal(untouched.sounds.play('sent'),false);untouched.sounds.destroy();
});
test('unsupported audio and rejected resume remain silent, with no delayed playback',async()=>{
  const unavailable=fixture({contextError:true});assert.doesNotThrow(()=>unavailable.prime());assert.equal(unavailable.sounds.play('sent'),false);unavailable.sounds.destroy();
  const denied=fixture({resumeError:true});denied.prime();assert.equal(denied.sounds.play('received'),false);await Promise.resolve();assert.equal(denied.starts.length,0);assert.equal(denied.sounds.play('bad-kind'),false);denied.sounds.destroy();
});
test('inbox initial/filter/history/read updates are silent and a new unread customer batch pings once',()=>{
  const f=fixture({scope:'admin',incomingRole:'user'});f.prime();assert.equal(f.sounds.observeInbox([{id:1,latestUserId:5,unread:1}]),false);
  assert.equal(f.sounds.observeInbox([{id:1,latestUserId:5,unread:3}]),false);assert.equal(f.sounds.observeInbox([{id:1,latestUserId:6,unread:0}]),false);
  assert.equal(f.sounds.observeInbox([{id:1,latestUserId:7,unread:2},{id:2,latestUserId:8,unread:1}]),true);assert.equal(f.starts.length,2);f.advance();
  assert.equal(f.sounds.observeInbox([{id:3,latestUserId:9,unread:1}],{kind:'older'}),false);assert.equal(f.sounds.observeInbox([{id:3,latestUserId:9,unread:1}]),false);
  assert.equal(f.sounds.observeInbox([{id:1,latestUserId:10,unread:1}],{kind:'initial'}),false);assert.equal(f.sounds.observeInbox([{id:1,latestUserId:10,unread:1}]),false);f.sounds.destroy();
});
test('inbox and open thread share a highwater so the same customer message cannot sound twice',()=>{
  const f=fixture({scope:'admin',incomingRole:'user'});f.prime();f.sounds.observeInbox([{id:1,latestUserId:1,unread:0}],{kind:'initial'});f.sounds.observe(thread([user(1)]),{kind:'initial'});
  assert.equal(f.sounds.observeInbox([{id:1,latestUserId:2,unread:1}]),true);f.advance();assert.equal(f.sounds.observe(thread([user(1),user(2)])),false);
  assert.equal(f.sounds.observe(thread([user(1),user(2),user(3)])),true);f.advance();assert.equal(f.sounds.observeInbox([{id:1,latestUserId:3,unread:1}]),false);f.sounds.destroy();
});
test('bounded inbox eviction does not replay historical unread rows; a new unread row still chirps',()=>{
  const f=fixture({scope:'admin',incomingRole:'user'});f.prime();f.sounds.observeInbox(Array.from({length:600},(_,index)=>({id:index+1,latestUserId:index+1,unread:1})),{kind:'initial'});
  assert.equal(f.sounds.observeInbox([{id:1,latestUserId:1,unread:1}]),false);assert.equal(f.sounds.observeInbox([{id:601,latestUserId:601,unread:1}]),true);f.sounds.destroy();
});
test('hide and mute stop active voices; reset clears thread seeds; destroy removes listeners and closes audio',()=>{
  const f=fixture();f.prime();f.sounds.play('sent');f.document.hidden=true;f.document.emit('visibilitychange');assert.ok(f.contexts[0].oscillators.every(oscillator=>oscillator.disconnected));
  f.document.hidden=false;f.advance();f.sounds.play('received');f.sounds.setEnabled(false);assert.ok(f.contexts[0].oscillators.every(oscillator=>oscillator.disconnected));f.sounds.setEnabled(true);f.advance();
  f.sounds.observe(thread([incoming(1)]),{kind:'initial'});f.sounds.reset();assert.equal(f.sounds.observe(thread([incoming(2)])),false);
  assert.equal(f.document.listenerCount(),3);f.sounds.destroy();assert.equal(f.document.listenerCount(),0);assert.equal(f.contexts[0].closed,true);assert.equal(f.sounds.play('sent'),false);assert.equal(f.sounds.observe(thread([incoming(3)])),false);assert.doesNotThrow(()=>f.sounds.destroy());
});
