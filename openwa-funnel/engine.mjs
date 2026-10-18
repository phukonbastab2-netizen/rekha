import { DatabaseSync } from 'node:sqlite';
import { firstSequence, mediaSequence, reminder, GAP, REMINDER_DELAY, MEDIA_DELAY } from './funnel.mjs';

export const validPeer = peer => typeof peer === 'string' && /^[0-9]{5,25}@(c\.us|lid|s\.whatsapp\.net)$/.test(peer);
export const isSensitive = text => /\b(?:otp|one.time (?:password|code)|verification code|confirmation code|security code|cvv|password|pin)\b.{0,35}\b\d{3,8}\b|\b\d{3,8}\b.{0,35}\b(?:otp|verification code|confirmation code)\b/i.test(text);
export class Engine {
  constructor(path, now = () => Date.now()) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY,kind TEXT NOT NULL,peer TEXT NOT NULL DEFAULT '',stamp INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_kind_stamp ON records(kind,stamp);
      CREATE INDEX IF NOT EXISTS records_peer_kind_stamp ON records(peer,kind,stamp);
      CREATE INDEX IF NOT EXISTS records_provider ON records(json_extract(json,'$.providerId')) WHERE kind='message';
      CREATE INDEX IF NOT EXISTS records_media ON records(json_extract(json,'$.media.id')) WHERE kind='message';
      CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT NOT NULL,kind TEXT NOT NULL,peer TEXT NOT NULL,stamp INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,peer TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS due_jobs(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT UNIQUE NOT NULL,peer TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_due_state ON due_jobs(state,due_at);
      CREATE INDEX IF NOT EXISTS jobs_peer_state ON due_jobs(peer,state);`);
    // A durable change cursor must advance even when several writes share the
    // same wall clock millisecond, including after a process restart.
    this.lastStamp=Number(this.db.prepare('SELECT max(stamp) AS stamp FROM records').get()?.stamp)||0;
    this.db.exec(`CREATE INDEX IF NOT EXISTS records_page ON records(kind,stamp DESC,key DESC);
      CREATE INDEX IF NOT EXISTS changes_key_seq ON changes(key,seq);
      CREATE INDEX IF NOT EXISTS records_peer_page ON records(peer,kind,stamp DESC,key DESC);
      CREATE INDEX IF NOT EXISTS records_peer_timeline ON records(peer,kind,coalesce(json_extract(json,'$.at'),stamp) DESC,key DESC);
      CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS counters(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_heads(peer TEXT NOT NULL,lane TEXT NOT NULL,key TEXT NOT NULL,due_at INTEGER NOT NULL,PRIMARY KEY(peer,lane));
      CREATE INDEX IF NOT EXISTS dispatch_ready ON dispatch_heads(lane,due_at,peer);`);
    if (!this.db.prepare("SELECT 1 FROM migrations WHERE name='dispatch-v1'").get()) {
      this.transaction(() => {
        this.db.exec(`ALTER TABLE due_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT '';
          ALTER TABLE due_jobs ADD COLUMN step INTEGER NOT NULL DEFAULT 0;
          UPDATE due_jobs SET phase=coalesce((SELECT json_extract(json,'$.phase') FROM records WHERE records.key=due_jobs.key),''),step=coalesce((SELECT json_extract(json,'$.step') FROM records WHERE records.key=due_jobs.key),0);
          INSERT INTO migrations VALUES('dispatch-v1');`);
      });
    }
    if (!this.db.prepare("SELECT 1 FROM migrations WHERE name='counters-v1'").get()) {
      this.transaction(() => {
        this.db.exec(`INSERT OR REPLACE INTO counters SELECT 'record:'||kind,count(*) FROM records GROUP BY kind;
          INSERT OR REPLACE INTO counters SELECT 'job:'||state,count(*) FROM due_jobs GROUP BY state;
          INSERT OR REPLACE INTO counters VALUES('changes',(SELECT count(*) FROM changes));
          INSERT INTO migrations VALUES('counters-v1');`);
      });
    }
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS records_count_insert AFTER INSERT ON records BEGIN INSERT INTO counters VALUES('record:'||new.kind,1) ON CONFLICT(key) DO UPDATE SET value=value+1; END;
      CREATE TRIGGER IF NOT EXISTS records_count_delete AFTER DELETE ON records BEGIN UPDATE counters SET value=value-1 WHERE key='record:'||old.kind; END;
      CREATE TRIGGER IF NOT EXISTS records_count_update AFTER UPDATE OF kind ON records WHEN old.kind<>new.kind BEGIN UPDATE counters SET value=value-1 WHERE key='record:'||old.kind; INSERT INTO counters VALUES('record:'||new.kind,1) ON CONFLICT(key) DO UPDATE SET value=value+1; END;
      CREATE TRIGGER IF NOT EXISTS jobs_count_insert AFTER INSERT ON due_jobs BEGIN INSERT INTO counters VALUES('job:'||new.state,1) ON CONFLICT(key) DO UPDATE SET value=value+1; END;
      CREATE TRIGGER IF NOT EXISTS jobs_count_delete AFTER DELETE ON due_jobs BEGIN UPDATE counters SET value=value-1 WHERE key='job:'||old.state; END;
      CREATE TRIGGER IF NOT EXISTS jobs_count_update AFTER UPDATE OF state ON due_jobs WHEN old.state<>new.state BEGIN UPDATE counters SET value=value-1 WHERE key='job:'||old.state; INSERT INTO counters VALUES('job:'||new.state,1) ON CONFLICT(key) DO UPDATE SET value=value+1; END;
      CREATE TRIGGER IF NOT EXISTS changes_count_insert AFTER INSERT ON changes BEGIN INSERT INTO counters VALUES('changes',1) ON CONFLICT(key) DO UPDATE SET value=value+1; END;
      CREATE TRIGGER IF NOT EXISTS changes_count_delete AFTER DELETE ON changes BEGIN UPDATE counters SET value=value-1 WHERE key='changes'; END;`);
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_peer_ready ON due_jobs(peer,state,due_at,ordinal)');
    if (!this.db.prepare("SELECT 1 FROM migrations WHERE name='heads-v1'").get()) {
      this.transaction(() => {
        for (const {peer} of this.db.prepare("SELECT DISTINCT peer FROM due_jobs WHERE state IN ('queued','sending','unknown')").iterate()) this.refreshHead(peer);
        this.db.exec("INSERT INTO migrations VALUES('heads-v1')");
      });
    }
    // A crash between reservation and ACK has an uncertain send outcome. Never resend it blindly.
    for (const row of this.db.prepare("SELECT key FROM due_jobs WHERE state='sending'").all()) {
      const job = this.get(row.key);
      this.transaction(() => { this.put({ ...job, state: 'unknown', error: 'Restart during send; check WhatsApp before resolving.' }); this.pauseContact(job.peer, true); });
    }
  }
  close() { this.db.close(); }
  transaction(fn) { if(this.inTransaction)return fn();this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } finally{this.inTransaction=false;} }
  get(key) { const row = this.db.prepare('SELECT json FROM records WHERE key=?').get(key); return row ? JSON.parse(row.json) : null; }
  put(value) {
    const stamp = Math.max(this.now(),this.lastStamp+1), json = JSON.stringify(value), peer = value.peer || '';
    this.lastStamp=stamp;
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,peer=excluded.peer,stamp=excluded.stamp,json=excluded.json').run(value.key, value.kind, peer, stamp, json);
    // Backup is a state mirror: keep only the newest pending revision of each key.
    // AUTOINCREMENT still makes acknowledgements safe while a batch is in flight.
    this.db.prepare('DELETE FROM changes WHERE key=?').run(value.key);
    this.db.prepare('INSERT INTO changes(key,kind,peer,stamp,json) VALUES(?,?,?,?,?)').run(value.key, value.kind, peer, stamp, json);
    if (value.kind === 'job') this.db.prepare('INSERT INTO due_jobs(key,peer,due_at,state,phase,step) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET due_at=excluded.due_at,state=excluded.state,phase=excluded.phase,step=excluded.step').run(value.key, peer, value.dueAt, value.state, value.phase, value.step);
    if (value.kind === 'job' || value.kind === 'contact') this.refreshHead(peer);
    return value;
  }
  refreshHead(peer) {
    this.db.prepare('DELETE FROM dispatch_heads WHERE peer=?').run(peer);
    const c = this.contact(peer);
    if (!c || c.isSelf || c.optedOut || c.deleted || this.db.prepare("SELECT 1 FROM due_jobs WHERE peer=? AND state IN ('sending','unknown') LIMIT 1").get(peer)) return;
    for (const lane of ['auto','manual']) {
      if (lane === 'auto' && c.paused) continue;
      const job = this.db.prepare(`SELECT j.key,j.due_at FROM due_jobs j INDEXED BY jobs_peer_ready WHERE j.peer=? AND j.state='queued'
        AND (CASE WHEN j.phase LIKE 'manual-%' THEN 'manual' ELSE 'auto' END)=?
        AND (j.step=0 OR EXISTS(SELECT 1 FROM due_jobs prev WHERE prev.key='job:'||j.peer||':'||j.phase||':'||(j.step-1) AND prev.state='accepted'))
        ORDER BY j.due_at,j.ordinal LIMIT 1`).get(peer,lane);
      if (job) this.db.prepare('INSERT INTO dispatch_heads VALUES(?,?,?,?)').run(peer,lane,job.key,Math.max(job.due_at,(c.lastSentAt || 0)+GAP));
    }
  }
  list(kind, peer = '', before = Number.MAX_SAFE_INTEGER, limit = 50) {
    limit = Math.max(1,Math.min(100,Number.isSafeInteger(limit)?limit:50));
    let stamp = Number.MAX_SAFE_INTEGER, key = '\uffff';
    if (typeof before === 'string' && before.length < 1500) { try { const c = JSON.parse(Buffer.from(before, 'base64url').toString()); if (Number.isSafeInteger(c.stamp) && typeof c.key === 'string') { stamp = c.stamp; key = c.key; } } catch {} }
    const rows = peer ? this.db.prepare('SELECT stamp,key,json FROM records WHERE peer=? AND kind=? AND (stamp,key)<(?,?) ORDER BY stamp DESC,key DESC LIMIT ?').all(peer, kind, stamp, key, limit)
      : this.db.prepare('SELECT stamp,key,json FROM records WHERE kind=? AND (stamp,key)<(?,?) ORDER BY stamp DESC,key DESC LIMIT ?').all(kind, stamp, key, limit);
    return rows.map(r => ({ ...JSON.parse(r.json), _cursor: Buffer.from(JSON.stringify({ stamp: r.stamp, key: r.key })).toString('base64url') }));
  }
  listMessagesTimeline(peer,before='',limit=50){
    if(!validPeer(peer))throw Error('Invalid chat');
    limit=Math.max(1,Math.min(100,Number.isSafeInteger(limit)?limit:50));
    let at=Number.MAX_SAFE_INTEGER,key='\uffff';
    if(typeof before==='string'&&before&&before.length<1500)try{const cursor=JSON.parse(Buffer.from(before,'base64url').toString());if(Number.isSafeInteger(cursor.at)&&typeof cursor.key==='string'&&cursor.key.length<=600){at=cursor.at;key=cursor.key;}}catch{}
    const rows=this.db.prepare("SELECT stamp,key,json,coalesce(json_extract(json,'$.at'),stamp) AS at FROM records WHERE peer=? AND kind='message' AND (coalesce(json_extract(json,'$.at'),stamp),key)<(?,?) ORDER BY coalesce(json_extract(json,'$.at'),stamp) DESC,key DESC LIMIT ?").all(peer,at,key,limit);
    const latest=this.db.prepare("SELECT stamp,key FROM records WHERE peer=? AND kind='message' ORDER BY stamp DESC,key DESC LIMIT 1").get(peer);
    const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    return{messages:rows.map(row=>({...JSON.parse(row.json),_cursor:encode({stamp:row.stamp,key:row.key}),_historyCursor:encode({at:row.at,key:row.key})})),revisionCursor:latest?encode({stamp:latest.stamp,key:latest.key}):''};
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
    if(input.isSelf||this.contact(input.peer)?.isSelf)return{ignored:true};
    if(input.mutation)return this.captureMutation({...input,direction:'in'});
    const body = String(input.body || '').slice(0, 8000), sensitive = isSensitive(body);
    const scheduleAt=input.recovered&&Number.isFinite(input.at)&&input.at>0?Math.min(input.at,this.now()):this.now();
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM receipts WHERE id=?').get(input.id)) {
        if(input.editedAt)return this.captureMutation({...input,mutation:'edit',direction:'in'});
        const previous=this.get('in:'+input.id);
        if(previous?.kind==='message'&&!previous.revoked&&!previous.body&&body&&previous.type===input.type)return this.captureMutation({...input,mutation:'hydrate',direction:'in'});
        return { duplicate: true };
      }
      const existing=this.contact(input.peer);
      if(input.recovered&&existing?.contentDeletedAt&&input.at<=existing.contentDeletedAt)return{ignored:true};
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(input.id, input.peer, this.now());
      let c = this.contact(input.peer);
      const isNew = !c;
      if (!c) c = { key: 'contact:' + input.peer, kind: 'contact', peer: input.peer, name: String(input.name || '').slice(0, 100), firstAt: this.now(), stage: input.passive?'history_only':'new', optedOut: false, paused: false, payment: 'not_received', unread: 0, firstStarted: false, reminderScheduled: false, mediaScheduled: false, lastSentAt: 0 };
      c = { ...c, lastAt: this.now(), lastInboundAt: this.now(), unread: c.unread + 1, lastMessageKey:'in:'+input.id, preview: sensitive ? '[Sensitive message omitted]' : (body || '[' + input.type + ']').slice(0, 150) };
      this.put({ key: 'in:' + input.id, kind: 'message', peer: input.peer, id: input.id, direction: 'in', type: input.type || 'text', body: sensitive ? '[Sensitive message omitted]' : body, at: input.at || this.now(), receivedAt: this.now(), sensitive, status: 'received', media: sensitive ? null : input.media || null, ...this.mirrorMetadata(input,sensitive) });
      const command = body.trim().toLowerCase();
      if (['stop', 'unsubscribe', 'बंद', 'बंद करें'].includes(command)) {
        c.optedOut = true;
        for (const row of this.db.prepare("SELECT key FROM due_jobs WHERE peer=? AND state='queued'").all(c.peer)) this.put({ ...this.get(row.key), state: 'cancelled', error: 'Customer opted out' });
      } else if (command === 'start') c.optedOut = false;
      if (!input.passive && !sensitive && !c.optedOut && !c.firstStarted) {
        c.firstStarted = true; c.stage = 'first_sequence';
        firstSequence.forEach((p, i) => this.job(c.peer, 'first', i, scheduleAt + i * GAP, p));
      } else if (!input.passive && !sensitive && !c.optedOut && !isNew && c.stage === 'waiting_for_details' && !c.reminderScheduled) {
        c.reminderScheduled = true; this.job(c.peer, 'reminder', 0, scheduleAt + REMINDER_DELAY, reminder);
      }
      if (!input.passive && !sensitive && !c.optedOut && ['image', 'video', 'audio', 'ptt', 'document', 'sticker','payment'].includes(input.type) && !c.mediaScheduled) {
        c.mediaScheduled = true; if(c.payment!=='verified_by_owner')c.payment = 'pending';
        mediaSequence.forEach((p, i) => this.job(c.peer, 'media', i, scheduleAt + MEDIA_DELAY + i * GAP, p));
      }
      this.put(c);
      return { accepted: true };
    });
  }
  importHistory(input) {
    if(!validPeer(input.peer)||!input.id||input.id.length>300)return false;
    if(input.isSelf||this.contact(input.peer)?.isSelf)return false;
    if(input.mutation)return false;
    return this.transaction(()=>{
      const current=this.contact(input.peer);
      if(current?.contentDeletedAt&&input.at<=current.contentDeletedAt)return false;
      if(this.db.prepare('SELECT 1 FROM receipts WHERE id=?').get(input.id))return false;
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(input.id,input.peer,this.now());
      const body=String(input.body||'').slice(0,8000),sensitive=isSensitive(body),at=input.at||this.now();
      this.put({key:'in:'+input.id,kind:'message',peer:input.peer,id:input.id,direction:'in',type:input.type||'text',body:sensitive?'[Sensitive message omitted]':body,at,receivedAt:this.now(),sensitive,status:'received',historical:true,...this.mirrorMetadata(input,sensitive)});
      const c=current||{key:'contact:'+input.peer,kind:'contact',peer:input.peer,name:String(input.name||'').slice(0,100),firstAt:at,stage:'history_only',optedOut:false,paused:false,payment:'not_received',unread:0,firstStarted:false,reminderScheduled:false,mediaScheduled:false,lastSentAt:0};
      const command=body.trim().toLowerCase();
      if(!current||at>(c.lastInboundAt||0)){
        if(['stop','unsubscribe','बंद','बंद करें'].includes(command))c.optedOut=true;
        else if(command==='start')c.optedOut=false;
      }
      if(!current||at>(c.lastAt||0)){c.lastAt=at;c.lastInboundAt=at;c.lastMessageKey='in:'+input.id;c.preview=sensitive?'[Sensitive message omitted]':(body||'['+input.type+']').slice(0,150);}
      this.put(c);return true;
    });
  }
  captureOutgoing(input) {
    const at=Number(input?.at),since=Number(input?.since),type=input?.type==='chat'?'text':input?.type;
    const name=String(input?.name||'').slice(0,100);
    const isSelf=!!input?.isSelf||input?.self===true||input?.peer===input?.selfPeer||input?.peer===input?.ownerPeer;
    const selfName=value=>!String(value||'').trim()||/^\+?[\d\s()-]+$/.test(value)?'You':value;
    if(input?.mutation)return this.captureMutation({...input,direction:'out'});
    if(!validPeer(input?.peer)||typeof input?.id!=='string'||!input.id||input.id.length>300||!Number.isFinite(at)||at<=0||!Number.isFinite(since)||since<0||at<since||at>this.now()+300000||!['text','image','video','audio','ptt','document','sticker','payment','vcard','multi_vcard','location','live_location','unsupported'].includes(type)||input.fromMe===false||input.isGroupMsg||input.isGroup||input.isPSA||input.isNotification&&type!=='payment'||/^(?:Facebook Business|Meta Business|WhatsApp)$/i.test(name.trim()))return{ignored:true};
    return this.transaction(()=>{
      let c=this.contact(input.peer);
      if(c?.deleted||c?.contentDeletedAt&&at<=c.contentDeletedAt)return{ignored:true};
      const key='out:provider:'+input.id;
      // A deleted mirror is a permanent tombstone, including after restarts.
      if(this.get(key)?.kind==='deleted')return{ignored:true};
      const row=this.db.prepare("SELECT json FROM records WHERE kind='message' AND json_extract(json,'$.providerId')=? LIMIT 1").get(input.id);
      if(row){
        const existing=JSON.parse(row.json);
        if(existing.peer!==input.peer||existing.direction!=='out')return{ignored:true};
        if(isSelf&&c&&!c.isSelf){c={...c,isSelf:true,name:selfName(c.name||name)};this.put(c);}
        if(input.editedAt){const mutation=this.captureMutation({...input,mutation:'edit',direction:'out'});if(mutation.mutated)return mutation;}
        else if(!existing.revoked&&!existing.body&&input.body&&existing.type===type){const mutation=this.captureMutation({...input,mutation:'hydrate',direction:'out'});if(mutation.mutated)return mutation;}
        // Older gateway versions saved the outgoing row without advancing its
        // chat preview. Repair only from that saved row, never snapshot text.
        const existingAt=Number(existing.at),preview=existing.revoked?'[Message deleted on WhatsApp]':existing.sensitive||isSensitive(String(existing.body||''))?'[Sensitive message omitted]':String(existing.body||'['+existing.type+']').slice(0,150);
        if(c&&Number.isFinite(existingAt)&&(existingAt>(c.lastAt||0)||existingAt===c.lastAt&&c.lastMessageKey===existing.key&&c.preview!==preview)){
          c={...c,lastAt:existingAt,lastMessageKey:existing.key,preview};this.put(c);
        }
        const ack=Number(input.ack),status=ack>=3?'read':ack===2?'delivered':ack===1?'sent':ack===-1?'failed':null;
        const rank={queued:0,accepted:0,sent:1,delivered:2,read:3,failed:4};
        // Repeated snapshots must not rewrite unchanged ACKs into cloud backup.
        if(status&&Number.isFinite(ack)&&status!==existing.status&&rank[status]>(rank[existing.status]??0))this.ack(input.id,ack);
        return{duplicate:true};
      }
      // A gateway echo can arrive before finish() returns its provider ID.
      // Defer it until the next provider scan instead of creating a second row.
      if(this.db.prepare("SELECT 1 FROM due_jobs WHERE peer=? AND state='sending' LIMIT 1").get(input.peer))return{deferred:true};
      const body=String(input.body||'').slice(0,8000),sensitive=isSensitive(body);
      this.put({key,kind:'message',peer:input.peer,id:input.id,providerId:input.id,direction:'out',type,body:sensitive?'[Sensitive message omitted]':body,at,receivedAt:this.now(),source:'owner_whatsapp',sensitive,media:sensitive?null:input.media||null,status:'queued',...this.mirrorMetadata(input,sensitive)});
      // ACK 0 is only queued on the sending device; it is not delivery evidence.
      const ack=Number(input.ack);if(Number.isFinite(ack)&&ack!==0)this.ack(input.id,ack);
      if(!c)c={key:'contact:'+input.peer,kind:'contact',peer:input.peer,name:isSelf?selfName(name):name,firstAt:at,stage:'history_only',optedOut:false,paused:false,payment:'not_received',unread:0,firstStarted:false,reminderScheduled:false,mediaScheduled:false,lastSentAt:0};
      if(isSelf)c={...c,isSelf:true,name:selfName(c.name||name)};
      if(at>=(c.lastAt||0))c={...c,lastAt:at,lastMessageKey:key,preview:sensitive?'[Sensitive message omitted]':(body||'['+type+']').slice(0,150)};
      this.put({...c,lastOutboundAt:Math.max(at,c.lastOutboundAt||0)});
      return{accepted:true,key};
    });
  }
  mirrorMetadata(input,sensitive=false){
    const value={};
    if(input.providerType)value.providerType=String(input.providerType).slice(0,80);
    if(!sensitive&&typeof input.filename==='string')value.filename=input.filename.slice(0,500);
    const editedAt=Number(input.editedAt);
    if(Number.isFinite(editedAt)&&editedAt>=Number(input.at)&&editedAt<=this.now()+300000){value.editedAt=editedAt;if(typeof input.editKey==='string'&&input.editKey.length<=300)value.editKey=input.editKey;}
    if(!sensitive&&input.sharedLocation){const {latitude,longitude}=input.sharedLocation;if(Number.isFinite(latitude)&&latitude>=-90&&latitude<=90&&Number.isFinite(longitude)&&longitude>=-180&&longitude<=180)value.sharedLocation={latitude,longitude,label:String(input.sharedLocation.label||'').slice(0,1000),live:!!input.sharedLocation.live};}
    return value;
  }
  captureMutation(input){
    const at=Number(input?.at),direction=input?.direction;
    if(!validPeer(input?.peer)||typeof input?.id!=='string'||!input.id||input.id.length>300||!['in','out'].includes(direction)||!['edit','revoke','hydrate'].includes(input?.mutation)||!Number.isFinite(at)||at<=0||at>this.now()+300000||typeof input.fromMe==='boolean'&&input.fromMe!==(direction==='out')||input.isGroupMsg||input.isGroup||input.isPSA||direction==='in'&&(input.isSelf||input.peer===input.selfPeer||input.peer===input.ownerPeer))return{ignored:true};
    return this.transaction(()=>{
      const c=this.contact(input.peer);
      if(!c||c.deleted||c.contentDeletedAt&&at<=c.contentDeletedAt)return{ignored:true};
      let m;
      if(direction==='in')m=this.get('in:'+input.id);
      else {const row=this.db.prepare("SELECT json FROM records WHERE kind='message' AND json_extract(json,'$.providerId')=? LIMIT 1").get(input.id);m=row?JSON.parse(row.json):null;}
      // Mutations never invent the original message, revive owner tombstones,
      // or cross a customer/direction boundary on the strength of an ID alone.
      const targetedRevoke=input.mutation==='revoke'&&input.targetKey===input.id;
      if(m?.kind!=='message'||m.peer!==input.peer||m.direction!==direction||m.revoked||Math.abs(at-m.at)>300000&&!targetedRevoke)return{ignored:true};
      const editedAt=Number(input.editedAt),observedAt=Number(input.observedAt??this.now()),body=String(input.body||'').slice(0,8000);
      if(input.mutation==='edit'&&(!Number.isFinite(editedAt)||editedAt<at||editedAt>this.now()+300000||editedAt<=(m.editedAt||0)))return{duplicate:true};
      if(input.mutation==='revoke'&&(!Number.isFinite(observedAt)||observedAt<at||observedAt>this.now()+300000))return{ignored:true};
      if(input.mutation==='hydrate'&&(m.body||!body||m.type!==input.type||m.editedAt))return{duplicate:true};
      const revoked=input.mutation==='revoke',sensitive=!revoked&&isSensitive(body),removedMedia=[];
      if((revoked||sensitive)&&/^[a-f0-9]{64}$/.test(m.media?.id||'')){
        removedMedia.push(m.media.id);
        this.put({key:'media-deleted:'+m.media.id,kind:'deleted',peer:m.peer,mediaId:m.media.id,deletedAt:this.now()});
      }
      const update=revoked?{...m,type:'revoked',body:'',url:null,media:null,filename:null,sharedLocation:null,attachmentError:null,sensitive:false,revoked:true,revokedAt:observedAt,revokedAtSource:'observed'}:{...m,body:sensitive?'[Sensitive message omitted]':body,sensitive,...this.mirrorMetadata(input,sensitive),...(sensitive?{url:null,media:null,filename:null,sharedLocation:null,attachmentError:null}:{})};
      if(input.mutation==='hydrate')update.hydratedAt=this.now();
      this.put(update);
      const latest=c.lastMessageKey?null:this.db.prepare("SELECT key FROM records WHERE peer=? AND kind='message' ORDER BY json_extract(json,'$.at') DESC,key DESC LIMIT 1").get(input.peer);
      if(c.lastMessageKey===m.key||!c.lastMessageKey&&latest?.key===m.key)this.put({...c,preview:revoked?'[Message deleted on WhatsApp]':sensitive?'[Sensitive message omitted]':(body||'['+m.type+']').slice(0,150)});
      return{mutated:true,key:m.key,removedMedia};
    });
  }
  markSeen(peer) { const c = this.contact(peer); if (c?.unread) this.put({ ...c, unread: 0 }); }
  restoreQueuedCopy() {
    let changed=0;
    this.transaction(()=>{ for(const row of this.db.prepare("SELECT key FROM due_jobs WHERE state='queued' AND phase IN ('first','reminder','media')").iterate()) {
      const j=this.get(row.key), payload=j.phase==='first'?firstSequence[j.step]:j.phase==='media'?mediaSequence[j.step]:reminder;
      if(payload && JSON.stringify(payload)!==JSON.stringify(j.payload)){this.put({...j,payload});changed++;}
    }});
    return changed;
  }
  deleteContent(peer, limit=200) {
    if(!validPeer(peer)||!this.contact(peer))throw Error('Unknown customer');
    if(this.db.prepare("SELECT 1 FROM due_jobs WHERE peer=? AND state IN ('sending','unknown') LIMIT 1").get(peer))throw Error('Resolve active or uncertain sends first');
    return this.transaction(()=>{
      const c=this.contact(peer);this.put({...c,paused:true,preview:'[Chat content deleted]',unread:0,contentDeletedAt:this.now()});
      const rows=this.db.prepare("SELECT key,json FROM records WHERE peer=? AND kind IN ('message','job') ORDER BY kind,stamp,key LIMIT ?").all(peer,Math.min(200,Math.max(1,limit)));
      const media=[];
      for(const row of rows){ const record=JSON.parse(row.json);if(record.media?.id)media.push(record.media.id);this.put({key:row.key,kind:'deleted',peer,mediaId:record.media?.id||null,deletedAt:this.now()});this.db.prepare('DELETE FROM due_jobs WHERE key=?').run(row.key); }
      this.refreshHead(peer);
      return {deleted:rows.length,media,more:!!this.db.prepare("SELECT 1 FROM records WHERE peer=? AND kind IN ('message','job') LIMIT 1").get(peer)};
    });
  }
  manual(peer, body, requestId) {
    if (!this.contact(peer) || !validPeer(peer)) throw Error('Unknown customer');
    if(this.contact(peer).isSelf)throw Error('This is your own WhatsApp chat. Send notes from WhatsApp.');
    if (this.contact(peer).optedOut) throw Error('Customer has opted out');
    body = String(body || '').trim();
    if (!body || body.length > 8000 || !/^[a-zA-Z0-9-]{10,80}$/.test(requestId)) throw Error('Invalid message');
    return this.transaction(() => { this.job(peer, 'manual-' + requestId, 0, this.now(), { type: 'text', body }); return { queued: true }; });
  }
  reserve() {
    return this.transaction(() => {
      // At most two indexed head lookups, regardless of stored history or paused queues.
      const heads = ['manual',...(this.settings().enabled?['auto']:[])].map(lane=>this.db.prepare('SELECT key,due_at FROM dispatch_heads WHERE lane=? AND due_at<=? ORDER BY due_at,peer LIMIT 1').get(lane,this.now())).filter(Boolean).sort((a,b)=>a.due_at-b.due_at);
      if (!heads.length) return null;
      return this.put({ ...this.get(heads[0].key), state: 'sending', startedAt: this.now() });
    });
  }
  finish(key, providerId, error = '') {
    this.transaction(() => {
      const j = this.get(key);
      if (!j || !['sending', 'unknown'].includes(j.state)) return;
      const accepted = typeof providerId === 'string' && providerId.length > 0, at=this.now(), messageKey='out:'+key;
      this.put({ ...j, state: accepted ? 'accepted' : 'unknown', providerId: providerId || null, error: accepted ? '' : error || 'Outcome unknown. Check WhatsApp before resolving.', completedAt: at });
      const c = this.contact(j.peer);
      const latest=at>=(c.lastAt||0)?{lastAt:at,lastMessageKey:messageKey,preview:(isSensitive(String(j.payload.body||''))?'[Sensitive message omitted]':String(j.payload.body||'['+j.payload.type+']')).slice(0,150)}:{};
      this.put({ ...c, ...latest, lastSentAt: at, paused: accepted ? c.paused : true, stage: accepted && j.phase === 'first' && j.step === firstSequence.length - 1 ? 'waiting_for_details' : c.stage });
      this.put({ key: messageKey, kind: 'message', peer: j.peer, direction: 'out', id: key, type: j.payload.type, body: j.payload.body, url: j.payload.url, at, source: j.phase.startsWith('manual-') ? 'owner' : 'funnel', status: accepted ? 'accepted' : 'unknown', providerId: providerId || null });
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
  changes(limit = 50) { let bytes=500;const batch=[];for(const row of this.db.prepare('SELECT * FROM changes ORDER BY seq LIMIT ?').all(Math.min(50,limit))){const size=Buffer.byteLength(JSON.stringify(row));if(batch.length&&bytes+size>850000)break;bytes+=size;batch.push(row);}return batch; }
  synced(seq) { this.db.prepare('DELETE FROM changes WHERE seq<=?').run(seq); }
  stats() { const n=Object.fromEntries(this.db.prepare('SELECT key,value FROM counters').all().map(r=>[r.key,r.value])); return { contacts:n['record:contact']||0,messages:n['record:message']||0,queued:n['job:queued']||0,sending:n['job:sending']||0,uncertain:n['job:unknown']||0,backupPending:n.changes||0 }; }
  prune() {
    const cutoff = this.now() - 90 * 86400000;
    for (const row of this.db.prepare("SELECT json FROM records WHERE kind='contact' AND stamp<? LIMIT 200").all(cutoff)) {
      const contact = JSON.parse(row.json);
      this.put({ ...contact, preview: '[Older message content expired]', unread: 0 });
    }
    // Preserve small once-only contact/receipt records to avoid replay after content expiry.
    for (const row of this.db.prepare("SELECT key,json FROM records WHERE kind IN ('message','job') AND stamp<? AND NOT EXISTS(SELECT 1 FROM due_jobs WHERE due_jobs.key=records.key AND state IN ('queued','sending','unknown')) ORDER BY stamp LIMIT 200").all(cutoff)) {
      const record = JSON.parse(row.json);
      if (record.kind === 'job' && ['queued', 'sending', 'unknown'].includes(record.state)) continue;
      const tombstone = { key: row.key, kind: 'deleted', peer: record.peer, mediaId: record.media?.id || null, deletedAt: this.now() };
      this.put(tombstone); this.db.prepare('DELETE FROM due_jobs WHERE key=?').run(row.key);
    }
  }
}
