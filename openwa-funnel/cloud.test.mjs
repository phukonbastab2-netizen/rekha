import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './cloud-worker.mjs';
import {Engine} from './engine.mjs';
import {createInboxSync} from './inbox-sync.mjs';
const source='00000000-0000-4000-8000-000000000000';
function fixture(t) {
  const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')); t.after(() => db.close());
  const objects = new Map();
  const env = {
    BRIDGE_TOKEN: 'private-test-token',
    DB: {
      prepare(sql) { return { bind(...args) { return { run: () => db.prepare(sql).run(...args), all: async () => ({ results: db.prepare(sql).all(...args) }) }; } }; },
      async batch(statements) { db.exec('BEGIN'); try { for (const s of statements) s.run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
    },
    MEDIA: { put: async (key,value) => objects.set(key,value), delete: async key => objects.delete(key), get: async () => null }
  };
  const call = (route,body,authorized=true,method=body?'POST':'GET') => worker.fetch(new Request('https://private.test'+route, { method, headers: { ...(authorized?{Authorization:'Bearer private-test-token'}:{}), 'Content-Type':'application/json' }, ...(body?{body:JSON.stringify(body)}:{}) }),env);
  return { call,db,objects };
}
const change=(seq,name='Alice')=>({seq,key:'contact:919876543210@c.us',kind:'contact',peer:'919876543210@c.us',stamp:1000000,json:JSON.stringify({key:'contact:919876543210@c.us',kind:'contact',name})});
test('cloud health public but every record/media route requires secret',async t=>{const{call}=fixture(t);assert.equal((await call('/health',null,false)).status,200);assert.equal((await call('/records?source='+source,null,false)).status,401);assert.equal((await call('/sync',{source,changes:[change(1)]},false)).status,401);});
test('cloud duplicates and out of order retries never overwrite newer state',async t=>{const{call}=fixture(t);for(const c of [change(2,'New name'),change(1,'Old name'),change(2,'New name')])assert.equal((await call('/sync',{source,changes:[c]})).status,200);const data=await(await call('/records?source='+source)).json();assert.equal(data.records.length,1);assert.equal(JSON.parse(data.records[0].payload).name,'New name');});
test('cloud malformed batch does not partially save',async t=>{const{call,db}=fixture(t);const result=await call('/sync',{source,changes:[change(1),{...change(2),json:'bad json'}]});assert.equal(result.status,400);assert.equal(db.prepare('SELECT count(*) n FROM ow_backup').get().n,0);});
test('cloud attachments removed when content retention tombstone is mirrored',async t=>{const{call,objects}=fixture(t);const id='a'.repeat(64),key='openwa-private/'+source+'/'+id;objects.set(key,'private attachment');const c={seq:1,key:'in:id',kind:'deleted',peer:'',stamp:1,json:JSON.stringify({key:'in:id',kind:'deleted',mediaId:id})};assert.equal((await call('/sync',{source,changes:[c]})).status,200);assert.equal(objects.has(key),false);});
test('recovery checkpoint and imported history remain compatible with the deployed backup contract',async t=>{
 const {call}=fixture(t),engine=new Engine(':memory:');t.after(()=>engine.close());
 createInboxSync({engine,evaluate:async()=>{},onIncoming:async()=>{}});
 engine.importHistory({peer:'919876543210@c.us',id:'history',type:'text',body:'Hello',at:1000000});
 assert.equal((await call('/sync',{source,changes:engine.changes()})).status,200);
});
