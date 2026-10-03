// LOCAL ONLY. This creates an ephemeral Miniflare D1 database. It does not use
// Wrangler credentials, deployment configuration, production URLs or cloud APIs.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
import {workflowScaleQueries,workflowDefaults} from '../cloudflare/workflow.mjs';
import {messagingInboxQuery} from '../cloudflare/messaging.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
const profiles=Number(args.profiles||100000),baseMessages=profiles*5,longMessages=4995;
if(!Number.isSafeInteger(profiles)||profiles<1000||profiles>100000)throw Error('Choose --profiles=1000..100000; no remote target is accepted.');
const output=path.resolve(root,args.output||'build/capacity-report.json'),now=Date.now(),id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),hash=text=>createHash('sha256').update(text).digest('hex');
const modules=['src/ai.mjs','cloudflare/messaging.mjs','cloudflare/calls.mjs','cloudflare/workflow.mjs','cloudflare/app-settings.mjs','cloudflare/owner.mjs','cloudflare/rewards.mjs','cloudflare/worker.mjs'];
const source=modules.map(file=>readFileSync(path.join(root,file),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export (async function|function|const)/g,'$1').replace('export default {','const capacityWorker={')).join('\n');
const instrumentation=`
export default {async fetch(request,env,context){let reads=0,writes=0,tasks=0;
const add=r=>{reads+=Number(r?.meta?.rows_read)||0;writes+=Number(r?.meta?.rows_written)||0;return r;};
function wrap(s){return {bind:(...a)=>wrap(s.bind(...a)),all:async()=>add(await s.all()),run:async()=>add(await s.run()),first:async(column)=>{const r=add(await s.all());return column?(r.results[0]?.[column]??null):(r.results[0]??null);},raw:(...a)=>s.raw(...a),_base:s};}
const db={prepare:sql=>wrap(env.DB.prepare(sql)),batch:async statements=>{const results=await env.DB.batch(statements.map(s=>s._base));results.forEach(add);return results;}};
const response=await handleApi(request,{...env,DB:db},{waitUntil:p=>{tasks++;context.waitUntil(p);}}),out=new Response(response.body,response);out.headers.set('X-Capacity-Rows-Read',String(reads));out.headers.set('X-Capacity-Rows-Written',String(writes));out.headers.set('X-Capacity-Background-Tasks',String(tasks));return out;}};`;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:source+'\n'+instrumentation,compatibilityDate:'2026-09-24',d1Databases:{DB:'local-capacity-fixture'},r2Buckets:{MEDIA:'local-capacity-media'},bindings:{ADMIN_PASSWORD_HASH:hash('local-owner-fixture')}}));
const db=await mf.getD1Database('DB'),stmt=(sql,...bindings)=>db.prepare(sql).bind(...bindings);
const report={generatedAt:new Date().toISOString(),scope:'Ephemeral local data-volume and bounded-request benchmark; not a production or 100,000-concurrent-user load test.',sourceHashes:Object.fromEntries(modules.map(file=>[file,hash(readFileSync(path.join(root,file),'utf8'))])),runtime:{node:process.version,platform:process.platform,cpus:os.cpus().length,cpu:os.cpus()[0]?.model,totalRamBytes:os.totalmem()},fixture:{profiles,baseMessages,longMessages},seed:{rowsRead:0,rowsWritten:0},queries:[],requests:[],bursts:[]};
async function seed(sql,...bindings){const r=await stmt(sql,...bindings).run();report.seed.rowsRead+=Number(r.meta?.rows_read)||0;report.seed.rowsWritten+=Number(r.meta?.rows_written)||0;report.seed.lastSizeBytes=r.meta?.size_after;return r;}
async function query(label,sql,bindings=[],{mutates=false}={}){const plan=(await stmt('EXPLAIN QUERY PLAN '+sql,...bindings).all()).results.map(r=>r.detail);const started=performance.now(),r=await stmt(sql,...bindings)[mutates?'run':'all']();const entry={label,sql,bindings,plan,ms:performance.now()-started,rowsRead:r.meta?.rows_read,rowsWritten:r.meta?.rows_written,databaseBytes:r.meta?.size_after,resultCount:r.results?.length??0};report.queries.push(entry);return r;}
async function request(label,url='/api/chat',cookie='ar_session=capacity-client-1'){const started=performance.now(),r=await mf.dispatchFetch('http://localhost'+url,{headers:{Cookie:cookie,'X-Rekha-History':'bounded-v1'}}),data=await r.json(),entry={label,status:r.status,ms:performance.now()-started,rowsRead:Number(r.headers.get('X-Capacity-Rows-Read')),rowsWritten:Number(r.headers.get('X-Capacity-Rows-Written')),backgroundTasks:Number(r.headers.get('X-Capacity-Background-Tasks')),messages:data.messages?.length,items:data.items?.length,bytes:Buffer.byteLength(JSON.stringify(data))};report.requests.push(entry);assert.equal(r.status,200,JSON.stringify(data));return {data,entry};}
try{
  for(const file of ['schema.sql','migration-workflow-scale.sql','migration-calls-scale.sql'])for(const sql of splitSqlStatements(readFileSync(path.join(root,'cloudflare',file),'utf8')))await db.prepare(sql).run();
  const started=performance.now();console.log(JSON.stringify({stage:'seed-start',profiles,messages:baseMessages+longMessages}));
  for(let offset=0;offset<profiles;offset+=2000){const count=Math.min(2000,profiles-offset);await seed(`WITH RECURSIVE n(x) AS (SELECT ? UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO conversations(id,token_hash,name,dob,language,preferences,mode,created,updated) SELECT printf('00000000-0000-4000-8000-%012d',x),'synthetic-token-'||x,printf('Customer %06d',x),'1990-01-01','en','{}','manual',?,?+x FROM n`,offset+1,offset+count,now,now);}
  console.log(JSON.stringify({stage:'profiles-ready',seconds:(performance.now()-started)/1000}));
  for(let offset=0;offset<baseMessages;offset+=10000){const count=Math.min(10000,baseMessages-offset);await seed(`WITH RECURSIVE n(x) AS (SELECT ? UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO messages(conversation_id,role,kind,body,status,created) SELECT printf('00000000-0000-4000-8000-%012d',CAST((x-1)/5 AS INTEGER)+1),CASE WHEN x%2=0 THEN 'assistant' ELSE 'user' END,'customer','Capacity fixture message '||x,'answered',?+x FROM n`,offset+1,offset+count,now);if(offset%100000===0)console.log(JSON.stringify({stage:'messages-seeding',inserted:offset+count,seconds:(performance.now()-started)/1000}));}
  await seed(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO messages(conversation_id,role,kind,body,status,created) SELECT ?,CASE WHEN x%2=0 THEN 'assistant' ELSE 'user' END,'customer','Long chat fixture '||x,'answered',?+x FROM n`,longMessages,id(1),now+baseMessages);
  await db.batch(Array.from({length:100},(_,i)=>stmt('UPDATE conversations SET token_hash=? WHERE id=?',hash('capacity-client-'+(i+1)),id(i+1))));await seed('INSERT INTO admin_sessions(token_hash,expires) VALUES(?,?)',hash('capacity-owner'),now+86400000);
  const [profileCount,messageCount]=await Promise.all([stmt('SELECT COUNT(*) n FROM conversations').first(),stmt('SELECT COUNT(*) n FROM messages').first()]);report.seed.ms=performance.now()-started;report.initialSeed={...report.seed};report.fixture.actualProfiles=profileCount.n;report.fixture.actualMessages=messageCount.n;report.fixture.databaseBytes=report.seed.lastSizeBytes;assert.equal(profileCount.n,profiles);assert.equal(messageCount.n,baseMessages+longMessages);
  console.log(JSON.stringify({stage:'seed-ready',seconds:report.seed.ms/1000,databaseBytes:report.fixture.databaseBytes}));
  // Measure actual authenticated Worker APIs. Each result includes every D1
  // statement executed before its HTTP response, through a local-only adapter.
  const first=await request('customer latest80');assert.equal(first.data.messages.length,80);const history=first.data.history??{};
  const beforeId=first.data.messages[0].id;await request('customer older80','/api/chat?beforeId='+beforeId);
  const revision=first.data.changeRevision??first.data.historyRevision??history.revision??first.data.revision;
  if(Number.isSafeInteger(revision))await request('customer unchanged delta','/api/chat?afterRevision='+revision);
  const owner='ar_admin=capacity-owner';const inbox=await request('owner first50','/api/admin/conversations?limit=50',owner);assert.equal(inbox.data.items.length,50);if(inbox.data.nextCursor)await request('owner next50','/api/admin/conversations?limit=50&cursor='+encodeURIComponent(inbox.data.nextCursor),owner);
  await request('owner broad prefix','/api/admin/conversations?limit=50&q=Customer',owner);await request('owner no match prefix','/api/admin/conversations?limit=50&q=Absent',owner);await request('owner broad prefix waiting no matches','/api/admin/conversations?limit=50&q=Customer&filter=waiting',owner);await request('owner unique prefix','/api/admin/conversations?limit=50&q=Customer%20'+String(profiles).padStart(6,'0'),owner);
  await seed("INSERT INTO calls(id,conversation_id,caller,type,status,created,updated,expires) SELECT 'call-history-'||id,id,'customer','voice','ended',?,?,? FROM conversations",now,now,now);
  await seed("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5000) INSERT INTO calls(id,conversation_id,caller,type,status,created,updated,expires) SELECT 'call-long-history-'||x,?,'customer','voice','ended',?,?,? FROM n",id(1),now,now,now);report.fixture.endedCallHistory=profiles+5000;
  await request('customer calls with ended history','/api/calls');await request('owner calls with ended history','/api/admin/calls',owner);
  await query('calls idle owner excludes ended history',"SELECT id FROM calls INDEXED BY calls_active_expiry WHERE status!='ended' ORDER BY expires,id LIMIT 20");
  for(const [label,options]of [['owner inbox plan',{limit:50}],['owner broad prefix plan',{limit:50,q:'Customer'}],['owner no match plan',{limit:50,q:'Absent'}],['owner broad waiting plan',{limit:50,q:'Customer',filter:'waiting'}]]){const q=messagingInboxQuery(options);await query(label,q.sql,q.args);}
  await query('customer latest80 plan','SELECT id,body FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 81',[id(1)]);await query('customer unchanged delta plan','SELECT id,body FROM messages WHERE conversation_id=? AND change_revision>? AND change_revision<=? ORDER BY change_revision,id LIMIT 201',[id(1),first.data.changeRevision||5000,first.data.changeRevision||5000]);
  await query('legacy recovery bounded200',workflowScaleQueries.historical,[0,baseMessages,200]);await query('workflow empty FIFO20',workflowScaleQueries.recovery,[20]);await query('workflow empty due20',workflowScaleQueries.duePending,[now,20]);
  for(const concurrency of [25,50,100]){const times=[],entries=[],begin=performance.now();await Promise.all(Array.from({length:concurrency},async(_,i)=>{const r=await request('burst '+concurrency+' client '+(i+1),'/api/chat?afterRevision='+(i===0?5000:5),'ar_session=capacity-client-'+(i+1));times.push(r.entry.ms);entries.push(r.entry);}));times.sort((a,b)=>a-b);report.bursts.push({concurrency,requests:entries.length,elapsedMs:performance.now()-begin,p50Ms:times[Math.floor((times.length-1)*.5)],p95Ms:times[Math.floor((times.length-1)*.95)],maxMs:times.at(-1),rowsRead:entries.reduce((n,e)=>n+e.rowsRead,0),rowsWritten:entries.reduce((n,e)=>n+e.rowsWritten,0),backgroundTasks:entries.reduce((n,e)=>n+e.backgroundTasks,0)});console.log(JSON.stringify({stage:'local-burst',...report.bursts.at(-1)}));}
  // One durable workflow event per profile exercises the child foreign-key
  // index during retention instead of hiding a scan behind an empty table.
  await seed("INSERT INTO workflow_events(conversation_id,generation,message_id,created) SELECT conversation_id,1,id,created FROM messages WHERE role='user' AND id<=? AND id%5 IN (1,2)",baseMessages);report.fixture.workflowEventHistory=profiles;
  await seed('UPDATE conversations SET mode=\'ai\' WHERE CAST(substr(id,-12) AS INTEGER)<=1000');
  await seed("INSERT INTO chat_workflow(conversation_id,status,stage,config,started_at,updated) SELECT id,CASE WHEN CAST(substr(id,-12) AS INTEGER)%2=0 THEN 'paused' ELSE 'armed' END,'NEW',?,0,? FROM conversations WHERE CAST(substr(id,-12) AS INTEGER)<=1000",JSON.stringify(workflowDefaults),now);
  await seed("INSERT INTO workflow_jobs(id,conversation_id,generation,kind,status,due,payload,created,updated) SELECT 'capacity-job-'||id,id,1,'first','pending',?, '{}',?,? FROM conversations WHERE CAST(substr(id,-12) AS INTEGER)<=1000",now,now,now);
  await seed("INSERT INTO messages(conversation_id,role,kind,body,status,created) SELECT id,'user','customer','Recovery fixture','pending',? FROM conversations WHERE CAST(substr(id,-12) AS INTEGER)<=1000",now);
  await seed("WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<2001) INSERT INTO workflow_jobs(id,conversation_id,generation,kind,status,due,payload,created,updated) SELECT 'old-workflow-job-'||x,?,x,'first','cancelled',?,'{}',?,? FROM n",id(2),now,now,now);
  await query('workflow populated FIFO20',workflowScaleQueries.recovery,[20]);await query('workflow populated scoped FIFO20',workflowScaleQueries.recoveryChat,[id(1),20]);await query('workflow populated due20 behind500 held',workflowScaleQueries.duePending,[now,20]);
  await query('workflow idle guard with2000 cancelled jobs',"SELECT 1 FROM workflow_jobs WHERE conversation_id=? AND status='pending' AND due<=? UNION ALL SELECT 1 FROM workflow_jobs WHERE conversation_id=? AND status='processing' AND lease_until<=? LIMIT 1",[id(2),now,id(2),now]);
  await query('workflow queued inbound write',"INSERT INTO messages(conversation_id,role,kind,body,status,created) VALUES(?,'user','customer','One new enrolled inbound','pending',?)",[id(1),now],{mutates:true});
  // A pending population mixes guided, completed assist drafts, manual and
  // blocked chats. Cron must visit at most its fixed candidate window.
  await seed("UPDATE conversations SET mode='ai',entitlement='preview' WHERE CAST(substr(id,-12) AS INTEGER)>100");
  await seed("UPDATE messages SET status='pending' WHERE role='user' AND id<=?",baseMessages);
  await seed("INSERT OR IGNORE INTO chat_workflow(conversation_id,status,stage,config,started_at,updated) SELECT id,'armed','NEW',?,?,? FROM conversations WHERE CAST(substr(id,-12) AS INTEGER)>100 AND CAST(substr(id,-12) AS INTEGER)%4=0",JSON.stringify(workflowDefaults),now,now);
  await seed("UPDATE conversations SET mode='assist' WHERE CAST(substr(id,-12) AS INTEGER)>100 AND CAST(substr(id,-12) AS INTEGER)%4=1");
  await seed("INSERT INTO drafts(conversation_id,message_id,body,kind,version) SELECT c.id,(SELECT MAX(id) FROM messages WHERE conversation_id=c.id AND role='user' AND status='pending'),'Ready draft','demo',c.version FROM conversations c WHERE c.mode='assist'");
  await seed("UPDATE conversations SET mode='manual' WHERE CAST(substr(id,-12) AS INTEGER)>100 AND CAST(substr(id,-12) AS INTEGER)%4=2");
  await seed("INSERT INTO chat_messaging(conversation_id,blocked) SELECT id,1 FROM conversations WHERE CAST(substr(id,-12) AS INTEGER)>100 AND CAST(substr(id,-12) AS INTEGER)%4=3");
  await seed('DELETE FROM workflow_recovery WHERE conversation_id IN (?,?,?,?)',id(102),id(103),id(104),id(105));
  for(const [n,label]of [[102,'manual pending customer poll'],[103,'blocked pending customer poll'],[104,'paused guided customer poll'],[105,'completed assist draft customer poll']]){await seed('UPDATE conversations SET token_hash=? WHERE id=?',hash('capacity-client-'+n),id(n));await request(label,'/api/chat','ar_session=capacity-client-'+n);}
  const lateEligible=Math.min(profiles-2,1802);await seed("UPDATE conversations SET mode='ai',entitlement='preview' WHERE id=?",id(lateEligible));await seed('DELETE FROM chat_workflow WHERE conversation_id=?',id(lateEligible));await seed('DELETE FROM drafts WHERE conversation_id=?',id(lateEligible));await seed('DELETE FROM chat_messaging WHERE conversation_id=?',id(lateEligible));
  const workerExports=await import('../cloudflare/worker.mjs');
  if(workerExports.replyCandidateSql){let scanCursor={updated:0,id:''};const sql=workerExports.replyCandidateSql;report.cronWindows=[];for(let page=0;page<6;page++){const r=await query('cron fair window200 page'+page,sql,[scanCursor.updated,scanCursor.id,5,now]);report.cronWindows.push({page,visited:r.results.length,eligible:r.results.filter(c=>c.eligible).length,reachedLateEligible:r.results.some(c=>c.id===id(lateEligible)&&c.eligible)});const last=r.results?.at(-1);if(last)scanCursor={updated:last.updated,id:last.id};}assert.ok(report.cronWindows.some(p=>p.reachedLateEligible),'Fair candidate cursor must reach the eligible fixture after skipped guided/drafted chats');report.cronScanAvailable=true;}else report.cronScanAvailable=false;
  // Retention selects a bounded expired page, then performs indexed cascades.
  if(workerExports.retentionSql){await query('retention bounded chats25',workerExports.retentionSql,[now-1]);report.retentionAvailable=true;}else report.retentionAvailable=false;
  await seed('UPDATE conversations SET updated=? WHERE id IN (SELECT id FROM conversations ORDER BY id LIMIT 100)',now-100*86400000);
  await query('retention select100','SELECT id FROM conversations WHERE updated<? ORDER BY updated,id LIMIT 100',[now-90*86400000]);
  await query('retention cascade100',"DELETE FROM conversations WHERE id IN (SELECT id FROM conversations WHERE updated<? ORDER BY updated,id LIMIT 100)",[now-90*86400000],{mutates:true});
  report.fixture.finalDatabaseBytes=report.queries.at(-1).databaseBytes;
  mkdirSync(path.dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({stage:'complete',output,profiles:report.fixture.actualProfiles,messages:report.fixture.actualMessages,queries:report.queries.length,requests:report.requests.length}));
}finally{await mf.dispose();}
