import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root='./';
const source=['cloudflare/app-settings.mjs','cloudflare/messaging.mjs','cloudflare/owner.mjs'].map(file=>fs.readFileSync(root+file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export (async function|function|const)/g,'$1')).join('\n');
const fixture=`
export default {async fetch(request,env){
 const route=new URL(request.url).pathname,method=request.method,db=env.DB,cookie=request.headers.get('Cookie')||'';
 const stmt=(sql,...args)=>db.prepare(sql).bind(...args),one=(sql,...args)=>stmt(sql,...args).first();
 const fail=(status,message)=>Object.assign(Error(message),{status}),result=(value,status=200)=>Response.json(value,{status}),body=()=>request.json();
 const owner=async()=>{if(cookie!=='fixture-owner')throw fail(401,'Owner fixture required.');};
 const customer=async()=>{if(!cookie.startsWith('fixture-customer:'))throw fail(401,'Customer fixture required.');const chat=await one('SELECT * FROM conversations WHERE id=?',cookie.slice(17));if(!chat)throw fail(401,'No customer fixture.');return chat;};
 const settingsEnv=request.headers.has('X-Fixture-Archive-Before-Commit')?{...env,MEDIA:{head:async key=>{const object=await env.MEDIA.head(key);await stmt('UPDATE media_items SET archived=1 WHERE object_key=?',key).run();return object;}}}:env;
 const ctx={request,env:settingsEnv,route,method,stmt,one,fail,result,body,owner,customer,now:()=>Number(request.headers.get('X-Fixture-Now'))||Date.now()};
 try{const handled=await appSettingsRoutes(ctx);if(handled)return handled;
  if(route==='/api/config'){const value=await appSettingsPublic(ctx);return result({...value,rewardsEnabled:false,paymentMode:'demo'});}
  if(route.startsWith('/api/media/'))return await mediaResponse(ctx);
  if(route.startsWith('/api/attachments/'))return await messagingAttachmentResponse(ctx);
  if(route==='/brand/logo'){
    const {settings}=await appSettingsPublic(ctx),id=settings.brand.logoMediaId;if(!id)throw fail(404,'No logo.');
    const item=await one("SELECT * FROM media_items WHERE id=? AND type='image' AND archived=0",id);
    if(!item?.object_key||!['image/jpeg','image/png','image/webp'].includes(item.mime))throw fail(404,'Logo unavailable.');
    const object=await env.MEDIA.get(item.object_key);if(!object)throw fail(404,'Logo unavailable.');
    return new Response(object.body,{headers:{'Content-Type':item.mime,'X-Content-Type-Options':'nosniff'}});
  }
  throw fail(404,'Not found.');
 }catch(error){return result({error:error.status?error.message:'Local fixture failure'},error.status||503);}
}};`;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:source+'\n'+fixture,compatibilityDate:'2026-09-24',d1Databases:{DB:'app-settings-test'},r2Buckets:{MEDIA:'app-settings-media'}}));
try{
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('MEDIA');
 for(const file of ['schema.sql','migration-app-settings.sql'])for(const sql of fs.readFileSync(root+'cloudflare/'+file,'utf8').split(';').filter(value=>value.trim()))await db.prepare(sql).run();
 let now=100000;
 async function api(route,method='GET',data,cookie='fixture-owner',headers={}){
  const response=await mf.dispatchFetch('https://settings.test'+route,{method,headers:{Cookie:cookie,Origin:'https://settings.test','Content-Type':'application/json','X-Fixture-Now':String(++now),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
  return{status:response.status,data:await response.json()};
 }
 const get=()=>api('/api/admin/app-settings'),save=(draft,revision)=>api('/api/admin/app-settings','PATCH',{draft,revision}),publish=revision=>api('/api/admin/app-settings/publish','POST',{revision}),discard=revision=>api('/api/admin/app-settings/discard','POST',{revision}),clone=value=>structuredClone(value);
 const initial=(await get()).data,defaults=clone(initial.published);
 assert.deepEqual(initial,{published:defaults,draft:defaults,revision:0,updated:null,publishedAt:null});
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM app_settings').first()).n,0,'Default reads must not write settings.');
 assert.equal((await api('/api/admin/app-settings','GET',undefined,'')).status,401);
 assert.equal((await api('/api/admin/app-settings/publish','POST',{revision:0},'')).status,401);
 assert.equal((await api('/api/admin/app-settings/discard','POST',{revision:0},'')).status,401);
 assert.equal((await api('/api/admin/app-settings','POST',{revision:0})).status,405);
 assert.equal((await api('/api/admin/app-settings/publish','GET')).status,405);
 const publicInitial=(await api('/api/config','GET',undefined,'')).data;
 assert.deepEqual(publicInitial.settings,defaults);assert.equal(publicInitial.rewardsEnabled,false);assert.equal(publicInitial.paymentMode,'demo');assert.ok(!('draft'in publicInitial)&&!('updated'in publicInitial));

 const draftA=clone(defaults),draftB=clone(defaults);draftA.brand.name='Draft A';draftB.brand.name='Draft B';
 const firstRace=await Promise.all([save(draftA,0),save(draftB,0)]);
 assert.deepEqual(firstRace.map(response=>response.status).sort(),[200,409]);
 let current=firstRace.find(response=>response.status===200).data;
 assert.equal(current.revision,1);assert.deepEqual(current.published,defaults);assert.notDeepEqual(current.draft,defaults);assert.equal(current.publishedAt,null);
 assert.deepEqual((await api('/api/config','GET',undefined,'')).data.settings,defaults,'A saved draft is not published.');
 assert.equal((await save(defaults,0)).status,409);assert.equal((await publish(0)).status,409);assert.equal((await discard(0)).status,409);
 current=(await discard(current.revision)).data;assert.equal(current.revision,2);assert.deepEqual(current.draft,defaults);assert.deepEqual(current.published,defaults);

 const png=fs.readFileSync(root+'public/icon-192.png'),logoId=randomUUID(),otherImageId=randomUUID(),videoId=randomUUID(),archivedId=randomUUID(),missingId=randomUUID(),linkedId=randomUUID(),svgId=randomUUID();
 for(const [id,type,mime,archived,key,url]of [[logoId,'image','image/png',0,'fixture/'+logoId,null],[otherImageId,'image','image/png',0,'fixture/'+otherImageId,null],[videoId,'video','video/mp4',0,'fixture/'+videoId,null],[archivedId,'image','image/png',1,'fixture/'+archivedId,null],[missingId,'image','image/png',0,'fixture/'+missingId,null],[linkedId,'image','image/png',0,null,'https://example.test/image.png'],[svgId,'image','image/svg+xml',0,'fixture/'+svgId,null]]){
  await db.prepare('INSERT INTO media_items(id,title,type,object_key,url,mime,size,archived,created) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,'Local logo fixture',type,key,url,mime,png.length,archived,now).run();
  if(key&&id!==missingId)await bucket.put(key,png,{httpMetadata:{contentType:mime}});
 }
 const customerId=randomUUID(),outsiderId=randomUUID(),privateUploadId=randomUUID(),pdf=Buffer.from('%PDF-1.4\n% Local settings privacy fixture\n%%EOF');
 for(const id of [customerId,outsiderId])await db.prepare('INSERT INTO conversations(id,token_hash,name,dob,language,preferences,created,updated) VALUES(?,?,?,?,?,?,?,?)').bind(id,randomUUID(),'Local private fixture','1990-01-01','hi','{}',now,now).run();
 await db.prepare('INSERT INTO chat_attachments(id,conversation_id,title,type,object_key,mime,size,ready,created) VALUES(?,?,?,?,?,?,?,?,?)').bind(privateUploadId,customerId,'Private.pdf','document','private/'+privateUploadId,'application/pdf',pdf.length,1,now).run();
 await bucket.put('private/'+privateUploadId,pdf,{httpMetadata:{contentType:'application/pdf'}});
 const customer='fixture-customer:'+customerId,outsider='fixture-customer:'+outsiderId;
 assert.equal((await api('/api/admin/app-settings','GET',undefined,customer)).status,401);
 assert.equal((await api('/api/admin/app-settings','PATCH',{draft:defaults,revision:current.revision},customer)).status,401);
 assert.equal((await mf.dispatchFetch('https://settings.test/api/attachments/'+privateUploadId,{headers:{Cookie:customer}})).status,200);
 assert.equal((await mf.dispatchFetch('https://settings.test/api/attachments/'+privateUploadId,{headers:{Cookie:outsider}})).status,404);
 assert.equal((await mf.dispatchFetch('https://settings.test/api/media/'+logoId,{headers:{Cookie:customer}})).status,404);

 for(const badLogo of [videoId,archivedId,missingId,linkedId,svgId,privateUploadId,randomUUID(),'https://example.test/logo.png']){
  const draft=clone(defaults);draft.brand.logoMediaId=badLogo;assert.equal((await save(draft,current.revision)).status,400,'Unavailable, customer-owned or unsupported images cannot be branding assets.');
 }
 const invalidEdits=[
  draft=>{draft.extra='arbitrary';},draft=>{draft.brand.secret='never';},draft=>{draft.chat.adsEnabled=true;},draft=>{draft.service.paymentMode='real';},
  draft=>{delete draft.chat.voiceCallsEnabled;},draft=>{draft.chat.attachmentsEnabled=1;},draft=>{draft.brand.primaryColor='url(javascript:alert(1))';},
  draft=>{draft.brand.name='x'.repeat(61);},draft=>{draft.brand.astrologerName=' ';},draft=>{draft.brand.tagline='x'.repeat(121);},
  draft=>{draft.onboarding.introOrder=['welcome','welcome','testimonials'];},draft=>{draft.onboarding.introOrder=['welcome'];},draft=>{draft.onboarding.introEnabled='true';},
  draft=>{draft.service.freeReplies=-1;},draft=>{draft.service.freeReplies=21;},draft=>{draft.service.freeReplies=1.5;},draft=>{draft.service.unlockPriceRupees=0;},draft=>{draft.service.unlockPriceRupees=10000;},draft=>{draft.service.retentionDays=6;},draft=>{draft.service.retentionDays=91;},
  draft=>{draft.copy.fr={};},draft=>{draft.copy.en.privacyUse='unsupported';},draft=>{draft.copy.en.languageTitle='<script>alert(1)</script>';},draft=>{draft.copy.en.tagline='';},draft=>{draft.copy.en.reflection='x\u0000y';},draft=>{draft.copy.en.messagePlaceholder='x'.repeat(201);},draft=>{draft.copy.en.topics=['Only one'];},draft=>{draft.copy.en.topics=['a','b','x'.repeat(121)];},draft=>{draft.copy.hi=[];}
 ];
 for(const edit of invalidEdits){const draft=clone(defaults);edit(draft);assert.equal((await save(draft,current.revision)).status,400);}
 assert.equal((await api('/api/admin/app-settings','PATCH',{draft:defaults,revision:current.revision,unknown:true})).status,400);
 assert.equal((await api('/api/admin/app-settings','PATCH',{draft:defaults,revision:String(current.revision)})).status,400);
 assert.equal((await api('/api/admin/app-settings/publish','POST',{revision:current.revision,enabled:true})).status,400);
 assert.deepEqual((await get()).data,current,'Invalid settings leave both published and draft untouched.');

 const valid=clone(defaults);valid.brand.name='Local published brand';valid.brand.astrologerName='Private owner';valid.brand.logoMediaId=logoId;valid.brand.primaryColor='#112233';valid.brand.accentColor='#AABBCC';
 valid.onboarding.introEnabled=false;valid.onboarding.introOrder=['testimonials','welcome','introduction'];
 for(const key of Object.keys(valid.chat))valid.chat[key]=false;
 valid.service={freeReplies:0,unlockPriceRupees:99,retentionDays:7};valid.copy.en={tagline:'Draft-only wording',topics:['Career','Relationships','Direction'],languageTitle:'Choose a language\nWelcome'};valid.copy.hi={messagePlaceholder:'अपना प्रश्न लिखें'};
 current=(await save(valid,current.revision)).data;assert.equal(current.revision,3);assert.deepEqual(current.draft,valid);assert.deepEqual(current.published,defaults);
 assert.deepEqual((await api('/api/config','GET',undefined,'')).data.settings,defaults);
 assert.equal((await mf.dispatchFetch('https://settings.test/brand/logo')).status,404,'Draft logos are not public.');
 assert.equal((await mf.dispatchFetch('https://settings.test/api/media/'+logoId,{headers:{Cookie:customer}})).status,404,'Saving branding must not grant generic private media access.');
 const draftCopy=clone(current.draft);draftCopy.brand.name='Concurrent edit';
 const publishRace=await Promise.all([publish(current.revision),save(draftCopy,current.revision)]);
 assert.deepEqual(publishRace.map(response=>response.status).sort(),[200,409]);current=publishRace.find(response=>response.status===200).data;
 if(current.publishedAt===null)current=(await publish(current.revision)).data;
 assert.equal(current.publishedAt>0,true);assert.deepEqual(current.published,current.draft);
 const published=(await api('/api/config','GET',undefined,'')).data;
 assert.deepEqual(published.settings,current.published);assert.equal(published.revision,current.revision);assert.ok(!('draft'in published)&&!('updated'in published));
 assert.equal(published.rewardsEnabled,false);assert.equal(published.paymentMode,'demo');
 const logo=await mf.dispatchFetch('https://settings.test/brand/logo');assert.equal(logo.status,200);assert.deepEqual(Buffer.from(await logo.arrayBuffer()),png);
 assert.equal((await mf.dispatchFetch('https://settings.test/api/media/'+logoId,{headers:{Cookie:customer}})).status,404);
 assert.equal((await mf.dispatchFetch('https://settings.test/api/media/'+otherImageId,{headers:{Cookie:customer}})).status,404,'Publishing one logo must not expose the rest of the library.');
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM media_grants').first()).n,0);

 // A logo archived after draft save must be rejected at publish; discarding
 // remains available even if a formerly published logo is later archived.
 const replacement=clone(current.published);replacement.brand.logoMediaId=otherImageId;
 current=(await save(replacement,current.revision)).data;
 await db.prepare('UPDATE media_items SET archived=1 WHERE id=?').bind(otherImageId).run();
 assert.equal((await publish(current.revision)).status,400);assert.deepEqual((await get()).data,current);
 current=(await discard(current.revision)).data;assert.deepEqual(current.draft,current.published);
 await db.prepare('UPDATE media_items SET archived=1 WHERE id=?').bind(logoId).run();
 current=(await discard(current.revision)).data;assert.deepEqual(current.draft,current.published);
 assert.equal((await mf.dispatchFetch('https://settings.test/brand/logo')).status,404,'Archived branding fails closed.');
 const clearLogo=clone(current.published);clearLogo.brand.logoMediaId=null;clearLogo.service={freeReplies:20,unlockPriceRupees:9999,retentionDays:90};
 current=(await save(clearLogo,current.revision)).data;current=(await publish(current.revision)).data;
 assert.equal(current.published.brand.logoMediaId,null);assert.deepEqual(current.published.service,clearLogo.service);
  await db.prepare('UPDATE media_items SET archived=0 WHERE id=?').bind(otherImageId).run();
  const racedLogo=clone(current.draft);racedLogo.brand.logoMediaId=otherImageId;
  const archiveRace=await api('/api/admin/app-settings','PATCH',{draft:racedLogo,revision:current.revision},'fixture-owner',{'X-Fixture-Archive-Before-Commit':'1'});
  assert.equal(archiveRace.status,409,'Archiving the logo between validation and commit must fail the atomic media guard.');
  assert.deepEqual((await get()).data,current,'A logo archive race must not save a stale draft or increment its revision.');
 console.log('App settings checks passed: read-only defaults, owner isolation, complete schema/plain-text validation, first-save and publish CAS, draft/publish/discard separation, protected ads/payments, service bounds, private logo and customer-upload isolation, archive revalidation, public published-only metadata and no generic media grants.');
}finally{await mf.dispose();}
