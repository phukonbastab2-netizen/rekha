// Local D1/R2 integration: no cloud account, credentials, provider or customer data.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const files=['cloudflare/rewards.mjs','cloudflare/messaging.mjs','cloudflare/calls.mjs','cloudflare/workflow.mjs','cloudflare/app-settings.mjs','cloudflare/owner.mjs','src/ai.mjs','cloudflare/worker.mjs'];
let script=files.map(file=>fs.readFileSync(file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export (async function|function|const)/g,'$1')).join('\n');
const providerCall="const reply=await generateReply({aiMode:'demo'},chat,history);";
assert.ok(script.includes(providerCall),'Fixture instruments the actual production reply call.');
script=script.replace(providerCall,`
  const fixtureControl=await one('SELECT delay_ms,fail FROM fixture_reply_control WHERE id=1');
  const fixtureAttempt=await stmt('INSERT INTO fixture_reply_calls(message_id,history_size,started) VALUES(?,?,?) RETURNING id',message.id,history.length,Date.now()).first();
  await new Promise(resolve=>setTimeout(resolve,fixtureControl.delay_ms));
  await stmt('UPDATE fixture_reply_calls SET finished=? WHERE id=?',Date.now(),fixtureAttempt.id).run();
  if(fixtureControl.fail)throw Error('Local delayed reply fixture failure');
  ${providerCall}`);
const password='local-fast-ack-fixture',origin='https://rekha.test';
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-09-24',d1Databases:{DB:'fast-message-acks'},r2Buckets:{MEDIA:'fast-message-acks-media'},bindings:{ADMIN_PASSWORD_HASH:createHash('sha256').update(password).digest('hex')}}));
const latency=[];
try{
  const db=await mf.getD1Database('DB');
  for(const sql of fs.readFileSync('cloudflare/schema.sql','utf8').split(';').filter(value=>value.trim()))await db.prepare(sql).run();
  await db.prepare('CREATE TABLE fixture_reply_control(id INTEGER PRIMARY KEY,delay_ms INTEGER,fail INTEGER)').run();
  await db.prepare('INSERT INTO fixture_reply_control VALUES(1,1500,0)').run();
  await db.prepare('CREATE TABLE fixture_reply_calls(id INTEGER PRIMARY KEY AUTOINCREMENT,message_id INTEGER,history_size INTEGER,started INTEGER,finished INTEGER)').run();
  async function api(route,method='GET',data,cookie=''){
    const began=Date.now(),response=await mf.dispatchFetch(origin+route,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},...(data===undefined?{}:{body:JSON.stringify(data)})});
    return{status:response.status,data:await response.json(),elapsed:Date.now()-began,cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
  }
  async function until(read,accept,description,timeout=7000){
    const deadline=Date.now()+timeout;let value;
    do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,40));}while(Date.now()<deadline);
    assert.fail(description+': '+JSON.stringify(value));
  }
  const expect=(reply,status)=>{assert.equal(reply.status,status,JSON.stringify(reply.data));return reply;};
  const signup=async()=>expect(await api('/api/start','POST',{name:'Synthetic ack fixture',dob:'1990-01-01',language:'en',consent:true,preferences:{}}),201);
  const send=(chat,clientId=randomUUID(),body='Synthetic question')=>api('/api/messages','POST',{body,clientId},chat.cookie);
  const history=async chat=>expect(await api('/api/chat','GET',undefined,chat.cookie),200).data;
  const slow=await signup(),firstId=randomUUID();
  const first=expect(await send(slow,firstId),202);latency.push(first.elapsed);
  assert.ok(first.elapsed<750,`A 1500 ms reply must not delay save acknowledgment (${first.elapsed} ms).`);
  const firstMessage=first.data.messages.find(message=>message.clientId===firstId);
  assert.ok(firstMessage);assert.equal(firstMessage.status,'pending');assert.equal(first.data.freeUsed,0);
  assert.equal(first.data.version,1);assert.equal(typeof first.data.updated,'number');
  await until(()=>db.prepare('SELECT COUNT(*) AS n FROM fixture_reply_calls WHERE message_id=?').bind(firstMessage.id).first(),value=>value.n===1,'The detached reply starts');
  const secondId=randomUUID(),second=expect(await send(slow,secondId,'Second message without waiting for Rekha'),202);latency.push(second.elapsed);
  assert.ok(second.elapsed<750,'Another message can be saved while a reply is still running.');
  assert.equal(second.data.version,2);assert.ok(second.data.messages.some(message=>message.clientId===secondId));
  const snapshots=await Promise.all(Array.from({length:6},()=>history(slow)));
  assert.ok(snapshots.every(value=>value.messages.filter(message=>message.role==='user').length===2));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM fixture_reply_calls WHERE message_id=?').bind(firstMessage.id).first()).n,1,'Concurrent polls do not duplicate provider work.');
  const finished=await until(()=>history(slow),value=>value.freeUsed===1,'Latest pending context recovers after an obsolete in-flight reply');
  assert.equal(finished.messages.filter(message=>message.role==='assistant'&&message.kind==='demo').length,1);
  assert.equal(finished.messages.filter(message=>message.role==='user'&&message.status==='pending').length,0);
  assert.ok(finished.version>second.data.version);assert.ok(finished.messages.filter(message=>message.role!=='user').every(message=>message.clientId===null),'Internal reply and workflow IDs are not exposed.');

  const owner=expect(await api('/api/admin/login','POST',{password}),200).cookie,manual=await signup();
  expect(await api('/api/admin/conversations/'+manual.data.id+'/mode','PATCH',{mode:'manual'},owner),200);
  const before=await history(manual),duplicateId=randomUUID();
  const duplicates=await Promise.all(Array.from({length:8},()=>send(manual,duplicateId,'One concurrent submission')));
  assert.equal(duplicates.filter(reply=>reply.status===202).length,1);assert.equal(duplicates.filter(reply=>reply.status===200).length,7);
  const saved=await history(manual),savedMessage=saved.messages.find(message=>message.clientId===duplicateId);
  assert.equal(saved.messages.filter(message=>message.clientId===duplicateId).length,1);assert.equal(saved.version,before.version+1,'Duplicate concurrent IDs increment the conversation once.');
  expect(await api('/api/admin/conversations/'+manual.data.id+'/settings','PATCH',{archived:true,blocked:true},owner),200);
  await db.prepare('INSERT INTO drafts(conversation_id,message_id,body,kind,version) VALUES(?,?,?,?,?)').bind(manual.data.id,savedMessage.id,'Synthetic preserved draft','demo',saved.version+1).run();
  const repeat=expect(await api('/api/messages','POST',{body:'Changed retry text',clientId:duplicateId,mediaIds:['not-an-attachment']},manual.cookie),200);
  assert.equal(repeat.data.version,saved.version+1,'A retry does not change the version after the owner block action.');
  assert.equal(repeat.data.messages.find(message=>message.clientId===duplicateId).body,'One concurrent submission');
  assert.ok(await db.prepare('SELECT 1 FROM drafts WHERE conversation_id=?').bind(manual.data.id).first(),'Duplicate retries do not erase a newer draft.');
  assert.equal((await db.prepare('SELECT archived FROM chat_messaging WHERE conversation_id=?').bind(manual.data.id).first()).archived,1);
  expect(await send(manual,randomUUID()),403);
  const noOpBlock=expect(await api('/api/admin/conversations/'+manual.data.id+'/settings','PATCH',{blocked:true},owner),200);
  assert.equal(noOpBlock.data.version,repeat.data.version,'A no-op block save does not invalidate a valid reply draft.');
  assert.ok(await db.prepare('SELECT 1 FROM drafts WHERE conversation_id=?').bind(manual.data.id).first());
  const unblocked=expect(await api('/api/admin/conversations/'+manual.data.id+'/settings','PATCH',{blocked:false},owner),200);
  assert.equal(unblocked.data.version,repeat.data.version+1,'Unblocking advances the customer snapshot version.');
  assert.equal((await history(manual)).blocked,false);expect(await send(manual,randomUUID(),'Message after unblock'),202);
  const other=await signup();expect(await api('/api/admin/conversations/'+other.data.id+'/mode','PATCH',{mode:'manual'},owner),200);
  const independent=expect(await send(other,duplicateId,'Another authenticated customer'),202);
  assert.equal(independent.data.messages.find(message=>message.clientId===duplicateId).body,'Another authenticated customer');
  assert.ok(!independent.data.messages.some(message=>message.id===savedMessage.id));expect(await api('/api/chat'),401);

  const failure=await signup();await db.prepare('UPDATE fixture_reply_control SET delay_ms=400,fail=1 WHERE id=1').run();
  const failedId=randomUUID(),failedAck=expect(await send(failure,failedId),202);latency.push(failedAck.elapsed);
  assert.ok(failedAck.elapsed<750);const failedView=await until(()=>history(failure),value=>value.messages.some(message=>message.clientId===failedId&&message.status==='failed'),'Provider failure remains distinct from successful message persistence');
  assert.ok(failedView.version>failedAck.data.version);assert.equal(failedView.freeUsed,0);
  const failedMessage=failedView.messages.find(message=>message.clientId===failedId);
  const count=await db.prepare('SELECT COUNT(*) AS n FROM fixture_reply_calls WHERE message_id=?').bind(failedMessage.id).first();
  await Promise.all(Array.from({length:4},()=>history(failure)));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM fixture_reply_calls WHERE message_id=?').bind(failedMessage.id).first()).n,count.n,'Failed provider work has durable backoff.');
  await db.prepare('UPDATE fixture_reply_control SET delay_ms=80,fail=0 WHERE id=1').run();
  const retried=expect(await api('/api/retry','POST',{},failure.cookie),202);assert.ok(retried.data.version>failedView.version);
  const recovered=await until(()=>history(failure),value=>value.freeUsed===1,'Explicit retry eventually answers the already-saved message');assert.ok(recovered.version>retried.data.version);
  assert.equal(recovered.messages.filter(message=>message.clientId===failedId).length,1);

  // Older ineligible chats must not fill the timer's 20-chat reply budget.
  const skipped=[];
  for(const category of ['guided','blocked','drafted','exhausted','active-lease','backoff'])for(let i=0;i<24;i++){
    const id=randomUUID(),old=Date.now()-60000,mode=category==='drafted'?'assist':'ai';skipped.push(id);
    await db.prepare('INSERT INTO conversations(id,token_hash,name,dob,language,preferences,mode,version,free_used,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,'fixture-skip-'+id,'Synthetic skipped '+category,'1990-01-01','en','{}',mode,1,category==='exhausted'?3:0,old,old).run();
    const message=await db.prepare("INSERT INTO messages(conversation_id,role,kind,body,status,client_id,created) VALUES(?,'user','customer','Synthetic skipped pending request','pending',?,?) RETURNING id").bind(id,randomUUID(),old).first();
    if(category==='guided')await db.prepare("INSERT INTO chat_workflow(conversation_id,generation,status,stage,campaign,config,started_at,updated) VALUES(?,1,'paused','NEW','NONE',?,?,?)").bind(id,JSON.stringify({enabled:false,paymentEnabled:false,assets:{},timings:{firstDelayMs:5000,itemGapMs:5000,reminderDelayMs:60000,mediaDelayMs:3600000},content:{greeting:'Synthetic held greeting',firstCaption:'',testimonialsCaption:'',final:'',reminder:'',kundliCaption:'',solutionCaption:'',pujaCaption:'',qrCaption:''},translations:{en:{},hinglish:{}}}),old-1,old).run();
    if(category==='blocked')await db.prepare('INSERT INTO chat_messaging(conversation_id,blocked) VALUES(?,1)').bind(id).run();
    if(category==='drafted')await db.prepare('INSERT INTO drafts(conversation_id,message_id,body,kind,version) VALUES(?,?,?,?,1)').bind(id,message.id,'Synthetic valid current draft','demo').run();
    if(category==='active-lease'||category==='backoff')await db.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,?,?)').bind('reply-lease:'+id,category==='backoff'?-message.id:message.id,Date.now()+60000).run();
  }
  // Recreate interruption after persistence: no client retry and no customer poll.
  const interrupted=await signup(),interruptedId=randomUUID(),created=Date.now();
  for(let i=0;i<30;i++)await db.prepare("INSERT INTO messages(conversation_id,role,kind,body,status,created) VALUES(?,'assistant','owner-message',?,'sent',?)").bind(interrupted.data.id,'Synthetic earlier history '+i,created-1).run();
  await db.batch([
    db.prepare("INSERT INTO messages(conversation_id,role,kind,body,status,client_id,created) VALUES(?,'user','customer','Synthetic interrupted background reply','pending',?,?)").bind(interrupted.data.id,interruptedId,created),
    db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').bind(interrupted.data.id),
    db.prepare('INSERT INTO rate_limits(key,count,expires) VALUES(?,?,?)').bind('reply-lease:'+interrupted.data.id,1,Date.now()-1),
  ]);
  const worker=await mf.getWorker(),outcome=await worker.scheduled({scheduledTime:new Date(),cron:'* * * * *'});assert.equal(outcome.outcome,'ok');
  const cronMessage=await db.prepare('SELECT status FROM messages WHERE conversation_id=? AND client_id=?').bind(interrupted.data.id,interruptedId).first();assert.equal(cronMessage.status,'answered');
  for(const id of skipped)assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='assistant' AND kind='demo'").bind(id).first()).n,0,'Ineligible timer entries are not processed.');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='assistant' AND kind='demo'").bind(interrupted.data.id).first()).n,1);
  assert.equal((await db.prepare('SELECT MAX(history_size) AS n FROM fixture_reply_calls').first()).n,16,'Reply provider history is bounded independently of a longer full chat history.');
  console.log(JSON.stringify({savedBeforeReply:true,replyDelayMs:1500,acknowledgmentMs:latency,concurrentDuplicateRequests:8,onePersistedMessageAndVersion:true,replyProviderLease:true,customerSendsUngated:true,failedReplyBackoff:true,cronRecoversInterruptedWork:true,olderSkippedCronEntries:skipped.length,cronEligibleChatsNotStarved:true,productionWrites:false}));
}finally{await mf.dispose();}
