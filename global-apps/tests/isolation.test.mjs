import{execFileSync}from'node:child_process';import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{createHash,randomUUID}from'node:crypto';import{namespaceSql,scopeEnvironment}from'../backend/isolation.mjs';
test('app identifiers are rewritten without changing literals or bound values',()=>{
 assert.equal(namespaceSql("SELECT conversations.id FROM conversations WHERE name='conversations' -- conversations\n",'g01_',['conversations']),"SELECT g01_conversations.id FROM g01_conversations WHERE name='conversations' -- conversations\n");
 assert.throws(()=>namespaceSql('SELECT 1','customer_prefix',['conversations']));
 const keys=[];const env={DB:{prepare:s=>s,batch:s=>s},MEDIA:{put:k=>keys.push(k),get:k=>keys.push(k),head:k=>keys.push(k),delete:k=>keys.push(k)}};
 const scoped=scopeEnvironment(env,'g02_',['conversations']);scoped.MEDIA.put('library/example');scoped.MEDIA.delete(['a','b']);assert.deepEqual(keys,['global-connected/g02_/library/example',['global-connected/g02_/a','global-connected/g02_/b']]);
});
test('two connected apps share infrastructure without sharing customer or owner sessions',async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import(process.env.MINIFLARE_MODULE||'miniflare');
 const dir=process.env.CONNECTED_OUTPUT||path.resolve('connected');if(!fs.existsSync(path.join(dir,'schema.sql')))execFileSync(process.execPath,['scripts/connected.mjs'],{env:{...process.env,CONNECTED_OUTPUT:dir}});
 const ids=['luna-harbor','willow-moon'];const password='local-isolation-fixture';
 const script=fs.readFileSync(path.join(dir,ids[0],'worker.mjs'),'utf8').replace('return connectedWorker.fetch(request,scopeEnvironment(env,"g01_",','return connectedWorker.fetch(request,scopeEnvironment(env,new URL(request.url).hostname.startsWith("luna")?"g01_":"g02_",');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-09-24',d1Databases:{DB:'shared-test'},r2Buckets:{MEDIA:'shared-test'},bindings:{ADMIN_PASSWORD_HASH:createHash('sha256').update(password).digest('hex'),AI_MODE:'manual'}}));
 try{const db=await mf.getD1Database('DB');for(const sql of fs.readFileSync(path.join(dir,'schema.sql'),'utf8').split(';').filter(s=>s.trim()))await db.prepare(sql).run();

 async function call(i,route,method='GET',body,cookie=''){const origin='https://'+ids[i]+'.test';const r=await mf.dispatchFetch(origin+route,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,cookie:r.headers.get('Set-Cookie')?.split(';')[0],data:await r.json()};}
 const input={name:'Disposable isolation fixture',dob:'1990-01-01',language:'en',consent:true,preferences:{}};
 const a=await call(0,'/api/start','POST',input),b=await call(1,'/api/start','POST',input);assert.equal(a.status,201,JSON.stringify(a.data));assert.equal(b.status,201,JSON.stringify(b.data));
 assert.equal((await call(1,'/api/chat','GET',null,a.cookie)).status,401);
 const owner=await call(0,'/api/admin/login','POST',{password});assert.equal(owner.status,200);assert.equal((await call(1,'/api/admin/conversations','GET',null,owner.cookie)).status,401);
 assert.equal((await call(0,'/api/messages','POST',{body:'Only app one',clientId:randomUUID()},a.cookie)).status,202);
 assert.equal((await call(1,'/api/chat','GET',null,b.cookie)).data.messages.some(m=>m.body==='Only app one'),false);
 const badOrigin=await mf.dispatchFetch('https://luna-harbor.test/api/messages',{method:'POST',headers:{Origin:'https://willow-moon.test','Content-Type':'application/json',Cookie:a.cookie},body:JSON.stringify({body:'Wrong origin',clientId:randomUUID()})});assert.equal(badOrigin.status,403);
 }finally{await mf.dispose();}
});
