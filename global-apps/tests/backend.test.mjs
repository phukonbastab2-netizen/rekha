import {test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import {createHash,randomUUID}from'node:crypto';import {apps}from'../apps/catalog.mjs';import {translations}from'../shared/translations.mjs';
const {Miniflare,convertV4MiniflareOptions}=await import(process.env.MINIFLARE_MODULE||'miniflare');
for(const c of apps)test(`${c.name}: localized signup, private sessions, owner controls, replies and deletion`,async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(`live/${c.id}/worker.mjs`,'utf8'),compatibilityDate:'2026-09-24',d1Databases:{DB:c.id},r2Buckets:{MEDIA:c.id},bindings:{ADMIN_PASSWORD_HASH:createHash('sha256').update('fixture-owner-password-not-for-deployment').digest('hex'),AI_MODE:'demo'}}));
 try{
  const db=await mf.getD1Database('DB');for(const sql of fs.readFileSync(`live/${c.id}/schema.sql`,'utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();
  const origin='https://'+c.id+'.test';
  const call=async(route,method='GET',body,cookie='',customOrigin=origin)=>{const r=await mf.dispatchFetch(origin+route,{method,headers:{Origin:customOrigin,'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json(),cookie:r.headers.get('Set-Cookie')?.split(';')[0]};};
  assert.equal((await mf.dispatchFetch(origin+'/')).status,200);assert.equal((await mf.dispatchFetch(origin+'/admin')).status,200);
  const health=await call('/api/health');assert.equal(health.data.app,c.id);
  assert.equal((await call('/api/admin/conversations')).status,401);
  const input={name:'Fixture only',dob:'1990-01-01',language:c.locale,consent:true,preferences:{}};
  assert.equal((await call('/api/start','POST',{...input,dob:'2020-01-01'})).status,400);
  assert.equal((await call('/api/start','POST',{...input,language:'not-a-locale'})).status,400);
  assert.equal((await call('/api/start','POST',input,'','https://attacker.invalid')).status,403);
  const first=await call('/api/start','POST',input),second=await call('/api/start','POST',{...input,name:'Other fixture'});
  assert.equal(first.status,201,JSON.stringify(first.data));assert.equal(first.data.messages[0].body,translations[c.locale].welcome);assert.equal(second.status,201);
  const customer=first.cookie,id=first.data.id;
  assert.equal((await call('/api/admin/conversations/'+id,'GET',undefined,customer)).status,401);
  const login=await call('/api/admin/login','POST',{password:'fixture-owner-password-not-for-deployment'});assert.equal(login.status,200);const owner=login.cookie;
  let state=(await call('/api/admin/conversations/'+id,'GET',undefined,owner)).data;assert.equal(state.mode,'manual');
  const request={body:'Question <script>alert(1)</script>',clientId:randomUUID()};
  const sent=await call('/api/messages','POST',request,customer);assert.equal(sent.status,202);assert.equal(sent.data.messages.filter(m=>m.role==='user').length,1);
  const again=await call('/api/messages','POST',request,customer);assert.equal(again.data.messages.filter(m=>m.role==='user').length,1);
  const other=(await call('/api/chat','GET',undefined,second.cookie)).data;assert.equal(other.messages.filter(m=>m.role==='user').length,0);
  state=(await call('/api/admin/conversations/'+id,'GET',undefined,owner)).data;
  const answer=await call('/api/admin/conversations/'+id+'/send','POST',{body:'Owner fixture response',version:state.version,clientId:randomUUID(),answersPending:true},owner);assert.equal(answer.status,201,JSON.stringify(answer.data));
  assert.ok((await call('/api/chat','GET',undefined,customer)).data.messages.some(m=>m.body==='Owner fixture response'));
  await call('/api/admin/conversations/'+id+'/settings','PATCH',{notes:'Private owner note',labels:['Private']},owner);
  assert.equal('notes'in(await call('/api/chat','GET',undefined,customer)).data,false);
  await call('/api/admin/conversations/'+id+'/mode','PATCH',{mode:'ai'},owner);
  const auto=await call('/api/messages','POST',{body:'Second question',clientId:randomUUID()},customer);assert.equal(auto.status,202);assert.ok(auto.data.messages.some(m=>m.kind==='demo'&&Object.values(translations[c.locale]).includes(m.body)));
  for(const l of c.languages.filter(l=>l!==c.locale)){const local=await call('/api/start','POST',{...input,language:l});assert.equal(local.status,201);assert.equal(local.data.messages[0].body,translations[l].welcome);}
  assert.equal((await call('/api/chat','DELETE',{},customer)).status,200);assert.equal((await call('/api/chat','GET',undefined,customer)).status,401);assert.equal((await call('/api/chat','GET',undefined,second.cookie)).status,200);
 }finally{await mf.dispose();}
});
