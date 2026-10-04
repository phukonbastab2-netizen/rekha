import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
import {appSettingsDefaults} from '../cloudflare/app-settings.mjs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const files=['cloudflare/rewards.mjs','cloudflare/messaging.mjs','cloudflare/calls.mjs','cloudflare/workflow.mjs','cloudflare/app-settings.mjs','cloudflare/owner.mjs','src/ai.mjs','cloudflare/kundli-followup.mjs','cloudflare/worker.mjs'];
const source=files.map(file=>readFileSync(file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export (async function|function|const)/g,'$1').replace('export default {','const testWorker={')).join('\n');
const instrument=`export default {async fetch(request,env,context){let queries=0,rowsRead=0;
  const add=result=>{rowsRead+=Number(result.meta?.rows_read)||0;return result;};
  function wrap(s){return{bind:(...args)=>wrap(s.bind(...args)),all:async()=>{queries++;return add(await s.all());},first:async(column)=>{queries++;const r=add(await s.all());return column?r.results[0]?.[column]??null:r.results[0]??null;},run:async()=>{queries++;return add(await s.run());},_base:s};}
  const db={prepare:sql=>wrap(env.DB.prepare(sql)),batch:async statements=>{queries+=statements.length;const r=await env.DB.batch(statements.map(s=>s._base));r.forEach(add);return r;}};
  const response=await handleApi(request,{...env,DB:db},context),out=new Response(response.body,response);out.headers.set('X-Test-Queries',queries);out.headers.set('X-Test-Rows-Read',rowsRead);return out;}};`;
const hash=text=>createHash('sha256').update(text).digest('hex'),id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:source+'\n'+instrument,compatibilityDate:'2026-09-24',d1Databases:{DB:'call-scale-test'},r2Buckets:{MEDIA:'call-scale-test'},bindings:{CUSTOMER_AUTOMATION_ENABLED:'true',ADMIN_PASSWORD_HASH:hash('local-call-scale-password')}}));
const db=await mf.getD1Database('DB');for(const sql of splitSqlStatements(readFileSync('cloudflare/schema.sql','utf8')))await db.prepare(sql).run();
for(const sql of splitSqlStatements(readFileSync('cloudflare/migration-calls-scale.sql','utf8')))await db.prepare(sql).run();
async function call(route,cookie='ar_admin=local-call-scale-owner',method='GET',data){const response=await mf.dispatchFetch('https://rekha.test'+route,{method,headers:{Cookie:cookie,Origin:'https://rekha.test',...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:response.status,data:await response.json(),queries:Number(response.headers.get('X-Test-Queries')),rowsRead:Number(response.headers.get('X-Test-Rows-Read'))};}
try{
  const now=Date.now();
  await db.prepare('INSERT INTO admin_sessions(token_hash,expires) VALUES(?,?)').bind(hash('local-call-scale-owner'),now+3600000).run();
  await db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<50) INSERT INTO conversations(id,token_hash,name,dob,language,preferences,mode,created,updated) SELECT printf('00000000-0000-4000-8000-%012d',x),'call-customer-'||x,'Call customer '||x,'1990-01-01','en','{}','manual',?,? FROM n").bind(now,now).run();
  await db.prepare('UPDATE conversations SET token_hash=? WHERE id=?').bind(hash('local-call-scale-customer'),id(50)).run();await db.prepare('UPDATE conversations SET token_hash=? WHERE id=?').bind(hash('local-call-scale-history-customer'),id(1)).run();
  await db.prepare("WITH RECURSIVE n(x) AS (SELECT 1001 UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO calls(id,conversation_id,caller,type,status,created,updated,expires) SELECT printf('00000000-0000-4000-8000-%012d',x),?,'customer','voice','ended',?,?,? FROM n").bind(id(1),now-10000,now-10000,now-10000).run();
  // Old interrupted end cleanup may leave signals in storage. Idle polling
  // must not scan them; authenticated ended-call reads still reveal none.
  await db.prepare("INSERT INTO call_signals(call_id,actor,kind,payload,created) VALUES(?,'customer','offer','{}',?)").bind(id(2000),now).run();
  await db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<45) INSERT INTO calls(id,conversation_id,caller,type,status,created,updated,expires) SELECT printf('00000000-0000-4000-8000-%012d',3000+x),printf('00000000-0000-4000-8000-%012d',x),'customer','voice','ringing',?,?,? FROM n").bind(now-100,now-100,now-1).run();
  await db.prepare("INSERT INTO call_signals(call_id,actor,kind,payload,created) SELECT id,'customer','offer','{}',? FROM calls WHERE status!='ended'").bind(now).run();
  const first=await call('/api/admin/calls');assert.equal(first.status,200);assert.deepEqual(first.data.calls,[]);assert.ok(first.queries<=6);assert.ok(first.rowsRead<500,JSON.stringify(first));assert.equal((await db.prepare("SELECT COUNT(*) n FROM calls WHERE status='ended' AND id>? AND id<?").bind(id(3000),id(4000)).first()).n,20);assert.equal((await db.prepare('SELECT COUNT(*) n FROM call_signals WHERE call_id=?').bind(id(2000)).first()).n,1);
  await call('/api/admin/calls');await call('/api/admin/calls');assert.equal((await db.prepare("SELECT COUNT(*) n FROM calls WHERE status!='ended'").first()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM call_signals').first()).n,1);
  const idle=await call('/api/admin/calls');assert.equal(idle.status,200);assert.ok(idle.queries<=4);assert.ok(idle.rowsRead<20,JSON.stringify(idle));
  const scopedIdle=await call('/api/calls','ar_session=local-call-scale-history-customer');assert.equal(scopedIdle.status,200);assert.deepEqual(scopedIdle.data.calls,[]);assert.ok(scopedIdle.rowsRead<20,JSON.stringify(scopedIdle));
  const historical=await call('/api/admin/calls/'+id(2000)+'/signals');assert.equal(historical.status,200);assert.deepEqual(historical.data.signals,[]);
  await call('/api/admin/calls/'+id(2000)+'/end',undefined,'POST',{reason:'completed'});assert.equal((await db.prepare('SELECT COUNT(*) n FROM call_signals WHERE call_id=?').bind(id(2000)).first()).n,0);

  // A customer's targeted cleanup cannot mutate another private customer's
  // call, even when that other expired ID is supplied deliberately.
  await db.prepare("INSERT INTO calls(id,conversation_id,caller,type,status,created,updated,expires) VALUES(?,?,'customer','voice','ringing',?,?,?)").bind(id(4001),id(1),now,now,now-1).run();
  const outsider=await call('/api/calls/'+id(4001)+'/signals','ar_session=local-call-scale-customer');assert.equal(outsider.status,404);assert.equal((await db.prepare('SELECT status FROM calls WHERE id=?').bind(id(4001)).first()).status,'ringing');
  const expired=await call('/api/admin/calls/'+id(4001)+'/signals');assert.equal(expired.data.call.status,'ended');assert.equal(expired.data.call.reason,'expired');assert.deepEqual(expired.data.signals,[]);
  await db.prepare('INSERT INTO chat_messaging(conversation_id,blocked) VALUES(?,1)').bind(id(2)).run();
  await db.prepare("INSERT INTO calls(id,conversation_id,caller,type,status,created,updated,expires) VALUES(?,?,'customer','voice','active',?,?,?)").bind(id(4002),id(2),now,now,now+3600000).run();
  const blocked=await call('/api/admin/calls/'+id(4002)+'/signals');assert.equal(blocked.data.call.status,'ended');assert.equal(blocked.data.call.reason,'blocked');
  const settings=structuredClone(appSettingsDefaults);settings.chat.videoCallsEnabled=false;
  await db.prepare('INSERT INTO app_settings(id,published,draft,revision,updated) VALUES(1,?,?,1,?)').bind(JSON.stringify(settings),JSON.stringify(settings),now).run();
  await db.prepare("INSERT INTO calls(id,conversation_id,caller,type,status,created,updated,expires) VALUES(?,?,'customer','video','ringing',?,?,?)").bind(id(4003),id(3),now,now,now+3600000).run();
  const disabled=await call('/api/admin/calls/'+id(4003)+'/signals');assert.equal(disabled.data.call.status,'ended');assert.equal(disabled.data.call.reason,'feature-disabled');
  console.log(JSON.stringify({checks:'bounded live-call cleanup and private ended-signal handling',endedHistory:1000,expiredBacklog:45,firstPollQueries:first.queries,firstPollRowsRead:first.rowsRead,idlePollQueries:idle.queries,idlePollRowsRead:idle.rowsRead,customerWithHistoryIdleRowsRead:scopedIdle.rowsRead}));
}finally{await mf.dispose();}
