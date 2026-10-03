// Full private HTTP APIs with real local D1; no hosted account or customer data.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
const files=['cloudflare/rewards.mjs','cloudflare/messaging.mjs','cloudflare/calls.mjs','cloudflare/workflow.mjs','cloudflare/app-settings.mjs','cloudflare/owner.mjs','src/ai.mjs','cloudflare/worker.mjs'];
let script=files.map(file=>readFileSync(file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export (async function|function|const)/g,'$1')).join('\n').replace('export default {','const fixtureWorker={');
script+=`
const fixtureMetrics=[],fixtureRaces=new Map();
function fixtureRace(id){if(!fixtureRaces.has(id)){const state={misses:new Set()};state.readGate=new Promise(resolve=>state.releaseReads=resolve);state.winner=new Promise(resolve=>state.releaseWinner=resolve);fixtureRaces.set(id,state);}return fixtureRaces.get(id);}
export default {async fetch(request,env,ctx){
 if(new URL(request.url).pathname==='/__fixture/metrics')return Response.json(fixtureMetrics);
 const metrics={id:request.headers.get('X-Fixture-Id'),queries:0},tasks=[];
 const role=request.headers.get('X-Fixture-Race-Role'),raceKey=request.headers.get('X-Fixture-Race'),sqlByStatement=new WeakMap();
 const DB={prepare(sql){metrics.queries++;const original=env.DB.prepare(sql);return{bind(...args){
   const prepared=original.bind(...args);sqlByStatement.set(prepared,sql);
   if(role&&sql==='SELECT id FROM messages WHERE conversation_id=? AND client_id=?')return{async first(){const row=await prepared.first();if(!row){const state=fixtureRace(raceKey);state.misses.add(role);if(state.misses.size===2)state.releaseReads();await state.readGate;}return row;}};
   return prepared;
 }}},async batch(statements){
   const ownerBatch=role&&sqlByStatement.get(statements[0])?.startsWith('INSERT OR IGNORE INTO messages')&&sqlByStatement.get(statements[0]).includes("'assistant'");
   if(ownerBatch&&role==='B'){
     await fixtureRace(raceKey).winner;
     if(request.headers.get('X-Fixture-New-Draft')){
       const chat=request.headers.get('X-Fixture-Chat'),now=Date.now();
       await env.DB.batch([
         DB.prepare("INSERT INTO messages(conversation_id,role,kind,body,status,created)VALUES(?,'user','customer','New question after winning send','pending',?)").bind(chat,now),
         DB.prepare('UPDATE conversations SET version=version+1,updated=? WHERE id=?').bind(now,chat),
         DB.prepare("INSERT OR REPLACE INTO drafts(conversation_id,message_id,body,kind,version) SELECT ?,MAX(m.id),'Newer retained draft','demo',c.version FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.id=?").bind(chat,chat),
         DB.prepare('UPDATE chat_messaging SET owner_typing=? WHERE conversation_id=?').bind(now+8000,chat)
       ]);
     }
   }
   const result=await env.DB.batch(statements);if(ownerBatch&&role==='A')fixtureRace(raceKey).releaseWinner();return result;
 }};
 const response=await fixtureWorker.fetch(request,{...env,DB},{waitUntil(promise){tasks.push(promise);ctx.waitUntil(promise);}});
 ctx.waitUntil(Promise.allSettled(tasks).then(()=>fixtureMetrics.push(metrics)));return response;
}};`;
const password='local-owner-scale-fixture',origin='https://rekha.test',header={'X-Rekha-History':'bounded-v1'};
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-09-24',d1Databases:{DB:'owner-send-scale'},r2Buckets:{MEDIA:'owner-send-scale-media'},bindings:{CUSTOMER_AUTOMATION_ENABLED:'true',ADMIN_PASSWORD_HASH:createHash('sha256').update(password).digest('hex')}}));
try{
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('MEDIA'),stmt=(sql,...args)=>db.prepare(sql).bind(...args),one=(sql,...args)=>stmt(sql,...args).first();
 for(const sql of splitSqlStatements(readFileSync('cloudflare/schema.sql','utf8')))await db.prepare(sql).run();
 async function api(route,method='GET',data,cookie='',extraHeaders={}){
  const id=randomUUID(),response=await mf.dispatchFetch(origin+route,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,...header,'X-Fixture-Id':id,...extraHeaders},...(data===undefined?{}:{body:JSON.stringify(data)})}),result={status:response.status,data:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};let metrics;
  for(let i=0;i<80;i++){metrics=(await(await mf.dispatchFetch(origin+'/__fixture/metrics')).json()).find(row=>row.id===id);if(metrics)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(metrics,'Background query metric must settle.');assert.ok(metrics.queries<=50,JSON.stringify({route,queries:metrics.queries}));return{...result,queries:metrics.queries};
 }
 const signup=async name=>{const result=await api('/api/start','POST',{name,dob:'1990-01-01',language:'en',consent:true,preferences:{}});assert.equal(result.status,201);return result;};
 const first=await signup('Bulk media fixture'),other=await signup('Other private fixture'),login=await api('/api/admin/login','POST',{password}),admin=login.cookie,id=first.data.id,cookie=first.cookie;
 assert.equal(login.status,200);assert.equal((await api('/api/admin/conversations/'+id+'/mode','PATCH',{mode:'manual'},admin)).status,200);
 const png=readFileSync('public/icon-192.png'),library=[],attachments=[];
 for(let i=0;i<20;i++){const media=randomUUID(),key='library/'+media;library.push(media);await stmt('INSERT INTO media_items(id,title,type,object_key,mime,size,created)VALUES(?,?,?,?,?,?,?)',media,'Item '+i,'image',key,'image/png',png.length,Date.now()).run();await bucket.put(key,png);}
 for(let i=0;i<10;i++){const file=randomUUID(),key='chat-attachments/'+file;attachments.push(file);await stmt('INSERT INTO chat_attachments(id,conversation_id,title,type,object_key,mime,size,ready,created)VALUES(?,?,?,?,?,?,?,?,?)',file,id,'Private '+i,'image',key,'image/png',png.length,1,Date.now()).run();await bucket.put(key,png);}
 const current=async()=>{const response=await api('/api/admin/conversations/'+id,'GET',undefined,admin);assert.equal(response.status,200);return response.data;};
 const itemIds=[...library].reverse(),mediaIds=[...attachments].reverse(),clientId=randomUUID(),version=(await current()).version;
 const sent=await api('/api/admin/conversations/'+id+'/send','POST',{body:'Twenty shared images and ten private photos',version,clientId,itemIds,mediaIds},admin);
 assert.equal(sent.status,201,JSON.stringify(sent.data));const message=sent.data.messages.at(-1),items=JSON.parse(message.body).items;assert.deepEqual(items.map(item=>item.id),[...mediaIds,...itemIds],'Batch reads preserve the requested attachment and playlist order.');
 assert.equal((await one('SELECT COUNT(*) n FROM media_grants WHERE conversation_id=?',id)).n,20);
 const duplicate=await api('/api/admin/conversations/'+id+'/send','POST',{body:'Retry',version:-1,clientId,itemIds:[randomUUID()]},admin);assert.equal(duplicate.status,200);assert.equal((await one('SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND client_id=?',id,'owner:'+clientId)).n,1);
 assert.equal((await api('/api/admin/conversations/'+id+'/send','POST',{body:'Stale',version,clientId:randomUUID(),itemIds},admin)).status,409);
 assert.equal((await one('SELECT COUNT(*) n FROM media_grants WHERE conversation_id=?',other.data.id)).n,0);
 assert.equal((await mf.dispatchFetch(origin+'/api/media/'+itemIds[0],{headers:{Cookie:other.cookie}})).status,404);
 assert.equal((await mf.dispatchFetch(origin+'/api/media/'+itemIds[0],{headers:{Cookie:cookie}})).status,200);
 const raceId=randomUUID(),raceVersion=(await api('/api/admin/conversations/'+other.data.id,'GET',undefined,admin)).data.version;
 const raceResults=await Promise.all([api('/api/admin/conversations/'+other.data.id+'/send','POST',{body:'Concurrent payload A',version:raceVersion,clientId:raceId,itemIds:itemIds.slice(0,10)},admin,{'X-Fixture-Race':raceId,'X-Fixture-Race-Role':'A'}),api('/api/admin/conversations/'+other.data.id+'/send','POST',{body:'Concurrent payload B',version:raceVersion,clientId:raceId,itemIds:itemIds.slice(10)},admin,{'X-Fixture-Race':raceId,'X-Fixture-Race-Role':'B'})]);
 assert.ok(raceResults.every(result=>[200,201].includes(result.status)),JSON.stringify(raceResults));assert.equal(raceResults.filter(result=>result.status===201).length,1);
 const raceMessage=await one('SELECT body FROM messages WHERE conversation_id=? AND client_id=?',other.data.id,'owner:'+raceId),raceGrants=(await stmt('SELECT media_id FROM media_grants WHERE conversation_id=? ORDER BY media_id',other.data.id).all()).results;
 assert.deepEqual(raceGrants.map(row=>row.media_id),JSON.parse(raceMessage.body).items.map(item=>item.id).sort(),'A losing concurrent retry cannot grant media from its different payload.');
 const stateChat=await signup('Concurrent state fixture'),stateId=stateChat.data.id;
 assert.equal((await api('/api/admin/conversations/'+stateId+'/mode','PATCH',{mode:'assist'},admin)).status,200);
 const oldPending=(await stmt("INSERT INTO messages(conversation_id,role,kind,body,status,created)VALUES(?,'user','customer','Original unanswered question','pending',?) RETURNING id",stateId,Date.now()).first()).id;
 await stmt('UPDATE conversations SET version=version+1 WHERE id=?',stateId).run();
 await stmt("INSERT INTO drafts(conversation_id,message_id,body,kind,version) SELECT ?,?,'Original draft','demo',version FROM conversations WHERE id=?",stateId,oldPending,stateId).run();
 const stateVersion=(await api('/api/admin/conversations/'+stateId,'GET',undefined,admin)).data.version,stateClient=randomUUID(),sameBody={body:'Same committed media payload',version:stateVersion,clientId:stateClient,itemIds:itemIds.slice(0,10)};
 const stateResults=await Promise.all([
  api('/api/admin/conversations/'+stateId+'/send','POST',{...sameBody,answersPending:false},admin,{'X-Fixture-Race':stateClient,'X-Fixture-Race-Role':'A'}),
  api('/api/admin/conversations/'+stateId+'/send','POST',{...sameBody,answersPending:true,replyTo:oldPending},admin,{'X-Fixture-Race':stateClient,'X-Fixture-Race-Role':'B','X-Fixture-New-Draft':'yes','X-Fixture-Chat':stateId})
 ]);
 assert.ok(stateResults.every(result=>[200,201].includes(result.status)),JSON.stringify(stateResults));assert.equal(stateResults.filter(result=>result.status===201).length,1);
 assert.equal((await one('SELECT status FROM messages WHERE id=?',oldPending)).status,'pending','A loser cannot mark the winner’s unanswered question answered.');
 const retainedDraft=await one('SELECT * FROM drafts WHERE conversation_id=?',stateId),stateAfter=await one('SELECT version,free_used FROM conversations WHERE id=?',stateId),lastUser=await one("SELECT id,status FROM messages WHERE conversation_id=? AND role='user' ORDER BY id DESC LIMIT 1",stateId);
 assert.equal(retainedDraft.body,'Newer retained draft');assert.equal(retainedDraft.message_id,lastUser.id);assert.equal(retainedDraft.version,stateAfter.version);assert.equal(lastUser.status,'pending');assert.equal(stateAfter.version,stateVersion+2);assert.equal(stateAfter.free_used,0);
 assert.ok((await one('SELECT owner_typing FROM chat_messaging WHERE conversation_id=?',stateId)).owner_typing>Date.now(),'A losing stale send cannot clear a newer typing state.');
 assert.equal((await one('SELECT d.reply_to FROM message_messaging d JOIN messages m ON m.id=d.message_id WHERE m.conversation_id=? AND m.client_id=?',stateId,'owner:'+stateClient)).reply_to,null,'The first persisted quote is retained.');
 const customerClient=randomUUID(),customerSent=await api('/api/messages','POST',{body:'Ten customer photos',clientId:customerClient,mediaIds},cookie);assert.equal(customerSent.status,202,JSON.stringify(customerSent.data));assert.deepEqual(JSON.parse(customerSent.data.acknowledgedMessage.body).items.map(item=>item.id),mediaIds);
 assert.equal((await api('/api/messages','POST',{body:'Foreign private photo',clientId:randomUUID(),mediaIds:[mediaIds[0]]},other.cookie)).status,404);
 assert.equal((await api('/api/messages','POST',{body:'Duplicate photo',clientId:randomUUID(),mediaIds:[mediaIds[0],mediaIds[0]]},cookie)).status,400);
 assert.equal((await api('/api/messages','POST',{body:'Too many',clientId:randomUUID(),mediaIds:[...mediaIds,randomUUID()]},cookie)).status,400);
 const badOwner=await api('/api/admin/conversations/'+id+'/send','POST',{body:'Duplicates',version:(await current()).version,clientId:randomUUID(),itemIds:[itemIds[0],itemIds[0]]},admin);assert.equal(badOwner.status,400);
 const collection=randomUUID();await stmt('INSERT INTO media_collections(id,title,item_ids,created)VALUES(?,?,?,?)',collection,'Ordered playlist',JSON.stringify(itemIds),Date.now()).run();
 const collectionSent=await api('/api/admin/conversations/'+id+'/send','POST',{body:'Playlist',version:(await current()).version,clientId:randomUUID(),collectionId:collection},admin);assert.equal(collectionSent.status,201);assert.deepEqual(JSON.parse(collectionSent.data.messages.at(-1).body).items.map(item=>item.id),itemIds);
 await stmt('UPDATE media_items SET archived=1 WHERE id=?',itemIds[0]).run();assert.equal((await api('/api/admin/conversations/'+id+'/send','POST',{body:'Archived',version:(await current()).version,clientId:randomUUID(),itemIds},admin)).status,409);
 assert.equal((await one('SELECT COUNT(*) n FROM media_grants WHERE conversation_id=?',id)).n,20,'Failed or duplicate sends do not expand grants.');
 // Long UTF-8 prefixes must avoid D1's50-byte LIKE pattern ceiling. Percent and
 // underscores remain literal name characters, with no wildcard expansion.
 const hindi='शिवशक्ति ज्योतिष मार्गदर्शन परीक्षण',ascii='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz12345678',literal='Customer%_literal';
 const hindiChat=await signup(hindi),asciiChat=await signup(ascii),literalChat=await signup(literal);
 for(const [prefix,chat]of [[hindi,hindiChat],[ascii,asciiChat],[literal,literalChat]]){const search=await api('/api/admin/conversations?q='+encodeURIComponent(prefix)+'&filter=all','GET',undefined,admin);assert.equal(search.status,200,JSON.stringify(search.data));assert.deepEqual(search.data.items.map(item=>item.id),[chat.data.id]);}
 assert.ok(Buffer.byteLength(hindi)>50);assert.ok(ascii.length>50);
 console.log(JSON.stringify({owner20ItemsAnd10AttachmentsQueries:sent.queries,customer10AttachmentsQueries:customerSent.queries,orderedPlaylist:true,privateAttachmentScope:true,atomicGrants:true,concurrentDifferentPayloadGrantsProtected:true,concurrentAnswerDraftTypingQuoteProtected:true,clientIdRetryDedup:true,casGuard:true,duplicateAndArchivedValidation:true,longUnicodeAndLiteralPrefix:true,productionWrites:false}));
}finally{await mf.dispose();}
