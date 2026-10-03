import {splitSqlStatements} from './sql-statements.mjs';

// Accepts a normal D1 binding or an authenticated rollout wrapper implementing
// prepare(sql).bind(...values).all()/run(). No cloud credentials are handled here.
export async function applyScaleMigration(db,source){
  let applied=0,skipped=0;const columns=new Map();
  // D1's REST statement splitter can reject trigger bodies with CRLF. Keep the
  // prepared SQL transport identical across Windows checkouts and rollout retries.
  for(const sql of splitSqlStatements(source.replace(/\r\n?/g,'\n'))){
    const clean=sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g,''),alter=/^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\b/i.exec(clean);
    if(alter){const [,table,column]=alter;if(!columns.has(table)){const result=await db.prepare('PRAGMA table_info('+table+')').all();columns.set(table,new Set(result.results.map(row=>row.name)));}if(columns.get(table).has(column)){skipped++;continue;}await db.prepare(sql).run();columns.get(table).add(column);applied++;}
    else{await db.prepare(sql).run();applied++;}
  }
  return{applied,skipped};
}

// Resumable keyset pages bound the number of existing profiles written at once.
// Computation happens inside each UPDATE, so concurrent trigger updates cannot
// be overwritten by a stale JavaScript snapshot. Historical revisions stay zero.
export async function backfillScaleCache(db,{cursor='',limit=100}={}){
  if(typeof cursor!=='string'||cursor.length>80||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid backfill page.');
  const rows=(await db.prepare('SELECT id FROM conversations WHERE id>? ORDER BY id LIMIT ?').bind(cursor,limit).all()).results;
  const sql=`UPDATE conversations SET inbox_pinned=COALESCE((SELECT pinned FROM chat_messaging WHERE conversation_id=conversations.id),0),inbox_archived=COALESCE((SELECT archived FROM chat_messaging WHERE conversation_id=conversations.id),0),inbox_blocked=COALESCE((SELECT blocked FROM chat_messaging WHERE conversation_id=conversations.id),0),inbox_owner_read=COALESCE((SELECT owner_read FROM chat_messaging WHERE conversation_id=conversations.id),0),last_user_id=COALESCE((SELECT id FROM messages WHERE conversation_id=conversations.id AND role='user' ORDER BY id DESC LIMIT 1),0),last_message_id=COALESCE((SELECT id FROM messages WHERE conversation_id=conversations.id ORDER BY id DESC LIMIT 1),0),waiting_count=(SELECT COUNT(*) FROM messages WHERE conversation_id=conversations.id AND role='user' AND status IN ('pending','failed')) WHERE id=?`;
  // Sequential writes let callers stop between rows and remain below D1's batch
  // query ceiling even when this helper is used through the HTTP query API.
  for(const row of rows)await db.prepare(sql).bind(row.id).run();
  return{cursor:rows.at(-1)?.id||cursor,processed:rows.length,done:rows.length<limit};
}
