import { DatabaseSync } from 'node:sqlite';
import { firstSequence, mediaSequence, reminder, GAP, REMINDER_DELAY, MEDIA_DELAY } from './funnel.mjs';

export const validPeer = peer => typeof peer === 'string' && /^[0-9]{5,25}@(c\.us|lid|s\.whatsapp\.net)$/.test(peer);
export const isSensitive = text => /\b(?:otp|one.time (?:password|code)|verification code|security code|cvv|password|pin)\b.{0,35}\b\d{3,8}\b|\b\d{3,8}\b.{0,35}\b(?:otp|verification code)\b/i.test(text);
export class Engine {
  constructor(path, now = () => Date.now()) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY,kind TEXT NOT NULL,peer TEXT NOT NULL DEFAULT '',stamp INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_kind_stamp ON records(kind,stamp);
      CREATE INDEX IF NOT EXISTS records_peer_kind_stamp ON records(peer,kind,stamp);
      CREATE INDEX IF NOT EXISTS records_provider ON records(json_extract(json,'$.providerId')) WHERE kind='message';
      CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT NOT NULL,kind TEXT NOT NULL,peer TEXT NOT NULL,stamp INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,peer TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS due_jobs(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT UNIQUE NOT NULL,peer TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due_state ON due_jobs(state,due_at);
      CREATE INDEX IF NOT EXISTS jobs_peer_state ON due_jobs(peer,state);`);
    // A crash between reservation and ACK has an uncertain send outcome. Never resend it blindly.
    for (const row of this.db.prepare("SELECT key FROM due_jobs WHERE state='sending'").all()) {
      const job = this.get(row.key);
      this.transaction(() => { this.put({ ...job, state: 'unknown', error: 'Restart during send; check WhatsApp before resolving.' }); this.pauseContact(job.peer, true); });
    }
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(key) { const row = this.db.prepare('SELECT json FROM records WHERE key=?').get(key); return row ? JSON.parse(row.json) : null; }
  put(value) {
    const stamp = this.now(), json = JSON.stringify(value), peer = value.peer || '';
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,peer=excluded.peer,stamp=excluded.stamp,json=excluded.json').run(value.key, value.kind, peer, stamp, json);
    this.db.prepare('INSERT INTO changes(key,kind,peer,stamp,json) VALUES(?,?,?,?,?)').run(value.key, value.kind, peer, stamp, json);
    if (value.kind === 'job') this.db.prepare('INSERT INTO due_jobs(key,peer,due_at,state) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET due_at=excluded.due_at,state=excluded.state').run(value.key, peer, value.dueAt, value.state);
    return value;
  }
  list(kind, peer = '', before = Number.MAX_SAFE_INTEGER, limit = 50) {
    let stamp = Number.MAX_SAFE_INTEGER, key = '\uffff';
    if (typeof before === 'string' && before.length < 1500) { try { const c = JSON.parse(Buffer.from(before, 'base64url').toString()); if (Number.isSafeInteger(c.stamp) && typeof c.key === 'string') { stamp = c.stamp; key = c.key; } } catch {} }
    const rows = peer ? this.db.prepare('SELECT stamp,key,json FROM records WHERE peer=? AND kind=? AND (stamp<? OR (stamp=? AND key<?)) ORDER BY stamp DESC,key DESC LIMIT ?').all(peer, kind, stamp, stamp, key, limit)
      : this.db.prepare('SELECT stamp,key,json FROM records WHERE kind=? AND (stamp<? OR (stamp=? AND key<?)) ORDER BY stamp DESC,key DESC LIMIT ?').all(kind, stamp, stamp, key, limit);
    return rows.map(r => ({ ...JSON.parse(r.json), _cursor: Buffer.from(JSON.stringify({ stamp: r.stamp, key: r.key })).toString('base64url') }));
  }
  settings() { return this.get('settings') || { key: 'settings', kind: 'settings', enabled: false }; }
  enable(enabled) { this.put({ ...this.settings(), enabled: !!enabled }); }
  contact(peer) { return this.get('contact:' + peer); }
  pauseContact(peer, paused) { const c = this.contact(peer); if (c) this.put({ ...c, paused }); }
  verifyPayment(peer, verified) { const c = this.contact(peer); if (!c) throw Error('Unknown customer'); this.put({ ...c, payment: verified ? 'verified_by_owner' : 'pending', paymentCheckedAt: this.now() }); }
  job(peer, phase, step, dueAt, payload) {
    const key = `job:${peer}:${phase}:${step}`;
    if (this.get(key)) return;
    this.put({ key, kind: 'job', peer, phase, step, dueAt, payload, state: 'queued', createdAt: this.now() });
  }
  inbound(input) {
    if (!validPeer(input.peer) || typeof input.id !== 'string' || input.id.length > 300 || !input.id) return { ignored: true };
    const body = String(input.body || '').slice(0, 8000), sensitive = isSensitive(body);
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM receipts WHERE id=?').get(input.id)) return { duplicate: true };
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(input.id, input.peer, this.now());
      let c = this.contact(input.peer);
      const isNew = !c;
      if (!c) c = { key: 'contact:' + input.peer, kind: 'contact', peer: input.peer, name: String(input.name || '').slice(0, 100), firstAt: this.now(), stage: 'new', optedOut: false, paused: false, payment: 'not_received', unread: 0, firstStarted: false, reminderScheduled: false, mediaScheduled: false, lastSentAt: 0 };
      c = { ...c, lastAt: this.now(), lastInboundAt: this.now(), unread: c.unread + 1, preview: sensitive ? '[Sensitive message omitted]' : (body || '[' + input.type + ']').slice(0, 150) };
      this.put({ key: 'in:' + input.id, kind: 'message', peer: input.peer, id: input.id, direction: 'in', type: input.type || 'text', body: sensitive ? '[Sensitive message omitted]' : body, at: input.at || this.now(), receivedAt: this.now(), sensitive, status: 'received', media: sensitive ? null : input.media || null });
      const command = body.trim().toLowerCase();
      if (['stop', 'unsubscribe', 'बंद', 'बंद करें'].includes(command)) {
        c.optedOut = true;
        for (const row of this.db.prepare("SELECT key FROM due_jobs WHERE peer=? AND state='queued'").all(c.peer)) this.put({ ...this.get(row.key), state: 'cancelled', error: 'Customer opted out' });
      } else if (command === 'start') c.optedOut = false;
      if (!sensitive && !c.optedOut && !c.firstStarted) {
        c.firstStarted = true; c.stage = 'first_sequence';
        firstSequence.forEach((p, i) => this.job(c.peer, 'first', i, this.now() + i * GAP, p));
      } else if (!sensitive && !c.optedOut && !isNew && c.stage === 'waiting_for_details' && !c.reminderScheduled) {
        c.reminderScheduled = true; this.job(c.peer, 'reminder', 0, this.now() + REMINDER_DELAY, reminder);
      }
      if (!sensitive && !c.optedOut && ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(input.type) && !c.mediaScheduled) {
        c.mediaScheduled = true; c.payment = 'pending';
        mediaSequence.forEach((p, i) => this.job(c.peer, 'media', i, this.now() + MEDIA_DELAY + i * GAP, p));
      }
      this.put(c);
      return { accepted: true };
    });
  }
  markSeen(peer) { const c = this.contact(peer); if (c) this.put({ ...c, unread: 0 }); }
  manual(peer, body, requestId) {
    if (!this.contact(peer) || !validPeer(peer)) throw Error('Unknown customer');
    if (this.contact(peer).optedOut) throw Error('Customer has opted out');
    body = String(body || '').trim();
    if (!body || body.length > 8000 || !/^[a-zA-Z0-9-]{10,80}$/.test(requestId)) throw Error('Invalid message');
    return this.transaction(() => { this.job(peer, 'manual-' + requestId, 0, this.now(), { type: 'text', body }); return { queued: true }; });
  }
  reserve() {
    return this.transaction(() => {
      // Bounded indexed due query. No repeated full contact/history scans.
      for (const row of this.db.prepare(`SELECT j.key FROM due_jobs j JOIN records c ON c.key='contact:'||j.peer
        WHERE j.state='queued' AND j.due_at<=? AND json_extract(c.json,'$.optedOut')=0
        AND (json_extract(c.json,'$.paused')=0 OR json_extract((SELECT json FROM records WHERE key=j.key),'$.phase') LIKE 'manual-%')
        AND (?=1 OR json_extract((SELECT json FROM records WHERE key=j.key),'$.phase') LIKE 'manual-%')
        AND ?-json_extract(c.json,'$.lastSentAt')>=?
        AND NOT EXISTS(SELECT 1 FROM due_jobs blocking WHERE blocking.peer=j.peer AND blocking.state IN ('sending','unknown'))
        ORDER BY j.due_at,j.ordinal LIMIT 100`).all(this.now(), this.settings().enabled ? 1 : 0, this.now(), GAP)) {
        const j = this.get(row.key), c = this.contact(j.peer);
        if (!c || c.optedOut || (c.paused && !j.phase.startsWith('manual-')) || (!this.settings().enabled && !j.phase.startsWith('manual-'))) continue;
        if (this.now() - c.lastSentAt < GAP) continue;
        const blocked = this.db.prepare("SELECT key FROM due_jobs WHERE peer=? AND state IN ('sending','unknown') LIMIT 1").get(j.peer);
        if (blocked) continue;
        if (j.step > 0 && this.get(`job:${j.peer}:${j.phase}:${j.step - 1}`)?.state !== 'accepted') continue;
        return this.put({ ...j, state: 'sending', startedAt: this.now() });
      }
      return null;
    });
  }
  finish(key, providerId, error = '') {
    this.transaction(() => {
      const j = this.get(key);
      if (!j || !['sending', 'unknown'].includes(j.state)) return;
      const accepted = typeof providerId === 'string' && providerId.length > 0;
      this.put({ ...j, state: accepted ? 'accepted' : 'unknown', providerId: providerId || null, error: accepted ? '' : error || 'Outcome unknown. Check WhatsApp before resolving.', completedAt: this.now() });
      const c = this.contact(j.peer);
      this.put({ ...c, lastSentAt: this.now(), paused: accepted ? c.paused : true, stage: accepted && j.phase === 'first' && j.step === firstSequence.length - 1 ? 'waiting_for_details' : c.stage });
      this.put({ key: 'out:' + key, kind: 'message', peer: j.peer, direction: 'out', id: key, type: j.payload.type, body: j.payload.body, url: j.payload.url, at: this.now(), source: j.phase.startsWith('manual-') ? 'owner' : 'funnel', status: accepted ? 'accepted' : 'unknown', providerId: providerId || null });
    });
  }
  resolveUnknown(key, action) {
    this.transaction(() => {
      const j = this.get(key);
      if (!j || j.state !== 'unknown' || !['sent', 'skip', 'retry'].includes(action)) throw Error('Invalid resolution');
      this.put({ ...j, state: action === 'retry' ? 'queued' : 'accepted', dueAt: this.now(), error: action === 'skip' ? 'Skipped by owner' : 'Resolved by owner', ownerResolution: action });
      const m = this.get('out:' + key); if (m) this.put({ ...m, status: action === 'sent' ? 'owner_confirmed_sent' : action === 'retry' ? 'retry_queued' : 'skipped' });
    });
  }
  ack(providerId, ack) {
    const status = Number(ack) >= 3 ? 'read' : Number(ack) === 2 ? 'delivered' : Number(ack) === 1 ? 'sent' : Number(ack) === -1 ? 'failed' : null;
    if (!status || !providerId) return;
    // ACK event may precede sendFile's resolution; the gateway queues it until the send finishes.
    const row = this.db.prepare("SELECT json FROM records WHERE kind='message' AND json_extract(json,'$.providerId')=? LIMIT 1").get(providerId);
    if (!row) return false;
    const m = JSON.parse(row.json), rank = { accepted: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
    if ((rank[status] || 0) >= (rank[m.status] || 0)) this.put({ ...m, status });
    return true;
  }
  changes(limit = 50) { return this.db.prepare('SELECT * FROM changes ORDER BY seq LIMIT ?').all(limit); }
  synced(seq) { this.db.prepare('DELETE FROM changes WHERE seq<=?').run(seq); }
  stats() { return { contacts: this.db.prepare("SELECT count(*) n FROM records WHERE kind='contact'").get().n, queued: this.db.prepare("SELECT count(*) n FROM due_jobs WHERE state='queued'").get().n, uncertain: this.db.prepare("SELECT count(*) n FROM due_jobs WHERE state='unknown'").get().n, backupPending: this.db.prepare('SELECT count(*) n FROM changes').get().n }; }
  prune() {
    const cutoff = this.now() - 90 * 86400000;
    for (const row of this.db.prepare("SELECT json FROM records WHERE kind='contact' AND stamp<? LIMIT 200").all(cutoff)) {
      const contact = JSON.parse(row.json);
      this.put({ ...contact, preview: '[Older message content expired]', unread: 0 });
    }
    // Preserve small once-only contact/receipt records to avoid replay after content expiry.
    for (const row of this.db.prepare("SELECT key,json FROM records WHERE kind IN ('message','job') AND stamp<? LIMIT 200").all(cutoff)) {
      const record = JSON.parse(row.json);
      if (record.kind === 'job' && ['queued', 'sending', 'unknown'].includes(record.state)) continue;
      const tombstone = { key: row.key, kind: 'deleted', peer: record.peer, mediaId: record.media?.id || null, deletedAt: this.now() };
      this.put(tombstone); this.db.prepare('DELETE FROM due_jobs WHERE key=?').run(row.key);
    }
  }
}
