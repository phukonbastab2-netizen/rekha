export const APP_URL = 'https://rekhaastrology.in';
export const DOWNLOAD_URL = APP_URL;
export const DOWNLOAD_REPLY = 'रेखा | Rekha Astrology\nमुझसे बात करने के लिए ऐप पर आएँ, यहाँ नहीं।\nMujhse baat karne ke liye app par aaiye, yahan nahi.\n'+DOWNLOAD_URL;

const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json','cache-control':'no-store'}});
const number = (value, fallback, max) => Math.max(1, Math.min(max, Number.parseInt(value,10)||fallback));
const q = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const required = ['DB','VERIFY_TOKEN','META_APP_SECRET','WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_WABA_ID','GRAPH_API_VERSION'];
export function readiness(env) { return {enabled:env.SEND_ENABLED==='true', missing:required.filter(k=>!env[k])}; }

export async function verifySignature(raw, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/.test(signature||'')) return false;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=Uint8Array.from(signature.slice(7).match(/../g),x=>parseInt(x,16));
  return crypto.subtle.verify('HMAC',key,bytes,raw);
}

export function parseEvents(payload, env, now=Date.now()) {
  const messages=[], statuses=[];
  if(payload?.object!=='whatsapp_business_account') return {messages,statuses};
  for(const entry of payload.entry||[]) {
    if(String(entry.id)!==String(env.WHATSAPP_WABA_ID)) continue;
    for(const change of entry.changes||[]) {
      const value=change.value;
      if(change.field!=='messages'||String(value?.metadata?.phone_number_id)!==String(env.WHATSAPP_PHONE_NUMBER_ID)) continue;
      for(const item of value.messages||[]) {
        const timestamp=Number(item.timestamp)*1000;
        if(!/^[0-9]{6,20}$/.test(item.from||'') || typeof item.id!=='string' || item.id.length>256 ||
          !Number.isFinite(timestamp)||timestamp<now-86400000||timestamp>now+300000) continue;
        const text=item.type==='text'?item.text?.body:item.type==='interactive'?(item.interactive?.button_reply?.title||item.interactive?.list_reply?.title):null;
        // Never download inbound media; a non-text message can still receive a read receipt and app link.
        messages.push({id:item.id,phone:item.from,text:typeof text==='string'?text.trim().slice(0,2000):'',timestamp});
      }
      for(const item of value.statuses||[]) {
        if(typeof item.id==='string' && ['sent','delivered','read','failed'].includes(item.status)) {
          statuses.push({id:item.id,status:item.status,timestamp:Number(item.timestamp)*1000,errorCode:String(item.errors?.[0]?.code||'').slice(0,32)});
        }
      }
    }
  }
  return {messages,statuses};
}

export function command(text) {
  const clean=text.toLowerCase().trim().replace(/[.!।]+$/,'');
  if(/^(stop|unsubscribe|cancel|band karo|band kardo|बंद|बंद करो|मत भेजो)$/.test(clean)) return 'stop';
  if(/^(start|resume|शुरू)$/.test(clean)) return 'start';
  if(/\b(human|agent|person|team)\b|इंसान|व्यक्ति|असली ज्योतिषी/.test(clean)) return 'human';
  return null;
}

async function ingest(env, events, now) {
  for(const status of events.statuses) {
    // Never downgrade a delivered/read receipt if callbacks arrive out of order.
    await q(env,`UPDATE lead_jobs SET delivery_status=?, delivery_at=?, error_code=? WHERE meta_id=?
      AND (delivery_status IS NULL OR delivery_status='sent' OR (?='read' AND delivery_status='delivered'))`,
      status.status,status.timestamp||now,status.errorCode,status.id,status.status).run();
    await q(env,`UPDATE lead_downloads SET delivery_status=?,delivery_at=?,error_code=? WHERE meta_id=? AND (delivery_status IS NULL OR delivery_status='sent' OR (?='read' AND delivery_status='delivered'))`,status.status,status.timestamp||now,status.errorCode,status.id,status.status).run();
  }
  for(const message of events.messages) {
    await env.DB.batch([
      q(env,`INSERT OR IGNORE INTO lead_contacts(phone,last_inbound,created_at) VALUES(?,?,?)`,message.phone,message.timestamp,now),
      q(env,`INSERT OR IGNORE INTO lead_jobs(id,phone,body,inbound_at,created_at,state) VALUES(?,?,?,?,?,'pending')`,message.id,message.phone,message.text,message.timestamp,now),
      q(env,`UPDATE lead_contacts SET last_inbound=MAX(last_inbound,?) WHERE phone=?`,message.timestamp,message.phone),
      q(env,`INSERT OR IGNORE INTO lead_read_receipts(id,created_at) VALUES(?,?)`,message.id,now),
    ]);
    const action=command(message.text);
    if(action) await q(env,`UPDATE lead_contacts SET paused=?,control_at=? WHERE phone=? AND (control_at<? OR (control_at=? AND ?=1))`,action==='start'?0:1,message.timestamp,message.phone,message.timestamp,message.timestamp,action==='start'?0:1).run();
  }
}

export async function markIncomingRead(env,fetcher=fetch) {
  if(env.SEND_ENABLED!=='true'||!env.WHATSAPP_ACCESS_TOKEN) return;
  // Read marking is idempotent, so an interrupted attempt can safely be retried.
  await q(env,`UPDATE lead_read_receipts SET state='failed' WHERE state='processing' AND updated_at<?`,Date.now()-60000).run();
  const rows=await q(env,`SELECT id FROM lead_read_receipts WHERE state IN ('pending','failed') AND attempts<3 ORDER BY created_at LIMIT 10`).all();
  await Promise.all(rows.results.map(async({id})=>{
    const claim=await q(env,`UPDATE lead_read_receipts SET state='processing',attempts=attempts+1,updated_at=? WHERE id=? AND state IN ('pending','failed') AND attempts<3`,Date.now(),id).run();
    if(!claim.meta.changes)return;
    let ok=false,error='read_outcome_unknown';
    try {
      const response=await fetcher(`https://graph.facebook.com/${env.GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,{
        method:'POST',headers:{authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,'content-type':'application/json'},
        body:JSON.stringify({messaging_product:'whatsapp',status:'read',message_id:id}),signal:AbortSignal.timeout(5000),
      });
      const result=await response.json();ok=response.ok&&result.success===true;error=ok?'':`meta_${result.error?.code||response.status}`;
    } catch {}
    await q(env,`UPDATE lead_read_receipts SET state=?,error_code=?,updated_at=? WHERE id=?`,ok?'accepted':'failed',error,Date.now(),id).run();
  }));
}

async function processJob(env, job, now, fetcher=fetch) {
  const lock=crypto.randomUUID();
  const acquired=await q(env,`UPDATE lead_contacts SET lock_token=?,lock_until=? WHERE phone=? AND lock_until<?`,lock,now+120000,job.phone,now).run();
  if(!acquired.meta.changes) return;
  try {
    const claim=await q(env,`UPDATE lead_jobs SET state='processing',attempts=attempts+1,updated_at=? WHERE id=? AND state='pending'`,now,job.id).run();
    if(!claim.meta.changes) return;
    const contact=await q(env,'SELECT * FROM lead_contacts WHERE phone=?',job.phone).first();
    const cmd=command(job.body);
    if(cmd==='stop'||cmd==='human') {
      await q(env,`UPDATE lead_jobs SET state='skipped',error_code=? WHERE id=?`,cmd,job.id).run();
      return;
    }
    if(contact.paused || now-job.inbound_at>=86400000 || now-contact.last_inbound>=86400000) {
      await q(env,`UPDATE lead_jobs SET state='skipped',error_code='paused_or_expired' WHERE id=?`,job.id).run(); return;
    }
    const previous=await q(env,'SELECT state FROM lead_downloads WHERE phone=?',job.phone).first();
    if(previous) {
      await q(env,`UPDATE lead_jobs SET state='skipped',error_code='app_link_already_sent' WHERE id=?`,job.id).run();return;
    }
    // Preserve the approved daily ceiling, without making any OpenAI requests.
    const day=new Date(now).toISOString().slice(0,10);
    await q(env,'INSERT OR IGNORE INTO lead_budget(day,requests) VALUES(?,0)',day).run();
    const budget=await q(env,'UPDATE lead_budget SET requests=requests+1 WHERE day=? AND requests<?',day,number(env.DAILY_SEND_LIMIT,100,10000)).run();
    if(!budget.meta.changes) {await q(env,`UPDATE lead_jobs SET state='skipped',error_code='global_limit' WHERE id=?`,job.id).run();return;}
    const reply=DOWNLOAD_REPLY;
    // Recheck opt-out and window immediately before reserving the send.
    const current=await q(env,'SELECT paused,last_inbound FROM lead_contacts WHERE phone=?',job.phone).first();
    if(current.paused||Date.now()-current.last_inbound>=86400000||env.SEND_ENABLED!=='true') {
      await q(env,`UPDATE lead_jobs SET state='skipped',error_code='send_cancelled' WHERE id=?`,job.id).run(); return;
    }
    const reservation=await q(env,`INSERT OR IGNORE INTO lead_downloads(phone,job_id,state,created_at,updated_at) VALUES(?,?,'sending',?,?)`,job.phone,job.id,Date.now(),Date.now()).run();
    if(!reservation.meta.changes){await q(env,`UPDATE lead_jobs SET state='skipped',error_code='app_link_already_sent' WHERE id=?`,job.id).run();return;}
    await q(env,`UPDATE lead_jobs SET state='sending',reply=?,updated_at=? WHERE id=?`,reply,Date.now(),job.id).run();
    // A timeout can mean Meta accepted the message. Mark unknown; never blindly retry.
    let response;
    try {
      response=await fetcher(`https://graph.facebook.com/${env.GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,{
        method:'POST',headers:{authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,'content-type':'application/json'},
        body:JSON.stringify({messaging_product:'whatsapp',to:job.phone,type:'text',text:{preview_url:false,body:reply}}),signal:AbortSignal.timeout(10000),
      });
      const result=await response.json();
      const metaId=result.messages?.[0]?.id;
      await q(env,`UPDATE lead_jobs SET state=?,meta_id=?,error_code=?,updated_at=? WHERE id=?`,response.ok&&metaId?'accepted':response.ok?'unknown':'failed',metaId||null,response.ok?'':`meta_${result.error?.code||response.status}`,Date.now(),job.id).run();
      await q(env,`UPDATE lead_downloads SET state=?,meta_id=?,error_code=?,updated_at=? WHERE job_id=?`,response.ok&&metaId?'accepted':response.ok?'unknown':'failed',metaId||null,response.ok?'':`meta_${result.error?.code||response.status}`,Date.now(),job.id).run();
    } catch { await q(env,`UPDATE lead_jobs SET state='unknown',error_code='send_outcome_unknown',updated_at=? WHERE id=?`,Date.now(),job.id).run(); await q(env,`UPDATE lead_downloads SET state='unknown',error_code='send_outcome_unknown',updated_at=? WHERE job_id=?`,Date.now(),job.id).run(); }
  } finally { await q(env,`UPDATE lead_contacts SET lock_until=0,lock_token=NULL WHERE phone=? AND lock_token=?`,job.phone,lock).run(); }
}

export async function drain(env, fetcher=fetch, limit=1) {
  if(env.SEND_ENABLED!=='true'||readiness(env).missing.length) return;
  const now=Date.now();
  // Crash recovery is deliberately conservative: never resend processing/sending jobs.
  await q(env,`UPDATE lead_jobs SET state='unknown',error_code='interrupted' WHERE state IN ('processing','sending') AND updated_at<?`,now-180000).run();
  await q(env,`UPDATE lead_downloads SET state='unknown',error_code='interrupted' WHERE state='sending' AND updated_at<?`,now-180000).run();
  const jobs=await q(env,`SELECT * FROM lead_jobs WHERE state='pending' ORDER BY created_at,id LIMIT ?`,number(limit,1,5)).all();
  for(const job of jobs.results) await processJob(env,job,Date.now(),fetcher);
}

async function pruneHistory(env) {
  // Also run on authenticated traffic when the account has no available cron slot.
  await env.DB.batch([
    q(env,'DELETE FROM lead_jobs WHERE created_at<?',Date.now()-7*86400000),
    q(env,'DELETE FROM lead_read_receipts WHERE created_at<?',Date.now()-7*86400000),
    q(env,'DELETE FROM lead_budget WHERE day<?',new Date(Date.now()-8*86400000).toISOString().slice(0,10)),
  ]);
}

async function webhook(request, env, ctx) {
  const url=new URL(request.url);
  if(request.method==='GET'&&url.pathname==='/health') return json({ok:true,service:'rekha-whatsapp-leads',mode:'app_download_link',aiReplies:false,...readiness(env)});
  if(url.pathname!=='/webhook') return new Response('Not found',{status:404});
  if(request.method==='GET') {
    if(env.VERIFY_TOKEN && url.searchParams.get('hub.mode')==='subscribe' && url.searchParams.get('hub.verify_token')===env.VERIFY_TOKEN) return new Response(url.searchParams.get('hub.challenge')||'');
    return new Response('Forbidden',{status:403});
  }
  if(request.method!=='POST') return new Response('Method not allowed',{status:405});
  if(!env.META_APP_SECRET) return new Response('Setup incomplete',{status:503});
  if(Number(request.headers.get('content-length'))>262144) return new Response('Too large',{status:413});
  const reader=request.body?.getReader(); if(!reader) return new Response('Bad request',{status:400});
  const chunks=[]; let length=0;
  while(true) {const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>262144){await reader.cancel();return new Response('Too large',{status:413});}chunks.push(value);}
  const raw=new Uint8Array(length); let at=0; for(const c of chunks){raw.set(c,at);at+=c.length;}
  if(!await verifySignature(raw,request.headers.get('x-hub-signature-256'),env.META_APP_SECRET)) return new Response('Unauthorized',{status:401});
  let payload; try {payload=JSON.parse(new TextDecoder().decode(raw));}catch{return new Response('Invalid JSON',{status:400});}
  if(!env.DB||!env.WHATSAPP_WABA_ID||!env.WHATSAPP_PHONE_NUMBER_ID) return new Response('Setup incomplete',{status:503});
  const now=Date.now(); const events=parseEvents(payload,env,now);
  await ingest(env,events,now);
  ctx.waitUntil(pruneHistory(env).catch(()=>console.error('lead_retention_failed')));
  ctx.waitUntil(markIncomingRead(env).catch(()=>console.error('lead_read_receipt_failed')));
  ctx.waitUntil(drain(env).catch(()=>console.error('lead_processor_failed')));
  return new Response('EVENT_RECEIVED');
}

export default {
  async fetch(request,env,ctx) {try{return await webhook(request,env,ctx);}catch{console.error('lead_webhook_failed');return new Response('Temporary failure',{status:503});}},
  async scheduled(_event,env,ctx) {
    ctx.waitUntil((async()=>{
      await markIncomingRead(env);
      await drain(env,fetch,5);
      // Keep a short conversation history; retain opt-outs after content expires.
      await pruneHistory(env);
    })().catch(()=>console.error('lead_schedule_failed')));
  },
};
