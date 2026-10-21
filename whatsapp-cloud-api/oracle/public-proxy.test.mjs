import {test} from 'node:test';import assert from 'node:assert/strict';import proxy from './public-proxy.mjs';
const env={ORACLE_INBOX_ORIGIN:'https://inbox-origin.rekhaastrology.in'};
test('proxy is limited to the separate owner page and fixed Oracle hostname',async()=>{
 const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('unexpected');};
 try{for(const url of ['https://rekhaastrology.in/','https://rekhaastrology.in/manual-inbox-other','https://foreign.test/manual-inbox/api/chats'])assert.equal((await proxy.fetch(new Request(url),env)).status,404);
 assert.equal((await proxy.fetch(new Request('https://rekhaastrology.in/manual-inbox/'),{ORACLE_INBOX_ORIGIN:'https://foreign.test'})).status,503);assert.equal(calls,0);
 const redirect=await proxy.fetch(new Request('https://rekhaastrology.in/manual-inbox'),env);assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'https://rekhaastrology.in/manual-inbox/');
 }finally{globalThis.fetch=old;}
});
test('proxy streams login to fixed origin and preserves secure path-scoped session cookie',async()=>{
 const old=globalThis.fetch;globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://inbox-origin.rekhaastrology.in/manual-inbox/auth/login');assert.equal(init.method,'POST');assert.equal(init.headers.get('origin'),'https://rekhaastrology.in');assert.equal(init.headers.get('x-forwarded-host'),null);assert.equal(init.redirect,'manual');return new Response('{"ok":true}',{headers:{'set-cookie':'rekha_owner=test; Path=/manual-inbox; HttpOnly; Secure; SameSite=Strict'}});};
 try{const response=await proxy.fetch(new Request('https://rekhaastrology.in/manual-inbox/auth/login',{method:'POST',headers:{origin:'https://rekhaastrology.in','x-forwarded-host':'foreign.test'},body:'{}'}),env);assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow');}finally{globalThis.fetch=old;}
});
