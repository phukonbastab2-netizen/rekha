import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker, { FunnelConversation, CloudApiControl, isOptOut, isPaymentConfirmation } from './worker.mjs';
import { firstSequence, mediaSequence, GAP, MEDIA_DELAY } from './funnel.mjs';

class Storage {
  data = new Map(); alarmAt = null;
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
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
  assert.equal(state.jobs.length, firstSequence.length);
  assert.ok(state.jobs.every((j) => j.state === 'accepted' && j.messageId));
  assert.equal(new Set(state.jobs.map((j) => j.id)).size, firstSequence.length);
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
  h.advance(MEDIA_DELAY); await h.object().alarm(); assert.equal(h.requests.length, firstSequence.length + 1);
});

test('reminder requires a later relevant question and is queued only once', async (t) => {
  const h = harness(t); await h.incoming(); await drain(h);
  await h.incoming('Thank you', 'wamid.thanks'); assert.equal((await h.state()).reminderScheduled, false);
  await h.incoming('How to send details?', 'wamid.question'); await h.incoming('What details?', 'wamid.question2');
  assert.equal((await h.state()).jobs.filter((j) => j.stage === 'reminder').length, 1);
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
