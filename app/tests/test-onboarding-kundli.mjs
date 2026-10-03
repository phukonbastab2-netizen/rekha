// Exact startup handlers with isolated D1/R2; no live credentials or customers.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
import {workflowDefaults} from '../cloudflare/workflow.mjs';

const bundled=process.argv.includes('--bundle');
const files=['cloudflare/rewards.mjs','cloudflare/messaging.mjs','cloudflare/calls.mjs','cloudflare/workflow.mjs','cloudflare/app-settings.mjs','cloudflare/owner.mjs','src/ai.mjs','cloudflare/worker.mjs'];
const original=bundled?fs.readFileSync('cloudflare/worker-bundle.mjs','utf8'):files.map(file=>fs.readFileSync(file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export (async function|function|const)/g,'$1')).join('\n');
assert.ok(original.includes("data.onboarding==='video-kundli-v1'"),'Fixture must use the actual onboarding handler.');
assert.equal(original.split('await db.batch(startBatch);').length,2,'Instrument only the atomic startup batch for an archive race.');
assert.equal(original.split('async function handleApi(request,env,executionContext){').length,2,'Instrument only the actual API environment for a missing-media binding.');
const script=original.replace('await db.batch(startBatch);',"if(kundli&&request.headers.get('X-Fixture-Archive-Race')==='yes')await stmt('UPDATE media_items SET archived=1 WHERE id=?',kundli.id).run();await db.batch(startBatch);").replace('async function handleApi(request,env,executionContext){',"async function handleApi(request,env,executionContext){if(request.headers.get('X-Fixture-No-Media')==='yes')env={...env,MEDIA:undefined};");
const origin='https://onboarding.test',password='local-onboarding-fixture-only';
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-09-24',d1Databases:{DB:'onboarding-'+randomUUID()},r2Buckets:{MEDIA:'onboarding-media-'+randomUUID()},bindings:{ADMIN_PASSWORD_HASH:createHash('sha256').update(password).digest('hex')},outboundService:()=>{throw Error('External requests are blocked for this local test.');}}));
const headers={'X-Rekha-History':'bounded-v1'},data={name:'Synthetic onboarding customer',dob:'1990-01-01',language:'en',consent:true,preferences:{}},newData={...data,onboarding:'video-kundli-v1'};
let ip=1;
try{
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('MEDIA');
  for(const sql of splitSqlStatements(fs.readFileSync('cloudflare/schema.sql','utf8')))await db.prepare(sql).run();
  async function api(route,method='GET',body,cookie='',extra={}){
    const response=await mf.dispatchFetch(origin+route,{method,headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.'+(ip++),Cookie:cookie,...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return{status:response.status,data:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
  }
  const expect=(response,status)=>{assert.equal(response.status,status,JSON.stringify(response.data));return response;};
  const count=async table=>(await db.prepare('SELECT COUNT(*) AS n FROM '+table).first()).n;
  const config=structuredClone(workflowDefaults);
  async function publish(){await db.prepare("INSERT INTO workflow_settings(key,value) VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(config)).run();}
  const missing=expect(await api('/api/start','POST',newData),503);assert.ok(missing.data.error.includes('kundli image'));assert.equal(missing.cookie,undefined);assert.equal(await count('conversations'),0);assert.equal(await count('messages'),0);assert.equal(await count('media_grants'),0);
  const legacy=expect(await api('/api/start','POST',data),201);assert.deepEqual(legacy.data.messages.map(m=>m.kind),['welcome']);assert.equal(legacy.data.freeUsed,0);assert.equal(await count('media_grants'),0);
  const id=randomUUID(),objectKey='fixture/shared-kundli-image',image=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  await db.prepare("INSERT INTO media_items(id,title,type,object_key,mime,size,created) VALUES(?,?,'image',?,'image/png',?,?)").bind(id,'Synthetic shared kundli image',objectKey,image.length,Date.now()).run();await bucket.put(objectKey,image,{httpMetadata:{contentType:'image/png'}});
  config.assets.kundli=id;await publish();
  const fresh=expect(await api('/api/start','POST',newData),201),profileId=fresh.data.id;
  assert.deepEqual(fresh.data.messages.map(m=>m.kind),['media','welcome'],'The shared kundli is the first persisted chat message.');
  assert.equal(fresh.data.messages[0].role,'assistant');assert.equal(fresh.data.messages[0].status,'sent');assert.equal(fresh.data.messages[0].clientId,null,'Private onboarding send ID is not exposed.');
  const payload=JSON.parse(fresh.data.messages[0].body);assert.equal(payload.text,'Your kundli');assert.equal(payload.title,'');assert.deepEqual(payload.items,[{id,title:'Shared kundli image',type:'image',url:'/api/media/'+id,mime:'image/png',size:image.length}]);assert.ok(!fresh.data.messages[0].body.includes(objectKey),'Internal object keys stay private.');
  assert.equal(fresh.data.freeUsed,0);assert.equal(fresh.data.freeRemaining,3);assert.equal(fresh.data.locked,false);assert.equal(fresh.data.version,0);assert.equal(fresh.data.guidedConversation,false);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM media_grants WHERE conversation_id=? AND media_id=?').bind(profileId,id).first()).n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND client_id=?').bind(profileId,'onboarding:kundli-v1').first()).n,1);
  const mine=await mf.dispatchFetch(origin+'/api/media/'+id,{headers:{Cookie:fresh.cookie}});assert.equal(mine.status,200);assert.equal(mine.headers.get('Content-Type'),'image/png');assert.deepEqual(new Uint8Array(await mine.arrayBuffer()),image);
  const other=await mf.dispatchFetch(origin+'/api/media/'+id,{headers:{Cookie:legacy.cookie}});assert.equal(other.status,404,'A legacy customer has no implicit library access.');
  const anonymous=await mf.dispatchFetch(origin+'/api/media/'+id);assert.equal(anonymous.status,401);
  const owner=expect(await api('/api/admin/login','POST',{password}),200).cookie,ownerImage=await mf.dispatchFetch(origin+'/api/media/'+id,{headers:{Cookie:owner}});assert.equal(ownerImage.status,200);
  const absentClip=await mf.dispatchFetch(origin+'/intro/onboarding.mp4');assert.equal(absentClip.status,404);
  const clip=Uint8Array.from([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,109,112,52,50]);
  const unauthClip=await mf.dispatchFetch(origin+'/api/admin/intro/onboarding',{method:'PUT',headers:{Origin:origin,'Content-Type':'video/mp4'},body:clip});assert.equal(unauthClip.status,401);
  for(const slug of ['welcome','introduction','testimonials','onboarding']){
    const uploaded=await mf.dispatchFetch(origin+'/api/admin/intro/'+slug,{method:'PUT',headers:{Origin:origin,'Content-Type':'video/mp4',Cookie:owner},body:clip});assert.equal(uploaded.status,200,slug+' owner upload');
    const publicClip=await mf.dispatchFetch(origin+'/intro/'+slug+'.mp4');assert.equal(publicClip.status,200,slug+' public video');assert.equal(publicClip.headers.get('Content-Type'),'video/mp4');assert.deepEqual(new Uint8Array(await publicClip.arrayBuffer()),clip);
  }
  const clipRange=await mf.dispatchFetch(origin+'/intro/onboarding.mp4',{headers:{Range:'bytes=4-7'}});assert.equal(clipRange.status,206);assert.equal(clipRange.headers.get('Content-Range'),'bytes 4-7/20');assert.equal(await clipRange.text(),'ftyp');
  const clipHead=await mf.dispatchFetch(origin+'/intro/onboarding.mp4',{method:'HEAD'});assert.equal(clipHead.status,200);assert.equal(clipHead.headers.get('Content-Length'),'20');assert.equal((await clipHead.arrayBuffer()).byteLength,0);
  const before=await count('conversations');expect(await api('/api/start','POST',{...newData,name:'Do not replace an existing session'},fresh.cookie),409);assert.equal(await count('conversations'),before);
  const recovered=expect(await api('/api/chat','GET',undefined,fresh.cookie),200);assert.deepEqual(recovered.data.messages.map(m=>m.id),fresh.data.messages.map(m=>m.id));assert.equal(recovered.data.name,data.name);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM media_grants WHERE conversation_id=?').bind(profileId).first()).n,1);
  const second=expect(await api('/api/start','POST',{...newData,name:'Second synthetic profile',language:'hi'}),201);assert.equal(JSON.parse(second.data.messages[0].body).items[0].id,id,'Every explicit new flow shares the configured image.');assert.equal(JSON.parse(second.data.messages[0].body).text,'Your kundli');assert.equal(second.data.freeUsed,0);
  expect(await api('/api/start','POST',{...newData,dob:'2020-01-01'}),400);expect(await api('/api/start','POST',{...newData,consent:false}),400);expect(await api('/api/start','POST',{...newData,onboarding:'unavailable-flow'}),400);expect(await api('/api/start','POST',newData,'',{Origin:'https://other.test'}),403);
  const stableCount=await count('conversations');
  expect(await api('/api/start','POST',newData,'',{'X-Fixture-No-Media':'yes'}),503);assert.equal(await count('conversations'),stableCount,'A missing media binding cannot create a profile.');
  await db.prepare('UPDATE media_items SET archived=1 WHERE id=?').bind(id).run();expect(await api('/api/start','POST',newData),503);assert.equal(await count('conversations'),stableCount);
  await db.prepare('UPDATE media_items SET archived=0 WHERE id=?').bind(id).run();await bucket.delete(objectKey);expect(await api('/api/start','POST',newData),503);assert.equal(await count('conversations'),stableCount);await bucket.put(objectKey,image);
  config.assets.kundli=randomUUID();await publish();expect(await api('/api/start','POST',newData),503);assert.equal(await count('conversations'),stableCount,'No arbitrary image fallback is selected.');config.assets.kundli=id;await publish();
  const beforeRace={profiles:await count('conversations'),messages:await count('messages'),grants:await count('media_grants')};expect(await api('/api/start','POST',newData,'',{'X-Fixture-Archive-Race':'yes'}),503);assert.deepEqual({profiles:await count('conversations'),messages:await count('messages'),grants:await count('media_grants')},beforeRace,'Concurrent library archive cannot leave a half-created profile/message/grant.');await db.prepare('UPDATE media_items SET archived=0 WHERE id=?').bind(id).run();
  // An enabled existing workflow still enrolls after the two startup messages.
  for(const [key,type]of Object.entries({firstVideo:'video',testimonials:'video',solution:'image',puja:'image',voice:'audio'})){
    const asset=randomUUID();config.assets[key]=asset;await db.prepare('INSERT INTO media_items(id,title,type,object_key,mime,size,created) VALUES(?,?,?,?,?,?,?)').bind(asset,'Synthetic '+key,type,'fixture/'+asset,type==='video'?'video/mp4':type==='audio'?'audio/mpeg':'image/png',20,Date.now()).run();
  }
  config.enabled=true;await publish();const enrolled=expect(await api('/api/start','POST',newData),201);assert.equal(enrolled.data.guidedConversation,true);assert.deepEqual(enrolled.data.messages.map(m=>m.kind),['media','welcome']);assert.equal((await db.prepare('SELECT stage FROM chat_workflow WHERE conversation_id=?').bind(enrolled.data.id).first()).stage,'NEW');assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workflow_jobs WHERE conversation_id=?').bind(enrolled.data.id).first()).n,0);
  const legacyEnrolled=expect(await api('/api/start','POST',data),201);assert.equal(legacyEnrolled.data.guidedConversation,true);assert.deepEqual(legacyEnrolled.data.messages.map(m=>m.kind),['welcome']);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM media_grants WHERE conversation_id=?').bind(legacyEnrolled.data.id).first()).n,0,'Legacy signup stays unchanged even while workflow is enabled.');
  console.log(JSON.stringify({exactBundle:bundled,newSignupFirstPrivateSharedKundli:true,caption:'Your kundli',welcomeSecond:true,freeUsageUnchanged:true,oneMessageAndGrantPerProfile:true,legacySignupAndSessionRecoveryPreserved:true,privateMediaOwnerCustomerIsolation:true,dedicatedOnboardingClipRouteOwnerWritePublicRead:true,existingThreeClipsUnchanged:true,onboardingClipRangeAndHead:true,missingBindingArchivedOrBrokenMediaDoesNotCreateProfile:true,archiveRaceRollsBackAtomicSignup:true,existingWorkflowEnrollmentPreserved:true,syntheticDataOnly:true,productionWrites:false}));
}finally{await mf.dispose();}
