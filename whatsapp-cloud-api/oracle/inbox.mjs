import {DatabaseSync} from 'node:sqlite';
import {sendCloudMessage} from '../transport.mjs';

export class Inbox {
 constructor(filename,env,{fetchImpl=globalThis.fetch,send=sendCloudMessage}={}){
  this.env=env;this.fetchImpl=fetchImpl;this.send=send;this.serial=new Map();this.lastError=null;
  this.db=new DatabaseSync(filename);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY,wa_id TEXT NOT NULL,last_at INTEGER NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,contact TEXT NOT NULL,at INTEGER NOT NULL,direction TEXT NOT NULL,payload TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS messages_contact_time ON messages(contact,at,id);
   CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,contact TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,provider_id TEXT,error_code TEXT,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  // A process restart is never permission to repeat a possibly accepted send.
  this.db.exec("UPDATE outbox SET state='uncertain' WHERE state='sending'");
 }
 meta(key){const row=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);return row?JSON.parse(row.value):null;}
 putMeta(key,value){this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
 async source(path){
  const response=await this.fetchImpl(this.env.FUNNEL_ORIGIN+path,{headers:{Authorization:'Bearer '+this.env.ADMIN_TOKEN},redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw Error('source_unavailable');return response.json();
 }
 importContact(id,value){
  if(!value.found)return;
  if(value.phoneNumberId!==this.env.WA_PHONE_NUMBER_ID||!/^\d{6,20}$/.test(value.waId))throw Error('source_sender_mismatch');
  const prior=this.db.prepare('SELECT data FROM contacts WHERE id=?').get(id);
  const next={...value};delete next.records;delete next.next;
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.prepare('INSERT INTO contacts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET wa_id=excluded.wa_id,last_at=excluded.last_at,data=excluded.data').run(id,value.waId,value.lastInboundAt,JSON.stringify(next));
   const put=this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
   for(const [key,inbound]of value.records||[])put.run('in:'+id+':'+key,id,inbound.eventAt||inbound.receivedAt,'in',JSON.stringify({type:inbound.type,text:inbound.text||'',source:'customer'}));
   for(const job of value.jobs||[])if(job.acceptedAt&&job.messageId)put.run('auto:'+id+':'+job.id,id,job.acceptedAt,'out',JSON.stringify({type:job.step.type,text:job.step.body||'',url:job.step.url||null,source:'funnel',delivery:job.delivery||'accepted'}));
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  return prior;
 }
 async syncContact(id){
  let after='';let pages=0;
  do{
   const value=await this.source('/admin/inbox-sync?'+new URLSearchParams({id,...(after?{after}:{})}));
   this.importContact(id,value);after=value.next||'';
   if(++pages>=50&&after)throw Error('contact_history_requires_more_pages');
  }while(after);
 }
 async sync({force=false}={}){
  if(this.syncing)return this.syncing;
  this.syncing=(async()=>{
   try{
    const index=await this.source('/admin/inbox-index');
    if(index.phoneNumberId!==this.env.WA_PHONE_NUMBER_ID)throw Error('source_sender_mismatch');
    this.putMeta('index',index);
    const changed=force||index.account?.ingestion?.lastWebhookAt!==this.meta('lastImportedWebhookAt');
    if(changed){
     const ids=[...new Set([...(index.account?.ingestion?.recentConversationIds||[]),...this.db.prepare('SELECT id FROM contacts ORDER BY last_at DESC LIMIT 100').all().map(x=>x.id)])];
     for(let start=0;start<ids.length;start+=4)await Promise.all(ids.slice(start,start+4).map(id=>this.syncContact(id)));
    }
    this.putMeta('lastImportedWebhookAt',index.account?.ingestion?.lastWebhookAt||0);
    this.putMeta('lastSyncAt',Date.now());this.lastError=null;
   }catch{this.lastError='Conversation sync is temporarily unavailable';throw Error('sync_unavailable');}
  })();try{return await this.syncing;}finally{this.syncing=null;}
 }
 chats(search=''){
  const rows=this.db.prepare('SELECT id,wa_id,last_at,data FROM contacts WHERE wa_id LIKE ? ORDER BY last_at DESC LIMIT 200').all('%'+String(search).replace(/[%_]/g,'')+'%');
  return rows.map(row=>{const state=JSON.parse(row.data);const last=this.db.prepare('SELECT direction,payload,at FROM messages WHERE contact=? ORDER BY at DESC,id DESC LIMIT 1').get(row.id);
   return {id:row.id,number:'+'+row.wa_id,lastAt:last?.at||row.last_at,preview:last?JSON.parse(last.payload).text||'['+JSON.parse(last.payload).type+']':'',firstReplies:state.jobs.filter(j=>j.stage==='first'&&j.state==='accepted').length,pending:state.jobs.filter(j=>['pending','held','retry'].includes(j.state)).length,optedOut:state.optedOut};});
 }
 messages(id,before=Number.MAX_SAFE_INTEGER){
  return this.db.prepare('SELECT id,at,direction,payload FROM messages WHERE contact=? AND at<? ORDER BY at DESC,id DESC LIMIT 200').all(id,Number(before)||Number.MAX_SAFE_INTEGER).reverse().map(row=>({...row,payload:JSON.parse(row.payload)}));
 }
 status(){return {backend:'Oracle',mode:'manual-replies-only',automaticFunnel:'Cloudflare (unchanged)',lastSyncAt:this.meta('lastSyncAt'),error:this.lastError,
  contacts:this.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,manualAccepted:this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='accepted'").get().n,
  uncertain:this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='uncertain'").get().n,accountPaused:Boolean(this.meta('index')?.account?.paused)};}
 async manualReply({id,text,requestId}){
  if(!/^[a-f0-9]{64}$/i.test(id||'')||!/^[-a-f0-9]{36}$/i.test(requestId||'')||typeof text!=='string'||!text.trim()||[...text].length>4096)throw Object.assign(Error('Enter a message of 1–4096 characters.'),{status:400});
  const previous=this.serial.get(id)||Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{
   const existing=this.db.prepare('SELECT * FROM outbox WHERE id=?').get(requestId);
   if(existing){if(existing.contact!==id||existing.text!==text)throw Object.assign(Error('This send identifier is already in use.'),{status:409});return {state:existing.state,duplicate:true};}
   const index=await this.source('/admin/inbox-index');this.putMeta('index',index);await this.syncContact(id);
   const row=this.db.prepare('SELECT * FROM contacts WHERE id=?').get(id);if(!row)throw Object.assign(Error('Choose a synced customer conversation.'),{status:404});
   const state=JSON.parse(row.data);
   if(index.account?.paused||state.restricted||state.optedOut||state.nameApprovalRequired)throw Object.assign(Error('Sending is paused for this conversation.'),{status:409});
   if(index.ownerTestOnly&&index.testConversationId!==id)throw Object.assign(Error('The current number is still limited to its owner test contact.'),{status:409});
   if(state.jobs.filter(j=>j.stage==='first'&&j.state==='accepted').length!==5)throw Object.assign(Error('Wait for the first five automatic replies to finish.'),{status:409});
   if(Date.now()-state.lastInboundAt>=86400000)throw Object.assign(Error('Ask the customer to message again to open the 24-hour reply window.'),{status:409});
   if(this.db.prepare("SELECT id FROM outbox WHERE contact=? AND state IN ('sending','uncertain') LIMIT 1").get(id))throw Object.assign(Error('An earlier send needs checking before another reply.'),{status:409});
   const at=Date.now();this.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?,?)').run(requestId,id,text,'sending',null,null,at);
   let result;
   try{
    result=await this.send({token:this.env.META_ACCESS_TOKEN,phoneNumberId:this.env.WA_PHONE_NUMBER_ID,graphVersion:this.env.GRAPH_VERSION,to:row.wa_id,step:{type:'text',body:text}});
    if(!result?.messageId)throw Object.assign(Error('unconfirmed'),{uncertain:true});
   }catch(error){const state=error.uncertain?'uncertain':'rejected';this.db.prepare('UPDATE outbox SET state=?,error_code=? WHERE id=?').run(state,String(error.code||'unconfirmed'),requestId);return {state};}
   this.db.exec('BEGIN IMMEDIATE');try{
    this.db.prepare("UPDATE outbox SET state='accepted',provider_id=? WHERE id=?").run(result.messageId,requestId);
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('manual:'+requestId,id,at,'out',JSON.stringify({type:'text',text,source:'you',delivery:'accepted'}));this.db.exec('COMMIT');
   }catch(error){this.db.exec('ROLLBACK');throw error;}
   return {state:'accepted'};
  });this.serial.set(id,task);try{return await task;}finally{if(this.serial.get(id)===task)this.serial.delete(id);}
 }
 close(){this.db.close();}
}
