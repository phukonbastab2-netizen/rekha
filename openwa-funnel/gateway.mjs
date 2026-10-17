import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Engine, validPeer, isSensitive } from './engine.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const data = process.env.REKHA_DATA_DIR || path.join(root, '.local');
fs.mkdirSync(path.join(data, 'media'), { recursive: true });
fs.mkdirSync(path.join(root, '.sessions'), { recursive: true });
const lock = path.join(data, 'gateway.pid');
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock, 'utf8')); let alive = false;
  try { if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); alive = true; } } catch {}
  if (alive) throw Error('This WhatsApp gateway is already running.');
  fs.unlinkSync(lock);
}
fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
process.on('exit', () => { if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); });
const zstdDir = process.env.ZSTD_DIR || path.join(data, 'bin');
if (fs.existsSync(zstdDir)) process.env.PATH = zstdDir + path.delimiter + process.env.PATH;
const idPath = path.join(data, 'source-id');
const source = fs.existsSync(idPath) ? fs.readFileSync(idPath, 'utf8').trim() : randomUUID();
fs.writeFileSync(idPath, source, { mode: 0o600 });
const engine = new Engine(path.join(data, 'funnel.sqlite'));
const cookie = randomBytes(32).toString('hex');
const port = Number(process.env.PORT || 4341);
const origin = `http://127.0.0.1:${port}`;
const cloud = process.env.CLOUD_BACKUP_URL || '', token = process.env.CLOUD_BACKUP_TOKEN || '';
const state = { connection: 'disconnected', error: '', qr: null, cloud: cloud ? 'waiting' : 'not_configured', lastBackup: null, connectedAt: null };
let client, runtime, connecting = false, stopping = false, busy = false, syncing = false, connectedSince = 0, eventsInstalled = false;
const pendingAcks = new Map();
const safeId = value => typeof value === 'string' ? value : value?._serialized || '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const privateHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
function json(res, value, status = 200) { res.writeHead(status, { ...privateHeaders, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req) {
  let raw = '', total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > 50000) throw Error('Request too large'); raw += chunk; }
  return JSON.parse(raw || '{}');
}
function sameCookie(req) {
  const value = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('rekha_owner='))?.slice(12) || '';
  return value.length === cookie.length && timingSafeEqual(Buffer.from(value), Buffer.from(cookie));
}
async function backupRequest(route, options = {}) {
  const response = await fetch(cloud + route, { ...options, headers: { Authorization: 'Bearer ' + token, ...(options.headers || {}) }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error('Cloud backup request failed (' + response.status + ')');
  return response;
}
async function sync() {
  if (syncing || !cloud || !token || stopping) return;
  syncing = true;
  try {
    const changes = engine.changes();
    if (!changes.length) { state.cloud = 'synced'; return; }
    // An attachment reaches the private bucket before a message references it.
    for (const c of changes) {
      const value = JSON.parse(c.json), m = value.media;
      if (m?.id && fs.existsSync(path.join(data, 'media', m.id)) && !fs.existsSync(path.join(data, 'media', m.id + '.synced'))) {
        await backupRequest('/media/' + source + '/' + m.id, { method: 'PUT', headers: { 'Content-Type': m.mime }, body: fs.readFileSync(path.join(data, 'media', m.id)) });
        fs.writeFileSync(path.join(data, 'media', m.id + '.synced'), '1');
      }
    }
    const result = await (await backupRequest('/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, changes }) })).json();
    if (result.acknowledged !== changes.at(-1).seq) throw Error('Unexpected backup acknowledgement');
    engine.synced(result.acknowledged); state.cloud = 'synced'; state.lastBackup = Date.now();
  } catch { state.cloud = 'retrying'; } finally { syncing = false; }
}
async function saveIncomingMedia(message, recordKey) {
  if (!client || engine.get(recordKey)?.sensitive) return;
  try {
    // Only customer-chosen attachments in this chat are accessed.
    const encoded = await client.decryptMedia(message);
    const match = /^data:(image\/(?:jpeg|png|webp)|video\/mp4|audio\/(?:mpeg|ogg|mp4|wav)|application\/pdf);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(encoded);
    if (!match || match[2].length > 35 * 1024 * 1024) return;
    const bytes = Buffer.from(match[2], 'base64'); if (!bytes.length || bytes.length > 25 * 1024 * 1024) return;
    const id = createHash('sha256').update(recordKey).digest('hex');
    fs.writeFileSync(path.join(data, 'media', id), bytes, { mode: 0o600 });
    const m = engine.get(recordKey); if (m) engine.put({ ...m, media: { id, mime: match[1], size: bytes.length } });
  } catch { const m = engine.get(recordKey); if (m) engine.put({ ...m, attachmentError: 'Open the original attachment in WhatsApp; download was unavailable.' }); }
}
async function incoming(message) {
  const peer = safeId(message.from), id = safeId(message.id), at = Number(message.timestamp || message.t || 0) * 1000;
  // Never run the funnel against synced historical chats, groups or account/service notices.
  if (!validPeer(peer) || !id || message.fromMe || message.isGroupMsg || message.isNotification || !Number.isFinite(at) || at < connectedSince - 10000 || at > Date.now() + 300000) return;
  const type = message.type === 'chat' ? 'text' : message.type || 'text';
  if (!['text','image','video','audio','ptt','document','sticker'].includes(type)) return;
  const result = engine.inbound({ peer, id, type, body: type === 'text' ? message.body || '' : message.caption || '', name: message.sender?.pushname || message.sender?.formattedName || '', at });
  if (!result.accepted) return;
  if (type !== 'text' && !isSensitive(message.caption || message.body || '')) void saveIncomingMedia(message, 'in:' + id);
  void sync(); void pump();
}
async function connect() {
  if (connecting || (client && state.connection === 'connected') || stopping) return;
  connecting = true; state.connection = 'starting'; state.error = '';
  try {
    const [{ Client, createClient, ev }, { PuppeteerDriver }, QRCode] = await Promise.all([import('@open-wa/wa-automate'), import('@open-wa/driver-puppeteer'), import('qrcode')]);
    if (!eventsInstalled) {
      ev.on('qr.**', async qr => { if (typeof qr === 'string') { state.qr = await QRCode.default.toDataURL(qr, { width: 300, margin: 2 }); state.connection = 'scan_qr'; } });
      ev.on('session.connection.disconnected', () => { state.connection = 'disconnected'; state.qr = null; });
      eventsInstalled = true;
    }
    if (client) { try { await client.stop('Owner reconnecting'); } catch {} client = null; }
    const chromePath = process.env.CHROME_PATH || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
    runtime = await createClient({ sessionId: 'rekha-29', driver: new PuppeteerDriver(), headless: true, debug: false, logConsole: false, logConsoleErrors: false, authTimeoutMs: 0, qrTimeoutMs: 0, userDataDir: process.env.WHATSAPP_PROFILE_DIR || path.join(root, '.sessions', 'rekha-29'), sessionDataPath: path.join(root, '.sessions'), ...(chromePath ? { executablePath: chromePath } : {}) });
    client = new Client({ client: runtime, transport: runtime.getTransport() });
    // Register before start so no live message is lost in a readiness/listener gap.
    client.onMessage(message => incoming(message).catch(() => { state.error = 'An incoming message needs checking in WhatsApp.'; }));
    client.onAck(message => { const id = safeId(message.id); if (!engine.ack(id, message.ack)) { pendingAcks.set(id, { ack: message.ack, at: Date.now() }); if (pendingAcks.size > 1000) pendingAcks.delete(pendingAcks.keys().next().value); } });
    connectedSince = Date.now();
    await client.start();
    if (!runtime.getReadiness().ready) throw Error('WhatsApp is not ready');
    state.connection = 'connected'; state.qr = null; state.connectedAt = Date.now();
  } catch {
    state.connection = 'error'; state.qr = null; state.error = 'Could not connect WhatsApp. Check the browser installation, account and internet connection, then restart the gateway.';
    // Do not log exceptions: third-party errors may contain account/session data.
    client = null;
    try { await runtime?.stop?.('connection failure'); } catch {}
  } finally { connecting = false; }
}
async function pump() {
  if (busy || !client || state.connection !== 'connected' || !runtime?.getReadiness().ready || stopping) return;
  busy = true;
  try {
    const j = engine.reserve(); if (!j) return;
    try {
      let providerId;
      const timed = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Send timed out')), 60000); })]); } finally { clearTimeout(timer); } };
      if (j.payload.type === 'text') providerId = await timed(client.sendText(j.peer, j.payload.body));
      else {
        // Media URLs come only from the checked-in allowlist, never arbitrary customer input.
        const filename = decodeURIComponent(new URL(j.payload.url).pathname.split('/').at(-1));
        providerId = await timed(client.sendFile(j.peer, j.payload.url, filename, { caption: j.payload.body }));
      }
      engine.finish(j.key, typeof providerId === 'string' ? providerId : null, 'Provider returned no trackable message ID; check WhatsApp before retrying.');
      for (const [id, pending] of pendingAcks) if (engine.ack(id, pending.ack) || Date.now() - pending.at > 60000) pendingAcks.delete(id);
    } catch { engine.finish(j.key, null, 'Send outcome uncertain; check WhatsApp before resolving. Automatic replies paused for this customer.'); }
    void sync();
  } finally { busy = false; }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` || ['cross-site','same-site'].includes(req.headers['sec-fetch-site'])) return json(res, { error: 'Forbidden' }, 403);
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `rekha_owner=${cookie}; HttpOnly; SameSite=Strict; Path=/` }); return res.end(fs.readFileSync(path.join(root, 'public', 'index.html')));
    }
    if (!sameCookie(req)) return json(res, { error: 'Open the private control page first' }, 401);
    if (['/app.js','/style.css'].includes(url.pathname) && req.method === 'GET') { res.writeHead(200, { ...privateHeaders, 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css' }); return res.end(fs.readFileSync(path.join(root, 'public', url.pathname.slice(1)))); }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, { ...state, enabled: engine.settings().enabled, ...engine.stats(), source });
    if (req.method === 'GET' && url.pathname === '/api/contacts') return json(res, engine.list('contact', '', url.searchParams.get('before') || '', 50));
    if (req.method === 'GET' && url.pathname === '/api/messages') { const peer = url.searchParams.get('peer'); if (!validPeer(peer)) return json(res, { error: 'Invalid chat' }, 400); return json(res, { messages: engine.list('message', peer, url.searchParams.get('before') || '', 50), jobs: engine.db.prepare("SELECT key FROM due_jobs WHERE peer=? AND state='unknown' LIMIT 30").all(peer).map(r => engine.get(r.key)), contact: engine.contact(peer) }); }
    if (req.method === 'GET' && /^\/media\/[a-f0-9]{64}$/.test(url.pathname)) {
      const file = path.join(data, 'media', url.pathname.slice(7)); if (!fs.existsSync(file)) return json(res, { error: 'Not found' }, 404);
      res.writeHead(200, { ...privateHeaders, 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="whatsapp-attachment"' }); return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'POST') {
      if (req.headers.origin !== origin || !String(req.headers['content-type']).startsWith('application/json')) return json(res, { error: 'Forbidden' }, 403);
      const input = await body(req);
      if (url.pathname === '/api/connect') { void connect(); return json(res, { starting: true }); }
      if (url.pathname === '/api/enabled') { engine.enable(!!input.enabled); return json(res, { enabled: engine.settings().enabled }); }
      if (url.pathname === '/api/send') { const value = engine.manual(input.peer, input.body, input.requestId); void pump(); return json(res, value); }
      if (!validPeer(input.peer)) return json(res, { error: 'Invalid customer' }, 400);
      if (url.pathname === '/api/pause') engine.pauseContact(input.peer, !!input.paused);
      else if (url.pathname === '/api/payment') engine.verifyPayment(input.peer, !!input.verified);
      else if (url.pathname === '/api/seen') { engine.markSeen(input.peer); if (client && state.connection === 'connected') void client.sendSeen(input.peer).catch(() => { state.error = 'WhatsApp read receipt could not be confirmed.'; }); }
      else if (url.pathname === '/api/resolve') { if (engine.get(input.key)?.peer !== input.peer) throw Error('Invalid job'); engine.resolveUnknown(input.key, input.action); }
      else return json(res, { error: 'Not found' }, 404);
      return json(res, { ok: true });
    }
    return json(res, { error: 'Not found' }, 404);
  } catch (error) { return json(res, { error: ['Unknown customer','Customer has opted out','Invalid message','Invalid resolution'].includes(error.message) ? error.message : 'Could not complete the request' }, 400); }
});
server.listen(port, '127.0.0.1', () => console.log(`Private WhatsApp controls: ${origin}`));
const pumping = setInterval(() => void pump(), 1000), backing = setInterval(() => void sync(), 15000);
const housekeeping = setInterval(() => {
  engine.prune();
  const expiry = Date.now() - 90 * 86400000;
  for (const entry of fs.readdirSync(path.join(data, 'media'), { withFileTypes: true })) if (entry.isFile() && fs.statSync(path.join(data,'media',entry.name)).mtimeMs < expiry) fs.unlinkSync(path.join(data,'media',entry.name));
}, 3600000);
async function shutdown() { if (stopping) return; stopping = true; clearInterval(pumping); clearInterval(backing); clearInterval(housekeeping); server.close(); try { await client?.stop('Owner stopped gateway'); } catch {} while (busy) await sleep(100); engine.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
void sync();
if (process.env.AUTO_CONNECT === 'true') void connect();
