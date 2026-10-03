// Local in-memory SQLite only. Tests rollout retries and old-profile backfill.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {applyScaleMigration,backfillScaleCache} from '../cloudflare/scale-migration.mjs';
import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
const native=new DatabaseSync(':memory:');
const wrapper={prepare(sql){const prepared=native.prepare(sql);let values=[];return{bind(...items){values=items;return this;},async all(){return{results:prepared.all(...values)};},async run(){return{meta:prepared.run(...values)};}};}};
let transportedTriggers=0;
const restTransport={prepare(sql){assert.ok(!sql.includes('\r'),'D1 REST transport must receive LF-only SQL.');if(/CREATE\s+TRIGGER/i.test(sql))transportedTriggers++;return wrapper.prepare(sql);}};
assert.throws(()=>restTransport.prepare('CREATE TRIGGER example AFTER INSERT ON messages BEGIN\r\nSELECT 1;\r\nEND;'),/LF-only SQL/);
let schema=readFileSync('cloudflare/schema.sql','utf8').split('CREATE INDEX IF NOT EXISTS messages_changes')[0];
for(const column of ['change_revision','inbox_revision','inbox_pinned','inbox_archived','inbox_blocked','inbox_owner_read','last_user_id','last_message_id','waiting_count'])schema=schema.replaceAll(','+column+' INTEGER NOT NULL DEFAULT 0','');
native.exec(schema);
const ids=[];for(let i=0;i<110;i++){const id=randomUUID();ids.push(id);native.prepare('INSERT INTO conversations(id,token_hash,name,dob,language,preferences,mode,created,updated)VALUES(?,?,?,?,?,?,?,?,?)').run(id,randomUUID(),'Legacy '+i,'1990-01-01','en','{}','manual',0,0);native.prepare("INSERT INTO messages(conversation_id,role,kind,body,status,created)VALUES(?,'user','customer','before upgrade','pending',0)").run(id);native.prepare('INSERT INTO chat_messaging(conversation_id,pinned,archived,blocked,labels)VALUES(?,?,?,?,?)').run(id,i===0?1:0,i===1?1:0,i===2?1:0,'["Legacy"]');}
// Simulate one ALTER applied before an interrupted rollout.
native.exec('ALTER TABLE conversations ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0;');
const migration=readFileSync('cloudflare/migration-scale.sql','utf8').replace(/\r\n?/g,'\n'),first=await applyScaleMigration(restTransport,migration.replaceAll('\n','\r\n'));assert.equal(first.skipped,1);
const second=await applyScaleMigration(restTransport,migration.replaceAll('\n','\r'));assert.equal(second.skipped,10);assert.ok(transportedTriggers>0,'Complete triggers survive CRLF and lone-CR transport normalization.');
let cursor='',pages=0,processed=0;for(;;){const result=await backfillScaleCache(wrapper,{cursor,limit:17});assert.ok(result.processed<=17);processed+=result.processed;pages++;cursor=result.cursor;if(result.done)break;}assert.equal(processed,110);assert.equal(pages,7);
for(const id of ids){const row=native.prepare('SELECT * FROM conversations WHERE id=?').get(id),settings=native.prepare('SELECT * FROM chat_messaging WHERE conversation_id=?').get(id);assert.equal(row.waiting_count,1);assert.equal(row.inbox_pinned,settings.pinned);assert.equal(row.inbox_archived,settings.archived);assert.equal(row.inbox_blocked,settings.blocked);assert.ok(row.last_user_id>0);assert.equal(row.change_revision,0);}
const id=ids[0],saved=native.prepare("INSERT INTO messages(conversation_id,role,kind,body,status,created)VALUES(?,'user','customer','after upgrade','pending',1)RETURNING id").get(id).id;
assert.equal(native.prepare('SELECT changes()n').get().n,1,'Trigger writes preserve outer statement changes().');assert.equal(native.prepare('SELECT waiting_count n FROM conversations WHERE id=?').get(id).n,2);
await backfillScaleCache(wrapper,{limit:100});await backfillScaleCache(wrapper,{cursor:ids.toSorted().at(99),limit:100});assert.equal(native.prepare('SELECT waiting_count n FROM conversations WHERE id=?').get(id).n,2,'Backfill retries do not double count hot inserts.');
native.prepare("UPDATE messages SET status='answered' WHERE id=?").run(saved);assert.equal(native.prepare('SELECT waiting_count n FROM conversations WHERE id=?').get(id).n,1);
const firstMessage=native.prepare('SELECT id FROM messages WHERE conversation_id=? ORDER BY id LIMIT 1').get(id)?.id;
native.prepare('INSERT INTO message_messaging(message_id,reply_to)VALUES(?,?)').run(saved,firstMessage);
native.prepare("INSERT INTO message_stars(message_id,side)VALUES(?,'customer')").run(firstMessage);
native.prepare('INSERT INTO chat_attachments(id,conversation_id,title,type,object_key,mime,size,created)VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),id,'private','image','fixture/private','image/png',12,0);
native.prepare('DELETE FROM conversations WHERE id=?').run(id);assert.equal(native.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=?').get(id).n,0);assert.equal(native.prepare('SELECT COUNT(*) n FROM object_cleanup').get().n,1,'Cascaded private media deletion remains durably queued for R2 cleanup.');
assert.ok(splitSqlStatements(migration).some(sql=>sql.includes('CREATE TRIGGER')&&sql.includes('END;')));
console.log(JSON.stringify({crlfAndLoneCrTransport:true,partialAlterRetry:true,repeatMigration:true,boundedBackfillPages:pages,legacyProfiles:110,hotInsertSafe:true,triggerChangesPreserved:true,cascadeQuoteAndMediaCleanup:true,productionWrites:false}));
native.close();
