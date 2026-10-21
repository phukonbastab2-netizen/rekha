import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';import {passwordHash} from './owner-auth.mjs';
const fetch=(url,options={})=>new Promise((resolve,reject)=>{const req=http.request(url,options,res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('; '):v]))})));});req.on('error',reject);req.end(options.body);});
test('real HTTP login protects data and rejects cross-origin requests with HTTPS cookies',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-login-')),port=18442;
 const child=spawn(process.execPath,['oracle/rich-server.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port),SQLITE_PATH:path.join(dir,'test.sqlite'),ADMIN_TOKEN:'test',META_ACCESS_TOKEN:'test',FUNNEL_ORIGIN:'https://worker.invalid',WA_PHONE_NUMBER_ID:'1418201524705343',GRAPH_VERSION:'v25.0',OWNER_PASSWORD_HASH:await passwordHash('test-owner'),OWNER_SESSION_KEY:randomBytes(32).toString('hex'),PUBLIC_ORIGIN:'https://rekhaastrology.in',PUBLIC_BASE_PATH:'/manual-inbox'},stdio:['ignore','pipe','pipe']});
 let output='';child.stderr.on('data',c=>output+=c);await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error(output)));});
 t.after(async()=>{child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});
 const local='http://127.0.0.1:'+port,base=local+'/manual-inbox',headers={host:'rekhaastrology.in'};
 let r=await fetch(base+'/',{headers});assert.equal(r.status,200);assert.match(await r.text(),/id="password"/);assert.equal(r.headers.get('set-cookie'),null);
 for(const endpoint of ['/api/status','/api/chats','/api/messages','/api/media?message=x','/app.js'])assert.equal((await fetch(base+endpoint,{headers})).status,401);
 assert.equal((await fetch(base+'/auth/login',{method:'POST',headers:{...headers,'content-type':'application/json',origin:'https://evil.test'},body:'{}'})).status,403);
 r=await fetch(base+'/auth/login',{method:'POST',headers:{...headers,'content-type':'application/json',origin:'https://rekhaastrology.in'},body:JSON.stringify({password:'test-owner'})});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie');assert.match(cookie,/; Secure$/);assert.match(cookie,/Path=\/manual-inbox/);
 r=await fetch(base+'/api/chats',{headers:{...headers,cookie}});assert.equal(r.status,200);assert.deepEqual((await r.json()).chats,[]);
 assert.equal((await fetch(base+'/api/sync',{method:'POST',headers:{...headers,cookie,origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/status',{headers:{host:'foreign.test',cookie}})).status,403);
 assert.equal((await fetch(local+'/api/status',{headers:{...headers,cookie}})).status,404);
 r=await fetch(base+'/auth/logout',{method:'POST',headers:{...headers,cookie,origin:'https://rekhaastrology.in','content-type':'application/json'},body:'{}'});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Max-Age=0/);
});
