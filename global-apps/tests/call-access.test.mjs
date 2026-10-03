import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{createHash,randomUUID}from'node:crypto';
test('temporary relay credentials require a live call and its authenticated participant',async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import(process.env.MINIFLARE_MODULE||'miniflare');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync('live/luna-harbor/worker.mjs','utf8'),compatibilityDate:'2026-09-24',d1Databases:{DB:'relay-access'},bindings:{ADMIN_PASSWORD_HASH:createHash('sha256').update('fixture-owner').digest('hex'),AI_MODE:'manual',TURN_KEY_ID:'fixture-turn-key'}}));
 try{const db=await mf.getD1Database('DB');for(const sql of fs.readFileSync('live/luna-harbor/schema.sql','utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();
 const origin='https://relay-access.test';const call=async(route,method='GET',body,cookie='')=>{const r=await mf.dispatchFetch(origin+route,{method,headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json(),cookie:r.headers.get('Set-Cookie')?.split(';')[0]};};
 assert.equal((await call('/api/calls/config')).status,401);
 const input={name:'Fixture',dob:'1990-01-01',language:'en',consent:true,preferences:{}};
 const a=await call('/api/start','POST',input),b=await call('/api/start','POST',input);
 assert.equal((await call('/api/calls/config','GET',null,a.cookie)).status,400);
 assert.equal((await call('/api/calls/config?callId='+randomUUID(),'GET',null,a.cookie)).status,404);
 const ringing=await call('/api/calls','POST',{type:'voice'},a.cookie);assert.equal(ringing.status,201);
 const route='/api/calls/config?callId='+ringing.data.id;
 assert.equal((await call(route,'GET',null,b.cookie)).status,404);
 const unavailable=await call(route,'GET',null,a.cookie);assert.equal(unavailable.status,503);assert.ok(!JSON.stringify(unavailable.data).includes('fixture-turn-key'));
 await call('/api/calls/'+ringing.data.id+'/end','POST',{reason:'cancelled'},a.cookie);
 assert.equal((await call(route,'GET',null,a.cookie)).status,404);
 }finally{await mf.dispose();}
});
