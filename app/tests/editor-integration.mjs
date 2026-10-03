import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
// Exact shipped bundle, ephemeral local D1/R2, and actual owner/customer auth.
// No cloud requests, production writes, credentials or real customer data.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const root='./',origin='https://rekha.test',password='local-editor-integration-fixture';
const bundle=fs.readFileSync(root+'cloudflare/worker-bundle.mjs','utf8');
const bundleSha256=createHash('sha256').update(bundle).digest('hex');
const mf=new Miniflare(convertV4MiniflareOptions({
  modules:true,script:bundle,compatibilityDate:'2026-09-24',host:'127.0.0.1',port:0,
  d1Databases:{DB:'bundled-editor-test'},r2Buckets:{MEDIA:'bundled-editor-media'},
  bindings:{CUSTOMER_AUTOMATION_ENABLED:'true',ADMIN_PASSWORD_HASH:createHash('sha256').update(password).digest('hex')}
}));

try{
  const db=await mf.getD1Database('DB');
  for(const sql of splitSqlStatements(fs.readFileSync(root+'cloudflare/schema.sql','utf8')))await db.prepare(sql).run();
  async function request(route,method='GET',data,cookie='',mime){
    return mf.dispatchFetch(origin+route,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':mime||'application/json'},
      ...(data===undefined?{}:{body:mime?data:JSON.stringify(data)})});
  }
  async function api(route,method='GET',data,cookie='',mime){
    const response=await request(route,method,data,cookie,mime),text=await response.text();
    let parsed;try{parsed=JSON.parse(text);}catch{assert.fail(`${method} ${route} returned non-JSON (${response.status}): ${text.slice(0,180)}`);}
    return{status:response.status,data:parsed,cookie:response.headers.get('Set-Cookie')?.split(';')[0]};
  }
  const expect=(reply,status)=>{assert.equal(reply.status,status,JSON.stringify(reply.data));return reply.data;};
  const publicConfig=async()=>expect(await api('/api/config'),200);
  const defaults=await publicConfig();
  assert.equal(defaults.freeTurns,3);assert.equal(defaults.amount,4900);assert.equal(defaults.retentionDays,30);
  assert.equal(defaults.paymentMode,'demo');assert.equal(defaults.rewardsEnabled,false);assert.equal(defaults.settingsRevision,0);
  assert.equal(await db.prepare('SELECT * FROM app_settings').first(),null,'Public defaults must not mutate storage.');
  for(const [route,method,data]of [['/api/admin/app-settings','GET'],['/api/admin/app-settings','PATCH',{draft:defaults.appSettings,revision:0}],['/api/admin/app-settings/publish','POST',{revision:0}],['/api/admin/app-settings/discard','POST',{revision:0}]])expect(await api(route,method,data),401);
  const login=await api('/api/admin/login','POST',{password});expect(login,200);const owner=login.cookie;assert.ok(owner?.startsWith('ar_admin='));
  const settings=async()=>expect(await api('/api/admin/app-settings','GET',undefined,owner),200);
  const save=async(draft,revision)=>api('/api/admin/app-settings','PATCH',{draft,revision},owner);
  const publish=async revision=>api('/api/admin/app-settings/publish','POST',{revision},owner);
  async function editPublished(edit){const current=await settings(),draft=structuredClone(current.published);edit(draft);const saved=expect(await save(draft,current.revision),200);return expect(await publish(saved.revision),200);}
  async function signup(language='hi'){
    const response=await api('/api/start','POST',{name:'Local editor fixture',dob:'1990-01-01',language,consent:true,preferences:{}});expect(response,201);
    assert.ok(response.cookie?.startsWith('ar_session='));return{id:response.data.id,cookie:response.cookie,view:response.data};
  }
  const active=await signup();expect(await api('/api/admin/app-settings','GET',undefined,active.cookie),401);
  expect(await api('/api/admin/app-settings/publish','POST',{revision:0},active.cookie),401);
  expect(await api('/api/admin/conversations/'+active.id+'/mode','PATCH',{mode:'manual'},owner),200);
  const send=async(chat,data={})=>api('/api/messages','POST',{body:'Synthetic private question',clientId:randomUUID(),...data},chat.cookie);
  const history=async chat=>expect(await api('/api/chat','GET',undefined,chat.cookie),200);
  async function delivered(chat,body){for(let attempt=0;attempt<80;attempt++){const view=await history(chat);if(view.messages.some(message=>message.body===body))return view;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('The asynchronously delivered workflow step did not appear: '+body);}
  const initial=expect(await send(active),202),textId=initial.messages.at(-1).id;
  const png=fs.readFileSync(root+'public/icon-192.png'),pdf=Buffer.from('%PDF-1.4\n% Synthetic editor fixture\n%%EOF');
  const audio=Buffer.alloc(32);audio.set([26,69,223,163]);
  async function uploadCustomer(chat,bytes,mime,name){return api('/api/uploads?name='+encodeURIComponent(name),'POST',bytes,chat.cookie,mime);}
  async function uploadOwner(bytes,mime,title){return expect(await api('/api/admin/uploads?title='+encodeURIComponent(title),'POST',bytes,owner,mime),201);}
  const privatePdf=expect(await uploadCustomer(active,pdf,'application/pdf','local.pdf'),201);
  const customerImage=expect(await uploadCustomer(active,png,'image/png','local.png'),201);
  const privateVoice=expect(await uploadCustomer(active,audio,'audio/webm','local.webm'),201);
  const logo=await uploadOwner(png,'image/png','Local published logo');
  const otherImage=await uploadOwner(Buffer.concat([png,Buffer.from('local-unrelated-fixture')]),'image/png','Local private unrelated image');

  for(const invalid of [
    {...structuredClone(defaults.appSettings),adsEnabled:true},
    {...structuredClone(defaults.appSettings),brand:{...defaults.appSettings.brand,logoMediaId:customerImage.id}},
    {...structuredClone(defaults.appSettings),service:{...defaults.appSettings.service,unlockPriceRupees:0}}
  ])expect(await save(invalid,0),400);
  assert.equal((await settings()).revision,0);
  const draft=structuredClone(defaults.appSettings);
  draft.brand.name='Local Rekha Editor';draft.brand.logoMediaId=logo.id;draft.brand.primaryColor='#104e44';
  draft.onboarding.introEnabled=false;draft.onboarding.introOrder=['testimonials','welcome','introduction'];
  draft.chat={attachmentsEnabled:false,voiceNotesEnabled:false,voiceCallsEnabled:false,videoCallsEnabled:false,customerMessagingEnabled:false};
  draft.service={freeReplies:7,unlockPriceRupees:99,retentionDays:14};draft.copy.hi.messagePlaceholder='अपना स्थानीय परीक्षण प्रश्न लिखें';
  const race=await Promise.all([save(draft,0),save({...draft,brand:{...draft.brand,name:'Concurrent alternative'}},0)]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);let stored=race.find(r=>r.status===200).data;
  assert.equal(stored.revision,1);assert.equal(stored.publishedAt,null);assert.equal(stored.published.brand.logoMediaId,null);
  assert.deepEqual((await publicConfig()).appSettings,defaults.appSettings,'Saving a draft must not change public settings.');
  assert.equal((await request('/brand/logo')).status,404,'A draft logo is still private.');
  assert.equal((await request('/api/media/'+logo.id,'GET',undefined,active.cookie)).status,404);
  assert.equal((await request('/api/media/'+otherImage.id,'GET',undefined,active.cookie)).status,404);
  expect(await send(active),202,'Draft disabled messaging has no effect.');
  const beforeCall=expect(await api('/api/calls','POST',{type:'voice'},active.cookie),201);
  expect(await publish(0),409);
  stored=expect(await publish(stored.revision),200);assert.equal(stored.revision,2);assert.ok(stored.publishedAt>0);
  let visible=await publicConfig();assert.deepEqual(visible.appSettings,stored.published);assert.equal(visible.settingsRevision,2);
  assert.equal(visible.freeTurns,7);assert.equal(visible.amount,9900);assert.equal(visible.retentionDays,14);
  assert.equal(visible.paymentMode,'demo');assert.equal(visible.rewardsEnabled,false);
  const brandResponse=await request('/brand/logo');assert.equal(brandResponse.status,200);assert.equal(brandResponse.headers.get('Content-Type'),'image/png');
  assert.equal(brandResponse.headers.get('X-Content-Type-Options'),'nosniff');
  assert.deepEqual(Buffer.from(await brandResponse.arrayBuffer()),png);
  const arbitrary=await request('/brand/logo?id='+otherImage.id);assert.equal(arbitrary.status,200);
  assert.deepEqual(Buffer.from(await arbitrary.arrayBuffer()),png,'Query parameters cannot select arbitrary private media.');
  assert.equal((await request('/brand/logo','HEAD')).status,200);assert.equal((await request('/brand/logo','POST',{})).status,405);
  assert.equal((await request('/api/media/'+logo.id,'GET',undefined,active.cookie)).status,404,'Publishing a logo does not grant the generic private media route.');
  assert.equal((await request('/api/media/'+otherImage.id,'GET',undefined,active.cookie)).status,404);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM media_grants WHERE media_id=?').bind(logo.id).first()).n,0);
  expect(await send(active),403);expect(await uploadCustomer(active,pdf,'application/pdf','paused.pdf'),403);
  expect(await api('/api/messages/'+textId,'PATCH',{body:'Paused edit'},active.cookie),403);
  expect(await api('/api/chat/read','POST',{lastId:textId},active.cookie),200);
  expect(await api('/api/messages/'+textId+'/star','PUT',{starred:true},active.cookie),200);
  expect(await api('/api/messages/'+textId+'/reaction','PUT',{emoji:'🙏'},active.cookie),200);
  expect(await api('/api/messages/'+textId,'DELETE',{},active.cookie),200);assert.equal((await history(active)).messages.find(m=>m.id===textId).deleted,true);
  const ended=expect(await api('/api/calls/'+beforeCall.id,'GET',undefined,active.cookie),200);assert.equal(ended.status,'ended');assert.equal(ended.reason,'feature-disabled');
  const callConfig=expect(await api('/api/calls/config','GET',undefined,active.cookie),200);assert.equal(callConfig.enabled,false);assert.equal(callConfig.voiceEnabled,false);assert.equal(callConfig.videoEnabled,false);
  expect(await api('/api/calls','POST',{type:'voice'},active.cookie),403);
  expect(await api('/api/admin/calls','POST',{type:'video',conversationId:active.id},owner),403);
  async function ownerSend(chat,data={}){
    const state=expect(await api('/api/admin/conversations/'+chat.id,'GET',undefined,owner),200);
    return api('/api/admin/conversations/'+chat.id+'/send','POST',{body:'Local owner follow-up',clientId:randomUUID(),version:state.version,answersPending:false,...data},owner);
  }
  expect(await ownerSend(active,{mediaIds:[privateVoice.id]}),201);await uploadOwner(audio,'audio/webm','Local owner voice');
  // A saved second draft can be discarded without changing published configuration.
  let view=await settings(),discardDraft=structuredClone(view.published);discardDraft.brand.name='Discard this local draft';
  let saved=expect(await save(discardDraft,view.revision),200);
  const discarded=expect(await api('/api/admin/app-settings/discard','POST',{revision:saved.revision},owner),200);
  assert.equal(discarded.revision,saved.revision+1);assert.deepEqual(discarded.draft,discarded.published);
  assert.equal(discarded.publishedAt,view.publishedAt);assert.equal((await publicConfig()).appSettings.brand.name,view.published.brand.name);
  await editPublished(next=>{next.chat.customerMessagingEnabled=true;});
  expect(await send(active),202);expect(await send(active,{mediaIds:[privatePdf.id]}),403);
  expect(await uploadCustomer(active,pdf,'application/pdf','attachment-disabled.pdf'),403);
  await editPublished(next=>{next.chat.attachmentsEnabled=true;});
  expect(await send(active,{mediaIds:[privateVoice.id]}),403);expect(await uploadCustomer(active,audio,'audio/webm','voice-disabled.webm'),403);
  expect(await send(active,{mediaIds:[privatePdf.id]}),202);
  const privateDownload=await request('/api/attachments/'+privatePdf.id,'GET',undefined,active.cookie);assert.equal(privateDownload.status,200);assert.match(privateDownload.headers.get('Content-Disposition'),/^attachment;/);
  await privateDownload.arrayBuffer();
  console.log('Exact bundle: owner auth, CAS, draft/publish/discard, private logo and server feature controls passed.');

  // Use format-valid small fixtures for storage/flow, not a media-decoder claim.
  const mp4=Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,2,0,105,115,111,109,109,112,52,49]),assets={};
  for(const[key,type]of Object.entries({firstVideo:'video',testimonials:'video',kundli:'image',solution:'image',puja:'image',voice:'audio'})){
    const item=await uploadOwner(type==='video'?mp4:type==='image'?png:audio,type==='video'?'video/mp4':type==='image'?'image/png':'audio/webm','Local workflow '+key);assets[key]=item.id;
  }
  const workflowSetup=expect(await api('/api/admin/workflow/settings','PATCH',{
    enabled:true,paymentEnabled:false,assets,
    timings:{firstDelayMs:0,itemGapMs:0,reminderDelayMs:0,mediaDelayMs:0},
    content:{greeting:'HI ₹49 + ₹299 + ₹499 + {price}',final:'HI final ₹49 + ₹299 + ₹499 + {price}',reminder:'HI reminder ₹49 / {price}'},
    translations:{en:{greeting:'EN ₹49 + ₹299 + ₹499 + {price}',final:'EN final ₹49 + ₹299 + ₹499 + {price}'}}
  },owner),200);
  await editPublished(next=>{next.service.freeReplies=0;next.service.unlockPriceRupees=99;next.chat.voiceNotesEnabled=true;});
  const oldFlow=await signup('hi');assert.equal(oldFlow.view.guidedConversation,true);assert.equal(oldFlow.view.locked,false);assert.equal(oldFlow.view.freeRemaining,0);
  const first=expect(await send(oldFlow),202);assert.equal(first.freeUsed,0);
  await delivered(oldFlow,'HI ₹99 + ₹299 + ₹499 + 99');
  const oldSnapshot=JSON.parse((await db.prepare('SELECT config FROM chat_workflow WHERE conversation_id=?').bind(oldFlow.id).first()).config);
  assert.equal(oldSnapshot.unlockPriceRupees,99);assert.equal(oldSnapshot.language,'hi');
  await editPublished(next=>{next.service.unlockPriceRupees=119;});
  let oldHistory=await delivered(oldFlow,'HI final ₹99 + ₹299 + ₹499 + 99');
  assert.equal(oldHistory.freeUsed,0);assert.equal(oldHistory.locked,false);
  expect(await send(oldFlow),202);await delivered(oldFlow,'HI reminder ₹99 / 99');
  const newFlow=await signup('en');assert.equal(newFlow.view.guidedConversation,true);assert.equal(newFlow.view.freeRemaining,0);assert.equal(newFlow.view.locked,false);
  expect(await send(newFlow),202);await delivered(newFlow,'EN ₹119 + ₹299 + ₹499 + 119');
  assert.equal(JSON.parse((await db.prepare('SELECT config FROM chat_workflow WHERE conversation_id=?').bind(newFlow.id).first()).config).unlockPriceRupees,119);
  for(let i=0;i<6;i++)expect(await send(newFlow,{body:'Synthetic unlimited follow-up '+i}),202);
  const guidedPdf=expect(await uploadCustomer(newFlow,pdf,'application/pdf','guided.pdf'),201);
  expect(await send(newFlow,{mediaIds:[guidedPdf.id]}),202);
  for(let i=0;i<5;i++)await history(newFlow);
  const guided=await history(newFlow);assert.equal(guided.freeUsed,0);assert.equal(guided.guidedConversation,true);assert.equal(guided.locked,false);
  assert.equal(guided.messages.some(m=>m.role==='assistant'&&m.kind.startsWith('demo')),false,'Enrolled guided chats must suppress generic sample AI.');
  assert.equal((await db.prepare('SELECT free_used FROM conversations WHERE id=?').bind(newFlow.id).first()).free_used,0);
  assert.deepEqual(expect(await api('/api/admin/workflow/settings','GET',undefined,owner),200),workflowSetup,'Workflow price rendering must not rewrite owner global text.');
  assert.ok(guided.messages.filter(m=>m.kind==='media'&&m.role==='assistant').every(m=>JSON.parse(m.body).items.every(item=>Object.values(assets).includes(item.id))));
  assert.equal((await request('/api/media/'+assets.firstVideo,'GET',undefined,newFlow.cookie)).status,200);
  assert.equal((await request('/api/media/'+assets.firstVideo,'GET',undefined,active.cookie)).status,404,'Workflow asset access remains scoped to the enrolled chat.');
  assert.equal((await request('/api/attachments/'+guidedPdf.id,'GET',undefined,active.cookie)).status,404);
  assert.equal((await request('/api/media/'+otherImage.id,'GET',undefined,newFlow.cookie)).status,404);
  const zeroCap=await send(active);expect(zeroCap,402);assert.ok(zeroCap.data.error.includes('₹119'));
  assert.equal((await history(active)).locked,true,'The configured zero free replies applies to an older unguided free chat.');
  expect(await api('/api/rewards/attempt','POST',{},newFlow.cookie),503);
  console.log(JSON.stringify({exactBundledWorker:true,bundleSha256,ownerAuthAndAtomicCas:true,draftIsolationAndDiscard:true,publishedPublicConfiguration:true,
    onlyPublishedLogoPublic:true,privateAttachmentsAndLibraryIsolated:true,serverFeatureControls:true,disabledCallTeardown:true,
    configuredFreeReplies:true,guidedUncappedAndNoFreeCounterIncrement:true,genericAiSuppressed:true,futureWorkflowPrices:[99,119],oldWorkflowPricePreserved:true,
    unchangedWorkflowGlobalText:true,paymentMode:'demo',adsEnabled:false,fixtureMediaDecodeTested:false,productionWrites:false}));
}finally{await mf.dispose();}
