import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',compatibilityDate:'2026-09-24',d1Databases:{DB:'attachment-quota-fixture'}}));
const db=await mf.getD1Database('DB'),stmt=(sql,...args)=>db.prepare(sql).bind(...args);
const apply=async file=>{for(const sql of splitSqlStatements(readFileSync(new URL('../cloudflare/'+file,import.meta.url),'utf8')))await db.prepare(sql).run();};
const total=async()=>(await stmt('SELECT bytes FROM attachment_storage_stats WHERE id=1').first()).bytes;
const chat=async()=>{const id=randomUUID();await stmt("INSERT INTO conversations(id,token_hash,name,dob,language,preferences,created,updated) VALUES(?,?,'Storage fixture','1990-01-01','en','{}',0,0)",id,randomUUID()).run();return id;};
const insert=(id,size,limit=false)=>stmt(`INSERT INTO chat_attachments(id,conversation_id,title,type,object_key,mime,size,created) SELECT ?,?,'Fixture','document',?,'application/pdf',?,0${limit?' WHERE (SELECT bytes FROM attachment_storage_stats WHERE id=1)+?<=1073741824':''}`,randomUUID(),id,randomUUID(),size,...(limit?[size]:[])).run();
try{
  await apply('schema.sql');
  // Exercise upgrading a pre-counter installation, rather than only new setup.
  for(const trigger of ['attachment_storage_insert','attachment_storage_delete','attachment_storage_update'])await stmt('DROP TRIGGER IF EXISTS '+trigger).run();
  await stmt('DROP TABLE IF EXISTS attachment_storage_stats').run();
  const first=await chat(),second=await chat();await insert(first,100);await insert(second,200);
  // A legacy upload between structural statements must be included in the
  // initial total; after that atomic INSERT all accounting triggers are live.
  for(const sql of splitSqlStatements(readFileSync(new URL('../cloudflare/migration-attachment-quota.sql',import.meta.url),'utf8'))){
    if(/INSERT OR IGNORE INTO attachment_storage_stats/.test(sql))await insert(first,25);
    await db.prepare(sql).run();
  }
  assert.equal(await total(),325);
  await insert(first,50);assert.equal(await total(),375);await apply('migration-attachment-quota.sql');assert.equal(await total(),375);
  await stmt('UPDATE chat_attachments SET size=size+10 WHERE conversation_id=?',second).run();assert.equal(await total(),385);
  await stmt('DELETE FROM conversations WHERE id=?',first).run();assert.equal(await total(),210);
  await stmt('DELETE FROM chat_attachments WHERE conversation_id=?',second).run();assert.equal(await total(),0);
  const large=await chat(),small=await chat();await insert(large,1073741814);
  const requests=await Promise.all(Array.from({length:12},()=>insert(small,10,true)));assert.equal(requests.filter(result=>result.meta.changes>0).length,1);assert.equal(await total(),1073741824);
  assert.equal((await insert(small,1,true)).meta.changes,0);await stmt('DELETE FROM conversations WHERE id=?',large).run();assert.equal(await total(),10);assert.ok((await insert(small,1,true)).meta.changes>0);
  const read=await stmt('SELECT bytes FROM attachment_storage_stats WHERE id=1').all();assert.equal(read.meta.rows_read,1);
  const plan=await stmt('EXPLAIN QUERY PLAN SELECT bytes FROM attachment_storage_stats WHERE id=1').all();assert.ok(plan.results.some(row=>/INTEGER PRIMARY KEY/.test(row.detail)));
  console.log('Attachment quota passed: one-time upgrade backfill, repeatable migration, size/delete/cascade accounting, concurrent atomic limit and one-row indexed check.');
}finally{await mf.dispose();}
