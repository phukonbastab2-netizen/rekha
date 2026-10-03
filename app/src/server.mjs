import { localOwnerAdapter } from './owner-adapter.mjs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { configuration } from './config.mjs';
import { database } from './db.mjs';
import { generateReply } from './ai.mjs';
import { paymentProvider, validSignature } from './payments.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const hash = text => createHash('sha256').update(text).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const fail = (status, message) => Object.assign(new Error(message), { status });
const welcome = {
  en: 'Namaste. This is a quiet space for your questions. What’s on your mind today? Your birth details can support a future kundli; a complete chart also needs birth time and birthplace. No chart has been calculated yet.',
  hi: 'नमस्ते। आज आप किस विषय पर बात करना चाहते हैं? आपकी जन्म जानकारी कुंडली बनाने में उपयोग होगी। पूरी कुंडली के लिए जन्म समय और जन्म स्थान भी चाहिए। अभी कुंडली की गणना नहीं हुई है।',
  hinglish: 'Namaste. Aaj aap kis baare mein baat karna chahte hain? Aapki birth details kundli banane mein kaam aayengi. Poori kundli ke liye birth time aur birthplace bhi chahiye. Abhi chart calculate nahi hua hai.',
};

function validDOB(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value || value < '1900-01-01') return false;
  const cutoff = new Date(); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 18);
  return date <= cutoff;
}

function preferences(value = {}) {
  let location = null;
  if (value.location != null) {
    const { latitude, longitude } = value.location;
    if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw fail(400, 'Invalid location.');
    location = { latitude: Math.round(latitude * 10) / 10, longitude: Math.round(longitude * 10) / 10 };
  }
  return { remember: value.remember === true, location, consentVersion: '2026-09-24' };
}

export function createApp(config, dependencies = {}) {
  const db = database(config.dataDir);
  const ownerAdapter=localOwnerAdapter(db,config);
  // A preview unlock must never survive a switch to real checkout.
  if (config.paymentMode !== 'demo') db.prepare("UPDATE conversations SET entitlement='free' WHERE entitlement='demo'").run();
  const ai = dependencies.generateReply || generateReply;
  const payments = dependencies.payments || paymentProvider(config);
  const sessions = new Map(), limits = new Map(), jobs = new Map(), orderLocks = new Set();
  let closed = false;
  const getChat = id => db.prepare('SELECT *, (SELECT COUNT(*) FROM reward_grants WHERE conversation_id=conversations.id) AS rewards FROM conversations WHERE id=?').get(id);
  const messages = id => db.prepare('SELECT id, role, kind, body, status, created FROM messages WHERE conversation_id=? ORDER BY id').all(id);
  const pending = id => db.prepare("SELECT * FROM messages WHERE conversation_id=? AND role='user' AND status IN ('pending','failed') ORDER BY id DESC LIMIT 1").get(id);
  const addMessage = (id, role, kind, body, status = 'sent', clientId = null) => Number(db.prepare('INSERT INTO messages(conversation_id,role,kind,body,status,client_id,created) VALUES(?,?,?,?,?,?,?)').run(id, role, kind, body, status, clientId, Date.now()).lastInsertRowid);
  const touch = id => db.prepare('UPDATE conversations SET updated=? WHERE id=?').run(Date.now(), id);
  function view(chat, admin = false) {
    return { id: chat.id, name: chat.name, dob: chat.dob, language: chat.language, preferences: JSON.parse(chat.preferences),
      ...(admin ? { mode: chat.mode, version: chat.version } : {}), rewardedReplies: chat.rewards || 0, freeUsed: chat.free_used, freeRemaining: Math.max(0, config.freeTurns + (chat.rewards || 0) - chat.free_used),
      entitlement: chat.entitlement, locked: chat.entitlement === 'free' && chat.free_used >= config.freeTurns + (chat.rewards || 0),
      messages: messages(chat.id), ...(admin ? { draft: db.prepare('SELECT * FROM drafts WHERE conversation_id=?').get(chat.id) || null } : {}) };
  }
  function finishReply(chat, userMessage, body, kind) {
    db.exec('BEGIN IMMEDIATE');
    try {
      addMessage(chat.id, 'assistant', kind, body);
      db.prepare("UPDATE messages SET status='answered' WHERE conversation_id=? AND role='user' AND id<=? AND status IN ('pending','failed')").run(chat.id,userMessage.id);
      db.prepare('UPDATE conversations SET free_used=free_used+1, updated=? WHERE id=?').run(Date.now(), chat.id);
      db.prepare('DELETE FROM drafts WHERE conversation_id=?').run(chat.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function cancelJob(id) { jobs.get(id)?.controller.abort(); }
  function schedule(id) {
    if (closed || jobs.has(id)) return;
    const chat = getChat(id), message = pending(id);
    if (!chat || chat.mode === 'manual' || !message || message.status !== 'pending' || (chat.entitlement==='free' && chat.free_used>=config.freeTurns+(chat.rewards||0))) return;
    if (db.prepare('SELECT 1 FROM drafts WHERE conversation_id=? AND message_id=? AND version=?').get(id, message.id, chat.version)) return;
    const controller = new AbortController();
    const entry = { controller, promise: null }; jobs.set(id, entry);
    entry.promise = (async () => {
      try {
        const result = await ai(config, chat, messages(id), controller.signal);
        if (closed) return;
        const current = getChat(id), currentMessage = pending(id);
        if (controller.signal.aborted || !current || current.version !== chat.version || current.mode !== chat.mode || currentMessage?.id !== message.id) return;
        if (chat.mode === 'assist') {
          db.prepare('INSERT OR REPLACE INTO drafts(conversation_id,message_id,body,kind,version) VALUES(?,?,?,?,?)').run(id, message.id, result.body, result.kind, chat.version);
        } else finishReply(current, message, result.body, result.kind);
      } catch {
        if (!closed && !controller.signal.aborted && getChat(id)?.version === chat.version) db.prepare("UPDATE messages SET status='failed' WHERE id=? AND status='pending'").run(message.id);
      } finally {
        jobs.delete(id);
        if (!closed) schedule(id);
      }
    })();
  }
  function cookie(res, key, value, remember = false, remove = false) {
    res.setHeader('Set-Cookie', `${key}=${value}; Path=/; HttpOnly; SameSite=Strict${config.production ? '; Secure' : ''}${remove ? '; Max-Age=0' : remember ? '; Max-Age=31536000' : ''}`);
  }
  function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('='))); }
  function customer(req) {
    const value = cookies(req).ar_session;
    const chat = value && db.prepare('SELECT *, (SELECT COUNT(*) FROM reward_grants WHERE conversation_id=conversations.id) AS rewards FROM conversations WHERE token_hash=?').get(hash(value));
    if (!chat) throw fail(401, 'Your chat session has ended. Please start again.');
    const expected = req.headers['x-rekha-chat'];
    if (['POST','PUT','PATCH','DELETE'].includes(req.method) && expected !== undefined && expected !== chat.id) throw fail(409, 'This chat session changed. Reopen your saved conversation before sending.');
    return chat;
  }
  function admin(req) {
    const value = cookies(req).ar_admin, expires = value && sessions.get(hash(value));
    if (!expires || expires < Date.now()) throw fail(401, 'Please sign in to the owner panel.');
  }
  function rate(key, max, windowMs = 60000) {
    const now = Date.now(), current = limits.get(key);
    if (!current || current.until < now) { limits.set(key, { count: 1, until: now + windowMs }); return; }
    if (++current.count > max) throw fail(429, 'Too many requests. Please wait a minute and try again.');
  }
  async function readBody(req, raw = false) {
    let total = 0; const chunks = [];
    for await (const chunk of req) { total += chunk.length; if (total > 32768) throw fail(413, 'Request too large.'); chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    if (raw) return body;
    if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'JSON required.');
    try { const parsed = JSON.parse(body.toString() || '{}'); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw Error(); return parsed; }
    catch { throw fail(400, 'Invalid request.'); }
  }
  function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
  function captured(order, payment) {
    return payment.order_id === order.id && payment.amount === config.amount && payment.currency === 'INR' && payment.status === 'captured' && payment.captured === true && !(payment.amount_refunded > 0);
  }
  function unlock(order, paymentId) {
    if (order.status === 'paid') return;
    if (order.status === 'refunded') throw fail(409, 'This payment has been refunded.');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE orders SET status='paid',payment_id=? WHERE id=?").run(paymentId, order.id);
      db.prepare("UPDATE conversations SET entitlement='paid',updated=? WHERE id=?").run(Date.now(), order.conversation_id);
      addMessage(order.conversation_id, 'system', 'payment', '₹49');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function cleanup() {
    const cutoff = Date.now() - config.retentionDays * 86400000;
    for (const row of db.prepare('SELECT id FROM conversations WHERE updated<?').all(cutoff)) cancelJob(row.id);
    db.prepare('DELETE FROM conversations WHERE updated<?').run(cutoff);
    for (const [key, value] of sessions) if (value < Date.now()) sessions.delete(key);
    for (const [key, value] of limits) if (value.until < Date.now()) limits.delete(key);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  cleanup();
  const timer = setInterval(cleanup, 3600000); timer.unref();
  for (const row of db.prepare("SELECT DISTINCT conversation_id FROM messages WHERE status='pending'").all()) schedule(row.conversation_id);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), payment=(self "https://api.razorpay.com" "https://checkout.razorpay.com"), geolocation=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.razorpay.com; media-src 'self'; connect-src 'self' https://*.razorpay.com; frame-src https://*.razorpay.com; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    try {
      const url = new URL(req.url, config.origin), route = url.pathname;
      const mutating = ['POST', 'PATCH', 'DELETE'].includes(req.method);
      if (mutating && route !== '/api/payments/webhook') {
        if (req.headers.origin !== config.origin) throw fail(403, 'Request origin not allowed.');
        rate(`write:${req.socket.remoteAddress}`, 100);
      }
      if (req.method === 'GET' && route === '/api/config') return json(res, 200, { aiMode: config.aiMode, paymentMode: config.paymentMode, paymentTest: config.razorKey.startsWith('rzp_test_'), freeTurns: config.freeTurns, amount: config.amount, retentionDays: config.retentionDays });
      if (req.method === 'GET' && route === '/api/health') return json(res, 200, { ok: true });
      if (route === '/api/start' && req.method === 'POST') {
        rate(`signup:${req.socket.remoteAddress}`, 12, 3600000);
        const data = await readBody(req);
        if (cookies(req).ar_session && db.prepare('SELECT 1 FROM conversations WHERE token_hash=?').get(hash(cookies(req).ar_session))) throw fail(409, 'You already have a chat. Reload to continue.');
        if (typeof data.name !== 'string' || data.name.trim().length < 1 || data.name.trim().length > 60 || !validDOB(data.dob) || !['en','hi','hinglish'].includes(data.language) || data.consent !== true) throw fail(400, 'Enter a valid name and birth date, confirm you are 18+, and accept the privacy notice.');
        const prefs = preferences(data.preferences), id = randomUUID(), session = token();
        db.prepare('INSERT INTO conversations(id,token_hash,name,dob,language,preferences,created,updated) VALUES(?,?,?,?,?,?,?,?)').run(id, hash(session), data.name.trim(), data.dob, data.language, JSON.stringify(prefs), Date.now(), Date.now());
        addMessage(id, 'assistant', 'welcome', welcome[data.language]);
        cookie(res, 'ar_session', session, true);
        return json(res, 201, view(getChat(id)));
      }
      if(route.startsWith('/api/media/')){await ownerAdapter({req,res,url,readBody,owner:()=>admin(req),customer:()=>customer(req),get:getChat,view,pending,fail});return;}
      if (route === '/api/chat' && req.method === 'GET') {const chat=customer(req);cookie(res,'ar_session',cookies(req).ar_session,true);return json(res,200,view(chat));}
      if (route === '/api/chat' && req.method === 'DELETE') {
        const chat = customer(req); cancelJob(chat.id);
        db.prepare('DELETE FROM conversations WHERE id=?').run(chat.id);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        cookie(res, 'ar_session', '', false, true); return json(res, 200, { deleted: true });
      }
      if (route === '/api/preferences' && req.method === 'PATCH') {
        const chat = customer(req), data = await readBody(req), prefs = preferences(data);
        cancelJob(chat.id);
        db.prepare('UPDATE conversations SET preferences=?,version=version+1,updated=? WHERE id=?').run(JSON.stringify(prefs), Date.now(), chat.id);
        db.prepare('DELETE FROM drafts WHERE conversation_id=?').run(chat.id);
        cookie(res, 'ar_session', cookies(req).ar_session, true); schedule(chat.id);
        return json(res, 200, view(getChat(chat.id)));
      }
      if (route === '/api/messages' && req.method === 'POST') {
        const chat = customer(req), data = await readBody(req);
        rate(`chat:${chat.id}`, 12);
        if (typeof data.body !== 'string' || !data.body.trim() || data.body.length > 2000 || typeof data.clientId !== 'string' || !/^[\w-]{16,80}$/.test(data.clientId)) throw fail(400, 'Write a message of 1–2000 characters.');
        if (db.prepare('SELECT 1 FROM messages WHERE conversation_id=? AND client_id=?').get(chat.id, data.clientId)) return json(res, 200, view(getChat(chat.id)));
        if (chat.entitlement === 'free' && chat.free_used >= config.freeTurns + (chat.rewards || 0)) throw fail(402, 'Unlock continued chat for ₹49.');
        addMessage(chat.id, 'user', 'customer', data.body.trim(), 'pending', data.clientId);
        db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(chat.id);
        db.prepare('DELETE FROM drafts WHERE conversation_id=?').run(chat.id);
        touch(chat.id); schedule(chat.id);
        return json(res, 202, view(getChat(chat.id)));
      }
      if (route === '/api/retry' && req.method === 'POST') {
        const chat = customer(req); rate(`retry:${chat.id}`, 5);
        const message = pending(chat.id);
        if (!message || message.status !== 'failed' || chat.mode === 'manual') throw fail(409, 'No reply to retry.');
        db.prepare("UPDATE messages SET status='pending' WHERE id=?").run(message.id); schedule(chat.id);
        return json(res, 202, view(getChat(chat.id)));
      }
      if (route === '/api/payment/demo' && req.method === 'POST') {
        const chat = customer(req);
        if (config.production || config.paymentMode !== 'demo') throw fail(404, 'Not available.');
        if (chat.entitlement === 'free') {
          db.prepare("UPDATE conversations SET entitlement='demo',updated=? WHERE id=?").run(Date.now(), chat.id);
          addMessage(chat.id, 'system', 'demo-payment', '₹49');
        }
        return json(res, 200, view(getChat(chat.id)));
      }
      if (route === '/api/payment/order' && req.method === 'POST') {
        const chat = customer(req);
        if (config.paymentMode !== 'razorpay') throw fail(409, 'Live checkout is not configured.');
        if (chat.entitlement !== 'free') throw fail(409, 'This chat is already unlocked.');
        if (orderLocks.has(chat.id)) throw fail(409, 'Checkout is already opening.');
        rate(`order:${chat.id}`, 5); orderLocks.add(chat.id);
        try {
          let order = db.prepare("SELECT * FROM orders WHERE conversation_id=? AND status='created' ORDER BY created DESC LIMIT 1").get(chat.id);
          if (!order) {
            const created = await payments.create(randomUUID());
            if (created.amount !== config.amount || created.currency !== 'INR' || typeof created.id !== 'string') throw fail(502, 'Invalid payment order.');
            if (!getChat(chat.id)) throw fail(409, 'Chat was deleted.');
            db.prepare('INSERT INTO orders(id,conversation_id,created) VALUES(?,?,?)').run(created.id, chat.id, Date.now());
            order = created;
          }
          return json(res, 200, { id: order.id, key: config.razorKey, amount: config.amount, currency: 'INR' });
        } finally { orderLocks.delete(chat.id); }
      }
      if (route === '/api/payment/verify' && req.method === 'POST') {
        const chat = customer(req), data = await readBody(req);
        if (config.paymentMode !== 'razorpay') throw fail(404, 'Not available.');
        const order = typeof data.razorpay_order_id === 'string' && db.prepare('SELECT * FROM orders WHERE id=? AND conversation_id=?').get(data.razorpay_order_id, chat.id);
        if (!order || typeof data.razorpay_payment_id !== 'string' || !validSignature(`${order.id}|${data.razorpay_payment_id}`, data.razorpay_signature, config.razorSecret)) throw fail(400, 'Payment could not be verified.');
        const payment = await payments.fetchPayment(data.razorpay_payment_id);
        if (payment.id !== data.razorpay_payment_id || !captured(order, payment)) throw fail(409, 'Payment is not captured yet. This chat will unlock after confirmation.');
        const current = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
        if (!current || !getChat(chat.id)) throw fail(409, 'Chat was deleted.');
        unlock(current, payment.id); return json(res, 200, view(getChat(chat.id)));
      }
      if (route === '/api/payments/webhook' && req.method === 'POST') {
        if (config.paymentMode !== 'razorpay') throw fail(404, 'Not available.');
        const raw = await readBody(req, true);
        if (!validSignature(raw, req.headers['x-razorpay-signature'], config.webhookSecret)) throw fail(400, 'Invalid webhook signature.');
        let data; try { data = JSON.parse(raw.toString()); } catch { throw fail(400, 'Invalid webhook.'); }
        const payment = data.payload?.payment?.entity;
        if (data.event === 'payment.captured' && payment) {
          const order = db.prepare('SELECT * FROM orders WHERE id=?').get(payment.order_id);
          if (order && order.status !== 'refunded' && captured(order, payment)) unlock(order, payment.id);
        }
        if (data.event === 'refund.processed') {
          const refund = data.payload?.refund?.entity;
          const order = refund?.payment_id && db.prepare("SELECT * FROM orders WHERE payment_id=? AND status='paid'").get(refund.payment_id);
          if (order && refund.amount >= config.amount) {
            db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(order.id);
            db.prepare("UPDATE conversations SET entitlement='free',version=version+1 WHERE id=?").run(order.conversation_id);
            cancelJob(order.conversation_id);
            db.prepare('DELETE FROM drafts WHERE conversation_id=?').run(order.conversation_id);
            db.prepare("UPDATE messages SET status='cancelled' WHERE conversation_id=? AND status IN ('pending','failed')").run(order.conversation_id);
            addMessage(order.conversation_id, 'system', 'refund', '₹49');
          }
        }
        return json(res, 200, { received: true });
      }
      if (route === '/api/admin/login' && req.method === 'POST') {
        rate(`login:${req.socket.remoteAddress}`, 6, 300000);
        const data = await readBody(req);
        if (typeof data.password !== 'string' || !timingSafeEqual(Buffer.from(hash(data.password)), Buffer.from(hash(config.adminPassword)))) throw fail(401, 'Incorrect owner password.');
        const session = token(); sessions.set(hash(session), Date.now() + 8 * 3600000);
        cookie(res, 'ar_admin', session); return json(res, 200, { ok: true });
      }
      if (route.startsWith('/api/admin/')) {
        admin(req);
        if(await ownerAdapter({req,res,url,readBody,owner:()=>admin(req),customer:()=>customer(req),get:getChat,view,pending,fail}))return;
        if (route === '/api/admin/logout' && req.method === 'POST') { sessions.delete(hash(cookies(req).ar_admin)); cookie(res, 'ar_admin', '', false, true); return json(res, 200, { ok: true }); }
        if (route === '/api/admin/conversations' && req.method === 'GET') return json(res, 200, db.prepare(`SELECT c.id,c.name,c.language,c.mode,c.entitlement,c.updated,c.free_used,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status IN ('pending','failed')) AS waiting
          FROM conversations c ORDER BY c.updated DESC LIMIT 500`).all());
        const match = route.match(/^\/api\/admin\/conversations\/([a-f0-9-]+)(?:\/(mode|reply|retry))?$/);
        if (match) {
          const chat = getChat(match[1]); if (!chat) throw fail(404, 'Conversation not found.');
          if (!match[2] && req.method === 'GET') return json(res, 200, view(chat, true));
          const data = await readBody(req);
          if (match[2] === 'mode' && req.method === 'PATCH') {
            if (!['ai','assist','manual'].includes(data.mode)) throw fail(400, 'Invalid mode.');
            if (chat.mode !== data.mode) {
              cancelJob(chat.id);
              db.prepare('UPDATE conversations SET mode=?,version=version+1,updated=? WHERE id=?').run(data.mode, Date.now(), chat.id);
              db.prepare('DELETE FROM drafts WHERE conversation_id=?').run(chat.id);
              db.prepare("UPDATE messages SET status='pending' WHERE conversation_id=? AND status='failed'").run(chat.id);
              schedule(chat.id);
            }
            return json(res, 200, view(getChat(chat.id), true));
          }
          if (match[2] === 'retry' && req.method === 'POST') {
            const message = pending(chat.id);
            if (!message || message.status !== 'failed' || chat.mode === 'manual') throw fail(409, 'No failed AI reply.');
            db.prepare("UPDATE messages SET status='pending' WHERE id=?").run(message.id); schedule(chat.id);
            return json(res, 202, view(getChat(chat.id), true));
          }
          if (match[2] === 'reply' && req.method === 'POST') {
            const message = pending(chat.id);
            if (chat.mode === 'ai' || !message || data.messageId !== message.id || data.version !== chat.version) throw fail(409, 'The chat changed. Refresh before sending.');
            if (typeof data.body !== 'string' || !data.body.trim() || data.body.length > 4000) throw fail(400, 'Reply must contain 1–4000 characters.');
            cancelJob(chat.id);
            finishReply(chat, message, data.body.trim(), chat.mode === 'assist' ? 'human-assisted' : 'human');
            return json(res, 200, view(getChat(chat.id), true));
          }
        }
        throw fail(404, 'Not found.');
      }
      if (route.startsWith('/api/')) throw fail(404, 'Not found.');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Method not allowed.');
      const assets = { '/': 'index.html', '/admin': 'admin.html', '/admin/': 'admin.html', '/app.js': 'app.js', '/admin.js': 'admin.js', '/library.js': 'library.js', '/media.js': 'media.js', '/styles.css': 'styles.css', '/chat.css':'chat.css', '/admin.css': 'admin.css', '/locales.js': 'locales.js', '/rekha-portrait.png': 'rekha-portrait.png', '/art.svg': 'art.svg', '/icon.svg': 'icon.svg', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png', '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js', '/offline.html': 'offline.html' };
      for(const slug of ['welcome','introduction','testimonials'])assets['/intro/'+slug+'.mp4']='intro/'+slug+'.mp4';
      const asset = assets[route]; if (!asset) throw fail(404, 'Not found.');
      const ext = path.extname(asset), types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
      res.setHeader('Content-Type', ext==='.mp4'?'video/mp4':`${types[ext]}; charset=utf-8`);
      const file = await readFile(path.join(root, asset)); res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 503, { error: error.status ? error.message : 'The service is temporarily unavailable. Please try again.' });
      else res.end();
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  return { server, db, async close() { closed = true; clearInterval(timer); for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...jobs.values()].map(j => j.promise)); await new Promise(resolve => server.close(resolve)); db.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = configuration(); const app = createApp(config);
    app.server.listen(config.port, config.host, () => console.log(`AstroRani: ${config.origin}\nOwner: ${config.origin}/admin\nAI: ${config.aiMode} | Payments: ${config.paymentMode}`));
    for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
