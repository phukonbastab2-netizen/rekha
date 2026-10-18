import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Engine, validPeer, isSensitive } from './engine.mjs';
import { ensurePairingCompatibility } from './pairing-compat.mjs';
import { withPersistentProfile } from './persistent-driver.mjs';
import {createMonitor} from './monitor.mjs';
import {createMobileBridge} from './mobile-bridge.mjs';
import {createInboxSync,normalizeIncoming,normalizeOutgoing,installFastInboxBridge,serializeNativeMessage} from './inbox-sync.mjs';
import {createReceiverWatchdog} from './receiver-watchdog.mjs';
import {createReceiverProbe,readMirrorSnapshot} from './receiver-probe.mjs';
import {createPhoneHistory} from './phone-history.mjs';
import {createAttachmentQueue,canAttachMedia} from './attachment-queue.mjs';
import {createProviderJournal} from './provider-journal.mjs';
import {withDeadline} from './async-deadline.mjs';

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
const pairingFile = path.join(data, 'pairing-phone');
const canPairWithPhone = process.env.ALLOW_PAIRING_RESTART === 'true';
let pairingPhone = fs.existsSync(pairingFile) ? fs.readFileSync(pairingFile, 'utf8').trim() : '';
const linkedFile=path.join(data,'whatsapp-linked.json');
const linkedBefore=()=>fs.existsSync(linkedFile);
const state = { connection: 'disconnected', error: '', qr: null, pairingCode: null, pairingMode: pairingPhone ? 'phone' : 'qr', canPairWithPhone, cloud: cloud ? 'waiting' : 'not_configured', lastBackup: null, connectedAt: null };
const ingress={events:0,accepted:0,duplicates:0,lastEventAt:null,lastAcceptedAt:null,lastShape:null,rejected:{}};
const monitor=createMonitor({engine,data,profile:process.env.WHATSAPP_PROFILE_DIR||path.join(root,'.sessions','rekha-29'),cloudStatus:()=>({state:state.cloud,lastSynced:state.lastBackup,databaseBytes:state.cloudDatabaseBytes||null,databaseMeasuredAt:state.cloudDatabaseMeasuredAt||null})});
let copyRestored=0;
if(!engine.db.prepare("SELECT 1 FROM migrations WHERE name='shop-qr-shahrukh-20261018'").get()){
  copyRestored=engine.restoreQueuedCopy();engine.db.exec("INSERT INTO migrations VALUES('shop-qr-shahrukh-20261018')");
}
if(copyRestored)console.log('Updated pending automatic messages to current owner-approved content.');
let client, runtime, connecting = false, stopping = false, busy = 0, syncing = false, connectedSince = 0, eventsInstalled = false;
let fastBridge={ready:false},checkingBridge=false;
let mirror={checkedAt:null,lastIncomingAt:null,lastOutgoingAt:null,lastProviderMessageAt:null},manualSyncing=false;
const mirrorCounters={outgoing:0,mutations:0,journalImports:0};
const receiverProbe=createReceiverProbe();
const phoneHistory=createPhoneHistory({evaluate:(fn,arg)=>client.evaluate(fn,arg),get:key=>engine.get(key),put:value=>engine.put(value)});
let mediaActive=0;
const inboxSync=createInboxSync({engine,evaluate:(fn,arg)=>withDeadline(()=>client.evaluate(fn,arg),40000,'Inbox scan'),onIncoming:message=>incoming(message,true),onOutgoing:message=>outgoing(message,true)});
const providerJournal=createProviderJournal({engine,evaluate:(fn,arg)=>withDeadline(()=>client.evaluate(fn,arg),30000,'Stored message scan'),serializeNativeMessage,onMessage:mirrorStoredMessage});
const attachmentQueue=createAttachmentQueue({run:saveIncomingMedia,eligible:key=>{
 const m=engine.get(key);return m?.kind==='message'&&!m.media&&!m.url&&!m.sensitive&&!m.revoked&&(m.attachmentAttempts||0)<3&&(m.attachmentRetryAt||0)<=Date.now();
}});
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
function removeMedia(ids){for(const id of ids)if(/^[a-f0-9]{64}$/.test(id))for(const suffix of['','.synced']){const file=path.join(data,'media',id+suffix);if(fs.existsSync(file))fs.unlinkSync(file);}}
let mobileMonitor=null,mobileMonitorAt=0;
const mobileBridge=cloud&&token?createMobileBridge({engine,source,request:backupRequest,removeMedia,status:()=>{
  if(Date.now()-mobileMonitorAt>30000){mobileMonitor=monitor.snapshot();mobileMonitorAt=Date.now();}
  return{connection:state.connection,enabled:engine.settings().enabled,...engine.stats(),cloud:state.cloud,monitor:mobileMonitor};
}}):null;
async function sync() {
  if (syncing || !cloud || !token || stopping) return;
  syncing = true;
  try {
    // Drain several bounded batches per cycle so a growing inbox does not outrun backup.
    for(let batch=0;batch<20&&!stopping;batch++){
    const changes = engine.changes();
    if (!changes.length) {
      state.cloud = 'synced';
      if(!state.cloudDatabaseMeasuredAt||Date.now()-state.cloudDatabaseMeasuredAt>60000){
        const usage=await(await backupRequest('/usage')).json();
        if(Number.isFinite(usage.databaseBytes)){state.cloudDatabaseBytes=usage.databaseBytes;state.cloudDatabaseMeasuredAt=usage.checkedAt;}
      }
      break;
    }
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
    if(Number.isFinite(result.databaseBytes)){state.cloudDatabaseBytes=result.databaseBytes;state.cloudDatabaseMeasuredAt=Date.now();}
    }
  } catch { state.cloud = 'retrying'; } finally { syncing = false; }
}
async function saveIncomingMedia(message, recordKey) {
  const original=engine.get(recordKey);
  if (!client || original?.kind!=='message'||original.sensitive||original.revoked) return;
  mediaActive++;
  try {
    const disk=fs.statfsSync(data);
    if(disk.bavail*disk.bsize<2*1024**3)throw Error('Low disk space');
    const attempts=(original.attachmentAttempts||0)+1;
    engine.put({...original,attachmentAttempts:attempts,attachmentRetryAt:Date.now()+30000*2**(attempts-1)});
    // Only customer-chosen attachments in this chat are accessed.
    const encoded = await withDeadline(()=>client.decryptMedia(message),30000,'Attachment download');
    const match = /^data:(image\/(?:jpeg|png|webp)|video\/mp4|audio\/(?:mpeg|ogg|mp4|wav)|application\/pdf);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(encoded);
    if (!match || match[2].length > 35 * 1024 * 1024) return;
    const bytes = Buffer.from(match[2], 'base64'); if (!bytes.length || bytes.length > 25 * 1024 * 1024) return;
    const current=engine.get(recordKey);if(!canAttachMedia(current,original))return;
    const id = createHash('sha256').update(recordKey).digest('hex');
    fs.writeFileSync(path.join(data, 'media', id), bytes, { mode: 0o600 });
    const m = engine.get(recordKey); if (canAttachMedia(m,original)) engine.put({ ...m, media: { id, mime: match[1], size: bytes.length },attachmentError:null,attachmentRetryAt:null });
    else fs.unlinkSync(path.join(data,'media',id));
  } catch { const m = engine.get(recordKey); if (canAttachMedia(m,original)) engine.put({ ...m, attachmentError: 'Open the original attachment in WhatsApp; download was unavailable.',attachmentRetryAt:m.attachmentRetryAt||Date.now()+1800000 }); }finally{mediaActive--;}
}
async function incoming(message,recovered=false) {
  if(receiverProbe.consume(message,'in'))return;
  ingress.events++;ingress.lastEventAt=Date.now();
  const peer = safeId(message.from), id = safeId(message.id), at = Number(message.timestamp || message.t || 0) * 1000;
  ingress.lastShape={peerType:typeof message.from,idType:typeof message.id,timestampType:typeof(message.timestamp??message.t),timestamp:at,fromMe:!!message.fromMe,group:!!message.isGroupMsg,notification:!!message.isNotification,type:String(message.type||'').slice(0,25),validPeer:validPeer(peer),hasId:!!id};
  // Never run the funnel against synced historical chats, groups or account/service notices.
  const normalized=normalizeIncoming(message,inboxSync.since);
  const reject=normalized.reason;
  if(reject){ingress.rejected[reject]=(ingress.rejected[reject]||0)+1;return;}
  noteProviderMessage(normalized.input,'in');
  const {type}=normalized.input;
  const result = engine.inbound({...normalized.input,recovered});
  if(result.mutated){mirrorCounters.mutations++;removeMedia(result.removedMedia||[]);void sync();return false;}
  if(result.duplicate)ingress.duplicates++;
  if ((result.accepted||result.duplicate)&&['image','video','audio','ptt','document','sticker'].includes(type) && !isSensitive(message.caption || message.body || '')) attachmentQueue.offer(message,'in:'+id);
  if (!result.accepted) return;
  ingress.accepted++;ingress.lastAcceptedAt=Date.now();
  void sync(); void pump();return true;
}
async function outgoing(message,historical=false){
  if(receiverProbe.consume(message,'out'))return false;
  const normalized=normalizeOutgoing(message,historical?0:inboxSync.since);
  if(normalized.reason)return false;
  noteProviderMessage(normalized.input,'out');
  const result=engine.captureOutgoing(normalized.input);
  if(result.mutated){mirrorCounters.mutations++;removeMedia(result.removedMedia||[]);void sync();return false;}
  if((result.accepted||result.duplicate)&&['image','video','audio','ptt','document','sticker'].includes(normalized.input.type)&&!isSensitive(normalized.input.body))attachmentQueue.offer(message,result.key||'out:provider:'+normalized.input.id);
  if(!result.accepted)return false;
  mirrorCounters.outgoing++;
  void sync();return true;
}
function noteProviderMessage(input,direction){
 const field=direction==='out'?'lastOutgoingAt':'lastIncomingAt';
 mirror[field]=Math.max(mirror[field]||0,input.at)||null;
 mirror.lastProviderMessageAt=Math.max(mirror.lastIncomingAt||0,mirror.lastOutgoingAt||0)||null;
}
async function mirrorStoredMessage(message){
 if(message.fromMe||message.id?.fromMe||message.self==='out')return outgoing(message,true);
 const normalized=normalizeIncoming(message,0);if(normalized.reason)return false;
 const input=normalized.input;
 noteProviderMessage(input,'in');
 if(input.mutation||input.editedAt&&engine.get('in:'+input.id)?.kind==='message')return incoming({...message,...(input.mutation?{}:{mutation:'edit'})},true);
 if(input.at>=inboxSync.since)return incoming(message,true);
 const imported=engine.importHistory(input);
 if(['image','video','audio','ptt','document','sticker'].includes(input.type))attachmentQueue.offer(message,'in:'+input.id);
 if(imported){mirrorCounters.journalImports++;void sync();}return imported;
}
async function checkFastBridge(){
  if(checkingBridge||stopping||!client||state.connection!=='connected')return;
  checkingBridge=true;
  let timeout;
  try{
    const [bridge,snapshot,roundTrip]=await Promise.race([Promise.all([client.evaluate(installFastInboxBridge,{since:inboxSync.since}),client.evaluate(readMirrorSnapshot),receiverProbe.check((fn,arg)=>client.evaluate(fn,arg))]),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Receiver probe timed out')),8000);})]);
    mirror={...mirror,...snapshot,lastIncomingAt:Math.max(mirror.lastIncomingAt||0,snapshot.lastIncomingAt||0)||null,lastOutgoingAt:Math.max(mirror.lastOutgoingAt||0,snapshot.lastOutgoingAt||0)||null};mirror.lastProviderMessageAt=Math.max(mirror.lastIncomingAt||0,mirror.lastOutgoingAt||0)||null;
    fastBridge={...bridge,ready:!!bridge.ready&&roundTrip.ready,roundTrip};return fastBridge;
  }catch{fastBridge={ready:false};return fastBridge;}finally{clearTimeout(timeout);checkingBridge=false;}
}
const receiverWatchdog=createReceiverWatchdog({
 probe:async()=>state.connection==='connected'?await checkFastBridge():{ready:false},
 canReconnect:()=>process.env.AUTO_CONNECT==='true'&&!stopping&&!connecting&&!busy&&!syncing&&!mediaActive&&!inboxSync.status.running&&!providerJournal.status.running&&!manualSyncing&&['connected','disconnected','error'].includes(state.connection),
 reconnect:async()=>{state.connection='disconnected';await connect();}
});
async function connect() {
  if (connecting || (client && state.connection === 'connected') || stopping) return;
  connecting = true; state.connection = 'starting'; state.error = '';
  try {
    ensurePairingCompatibility();
    const [{ Client, createClient, ev }, { PuppeteerDriver }, QRCode] = await Promise.all([import('@open-wa/wa-automate'), import('@open-wa/driver-puppeteer'), import('qrcode')]);
    if(stopping)return;
    if (!eventsInstalled) {
      ev.on('qr.**', async qr => { if (typeof qr === 'string' && !stopping) { state.qr = await QRCode.default.toDataURL(qr, { width: 300, margin: 2 }); state.pairingCode = null; state.connection = 'scan_qr'; if (pairingPhone) state.error = 'WhatsApp did not offer a pairing code. You can scan the QR or request a fresh code.'; } });
      ev.on('linkCode.**', code => { if (typeof code === 'string' && /^[a-z0-9-]{8,10}$/i.test(code) && !stopping) { state.pairingCode = code; state.qr = null; state.error = ''; state.connection = 'enter_code'; } });
      ev.on('session.connection.disconnected', () => { state.connection = 'disconnected'; state.qr = null; state.pairingCode = null; });
      eventsInstalled = true;
    }
    if (client) { try { await client.stop('Owner reconnecting'); } catch {} client = null; }
    const chromePath = process.env.CHROME_PATH || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
    const profile = process.env.WHATSAPP_PROFILE_DIR || path.join(root, '.sessions', 'rekha-29');
    const driver = withPersistentProfile(new PuppeteerDriver(),profile);
    runtime = await createClient({ sessionId: 'rekha-29', driver, headless: true, debug: false, logConsole: false, logConsoleErrors: false, authTimeoutMs: 0, qrTimeoutMs: 0, ...(pairingPhone ? { linkCode: pairingPhone } : {}), userDataDir: profile, sessionDataPath: path.join(root, '.sessions'), ...(chromePath ? { executablePath: chromePath } : {}) });
    if(stopping){await runtime.stop('Gateway stopping');return;}
    runtime.events.on('error', event => saveConnectionDiagnostic(event.error, 'runtime'));
    client = new Client({ client: runtime, transport: runtime.getTransport() });
    // Register before start so no live message is lost in a readiness/listener gap.
    client.onMessage(message => incoming(message).catch(() => { state.error = 'An incoming message needs checking in WhatsApp.'; }));
    client.onAnyMessage(message=>outgoing(message).catch(()=>{state.error='An outgoing phone message could not be copied to the inbox.';}));
    client.onAck(message => { const id = safeId(message.id); if (!engine.ack(id, message.ack)) { pendingAcks.set(id, { ack: message.ack, at: Date.now() }); if (pendingAcks.size > 1000) pendingAcks.delete(pendingAcks.keys().next().value); } });
    connectedSince = Date.now();
    await client.start();
    if(stopping)return;
    if (!runtime.getReadiness().ready) throw Error('WhatsApp is not ready');
    // The pinned core can skip persistence when runtime bridge installation fails.
    // Saving the encrypted checkpoint must not depend on message bridge readiness.
    await runtime.getTransport().portable.activate().catch(error => saveConnectionDiagnostic(error,'session_save'));
    state.connection = 'connected'; state.qr = null; state.pairingCode = null; state.connectedAt = Date.now();
    fs.writeFileSync(linkedFile,JSON.stringify({lastConnectedAt:state.connectedAt}),{mode:0o600});
    pairingPhone='';
    await checkFastBridge();
    void inboxSync.scan().then(()=>sync());
    void providerJournal.scan().then(()=>sync());
    if (fs.existsSync(pairingFile)) fs.unlinkSync(pairingFile);
  } catch (error) {
    saveConnectionDiagnostic(error,'connection');
    state.connection = 'error'; state.qr = null; state.pairingCode = null; state.error = 'Could not connect WhatsApp. Check the browser installation, account and internet connection, then restart the gateway.';
    // Do not log exceptions: third-party errors may contain account/session data.
    client = null;
    try { await runtime?.stop?.('connection failure'); } catch {}
  } finally { connecting = false; }
}
function saveConnectionDiagnostic(error, phase) {
  // Keep a redacted diagnostic on the private host, never in cloud backups.
  let detail = String(error?.message || 'Unknown connection failure');
  if (/bearer|secret|access.?token|session.?data/i.test(detail)) detail = 'Private provider error';
  else detail = detail.replace(/https?:\/\/\S+/g, '[url]').replace(/(?:\+?\d[\s()-]*){6,}/g, '[number]').replace(/\b(?=[A-Z0-9-]{8,10}\b)(?=[A-Z0-9-]*\d)[A-Z0-9]{4}-?[A-Z0-9]{4}\b/g, '[code]').replace(/[A-Za-z0-9+/_=-]{32,}/g, '[private]');
  fs.writeFileSync(path.join(data,'connection-error.json'),JSON.stringify({at:Date.now(),phase,name:/^[A-Za-z]{1,30}$/.test(error?.name || '')?error.name:'Error',detail:detail.slice(0,1500)}),{mode:0o600});
}
async function pump() {
  if (busy>=2 || !client || state.connection !== 'connected' || !runtime?.getReadiness().ready || stopping) return;
  const disk=fs.statfsSync(data);if(disk.bavail*disk.bsize<500*1024**2){state.error='Storage nearly full. Outgoing sends are paused until space is available.';return;}
  busy++;
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
  } finally { busy--; }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` || ['cross-site','same-site'].includes(req.headers['sec-fetch-site'])) return json(res, { error: 'Forbidden' }, 403);
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `rekha_owner=${cookie}; HttpOnly; SameSite=Strict; Path=/` }); return res.end(fs.readFileSync(path.join(root, 'public', 'index.html')));
    }
    if (!sameCookie(req)) return json(res, { error: 'Open the private control page first' }, 401);
    if (['/app.js','/api.js','/message-state.js','/style.css'].includes(url.pathname) && req.method === 'GET') { res.writeHead(200, { ...privateHeaders, 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css' }); return res.end(fs.readFileSync(path.join(root, 'public', url.pathname.slice(1)))); }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, { ...state, linkedBefore:linkedBefore(), enabled: engine.settings().enabled, ...engine.stats(), source,inboxSync:inboxSync.status,receiver:receiverWatchdog.status,mirror,journal:providerJournal.status });
    if (req.method === 'GET' && url.pathname === '/api/monitor') return json(res,monitor.snapshot());
    if(req.method==='GET'&&url.pathname==='/api/runtime-status'){
      const ready=runtime?.getReadiness?.();
      const timed=promise=>Promise.race([promise,new Promise(resolve=>{const t=setTimeout(()=>resolve(null),8000);t.unref();})]);
      // The pinned client declares getConnectionState unsupported. Probe only safe
      // connection metadata through its supported evaluate API instead.
      const [probe,number]=client?await Promise.all([timed(client.evaluate(()=>{const store=globalThis.Store,models=store?.Msg?.getModelsArray?.()||store?.Msg?._models||store?.Msg?.models||[];return{socket:store?.State?.Socket?.state||store?.State?.default?.state||null,loadedMessages:models.length,lastIncomingAt:models.slice(-200).reduce((latest,m)=>!m.id?.fromMe?Math.max(latest,Number(m.t||0)*1000):latest,0),online:navigator.onLine};}).catch(()=>null)),timed(client.getHostNumber().catch(()=>null))]):[null,null];
      return json(res,{state:runtime?.getState?.()||null,ready:ready?.ready||false,pending:ready?.pending||[],blockers:ready?.blockers||[],provider:probe,linkedNumberLast4:typeof number==='string'?number.replace(/\D/g,'').slice(-4):null,ingress,inboxSync:inboxSync.status,fastBridge,receiver:receiverWatchdog.status,mirror,journal:providerJournal.status,attachments:{active:attachmentQueue.active,pending:attachmentQueue.pending}});
    }
    if (req.method === 'GET' && url.pathname === '/api/session-status') {
      const portable = runtime?.getTransport?.()?.portable;
      const browser = runtime ? await runtime.evaluateScript('(() => { const p=globalThis.OpenWA_PortableSession; return {present:!!p,methods:p?Object.keys(p):[],startupFailure:p?.startupFailure?.()??null}; })()').catch(()=>null) : null;
      return json(res,{saved:fs.existsSync(path.join(root,'.sessions','rekha-29.data.json')),checkpoint:!!portable?.hasCheckpoint,revision:portable?.revision,documentBound:!!portable?.documentId,browser});
    }
    if (req.method === 'GET' && url.pathname === '/api/contacts') return json(res, engine.list('contact', '', url.searchParams.get('before') || '', 50));
    if (req.method === 'GET' && url.pathname === '/api/messages') { const peer = url.searchParams.get('peer'); if (!validPeer(peer)) return json(res, { error: 'Invalid chat' }, 400); const rows=url.searchParams.get('order')==='timeline'?engine.listMessagesTimeline(peer,url.searchParams.get('before')||'',50):{messages:engine.list('message',peer,url.searchParams.get('before')||'',50)};return json(res, { ...rows,jobs: engine.db.prepare("SELECT key FROM due_jobs WHERE peer=? AND state='unknown' LIMIT 30").all(peer).map(r => engine.get(r.key)), contact: engine.contact(peer) }); }
    if (req.method === 'GET' && /^\/media\/[a-f0-9]{64}$/.test(url.pathname)) {
      const file = path.join(data, 'media', url.pathname.slice(7)); if (!fs.existsSync(file)) return json(res, { error: 'Not found' }, 404);
      const saved=engine.db.prepare("SELECT json_extract(json,'$.media.mime') AS mime FROM records WHERE kind='message' AND json_extract(json,'$.media.id')=? LIMIT 1").get(url.pathname.slice(7));
      const mime=/^(image\/(jpeg|png|webp)|video\/mp4|audio\/(mpeg|ogg|mp4|wav)|application\/pdf)$/.test(saved?.mime||'')?saved.mime:'application/octet-stream';
      const inline=url.searchParams.get('inline')==='1'&&mime!=='application/octet-stream';
      res.writeHead(200, { ...privateHeaders, 'Content-Type': mime, 'Content-Disposition': (inline?'inline':'attachment')+'; filename="whatsapp-attachment"' }); return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'POST') {
      if (req.headers.origin !== origin || !String(req.headers['content-type']).startsWith('application/json')) return json(res, { error: 'Forbidden' }, 403);
      const input = await body(req);
      if(url.pathname==='/api/sync-inbox'){
        if(state.connection!=='connected'||!client)return json(res,{error:'WhatsApp is not connected. The saved login will be reused.'},409);
        if(input.peer!==undefined&&(!validPeer(input.peer)||!engine.contact(input.peer)))return json(res,{error:'Choose a saved chat first.'},400);
        if(manualSyncing||inboxSync.status.running||providerJournal.status.running)return json(res,{busy:true,recovered:0,outgoingMirrored:0,checkedAt:mirror.checkedAt,mirror,history:{requested:false,reason:'An inbox check is already running.'}},202);
        manualSyncing=true;
        const before={incoming:ingress.accepted,imported:inboxSync.status.imported,...mirrorCounters};
        try{
          const history=input.peer?await phoneHistory.request(input.peer):{requested:false,reason:''};
          await inboxSync.scan();await providerJournal.scan();await checkFastBridge();void sync();
          return json(res,{checkedAt:inboxSync.status.checkedAt,recovered:Math.max(0,ingress.accepted-before.incoming+inboxSync.status.imported-before.imported+mirrorCounters.journalImports-before.journalImports),outgoingMirrored:Math.max(0,mirrorCounters.outgoing-before.outgoing),updated:Math.max(0,mirrorCounters.mutations-before.mutations),mirror,history,journal:providerJournal.status});
        }finally{manualSyncing=false;}
      }
      if(url.pathname==='/api/mobile-link'){
        if(!mobileBridge)return json(res,{error:'Cloud backup is not configured'},409);
        return json(res,{...await mobileBridge.issueCode(),url:cloud+'/admin',apk:cloud+'/downloads/rekha-whatsapp-admin.apk'});
      }
      if(url.pathname==='/api/mobile-revoke'){
        if(mobileBridge)await mobileBridge.revoke();return json(res,{ok:true});
      }
      if(url.pathname==='/api/cleanup'){
        if(input.confirm!=='DELETE EXPIRED CONTENT')return json(res,{error:'Confirmation required'},400);
        engine.prune();void monitor.scan();void sync();return json(res,{ok:true});
      }
      if(url.pathname==='/api/delete-content'){
        if(input.confirm!=='DELETE CHAT CONTENT')return json(res,{error:'Confirmation required'},400);
        const result=engine.deleteContent(input.peer);
        removeMedia(result.media);
        void monitor.scan();void sync();return json(res,{deleted:result.deleted,more:result.more,cloudDeletion:'pending_backup'});
      }
      if (url.pathname === '/api/pairing') {
        if (!canPairWithPhone) return json(res, { error: 'Phone linking requires the cloud service.' }, 409);
        if ((connecting&&!['scan_qr','enter_code'].includes(state.connection))||['connected','restarting'].includes(state.connection) || stopping) return json(res, { error: 'WhatsApp is connected or restarting.' }, 409);
        if(linkedBefore()&&!['scan_qr','enter_code'].includes(state.connection))return json(res,{error:'The saved login will be reused. Choose Connect WhatsApp to restore the connection.'},409);
        if (!['phone','qr'].includes(input.mode)) return json(res, { error: 'Choose phone number or QR.' }, 400);
        const phone = typeof input.phone === 'string' && /^\+?[0-9 -]+$/.test(input.phone) ? input.phone.replace(/[+ -]/g, '') : '';
        if (input.mode === 'phone' && !/^[1-9][0-9]{7,14}$/.test(phone)) return json(res, { error: 'Enter your WhatsApp number with country code, for example +91 9876543210.' }, 400);
        if (input.mode === 'phone') fs.writeFileSync(pairingFile, phone, { mode: 0o600 });
        else if (fs.existsSync(pairingFile)) fs.unlinkSync(pairingFile);
        state.connection = 'restarting'; state.qr = null; state.pairingCode = null;
        json(res, { restarting: true });
        setTimeout(() => void shutdown(75), 250);
        return;
      }
      if (url.pathname === '/api/connect') { void connect(); return json(res, { starting: true }); }
      if (url.pathname === '/api/enabled') { engine.enable(!!input.enabled); return json(res, { enabled: engine.settings().enabled }); }
      if (url.pathname === '/api/send') { const value = engine.manual(input.peer, input.body, input.requestId); void pump(); return json(res, value); }
      if (!validPeer(input.peer)) return json(res, { error: 'Invalid customer' }, 400);
      if (url.pathname === '/api/pause') engine.pauseContact(input.peer, !!input.paused);
      else if (url.pathname === '/api/payment') engine.verifyPayment(input.peer, !!input.verified);
      else if (url.pathname === '/api/seen') { engine.markSeen(input.peer); if (client && state.connection === 'connected'&&!engine.contact(input.peer)?.isSelf) void client.sendSeen(input.peer).catch(() => { state.error = 'WhatsApp read receipt could not be confirmed.'; }); }
      else if (url.pathname === '/api/resolve') { if (engine.get(input.key)?.peer !== input.peer) throw Error('Invalid job'); engine.resolveUnknown(input.key, input.action); }
      else return json(res, { error: 'Not found' }, 404);
      return json(res, { ok: true });
    }
    return json(res, { error: 'Not found' }, 404);
  } catch (error) { return json(res, { error: ['Unknown customer','Customer has opted out','Invalid message','Invalid resolution'].includes(error.message) ? error.message : 'Could not complete the request' }, 400); }
});
server.listen(port, '127.0.0.1', () => console.log(`Private WhatsApp controls: ${origin}`));
const pumping = setInterval(() => void pump(), 1000), backing = setInterval(() => void sync(), 15000);
const inboxPolling=setInterval(()=>{if(!stopping&&client&&state.connection==='connected')void inboxSync.scan().then(()=>sync());},15000);
const journalPolling=setInterval(()=>{if(!stopping&&client&&state.connection==='connected')void providerJournal.scan().then(()=>sync());},15000);
const bridgeChecking=setInterval(()=>{if(!stopping)void receiverWatchdog.tick();},3000);
const mobilePolling=setInterval(()=>void mobileBridge?.poll(),5000);
const housekeeping = setInterval(() => {
  engine.prune();
  const expiry = Date.now() - 90 * 86400000;
  for (const entry of fs.readdirSync(path.join(data, 'media'), { withFileTypes: true })) if (entry.isFile() && fs.statSync(path.join(data,'media',entry.name)).mtimeMs < expiry) fs.unlinkSync(path.join(data,'media',entry.name));
}, 3600000);
async function shutdown(exitCode = 0) { if (stopping) return; stopping = true;receiverProbe.cancel();attachmentQueue.close(); mobileBridge?.close();monitor.close();clearInterval(bridgeChecking);clearInterval(inboxPolling);clearInterval(journalPolling);clearInterval(mobilePolling); clearInterval(pumping); clearInterval(backing); clearInterval(housekeeping); server.close(); if(connecting)try{await runtime?.stop?.('Gateway stopping');}catch{} while (busy||syncing||mediaActive||attachmentQueue.active||mobileBridge?.busy||inboxSync.status.running||providerJournal.status.running||checkingBridge||connecting||receiverWatchdog.busy||manualSyncing||phoneHistory.busy) await sleep(100);try { await client?.stop('Owner stopped gateway'); } catch {} engine.close(); process.exit(exitCode); }
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
void sync();
void mobileBridge?.poll();
if (process.env.AUTO_CONNECT === 'true') void connect();
