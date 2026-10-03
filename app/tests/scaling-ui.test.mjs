import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdaptivePoll} from '../public/adaptive-poll.js';
import {createChatHistory} from '../public/chat-history.js';
import {createInboxPages} from '../public/inbox-pages.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function clock(){let time=0,id=0;const timers=new Map();return{now:()=>time,setTimer:(fn,ms)=>{const key=++id;timers.set(key,{fn,at:time+ms});return key;},clearTimer:key=>timers.delete(key),pending:()=>timers.size,next:()=>Math.min(...[...timers.values()].map(t=>t.at)),advance:async ms=>{const target=time+ms;for(;;){const [key,timer]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0]||[];if(!timer||timer.at>target)break;time=timer.at;timers.delete(key);timer.fn();await settle();}time=target;await settle();}};}
function setup(task,options={}){const time=clock(),doc=new EventTarget(),win=new EventTarget();doc.hidden=false;let connected=true;const poll=createAdaptivePoll({task,fastMs:100,idleMs:1000,activeForMs:200,maxErrorMs:2000,random:()=>.5,now:time.now,setTimer:time.setTimer,clearTimer:time.clearTimer,documentTarget:doc,windowTarget:win,online:()=>connected,...options});return{time,doc,win,poll,offline(value){connected=!value;win.dispatchEvent(new Event(value?'offline':'online'));}};}
test('slow polling never overlaps and repeated urgent updates coalesce into one follow-up',async()=>{
  let requests=0,finish;const h=setup(()=>{requests++;return new Promise(resolve=>finish=resolve);});h.poll.start();await h.time.advance(100);assert.equal(requests,1);
  for(let i=0;i<20;i++)h.poll.poke({immediate:true});await h.time.advance(2000);assert.equal(requests,1);assert.equal(h.time.pending(),0);
  finish({changed:true});await settle();await h.time.advance(150);assert.equal(requests,2);h.poll.destroy();finish();await settle();assert.equal(h.time.pending(),0);
});
test('quiet tabs back off; interaction and a live call restore prompt polling',async()=>{
  const arrivals=[];let live=false;const h=setup(()=>{arrivals.push(h.time.now());},{hot:()=>live,hotMs:40});h.poll.start();await h.time.advance(6000);
  const gaps=arrivals.slice(1).map((at,i)=>at-arrivals[i]);assert.ok(gaps.some(ms=>ms>=900));assert.ok(arrivals.length<12);
  const before=arrivals.length;h.doc.dispatchEvent(new Event('input'));await h.time.advance(100);assert.equal(arrivals.length,before+1);
  live=true;h.poll.poke();await h.time.advance(120);assert.ok(arrivals.length>=before+3);h.poll.destroy();
});
test('hidden and offline polling is suspended, aborts reads and resumes only one request',async()=>{
  let requests=0,aborted=0;const h=setup(({signal})=>{requests++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('Stopped','AbortError'));},{once:true}));});h.poll.start();await h.time.advance(100);h.doc.hidden=true;h.doc.dispatchEvent(new Event('visibilitychange'));await settle();await h.time.advance(5000);assert.equal(requests,1);assert.equal(aborted,1);
  h.doc.hidden=false;h.doc.dispatchEvent(new Event('visibilitychange'));h.offline(true);await h.time.advance(5000);assert.equal(requests,1);
  h.offline(false);await h.time.advance(100);assert.equal(requests,2);h.poll.destroy();await settle();assert.equal(aborted,2);
});
test('failure backoff and random phases prevent fixed synchronized request intervals',async()=>{
  let requests=0;const h=setup(()=>{requests++;throw new Error('Proxy unavailable');});h.poll.start();await h.time.advance(100);assert.equal(h.time.next()-h.time.now(),200);await h.time.advance(200);assert.equal(h.time.next()-h.time.now(),400);await h.time.advance(400);assert.equal(h.time.next()-h.time.now(),800);h.poll.destroy();
  const early=setup(()=>{}, {random:()=>0}),late=setup(()=>{}, {random:()=>1});early.poll.start();late.poll.start();assert.equal(early.time.next(),80);assert.equal(late.time.next(),120);early.poll.destroy();late.poll.destroy();
});
const message=(id,body='Message '+id,changeRevision=id)=>({id,role:id%2?'user':'assistant',body,created:id,changeRevision,readByOther:false});
const view=(messages,version=1,changeRevision=10,extra={})=>({id:'private-customer',version,updated:version,historyComplete:false,changeRevision,messages,...extra});
test('older pages retain live metadata, and delta updates retain all loaded history',()=>{
  const h=createChatHistory();let chat=h.accept(null,view([message(81),message(82)],3,20,{page:{oldestId:81,hasOlder:true},blocked:false}),{kind:'initial'});assert.equal(h.route('/api/chat'),'/api/chat?afterRevision=20');
  chat=h.accept(chat,view([message(1),message(2)],2,19,{page:{oldestId:1,hasOlder:false},blocked:true}),{kind:'older'});assert.equal(chat.version,3);assert.equal(chat.blocked,false);assert.equal(h.state().revision,20);assert.equal(h.state().hasOlder,false);
  chat=h.accept(chat,view([message(83)],4,21),{kind:'delta'});assert.deepEqual(chat.messages.map(m=>m.id),[1,2,81,82,83]);assert.equal(h.state().revision,21);
});
test('a saved ACK cannot skip concurrent old-message edits; row revisions beat stale core metadata',()=>{
  const h=createChatHistory();let chat=h.accept(null,view([message(1,'Original',1),message(82,'Recent',2)],3,3,{page:{oldestId:1,hasOlder:false}}),{kind:'initial'});
  chat=h.accept(chat,view([message(90)],5,5,{acknowledgedMessage:{...message(91),role:'user',clientId:'same-safe-send-id'}}));assert.equal(h.state().revision,3);assert.equal(chat.messages.at(-1).clientId,'same-safe-send-id');
  chat=h.accept(chat,view([{...message(1,'',4),deleted:true,reactions:[]}],4,4),{kind:'delta'});assert.equal(chat.version,5);assert.equal(chat.messages.find(m=>m.id===1).deleted,true);assert.equal(h.state().revision,4);
  chat=h.accept(chat,view([message(1,'Original',1)],5,5),{kind:'delta'});assert.equal(chat.messages.find(m=>m.id===1).deleted,true);
});
test('receipt cursors update older loaded pages and late unread deltas cannot undo a tick',()=>{
  const h=createChatHistory();let chat=h.accept(null,view([message(1),message(2),message(81)],3,3,{page:{oldestId:1,hasOlder:false}}),{kind:'initial'});
  chat=h.accept(chat,view([],3,3,{receiptCursors:{ownerRead:81,customerRead:2},typing:{owner:true}}),{kind:'delta'});assert.ok(chat.messages.every(m=>m.readByOther));assert.equal(chat.typing.owner,true);
  chat=h.accept(chat,view([message(1)],3,3,{receiptCursors:{ownerRead:0,customerRead:0}}),{kind:'delta'});assert.equal(chat.messages[0].readByOther,true);
});
test('wrong private conversation cannot alter history or advance the delta cursor',()=>{
  const h=createChatHistory();const chat=h.accept(null,view([message(80)],1,2),{kind:'initial'}),before=h.state();assert.equal(h.accept(chat,{...view([message(100)],5,50),id:'other-private-chat'},{kind:'delta'}),chat);assert.deepEqual(h.state(),before);
});
test('an older settings marker cannot undo pin/labels while newer message changes still apply',()=>{
  const h=createChatHistory();let chat=h.accept(null,view([message(1,'Original',1)],2,2,{inboxRevision:4,pinned:true,labels:['Paid']}),{kind:'initial'});
  chat=h.accept(chat,view([message(1,'New reply text',3)],3,3,{inboxRevision:3,pinned:false,labels:[]}),{kind:'delta'});assert.equal(chat.version,3);assert.equal(chat.pinned,true);assert.deepEqual(chat.labels,['Paid']);assert.equal(chat.messages[0].body,'New reply text');
  chat=h.accept(chat,view([],2,3,{inboxRevision:5,pinned:false,labels:['Reviewed']}),{kind:'delta'});assert.equal(chat.version,3);assert.equal(chat.pinned,false);assert.deepEqual(chat.labels,['Reviewed']);assert.equal(chat.messages[0].body,'New reply text');
});
test('inbox search rejects previous-query responses and requests the server beyond the first page',()=>{
  const inbox=createInboxPages();inbox.reset('first','all');const old=inbox.request();inbox.reset('Rare customer 99999','unread');const request=inbox.request();assert.match(request.route,/q=Rare\+customer\+99999/);assert.match(request.route,/filter=unread/);assert.equal(inbox.accept({items:[{id:'wrong'}]},old),false);assert.equal(inbox.accept({items:[{id:'found'}],nextCursor:'private-cursor',hasMore:true},request),true);assert.equal(inbox.state().items[0].id,'found');assert.match(inbox.request({more:true}).route,/cursor=private-cursor/);
});
test('inbox first-page refresh retains loaded older pages and their safe continuation cursor',()=>{
  const inbox=createInboxPages({limit:2});inbox.accept({items:[{id:'A'},{id:'B'}],hasMore:true,nextCursor:'page2'},inbox.request());inbox.accept({items:[{id:'C'},{id:'D'}],hasMore:true,nextCursor:'page3'},inbox.request({more:true}));
  inbox.accept({items:[{id:'E'},{id:'A',unread:1}],hasMore:true,nextCursor:'new-page2'},inbox.request());assert.deepEqual(new Set(inbox.state().items.map(m=>m.id)),new Set(['A','B','C','D','E']));assert.equal(inbox.state().nextCursor,'page3');
  inbox.accept({items:[{id:'D',unread:2},{id:'F'}],hasMore:false,nextCursor:null},inbox.request({more:true}));assert.equal(inbox.state().items.filter(m=>m.id==='D').length,1);assert.equal(inbox.state().items.find(m=>m.id==='D').unread,2);assert.equal(inbox.state().hasMore,false);
  inbox.remove('B');assert.ok(!inbox.state().items.some(m=>m.id==='B'));inbox.reset('Different','archived');assert.deepEqual(inbox.state().items,[]);
});
test('before Load more inbox refresh stays one page and rejects older settings metadata',()=>{
  const inbox=createInboxPages({limit:2});inbox.accept({items:[{id:'A',version:2,inboxRevision:4,pinned:true},{id:'B'}],hasMore:true,nextCursor:'page2'},inbox.request());
  inbox.accept({items:[{id:'E'},{id:'A',version:2,inboxRevision:3,pinned:false}],hasMore:true,nextCursor:'new-page2'},inbox.request());assert.deepEqual(inbox.state().items.map(item=>item.id),['E','A']);assert.equal(inbox.state().items[1].pinned,true);assert.equal(inbox.state().nextCursor,'new-page2');
});
test('inbox core and owner settings revisions merge independently',()=>{
  const inbox=createInboxPages();inbox.accept({items:[{id:'A',version:4,inboxRevision:2,waiting:1,pinned:false}],hasMore:false},inbox.request());
  inbox.accept({items:[{id:'A',version:3,inboxRevision:3,waiting:0,pinned:true}],hasMore:false},inbox.request());assert.equal(inbox.state().items[0].version,4);assert.equal(inbox.state().items[0].waiting,1);assert.equal(inbox.state().items[0].pinned,true);
  inbox.accept({items:[{id:'A',version:5,inboxRevision:2,waiting:2,pinned:false}],hasMore:false},inbox.request());assert.equal(inbox.state().items[0].version,5);assert.equal(inbox.state().items[0].waiting,2);assert.equal(inbox.state().items[0].pinned,true);assert.equal(inbox.state().items[0].inboxRevision,3);
});
