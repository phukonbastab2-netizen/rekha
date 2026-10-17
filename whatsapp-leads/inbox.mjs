const iq=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
const inboxJson=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow'}});
const phoneOk=value=>/^[0-9]{6,20}$/.test(value||'');
const uuidOk=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value||'');
function cursor(value){if(!value)return null;try{const v=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value),c=>c.charCodeAt(0))));if(Array.isArray(v)&&v.length===2&&Number.isSafeInteger(v[0])&&typeof v[1]==='string'&&v[1].length<400)return v;}catch{}throw Object.assign(Error('Invalid page cursor.'),{status:400});}
const makeCursor=(time,id)=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([time,id]))));
const preview=message=>message.text||('['+(message.type||'message')+']');

export function inboxIncomingStatements(env,message,now,action){
 const raw=message.details||{},media=raw[message.type]||{},body=message.text||'',details=JSON.stringify(raw);
 const statements=[
  iq(env,"INSERT OR IGNORE INTO wa_inbox_contacts(phone,name) VALUES(?,?)",message.phone,message.name||''),
  iq(env,"INSERT OR IGNORE INTO wa_messages(id,phone,direction,type,body,details_json,media_id,mime,filename,source,created_at,received_at,state,meta_id,archive_state) VALUES(?,?,'in',?,?,?,?,?,?,'customer',?,?,'received',?,?)",'in:'+message.id,message.phone,message.type||'text',body,details,media.id||null,media.mime_type||null,media.filename||null,message.timestamp,now,message.id,media.id?'pending':'none'),
  iq(env,"UPDATE wa_inbox_contacts SET name=CASE WHEN ?!='' THEN ? ELSE name END,preview=CASE WHEN ? >=last_at THEN ? ELSE preview END,last_at=MAX(last_at,?),unread=unread+1 WHERE phone=? AND changes()=1",message.name||'',message.name||'',message.timestamp,preview(message).slice(0,160),message.timestamp,message.phone),
 ];
 if(action==='stop'||action==='start')statements.push(iq(env,"UPDATE wa_inbox_contacts SET opted_out=?,control_at=? WHERE phone=? AND (control_at<? OR (control_at=? AND ?=1))",action==='stop'?1:0,message.timestamp,message.phone,message.timestamp,message.timestamp,action==='stop'?1:0));
 return statements;
}

export async function inboxAutomaticStart(env,job,caption,videoUrl,now){
 const body=JSON.stringify({video:{link:videoUrl}});
 await env.DB.batch([
  iq(env,"INSERT OR IGNORE INTO wa_messages(id,phone,direction,type,body,details_json,source,created_at,received_at,state) VALUES(?,?,'out','video',?,?,'automatic',?,?,'sending')",'auto:'+job.id,job.phone,caption,body,now,now),
  iq(env,"UPDATE wa_inbox_contacts SET preview=?,last_at=MAX(last_at,?) WHERE phone=?",'[App download video]',now,job.phone),
 ]);
}
export async function inboxAutomaticResult(env,job,now){
 const row=await iq(env,'SELECT state,meta_id,error_code FROM lead_jobs WHERE id=?',job.id).first();
 if(row)await iq(env,'UPDATE wa_messages SET state=?,meta_id=?,error_code=? WHERE id=?',row.state,row.meta_id||null,row.error_code||null,'auto:'+job.id).run();
}
export function inboxStatusStatement(env,status){
 return iq(env,"UPDATE wa_messages SET delivery_status=?,error_code=? WHERE meta_id=? AND (delivery_status IS NULL OR delivery_status='sent' OR (?='read' AND delivery_status='delivered'))",status.status,status.errorCode||null,status.id,status.status);
}

async function boundedBody(request,max){
 const reader=request.body?.getReader();if(!reader)return new Uint8Array();let size=0;const chunks=[];
 for(;;){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>max){await reader.cancel();throw Object.assign(Error('Message is too large.'),{status:413});}chunks.push(v.value);}
 const bytes=new Uint8Array(size);let n=0;for(const part of chunks){bytes.set(part,n);n+=part.length;}return bytes;
}
async function parseInboxBody(request){try{const data=JSON.parse(new TextDecoder().decode(await boundedBody(request,50000)));if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data;}catch(e){if(e.status)throw e;throw Object.assign(Error('Invalid message.'),{status:400});}}
const inboxError=(status,message)=>Object.assign(Error(message),{status});

async function manualSend(request,env,phone,fetcher){
 const data=await parseInboxBody(request),text=typeof data.text==='string'?data.text.trim():'';
 if(!uuidOk(data.clientId)||!text||text.length>4096)throw inboxError(400,'Enter a message of up to 4096 characters.');
 const id='manual:'+phone+':'+data.clientId,previous=await iq(env,'SELECT * FROM wa_messages WHERE id=?',id).first();
 if(previous){if(previous.body!==text)throw inboxError(409,'This send identifier belongs to a different message.');return inboxJson({message:previous,repeated:true},200);}
 if(env.SEND_ENABLED!=='true')throw inboxError(409,'WhatsApp sending is paused.');
 const contact=await iq(env,'SELECT c.last_inbound,COALESCE(i.opted_out,0) AS opted_out FROM lead_contacts c LEFT JOIN wa_inbox_contacts i ON i.phone=c.phone WHERE c.phone=?',phone).first(),now=Date.now();
 if(!contact)throw inboxError(404,'Customer not found.');
 if(contact.opted_out)throw inboxError(409,'This customer opted out. Wait for them to send START.');
 if(now-contact.last_inbound>=86400000)throw inboxError(409,'The 24-hour reply window is closed. Wait for a customer message or use an approved WhatsApp template.');
 // One durable reservation for each deliberate Send action, even if HTTP times out.
 const claim=await iq(env,"INSERT OR IGNORE INTO wa_messages(id,phone,direction,type,body,source,created_at,received_at,state) VALUES(?,?,'out','text',?,'manual',?,?,'sending')",id,phone,text,now,now).run();
 if(!claim.meta.changes)return inboxJson({message:await iq(env,'SELECT * FROM wa_messages WHERE id=?',id).first(),repeated:true});
 const fresh=await iq(env,'SELECT c.last_inbound,COALESCE(i.opted_out,0) AS opted_out FROM lead_contacts c LEFT JOIN wa_inbox_contacts i ON i.phone=c.phone WHERE c.phone=?',phone).first();
 if(fresh.opted_out||Date.now()-fresh.last_inbound>=86400000||env.SEND_ENABLED!=='true'){
  await iq(env,"UPDATE wa_messages SET state='failed',error_code='send_cancelled' WHERE id=?",id).run();throw inboxError(409,'Customer reply permission changed. Message was not sent.');
 }
 try{
  const response=await fetcher(`https://graph.facebook.com/${env.GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,{method:'POST',headers:{Authorization:'Bearer '+env.WHATSAPP_ACCESS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:phone,type:'text',text:{preview_url:false,body:text}}),signal:AbortSignal.timeout(15000)});
  const result=await response.json(),meta=result.messages?.[0]?.id,state=response.ok&&meta?'accepted':response.ok?'unknown':'failed';
  await iq(env,'UPDATE wa_messages SET state=?,meta_id=?,error_code=? WHERE id=?',state,meta||null,response.ok?null:'meta_'+(result.error?.code||response.status),id).run();
 }catch{await iq(env,"UPDATE wa_messages SET state='unknown',error_code='send_outcome_unknown' WHERE id=?",id).run();}
 await iq(env,'UPDATE wa_inbox_contacts SET last_at=MAX(last_at,?),preview=? WHERE phone=?',now,text.slice(0,160),phone).run();
 return inboxJson({message:await iq(env,'SELECT * FROM wa_messages WHERE id=?',id).first()},202);
}

async function ownerMedia(request,env,id,fetcher){
 if(!/^\d{5,40}$/.test(id))throw inboxError(404,'Attachment not found.');
 const message=await iq(env,'SELECT mime,filename,archive_key FROM wa_messages WHERE media_id=? LIMIT 1',id).first();if(!message)throw inboxError(404,'Attachment not found.');
 if(message.archive_key&&env.WA_MEDIA){
  const meta=await env.WA_MEDIA.head(message.archive_key);if(meta){
   let start=0,end=meta.size-1;const range=request.headers.get('Range');
   if(range){const match=range.match(/^bytes=(\d+)-(\d*)$/);if(!match)throw inboxError(416,'Invalid media range.');start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));if(start>end||start>=meta.size)throw inboxError(416,'Invalid media range.');}
   const object=await env.WA_MEDIA.get(message.archive_key,{range:{offset:start,length:end-start+1}});
   return new Response(object.body,{status:range?206:200,headers:{...mediaHeaders(message.mime||meta.httpMetadata?.contentType,message.filename),'Content-Length':String(end-start+1),'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${meta.size}`}:{})}});
  }
 }
 const metadata=await fetcher(`https://graph.facebook.com/${env.GRAPH_API_VERSION}/${id}?phone_number_id=${env.WHATSAPP_PHONE_NUMBER_ID}`,{headers:{Authorization:'Bearer '+env.WHATSAPP_ACCESS_TOKEN},signal:AbortSignal.timeout(10000)});
 if(!metadata.ok)throw inboxError(410,'WhatsApp no longer has this attachment.');
 const info=await metadata.json(),url=new URL(info.url);
 if(url.protocol!=='https:'||!['lookaside.fbsbx.com','mmg.whatsapp.net'].includes(url.hostname))throw inboxError(502,'Unexpected WhatsApp attachment server.');
 const media=await fetcher(url,{headers:{Authorization:'Bearer '+env.WHATSAPP_ACCESS_TOKEN,...(request.headers.has('Range')?{Range:request.headers.get('Range')}:{})},redirect:'error',signal:AbortSignal.timeout(20000)});
 if(![200,206].includes(media.status))throw inboxError(410,'Attachment is unavailable.');
 const headers=mediaHeaders(info.mime_type||message.mime,message.filename);
 for(const name of ['Content-Length','Content-Range','Accept-Ranges'])if(media.headers.has(name))headers[name]=media.headers.get(name);
 return new Response(media.body,{status:media.status,headers});
}

function mediaHeaders(value,filename){
 const mime=value||'application/octet-stream',safeInline=/^(image\/(jpeg|png|webp)|audio\/(mpeg|mp4|ogg|aac|amr|wav)|video\/(mp4|3gpp))$/.test(mime);
 return {'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':safeInline?'inline':'attachment; filename="'+(filename||'WhatsApp-attachment').replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,120)+'"'};
}

export async function inboxArchiveMedia(env,fetcher=fetch){
 if(!env.WA_MEDIA||!env.WHATSAPP_ACCESS_TOKEN)return;
 await iq(env,"UPDATE wa_messages SET archive_state='failed' WHERE archive_state='processing' AND archive_updated<?",Date.now()-300000).run();
 const row=await iq(env,"SELECT id,media_id FROM wa_messages WHERE archive_state IN ('pending','failed') AND archive_attempts<3 ORDER BY created_at LIMIT 1").first();if(!row)return;
 const claim=await iq(env,"UPDATE wa_messages SET archive_state='processing',archive_attempts=archive_attempts+1,archive_updated=? WHERE id=? AND archive_state IN ('pending','failed') AND archive_attempts<3",Date.now(),row.id).run();if(!claim.meta.changes)return;
 try{
  if(!/^\d{5,40}$/.test(row.media_id))throw Error();
  const response=await fetcher(`https://graph.facebook.com/${env.GRAPH_API_VERSION}/${row.media_id}?phone_number_id=${env.WHATSAPP_PHONE_NUMBER_ID}`,{headers:{Authorization:'Bearer '+env.WHATSAPP_ACCESS_TOKEN},signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error();
  const info=await response.json(),url=new URL(info.url);if(url.protocol!=='https:'||!['lookaside.fbsbx.com','mmg.whatsapp.net'].includes(url.hostname)||Number(info.file_size)>100*1024*1024)throw Error();
  const media=await fetcher(url,{headers:{Authorization:'Bearer '+env.WHATSAPP_ACCESS_TOKEN},redirect:'error',signal:AbortSignal.timeout(18000)});if(!media.ok||Number(media.headers.get('Content-Length'))>100*1024*1024)throw Error();
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(row.id))),n=>n.toString(16).padStart(2,'0')).join(''),key='whatsapp-private/'+digest;
  await env.WA_MEDIA.put(key,media.body,{httpMetadata:{contentType:info.mime_type||'application/octet-stream'}});
  const stored=await iq(env,"UPDATE wa_messages SET archive_key=?,archive_state='saved',mime=?,archive_updated=? WHERE id=?",key,info.mime_type||'application/octet-stream',Date.now(),row.id).run();
  if(!stored.meta.changes)await env.WA_MEDIA.delete(key);
 }catch{await iq(env,"UPDATE wa_messages SET archive_state='failed',archive_updated=? WHERE id=?",Date.now(),row.id).run();}
}

export async function inboxCleanup(env){
 const before=Date.now()-90*86400000;
 await env.DB.batch([
  iq(env,'INSERT OR IGNORE INTO wa_media_cleanup(object_key) SELECT archive_key FROM wa_messages WHERE received_at<? AND archive_key IS NOT NULL',before),
  iq(env,'DELETE FROM wa_messages WHERE received_at<?',before),
  iq(env,"UPDATE wa_inbox_contacts SET name='',preview='History expired',unread=0 WHERE last_at<? AND (name!='' OR unread!=0 OR preview!='History expired')",before),
 ]);
 if(!env.WA_MEDIA)return;
 const rows=(await iq(env,'SELECT object_key FROM wa_media_cleanup LIMIT 5').all()).results;
 for(const row of rows){try{await env.WA_MEDIA.delete(row.object_key);await iq(env,'DELETE FROM wa_media_cleanup WHERE object_key=?',row.object_key).run();}catch{}}
}

export async function inboxOwnerRoute(request,env,fetcher=fetch){
 const url=new URL(request.url);if(!url.pathname.startsWith('/owner/'))return null;
 // This credential exists only on the two Cloudflare Workers, never in the UI.
 const token=request.headers.get('Authorization')||'',expected=env.WHATSAPP_ADMIN_TOKEN;
 if(!expected||token!=='Bearer '+expected)return inboxJson({error:'Not found'},404);
 try{
  if(url.pathname==='/owner/contacts'&&request.method==='GET'){
   const after=cursor(url.searchParams.get('cursor')),search=(url.searchParams.get('search')||'').trim().replace(/[^0-9a-zA-Z\u0900-\u097f @._+-]/g,'').slice(0,80),args=[];
   let where='',order='i.last_at DESC,i.phone DESC';
   if(search){
    const byPhone=/^\+?\d+$/.test(search),term=byPhone?search.replace(/^\+/,''):search;
    where=byPhone?' WHERE i.phone>=? AND i.phone<?':' WHERE i.name>=? COLLATE NOCASE AND i.name<? COLLATE NOCASE';args.push(term,term+'\uffff');order=byPhone?'i.phone':'i.name COLLATE NOCASE,i.phone';
    if(after){let last;try{last=JSON.parse(after[1]);}catch{throw inboxError(400,'Invalid search cursor.');}if(!Array.isArray(last)||last.length!==2||typeof last[0]!=='string'||!phoneOk(last[1]))throw inboxError(400,'Invalid search cursor.');where+=byPhone?' AND i.phone>?':' AND (i.name COLLATE NOCASE,i.phone)>(?,?)';args.push(...(byPhone?[last[1]]:last));}
   }else if(after){where=' WHERE (i.last_at,i.phone)<(?,?)';args.push(...after);}
   const result=await iq(env,'SELECT i.*,c.last_inbound,c.paused FROM wa_inbox_contacts i LEFT JOIN lead_contacts c ON c.phone=i.phone'+where+' ORDER BY '+order+' LIMIT 51',...args).all(),rows=result.results.slice(0,50),last=rows.at(-1);
   return inboxJson({contacts:rows,nextCursor:result.results.length>50?makeCursor(search?0:last.last_at,search?JSON.stringify([last.name,last.phone]):last.phone):null,retentionDays:90});
  }
  const media=url.pathname.match(/^\/owner\/media\/([^/]+)$/);if(media&&request.method==='GET')return await ownerMedia(request,env,media[1],fetcher);
  const match=url.pathname.match(/^\/owner\/contacts\/(\d{6,20})\/(messages|send|read|delete)$/);if(!match)throw inboxError(404,'Not found.');const [,phone,action]=match;
  if(action==='send'&&request.method==='POST')return await manualSend(request,env,phone,fetcher);
  if(action==='messages'&&request.method==='GET'){
   const after=cursor(url.searchParams.get('cursor')),args=[phone];let where='phone=?';if(after){where+=' AND (created_at,id)<(?,?)';args.push(...after);}
   const result=await iq(env,'SELECT * FROM wa_messages WHERE '+where+' ORDER BY created_at DESC,id DESC LIMIT 101',...args).all(),rows=result.results.slice(0,100);
   const contact=await iq(env,'SELECT i.*,c.last_inbound,c.paused FROM wa_inbox_contacts i LEFT JOIN lead_contacts c ON c.phone=i.phone WHERE i.phone=?',phone).first();if(!contact)throw inboxError(404,'Customer not found.');
   return inboxJson({contact,messages:rows.reverse(),nextCursor:result.results.length>100?makeCursor(rows[0].created_at,rows[0].id):null,replyWindowEndsAt:(contact.last_inbound||0)+86400000,retentionDays:90});
  }
  if(action==='read'&&request.method==='POST'){
   const data=await parseInboxBody(request);if(!Array.isArray(data.ids)||data.ids.length>100||!data.ids.every(id=>typeof id==='string'&&id.length<=300))throw inboxError(400,'Read message identifiers required.');
   await env.DB.batch([iq(env,"UPDATE wa_messages SET owner_seen=1 WHERE phone=? AND direction='in' AND id IN(SELECT value FROM json_each(?))",phone,JSON.stringify(data.ids)),iq(env,"UPDATE wa_inbox_contacts SET unread=(SELECT COUNT(*) FROM wa_messages WHERE phone=? AND direction='in' AND owner_seen=0) WHERE phone=?",phone,phone)]);return inboxJson({ok:true});
  }
  if(action==='delete'&&request.method==='POST'){
   await env.DB.batch([iq(env,'INSERT OR IGNORE INTO wa_media_cleanup(object_key) SELECT archive_key FROM wa_messages WHERE phone=? AND archive_key IS NOT NULL',phone),iq(env,'DELETE FROM wa_messages WHERE phone=?',phone),iq(env,'DELETE FROM lead_jobs WHERE phone=?',phone),iq(env,"UPDATE wa_inbox_contacts SET name='',preview='History deleted',unread=0 WHERE phone=?",phone)]);
   await inboxCleanup(env);
   return inboxJson({ok:true,duplicateProtectionPreserved:true});
  }
  throw inboxError(405,'Method not allowed.');
 }catch(error){return inboxJson({error:error.status?error.message:'WhatsApp inbox temporarily unavailable.'},error.status||503);}
}
