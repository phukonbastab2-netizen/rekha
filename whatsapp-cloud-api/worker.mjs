import { firstSequence, reminder, mediaSequence, GAP, REMINDER_DELAY, MEDIA_DELAY } from './funnel.mjs';
import { verifyWebhookSignature, sendCloudMessage, markCloudMessageRead } from './transport.mjs';

const DAY = 24 * 60 * 60 * 1000;
const MAX_BODY = 256 * 1024;
const MAX_ATTEMPTS = 4;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const isTrue = (value) => String(value).toLowerCase() === 'true';
const digits = (value) => /^\d{6,20}$/.test(String(value || ''));
const restrictedCodes = new Set([368, 131031, 131048]);

function enabled(env) { return isTrue(env.SEND_ENABLED) && Boolean(env.SEND_EPOCH); }
function ready(env) { return Boolean(env.META_ACCESS_TOKEN && digits(env.WA_PHONE_NUMBER_ID) && /^v\d+\.\d+$/.test(env.GRAPH_VERSION || '')); }
async function control(env, action = 'state', payload) {
  if (!env.CONTROL) throw new Error('control_unavailable');
  const stub = env.CONTROL.get(env.CONTROL.idFromName(`account:${env.WA_PHONE_NUMBER_ID}`));
  const response = await stub.fetch(`https://control.internal/${action}`, { method: payload ? 'POST' : 'GET', ...(payload ? { body: JSON.stringify(payload) } : {}) });
  if (!response.ok) throw new Error('control_unavailable');
  return response.json();
}
async function equalSecret(a, b) {
  const hash = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text))));
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  let diff = 0; for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function boundedBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw Object.assign(new Error('too_large'), { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size = 0; const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw Object.assign(new Error('too_large'), { status: 413 }); }
    chunks.push(value);
  }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

function textOf(message) {
  if (message.type === 'text') return String(message.text?.body || '').slice(0, 4096);
  if (message.type === 'button') return String(message.button?.text || '').slice(0, 4096);
  if (message.type === 'interactive') return String(message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '').slice(0, 4096);
  return '';
}

export function isOptOut(text) {
  const t = String(text || '').normalize('NFKC').trim().toLowerCase().replace(/[.!?,।]+/g, ' ').replace(/\s+/g, ' ');
  return /^(stop|unsubscribe|cancel|quit|no|no thanks|not interested|nahi|nahin|nhi|नहीं|नही|बंद|बन्द)(\b|\s|$)/u.test(t)
    || /\b(please stop|stop messaging|do not message|don't message|dont message|do not contact|don't contact|dont contact|message mat karo|msg mat karo|mat bhejo|band karo|nahi chahiye|nhi chahiye|nahin chahiye)\b/u.test(t)
    || /(मैसेज मत|मेसेज मत|संदेश मत|मैसेज बंद|मेसेज बंद|संदेश बंद|नहीं चाहिए|नही चाहिए|रुचि नहीं|मुझे नहीं)/u.test(t);
}

export function isPaymentConfirmation(text) {
  const t = String(text || '').normalize('NFKC').toLowerCase();
  if (/\b(not|haven't|havent|didn't|didnt|unpaid|nahi|nahin|nhi)\b/u.test(t) || /(नहीं|नही|न किया|मत)/u.test(t)) return false;
  return /\b(i have paid|i paid|payment (done|sent|completed|successful)|paid (rs\.?\s*)?29|29\s*(rs|rupees)?\s*(paid|sent)|payment (kar diya|ho gaya|kiya)|paise (bhej diye|bhej diya))\b/u.test(t)
    || /(पेमेंट (कर दिया|कर दी|हो गया|हो गई)|भुगतान (कर दिया|कर दी|हो गया)|पैसे भेज दिए|पैसे भेज दिये|₹\s*29\s*(भेज|दे दिए))/u.test(t);
}

function isRelevantQuestion(text) {
  return /[?？]|\b(help|how|what|details|detail|payment|pay|kundli|reading|video|kaise|kya|bataye|bataiye|samajh|29)\b|कैसे|क्या|बताइए|बताएं|विवरण|कुंडली|पेमेंट|भुगतान/iu.test(text);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, service: 'rekha-whatsapp-cloud-api' });
    if (['/admin/preflight', '/admin/status', '/admin/pause', '/admin/conversation-status', '/admin/transport-check', '/admin/read-latest'].includes(url.pathname)) {
      const auth = request.headers.get('authorization') || '';
      if (!env.ADMIN_TOKEN || !auth.startsWith('Bearer ') || !await equalSecret(auth.slice(7), env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
      if (url.pathname === '/admin/read-latest') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        let value; try { value = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
        if (!/^[a-f0-9]{64}$/i.test(value.id || '')) return json({ error: 'invalid_object_id' }, 400);
        try {
          const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromString(value.id));
          const result = await stub.fetch('https://conversation.internal/read-latest', { method: 'POST' });
          return json(await result.json(), result.status);
        } catch { return json({ error: 'storage_unavailable' }, 503); }
      }
      if (url.pathname === '/admin/transport-check') {
        if (request.method !== 'GET' || !ready(env)) return json({ error: 'not_ready' }, 409);
        const target = `https://graph.facebook.com/${env.GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}?fields=id`;
        const init = () => ({ headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(10000), redirect: 'manual' });
        let unboundStatus = null, unboundReceiverError = false;
        try { const unbound = globalThis.fetch; unboundStatus = (await unbound(target, init())).status; }
        catch (error) { unboundReceiverError = /illegal invocation|incorrect.*this|receiver/i.test(String(error?.message)); }
        let boundStatus = null, boundContentType = null;
        try {
          const response = await globalThis.fetch(target, init());
          boundStatus = response.status; boundContentType = response.headers.get('content-type');
          const value = await response.json();
          return json({ unboundStatus, unboundReceiverError, boundStatus: response.status, boundPhoneMatches: value.id === env.WA_PHONE_NUMBER_ID });
        } catch (error) {
          const diagnostic = String(error?.message || 'Unknown error').replaceAll(env.META_ACCESS_TOKEN, '[hidden]').replace(/https?:\/\/\S+/g, '[url]').slice(0,250);
          return json({ unboundStatus, unboundReceiverError, boundStatus, boundContentType, boundRequestFailed: true, diagnostic }, 502);
        }
      }
      if (url.pathname === '/admin/conversation-status') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        const objectId = url.searchParams.get('id') || '';
        if (!/^[a-f0-9]{64}$/i.test(objectId)) return json({ error: 'invalid_object_id' }, 400);
        try {
          const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromString(objectId));
          const result = await stub.fetch('https://conversation.internal/summary');
          return json(await result.json(), result.status);
        } catch { return json({ error: 'storage_unavailable' }, 503); }
      }
      if (url.pathname === '/admin/pause' && request.method === 'POST') {
        try { return json(await control(env, 'pause', { reason: 'owner_pause', at: Date.now() })); } catch { return json({ error: 'control_unavailable' }, 503); }
      }
      if (request.method !== 'GET' || url.pathname === '/admin/pause') return json({ error: 'method_not_allowed' }, 405);
      let account; try { account = await control(env); } catch { account = { paused: true, reason: 'control_unavailable' }; }
      return json({ service: 'rekha-whatsapp-cloud-api', sendEnabled: enabled(env), readEnabled: isTrue(env.READ_ENABLED), configured: {
        accessToken: Boolean(env.META_ACCESS_TOKEN), appSecret: Boolean(env.META_APP_SECRET), verifyToken: Boolean(env.META_VERIFY_TOKEN),
        phoneNumber: digits(env.WA_PHONE_NUMBER_ID), graphVersion: /^v\d+\.\d+$/.test(env.GRAPH_VERSION || ''), conversations: Boolean(env.CONVERSATIONS), control: Boolean(env.CONTROL), sendEpoch: Boolean(env.SEND_EPOCH),
      }, readyForConnection: ready(env) && Boolean(env.META_APP_SECRET && env.META_VERIFY_TOKEN && env.CONVERSATIONS && env.CONTROL), account, automaticBacklogRelease: false });
    }
    if (url.pathname !== '/webhook') return json({ error: 'not_found' }, 404);
    if (request.method === 'GET') {
      if (!env.META_VERIFY_TOKEN) return json({ error: 'not_configured' }, 503);
      if (url.searchParams.get('hub.mode') !== 'subscribe' || !await equalSecret(url.searchParams.get('hub.verify_token') || '', env.META_VERIFY_TOKEN)) return json({ error: 'verification_failed' }, 403);
      const challenge = url.searchParams.get('hub.challenge');
      if (!challenge || challenge.length > 2048) return json({ error: 'invalid_challenge' }, 400);
      return new Response(challenge, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!env.META_APP_SECRET || !digits(env.WA_PHONE_NUMBER_ID) || !env.CONVERSATIONS) return json({ error: 'not_configured' }, 503);
    let raw, body;
    try { raw = await boundedBody(request); } catch (error) { return json({ error: error.status === 413 ? 'payload_too_large' : 'invalid_body' }, error.status || 400); }
    if (!await verifyWebhookSignature(raw, request.headers.get('x-hub-signature-256'), env.META_APP_SECRET)) return json({ error: 'signature_failed' }, 401);
    try { body = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400); }
    if (body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return json({ error: 'invalid_event' }, 400);
    const events = [];
    for (const entry of body.entry) {
      for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        if (String(value?.metadata?.phone_number_id || '') !== String(env.WA_PHONE_NUMBER_ID)) return json({ error: 'phone_number_mismatch' }, 403);
        for (const message of Array.isArray(value.messages) ? value.messages : []) {
          if (!digits(message.from) || !message.id || String(message.id).length > 512) continue;
          events.push({ kind: 'inbound', waId: String(message.from), id: String(message.id), type: String(message.type || 'unknown'), text: textOf(message), timestamp: message.timestamp });
        }
        for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
          if (!digits(status.recipient_id) || !status.id || String(status.id).length > 512) continue;
          if (!['sent', 'delivered', 'read', 'failed', 'deleted'].includes(status.status)) continue;
          events.push({ kind: 'status', waId: String(status.recipient_id), id: String(status.id), status: status.status, timestamp: status.timestamp,
            errors: (Array.isArray(status.errors) ? status.errors : []).map((e) => ({ code: Number(e.code) })).slice(0, 10) });
        }
      }
    }
    try {
      for (const event of events) {
        const id = env.CONVERSATIONS.idFromName(`${env.WA_PHONE_NUMBER_ID}:${event.waId}`);
        const response = await env.CONVERSATIONS.get(id).fetch('https://conversation.internal/ingest', { method: 'POST', body: JSON.stringify(event) });
        if (!response.ok) throw new Error('persistence_failed');
      }
      if (events.length) await control(env, 'receipt', {
        inbound: events.some(event => event.kind === 'inbound'),
        status: events.some(event => event.kind === 'status'),
      });
    } catch { return json({ error: 'persistence_unavailable' }, 503); }
    return json({ received: true });
  },
};

function initialState(phoneNumberId) {
  return { version: 1, phoneNumberId, waId: '', lastInboundAt: 0, optedOut: false, restricted: false, firstStarted: false, reminderScheduled: false, mediaScheduled: false, paymentState: 'none', nextOrder: 0, jobs: [], lastAcceptedAt: 0 };
}

export class FunnelConversation {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.storage = ctx.storage; this.serial = Promise.resolve(); this.loaded = false; this.fetchImpl = globalThis.fetch.bind(globalThis);
  }
  exclusive(fn) {
    const result = this.serial.then(fn); this.serial = result.catch(() => {}); return result;
  }
  async load() {
    const state = await this.storage.get('state') || initialState(this.env.WA_PHONE_NUMBER_ID);
    // Owner-reviewed repair for a specific local validation failure. A matching
    // object and activation are required; generic network uncertainty stays held.
    let repair; try { repair = JSON.parse(this.env.LOCAL_REDIRECT_REPAIR || 'null'); } catch { repair = null; }
    if (repair && this.ctx.id?.toString() === repair.objectId && state.phoneNumberId === this.env.WA_PHONE_NUMBER_ID) {
      const job = state.jobs.find(j => j.id === 'first:0');
      if (job?.state === 'uncertain' && job.epoch === repair.epoch && job.attempts === 1 && !job.messageId
        && job.lastError?.code === 'NETWORK_ERROR' && !job.lastError.status && !state.restricted
        && state.jobs.every(j => j.state !== 'accepted' && !j.messageId)) {
        job.state = 'held'; job.epoch = null; job.reason = 'local_validation_error_corrected';
        job.reconciledAt = Date.now(); job.reconciliation = 'unsupported_redirect_rejected_before_network';
        for (const next of state.jobs) if (['pending','retry'].includes(next.state)) {
          next.state = 'held'; next.epoch = null; next.reason = 'awaiting_fresh_inbound_after_local_repair';
        }
        await this.storage.put('state', state);
      }
    }
    if (!this.loaded) {
      this.loaded = true;
      let changed = false;
      for (const job of state.jobs) if (job.state === 'sending') { job.state = 'uncertain'; job.reason = 'interrupted_attempt'; changed = true; }
      if (changed) await this.storage.put('state', state);
    }
    return state;
  }
  async checkSender(state) {
    if (state.phoneNumberId === this.env.WA_PHONE_NUMBER_ID) return true;
    for (const job of state.jobs) if (['pending', 'retry', 'held'].includes(job.state)) { job.state = 'held'; job.reason = 'sender_mismatch'; }
    await this.storage.put('state', state); await this.storage.deleteAlarm();
    return false;
  }
  async fetch(request) {
    if (request.method === 'POST' && new URL(request.url).pathname === '/read-latest') return this.exclusive(async () => {
      const state = await this.load();
      if (!await this.checkSender(state) || !ready(this.env) || !isTrue(this.env.READ_ENABLED)
        || state.optedOut || state.restricted || Date.now()-state.lastInboundAt >= DAY || (await control(this.env)).paused) return json({ read: false, reason: 'not_available' }, 409);
      const entries = await this.storage.list({ prefix: 'inbound:', limit: 128 });
      const latest = [...entries].filter(([,value])=>value.eventAt===state.lastInboundAt).pop();
      if (!latest) return json({ read: false, reason: 'latest_message_not_available' }, 409);
      const messageId = latest[0].slice('inbound:'.length);
      if (state.lastReadMessageId === messageId) return json({ read: true, alreadyMarked: true });
      try {
        await markCloudMessageRead({ token: this.env.META_ACCESS_TOKEN, phoneNumberId: this.env.WA_PHONE_NUMBER_ID, graphVersion: this.env.GRAPH_VERSION, messageId, fetchImpl: this.fetchImpl });
        state.lastReadMessageId = messageId; state.lastReadAt = Date.now(); await this.storage.put('state',state);
        return json({ read: true });
      } catch(error) {
        if (error.isRestriction) { state.restricted=true; state.pendingRestrictionFlag={reason:'provider_restriction',code:error.code??null,at:Date.now()};await this.storage.put('state',state);await this.propagateRestriction(state); }
        return json({ read: false, errorCode: error.code??null }, 502);
      }
    });
    if (request.method === 'GET' && new URL(request.url).pathname === '/summary') return this.exclusive(async () => {
      const state = await this.load();
      if (!state || state.phoneNumberId !== this.env.WA_PHONE_NUMBER_ID) return json({ found: false });
      return json({ found: true, lastInboundAt: state.lastInboundAt, firstStarted: state.firstStarted,
        optedOut: state.optedOut, restricted: state.restricted,
        jobs: state.jobs.map(({ stage, state: status, delivery, reason, lastError, deliveryFailure }) => ({ stage, status, delivery, reason,
          ...(lastError ? { errorCode: lastError.code, httpStatus: lastError.status } : {}),
          ...(deliveryFailure?.length ? { deliveryErrorCodes: deliveryFailure.map(e => e.code) } : {}),
        })),
      });
    });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/ingest') return json({ error: 'not_found' }, 404);
    let event; try { event = await request.json(); } catch { return json({ error: 'invalid_event' }, 400); }
    return this.exclusive(() => this.ingest(event));
  }
  async ingest(event) {
    if (!digits(event.waId) || !event.id || !['inbound', 'status'].includes(event.kind)) return json({ error: 'invalid_event' }, 400);
    const state = await this.load();
    if (!await this.checkSender(state)) return json({ error: 'sender_mismatch' }, 409);
    if (state.waId && state.waId !== event.waId) return json({ error: 'conversation_mismatch' }, 409);
    state.waId = event.waId;
    if (event.kind === 'status') {
      const job = state.jobs.find((j) => j.messageId === event.id);
      if (job) {
        const ranks = { sent: 1, delivered: 2, read: 3 };
        if ((ranks[event.status] || 0) > (ranks[job.delivery] || 0)) job.delivery = event.status;
        if (event.status === 'failed' && !['delivered', 'read'].includes(job.delivery)) { job.delivery = 'failed'; job.deliveryFailure = event.errors || []; state.deliveryBlocked = true; }
      }
      const restriction = event.status === 'failed' && event.errors?.find((e) => restrictedCodes.has(Number(e.code)));
      if (restriction) { state.restricted = true; state.pendingRestrictionFlag = { reason: 'provider_restriction', code: restriction.code, at: Date.now() }; }
      await this.storage.put('state', state);
      await this.propagateRestriction(state);
      await this.schedule(state);
      return json({ stored: true });
    }
    const eventKey = `inbound:${event.id}`;
    if (await this.storage.get(eventKey)) {
      // A previous invocation may have committed the event before an alarm
      // scheduling error. Redelivery repairs that alarm without new jobs.
      await this.schedule(state);
      return json({ stored: true, duplicate: true });
    }
    const now = Date.now();
    const suppliedTime = Number(event.timestamp) * 1000;
    const eventAt = Number.isFinite(suppliedTime) && suppliedTime > 0 ? Math.min(suppliedTime, now) : 0;
    const fresh = eventAt > 0 && now - eventAt < DAY;
    const text = String(event.text || '').slice(0, 4096);
    if (fresh) state.lastInboundAt = Math.max(state.lastInboundAt, eventAt);
    const decline = isOptOut(text);
    if (decline) {
      state.optedOut = true; state.optedOutAt = now;
      for (const job of state.jobs) if (['pending', 'held', 'retry'].includes(job.state)) { job.state = 'cancelled'; job.reason = 'customer_opt_out'; }
    } else if (fresh && !state.optedOut && !state.restricted) {
      const active = enabled(this.env) && ready(this.env);
      if (active) for (const job of state.jobs) if (['held', 'pending', 'retry'].includes(job.state)) { job.state = 'pending'; job.epoch = this.env.SEND_EPOCH; job.authorizedAt = eventAt; }
      if (text && !state.firstStarted) {
        state.firstStarted = true;
        this.addSequence(state, 'first', firstSequence, now, active, eventAt);
      } else if (state.firstStarted) {
        if ((event.type === 'image' || isPaymentConfirmation(text)) && !state.mediaScheduled) {
          state.paymentState = 'customer_reported_pending_review'; state.paymentReportedAt = eventAt; state.mediaScheduled = true;
          this.addSequence(state, 'payment_followup', mediaSequence, now + MEDIA_DELAY, active, eventAt);
        } else if (!state.reminderScheduled && !state.mediaScheduled && state.jobs.filter((j) => j.stage === 'first').every((j) => j.state === 'accepted') && isRelevantQuestion(text)) {
          state.reminderScheduled = true;
          this.addSequence(state, 'reminder', [reminder], now + REMINDER_DELAY, active, eventAt);
        }
      }
    }
    // State and the incoming ID commit together before acknowledging Meta.
    await this.storage.transaction(async (tx) => {
      await tx.put('state', state);
      await tx.put(eventKey, { type: event.type, text, eventAt, receivedAt: now });
    });
    await this.schedule(state);
    if (fresh && !decline && !state.optedOut && !state.restricted && enabled(this.env) && ready(this.env) && isTrue(this.env.READ_ENABLED)) {
      const work = this.exclusive(async () => {
        try {
          if ((await control(this.env)).paused) return;
          await markCloudMessageRead({ token: this.env.META_ACCESS_TOKEN, phoneNumberId: this.env.WA_PHONE_NUMBER_ID, graphVersion: this.env.GRAPH_VERSION, messageId: event.id, fetchImpl: this.fetchImpl });
        } catch (error) {
          if (!error.isRestriction) return;
          const current = await this.load();
          current.restricted = true; current.pendingRestrictionFlag = { reason: 'provider_restriction', code: error.code ?? null, at: Date.now() };
          await this.storage.put('state', current); await this.propagateRestriction(current); await this.schedule(current);
        }
      }).catch(() => {});
      this.ctx.waitUntil?.(work);
    }
    return json({ stored: true });
  }
  addSequence(state, stage, steps, dueAt, active, authorizedAt) {
    for (let index = 0; index < steps.length; index++) state.jobs.push({ id: `${stage}:${index}`, stage, step: steps[index], order: state.nextOrder++, state: active ? 'pending' : 'held', dueAt, epoch: active ? this.env.SEND_EPOCH : null, authorizedAt, attempts: 0 });
  }
  blocked(state) { return state.optedOut || state.restricted || state.deliveryBlocked || state.jobs.some((j) => ['uncertain', 'failed', 'sending'].includes(j.state)); }
  async propagateRestriction(state) {
    if (!state.pendingRestrictionFlag) return;
    try { await control(this.env, 'pause', state.pendingRestrictionFlag); delete state.pendingRestrictionFlag; await this.storage.put('state', state); } catch { /* The next alarm retries only the global halt, never a message. */ }
  }
  async schedule(state) {
    if (state.pendingRestrictionFlag) { await this.storage.setAlarm(Date.now() + 5000); return; }
    if (this.blocked(state)) { await this.storage.deleteAlarm(); return; }
    const next = state.jobs.filter((j) => ['pending', 'retry'].includes(j.state)).sort((a, b) => a.order - b.order)[0];
    if (!next) { await this.storage.deleteAlarm(); return; }
    await this.storage.setAlarm(Math.max(Date.now() + 1, next.dueAt, (state.lastAcceptedAt || 0) + GAP));
  }
  async alarm() { return this.exclusive(() => this.runAlarm()); }
  async runAlarm() {
    const state = await this.load();
    if (!await this.checkSender(state)) return;
    if (state.pendingRestrictionFlag) { await this.propagateRestriction(state); await this.schedule(state); return; }
    if (this.blocked(state)) { await this.storage.deleteAlarm(); return; }
    const job = state.jobs.filter((j) => ['pending', 'retry'].includes(j.state)).sort((a, b) => a.order - b.order)[0];
    if (!job) { await this.storage.deleteAlarm(); return; }
    const now = Date.now();
    if (!enabled(this.env) || !ready(this.env) || job.epoch !== this.env.SEND_EPOCH || now - state.lastInboundAt >= DAY) {
      for (const pending of state.jobs) if (['pending', 'retry'].includes(pending.state)) { pending.state = 'held'; pending.reason = now - state.lastInboundAt >= DAY ? 'service_window_expired' : 'sending_disabled_or_new_activation'; }
      await this.storage.put('state', state); await this.storage.deleteAlarm(); return;
    }
    if (Math.max(job.dueAt, state.lastAcceptedAt + GAP) > now) { await this.schedule(state); return; }
    let account;
    try { account = await control(this.env); } catch { await this.storage.setAlarm(Date.now() + 5000); return; }
    if (account.paused) {
      for (const pending of state.jobs) if (['pending', 'retry'].includes(pending.state)) { pending.state = 'held'; pending.reason = 'account_paused'; }
      await this.storage.put('state', state); await this.storage.deleteAlarm(); return;
    }
    // The account gate is a network round trip. Check the service window again
    // immediately before recording and issuing the attempt.
    if (Date.now() - state.lastInboundAt >= DAY) {
      for (const pending of state.jobs) if (['pending', 'retry'].includes(pending.state)) { pending.state = 'held'; pending.reason = 'service_window_expired'; }
      await this.storage.put('state', state); await this.storage.deleteAlarm(); return;
    }
    job.state = 'sending'; job.attempts += 1; job.attemptStartedAt = now;
    await this.storage.put('state', state);
    try {
      const result = await sendCloudMessage({ token: this.env.META_ACCESS_TOKEN, phoneNumberId: this.env.WA_PHONE_NUMBER_ID, graphVersion: this.env.GRAPH_VERSION, to: state.waId, step: job.step, fetchImpl: this.fetchImpl });
      if (!result?.messageId) throw Object.assign(new Error('missing_provider_receipt'), { uncertain: true });
      job.state = 'accepted'; job.messageId = result.messageId; job.acceptedAt = Date.now(); job.delivery = 'accepted'; state.lastAcceptedAt = job.acceptedAt;
      delete job.reason;
    } catch (error) {
      job.lastError = { code: error.code ?? null, status: error.status ?? null, at: Date.now() };
      if (error.isRestriction) { state.restricted = true; job.state = error.uncertain ? 'uncertain' : 'failed'; job.reason = error.uncertain ? 'delivery_requires_review' : 'account_restricted'; state.pendingRestrictionFlag = { reason: 'provider_restriction', code: error.code ?? null, at: Date.now() }; }
      else if (error.uncertain || !error.retryable) { job.state = error.uncertain || error.retryable === undefined ? 'uncertain' : 'failed'; job.reason = job.state === 'uncertain' ? 'delivery_requires_review' : 'provider_rejected'; }
      else if (job.attempts < MAX_ATTEMPTS) { job.state = 'retry'; job.dueAt = Date.now() + Math.max(GAP * 2 ** (job.attempts - 1), Math.min(3600, Number(error.retryAfterSeconds) || 0) * 1000); }
      else { job.state = 'failed'; job.reason = 'retry_limit_reached'; }
    }
    await this.storage.put('state', state);
    await this.propagateRestriction(state);
    await this.schedule(state);
  }
}

export class CloudApiControl {
  constructor(ctx) { this.storage = ctx.storage; this.serial = Promise.resolve(); }
  async fetch(request) {
    const run = async () => {
      const path = new URL(request.url).pathname;
      if (path === '/state' && request.method === 'GET') {
        const account = await this.storage.get('account') || { paused: false };
        const ingestion = await this.storage.get('ingestion');
        return json({ ...account, ...(ingestion ? { ingestion } : {}) });
      }
      if (path === '/receipt' && request.method === 'POST') {
        const value = await request.json();
        const previous = await this.storage.get('ingestion') || {};
        const now = Date.now();
        const ingestion = { ...previous, lastWebhookAt: now,
          ...(value.inbound === true ? { lastInboundAt: now } : {}),
          ...(value.status === true ? { lastStatusAt: now } : {}),
        };
        await this.storage.put('ingestion', ingestion);
        return json({ stored: true });
      }
      if (path === '/pause' && request.method === 'POST') {
        const value = await request.json();
        const previous = await this.storage.get('account');
        const account = previous?.reason === 'provider_restriction' ? previous : {
          paused: true, reason: value.reason === 'provider_restriction' ? 'provider_restriction' : 'owner_pause',
          ...(Number.isFinite(Number(value.code)) ? { code: Number(value.code) } : {}), at: Date.now(),
        };
        await this.storage.put('account', account);
        return json(account);
      }
      return json({ error: 'not_found' }, 404);
    };
    const result = this.serial.then(run); this.serial = result.catch(() => {}); return result;
  }
}
