import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { createApp } from '../src/server.mjs';
import { configuration } from '../src/config.mjs';

const password='test-owner-password-astrorani';
async function fixture(t, options={}, dependencies={}) {
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'astrorani-test-'));
  const config={...configuration({ADMIN_PASSWORD:password,DATA_DIR:dataDir}),...options};
  const app=createApp(config,dependencies);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  config.origin=`http://127.0.0.1:${app.server.address().port}`;
  async function request(route,method='GET',body,cookie='',headers={}) {
    const response=await fetch(config.origin+route,{method,headers:{Origin:config.origin,'Content-Type':'application/json',Cookie:cookie,...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  const start=async(name='Asha', extra={})=>request('/api/start','POST',{name,dob:'1995-02-03',language:'en',consent:true,preferences:{},...extra});
  const owner=async()=>(await request('/api/admin/login','POST',{password})).cookie;
  const send=(cookie,body='How can I reflect on my career?',clientId=randomUUID())=>request('/api/messages','POST',{body,clientId},cookie);
  const mode=(id,ownerCookie,value)=>request(`/api/admin/conversations/${id}/mode`,'PATCH',{mode:value},ownerCookie);
  async function wait(cookie,predicate) {
    for(let i=0;i<100;i++){const result=await request('/api/chat','GET',undefined,cookie);if(predicate(result.data))return result.data;await new Promise(resolve=>setTimeout(resolve,15));}
    assert.fail('Expected chat state was not reached');
  }
  t.after(async()=>{await app.close();assert.equal(path.dirname(dataDir),path.resolve(os.tmpdir()));assert.ok(path.basename(dataDir).startsWith('astrorani-test-'));await rm(dataDir,{recursive:true,force:true});});
  return {app,config,request,start,owner,send,mode,wait,dataDir};
}

test('onboarding validates dates, age, consent, language and optional location',async t=>{
  const f=await fixture(t);
  for(const extra of [{dob:'2020-01-01'},{dob:'1995-02-30'},{dob:'0000-01-01'},{consent:false},{language:'not-supported'},{preferences:{location:{latitude:900,longitude:1}}}])assert.equal((await f.start('Asha',extra)).status,400);
  const response=await f.start('Asha',{preferences:{remember:true,location:{latitude:26.1445,longitude:91.7362}}});
  assert.equal(response.status,201);assert.equal(response.data.preferences.location.latitude,26.1);
  assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));assert.ok(response.headers.get('set-cookie').includes('SameSite=Strict'));
  assert.ok(!('mode' in response.data));assert.ok(!('token_hash' in response.data));
});

test('three free replies, server-enforced paywall, demo unlock and continued chat',async t=>{
  const f=await fixture(t),session=await f.start();
  for(let i=1;i<=3;i++){assert.equal((await f.send(session.cookie)).status,202);await f.wait(session.cookie,c=>c.freeUsed===i);}
  assert.equal((await f.send(session.cookie)).status,402);
  const paid=await f.request('/api/payment/demo','POST',{},session.cookie);
  assert.equal(paid.data.entitlement,'demo');assert.equal(paid.data.locked,false);
  assert.equal((await f.send(session.cookie)).status,202);await f.wait(session.cookie,c=>c.freeUsed===4);
});

test('owner endpoints, same-origin writes and customer sessions are isolated',async t=>{
  const f=await fixture(t),a=await f.start('Asha'),b=await f.start('Mira');
  assert.equal((await f.request('/api/admin/conversations')).status,401);
  assert.equal((await f.request('/api/admin/login','POST',{password:'wrong'})).status,401);
  assert.equal((await f.request('/api/messages','POST',{body:'Hello',clientId:randomUUID()},a.cookie,{Origin:'https://other.example'})).status,403);
  assert.equal((await f.request('/api/chat','GET',undefined,b.cookie)).data.name,'Mira');
  assert.equal((await f.request(`/api/admin/conversations/${a.data.id}`,'GET',undefined,b.cookie)).status,401);
  const owner=await f.owner();assert.equal((await f.request('/api/admin/conversations','GET',undefined,owner)).data.length,2);
});

test('manual mode remains private and sends only personal replies',async t=>{
  const f=await fixture(t),session=await f.start(),owner=await f.owner();
  assert.equal((await f.mode(session.data.id,owner,'manual')).status,200);
  await f.send(session.cookie);
  const current=(await f.request(`/api/admin/conversations/${session.data.id}`,'GET',undefined,owner)).data;
  const pending=current.messages.find(m=>m.status==='pending');
  assert.equal(current.messages.length,2);assert.equal(current.mode,'manual');
  assert.equal((await f.request(`/api/admin/conversations/${current.id}/reply`,'POST',{body:'I have read your question. Let us discuss your choices.',messageId:pending.id,version:current.version},owner)).status,200);
  const customer=(await f.request('/api/chat','GET',undefined,session.cookie)).data;
  assert.equal(customer.messages.at(-1).kind,'human');assert.equal(customer.freeUsed,1);
  assert.ok(!('mode' in customer));assert.ok(!customer.messages.some(m=>m.kind==='handoff'));
});

test('AI assist draft is private until owner edits and approves it',async t=>{
  const f=await fixture(t),session=await f.start(),owner=await f.owner();await f.mode(session.data.id,owner,'assist');await f.send(session.cookie);
  let current;for(let i=0;i<40;i++){current=(await f.request(`/api/admin/conversations/${session.data.id}`,'GET',undefined,owner)).data;if(current.draft)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(current.draft);const customer=(await f.request('/api/chat','GET',undefined,session.cookie)).data;
  assert.equal(customer.messages.length,2);assert.equal(customer.freeUsed,0);assert.ok(!('draft' in customer));
  const result=await f.request(`/api/admin/conversations/${current.id}/reply`,'POST',{body:'An edited, personally reviewed response.',messageId:current.draft.message_id,version:current.version},owner);
  assert.equal(result.data.messages.at(-1).body,'An edited, personally reviewed response.');assert.equal(result.data.draft,null);
  assert.equal((await f.request(`/api/admin/conversations/${current.id}/reply`,'POST',{body:'Duplicate',messageId:current.draft.message_id,version:current.version},owner)).status,409);
});

test('human takeover suppresses an already-running AI response',async t=>{
  let release;const hold=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{}, {generateReply:async()=>{await hold;return{body:'Stale automatic reply',kind:'ai'};}});
  const session=await f.start(),owner=await f.owner();await f.send(session.cookie);await f.mode(session.data.id,owner,'manual');release();
  await new Promise(resolve=>setTimeout(resolve,30));const current=(await f.request('/api/chat','GET',undefined,session.cookie)).data;
  assert.equal(current.messages.length,2);assert.ok(!current.messages.some(m=>m.body==='Stale automatic reply'));
});

test('customers can send consecutive messages and one owner reply resolves the waiting batch',async t=>{
  const f=await fixture(t),session=await f.start(),owner=await f.owner();await f.mode(session.data.id,owner,'manual');
  const nonce=randomUUID();await f.send(session.cookie,'Hello',nonce);
  assert.equal((await f.send(session.cookie,'Hello',nonce)).status,200);
  assert.equal((await f.send(session.cookie,'Another message')).status,202);
  assert.equal((await f.send(session.cookie,'One more detail')).status,202);
  const state=(await f.request('/api/chat','GET',undefined,session.cookie)).data;
  assert.equal(state.messages.length,4);assert.equal(state.freeUsed,0);
  assert.equal(state.messages.filter(m=>m.status==='pending').length,3);
  const current=(await f.request('/api/admin/conversations/'+session.data.id,'GET',undefined,owner)).data;
  const answer=await f.request('/api/admin/conversations/'+session.data.id+'/send','POST',{body:'Answer to all your details',version:current.version,clientId:randomUUID(),replyTo:current.messages.at(-1).id},owner);
  assert.equal(answer.status,201);assert.equal(answer.data.freeUsed,1);
  assert.equal(answer.data.messages.filter(m=>m.status==='pending').length,0);
});

test('provider failure does not consume free reply; retry recovers',async t=>{
  let calls=0;
  const f=await fixture(t,{}, {generateReply:async()=>{if(++calls===1)throw Error('private-provider-error');return{body:'Recovered answer',kind:'ai'};}});
  const session=await f.start();await f.send(session.cookie);const failed=await f.wait(session.cookie,c=>c.messages.some(m=>m.status==='failed'));
  assert.equal(failed.freeUsed,0);assert.ok(!JSON.stringify(failed).includes('private-provider-error'));
  await f.request('/api/retry','POST',{},session.cookie);const next=await f.wait(session.cookie,c=>c.freeUsed===1);assert.equal(next.messages.at(-1).body,'Recovered answer');
});

test('follow-up during generation is included in a fresh answer with one credit consumed',async t=>{
  let release,entered;const started=new Promise(resolve=>entered=resolve);let count=0;
  const f=await fixture(t,{}, {generateReply:async(_config,_chat,messages)=>{
    if(++count===1){entered();await new Promise(resolve=>release=resolve);}
    return {body:messages.filter(m=>m.role==='user').map(m=>m.body).join(' / '),kind:'ai'};
  }});
  const session=await f.start();await f.send(session.cookie,'First detail');await started;
  assert.equal((await f.send(session.cookie,'Second detail')).status,202);
  release();const state=await f.wait(session.cookie,c=>c.freeUsed===1);
  assert.equal(state.messages.at(-1).body,'First detail / Second detail');
  assert.equal(state.messages.filter(m=>m.role==='assistant').length,2);
  assert.equal(state.messages.filter(m=>m.status==='pending').length,0);
});

test('deletion cascades messages, orders and drafts and invalidates session',async t=>{
  const f=await fixture(t),session=await f.start(),owner=await f.owner();await f.mode(session.data.id,owner,'assist');await f.send(session.cookie);
  f.app.db.prepare('INSERT INTO orders(id,conversation_id,created) VALUES(?,?,?)').run('order-delete',session.data.id,Date.now());
  assert.equal((await f.request('/api/chat','DELETE',{},session.cookie)).status,200);
  assert.equal((await f.request('/api/chat','GET',undefined,session.cookie)).status,401);
  for(const table of ['conversations','messages','drafts','orders'])assert.equal(f.app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
});

function paymentFixture(){
  let status='authorized';
  return {config:{paymentMode:'razorpay',razorKey:'test-key',razorSecret:'test-secret',webhookSecret:'test-webhook-secret'},setStatus:value=>status=value,
    dependencies:{payments:{create:async()=>({id:`order_${randomUUID()}`,amount:4900,currency:'INR'}),fetchPayment:async id=>({id,order_id:paymentFixture.order,amount:4900,currency:'INR',status,captured:status==='captured'})}}};
}
const sign=(text,secret)=>createHmac('sha256',secret).update(text).digest('hex');

test('₹49 payment requires owned order, valid signature and server-confirmed capture',async t=>{
  const mock=paymentFixture(),f=await fixture(t,mock.config,mock.dependencies),session=await f.start(),other=await f.start('Mira');
  const order=(await f.request('/api/payment/order','POST',{},session.cookie)).data;paymentFixture.order=order.id;
  assert.equal(order.amount,4900);assert.equal(order.currency,'INR');
  assert.equal((await f.request('/api/payment/demo','POST',{},session.cookie)).status,404);
  const data={razorpay_order_id:order.id,razorpay_payment_id:'pay_1',razorpay_signature:'bad'};
  assert.equal((await f.request('/api/payment/verify','POST',data,session.cookie)).status,400);
  data.razorpay_signature=sign(`${order.id}|pay_1`,mock.config.razorSecret);
  assert.equal((await f.request('/api/payment/verify','POST',data,other.cookie)).status,400);
  assert.equal((await f.request('/api/payment/verify','POST',data,session.cookie)).status,409);
  mock.setStatus('captured');assert.equal((await f.request('/api/payment/verify','POST',data,session.cookie)).data.entitlement,'paid');
  await f.request('/api/payment/verify','POST',data,session.cookie);
  assert.equal((await f.request('/api/chat','GET',undefined,session.cookie)).data.messages.filter(m=>m.kind==='payment').length,1);
});

test('signed webhooks recover checkout, are idempotent, and full refund revokes unlock',async t=>{
  const mock=paymentFixture(),f=await fixture(t,mock.config,mock.dependencies),session=await f.start();
  const order=(await f.request('/api/payment/order','POST',{},session.cookie)).data;
  const body=JSON.stringify({event:'payment.captured',payload:{payment:{entity:{id:'pay_hook',order_id:order.id,status:'captured',captured:true,amount:4900,currency:'INR'}}}});
  assert.equal((await f.request('/api/payments/webhook','POST',body,'',{'x-razorpay-signature':'bad'})).status,400);
  const headers={'x-razorpay-signature':sign(body,mock.config.webhookSecret)};
  await f.request('/api/payments/webhook','POST',body,'',headers);await f.request('/api/payments/webhook','POST',body,'',headers);
  const current=(await f.request('/api/chat','GET',undefined,session.cookie)).data;assert.equal(current.entitlement,'paid');assert.equal(current.messages.filter(m=>m.kind==='payment').length,1);
  const refund=JSON.stringify({event:'refund.processed',payload:{refund:{entity:{payment_id:'pay_hook',amount:4900}}}});
  await f.request('/api/payments/webhook','POST',refund,'',{'x-razorpay-signature':sign(refund,mock.config.webhookSecret)});
  await f.request('/api/payments/webhook','POST',body,'',headers);
  assert.equal((await f.request('/api/chat','GET',undefined,session.cookie)).data.entitlement,'free');
});

test('production refuses demo providers and insecure origins',()=>{
  assert.throws(()=>configuration({ADMIN_PASSWORD:password,NODE_ENV:'production',PUBLIC_ORIGIN:'https://example.com'}),/Production requires/);
  assert.throws(()=>configuration({ADMIN_PASSWORD:'short'}),/16 characters/);
});

test('cookie removal and database persistence survive server restart',async t=>{
  const f=await fixture(t),session=await f.start();await f.send(session.cookie);await f.wait(session.cookie,c=>c.freeUsed===1);
  const second=createApp({...f.config});await new Promise(resolve=>second.server.listen(0,'127.0.0.1',resolve));
  try{const response=await fetch(`http://127.0.0.1:${second.server.address().port}/api/chat`,{headers:{Cookie:session.cookie}});const data=await response.json();assert.equal(data.freeUsed,1);assert.equal(data.name,'Asha');}finally{await second.close();}
  const removed=await f.request('/api/chat','DELETE',{},session.cookie);assert.ok(removed.headers.get('set-cookie').includes('Max-Age=0'));
});

test('demo entitlements cannot carry over to real payment configuration',async t=>{
  const f=await fixture(t),session=await f.start();await f.request('/api/payment/demo','POST',{},session.cookie);
  const second=createApp({...f.config,paymentMode:'razorpay'});
  try{assert.equal(second.db.prepare('SELECT entitlement FROM conversations WHERE id=?').get(session.data.id).entitlement,'free');}
  finally{await second.close();}
});

test('only allowlisted public assets are served; private files cannot be downloaded',async t=>{
  const f=await fixture(t);
  for(const route of ['/.env','/data/astrorani.sqlite','/src/server.mjs','/LOCAL-ACCESS.txt'])assert.equal((await f.request(route)).status,404);
  const icon=await fetch(f.config.origin+'/icon-192.png');assert.equal(icon.status,200);assert.ok(icon.headers.get('content-type').startsWith('image/png'));
  const manifest=await fetch(f.config.origin+'/manifest.webmanifest');assert.equal((await manifest.json()).icons.length,2);
});

test('owner follow-ups, collections and private media work without customer replies',async t=>{
  const f=await fixture(t),a=await f.owner(),start=await f.start(),id=start.data.id;
  let state=start.data;
  const sendOwner=async extra=>{
    const current=(await f.request('/api/admin/conversations/'+id,'GET',undefined,a)).data;
    return f.request('/api/admin/conversations/'+id+'/send','POST',{body:'A personal follow-up',version:current.version,clientId:randomUUID(),...extra},a);
  };
  const first=await sendOwner();assert.equal(first.status,201,JSON.stringify(first.data));
  assert.equal(first.data.mode,'manual');assert.equal(first.data.freeUsed,0);
  for(let i=0;i<4;i++)assert.equal((await sendOwner()).status,201);
  const key=randomUUID();await sendOwner({clientId:key});
  const count=(await f.request('/api/chat','GET',undefined,start.cookie)).data.messages.length;
  await sendOwner({clientId:key});assert.equal((await f.request('/api/chat','GET',undefined,start.cookie)).data.messages.length,count);
  const bytes=await (await import('node:fs/promises')).readFile(new URL('../public/icon-192.png',import.meta.url));
  const upload=await fetch(f.config.origin+'/api/admin/uploads?title=Portrait&category=testimonial',{method:'POST',headers:{Origin:f.config.origin,Cookie:a,'Content-Type':'image/png'},body:bytes});
  assert.equal(upload.status,201);const media=await upload.json();
  const readMedia=(cookie,range)=>fetch(f.config.origin+'/api/media/'+media.id,{headers:{Cookie:cookie,...(range?{Range:range}:{})}});
  assert.equal((await readMedia(start.cookie)).status,404);
  const collection=await f.request('/api/admin/collections','POST',{title:'Our stories',itemIds:[media.id]},a);
  assert.equal(collection.status,201);
  const sent=await sendOwner({collectionId:collection.data.id});assert.equal(sent.status,201);
  assert.equal(sent.data.freeUsed,0);
  assert.deepEqual(Buffer.from(await(await readMedia(start.cookie)).arrayBuffer()),bytes);
  const partial=await readMedia(start.cookie,'bytes=0-15');assert.equal(partial.status,206);assert.equal((await partial.arrayBuffer()).byteLength,16);
  const stranger=await f.start('Another customer');assert.equal((await readMedia(stranger.cookie)).status,404);
  assert.equal((await f.request('/api/admin/library','GET')).status,401);
  await f.send(start.cookie,'A question');
  const waiting=(await f.request('/api/chat','GET',undefined,start.cookie)).data.messages.at(-1);
  assert.equal((await sendOwner({replyTo:waiting.id})).data.freeUsed,1);
  assert.equal((await sendOwner()).data.freeUsed,1);
});
