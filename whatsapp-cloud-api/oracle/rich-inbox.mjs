import {Inbox} from './inbox.mjs';
import {sendOwnerMessage} from '../transport.mjs';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {OwnerMedia} from './media.mjs';
const fail=(text,status=400)=>Object.assign(Error(text),{status});
const cursor=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function uncursor(value){try{if(!value||value.length>1000)return null;const c=JSON.parse(Buffer.from(value,'base64url'));if(!Number.isFinite(c.at)||typeof c.id!=='string'||c.id.length>600)throw Error();return c;}catch{throw fail('Invalid page.');}}
const validId=id=>/^[a-f0-9]{64}$/i.test(id||'');
const hash=value=>createHash('sha256').update(value).digest('hex');

export class RichInbox extends Inbox {
 constructor(filename,env,options={}){
  super(filename,env,{...options,send:options.send||sendOwnerMessage});
  this.media=options.media||new OwnerMedia(env,options.fetchImpl);this.version=Date.now();this.templateCache=new Map();
  try{this.capacityReport=JSON.parse(fs.readFileSync(new URL('./capacity-results.json',import.meta.url),'utf8'));}catch{this.capacityReport=null;}
  const columns=new Set(this.db.prepare('PRAGMA table_info(contacts)').all().map(c=>c.name));
  for(const [name,type]of Object.entries({pinned:'INTEGER NOT NULL DEFAULT 0',archived:'INTEGER NOT NULL DEFAULT 0',unread:'INTEGER NOT NULL DEFAULT 0',payment_state:"TEXT NOT NULL DEFAULT 'none'",payment_note:"TEXT NOT NULL DEFAULT ''",source_revision:'INTEGER NOT NULL DEFAULT 0'}))if(!columns.has(name))this.db.exec('ALTER TABLE contacts ADD COLUMN '+name+' '+type);
  const mcols=new Set(this.db.prepare('PRAGMA table_info(messages)').all().map(c=>c.name));
  if(!mcols.has('starred'))this.db.exec('ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0');
  if(!mcols.has('provider_id'))this.db.exec('ALTER TABLE messages ADD COLUMN provider_id TEXT');
  this.db.exec(`CREATE INDEX IF NOT EXISTS contacts_recent ON contacts(archived,pinned DESC,last_at DESC,id DESC);
   CREATE INDEX IF NOT EXISTS contacts_number ON contacts(wa_id);
   CREATE INDEX IF NOT EXISTS contacts_last_four ON contacts(substr(wa_id,-4));
   CREATE INDEX IF NOT EXISTS contacts_unread ON contacts(pinned DESC,last_at DESC,id DESC) WHERE archived=0 AND unread>0;
   CREATE INDEX IF NOT EXISTS contacts_payment ON contacts(pinned DESC,last_at DESC,id DESC) WHERE payment_state='pending';
   CREATE INDEX IF NOT EXISTS messages_provider ON messages(provider_id);
   CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS owner_receipts(provider_id TEXT PRIMARY KEY,contact TEXT NOT NULL,status TEXT NOT NULL,at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,contact TEXT NOT NULL,media_id TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS payment_audit(id TEXT PRIMARY KEY,contact TEXT NOT NULL,at INTEGER NOT NULL,state TEXT NOT NULL,note TEXT NOT NULL,proof TEXT);`);
  if(!this.meta('counters'))this.putMeta('counters',{contacts:this.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,messages:this.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,manualAccepted:this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='accepted'").get().n,uncertain:this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='uncertain'").get().n});
  if(!this.meta('richSchema')){this.putMeta('lastImportedWebhookAt',null);this.putMeta('richSchema',1);}
  if(!this.meta('activityMigration')){this.db.exec('UPDATE contacts SET last_at=MAX(last_at,COALESCE((SELECT MAX(at) FROM messages WHERE contact=contacts.id),0))');this.putMeta('activityMigration',1);}
 }
 bump(){this.version++;}
 addCounts(delta){const c=this.meta('counters');for(const [key,n]of Object.entries(delta))c[key]=(c[key]||0)+n;this.putMeta('counters',c);}
 payload(raw){const p=typeof raw==='string'?JSON.parse(raw):raw;if(!p.template)return p;let base=this.templateCache.get(p.template);if(!base){base=JSON.parse(this.db.prepare('SELECT payload FROM templates WHERE id=?').get(p.template)?.payload||'{}');if(this.templateCache.size>=128)this.templateCache.delete(this.templateCache.keys().next().value);this.templateCache.set(p.template,base);}return {...base,...p};}
 saveMessage(id,contact,at,direction,payload,providerId){
  const before=this.db.prepare('SELECT id FROM messages WHERE id=?').get(id);
  const result=this.db.prepare('INSERT INTO messages(id,contact,at,direction,payload,provider_id) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,provider_id=excluded.provider_id WHERE messages.payload<>excluded.payload OR messages.provider_id IS NOT excluded.provider_id').run(id,contact,at,direction,JSON.stringify(payload),providerId||null);
  return {added:!before,changed:result.changes>0};
 }
 importContact(id,value){
  if(!value.found)return;
  if(value.phoneNumberId!==this.env.WA_PHONE_NUMBER_ID||!/^\d{6,20}$/.test(value.waId))throw Error('source_sender_mismatch');
  const prior=this.db.prepare('SELECT id,last_at FROM contacts WHERE id=?').get(id);
  const compact={lastInboundAt:value.lastInboundAt,optedOut:value.optedOut,restricted:value.restricted,nameApprovalRequired:value.nameApprovalRequired,
   firstReplies:value.jobs.filter(j=>j.stage==='first'&&j.state==='accepted').length,pending:value.jobs.filter(j=>['pending','held','retry'].includes(j.state)).length};
  let added=0,unread=0,changed=false,image=false;
  this.db.exec('BEGIN IMMEDIATE');try{
   const activity=Math.max(value.lastInboundAt,...value.jobs.map(j=>j.acceptedAt||0));
   this.db.prepare('INSERT INTO contacts(id,wa_id,last_at,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET wa_id=excluded.wa_id,last_at=MAX(contacts.last_at,excluded.last_at),data=excluded.data WHERE contacts.data<>excluded.data OR contacts.last_at<excluded.last_at').run(id,value.waId,activity,JSON.stringify(compact));
   for(const [key,inbound]of value.records||[]){
    if(inbound.type==='image')image=true;
    const providerId=key.slice('inbound:'.length),p={type:inbound.type,text:inbound.text||inbound.media?.caption||'',source:'customer',providerId,...(inbound.media?{media:inbound.media}:{}),...(inbound.replyTo?{replyTo:inbound.replyTo}:{})};
    const result=this.saveMessage('in:'+id+':'+key,id,inbound.eventAt||inbound.receivedAt,'in',p,providerId);if(result.added){added++;unread++;if(inbound.type==='image')image=true;}changed||=result.changed;
   }
   for(const job of value.jobs||[])if(job.acceptedAt&&job.messageId){
    const base={type:job.step.type,text:job.step.body||'',url:job.step.url||null};const text=JSON.stringify(base),template=hash(text);
    this.db.prepare('INSERT OR IGNORE INTO templates VALUES(?,?)').run(template,text);
    const result=this.saveMessage('auto:'+id+':'+job.id,id,job.acceptedAt,'out',{template,source:'funnel',delivery:job.delivery||'accepted',providerId:job.messageId},job.messageId);if(result.added)added++;changed||=result.changed;
   }
   if(unread)this.db.prepare('UPDATE contacts SET unread=unread+? WHERE id=?').run(unread,id);
   if(image)this.db.prepare("UPDATE contacts SET payment_state='pending' WHERE id=? AND payment_state='none'").run(id);
   for(const [providerId,receipt]of Object.entries(value.ownerReceipts||{})){
    const saved=this.db.prepare('SELECT status FROM owner_receipts WHERE provider_id=?').get(providerId),ranks={accepted:0,sent:1,delivered:2,read:3};
    if(!saved||(ranks[receipt.status]||0)>(ranks[saved.status]||0)||(receipt.status==='failed'&&!['delivered','read'].includes(saved.status)))this.db.prepare('INSERT INTO owner_receipts VALUES(?,?,?,?) ON CONFLICT(provider_id) DO UPDATE SET status=excluded.status,at=excluded.at').run(providerId,id,receipt.status,receipt.at||Date.now());
    const row=this.db.prepare('SELECT id,payload FROM messages WHERE contact=? AND provider_id=?').get(id,providerId);if(!row)continue;const p=JSON.parse(row.payload);
    if((ranks[receipt.status]||0)>(ranks[p.delivery]||0)||(receipt.status==='failed'&&!['delivered','read'].includes(p.delivery))){p.delivery=receipt.status;this.db.prepare('UPDATE messages SET payload=? WHERE id=?').run(JSON.stringify(p),row.id);changed=true;}
   }
   if(!prior||added)this.addCounts({contacts:prior?0:1,messages:added});
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  if(changed||!prior)this.bump();
 }
 async syncContact(id){let after='',last;for(let page=0;page<50;page++){last=await this.source('/admin/inbox-sync?'+new URLSearchParams({id,...(after?{after}:{})}));this.importContact(id,last);if(!last.next)return last;after=last.next;}throw Error('history_page_limit');}
 async sync({force=false}={}){
  if(this.syncing)return this.syncing;
  this.syncing=(async()=>{try{
   const index=await this.source('/admin/inbox-index');if(index.phoneNumberId!==this.env.WA_PHONE_NUMBER_ID)throw Error('source_sender_mismatch');if(JSON.stringify(index)!==JSON.stringify(this.meta('index')))this.putMeta('index',index);
   const ingestion=index.account?.ingestion||{},ids=ingestion.recentConversationIds||[],updates=ingestion.recentConversationUpdates||{};
   const changed=force||ingestion.lastWebhookAt!==this.meta('lastImportedWebhookAt');
   if(changed){const todo=ids.filter(id=>{const row=this.db.prepare('SELECT source_revision FROM contacts WHERE id=?').get(id);return force||!row||!updates[id]||row.source_revision<updates[id];});
    for(let at=0;at<todo.length;at+=4)await Promise.all(todo.slice(at,at+4).map(async id=>{await this.syncContact(id);this.db.prepare('UPDATE contacts SET source_revision=? WHERE id=?').run(updates[id]||ingestion.lastWebhookAt||0,id);}));
   }
   if(changed)this.putMeta('lastImportedWebhookAt',ingestion.lastWebhookAt||0);this.lastSyncTime=Date.now();if(!this.meta('lastSyncAt')||Date.now()-this.meta('lastSyncAt')>60000)this.putMeta('lastSyncAt',Date.now());this.lastError=null;
  }catch{this.lastError='Conversation sync is temporarily unavailable';throw Error('sync_unavailable');}})();try{return await this.syncing;}finally{this.syncing=null;}
 }
 chatPage({search='',filter='all',after}={}){
  const c=uncursor(after),where=[],args=[];const digits=search.replace(/\D/g,'').slice(0,20);
  if(digits&&digits.length<4)return {chats:[],next:null};
  if(digits.length===4){where.push('substr(c.wa_id,-4)=?');args.push(digits);}
  else if(digits){where.push('c.wa_id>=? AND c.wa_id<?');args.push(digits,digits+'\uffff');}
  if(filter==='archived')where.push('c.archived=1');else where.push('c.archived=0');
  if(filter==='unread')where.push('c.unread>0');if(filter==='payments')where.push("c.payment_state='pending'");
  if(c){where.push('(c.pinned<? OR (c.pinned=? AND (c.last_at<? OR (c.last_at=? AND c.id<?))))');args.push(c.pin||0,c.pin||0,c.at,c.at,c.id);}
  const rows=this.db.prepare('SELECT c.*,(SELECT payload FROM messages m WHERE m.contact=c.id ORDER BY at DESC,id DESC LIMIT 1) AS last_payload FROM contacts c WHERE '+where.join(' AND ')+' ORDER BY c.pinned DESC,c.last_at DESC,c.id DESC LIMIT 51').all(...args);
  const page=rows.slice(0,50);return {chats:page.map(r=>{const state=JSON.parse(r.data),last=r.last_payload?this.payload(r.last_payload):{};return {id:r.id,number:'+'+r.wa_id,lastAt:r.last_at,preview:last.text||'['+(last.type||'chat')+']',...state,pinned:!!r.pinned,archived:!!r.archived,unread:r.unread,paymentState:r.payment_state,paymentNote:r.payment_note};}),next:rows.length>50?cursor({pin:page.at(-1).pinned,at:page.at(-1).last_at,id:page.at(-1).id}):null};
 }
 messagePage(id,{after,search='',starred=false}={}){
  if(!validId(id))throw fail('Choose a customer.');const c=uncursor(after);const args=[id];let where='contact=?';
  if(c){where+=' AND (at<? OR (at=? AND id<?))';args.push(c.at,c.at,c.id);}if(starred)where+=' AND starred=1';
  const rows=this.db.prepare('SELECT id,at,direction,payload,starred FROM messages WHERE '+where+' ORDER BY at DESC,id DESC LIMIT ?').all(...args,search?1000:81);
  const mapped=rows.map(r=>({...r,payload:this.payload(r.payload)}));const filtered=search?mapped.filter(m=>String(m.payload.text||'').toLowerCase().includes(search.toLowerCase())).slice(0,80):mapped.slice(0,80);
  return {messages:filtered.reverse(),next:rows.length>(search?999:80)?cursor({at:rows[(search?1000:80)-1].at,id:rows[(search?1000:80)-1].id}):null};
 }
 async preflight(id){
  if(!validId(id))throw fail('Choose a customer.');const index=await this.source('/admin/inbox-index');this.putMeta('index',index);const source=await this.syncContact(id);
  const row=this.db.prepare('SELECT * FROM contacts WHERE id=?').get(id);if(!row||!source?.found)throw fail('Choose a synced customer.',404);const state=JSON.parse(row.data);
  if(index.account?.paused||state.restricted||state.optedOut||state.nameApprovalRequired)throw fail('Sending is paused for this conversation.',409);
  if(index.ownerTestOnly&&index.testConversationId!==id)throw fail('This number is still limited to its owner test contact.',409);
  if(state.firstReplies!==5)throw fail('Wait for the first five funnel replies.',409);
  if(Date.now()-state.lastInboundAt>=86400000)throw fail('Ask the customer to message again to reopen the 24-hour reply window.',409);
  if(this.db.prepare("SELECT id FROM outbox WHERE contact=? AND state IN ('sending','uncertain') LIMIT 1").get(id))throw fail('An earlier reply needs checking before another send.',409);
  this.checkDisk();return row;
 }
 checkDisk(){if(!this.disk||this.disk.at<Date.now()-30000){const s=fs.statfsSync(path.dirname(this.env.SQLITE_PATH||'.'));this.disk={at:Date.now(),free:Number(s.bavail)*Number(s.bsize),total:Number(s.blocks)*Number(s.bsize)};}if(this.disk.free<1024**3)throw fail('Server storage is nearly full. Sending is paused to protect saved messages.',507);return this.disk;}
 async upload(id,file,{voice=false}={}){await this.preflight(id);const uploaded=await this.media.upload(file,{voice});this.db.prepare('INSERT INTO uploads VALUES(?,?,?,?,?)').run(uploaded.id,id,uploaded.mediaId,JSON.stringify(uploaded),Date.now());return uploaded;}
 message(id){const row=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);return row?{...row,payload:this.payload(row.payload)}:null;}
 mediaId({message,upload}){if(message){const row=this.message(message);if(!row)throw fail('Media not found.',404);return row.payload.media?.id||row.payload.mediaId;}const row=this.db.prepare('SELECT media_id FROM uploads WHERE id=?').get(upload||'');if(!row)throw fail('Upload not found.',404);return row.media_id;}
 chatAction({id,action}){
  if(!validId(id))throw fail('Choose a customer.');const row=this.db.prepare('SELECT id FROM contacts WHERE id=?').get(id);if(!row)throw fail('Customer not found.',404);
  const set={read:'unread=0',unread:'unread=MAX(1,unread)',pin:'pinned=1',unpin:'pinned=0',archive:'archived=1',unarchive:'archived=0'}[action];if(!set)throw fail('Unknown action.');this.db.prepare('UPDATE contacts SET '+set+' WHERE id=?').run(id);this.bump();return {ok:true};
 }
 star({message,starred}){if(typeof starred!=='boolean'||!this.message(message))throw fail('Message not found.',404);this.db.prepare('UPDATE messages SET starred=? WHERE id=?').run(starred?1:0,message);this.bump();return {ok:true};}
 payment({id,state,note='',proof,confirmed=false}){
  if(!validId(id)||!['none','pending','verified','rejected'].includes(state)||typeof note!=='string'||note.length>240)throw fail('Invalid payment review.');
  if(state==='verified'&&!confirmed)throw fail('Check the payment in your payment app before confirming.');
  if(!this.db.prepare('SELECT id FROM contacts WHERE id=?').get(id))throw fail('Customer not found.',404);
  if(proof){const m=this.message(proof);if(!m||m.contact!==id||m.direction!=='in'||m.payload.type!=='image')throw fail('Select a customer screenshot from this chat.');}
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('UPDATE contacts SET payment_state=?,payment_note=? WHERE id=?').run(state,note,id);this.db.prepare('INSERT INTO payment_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),id,Date.now(),state,note,proof||null);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}this.bump();return {ok:true,state};
 }
 async manualReply(input){
  const {id,requestId}=input;if(!validId(id)||!/^[-a-f0-9]{36}$/i.test(requestId||''))throw fail('Invalid send.');
  const intent=JSON.stringify({text:input.text||'',upload:input.upload||null,reply:input.reply||null,reaction:input.reaction||null,qr:!!input.qr});
  const prior=this.serial.get(id)||Promise.resolve();const task=prior.catch(()=>{}).then(async()=>{
   const existing=this.db.prepare('SELECT * FROM outbox WHERE id=?').get(requestId);if(existing){if(existing.contact!==id||existing.text!==intent)throw fail('Send identifier is already in use.',409);return {state:existing.state,duplicate:true};}
   const contact=await this.preflight(id);let step,payload;
   if(input.qr){const {firstSequence}=await import('../funnel.mjs');step=firstSequence[3];payload={type:step.type,url:step.url,text:step.body,paymentRequest:true};}
   else if(input.reaction){const target=this.message(input.reaction.message);if(!target||target.contact!==id||!target.payload.providerId)throw fail('This message cannot receive a reaction.');const emoji=String(input.reaction.emoji||'');if([...new Intl.Segmenter().segment(emoji)].length>1||emoji&&!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(emoji))throw fail('Choose one emoji.');step={type:'reaction',messageId:target.payload.providerId,emoji};payload={type:'reaction',text:emoji,reactsTo:input.reaction.message};}
   else if(input.upload){const row=this.db.prepare('SELECT * FROM uploads WHERE id=? AND contact=?').get(input.upload,id);if(!row)throw fail('Choose a file uploaded to this chat.');const file=JSON.parse(row.data);const caption=String(input.text||'');if([...caption].length>1024)throw fail('Keep attachment captions under 1024 characters.');if(file.type==='audio'&&caption.trim())throw fail('Send the voice message without a caption.');step={type:file.type,mediaId:file.mediaId,filename:file.filename,body:caption};payload={...file,text:caption,uploadId:file.id};}
   else {const text=input.text;if(typeof text!=='string'||!text.trim()||[...text].length>4096)throw fail('Enter a message of 1–4096 characters.');step={type:'text',body:text};payload={type:'text',text};}
   let replyTo;if(input.reply){const target=this.message(input.reply);if(!target||target.contact!==id||!target.payload.providerId)throw fail('Choose a message from this chat to reply to.');replyTo=target.payload.providerId;payload.quote={text:(target.payload.text||'['+target.payload.type+']').slice(0,300),source:target.payload.source};}
   const at=Date.now();this.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?,?)').run(requestId,id,intent,'sending',null,null,at);let result;
   try{result=await this.send({token:this.env.META_ACCESS_TOKEN,phoneNumberId:this.env.WA_PHONE_NUMBER_ID,graphVersion:this.env.GRAPH_VERSION,to:contact.wa_id,step,replyTo});if(!result?.messageId)throw Object.assign(Error('unconfirmed'),{uncertain:true});}
   catch(error){const state=error.uncertain?'uncertain':'rejected';this.db.prepare('UPDATE outbox SET state=?,error_code=? WHERE id=?').run(state,String(error.code||'unconfirmed'),requestId);if(state==='uncertain')this.addCounts({uncertain:1});this.bump();return {state};}
   this.db.exec('BEGIN IMMEDIATE');try{const receipt=this.db.prepare('SELECT status FROM owner_receipts WHERE provider_id=? AND contact=?').get(result.messageId,id);this.db.prepare("UPDATE outbox SET state='accepted',provider_id=? WHERE id=?").run(result.messageId,requestId);this.saveMessage('manual:'+requestId,id,at,'out',{...payload,source:'you',delivery:receipt?.status||'accepted',providerId:result.messageId},result.messageId);this.db.prepare('UPDATE contacts SET last_at=MAX(last_at,?) WHERE id=?').run(at,id);this.addCounts({manualAccepted:1,messages:1});this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}this.bump();return {state:'accepted'};
  });this.serial.set(id,task);try{return await task;}finally{if(this.serial.get(id)===task)this.serial.delete(id);}
 }
 status(){let disk;try{disk=this.checkDisk();}catch{disk=this.disk;}return {backend:'Oracle',mode:'manual-replies-only',automaticFunnel:'Cloudflare (unchanged)',lastSyncAt:this.lastSyncTime||this.meta('lastSyncAt'),error:this.lastError,...this.meta('counters'),accountPaused:!!this.meta('index')?.account?.paused,version:this.version,disk,discoveryWindow:100,capacityTarget:10000000,capacityVerified:false,capacityReport:this.capacityReport};}
}
