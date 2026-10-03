// Private voice transport. PCM frames exist only while being forwarded; never
// write audio, session cookies, or customer profile data to storage or logs.
const AUDIO_FRAME_BYTES = 1280; // PCM16LE, mono, 16 kHz, 640 samples / 40 ms.
const AUDIO_MAX_FRAMES_PER_SECOND = 40;
const AUDIO_VALIDATE_MS = 5000;
const AUDIO_LEASE_MS = 120000;
const AUDIO_MAX_SESSION_MS = 3600000;
const AUDIO_INTERNAL_ORIGIN = 'https://call-audio.internal';
const AUDIO_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const AUDIO_ROLES = ['admin', 'customer'];
const AUDIO_END_REASONS = ['completed', 'cancelled', 'declined', 'expired', 'blocked', 'connection-failed'];

function audioFailure(status, message) {
  return new Response(JSON.stringify({error: message}), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
}

function audioStub(env, callId) {
  const namespace = env.CALL_AUDIO_RELAY;
  return namespace.get(namespace.idFromName(callId));
}

// The route must authenticate its existing session and check conversation
// ownership before supplying actor and the stored call row. No browser-provided
// role, expiry, URL, or bearer credential is passed through to the private room.
export async function handleAudioRelay(request, env, {actor, call} = {}) {
  if (!AUDIO_ROLES.includes(actor)) return audioFailure(401, 'Sign in before joining a voice call.');
  const url = new URL(request.url), prefix = actor === 'admin' ? '/api/admin/calls/' : '/api/calls/';
  if (!call || !AUDIO_UUID.test(call.id || '') || url.pathname !== prefix + call.id + '/audio') return audioFailure(404, 'Call not found.');
  if (request.method !== 'GET') return audioFailure(405, 'Voice connections require GET.');
  if (request.headers.get('Origin') !== url.origin) return audioFailure(403, 'Open the voice call from this app.');
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return audioFailure(426, 'A WebSocket voice connection is required.');
  const now = Date.now();
  if (call.type !== 'voice' || call.status !== 'active' || !Number.isSafeInteger(call.expires) || call.expires <= now || call.expires > now + AUDIO_MAX_SESSION_MS + 5000) return audioFailure(409, 'Answer an active voice call before connecting.');
  if (!env.CALL_AUDIO_RELAY) return audioFailure(503, 'Voice relay is not configured.');
  // Keep protocol identifiers lowercase: country branding replaces the word
  // "Rekha" in UI/source text and must never change machine header names.
  const headers = new Headers({Upgrade: 'websocket', 'x-rekha-call-id': call.id, 'x-rekha-call-role': actor, 'x-rekha-call-expires': String(call.expires)});
  return audioStub(env, call.id).fetch(new Request(AUDIO_INTERNAL_ORIGIN + '/connect', {method: 'GET', headers}));
}

// Private server helper: invoke after storing the call's ended status. It never
// exposes an end-room endpoint, ticket, or long-term secret to the browser.
export async function endAudioRelay(env, call, reason = 'completed') {
  const callId = typeof call === 'string' ? call : call?.id;
  if (!env.CALL_AUDIO_RELAY || !AUDIO_UUID.test(callId || '')) return false;
  const headers = {'x-rekha-call-id': callId, 'x-rekha-call-end': AUDIO_END_REASONS.includes(reason) ? reason : 'completed'};
  const response = await audioStub(env, callId).fetch(new Request(AUDIO_INTERNAL_ORIGIN + '/end', {method: 'POST', headers}));
  if (!response.ok) throw new Error('The voice relay could not be closed.');
  return true;
}

// A plain exported class works with the existing Worker bundler. The connected
// deployment must give this class the same scoped DB as its outer call routes.
export class CallAudioRelay {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.session = null;
    this.validation = null;
    this.validationAt = 0;
    this.validationPromise = null;
    this.rates = new Map();
    this.ready = ctx.blockConcurrencyWhile(async () => {this.session = await ctx.storage.get('session') || null;});
  }

  sockets() {return this.ctx.getWebSockets().filter(ws => ws.readyState === 1);}
  metadata(ws) {try {return ws.deserializeAttachment();} catch {return null;}}
  sendControl(ws, data) {try {ws.send(JSON.stringify(data));} catch {}}
  safeClose(ws, code, reason) {try {ws.close(code, reason);} catch {}}

  async validate(callId, force = false) {
    const now = Date.now();
    if (!force && this.validation && now - this.validationAt < AUDIO_VALIDATE_MS) return this.validation;
    if (this.validationPromise) return this.validationPromise;
    // Bound a provider failure. No frame queue or permanent timer is retained.
    this.validationAt = now;
    this.validationPromise = (async () => {
      let timer;
      try {
        const query = this.env.DB.prepare("SELECT calls.id,calls.type,calls.status,calls.expires,calls.updated,(SELECT blocked FROM chat_messaging WHERE conversation_id=calls.conversation_id) AS blocked,(SELECT MAX(created) FROM call_signals WHERE call_id=calls.id AND kind='heartbeat' AND actor='admin') AS admin_heartbeat,(SELECT MAX(created) FROM call_signals WHERE call_id=calls.id AND kind='heartbeat' AND actor='customer') AS customer_heartbeat FROM calls JOIN conversations ON conversations.id=calls.conversation_id WHERE calls.id=?").bind(callId).first();
        const row = await Promise.race([query, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Voice call validation timed out.')), 1500);})]);
        const checkedAt = Date.now();
        const valid = row && row.type === 'voice' && row.status === 'active' && Number.isSafeInteger(row.expires) && row.expires > checkedAt && !row.blocked && (row.admin_heartbeat ?? row.updated) >= checkedAt - AUDIO_LEASE_MS && (row.customer_heartbeat ?? row.updated) >= checkedAt - AUDIO_LEASE_MS;
        this.validation = valid ? {expiresAt: row.expires} : null;
        return this.validation;
      } catch {
        this.validation = null;
        return null;
      } finally {clearTimeout(timer);}
    })();
    const pending = this.validationPromise;
    try {return await pending;} finally {if (this.validationPromise === pending) this.validationPromise = null;}
  }

  async finish(reason, code = 1000) {
    await this.ready;
    const mustPersist = this.session && !this.session.ended;
    if (mustPersist) this.session = {...this.session, ended: true};
    for (const ws of this.sockets()) {
      this.sendControl(ws, {type: 'ended', reason});
      this.safeClose(ws, code, reason);
    }
    this.rates.clear();
    this.validation = null;
    if (mustPersist) await this.ctx.storage.put('session', this.session);
  }

  async fetch(request) {
    await this.ready;
    // A simultaneous connect/end cannot reserve the same role twice or reopen
    // an ended room while its storage write is in progress.
    return this.ctx.blockConcurrencyWhile(() => this.privateFetch(request));
  }

  async privateFetch(request) {
    const url = new URL(request.url), callId = request.headers.get('x-rekha-call-id');
    if (url.origin !== AUDIO_INTERNAL_ORIGIN || url.search || !AUDIO_UUID.test(callId || '')) return audioFailure(400, 'Invalid private voice request.');
    if (this.session && this.session.callId !== callId) return audioFailure(403, 'Voice room mismatch.');
    if (url.pathname === '/end' && request.method === 'POST') {
      if (!this.session) {
        this.session = {callId, expiresAt: Date.now() + AUDIO_LEASE_MS, ended: true};
        await this.ctx.storage.put('session', this.session);
        await this.ctx.storage.setAlarm(this.session.expiresAt);
      }
      const suppliedReason = request.headers.get('x-rekha-call-end');
      await this.finish(AUDIO_END_REASONS.includes(suppliedReason) ? suppliedReason : 'completed');
      return new Response(null, {status: 204});
    }
    if (url.pathname !== '/connect' || request.method !== 'GET' || (request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return audioFailure(426, 'A private WebSocket connection is required.');
    const role = request.headers.get('x-rekha-call-role'), expiresAt = Number(request.headers.get('x-rekha-call-expires')), now = Date.now();
    if (!AUDIO_ROLES.includes(role) || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + AUDIO_MAX_SESSION_MS + 5000) return audioFailure(400, 'Invalid private voice participant.');
    if (this.session?.ended || this.session && (this.session.expiresAt <= now || this.session.expiresAt !== expiresAt)) return audioFailure(409, 'The voice call has ended.');
    const permitted = await this.validate(callId, true);
    if (!permitted || permitted.expiresAt !== expiresAt) {
      await this.finish('connection-failed', 1008);
      return audioFailure(409, 'The voice call is no longer available.');
    }
    const existing = this.sockets();
    if (existing.length >= 2 || existing.some(ws => this.metadata(ws)?.role === role)) return audioFailure(409, 'This participant is already connected.');
    if (!this.session) {
      this.session = {callId, expiresAt, ended: false};
      await this.ctx.storage.put('session', this.session);
      await this.ctx.storage.setAlarm(expiresAt);
    }
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({callId, role, expiresAt});
    this.sendControl(server, {type: 'peer', connected: existing.length === 1});
    for (const peer of existing) this.sendControl(peer, {type: 'peer', connected: true});
    return new Response(null, {status: 101, webSocket: client});
  }

  allowedRate(ws, kind, max) {
    const now = Date.now(), rates = this.rates.get(ws) || {};
    const bucket = rates[kind];
    if (!bucket || now - bucket.started >= 1000) rates[kind] = {started: now, count: 1};
    else if (++bucket.count > max) return false;
    this.rates.set(ws, rates);
    return true;
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    const meta = this.metadata(ws), now = Date.now();
    if (!meta || !this.session || this.session.ended || meta.callId !== this.session.callId || !AUDIO_ROLES.includes(meta.role) || now >= Math.min(meta.expiresAt, this.session.expiresAt)) {
      await this.finish('expired', 1008);return;
    }
    const control = typeof message === 'string';
    if (control ? message !== 'ping' : !(message instanceof ArrayBuffer) || message.byteLength !== AUDIO_FRAME_BYTES) {
      this.safeClose(ws, control ? 1008 : 1009, 'Invalid voice frame.');return;
    }
    if (!this.allowedRate(ws, control ? 'ping' : 'audio', control ? 4 : AUDIO_MAX_FRAMES_PER_SECOND)) {
      this.safeClose(ws, 1008, 'Voice frame rate exceeded.');return;
    }
    // Drop audio arriving during the one in-flight validation rather than build
    // a burst of delayed sound. A following 40 ms frame will resume normally.
    if (this.validationPromise) return;
    const permitted = await this.validate(meta.callId);
    if (!permitted || Date.now() >= Math.min(meta.expiresAt, permitted.expiresAt) || this.session.ended) {
      await this.finish('connection-failed', 1008);return;
    }
    if (control) {try {ws.send('pong');} catch {} return;}
    for (const peer of this.sockets()) {
      const peerMeta = this.metadata(peer);
      if (peer !== ws && peerMeta?.callId === meta.callId && peerMeta.role !== meta.role) {
        try {peer.send(message);} catch {this.safeClose(peer, 1011, 'Voice connection failed.');}
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    this.rates.delete(ws);
    this.safeClose(ws, code === 1005 || code === 1006 ? 1000 : code, 'Voice connection closed.');
    for (const peer of this.sockets()) if (peer !== ws) this.sendControl(peer, {type: 'peer', connected: false});
  }

  async webSocketError(ws) {
    this.rates.delete(ws);
    this.safeClose(ws, 1011, 'Voice connection failed.');
    for (const peer of this.sockets()) if (peer !== ws) this.sendControl(peer, {type: 'peer', connected: false});
  }

  async alarm() {
    await this.finish('expired', 1008);
    await this.ctx.storage.deleteAll();
  }
}
