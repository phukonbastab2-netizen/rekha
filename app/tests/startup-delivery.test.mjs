import test from 'node:test';
import assert from 'node:assert/strict';
import {createStartupDelivery,startupDeliveryState,validClockOffset,orderDeliveredMessages} from '../public/startup-delivery.js';
import {kundliWaitDeadline,kundliWaitState} from '../public/countdown.js';

const start=Date.parse('2026-10-04T01:00:00Z');
const rows=()=>[1,2,3,4].map(id=>({id,role:'assistant',kind:id===4?'kundli-wait':'owner-message',created:start+id*5000,deliveryAt:start+id*5000,body:'Startup '+id}));
const followups=()=>Array.from({length:30},(_,index)=>({id:index+5,role:'assistant',kind:'kundli-review-line',created:start+320000+index*5000,deliveryAt:start+320000+index*5000,body:'Local follow-up '+index}));
function fixture({skew=120000,elapsed=0,cached=null}={}){
  let wall=start+skew+elapsed,tick=elapsed,chat=cached||{id:'local-startup-chat',serverTime:start,messages:rows()},nextId=0;
  const timers=new Map(),reveals=[],doc=new EventTarget(),win=new EventTarget();doc.hidden=false;doc.visibilityState='visible';
  const delivery=createStartupDelivery({getChat:()=>chat,now:()=>wall,monotonic:()=>tick,setTimer:(callback,delay)=>{const id=++nextId;timers.set(id,{callback,due:tick+delay});return id;},clearTimer:id=>timers.delete(id),documentTarget:doc,windowTarget:win,onReveal:()=>reveals.push(delivery.view().messages.map(row=>row.id))});
  const advance=ms=>{wall+=ms;tick+=ms;for(const [id,timer] of [...timers])if(timer.due<=tick){timers.delete(id);timer.callback();}};
  return {delivery,doc,win,timers,reveals,advance,setChat:value=>chat=value,jumpWall:ms=>wall+=ms};
}

test('only explicit assistant delivery deadlines hide rows and cap reads before future IDs',()=>{
  const ordinary={id:10,role:'assistant',created:start+3600000,body:'Manual'},customer={id:11,role:'user',deliveryAt:start+3600000,body:'Customer'};
  const state=startupDeliveryState([...rows(),ordinary,customer],start);
  assert.deepEqual(state.messages,[ordinary,customer]);assert.equal(state.nextDueAt,start+5000);assert.equal(state.readLimit,0);assert.equal(state.pending,true);
  const second=startupDeliveryState([...rows(),ordinary],start+10000);assert.deepEqual(second.messages.map(row=>row.id),[1,2,10]);assert.equal(second.readLimit,2);
  assert.equal(startupDeliveryState(rows(),start+20000).readLimit,null);
  assert.equal(startupDeliveryState([{id:1,role:'assistant',deliveryAt:Infinity}],start).messages.length,1);
});

test('rendering follows due arrival time while preserving the ID-ordered source and pending timestamps',()=>{
  const source=[rows()[0],rows()[1],{id:5,role:'user',created:start+6000},rows()[2],rows()[3],{id:'local-send',created:start+11000}];
  const original=JSON.stringify(source);assert.deepEqual(orderDeliveredMessages(source).map(row=>row.id),[1,5,2,'local-send',3,4]);assert.equal(JSON.stringify(source),original);
});

test('server clock skew alignment reveals four immutable rows once at five-second boundaries',t=>{
  const f=fixture();t.after(()=>f.delivery.destroy());f.delivery.accept({id:'local-startup-chat',serverTime:start});f.delivery.start();
  assert.equal(f.delivery.clockOffsetMs(),-120000);assert.deepEqual(f.delivery.view().messages,[]);assert.equal(f.timers.size,1);
  f.advance(4999);assert.deepEqual(f.reveals,[]);f.advance(1);assert.deepEqual(f.reveals,[[1]]);
  for(let n=2;n<=4;n++){f.advance(5000);assert.deepEqual(f.reveals.at(-1),Array.from({length:n},(_,i)=>i+1));assert(f.timers.size<=1);}
  assert.equal(f.timers.size,0);assert.equal(f.delivery.state().pending,false);assert.equal(f.delivery.view().messages[3].created,start+20000);
  assert.equal(kundliWaitState(kundliWaitDeadline(f.delivery.view().messages[3]),f.delivery.now()).text,'05:00');
  f.advance(10000);assert.equal(f.reveals.length,4);assert.equal(kundliWaitState(kundliWaitDeadline(f.delivery.view().messages[3]),f.delivery.now()).text,'04:50');
});

test('signup preparation time does not re-anchor a server response received five seconds earlier',t=>{
  const f=fixture();t.after(()=>f.delivery.destroy());f.delivery.accept({id:'local-startup-chat',serverTime:start});
  f.advance(5000);f.delivery.start();assert.deepEqual(f.delivery.view().messages.map(row=>row.id),[1]);assert.equal(f.delivery.now(),start+5000);assert.equal(f.timers.size,1);
});

test('cached offline reopen retains delivery deadlines and safe clock offset without stale serverTime',t=>{
  const first=fixture();t.after(()=>first.delivery.destroy());first.delivery.accept({id:'local-startup-chat',serverTime:start});first.advance(7000);
  const cached={id:'local-startup-chat',clockOffsetMs:first.delivery.clockOffsetMs(),serverTime:start,messages:rows()};
  const next=fixture({elapsed:7000,cached});t.after(()=>next.delivery.destroy());next.delivery.accept(cached,{cached:true});next.delivery.start();
  assert.deepEqual(next.delivery.view().messages.map(row=>row.id),[1]);next.advance(3000);assert.deepEqual(next.reveals,[[1,2]]);
  next.advance(10000);assert.deepEqual(next.delivery.view().messages.map(row=>row.id),[1,2,3,4]);assert.equal(next.timers.size,0);
  assert.equal(cached.messages[3].created,start+20000);
});

test('monotonic elapsed time resists device clock changes and ignores older server anchors',t=>{
  const f=fixture();t.after(()=>f.delivery.destroy());f.delivery.accept({id:'local-startup-chat',serverTime:start});f.delivery.start();
  f.advance(4000);f.jumpWall(3600000);assert.equal(f.delivery.now(),start+4000);assert.equal(f.delivery.clockOffsetMs(),-3720000);
  f.delivery.accept({id:'local-startup-chat',serverTime:start+4000});f.delivery.accept({id:'local-startup-chat',serverTime:start+2000});assert.equal(f.delivery.now(),start+4000);
  f.advance(1000);assert.deepEqual(f.delivery.view().messages.map(row=>row.id),[1]);
  for(const bad of [Infinity,NaN,'1',3660*86400000+1])assert.equal(validClockOffset(bad),false);
});

test('hidden pages suspend local reveals and resume elapsed deadlines without replay or requests',t=>{
  const f=fixture();t.after(()=>f.delivery.destroy());f.delivery.accept({id:'local-startup-chat',serverTime:start});f.delivery.start();
  f.doc.hidden=true;f.doc.visibilityState='hidden';f.doc.dispatchEvent(new Event('visibilitychange'));assert.equal(f.timers.size,0);
  f.advance(16000);assert.deepEqual(f.reveals,[]);f.doc.hidden=false;f.doc.visibilityState='visible';f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(f.reveals,[[1,2,3]]);assert.equal(f.timers.size,1);f.win.dispatchEvent(new Event('pagehide'));assert.equal(f.timers.size,0);
  f.advance(4000);f.win.dispatchEvent(new Event('pageshow'));assert.deepEqual(f.reveals.at(-1),[1,2,3,4]);assert.equal(f.timers.size,0);
});

test('a later ordinary high-ID reply cannot hide delayed low-ID startup rows or defeat the read limit',t=>{
  const f=fixture();t.after(()=>f.delivery.destroy());f.setChat({id:'local-startup-chat',messages:[...rows(),{id:9,role:'assistant',created:start+1000,body:'Manual'}]});f.delivery.accept({id:'local-startup-chat',serverTime:start});f.delivery.start();
  assert.deepEqual(f.delivery.view().messages.map(row=>row.id),[9]);assert.equal(f.delivery.view().startupReadLimit,0);
  f.advance(5000);assert.deepEqual(f.delivery.view().messages.map(row=>row.id),[1,9]);assert.equal(f.delivery.view().startupReadLimit,1);
  f.advance(15000);assert.equal(f.delivery.view().startupReadLimit,null);assert.equal(f.delivery.view().messages.length,5);
});

test('post-timer sequence remains quiet through the long wait, shows a five-second lead, then reveals thirty lines',t=>{
  const f=fixture();t.after(()=>f.delivery.destroy());const messages=[...rows(),...followups()],original=JSON.stringify(messages);
  f.setChat({id:'local-startup-chat',messages});f.delivery.accept({id:'local-startup-chat',serverTime:start});f.delivery.start();f.advance(20000);
  assert.equal(f.delivery.state().pending,true);assert.equal(f.delivery.state().sending,false);assert.equal(f.delivery.state().readLimit,4);assert.equal(f.delivery.state().nextWakeAt,start+315000);assert.equal([...f.timers.values()][0].due,315000);
  const count=f.reveals.length;f.advance(294999);assert.equal(f.reveals.length,count);assert.equal(f.delivery.state().sending,false);assert.equal(f.delivery.view().messages.length,4);
  f.advance(1);assert.equal(f.delivery.state().sending,true);assert.equal(f.delivery.view().messages.length,4);assert.equal(kundliWaitState(kundliWaitDeadline(messages[3]),f.delivery.now()).text,'00:05');
  f.advance(5000);assert.deepEqual(f.delivery.view().messages.map(row=>row.id),[1,2,3,4,5]);assert.equal(kundliWaitState(kundliWaitDeadline(messages[3]),f.delivery.now()).text,'00:00');
  for(let index=1;index<30;index++){f.advance(5000);assert.equal(f.delivery.view().messages.length,5+index);assert(f.timers.size<=1);}
  assert.equal(f.delivery.view().messages.length,34);assert.equal(f.delivery.state().sending,false);assert.equal(f.delivery.state().readLimit,null);assert.equal(f.timers.size,0);assert.equal(JSON.stringify(messages),original);
});

test('offline reopen before and during post-timer delivery preserves deadlines and does not restart the kundli timer',t=>{
  const messages=[...rows(),...followups()],cached={id:'local-startup-chat',clockOffsetMs:-120000,serverTime:start,messages};
  const waiting=fixture({elapsed:100000,cached});t.after(()=>waiting.delivery.destroy());waiting.delivery.accept(cached,{cached:true});waiting.delivery.start();
  assert.equal(waiting.delivery.view().messages.length,4);assert.equal(waiting.delivery.state().sending,false);assert.equal(waiting.delivery.state().nextWakeAt,start+315000);assert.equal(kundliWaitState(kundliWaitDeadline(messages[3]),waiting.delivery.now()).text,'03:40');
  const later=fixture({elapsed:327000,cached});t.after(()=>later.delivery.destroy());later.delivery.accept(cached,{cached:true});later.delivery.start();
  assert.equal(later.delivery.view().messages.length,6);assert.equal(later.delivery.state().sending,true);assert.deepEqual(later.reveals,[]);assert.equal(kundliWaitState(kundliWaitDeadline(messages[3]),later.delivery.now()).text,'00:00');
  later.advance(3000);assert.equal(later.delivery.view().messages.length,7);assert.equal(later.reveals.length,1);assert.equal(messages[3].created,start+20000);
});

test('future deleted rows keep read ordering safe without a false sending indicator',()=>{
  const deleted={id:5,role:'assistant',deleted:true,deliveryAt:start+5000},next={id:6,role:'assistant',deliveryAt:start+20000};
  const state=startupDeliveryState([deleted,next],start);assert.equal(state.sending,false);assert.equal(state.readLimit,4);assert.equal(state.nextWakeAt,start+5000);
  const after=startupDeliveryState([deleted,next],start+5000);assert.equal(after.sending,false);assert.equal(after.nextWakeAt,start+15000);
});
