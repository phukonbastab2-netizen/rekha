// Exercises the full scheduled handler and real D1 statements, entirely local.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
import {workflowDefaults} from '../cloudflare/workflow.mjs';
const files=['cloudflare/rewards.mjs','cloudflare/messaging.mjs','cloudflare/calls.mjs','cloudflare/workflow.mjs','cloudflare/app-settings.mjs','cloudflare/owner.mjs','src/ai.mjs','cloudflare/kundli-followup.mjs','cloudflare/worker.mjs'];
let script=files.map(file=>readFileSync(file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export (async function|function|const)/g,'$1')).join('\n');
script=script.replace('export default {','const fixtureWorker={');
script+=`
const fixtureCounts=[];
export default {
 async fetch(request,env,ctx){if(new URL(request.url).pathname==='/__fixture/counts')return Response.json(fixtureCounts);return fixtureWorker.fetch(request,env,ctx);},
 async scheduled(controller,env,ctx){
   const metrics={cron:controller.cron,queries:0,r2Deletes:0};
   const DB={prepare(sql){metrics.queries++;return env.DB.prepare(sql);},batch(values){return env.DB.batch(values);}};
   const MEDIA={delete(key){metrics.r2Deletes++;return env.MEDIA.delete(key);},get(...args){return env.MEDIA.get(...args);}};
   await fixtureWorker.scheduled(controller,{...env,DB,MEDIA},ctx);fixtureCounts.push(metrics);
 }
};`;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-09-24',d1Databases:{DB:'cron-query-budget'},r2Buckets:{MEDIA:'cron-query-budget-media'},bindings:{CUSTOMER_AUTOMATION_ENABLED:'true',ADMIN_PASSWORD_HASH:createHash('sha256').update('local-budget-fixture').digest('hex')}}));
const counts=[];
try{
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('MEDIA'),worker=await mf.getWorker(),now=Date.now(),old=now-100*86400000;
 const stmt=(sql,...args)=>db.prepare(sql).bind(...args),one=(sql,...args)=>stmt(sql,...args).first();
 for(const sql of splitSqlStatements(readFileSync('cloudflare/schema.sql','utf8')))await db.prepare(sql).run();
 const asset=randomUUID();await stmt('INSERT INTO media_items(id,title,type,object_key,mime,size,created)VALUES(?,?,?,?,?,?,?)',asset,'local media','video','library/local','video/mp4',1,now).run();await bucket.put('library/local','x');
 const config={...structuredClone(workflowDefaults),enabled:true,assets:{...workflowDefaults.assets,firstVideo:asset},timings:{firstDelayMs:3600000,itemGapMs:3600000,reminderDelayMs:3600000,mediaDelayMs:3600000}};
 await stmt("INSERT OR REPLACE INTO workflow_settings(key,value)VALUES('config',?)",JSON.stringify(config)).run();
 async function profile({guided=false,created=now}={}){const id=randomUUID();await stmt('INSERT INTO conversations(id,token_hash,name,dob,language,preferences,created,updated)VALUES(?,?,?,?,?,?,?,?)',id,randomUUID(),'Budget fixture','1990-01-01','en','{}',created,created).run();if(guided)await stmt('INSERT INTO chat_workflow(conversation_id,config,started_at,updated)VALUES(?,?,?,?)',id,JSON.stringify(config),created,created).run();return id;}
 const queued=[];for(let i=0;i<4;i++){const id=await profile({guided:true});queued.push(id);await stmt("INSERT INTO messages(conversation_id,role,kind,body,status,created)VALUES(?,'user','media','local queued media','pending',?)",id,now).run();}
 const plain=await profile();await stmt("INSERT INTO messages(conversation_id,role,kind,body,status,created)VALUES(?,'user','customer','Please guide me','pending',?)",plain,now).run();
 const dueIds=[];for(let i=0;i<3;i++){const id=await profile({guided:true});dueIds.push(id);await stmt("UPDATE chat_workflow SET stage='FIRST_SEQUENCE' WHERE conversation_id=?",id).run();await stmt('INSERT INTO workflow_jobs(id,conversation_id,generation,kind,due,payload,created,updated)VALUES(?,?,?,?,?,?,?,?)',randomUUID(),id,1,'first',now-100,JSON.stringify({steps:[{text:'Private sequence video',asset:'firstVideo'}],assets:config.assets,timings:config.timings}),now,now).run();}
 const expired=[];for(let i=0;i<150;i++){const id=await profile({created:old}),key='expired/'+i;expired.push(id);await stmt('INSERT INTO chat_attachments(id,conversation_id,title,type,object_key,mime,size,created)VALUES(?,?,?,?,?,?,?,?)',randomUUID(),id,'private expired','image',key,'image/png',1,old).run();await bucket.put(key,'x');}
 async function dispatch(cron){const result=await worker.scheduled({cron,scheduledTime:new Date()});assert.equal(result.outcome,'ok');const response=await mf.dispatchFetch('https://rekha.test/__fixture/counts');const all=await response.json(),latest=all.at(-1);assert.ok(latest.queries<=50,JSON.stringify(latest));assert.ok(latest.r2Deletes<=20,JSON.stringify(latest));counts.push(latest);}
 await dispatch('17 2 * * *');assert.ok(await one("SELECT value FROM workflow_settings WHERE key='retention-before'"),'Daily marker survives a busy tick.');
 let repliedDuringSweep=false;
 for(let i=0;i<8;i++){await dispatch('* * * * *');if((await one("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND role='assistant'",plain)).n&&(await one('SELECT COUNT(*) n FROM conversations WHERE updated<?',now-90*86400000)).n)repliedDuringSweep=true;}
 assert.ok(repliedDuringSweep,'AI recovery must run while a large retention sweep is still active.');
 assert.equal((await one('SELECT COUNT(*) n FROM conversations WHERE updated<?',now-90*86400000)).n,0,'Minute ticks finish the retained profile sweep.');
 assert.equal((await one('SELECT COUNT(*) n FROM object_cleanup')).n,0,'R2 cleanup is resumable and drains in bounded batches.');
 for(const id of dueIds)assert.equal((await one("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND role='assistant'",id)).n,1,'Due media work survives the shared budget.');
 assert.equal((await one("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND role='assistant'",plain)).n,1,'Deferred AI work resumes after sweep/recovery pressure.');
 assert.equal((await one('SELECT COUNT(*) n FROM workflow_recovery')).n,0,'Interrupted recovery remains durable and eventually runs.');
 assert.ok(await bucket.head('library/local'),'Owner library is preserved.');
 assert.equal(await bucket.head('expired/0'),null);
 // Auxiliary cleanup must also finish when there are no expired profiles. The
 // old all-profile marker check used to strand rows beyond the100-row page.
 for(let i=0;i<225;i++)await stmt('INSERT INTO calls(id,conversation_id,caller,type,status,created,updated,expires)VALUES(?,?,?,?,?,?,?,?)',randomUUID(),plain,'customer','audio','ended',old,old,old).run();
 await dispatch('17 2 * * *');assert.equal((await one('SELECT COUNT(*) n FROM calls WHERE created<?',old+1)).n,125);assert.ok(await one("SELECT value FROM workflow_settings WHERE key='retention-before'"));
 await dispatch('* * * * *');assert.equal((await one('SELECT COUNT(*) n FROM calls WHERE created<?',old+1)).n,25);assert.ok(await one("SELECT value FROM workflow_settings WHERE key='retention-before'"));
 await dispatch('* * * * *');assert.equal((await one('SELECT COUNT(*) n FROM calls WHERE created<?',old+1)).n,0);assert.equal(await one("SELECT value FROM workflow_settings WHERE key='retention-before'"),null);
 console.log(JSON.stringify({actualScheduledHandler:true,mixedQueuedMediaRepliesRetention:true,expiredProfiles:150,expiredCallsWithoutExpiredProfiles:225,auxiliaryCleanupMarkerResumes:true,aiRepliedDuringActiveSweep:repliedDuringSweep,maxD1Queries:Math.max(...counts.map(row=>row.queries)),cronTicks:counts.length,maxR2Deletes:Math.max(...counts.map(row=>row.r2Deletes)),durableAllWorkCompleted:true,productionWrites:false}));
}finally{await mf.dispose();}
