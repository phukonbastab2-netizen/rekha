import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker, { FunnelConversation, CloudApiControl, isOptOut, isPaymentConfirmation } from './worker.mjs';
import { firstSequence, reminder, mediaSequence, GAP, REMINDER_DELAY, MEDIA_DELAY } from './funnel.mjs';

class Storage {
  data = new Map(); alarmAt = null;
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async list({prefix='',limit=1000}={}) { return new Map([...this.data].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit).map(([key,value])=>[key,structuredClone(value)])); }
  async setAlarm(time) { this.alarmAt = Number(time); }
  async deleteAlarm() { this.alarmAt = null; }
  async transaction(fn) {
    const previous = structuredClone(this.data);
    try { return await fn(this); } catch (error) { this.data = previous; throw error; }
  }
}

function namespace(factory) {
  const objects = new Map();
  return { objects, idFromName: (name) => name, get(name) {
    if (!objects.has(name)) objects.set(name, factory(name));
    const target = objects.get(name);
    return { fetch: (input, init) => target.fetch(new Request(input, init)) };
  } };
}

const phoneId = '123456789012345';
const waId = '919876543210';
function harness(t, overrides = {}) {
  let now = 1_792_300_000_000; let sent = 0; const requests = []; const waits = [];
  const previousFetch = globalThis.fetch, previousNow = Date.now;
  Date.now = () => now;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body); requests.push(payload);
    if (payload.status === 'read') return Response.json({ success: true });
    return Response.json({ messages: [{ id: `wamid.test${++sent}` }] });
  };
  t.after(() => { globalThis.fetch = previousFetch; Date.now = previousNow; });
  const env = { META_ACCESS_TOKEN: 'test_token', META_APP_SECRET: 'test_app_secret', META_VERIFY_TOKEN: 'test_verify', ADMIN_TOKEN: 'private_admin',
    WA_PHONE_NUMBER_ID: phoneId, GRAPH_VERSION: 'v23.0', SEND_ENABLED: 'true', SEND_EPOCH: 'activation-1', READ_ENABLED: 'false', ...overrides };
  env.CONTROL = namespace(() => new CloudApiControl({ storage: new Storage() }));
  env.CONVERSATIONS = namespace(() => new FunnelConversation({ storage: new Storage(), waitUntil: (promise) => waits.push(promise) }, env));
  const object = (number = waId) => { const name = `${phoneId}:${number}`; env.CONVERSATIONS.get(name); return env.CONVERSATIONS.objects.get(name); };
  const incoming = async (text = 'Hi', id = 'wamid.incoming1', fields = {}, number = waId) => object(number).fetch(new Request('https://conversation.internal/ingest', {
    method: 'POST', body: JSON.stringify({ kind: 'inbound', waId: number, id, type: 'text', text, timestamp: Math.floor(now / 1000), ...fields }),
  }));
  return { env, requests, waits, object, incoming, advance: (ms) => { now += ms; }, now: () => now, state: async (number) => object(number).storage.get('state') };
}

function payload(message = { from: waId, id: 'wamid.webhook1', type: 'text', text: { body: 'Hi' }, timestamp: '1792300000' }) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneId }, messages: [message] } }] }] };
}
function signedRequest(body, secret = 'test_app_secret', raw = JSON.stringify(body)) {
  return new Request('https://example.test/webhook', { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }, body: raw });
}
async function drain(h) {
  for (let i = 0; i < firstSequence.length; i++) { await h.object().alarm(); h.advance(GAP); }
}

test('owner conversation gate holds other leads and does not mark them read', async (t) => {
  const h=harness(t,{TEST_CONVERSATION_ID:'owner-test',READ_ENABLED:'true'});
  h.object().ctx.id={toString:()=> 'owner-test'};
  const other='919876540000';h.object(other).ctx.id={toString:()=> 'another-contact'};
  await h.incoming('Hi','wamid.owner-inbound');
  await h.incoming('Hi','wamid.other-inbound',{},other);
  await Promise.all(h.waits);
  assert.equal(h.requests.filter(x=>x.status==='read').length,1);
  assert.ok((await h.state()).jobs.every(x=>x.state==='pending'));
  assert.ok((await h.state(other)).jobs.every(x=>x.state==='held'));
  await h.object(other).alarm();
  await h.object().alarm();
  assert.equal(h.requests.filter(x=>x.type==='text').length,1);
  assert.equal(h.requests.find(x=>x.type==='text').to,waId);
});

test('owner gate blocks a previously pending contact at alarm execution', async (t) => {
  const h=harness(t);
  await h.incoming();
  h.env.TEST_CONVERSATION_ID='different-object';
  h.object().ctx.id={toString:()=> 'previous-contact'};
  await h.object().alarm();
  assert.equal(h.requests.length,0);
  assert.ok((await h.state()).jobs.every(x=>x.state==='held'));
});

test('owner gate also applies to manual read acknowledgments', async (t) => {
  const h=harness(t,{TEST_CONVERSATION_ID:'owner-test',READ_ENABLED:'true'});
  h.object().ctx.id={toString:()=> 'another-contact'};
  await h.incoming();await Promise.all(h.waits);
  const response=await h.object().fetch(new Request('https://conversation.internal/read-latest',{method:'POST'}));
  assert.equal(response.status,409);assert.equal(h.requests.length,0);
});

test('an explicit owner test uses only a recent real inbound and cannot replay accepted steps', async (t) => {
  const h=harness(t,{SEND_ENABLED:'false',TEST_CONVERSATION_ID:'owner-test'});
  h.object().ctx.id={toString:()=> 'owner-test'};
  const start=()=>h.object().fetch(new Request('https://conversation.internal/start-owner-test',{method:'POST'}));
  assert.equal((await start()).status,409);
  await h.incoming();h.env.SEND_ENABLED='true';
  assert.equal((await start()).status,200);await h.object().alarm();
  assert.equal(h.requests.length,1);
  assert.equal((await (await start()).json()).duplicate,true);
  assert.equal((await h.state()).jobs.filter(j=>j.state==='accepted').length,1);
  assert.equal(h.requests.length,1);
});

test('owner test cannot release another contact, stale inbound or a global pause', async (t) => {
  const h=harness(t,{SEND_ENABLED:'false',TEST_CONVERSATION_ID:'owner-test'});
  h.object().ctx.id={toString:()=> 'other'};await h.incoming();h.env.SEND_ENABLED='true';
  const start=()=>h.object().fetch(new Request('https://conversation.internal/start-owner-test',{method:'POST'}));
  assert.equal((await start()).status,409);
  h.object().ctx.id={toString:()=> 'owner-test'};h.advance(10*60*1000+1);
  assert.equal((await start()).status,409);
  h.env.SEND_ENABLED='false';await h.incoming('Hi','wamid.new-inbound');h.env.SEND_ENABLED='true';
  await h.env.CONTROL.get(`account:${phoneId}`).fetch('https://control.internal/pause',{method:'POST',body:JSON.stringify({reason:'owner_pause',at:h.now()})});
  assert.equal((await start()).status,409);
  assert.equal(h.requests.length,0);
});

test('owner test endpoint requires authentication and cannot retry a previously accepted first step', async (t) => {
  const h=harness(t,{TEST_CONVERSATION_ID:'a'.repeat(64)});
  h.object().ctx.id={toString:()=> 'a'.repeat(64)};await h.incoming();await h.object().alarm();
  h.env.CONVERSATIONS.idFromString=()=>`${phoneId}:${waId}`;
  const url='https://x.test/admin/start-owner-test',body=JSON.stringify({id:'a'.repeat(64)});
  assert.equal((await worker.fetch(new Request(url,{method:'POST',body}),h.env)).status,401);
  assert.equal((await worker.fetch(new Request(url,{method:'POST',headers:{Authorization:'Bearer private_admin'},body}),h.env)).status,409);
  assert.equal(h.requests.length,1);
});

test('a stored webhook exposes only its opaque object ID in authenticated recent receipts', async (t) => {
  const h=harness(t,{SEND_ENABLED:'false'}),objectId='b'.repeat(64);
  h.env.CONVERSATIONS.idFromName=()=>objectId;
  assert.equal((await worker.fetch(signedRequest(payload()),h.env)).status,200);
  const response=await worker.fetch(new Request('https://x.test/admin/status',{headers:{Authorization:'Bearer private_admin'}}),h.env);
  const value=await response.json();
  assert.deepEqual(value.account.ingestion.recentConversationIds,[objectId]);
  assert.equal(JSON.stringify(value).includes(waId),false);
  assert.equal((await worker.fetch(new Request('https://x.test/admin/status'),h.env)).status,401);
});

test('recent conversation lookup stays bounded and deduplicated under concurrent receipts', async () => {
  const control=new CloudApiControl({storage:new Storage()});
  const send=ids=>control.fetch(new Request('https://control.internal/receipt',{method:'POST',body:JSON.stringify({inbound:true,conversationIds:ids})}));
  const ids=Array.from({length:110},(_,i)=>i.toString(16).padStart(64,'0'));
  await Promise.all(ids.map(id=>send([id])));
  await send(['invalid',ids[20]]);
  const value=await(await control.fetch(new Request('https://control.internal/state'))).json();
  assert.equal(value.ingestion.recentConversationIds.length,100);
  assert.equal(new Set(value.ingestion.recentConversationIds).size,100);
  assert.equal(value.ingestion.recentConversationIds.at(-1),ids[20]);
  assert.equal(value.ingestion.recentConversationIds.includes('invalid'),false);
});

test('reviewed owner permission repair is single-use and only retries a definite unaccepted code 10', async (t) => {
  const h=harness(t,{SEND_ENABLED:'false',TEST_CONVERSATION_ID:'owner-test'});
  h.object().ctx.id={toString:()=> 'owner-test'};await h.incoming();h.env.SEND_ENABLED='true';
  await h.object().fetch(new Request('https://conversation.internal/start-owner-test',{method:'POST'}));
  const send=h.object().fetchImpl;
  h.object().fetchImpl=async()=>Response.json({error:{code:10}},{status:400});
  await h.object().alarm();assert.equal((await h.state()).jobs[0].state,'failed');
  const repair=()=>h.object().fetch(new Request('https://conversation.internal/repair-owner-permission-test',{method:'POST'}));
  assert.equal((await repair()).status,200);assert.equal((await repair()).status,409);
  h.object().fetchImpl=send;await h.object().alarm();
  assert.equal((await h.state()).jobs[0].state,'accepted');
  assert.equal((await h.state()).jobs[0].attempts,2);
  assert.equal((await h.state()).ownerPermissionRepair.previousError.code,10);
  assert.equal(h.requests.length,1);
});

test('permission repair rejects uncertainty, different provider errors and already accepted work', async (t) => {
  const h=harness(t,{SEND_ENABLED:'false',TEST_CONVERSATION_ID:'owner-test'});
  h.object().ctx.id={toString:()=> 'owner-test'};await h.incoming();h.env.SEND_ENABLED='true';
  await h.object().fetch(new Request('https://conversation.internal/start-owner-test',{method:'POST'}));
  const repair=()=>h.object().fetch(new Request('https://conversation.internal/repair-owner-permission-test',{method:'POST'}));
  for(const mutation of [
    {state:'uncertain',attempts:1,lastError:{code:10,status:400}},
    {state:'failed',attempts:1,lastError:{code:131037,status:400}},
    {state:'failed',attempts:1,lastError:{code:10,status:500}},
    {state:'failed',attempts:1,lastError:{code:10,status:400},messageId:'wamid.already-accepted'},
  ]){
    const state=await h.state();state.jobs[0]={...state.jobs[0],...mutation};await h.object().storage.put('state',state);
    assert.equal((await repair()).status,409);
  }
  assert.equal(h.requests.length,0);
});

test('webhook authenticates the raw body and exact configured number before persisting', async (t) => {
  const h = harness(t);
  assert.equal((await worker.fetch(signedRequest(payload(), 'wrong'), h.env)).status, 401);
  const wrong = payload(); wrong.entry[0].changes[0].value.metadata.phone_number_id = '333333333333333';
  assert.equal((await worker.fetch(signedRequest(wrong), h.env)).status, 403);
  assert.equal(h.env.CONVERSATIONS.objects.size, 0);
  assert.equal((await worker.fetch(signedRequest(payload()), h.env)).status, 200);
  assert.equal((await h.state()).jobs.length, firstSequence.length);
  assert.ok(await h.object().storage.get('inbound:wamid.webhook1'));
});

test('webhook rejects oversized payload before parsing or sending', async (t) => {
  const h = harness(t);
  const response = await worker.fetch(signedRequest({}, 'test_app_secret', 'x'.repeat(270_000)), h.env);
  assert.equal(response.status, 413); assert.equal(h.requests.length, 0);
});

test('private status proves a persisted inbound webhook without disclosing the customer', async (t) => {
  const h = harness(t, { SEND_ENABLED: 'false' });
  assert.equal((await worker.fetch(signedRequest(payload()), h.env)).status, 200);
  const response = await worker.fetch(new Request('https://x.test/admin/status', { headers: { authorization: 'Bearer private_admin' } }), h.env);
  const raw = await response.text(), status = JSON.parse(raw);
  assert.equal(status.account.ingestion.lastInboundAt, h.now());
  assert.equal(status.sendEnabled, false);
  assert.equal(raw.includes(waId), false);
  assert.equal(raw.includes('wamid.webhook1'), false);
  assert.equal(h.requests.length, 0);
});

test('a receipt-recording failure requests redelivery without duplicating the saved funnel', async (t) => {
  const h = harness(t, { SEND_ENABLED: 'false' });
  const original = h.env.CONTROL.get.bind(h.env.CONTROL);
  h.env.CONTROL.get = name => ({ fetch: async (url, init) => new URL(url).pathname === '/receipt'
    ? new Response('unavailable', { status: 503 }) : original(name).fetch(url, init) });
  assert.equal((await worker.fetch(signedRequest(payload()), h.env)).status, 503);
  h.env.CONTROL.get = original;
  assert.equal((await worker.fetch(signedRequest(payload()), h.env)).status, 200);
  assert.equal((await h.state()).jobs.length, firstSequence.length);
  assert.equal(h.requests.length, 0);
});

test('owner-only receipt inspection is read-only and excludes customer text and number', async (t) => {
  const h = harness(t, { SEND_ENABLED: 'false' });
  await h.incoming('private customer text');
  const objectId = 'a'.repeat(64);
  h.env.CONVERSATIONS.idFromString = id => { assert.equal(id, objectId); return `${phoneId}:${waId}`; };
  const url = 'https://x.test/admin/conversation-status?id='+objectId;
  assert.equal((await worker.fetch(new Request(url), h.env)).status, 401);
  const before = await h.state();
  const response = await worker.fetch(new Request(url, { headers: { authorization: 'Bearer private_admin' } }), h.env);
  const raw = await response.text(), value = JSON.parse(raw);
  assert.equal(value.found, true); assert.equal(value.lastInboundAt, h.now());
  assert.equal(raw.includes(waId), false); assert.equal(raw.includes('private customer text'), false);
  assert.deepEqual(await h.state(), before); assert.equal(h.requests.length, 0);
});

test('sender preserves the global fetch receiver required by Workers', async (t) => {
  const h = harness(t);
  globalThis.fetch = function () {
    assert.equal(this, globalThis, 'Illegal invocation: incorrect fetch receiver');
    return Promise.resolve(Response.json({ messages: [{ id: 'wamid.bound-fetch' }] }));
  };
  await h.incoming(); await h.object().alarm();
  assert.equal((await h.state()).jobs[0].state, 'accepted');
});

test('enabling read receipts can mark the existing latest inbound without sending or replaying messages', async (t) => {
  const h = harness(t); await h.incoming(); h.env.READ_ENABLED='true';
  const before=await h.state();
  const response=await h.object().fetch(new Request('https://conversation.internal/read-latest',{method:'POST'}));
  assert.deepEqual(await response.json(),{read:true});
  assert.equal(h.requests.length,1); assert.equal(h.requests[0].status,'read');
  assert.equal(h.requests[0].message_id,'wamid.incoming1');
  assert.deepEqual((await h.state()).jobs,before.jobs);
  await h.object().fetch(new Request('https://conversation.internal/read-latest',{method:'POST'}));
  assert.equal(h.requests.length,1);
});

test('reviewed local validation repair is limited to its object and epoch and cannot send by itself', async (t) => {
  const h = harness(t);
  const object = h.object(); object.ctx.id = { toString: () => 'reviewed-owner-object' };
  object.fetchImpl = async () => { throw new TypeError('Invalid redirect value'); };
  await h.incoming(); await object.alarm();
  assert.equal((await h.state()).jobs[0].state, 'uncertain');
  h.env.LOCAL_REDIRECT_REPAIR = JSON.stringify({ objectId:'another-object', epoch:'activation-1' });
  await object.load(); assert.equal((await h.state()).jobs[0].state, 'uncertain');
  h.env.LOCAL_REDIRECT_REPAIR = JSON.stringify({ objectId:'reviewed-owner-object', epoch:'another-epoch' });
  await object.load(); assert.equal((await h.state()).jobs[0].state, 'uncertain');
  h.env.LOCAL_REDIRECT_REPAIR = JSON.stringify({ objectId:'reviewed-owner-object', epoch:'activation-1' });
  await object.load(); await object.alarm();
  assert.ok((await h.state()).jobs.every(j => j.state === 'held'));
  assert.equal((await h.state()).jobs[0].reconciliation, 'unsupported_redirect_rejected_before_network');
  assert.equal(h.requests.length, 0);
});

test('Meta verification uses its separate token; private preflight requires owner token', async (t) => {
  const h = harness(t);
  assert.equal((await worker.fetch(new Request('https://x.test/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=abc'), h.env)).status, 403);
  const response = await worker.fetch(new Request('https://x.test/webhook?hub.mode=subscribe&hub.verify_token=test_verify&hub.challenge=abc'), h.env);
  assert.equal(await response.text(), 'abc');
  assert.equal((await worker.fetch(new Request('https://x.test/admin/preflight'), h.env)).status, 401);
  const privateResult = await worker.fetch(new Request('https://x.test/admin/preflight', { headers: { authorization: 'Bearer private_admin' } }), h.env);
  const text = await privateResult.text();
  assert.equal(privateResult.status, 200); assert.equal(text.includes('test_token'), false); assert.equal(text.includes(phoneId), false);
  const publicResult = await worker.fetch(new Request('https://x.test/health'), h.env);
  assert.deepEqual(await publicResult.json(), { ok: true, service: 'rekha-whatsapp-cloud-api' });
});

test('a persistence failure returns 503 so Meta can retry; dedup is durable across restarts', async (t) => {
  const h = harness(t);
  const storage = h.object().storage;
  const original = storage.transaction.bind(storage);
  storage.transaction = async () => { throw new Error('disk failed'); };
  assert.equal((await worker.fetch(signedRequest(payload()), h.env)).status, 503);
  storage.transaction = original;
  assert.equal((await worker.fetch(signedRequest(payload()), h.env)).status, 200);
  const restarted = new FunnelConversation({ storage, waitUntil() {} }, h.env);
  const response = await restarted.fetch(new Request('https://conversation.internal/ingest', { method: 'POST', body: JSON.stringify({ kind: 'inbound', waId, id: 'wamid.webhook1', type: 'text', text: 'Hi', timestamp: h.now() / 1000 }) }));
  assert.equal((await response.json()).duplicate, true);
  assert.equal((await storage.get('state')).jobs.length, firstSequence.length);
});

test('five first steps send one at a time with stable IDs and five second spacing', async (t) => {
  const h = harness(t); await h.incoming();
  await h.object().alarm(); await h.object().alarm();
  assert.equal(h.requests.length, 1);
  for (let i = 1; i < firstSequence.length; i++) { h.advance(GAP); await h.object().alarm(); }
  await h.incoming('Hi again', 'wamid.incoming2'); await h.object().alarm();
  const state = await h.state();
  assert.equal(h.requests.length, firstSequence.length);
  const first = state.jobs.filter(j => j.stage === 'first');
  assert.equal(first.length, firstSequence.length);
  assert.ok(first.every((j) => j.state === 'accepted' && j.messageId));
  assert.equal(new Set(first.map((j) => j.id)).size, firstSequence.length);
  assert.equal(state.jobs.filter(j => j.stage === 'reminder').length, 1);
});

test('disabled sends persist held work; an enable requires a fresh inbound to release it', async (t) => {
  const h = harness(t, { SEND_ENABLED: 'false' }); await h.incoming(); await h.object().alarm();
  assert.equal(h.requests.length, 0); assert.ok((await h.state()).jobs.every((j) => j.state === 'held'));
  h.env.SEND_ENABLED = 'true'; h.env.SEND_EPOCH = 'activation-2'; await h.object().alarm();
  assert.equal(h.requests.length, 0);
  await h.incoming('Hi', 'wamid.incoming2'); await h.object().alarm();
  assert.equal(h.requests.length, 1);
});

test('activation epoch changes quarantine a previously queued backlog', async (t) => {
  const h = harness(t); await h.incoming(); h.env.SEND_EPOCH = 'activation-2'; await h.object().alarm();
  assert.equal(h.requests.length, 0); assert.ok((await h.state()).jobs.every((j) => j.state === 'held'));
  await h.incoming('Hi', 'wamid.fresh'); await h.object().alarm(); assert.equal(h.requests.length, 1);
});

test('old incoming events cannot start and an expired 24 hour window holds pending steps', async (t) => {
  const h = harness(t); await h.incoming('Hi', 'wamid.old', { timestamp: (h.now() - 25 * 3600000) / 1000 });
  assert.equal((await h.state()).jobs.length, 0);
  await h.incoming('Hi', 'wamid.fresh'); await h.object().alarm();
  h.advance(24 * 3600000); await h.object().alarm();
  assert.equal(h.requests.length, 1); assert.equal((await h.state()).jobs[1].reason, 'service_window_expired');
});

test('future timestamps cannot extend the service window into the future', async (t) => {
  const h = harness(t); await h.incoming('Hi', 'wamid.future', { timestamp: (h.now() + 365 * 24 * 3600000) / 1000 });
  assert.equal((await h.state()).lastInboundAt, h.now());
  h.advance(24 * 3600000); await h.object().alarm(); assert.equal(h.requests.length, 0);
});

test('ordinary stop phrases cancel work permanently even after later messages', async (t) => {
  const h = harness(t); await h.incoming(); await h.incoming('please stop messaging', 'wamid.stop');
  await h.object().alarm(); await h.incoming('Hi', 'wamid.afterstop'); await h.object().alarm();
  assert.equal(h.requests.length, 0); assert.equal((await h.state()).optedOut, true);
  for (const text of ['STOP', 'message mat karo', 'नहीं चाहिए', 'मैसेज मत भेजो', 'no thanks']) assert.equal(isOptOut(text), true, text);
});

test('audio, stickers and unrelated media cannot trigger the payment followup', async (t) => {
  const h = harness(t); await h.incoming(); await drain(h);
  for (const type of ['audio', 'sticker', 'video', 'document']) await h.incoming('', `wamid.${type}`, { type });
  await h.incoming('payment nahi kiya', 'wamid.unpaid');
  const state = await h.state(); assert.equal(state.mediaScheduled, false); assert.equal(state.paymentState, 'none');
  assert.equal(isPaymentConfirmation('payment not done'), false);
  assert.equal(isPaymentConfirmation('payment kar diya'), true);
});

test('explicit payment report schedules original one hour followup once without marking verified', async (t) => {
  const h = harness(t); await h.incoming(); await drain(h);
  const reportAt = h.now();
  await h.incoming('payment done', 'wamid.payment'); await h.incoming('payment done', 'wamid.payment2');
  const state = await h.state();
  assert.equal(state.paymentState, 'customer_reported_pending_review');
  assert.equal(state.jobs.filter((j) => j.stage === 'payment_followup').length, mediaSequence.length);
  assert.equal(state.jobs.find((j) => j.stage === 'payment_followup').dueAt, reportAt + MEDIA_DELAY);
  await h.object().alarm(); assert.equal(h.requests.length, firstSequence.length);
  h.advance(REMINDER_DELAY); await h.object().alarm(); assert.equal(h.requests.length, firstSequence.length + 1);
  assert.equal(h.requests.at(-1).text.body, reminder.body);
  h.advance(MEDIA_DELAY - REMINDER_DELAY); await h.object().alarm(); assert.equal(h.requests.length, firstSequence.length + 2);
  assert.equal(h.requests.at(-1).image.link, mediaSequence[0].url);
});

test('any later customer reply queues the original reminder once, never automatically', async (t) => {
  const h = harness(t); await h.incoming(); await drain(h);
  h.advance(REMINDER_DELAY); await h.object().alarm();
  assert.equal((await h.state()).reminderScheduled, false);
  assert.equal(h.requests.length, 5);
  await h.incoming('Namaste', 'wamid.namaste');
  const due = (await h.state()).jobs.find(j => j.stage === 'reminder').dueAt;
  await h.incoming('01/01/1990', 'wamid.dob'); await h.incoming('Thank you', 'wamid.thanks');
  assert.equal((await h.state()).jobs.filter((j) => j.stage === 'reminder').length, 1);
  assert.equal((await h.state()).jobs.find(j => j.stage === 'reminder').dueAt, due);
  h.advance(REMINDER_DELAY - 1); await h.object().alarm(); assert.equal(h.requests.length, 5);
  h.advance(1); await h.object().alarm(); assert.equal(h.requests.at(-1).text.body, reminder.body);
  await h.incoming('Hi again', 'wamid.afterreminder'); h.advance(REMINDER_DELAY); await h.object().alarm();
  assert.equal(h.requests.length, 6);
});

test('ambiguous network outcome blocks the contact; redelivery and new inbound never resend it', async (t) => {
  const h = harness(t); await h.incoming();
  let calls = 0; h.object().fetchImpl = async () => { calls++; throw new Error('network lost after send'); };
  await h.object().alarm(); await h.object().alarm(); await h.incoming('Hello?', 'wamid.hello'); await h.object().alarm();
  assert.equal(calls, 1); assert.equal((await h.state()).jobs[0].state, 'uncertain');
});

test('restart after an interrupted send preserves uncertainty and cannot auto retry', async (t) => {
  const h = harness(t); await h.incoming();
  const state = await h.state(); state.jobs[0].state = 'sending'; state.jobs[0].attempts = 1; await h.object().storage.put('state', state);
  const restarted = new FunnelConversation({ storage: h.object().storage, waitUntil() {} }, h.env);
  await restarted.alarm();
  assert.equal((await h.state()).jobs[0].state, 'uncertain'); assert.equal(h.requests.length, 0);
});

test('only definite throttle rejection retries with bounded attempts and same job ID', async (t) => {
  const h = harness(t); await h.incoming();
  let attempts = 0; h.object().fetchImpl = async () => { attempts++; return Response.json({ error: { code: 130429 } }, { status: 429, headers: { 'retry-after': '1' } }); };
  for (let i = 0; i < 5; i++) { await h.object().alarm(); h.advance(120000); }
  const state = await h.state(); assert.equal(attempts, 4); assert.equal(state.jobs[0].state, 'failed'); assert.equal(state.jobs[0].id, 'first:0');
});

test('provider restriction blocks all customers through the durable account control', async (t) => {
  const h = harness(t); await h.incoming(); await h.incoming('Hi', 'wamid.other', {}, '919000000001');
  h.object().fetchImpl = async () => Response.json({ error: { code: 131031 } }, { status: 400 });
  await h.object().alarm(); await h.object('919000000001').alarm();
  assert.equal((await h.state()).restricted, true); assert.equal(h.requests.length, 0);
  assert.equal((await h.state('919000000001')).jobs[0].reason, 'account_paused');
  const response = await worker.fetch(new Request('https://x.test/admin/status', { headers: { authorization: 'Bearer private_admin' } }), h.env);
  assert.equal((await response.json()).account.reason, 'provider_restriction');
});

test('STOP arriving while a send awaits cannot be overwritten by a stale send result', async (t) => {
  const h = harness(t); await h.incoming();
  let resolveSend, started; const startedPromise = new Promise((resolve) => { started = resolve; });
  h.object().fetchImpl = async () => { started(); return new Promise((resolve) => { resolveSend = resolve; }); };
  const sending = h.object().alarm(); await startedPromise;
  const stopping = h.incoming('STOP', 'wamid.stop');
  resolveSend(Response.json({ messages: [{ id: 'wamid.inflight' }] }));
  await Promise.all([sending, stopping]); await h.object().alarm();
  const state = await h.state(); assert.equal(state.optedOut, true); assert.equal(state.jobs[0].state, 'accepted');
  assert.ok(state.jobs.slice(1).every((j) => j.state === 'cancelled'));
});

test('status receipts never start messages and delivery statuses cannot regress', async (t) => {
  const h = harness(t); await h.incoming(); await h.object().alarm();
  assert.equal((await h.state()).jobs[0].delivery, 'accepted');
  const sendStatus = (status) => h.object().fetch(new Request('https://conversation.internal/ingest', { method: 'POST', body: JSON.stringify({ kind: 'status', waId, id: 'wamid.test1', status, errors: [] }) }));
  await sendStatus('read'); await sendStatus('sent');
  assert.equal((await h.state()).jobs[0].delivery, 'read'); assert.equal((await h.state()).jobs.length, firstSequence.length);
});

test('owner pause persists and never enables sends through an unauthenticated route', async (t) => {
  const h = harness(t); await h.incoming();
  assert.equal((await worker.fetch(new Request('https://x.test/admin/pause', { method: 'POST' }), h.env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://x.test/admin/pause', { method: 'POST', headers: { authorization: 'Bearer private_admin' } }), h.env)).status, 200);
  await h.object().alarm(); assert.equal(h.requests.length, 0);
  assert.equal((await worker.fetch(new Request('https://x.test/admin/resume', { method: 'POST', headers: { authorization: 'Bearer private_admin' } }), h.env)).status, 404);
});

test('redelivery repairs an alarm scheduling failure after the inbound was committed', async (t) => {
  const h = harness(t); const storage = h.object().storage;
  const setAlarm = storage.setAlarm.bind(storage);
  storage.setAlarm = async () => { throw new Error('alarm unavailable'); };
  assert.equal((await worker.fetch(signedRequest(payload()), h.env)).status, 503);
  assert.ok(await storage.get('inbound:wamid.webhook1'));
  storage.setAlarm = setAlarm;
  assert.equal((await worker.fetch(signedRequest(payload()), h.env)).status, 200);
  assert.ok(storage.alarmAt); assert.equal((await h.state()).jobs.length, firstSequence.length);
  await h.object().alarm(); assert.equal(h.requests.length, 1);
});

test('optional read receipts do not create messages and respect the global pause', async (t) => {
  const h = harness(t, { READ_ENABLED: 'true' });
  await h.incoming(); await Promise.all(h.waits);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].status, 'read');
  assert.equal((await h.state()).jobs.filter((j) => j.state === 'accepted').length, 0);
  await worker.fetch(new Request('https://x.test/admin/pause', { method: 'POST', headers: { authorization: 'Bearer private_admin' } }), h.env);
  await h.incoming('Hi', 'wamid.new'); await Promise.all(h.waits);
  assert.equal(h.requests.length, 1);
});

test('restriction found by a read receipt also durably stops account sends', async (t) => {
  const h = harness(t, { READ_ENABLED: 'true' });
  h.object().fetchImpl = async () => Response.json({ error: { code: 131031 } }, { status: 400 });
  await h.incoming(); await Promise.all(h.waits); await h.object().alarm();
  assert.equal((await h.state()).restricted, true);
  const response = await worker.fetch(new Request('https://x.test/admin/status', { headers: { authorization: 'Bearer private_admin' } }), h.env);
  assert.equal((await response.json()).account.paused, true);
});

test('changing sender credentials never releases another sender backlog', async (t) => {
  const h = harness(t); await h.incoming();
  h.env.WA_PHONE_NUMBER_ID = '999999999999999';
  await h.object().alarm();
  assert.equal(h.requests.length, 0);
  assert.equal((await h.state()).jobs[0].reason, 'sender_mismatch');
  assert.equal((await h.incoming('Hi', 'wamid.newsender')).status, 409);
  const restarted = new FunnelConversation({ storage: h.object().storage }, h.env);
  await restarted.alarm(); assert.equal(h.requests.length, 0);
});

test('a restriction response with an uncertain outcome stays uncertain and pauses everyone', async (t) => {
  const h = harness(t); await h.incoming();
  h.object().fetchImpl = async () => Response.json({ error: { code: 131031 } }, { status: 503 });
  await h.object().alarm(); await h.object().alarm();
  assert.equal((await h.state()).jobs[0].state, 'uncertain');
  const response = await worker.fetch(new Request('https://x.test/admin/status', { headers: { authorization: 'Bearer private_admin' } }), h.env);
  assert.equal((await response.json()).account.paused, true);
});

test('an image schedules the original one-hour followup once, pending manual payment review', async (t) => {
  const h = harness(t); await h.incoming(); await drain(h);
  const at = h.now();
  await h.incoming('', 'wamid.photo', { type: 'image' });
  await h.incoming('', 'wamid.photoagain', { type: 'image' });
  const state = await h.state();
  assert.equal(state.paymentState, 'customer_reported_pending_review');
  const followup = state.jobs.filter(job => job.stage === 'payment_followup');
  assert.equal(followup.length, mediaSequence.length);
  assert.equal(followup[0].dueAt, at + MEDIA_DELAY);
});

test('media-only new leads enroll once; a first image also schedules its delayed followup', async (t) => {
  const h = harness(t);
  for (const [index, type] of ['image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts'].entries()) {
    const number = `91900000000${index}`;
    await h.incoming('', `wamid.first-${type}`, { type }, number);
    await h.incoming('', `wamid.first-${type}`, { type }, number);
    const state = await h.state(number);
    assert.equal(state.firstStarted, true, type);
    assert.equal(state.jobs.filter(j => j.stage === 'first').length, 5, type);
    assert.equal(state.mediaScheduled, type === 'image', type);
    assert.equal(state.reminderScheduled, false, type);
    await h.object(number).alarm();
    assert.equal(h.requests.at(-1).text.body, firstSequence[0].body);
  }
  await h.incoming('', 'wamid.reaction', { type: 'reaction' });
  await h.incoming('', 'wamid.system', { type: 'system' });
  assert.equal((await h.state()).firstStarted, false);
});

test('an initial payment report enrolls the lead and schedules followup without claiming verification', async (t) => {
  const h = harness(t); await h.incoming('payment done');
  const state = await h.state();
  assert.equal(state.jobs.filter(j => j.stage === 'first').length, 5);
  assert.equal(state.jobs.filter(j => j.stage === 'payment_followup').length, 4);
  assert.equal(state.paymentState, 'customer_reported_pending_review');
  assert.equal(state.reminderScheduled, false);
});

test('an early image cannot block the later one-minute reminder behind the one-hour media jobs', async (t) => {
  const h = harness(t); const photoAt = h.now();
  await h.incoming('', 'wamid.firstphoto', { type: 'image' });
  await drain(h);
  await h.incoming('My name', 'wamid.name');
  assert.equal(h.object().storage.alarmAt, h.now() + REMINDER_DELAY);
  h.advance(REMINDER_DELAY); await h.object().alarm();
  assert.equal(h.requests.length, 6); assert.equal(h.requests.at(-1).text.body, reminder.body);
  assert.equal(h.object().storage.alarmAt, photoAt + MEDIA_DELAY);
  h.advance(photoAt + MEDIA_DELAY - h.now()); await h.object().alarm();
  assert.equal(h.requests.at(-1).image.link, mediaSequence[0].url);
});

test('the complete ten-message flow survives concurrent duplicates, restarts and repeated replies', async (t) => {
  const h = harness(t);
  const restart = () => {
    const name = `${phoneId}:${waId}`, storage = h.object().storage;
    h.env.CONVERSATIONS.objects.set(name, new FunnelConversation({ storage, waitUntil() {} }, h.env));
  };
  await Promise.all(Array.from({ length: 8 }, () => h.incoming('Hi', 'wamid.start')));
  await drain(h);
  assert.deepEqual(h.requests.map(p => p.type), ['text', 'video', 'video', 'image', 'text']);
  restart();
  await Promise.all(Array.from({ length: 6 }, (_, i) => h.incoming('Namaste', `wamid.reply${i}`)));
  h.advance(REMINDER_DELAY); await h.object().alarm(); await h.object().alarm();
  assert.equal(h.requests.length, 6); assert.equal(h.requests[5].text.body, reminder.body);
  const photoAt = h.now();
  await Promise.all(Array.from({ length: 6 }, () => h.incoming('', 'wamid.proof', { type: 'image' })));
  await h.incoming('payment done', 'wamid.payment-again');
  restart();
  h.advance(MEDIA_DELAY - 1); await h.object().alarm(); assert.equal(h.requests.length, 6);
  h.advance(1);
  for (const step of mediaSequence) {
    await h.object().alarm(); await h.object().alarm();
    assert.equal(h.requests.at(-1)[step.type].link, step.url);
    h.advance(GAP); restart();
  }
  for (let i = 0; i < 5; i++) { await h.incoming('Namaste', `wamid.after${i}`); await h.object().alarm(); }
  const state = await h.state();
  assert.equal(h.requests.length, 10);
  assert.equal(state.jobs.length, 10); assert.equal(new Set(state.jobs.map(j => j.id)).size, 10);
  assert.ok(state.jobs.every(j => j.state === 'accepted' && j.attempts === 1));
  assert.equal(state.jobs.find(j => j.stage === 'payment_followup').acceptedAt, photoAt + MEDIA_DELAY);
  for (let i = 1; i < state.jobs.length; i++) assert.ok(state.jobs[i].acceptedAt - state.jobs[i - 1].acceptedAt >= GAP);
  for (const job of state.jobs) {
    await h.object().fetch(new Request('https://conversation.internal/ingest', { method: 'POST', body: JSON.stringify({ kind: 'status', waId, id: job.messageId, status: 'read' }) }));
    await h.object().fetch(new Request('https://conversation.internal/ingest', { method: 'POST', body: JSON.stringify({ kind: 'status', waId, id: job.messageId, status: 'sent' }) }));
  }
  assert.ok((await h.state()).jobs.every(j => j.delivery === 'read'));
  assert.equal(h.object().storage.alarmAt, null);
});

test('opting out after the first five cancels both the reminder and delayed media', async (t) => {
  const h = harness(t); await h.incoming(); await drain(h);
  await h.incoming('', 'wamid.proof', { type: 'image' });
  await h.incoming('STOP', 'wamid.stop'); h.advance(MEDIA_DELAY); await h.object().alarm();
  assert.equal(h.requests.length, 5);
  assert.ok((await h.state()).jobs.filter(j => j.stage !== 'first').every(j => j.state === 'cancelled'));
});

test('late confirmed delivery resolves a failure without replaying its accepted step', async (t) => {
  const h = harness(t); await h.incoming(); await h.object().alarm();
  const messageId = (await h.state()).jobs[0].messageId;
  const receipt = status => h.object().fetch(new Request('https://conversation.internal/ingest', {
    method: 'POST', body: JSON.stringify({ kind: 'status', waId, id: messageId, status, errors: [{ code: 131026 }] }),
  }));
  await receipt('failed'); h.advance(GAP); await h.object().alarm(); assert.equal(h.requests.length, 1);
  await receipt('sent'); await h.object().alarm(); assert.equal(h.requests.length, 1);
  assert.equal((await h.state()).deliveryBlocked, true);
  await receipt('delivered'); await h.object().alarm(); assert.equal(h.requests.length, 2);
  const state = await h.state();
  assert.equal(state.deliveryBlocked, false); assert.equal(state.jobs[0].delivery, 'delivered');
  assert.equal(state.jobs[0].attempts, 1); assert.equal(h.requests[1].type, 'video');
});

test('display-name rejection preserves all work and pauses sending for every contact', async (t) => {
  const h = harness(t); await h.incoming();
  let calls = 0;
  h.object().fetchImpl = async () => { calls++; return Response.json({ error: { code: 131037 } }, { status: 400 }); };
  await h.object().alarm(); await h.object().alarm();
  const state = await h.state();
  assert.ok(state.jobs.every(j => j.state === 'held'));
  assert.equal(state.jobs[0].reason, 'display_name_approval_required');
  assert.equal(state.nameApprovalRequired, true); assert.equal(state.jobs[0].attempts, 1);
  await h.incoming('Hi', 'wamid.new-lead', {}, '919000000001');
  await h.object('919000000001').alarm();
  assert.ok((await h.state('919000000001')).jobs.every(j => j.state === 'held'));
  const result = await worker.fetch(new Request('https://x.test/admin/status', { headers: { authorization: 'Bearer private_admin' } }), h.env);
  assert.equal((await result.json()).account.reason, 'display_name_approval_required');
  assert.equal(calls, 1); assert.equal(h.requests.length, 0);
});

test('existing rejected reminders migrate to an approval hold without replaying the first five', async (t) => {
  const h = harness(t); await h.incoming(); await drain(h);
  await h.incoming('', 'wamid.proof', { type: 'image' });
  const state = await h.state(); const job = state.jobs.find(j => j.stage === 'reminder');
  job.state = 'failed'; job.attempts = 1; job.lastError = { code: 131037, status: 400, at: h.now() };
  await h.object().storage.put('state', state);
  const restarted = new FunnelConversation({ storage: h.object().storage, waitUntil() {} }, h.env);
  await restarted.alarm();
  const migrated = await h.state();
  assert.equal(migrated.jobs.find(j => j.stage === 'reminder').state, 'held');
  assert.equal(migrated.jobs.filter(j => j.stage === 'payment_followup' && j.state === 'held').length, 4);
  assert.ok(migrated.jobs.filter(j => j.stage === 'first').every(j => j.state === 'accepted'));
  assert.equal(h.requests.length, 5); assert.equal(migrated.pendingRestrictionFlag, undefined);
});

test('signed incoming media keeps its private media ID and caption in the existing inbound record', async(t)=>{
 const h=harness(t);const body=payload({from:waId,id:'wamid.photo',type:'image',image:{id:'12345678',mime_type:'image/jpeg',caption:'Payment screenshot'},timestamp:String(h.now()/1000)});
 assert.equal((await worker.fetch(signedRequest(body),h.env)).status,200);
 const saved=await h.object().storage.get('inbound:wamid.photo');assert.equal(saved.media.id,'12345678');assert.equal(saved.media.caption,'Payment screenshot');assert.equal((await h.state()).paymentState,'customer_reported_pending_review');
});

test('unknown owner-message receipts are bounded and never enroll or replay the funnel',async(t)=>{
 const h=harness(t);for(let i=0;i<140;i++)await h.object().ingest({kind:'status',waId,id:'wamid.owner'+i,status:'delivered'});
 const state=await h.state();assert.equal(state.firstStarted,false);assert.equal(state.jobs.length,0);assert.equal(Object.keys(state.ownerReceipts).length,128);assert.equal(h.requests.length,0);
 await h.object().ingest({kind:'status',waId,id:'wamid.owner139',status:'read'});await h.object().ingest({kind:'status',waId,id:'wamid.owner139',status:'sent'});assert.equal((await h.state()).ownerReceipts['wamid.owner139'].status,'read');
});

test('changed-contact revision is piggybacked on the existing account ingestion record',async(t)=>{
 const h=harness(t),id='a'.repeat(64);const stub=h.env.CONTROL.get('account:'+phoneId);
 await stub.fetch('https://control.internal/receipt',{method:'POST',body:JSON.stringify({inbound:true,conversationIds:[id]})});
 const first=await(await stub.fetch('https://control.internal/state')).json();assert.equal(first.ingestion.recentConversationUpdates[id],h.now());h.advance(3000);
 await stub.fetch('https://control.internal/receipt',{method:'POST',body:JSON.stringify({status:true,conversationIds:[id]})});const second=await(await stub.fetch('https://control.internal/state')).json();assert.equal(second.ingestion.recentConversationUpdates[id],h.now());assert.equal(second.ingestion.recentConversationIds.length,1);
});
