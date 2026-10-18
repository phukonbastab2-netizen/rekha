import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createProviderJournal,createProviderJournalReader,readProviderJournalPage} from './provider-journal.mjs';
import {serializeNativeMessage} from './inbox-sync.mjs';

const peer='919876543210@c.us',own='919876548973@c.us';
const native=(id,body='Actual text',extra={})=>({id:{_serialized:id,fromMe:id.startsWith('true_'),remote:{_serialized:peer}},t:1000,type:'chat',body,...extra});
const row=(id,rowId=1,type='chat')=>({id,rowId,type,t:1000,msgRowOpaqueData:{_data:'NOT PLAINTEXT',iv:'DO NOT READ'}});
const clone=value=>JSON.parse(JSON.stringify(value));

function fixture(initialRows,initialModels=[],hydrated=[]){
  const state={rows:initialRows,models:initialModels,hydrated:new Map(hydrated.map(m=>[m.id._serialized,m])),reads:0,hydrates:[],opened:0,closed:0,version:2070,now:2000000};
  const asyncRequest=(get)=>{const r={};queueMicrotask(()=>{try{r.result=get();r.onsuccess?.();}catch{r.onerror?.();}});return r;};
  const rows=()=>state.rows.slice().sort((a,b)=>a.id.localeCompare(b.id));
  const table=()=>({keyPath:'id',indexNames:['rowId'],index:()=>({keyPath:'rowId',unique:true}),count:()=>asyncRequest(()=>state.rows.length),get:key=>asyncRequest(()=>state.rows.find(r=>r.id===key)),openCursor:range=>{
    const ordered=rows().filter(r=>!range||r.id>range.lower),r={};let index=0;
    const emit=()=>queueMicrotask(()=>{const value=ordered[index];r.result=value?{value,key:value.id,primaryKey:value.id,continue(){index++;emit();}}:null;r.onsuccess?.();});emit();return r;
  }});
  const context={setTimeout,clearTimeout,console,IDBKeyRange:{lowerBound:(lower,open)=>({lower,open})},indexedDB:{databases:async()=>[{name:'model-storage',version:state.version}],open:name=>{state.opened++;assert.equal(name,'model-storage');return asyncRequest(()=>({name,version:state.version,objectStoreNames:{contains:name=>name==='message'},transaction:(name,mode)=>{assert.equal(name,'message');assert.equal(mode,'readonly');state.reads++;return{objectStore:table};},close(){state.closed++;}}));}},Store:{Msg:{getModelsArray:()=>state.models,getMessagesById:async ids=>{state.hydrates.push(ids);return{messages:ids.map(id=>state.hydrated.get(id)).filter(Boolean),eof:true,canceled:false};}},Chat:{get:()=>({name:'Client',contact:{pushname:'Client'}})},Contact:{get:()=>null}},require:n=>{if(n==='WAWebUserPrefsMeUser')return{getMaybeMePnUser:()=>own,getMaybeMeLidUser:()=>null};throw Error('Unapproved native dependency');}};
  const reader=createProviderJournalReader(serializeNativeMessage);
  state.evaluate=async(fn,args)=>{const run=vm.runInNewContext('('+fn.toString()+')',context);return run(args);};
  state.read=args=>state.evaluate(reader,args);
  state.context=context;
  return state;
}

function memoryEngine(){const records=new Map();return{get:key=>records.has(key)?clone(records.get(key)):null,put:value=>records.set(value.key,clone(value)),records};}

test('reads stored identities and hydrates real text absent from the loaded collection',async()=>{
  const id='false_'+peer+'_old',f=fixture([row(id,999999918)],[],[native(id,'Phone-only reply')]);
  const result=await f.read({limit:100});
  assert.equal(result.messages.length,1);assert.equal(result.messages[0].body,'Phone-only reply');
  assert.equal(result.messages[0].journal.source,'native_indexeddb');assert.equal(result.messages[0].journal.rowId,999999918);
  assert.equal(result.storedRows,1);assert.equal(result.complete,true);assert.equal(result.pageHydrated,1);
  assert.deepEqual(clone(f.hydrates),[[id]]);assert.equal(f.closed,1);
});

test('does not treat encrypted row fields or missing hydrated plaintext as message text',async()=>{
  const id='false_'+peer+'_hole',opaque=row(id);Object.defineProperty(opaque.msgRowOpaqueData,'_data',{get(){throw Error('Encrypted payload must not be touched');}});
  const f=fixture([opaque],[],[native(id,undefined)]);f.hydrated.get(id).body=undefined;
  const result=await f.read({});assert.equal(result.messages.length,0);assert.deepEqual([...result.unresolvedIds],[id]);assert.equal(result.pageUnresolved,1);
});

test('all-direction snapshots preserve outgoing, self-chat, media, contact and location fields',async()=>{
  const records=['in','out','self','media','card','place'].map((label,i)=>row((label==='in'?'false_':'true_')+peer+'_'+label,i+1,label==='in'||['out','self'].includes(label)?'chat':label==='media'?'image':label==='card'?'vcard':'location'));
  const hydrated=records.map((r,i)=>native(r.id,'Actual '+i,{type:r.type,...(i===2?{id:{_serialized:r.id,remote:{_serialized:own},fromMe:true}}:{}),...(i===3?{caption:'Real caption',mimetype:'image/jpeg',directPath:'/actual-media',mediaKey:'private-media-key'}:{}),...(i===4?{body:'BEGIN:VCARD\nFN:Actual contact\nEND:VCARD'}:{}),...(i===5?{lat:27.57,lng:77.69,loc:'Actual place'}:{})}));
  const f=fixture(records,[],hydrated),result=await f.read({});
  const byId=new Map(result.messages.map(m=>[m.id,m]));
  assert.equal(byId.get(records[0].id).fromMe,false);assert.equal(byId.get(records[1].id).fromMe,true);assert.equal(byId.get(records[2].id).isSelf,true);
  assert.equal(byId.get(records[3].id).caption,'Real caption');assert.equal(byId.get(records[3].id).directPath,'/actual-media');
  assert.match(byId.get(records[4].id).body,/Actual contact/);assert.equal(byId.get(records[5].id).lat,27.57);
});

test('durable bounded pages resume after restart and revisit late older rows next sweep',async()=>{
  const records=Array.from({length:205},(_,i)=>row('false_'+peer+'_'+String(i).padStart(4,'0'),1000000000+i)),f=fixture(records,records.map(r=>native(r.id)));
  const engine=memoryEngine(),seen=[];
  const build=()=>createProviderJournal({engine,evaluate:f.evaluate,onMessage:async m=>seen.push(m.id),serializeNativeMessage,now:()=>f.now});
  const first=build();await first.scan();assert.equal(first.status.lastPageRows,100);assert.equal(engine.get('provider-journal-cursor').cursor.position,records[99].id);
  const restarted=build();await restarted.scan();assert.equal(restarted.status.lastPageRows,100);
  await restarted.scan();assert.equal(restarted.status.lastPageRows,5);assert.equal(restarted.status.completedPasses,1);assert.equal(restarted.status.lastPass.localRowsCovered,true);
  const older=row('false_'+peer+'_000!',999999000);f.rows.push(older);f.models.push(native(older.id,'Late older history'));
  await restarted.scan();assert.ok(seen.includes(older.id));assert.equal(restarted.status.mobileHistoryComplete,false);
  assert.ok(f.hydrates.length===0);assert.equal(f.opened,f.closed);
});

test('unresolved records remain on durable priority retries and can later hydrate',async()=>{
  const id='false_'+peer+'_hole',f=fixture([row(id)]),engine=memoryEngine(),seen=[];
  const build=()=>createProviderJournal({engine,evaluate:f.evaluate,onMessage:async m=>seen.push(m.id),serializeNativeMessage,now:()=>f.now});
  const sync=build();await sync.scan();assert.equal(sync.status.pendingHydration,1);assert.equal(sync.status.lastPass.localRowsCovered,false);
  assert.equal(engine.get('provider-journal-cursor').pending[0].id,id);
  f.hydrated.set(id,native(id,'Decoded later'));f.now+=6000;
  const resumed=build();await resumed.scan();assert.deepEqual(seen,[id]);assert.equal(resumed.status.pendingHydration,0);
});

test('a failed gateway callback cannot advance the durable cursor',async()=>{
  const id='false_'+peer+'_a',f=fixture([row(id)],[native(id)]),engine=memoryEngine();let fail=true;
  const sync=createProviderJournal({engine,evaluate:f.evaluate,onMessage:async()=>{if(fail)throw Error('Database busy');},serializeNativeMessage});
  assert.equal(await sync.scan(),false);assert.equal(engine.get('provider-journal-cursor'),null);assert.match(sync.status.error,/without advancing/);
  fail=false;assert.equal(await sync.scan(),true);assert.equal(sync.status.completedPasses,1);
});

test('native schema change or a replaced row anchor resets safely without losing old holes',async()=>{
  const records=Array.from({length:3},(_,i)=>row('false_'+peer+'_'+i,i+1)),f=fixture(records,records.map(r=>native(r.id)));
  const first=await f.read({limit:1});assert.equal(first.complete,false);
  f.rows[0].rowId=999;
  const replaced=await f.read({cursor:first.cursor,limit:1});assert.equal(replaced.reset,true);assert.equal(replaced.messages[0].id,records[0].id);
  f.version++;
  const schema=await f.read({cursor:replaced.cursor,limit:1});assert.equal(schema.reset,true);assert.equal(schema.pageRows,1);
});

test('a hydration failure leaves records unresolved and never invents fallback bodies',async()=>{
  const id='false_'+peer+'_a',f=fixture([row(id)]);f.context.Store.Msg.getMessagesById=async()=>{throw Error('Provider decoding failed');};
  const result=await f.read({});assert.equal(result.hydrationError,true);assert.equal(result.messages.length,0);assert.deepEqual([...result.unresolvedIds],[id]);
});

test('internal rows are accounted for without sending, receipts, history requests or profile changes',async()=>{
  const ids=['e2e_notification','notification_template','album'].map((type,i)=>row('false_'+peer+'_'+i,i,type)),f=fixture(ids);
  for(const name of ['sendMessage','sendSeen','markRead','loadEarlierMsgs','requestHistory'])f.context.Store.Msg[name]=()=>{throw Error('Forbidden write');};
  const result=await f.read({});assert.equal(result.messages.length,0);assert.equal(result.pageIgnored,3);assert.equal(f.hydrates.length,0);assert.equal(result.unresolvedIds.length,0);
});

test('each provider read stays within 100 selected rows including priority retries',async()=>{
  const records=Array.from({length:200},(_,i)=>row('false_'+peer+'_'+String(i).padStart(4,'0'),i)),f=fixture(records,records.map(r=>native(r.id)));
  const retryIds=records.slice(-50).map(r=>r.id),result=await f.read({limit:10000,retryIds});
  assert.equal(result.pageRows,75);assert.equal(result.messages.length,100);assert.equal(result.complete,false);
});

test('overlapping scans do not run concurrently and ignore untrusted response errors safely',async()=>{
  const engine=memoryEngine();let finish,calls=0;
  const sync=createProviderJournal({engine,serializeNativeMessage,onMessage:async()=>{},evaluate:async()=>{calls++;await new Promise(resolve=>finish=resolve);return null;}});
  const running=sync.scan();assert.equal(await sync.scan(),false);assert.equal(calls,1);finish();await running;
  assert.equal(sync.status.running,false);assert.equal(engine.get('provider-journal-cursor'),null);
});

test('does not create a nonexistent native database',async()=>{
  const context={Store:{Msg:{}},indexedDB:{databases:async()=>[],open(){throw Error('Must not create database');}}};
  const fn=vm.runInNewContext('('+readProviderJournalPage.toString()+')',context);
  await assert.rejects(fn({},()=>({})),/table unavailable/);
});

test('priority retry state stays below the cloud record limit for long Unicode identities',async()=>{
  const engine=memoryEngine(),ids=Array.from({length:100},(_,i)=>String(i)+'\u754c'.repeat(2040));
  const sync=createProviderJournal({engine,serializeNativeMessage,onMessage:async()=>{},evaluate:async()=>({cursor:{generation:'actual-native-generation',position:null,anchor:null,cycle:1},messages:[],unresolvedIds:ids,storedRows:100,pageRows:100,pageHydrated:0,pageIgnored:0,pageUnresolved:100,complete:true})});
  assert.equal(await sync.scan(),true);
  const record=engine.get('provider-journal-cursor');
  assert.ok(record.pending.length>0&&record.pending.length<100);
  assert.ok(Buffer.byteLength(JSON.stringify(record.pending),'utf8')<=20000);
  assert.ok(JSON.stringify(record).length<30000);
  assert.equal(sync.status.lastPass.localRowsCovered,false);
  assert.equal(record.cursor.position,null,'Overflow remains available to the next full sweep');
});
