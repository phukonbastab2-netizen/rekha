import test from 'node:test';
import assert from 'node:assert/strict';
import {createMessageState,createContactState,compareCursors,decodeCursor,releaseMessageMedia,historyCursor} from './public/message-state.js';
import {createApi} from './public/api.js';

const peer='919876543210@c.us',other='919876543211@c.us';
const cursor=(stamp,key)=>Buffer.from(JSON.stringify({stamp,key})).toString('base64url');
const row=(n,stamp=n,extra={})=>({key:'in:'+String(n).padStart(4,'0'),kind:'message',peer,at:n,body:'Message '+n,status:'received',_cursor:cursor(stamp,'in:'+String(n).padStart(4,'0')),...extra});
function fixture(options={}){
  const state=createMessageState(options);state.select(peer);
  const db=new Map(),requests=[];let contact={peer};
  const fetchPage=async request=>{
    requests.push(request);const rows=[...db.values()].filter(r=>r.peer===request.peer),timeline=request.order==='timeline';
    const chronological=(a,b)=>a.at-b.at||(a.key<b.key?-1:a.key>b.key?1:0),boundary=timeline&&request.before?JSON.parse(Buffer.from(request.before,'base64url')):null;
    return{contact:{...contact,peer:request.peer},jobs:[],...(timeline?{revisionCursor:[...rows].sort((a,b)=>compareCursors(b._cursor,a._cursor))[0]?._cursor||''}:{}),messages:rows.filter(r=>!request.before||(timeline?chronological(r,boundary)<0:compareCursors(r._cursor,request.before)<0)).sort((a,b)=>timeline?chronological(b,a):compareCursors(b._cursor,a._cursor)).slice(0,50).map(r=>({...r,...(timeline?{_historyCursor:historyCursor(r)}:{})}))};
  };
  return{state,db,requests,fetchPage,setContact:value=>contact=value};
}
test('head polling resumes across pages without losing sixty new messages',async()=>{
  const f=fixture({pagesPerPoll:1});for(let n=1;n<=10;n++)f.db.set(row(n).key,row(n));await f.state.load(f.fetchPage);
  for(let n=11;n<=70;n++)f.db.set(row(n).key,row(n));
  const first=await f.state.load(f.fetchPage);assert.equal(first.catchingUp,true);assert.equal(f.state.records.size,60);
  const second=await f.state.load(f.fetchPage);assert.equal(second.catchingUp,false);assert.equal(f.state.records.size,70);
  for(let n=1;n<=70;n++)assert.ok(f.state.records.has(row(n).key));
});
test('new messages sharing one revision timestamp use the key tie-break across page boundaries',async()=>{
  const f=fixture({pagesPerPoll:1});f.db.set(row(1).key,row(1));await f.state.load(f.fetchPage);
  for(let n=2;n<=61;n++)f.db.set(row(n).key,row(n,1000));
  await f.state.load(f.fetchPage);await f.state.load(f.fetchPage);assert.equal(f.state.records.size,61);assert.equal(f.state.catchingUp,false);
});
test('bulk ACK updates to sixty loaded rows sharing a timestamp are all reflected',async()=>{
  const f=fixture({pagesPerPoll:1});for(let n=1;n<=60;n++)f.db.set(row(n).key,row(n,n,{direction:'out',status:'sent'}));
  await f.state.load(f.fetchPage);await f.state.load(f.fetchPage,{older:true});assert.equal(f.state.records.size,60);
  for(let n=1;n<=60;n++)f.db.set(row(n).key,row(n,500,{direction:'out',status:'read'}));
  await f.state.load(f.fetchPage);assert.equal(f.state.catchingUp,true);await f.state.load(f.fetchPage);assert.equal(f.state.catchingUp,false);
  assert.equal([...f.state.records.values()].filter(r=>r.status==='read').length,60);
});
test('refresh catch-up does not move the independent older-history cursor',async()=>{
  const f=fixture({pagesPerPoll:1});for(let n=1;n<=100;n++)f.db.set(row(n).key,row(n));await f.state.load(f.fetchPage);
  const historyCursor=f.state.olderCursor;
  for(let n=101;n<=160;n++)f.db.set(row(n).key,row(n));await f.state.load(f.fetchPage);await f.state.load(f.fetchPage);
  assert.equal(f.state.olderCursor,historyCursor);await f.state.load(f.fetchPage,{older:true});
  assert.ok(f.requests.some(r=>r.before===historyCursor));assert.equal(f.state.records.size,160);
});
test('an initially empty chat catches up to more than fifty later messages',async()=>{
  const f=fixture({pagesPerPoll:1});await f.state.load(f.fetchPage);for(let n=1;n<=60;n++)f.db.set(row(n).key,row(n));
  await f.state.load(f.fetchPage);assert.equal(f.state.catchingUp,true);await f.state.load(f.fetchPage);assert.equal(f.state.records.size,60);
});
test('peer changes discard late responses and do not wait for the old request',async()=>{
  const f=fixture();let release;const old=f.state.load(()=>new Promise(resolve=>release=resolve));await Promise.resolve();
  f.state.select(other);f.db.set('other',row(2,2,{key:'other',peer:other,_cursor:cursor(2,'other')}));
  const fresh=await f.state.load(f.fetchPage);assert.equal(fresh.peer,other);assert.equal(f.state.records.size,1);
  release({contact:{peer},messages:[row(1)],jobs:[]});assert.equal((await old).stale,true);assert.equal(f.state.records.size,1);assert.ok(f.state.records.has('other'));
});
test('returning to the same peer still rejects a previous generation response',async()=>{
  const f=fixture();let release;const pending=f.state.load(()=>new Promise(resolve=>release=resolve));await Promise.resolve();
  f.state.select(other);f.state.select(peer);f.db.set(row(2).key,row(2));await f.state.load(f.fetchPage);
  release({contact:{peer},messages:[row(1)],jobs:[]});assert.equal((await pending).stale,true);assert.deepEqual([...f.state.records.keys()],[row(2).key]);
});
test('remote content deletion invalidates cached media and all old in-flight responses',async()=>{
  const f=fixture();const media=row(1,1,{media:{id:'a'.repeat(64),mime:'image/jpeg'}});f.db.set(media.key,media);await f.state.load(f.fetchPage);
  let release;const pending=f.state.load(()=>new Promise(resolve=>release=resolve));await Promise.resolve();const before=f.state.generation;
  assert.equal(f.state.noticeContact({peer,contentDeletedAt:100}),true);assert.equal(f.state.records.size,0);assert.ok(f.state.generation>before);
  release({contact:{peer},messages:[media],jobs:[]});assert.equal((await pending).stale,true);assert.equal(f.state.records.size,0);
  f.db.set(row(101).key,row(101));f.setContact({peer,contentDeletedAt:100});await f.state.load(f.fetchPage);
  assert.deepEqual([...f.state.records.keys()],[row(101).key]);assert.equal(f.state.noticeContact({peer,contentDeletedAt:100}),false);
});
test('a deletion discovered in a message page clears old content before rendering the page',async()=>{
  const f=fixture();f.db.set(row(1).key,row(1));await f.state.load(f.fetchPage);f.setContact({peer,contentDeletedAt:100});f.db.set(row(101).key,row(101));
  const result=await f.state.load(f.fetchPage);assert.equal(result.invalidated,true);assert.deepEqual([...f.state.records.keys()],[row(101).key]);
});
test('the local message window stays bounded while older history remains navigable',async()=>{
  const f=fixture({maxRecords:60,pagesPerPoll:1});for(let n=1;n<=300;n++)f.db.set(row(n).key,row(n));await f.state.load(f.fetchPage);
  await f.state.load(f.fetchPage,{older:true});assert.equal(f.state.records.size,60);assert.equal(f.state.historyMode,true);const oldest=Math.min(...[...f.state.records.values()].map(r=>r.at));
  await f.state.load(f.fetchPage,{older:true});assert.equal(f.state.records.size,60);assert.ok(Math.min(...[...f.state.records.values()].map(r=>r.at))<oldest);
  f.db.set(row(301).key,row(301));await f.state.load(f.fetchPage);assert.equal(f.state.hasNewer,true);assert.equal(f.state.records.size,60);
  f.state.latest();await f.state.load(f.fetchPage);assert.equal(f.state.historyMode,false);assert.ok(f.state.records.has(row(301).key));assert.equal(f.state.records.size,50);
});
test('refresh resumes after a failed page and does not replay an already committed older page',async()=>{
  const f=fixture({pagesPerPoll:1});f.db.set(row(1).key,row(1));await f.state.load(f.fetchPage);for(let n=2;n<=101;n++)f.db.set(row(n).key,row(n));
  await f.state.load(f.fetchPage);const cursorBefore=f.requests.at(-1).before;
  await assert.rejects(f.state.load(async()=>{throw Error('temporary offline');}),/temporary offline/);assert.equal(f.state.catchingUp,true);
  await f.state.load(f.fetchPage);assert.notEqual(f.requests.at(-1).before,cursorBefore);await f.state.load(f.fetchPage);assert.equal(f.state.records.size,101);
});
test('invalid pagination cannot silently mark an incomplete refresh as current',async()=>{
  assert.equal(decodeCursor('bad'),null);assert.throws(()=>compareCursors('bad',cursor(1,'one')),/pagination/);
  const f=fixture();await assert.rejects(f.state.load(async()=>({contact:{peer},messages:[{...row(1),_cursor:'bad'}]})),/pagination/);assert.equal(f.state.records.size,0);
});
test('new changes arriving during a bounded catch-up are found by the following head sweep',async()=>{
  const f=fixture({pagesPerPoll:1});f.db.set(row(1).key,row(1));await f.state.load(f.fetchPage);
  for(let n=2;n<=101;n++)f.db.set(row(n).key,row(n));await f.state.load(f.fetchPage);
  for(let n=102;n<=111;n++)f.db.set(row(n).key,row(n));
  await f.state.load(f.fetchPage);await f.state.load(f.fetchPage);await f.state.load(f.fetchPage);
  assert.equal(f.state.records.size,111);assert.equal(f.state.catchingUp,false);
});
test('edited and revoked revisions replace cached content without creating duplicate messages',async()=>{
  const f=fixture();const original=row(1,1,{media:{id:'a'.repeat(64),mime:'image/jpeg'}});f.db.set(original.key,original);await f.state.load(f.fetchPage);
  const edited={...original,body:'Edited message',editedAt:10,_cursor:cursor(10,original.key)};f.db.set(edited.key,edited);await f.state.load(f.fetchPage);
  assert.equal(f.state.records.size,1);assert.equal(f.state.records.get(original.key).body,'Edited message');
  const revoked={...edited,body:'[Message deleted]',media:null,revoked:true,_cursor:cursor(20,original.key)};f.db.set(revoked.key,revoked);await f.state.load(f.fetchPage);
  assert.equal(f.state.records.size,1);assert.equal(f.state.records.get(original.key).media,null);assert.equal(f.state.records.get(original.key).revoked,true);
});
test('discarded message views stop media playback and clear every image or media source',()=>{
  const calls=[];const image={removeAttribute:name=>calls.push('image:'+name)},audio={pause:()=>calls.push('audio:pause'),removeAttribute:name=>calls.push('audio:'+name),load:()=>calls.push('audio:load')},video={pause:()=>calls.push('video:pause'),removeAttribute:name=>calls.push('video:'+name),load:()=>calls.push('video:load')};
  releaseMessageMedia({querySelectorAll:selector=>{assert.equal(selector,'img,video,audio');return[image,audio,video];}});
  assert.deepEqual(calls,['image:src','audio:pause','audio:src','audio:load','video:pause','video:src','video:load']);
});
test('peer changes abort an old GET and discard its rejection without delaying the new chat',async()=>{
  const f=fixture();let oldSignal;const old=f.state.load(({signal})=>{oldSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));});await Promise.resolve();
  f.state.select(other);assert.equal(oldSignal.aborted,true);f.db.set('other',row(2,2,{key:'other',peer:other,_cursor:cursor(2,'other')}));
  const fresh=await f.state.load(f.fetchPage);assert.equal(fresh.peer,other);assert.equal((await old).stale,true);assert.equal(f.state.records.size,1);
});
test('optional cancellation applies to message GETs without changing ordinary API calls',async()=>{
  const controller=new AbortController(),calls=[];const api=createApi(async(url,options)=>{calls.push({url,options});return Response.json({ok:true});});
  await api('messages?peer='+peer,undefined,controller.signal);await api('status');
  assert.equal(calls[0].options.signal,controller.signal);assert.deepEqual(calls[1].options,{});
});

test('initial and older pages stay chronological after an old message receives a new revision',async()=>{
  const f=fixture();for(let n=1;n<=100;n++)f.db.set(row(n).key,row(n));f.db.set(row(1).key,row(1,1000,{status:'read'}));
  await f.state.load(f.fetchPage);assert.equal(f.requests[0].order,'timeline');assert.equal(f.state.records.size,50);
  assert.equal(Math.min(...[...f.state.records.values()].map(r=>r.at)),51);assert.equal(f.state.records.has(row(1).key),false);
  const before=f.state.olderCursor;assert.deepEqual(JSON.parse(Buffer.from(before,'base64url')),{at:51,key:row(51).key});
  f.db.set(row(101).key,row(101,1001));await f.state.load(f.fetchPage);assert.equal(f.requests.at(-1).order,'revision');assert.ok(f.state.records.has(row(101).key));
  await f.state.load(f.fetchPage,{older:true});assert.equal(f.requests.at(-1).order,'timeline');assert.equal(f.requests.at(-1).before,before);
  for(let n=1;n<=101;n++)assert.ok(f.state.records.has(row(n).key));
});

test('latest message cache retains recent message times rather than recent ACK revisions',async()=>{
  const f=fixture({maxRecords:50});for(let n=1;n<=100;n++)f.db.set(row(n).key,row(n));await f.state.load(f.fetchPage);
  for(let n=1;n<=50;n++)f.db.set(row(n).key,row(n,1000+n,{status:'read'}));await f.state.load(f.fetchPage);
  assert.equal(f.state.records.size,50);assert.equal(Math.min(...[...f.state.records.values()].map(r=>r.at)),51);
  assert.equal(JSON.parse(Buffer.from(f.state.olderCursor,'base64url')).at,51);
});

test('contact refresh catches more than fifty new chats and keeps older pagination separate',async()=>{
  const state=createContactState({pagesPerPoll:1}),db=new Map(),requests=[];
  const fetchPage=async before=>{requests.push(before);return[...db.values()].filter(r=>!before||compareCursors(r._cursor,before)<0).sort((a,b)=>compareCursors(b._cursor,a._cursor)).slice(0,50);};
  for(let n=1;n<=100;n++)db.set(row(n).key,row(n));await state.load(fetchPage);const older=state.olderCursor;
  for(let n=101;n<=160;n++)db.set(row(n).key,row(n));await state.load(fetchPage);assert.equal(state.catchingUp,true);
  await state.load(fetchPage);assert.equal(state.catchingUp,false);assert.equal(state.records.size,110);assert.equal(state.olderCursor,older);
  await state.load(fetchPage,{older:true});assert.equal(requests.at(-1),older);assert.equal(state.records.size,160);
});

test('contact changes arriving during catch-up are found on the next head sweep',async()=>{
  const state=createContactState({pagesPerPoll:1}),db=new Map();
  const fetchPage=async before=>[...db.values()].filter(r=>!before||compareCursors(r._cursor,before)<0).sort((a,b)=>compareCursors(b._cursor,a._cursor)).slice(0,50);
  db.set(row(1).key,row(1));await state.load(fetchPage);for(let n=2;n<=120;n++)db.set(row(n).key,row(n));await state.load(fetchPage);
  db.set(row(121).key,row(121));await state.load(fetchPage);await state.load(fetchPage);await state.load(fetchPage);
  assert.equal(state.records.size,121);assert.equal(state.catchingUp,false);
});
