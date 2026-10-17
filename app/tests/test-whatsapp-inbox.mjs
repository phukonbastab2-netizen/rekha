// Actual bundled owner proxy with isolated D1 and a fake internal WhatsApp service.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {splitSqlStatements} from '../cloudflare/sql-statements.mjs';
const origin='https://owner.test',secret='fixture-server-secret',password='fixture-owner-password';
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{
 name:'app',modules:true,script:fs.readFileSync('cloudflare/worker-bundle.mjs','utf8'),compatibilityDate:'2026-09-24',d1Databases:{DB:'whatsapp-proxy-'+randomUUID()},bindings:{WHATSAPP_ADMIN_TOKEN:secret,ADMIN_PASSWORD_HASH:createHash('sha256').update(password).digest('hex')},serviceBindings:{WHATSAPP_LEADS:'fake-whatsapp'},outboundService:()=>{throw Error('External network forbidden.');}
},{name:'fake-whatsapp',modules:true,compatibilityDate:'2026-09-24',script:`export default {async fetch(request){if(request.headers.get('Authorization')!=='Bearer ${secret}')return new Response('Bad internal auth',{status:401});const url=new URL(request.url);return Response.json({path:url.pathname,search:url.search,body:await request.text(),range:request.headers.get('Range')},{status:202});}};`}]}));
try{
 const db=await mf.getD1Database('DB','app');for(const sql of splitSqlStatements(fs.readFileSync('cloudflare/schema.sql','utf8')))await db.prepare(sql).run();
 const endpoint=origin+'/api/admin/whatsapp/contacts',request=(path,method='GET',body,cookie,requestOrigin=origin)=>mf.dispatchFetch(path,{method,headers:{Origin:requestOrigin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await request(endpoint)).status,401);
 const login=await request(origin+'/api/admin/login','POST',{password});assert.equal(login.status,200);const cookie=login.headers.get('Set-Cookie').split(';')[0];
 const list=await request(endpoint+'?search=%E0%A4%B0', 'GET',null,cookie);assert.equal(list.status,202);assert.equal(list.headers.get('Cache-Control'),'no-store');const data=await list.json();assert.equal(data.path,'/owner/contacts');assert.equal(new URLSearchParams(data.search).get('search'),'र');assert.ok(!JSON.stringify(data).includes(secret));
 const send=await request(endpoint+'/919999999999/send','POST',{text:'नमस्ते',clientId:randomUUID()},cookie);assert.equal(send.status,202);assert.equal(JSON.parse((await send.json()).body).text,'नमस्ते');
 assert.equal((await request(endpoint+'/919999999999/send','POST',{text:'forged'},cookie,'https://other.test')).status,403);
 const media=await mf.dispatchFetch(origin+'/api/admin/whatsapp/media/123456789',{headers:{Cookie:cookie,Range:'bytes=2-4'}});assert.equal((await media.json()).range,'bytes=2-4');
 await request(origin+'/api/admin/logout','POST',{},cookie);assert.equal((await request(endpoint,'GET',null,cookie)).status,401);
 for(const name of ['whatsapp-admin.js','whatsapp-admin.css'])assert.equal((await request(origin+'/'+name)).status,200);
 console.log('WhatsApp owner login isolation, internal-only credential, CSRF, text, range and logout checks passed.');
}finally{await mf.dispose();}
