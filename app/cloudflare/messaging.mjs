// Additive private messaging data. Every action resolves its authenticated chat first.
const messagingEmoji=new Set(['👍','❤️','😂','😮','😢','🙏']);
const messagingMimes=new Set(['image/jpeg','image/png','image/webp','video/mp4','video/webm','audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/wav','application/pdf']);
const messagingId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const messagingClient=value=>typeof value==='string'&&/^[\w-]{16,80}$/.test(value);
const messagingSafeName=value=>(typeof value==='string'?value:'Attachment').replace(/[\x00-\x1f\x7f/\\]/g,' ').trim().slice(0,120)||'Attachment';
const inboxFilters=new Set(['all','active','unread','waiting','archived','pinned','blocked']);
export function messagingInboxQuery({filter='all',q='',cursor=null,limit=80,bounded=true}){
  const where=[],args=[],search=!!q,order=search?'name':'activity';
  if(bounded){
    where.push(filter==='archived'?'c.inbox_archived=1':'c.inbox_archived=0');
    if(filter==='pinned')where.push('c.inbox_pinned=1');
    if(filter==='blocked')where.push('c.inbox_blocked=1');
    if(filter==='waiting')where.push('c.waiting_count>0');
    if(filter==='unread')where.push('c.last_user_id>c.inbox_owner_read');
    if(search){
      const lower=q.replace(/[A-Z]/g,char=>char.toLowerCase()),points=Array.from(lower);let upper=null;
      while(points.length){const last=points.pop().codePointAt(0);if(last<0x10ffff){upper=points.join('')+String.fromCodePoint(last+1);break;}}
      where.push("c.name>=? COLLATE NOCASE");args.push(lower);
      if(upper!==null){where.push("c.name<? COLLATE NOCASE");args.push(upper);}
      // D1 caps LIKE patterns at50bytes; literal prefixes can be longer in Hindi.
      // The explicit bounds still seek the name index before this exact check.
      where.push('substr(c.name,1,length(?))=? COLLATE NOCASE');args.push(q,q);
    }
    if(cursor){
      if(search){where.push('(c.name COLLATE NOCASE,c.id)>(? COLLATE NOCASE,?)');args.push(cursor.name,cursor.id);}
      else{where.push('(c.inbox_pinned,c.updated,c.id)<(?,?,?)');args.push(cursor.pinned,cursor.updated,cursor.id);}
    }
  }
  const capped=bounded?'SELECT COUNT(*) FROM (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role=\'user\' AND m.status!=\'deleted\' AND m.id>c.inbox_owner_read LIMIT 101)':'SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.role=\'user\' AND m.status!=\'deleted\' AND m.id>c.inbox_owner_read';
  const searchIndex='conversations_name_'+(filter==='archived'?'archived':['unread','waiting','pinned','blocked'].includes(filter)?filter:'active');
  const sql=`SELECT c.id,c.name,c.language,c.mode,c.entitlement,c.updated,c.version,c.inbox_revision AS inboxRevision,c.free_used,c.inbox_pinned AS pinned,c.inbox_archived AS archived,c.inbox_blocked AS blocked,COALESCE(s.labels,'[]') AS labels,COALESCE(s.notes,'') AS notes,${bounded?'MIN(c.waiting_count,101)':'c.waiting_count'} AS waiting,(${capped}) AS unread,c.last_user_id AS latestUserMessageId,c.last_user_id AS latestUserId,c.last_message_id AS latestMessageId FROM conversations c ${search?'INDEXED BY '+searchIndex:''} LEFT JOIN chat_messaging s ON s.conversation_id=c.id${where.length?' WHERE '+where.join(' AND '):''} ORDER BY ${search?'c.name COLLATE NOCASE,c.id':'c.inbox_pinned DESC,c.updated DESC,c.id DESC'} LIMIT ?`;
  args.push(bounded?limit+1:500);return{sql,args,order};
}
const inboxCursorEncode=value=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function inboxCursorDecode(value,filter,q,fail){
  if(typeof value!=='string'||value.length>2048||!/^[A-Za-z0-9_-]+$/.test(value))throw fail(400,'Invalid inbox cursor.');
  let item;try{item=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),char=>char.charCodeAt(0))));}catch{throw fail(400,'Invalid inbox cursor.');}
  if(!item||item.filter!==filter||item.q!==q||item.order!==(q?'name':'activity')||!messagingId(item.id)||!Number.isSafeInteger(item.updated)||![0,1].includes(item.pinned)||typeof item.name!=='string'||item.name.length>60)throw fail(400,'Inbox cursor belongs to a different search.');
  return item;
}
export function messagingFileValid(bytes,mime){
  const text=(a,b)=>String.fromCharCode(...bytes.slice(a,b));
  if(bytes.length<12)return false;
  if(mime==='image/jpeg')return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(mime==='image/png')return [137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n);
  if(mime==='image/webp')return text(0,4)==='RIFF'&&text(8,12)==='WEBP';
  if(mime==='video/mp4'||mime==='audio/mp4')return text(4,8)==='ftyp';
  if(mime==='video/webm'||mime==='audio/webm')return [26,69,223,163].every((n,i)=>bytes[i]===n);
  if(mime==='audio/ogg')return text(0,4)==='OggS';
  if(mime==='audio/wav')return text(0,4)==='RIFF'&&text(8,12)==='WAVE';
  if(mime==='audio/mpeg')return text(0,3)==='ID3'||(bytes[0]===255&&(bytes[1]&224)===224);
  return mime==='application/pdf'&&text(0,5)==='%PDF-';
}
export async function messagingReadUpload(request,limit,fail){
  const length=request.headers.get('Content-Length');if(length&&(!/^\d+$/.test(length)||Number(length)>limit))throw fail(413,'Files must be 20 MB or smaller.');
  const reader=request.body?.getReader();if(!reader)throw fail(400,'Choose a file.');
  let size=0;const chunks=[];for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit){await reader.cancel();throw fail(413,'Files must be 20 MB or smaller.');}chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}return bytes;
}
const messagingColumns="id,role,kind,body,status,created,change_revision AS changeRevision,CASE WHEN role='user' THEN client_id ELSE NULL END AS clientId";
export async function messagingHistory({request,chat,all,fail,options={}}){
  const params=new URL(request.url).searchParams,cutoff=chat.change_revision||0;
  const before=request.method==='GET'?params.get('beforeId'):null,after=request.method==='GET'?params.get('afterRevision'):null;
  const number=(value,minimum)=>{if(!/^\d{1,16}$/.test(value||'')||!Number.isSafeInteger(Number(value))||Number(value)<minimum)throw fail(400,'Invalid history cursor.');return Number(value);};
  if(before!==null&&after!==null)throw fail(400,'Choose one history cursor.');
  if(after!==null){
    const revision=number(after,0);if(revision>cutoff)throw fail(400,'History cursor is ahead of this chat.');
    const rows=await all('SELECT '+messagingColumns+' FROM messages WHERE conversation_id=? AND change_revision>? AND change_revision<=? ORDER BY change_revision,id LIMIT 121',chat.id,revision,cutoff),hasMoreChanges=rows.length>120;
    if(hasMoreChanges)rows.pop();
    return{rows,metadata:{historyComplete:false,changeRevision:hasMoreChanges?rows.at(-1).changeRevision:cutoff,hasMoreChanges}};
  }
  const rows=await all('SELECT '+messagingColumns+' FROM messages WHERE conversation_id=?'+(before!==null?' AND id<?':'')+' ORDER BY id DESC LIMIT 81',chat.id,...(before!==null?[number(before,1)]:[])),hasOlder=rows.length>80;
  if(hasOlder)rows.pop();rows.reverse();
  return{rows,metadata:{historyComplete:false,page:{oldestId:rows[0]?.id||null,hasOlder},changeRevision:cutoff,hasMoreChanges:false}};
}
export async function messagingView({chat,messages,admin,one,all,bounded=false,acknowledgedId=null}){
  // These private reads are independent. Start them together rather than paying
  // a separate D1 round trip for every part of a chat on each refresh.
  const rows=await messages,ack=bounded&&acknowledgedId?await one('SELECT '+messagingColumns+' FROM messages WHERE conversation_id=? AND id=?',chat.id,acknowledgedId):null;
  const selected=JSON.stringify([...new Set([...rows.map(row=>row.id),...(ack?[ack.id]:[])])]),restriction=bounded?' AND m.id IN (SELECT value FROM json_each(?))':'',selectedArgs=bounded?[selected]:[];
  const [settingsRow,details,stars,reactions]=await Promise.all([
    one('SELECT * FROM chat_messaging WHERE conversation_id=?',chat.id),
    all('SELECT d.* FROM message_messaging d JOIN messages m ON m.id=d.message_id WHERE m.conversation_id=?'+restriction,chat.id,...selectedArgs),
    all('SELECT s.message_id FROM message_stars s JOIN messages m ON m.id=s.message_id WHERE m.conversation_id=? AND s.side=?'+restriction,chat.id,admin?'owner':'customer',...selectedArgs),
    all('SELECT r.message_id,r.side,r.emoji FROM message_reactions r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=?'+restriction,chat.id,...selectedArgs),
  ]);
  const settings=settingsRow||{},byId=new Map(details.map(d=>[d.message_id,d])),starred=new Set(stars.map(s=>s.message_id)),byReaction=new Map(),now=Date.now();
  for(const reaction of reactions){let items=byReaction.get(reaction.message_id);if(!items)byReaction.set(reaction.message_id,items=[]);items.push({emoji:reaction.emoji,by:reaction.side});}
  const decorate=m=>{const d=byId.get(m.id)||{};return{...m,body:d.deleted?'':m.body,replyTo:d.reply_to??null,edited:d.edited??null,deleted:!!d.deleted,starred:starred.has(m.id),reactions:d.deleted?[]:byReaction.get(m.id)||[],readByOther:m.role==='user'?m.id<=(settings.owner_read||0):m.role==='assistant'?m.id<=(settings.customer_read||0):false};};
  return {messages:rows.map(decorate),...(ack?{acknowledgedMessage:decorate(ack)}:{}),...(bounded?{receiptCursors:{ownerRead:settings.owner_read||0,customerRead:settings.customer_read||0}}:{}),typing:{customer:(settings.customer_typing||0)>now,owner:(settings.owner_typing||0)>now},blocked:!!settings.blocked,...(admin?{pinned:!!settings.pinned,archived:!!settings.archived,labels:JSON.parse(settings.labels||'[]'),notes:settings.notes||''}:{})};
}
export async function messagingAcknowledgment({chat,acknowledgedId,one}){
  // Send acknowledgments need only the saved row, not another history page.
  // Read current decoration as well: a replay may follow an edit, deletion,
  // reaction or owner read. The indexed subqueries stay scoped to this row.
  const row=await one(`SELECT m.id,m.role,m.kind,m.body,m.status,m.created,m.change_revision AS changeRevision,m.client_id AS clientId,
    d.reply_to AS replyTo,d.edited,d.deleted,COALESCE(s.owner_read,0) AS ownerRead,COALESCE(s.customer_read,0) AS customerRead,
    COALESCE(s.customer_typing,0) AS customerTyping,COALESCE(s.owner_typing,0) AS ownerTyping,COALESCE(s.blocked,0) AS blocked,
    EXISTS(SELECT 1 FROM message_stars WHERE message_id=m.id AND side='customer') AS starred,
    (SELECT json_group_array(json_object('emoji',emoji,'by',side)) FROM message_reactions WHERE message_id=m.id) AS reactions
    FROM messages m LEFT JOIN message_messaging d ON d.message_id=m.id LEFT JOIN chat_messaging s ON s.conversation_id=m.conversation_id
    WHERE m.conversation_id=? AND m.id=? AND m.role='user'`,chat.id,acknowledgedId);
  if(!row)return null;
  const {ownerRead,customerRead,customerTyping,ownerTyping,blocked,...message}=row,now=Date.now();
  return{acknowledgedMessage:{...message,body:message.deleted?'':message.body,deleted:!!message.deleted,starred:!!message.starred,reactions:message.deleted?[]:JSON.parse(message.reactions||'[]'),readByOther:message.id<=ownerRead},receiptCursors:{ownerRead,customerRead},typing:{customer:customerTyping>now,owner:ownerTyping>now},blocked:!!blocked};
}
export async function messagingDeleteAttachments({env,all,chatId}){
  const files=await all('SELECT object_key FROM chat_attachments WHERE conversation_id=?',chatId);
  for(const file of files)await env.MEDIA.delete(file.object_key);
}
export async function messagingAttachmentResponse({request,env,route,one,owner,customer,fail}){
  const match=route.match(/^\/api\/attachments\/([a-f0-9-]{36})$/);if(!match||!['GET','HEAD'].includes(request.method))throw fail(404,'Not found.');
  let isOwner=false;try{await owner();isOwner=true;}catch(error){if(error.status!==401)throw error;}
  const file=await one('SELECT * FROM chat_attachments WHERE id=? AND ready=1',match[1]);
  if(!isOwner){const chat=await customer();if(!file||file.conversation_id!==chat.id)throw fail(404,'Attachment not found.');}
  if(!file)throw fail(404,'Attachment not found.');
  const rangeHeader=request.headers.get('Range');let range;
  if(rangeHeader){const r=/^bytes=(\d*)-(\d*)$/.exec(rangeHeader);if(!r||(!r[1]&&!r[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${file.size}`}});const start=r[1]?Number(r[1]):Math.max(0,file.size-Number(r[2])),end=r[1]&&r[2]?Math.min(Number(r[2]),file.size-1):file.size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=file.size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${file.size}`}});range={offset:start,length:end-start+1};}
  const object=await env.MEDIA.get(file.object_key,range?{range}:undefined);if(!object)throw fail(404,'Attachment not found.');
  const h={'Content-Type':file.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Content-Length':String(range?.length??file.size),'Content-Security-Policy':"default-src 'none'; sandbox",'Cross-Origin-Resource-Policy':'same-origin'};
  if(file.mime==='application/pdf')h['Content-Disposition']=`attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(file.title)}`;
  if(range)h['Content-Range']=`bytes ${range.offset}-${range.offset+range.length-1}/${file.size}`;
  return new Response(request.method==='HEAD'?null:object.body,{status:range?206:200,headers:h});
}
export async function messagingRoutes(ctx){
  const {request,env,route,method,stmt,one,all,result,body,get,view,acknowledge,pending,generate,scheduleChatWork,customer,owner,fail,rate,onCustomerMessage,isGuided}=ctx;
  const schedule=scheduleChatWork||generate;
  const compactAck=request.headers.get('X-Rekha-Ack')==='compact-v1'&&typeof acknowledge==='function';
  const savedView=async(chatId,messageId)=>{const current=await get(chatId);return compactAck?acknowledge(current,messageId):view(current,false,{acknowledgedId:messageId});};
  const appChat=ctx.appSettings?.chat||{},freeTurns=ctx.appSettings?.service?.freeReplies??3,unlockPrice=ctx.appSettings?.service?.unlockPriceRupees??49;
  const quotaEnabled=ctx.automationEnabled!==false;
  const customerMayWrite=()=>{if(appChat.customerMessagingEnabled===false)throw fail(403,'Customer messages are currently paused.');};
  const ensure=chatId=>stmt('INSERT OR IGNORE INTO chat_messaging(conversation_id) VALUES(?)',chatId).run();
  const settings=async chatId=>await one('SELECT * FROM chat_messaging WHERE conversation_id=?',chatId)||{};
  const attachmentItem=m=>({id:m.id,title:m.title,type:m.type,url:`/api/attachments/${m.id}`,mime:m.mime,size:m.size});
  async function attachments(ids,chatId){if(!Array.isArray(ids)||ids.length>10||new Set(ids).size!==ids.length||!ids.every(messagingId))throw fail(400,'Choose up to 10 different attachments.');if(!ids.length)return[];const available=await all('SELECT * FROM chat_attachments WHERE conversation_id=? AND ready=1 AND id IN (SELECT value FROM json_each(?))',chatId,JSON.stringify(ids)),byId=new Map(available.map(file=>[file.id,file])),files=ids.map(id=>byId.get(id));if(files.some(f=>!f))throw fail(404,'Attachment not found.');return files.map(attachmentItem);}
  async function quote(id,chatId){if(id==null)return null;if(!Number.isSafeInteger(id)||id<1||!await one('SELECT m.id FROM messages m LEFT JOIN message_messaging d ON d.message_id=m.id WHERE m.id=? AND m.conversation_id=? AND d.deleted IS NULL',id,chatId))throw fail(400,'The quoted message is unavailable.');return id;}
  if(route.startsWith('/api/attachments/'))return messagingAttachmentResponse(ctx);
  if(route==='/api/uploads'&&method==='POST'){
    const chat=await customer();customerMayWrite();if(appChat.attachmentsEnabled===false)throw fail(403,'Customer attachments are currently unavailable.');if((await settings(chat.id)).blocked)throw fail(403,'Messages to this chat are paused.');await rate('upload:'+chat.id,8,60000);
    if(quotaEnabled&&chat.entitlement==='free'&&chat.free_used>=freeTurns+(chat.rewards||0)&&!await isGuided?.(chat.id))throw fail(402,`Unlock continued chat for ₹${unlockPrice}.`);
    if(!env.MEDIA)throw fail(503,'Media storage is unavailable.');
    const mime=request.headers.get('Content-Type')?.split(';')[0].trim();if(!messagingMimes.has(mime))throw fail(415,'Choose an image, video, audio file or PDF.');
    if(mime.startsWith('audio/')&&appChat.voiceNotesEnabled===false)throw fail(403,'Customer voice notes are currently unavailable.');
    const bytes=await messagingReadUpload(request,20*1024*1024,fail);if(!messagingFileValid(bytes,mime))throw fail(400,'File contents do not match its format.');
    const id=crypto.randomUUID(),objectKey='chat-attachments/'+id,title=messagingSafeName(new URL(request.url).searchParams.get('name')),type=mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':'document';
    const reserved=await stmt('INSERT INTO chat_attachments(id,conversation_id,title,type,object_key,mime,size,created) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM chat_attachments WHERE conversation_id=?)<80 AND (SELECT COALESCE(SUM(size),0) FROM chat_attachments WHERE conversation_id=?)+?<=209715200 AND (SELECT bytes FROM attachment_storage_stats WHERE id=1)+?<=1073741824',id,chat.id,title,type,objectKey,mime,bytes.length,Date.now(),chat.id,chat.id,bytes.length,bytes.length).run();
    if(!reserved.meta.changes)throw fail(409,'Attachment storage for this chat is full.');
    try{await env.MEDIA.put(objectKey,bytes,{httpMetadata:{contentType:mime}});await stmt('UPDATE chat_attachments SET ready=1 WHERE id=?',id).run();}catch(error){await env.MEDIA.delete(objectKey);await stmt('DELETE FROM chat_attachments WHERE id=?',id).run();throw error;}
    return result(attachmentItem(await one('SELECT * FROM chat_attachments WHERE id=?',id)),201);
  }
  if(route==='/api/messages'&&method==='POST'){
    const chat=await customer(),data=await body();
    if(!messagingClient(data.clientId)||typeof data.body!=='string'||data.body.length>2000)throw fail(400,'Write a message of up to 2,000 characters.');
    const existingMessage=await one('SELECT * FROM messages WHERE conversation_id=? AND client_id=?',chat.id,data.clientId);
    if(existingMessage){try{await onCustomerMessage?.(await get(chat.id),existingMessage);}catch{}await schedule(chat.id);return result(await savedView(chat.id,existingMessage.id));}
    customerMayWrite();const guided=!!await isGuided?.(chat.id);await rate('chat:'+chat.id,guided?60:48);
    if(data.mediaIds?.length&&appChat.attachmentsEnabled===false)throw fail(403,'Customer attachments are currently unavailable.');
    const selected=await attachments(data.mediaIds||[],chat.id);
    if(selected.some(item=>item.type==='audio')&&appChat.voiceNotesEnabled===false)throw fail(403,'Customer voice notes are currently unavailable.');
    if((await settings(chat.id)).blocked)throw fail(403,'Messages to this chat are paused.');
    if(quotaEnabled&&chat.entitlement==='free'&&chat.free_used>=freeTurns+(chat.rewards||0)&&!guided)throw fail(402,`Unlock continued chat for ₹${unlockPrice}.`);
    const replyTo=await quote(data.replyTo,chat.id);
    if(!data.body.trim()&&!selected.length)throw fail(400,'Write a message or attach a file.');
    const payload=selected.length?JSON.stringify({text:data.body.trim(),title:'',items:selected}):data.body.trim(),kind=selected.length?'media':'customer',now=Date.now();
    const batch=await env.DB.batch([
      stmt("INSERT OR IGNORE INTO messages(conversation_id,role,kind,body,status,client_id,created) SELECT ?,'user',?,?,'pending',?,? WHERE EXISTS(SELECT 1 FROM conversations WHERE id=? AND (?=0 OR entitlement!='free' OR free_used<?+(SELECT COUNT(*) FROM reward_grants WHERE conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM chat_workflow WHERE conversation_id=conversations.id))) AND NOT EXISTS(SELECT 1 FROM chat_messaging WHERE conversation_id=? AND blocked=1)",chat.id,kind,payload,data.clientId,now,chat.id,quotaEnabled?1:0,freeTurns,chat.id),
      stmt('UPDATE conversations SET version=version+1,updated=? WHERE id=? AND changes()=1',now,chat.id),
      stmt('INSERT INTO chat_messaging(conversation_id,archived,customer_typing) SELECT ?,0,0 WHERE changes()=1 ON CONFLICT(conversation_id) DO UPDATE SET archived=0,customer_typing=0',chat.id),
      stmt('DELETE FROM drafts WHERE conversation_id=? AND changes()=1',chat.id),
      stmt('INSERT OR IGNORE INTO message_messaging(message_id,reply_to) SELECT id,? FROM messages WHERE conversation_id=? AND client_id=?',replyTo,chat.id,data.clientId),
    ]);
    const saved=await one('SELECT * FROM messages WHERE conversation_id=? AND client_id=?',chat.id,data.clientId);
    if(!saved)throw fail(409,'The chat changed. Please refresh.');
    // A stored message is acknowledged even if subsequent scheduling is interrupted.
    // The pending row and missing workflow event are recovered by polls and cron.
    try{await onCustomerMessage?.(await get(chat.id),saved);}catch{}
    await schedule(chat.id);return result(await savedView(chat.id,saved.id),batch[0].meta.changes?202:200);
  }
  const ownerPath=route.match(/^\/api\/admin\/conversations\/([a-f0-9-]{36})\/(settings|read|typing|send)$/),customerPath=route.match(/^\/api\/chat\/(read|typing)$/);
  if(ownerPath||customerPath){
    const isOwner=!!ownerPath;if(isOwner)await owner();const chat=isOwner?await get(ownerPath[1]):await customer();if(!chat)throw fail(404,'Conversation not found.');const action=isOwner?ownerPath[2]:customerPath[1];
    if((action==='settings'&&method!=='PATCH')||(action!=='settings'&&method!=='POST'))throw fail(405,'Method not allowed.');
    const data=await body();await ensure(chat.id);
    if(action==='settings'){
      const current=await settings(chat.id),changes={...current};
      for(const field of ['pinned','archived','blocked'])if(field in data){if(typeof data[field]!=='boolean')throw fail(400,'Invalid chat setting.');changes[field]=data[field]?1:0;}
      if('notes' in data){if(typeof data.notes!=='string'||data.notes.length>4000)throw fail(400,'Notes must be 4,000 characters or less.');changes.notes=data.notes;}
      if('labels' in data){if(!Array.isArray(data.labels)||data.labels.length>8||data.labels.some(s=>typeof s!=='string'||!s.trim()||s.length>30))throw fail(400,'Choose up to eight labels of 30 characters.');changes.labels=JSON.stringify([...new Set(data.labels.map(s=>s.trim()))]);}
      await env.DB.batch([
        stmt('UPDATE conversations SET version=version+1,updated=? WHERE id=? AND EXISTS(SELECT 1 FROM chat_messaging WHERE conversation_id=? AND blocked!=?)',Date.now(),chat.id,chat.id,changes.blocked),
        stmt('DELETE FROM drafts WHERE conversation_id=? AND changes()=1',chat.id),
        stmt('UPDATE chat_messaging SET pinned=?,archived=?,blocked=?,labels=?,notes=?,owner_typing=CASE WHEN ?=1 THEN 0 ELSE owner_typing END,customer_typing=CASE WHEN ?=1 THEN 0 ELSE customer_typing END WHERE conversation_id=?',changes.pinned,changes.archived,changes.blocked,changes.labels,changes.notes,changes.blocked,changes.blocked,chat.id),
      ]);
      return result(await view(await get(chat.id),true));
    }
    if(action==='read'){
      if(!Number.isSafeInteger(data.lastId)||data.lastId<0)throw fail(400,'Invalid read position.');
      const latest=await one('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE conversation_id=?',chat.id),read=Math.min(data.lastId,latest.id);
      await stmt(`UPDATE chat_messaging SET ${isOwner?'owner_read':'customer_read'}=MAX(${isOwner?'owner_read':'customer_read'},?) WHERE conversation_id=?`,read,chat.id).run();return result({ok:true});
    }
    if(action==='typing'){
      if(typeof data.active!=='boolean')throw fail(400,'Invalid typing state.');if(!isOwner&&(await settings(chat.id)).blocked)throw fail(403,'Messages to this chat are paused.');await rate('typing:'+(isOwner?'owner:':'customer:')+chat.id,40);
      await stmt(`UPDATE chat_messaging SET ${isOwner?'owner_typing':'customer_typing'}=? WHERE conversation_id=?`,data.active?Date.now()+8000:0,chat.id).run();return result({ok:true});
    }
    return messagingOwnerSend({...ctx,chat,data,attachments,quote,settings});
  }
  const messagePath=route.match(/^\/api\/messages\/(\d+)(?:\/(star|reaction))?$/),adminMessagePath=route.match(/^\/api\/admin\/conversations\/([a-f0-9-]{36})\/messages\/(\d+)(?:\/(star|reaction))?$/);
  if(messagePath||adminMessagePath){
    const isOwner=!!adminMessagePath;if(isOwner)await owner();const chat=isOwner?await get(adminMessagePath[1]):await customer();if(!chat)throw fail(404,'Conversation not found.');
    const id=Number(isOwner?adminMessagePath[2]:messagePath[1]),action=isOwner?adminMessagePath[3]:messagePath[2],side=isOwner?'owner':'customer',message=await one('SELECT m.*,d.deleted FROM messages m LEFT JOIN message_messaging d ON d.message_id=m.id WHERE m.id=? AND m.conversation_id=?',id,chat.id);
    if(!message)throw fail(404,'Message not found.');
    if(action==='star'&&method==='PUT'){const data=await body();if(typeof data.starred!=='boolean')throw fail(400,'Invalid star setting.');if(data.starred)await stmt('INSERT OR IGNORE INTO message_stars(message_id,side) VALUES(?,?)',id,side).run();else await stmt('DELETE FROM message_stars WHERE message_id=? AND side=?',id,side).run();}
    else if(action==='reaction'&&method==='PUT'){const data=await body();if(message.deleted)throw fail(409,'This message was deleted.');if(typeof data.emoji!=='string'||(data.emoji!==''&&!messagingEmoji.has(data.emoji)))throw fail(400,'Choose a supported reaction.');if(data.emoji)await stmt('INSERT INTO message_reactions(message_id,side,emoji) VALUES(?,?,?) ON CONFLICT(message_id,side) DO UPDATE SET emoji=excluded.emoji',id,side,data.emoji).run();else await stmt('DELETE FROM message_reactions WHERE message_id=? AND side=?',id,side).run();}
    else if(!action&&(method==='PATCH'||method==='DELETE')){
      if(!isOwner&&method==='PATCH')customerMayWrite();
      if(message.role!==(isOwner?'assistant':'user')||['welcome'].includes(message.kind))throw fail(403,'You can change only your own messages.');
      if(message.deleted)throw fail(409,'This message was already deleted.');
      if(Date.now()-message.created>(method==='PATCH'?15*60000:24*3600000))throw fail(409,method==='PATCH'?'Messages can be edited for 15 minutes.':'Messages can be deleted for 24 hours.');
      const data=method==='PATCH'?await body():{};
      if(method==='PATCH'&&(message.kind==='media'||typeof data.body!=='string'||!data.body.trim()||data.body.length>(isOwner?4000:2000)))throw fail(400,'Only text messages can be edited.');
      await env.DB.batch([stmt('INSERT OR IGNORE INTO message_messaging(message_id) VALUES(?)',id),stmt(`UPDATE message_messaging SET ${method==='PATCH'?'edited':'deleted'}=? WHERE message_id=?`,Date.now(),id),stmt(method==='PATCH'?'UPDATE messages SET body=? WHERE id=?':"UPDATE messages SET body=?,status=CASE WHEN role='user' THEN 'deleted' ELSE status END WHERE id=?",method==='PATCH'?data.body.trim():'',id),stmt('UPDATE conversations SET version=version+1,updated=? WHERE id=?',Date.now(),chat.id),stmt('DELETE FROM drafts WHERE conversation_id=?',chat.id),...(method==='DELETE'?[stmt('DELETE FROM message_reactions WHERE message_id=?',id)]:[])]);
      if(!isOwner&&method==='PATCH'&&message.status==='pending')await schedule(chat.id);
    }else throw fail(405,'Method not allowed.');
    if(action==='star'||action==='reaction')await stmt('UPDATE conversations SET version=version+1,updated=? WHERE id=?',Date.now(),chat.id).run();
    return result(await view(await get(chat.id),isOwner));
  }
  if(route==='/api/admin/conversations'&&method==='GET'){
    await owner();const bounded=request.headers.get('X-Rekha-History')==='bounded-v1',params=new URL(request.url).searchParams,q=(params.get('q')||'').trim(),filter=params.get('filter')||'all',limit=Number(params.get('limit')||80);
    if(bounded&&(!inboxFilters.has(filter)||q.length>100||!Number.isSafeInteger(limit)||limit<1||limit>100))throw fail(400,'Invalid inbox search.');
    const cursor=bounded&&params.has('cursor')?inboxCursorDecode(params.get('cursor'),filter,q,fail):null,query=messagingInboxQuery({filter,q:bounded?q:'',cursor,limit,bounded}),list=await all(query.sql,...query.args),hasMore=bounded&&list.length>limit;
    if(hasMore)list.pop();const items=list.map(c=>({...c,pinned:!!c.pinned,archived:!!c.archived,blocked:!!c.blocked,labels:JSON.parse(c.labels)})),last=list.at(-1);
    return result(bounded?{items,hasMore,nextCursor:hasMore?inboxCursorEncode({filter,q,order:query.order,id:last.id,name:last.name,updated:last.updated,pinned:last.pinned}):null}:items);
  }
  const quick=route.match(/^\/api\/admin\/quick-replies(?:\/([a-f0-9-]{36}))?$/);
  if(quick){
    await owner();if(method==='GET'&&!quick[1])return result(await all('SELECT * FROM saved_replies ORDER BY updated DESC LIMIT 100'));
    if(method==='DELETE'&&quick[1]){await stmt('DELETE FROM saved_replies WHERE id=?',quick[1]).run();return result({ok:true});}
    if((method==='POST'&&!quick[1])||(method==='PATCH'&&quick[1])){const data=await body();if(typeof data.title!=='string'||!data.title.trim()||data.title.length>80||typeof data.body!=='string'||!data.body.trim()||data.body.length>4000)throw fail(400,'Enter a title and reply of up to 4,000 characters.');const id=quick[1]||crypto.randomUUID(),now=Date.now();if(quick[1]){if(!await one('SELECT id FROM saved_replies WHERE id=?',id))throw fail(404,'Quick reply not found.');await stmt('UPDATE saved_replies SET title=?,body=?,updated=? WHERE id=?',data.title.trim(),data.body.trim(),now,id).run();}else{const inserted=await stmt('INSERT INTO saved_replies(id,title,body,created,updated) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM saved_replies)<100',id,data.title.trim(),data.body.trim(),now,now).run();if(!inserted.meta.changes)throw fail(409,'Save up to 100 quick replies.');}return result(await one('SELECT * FROM saved_replies WHERE id=?',id),quick[1]?200:201);}throw fail(405,'Method not allowed.');
  }
  return null;
}
async function messagingOwnerSend(ctx){
  const {env,chat,data,stmt,one,all,get,view,result,pending,fail,attachments,quote}=ctx;
  if(!messagingClient(data.clientId))throw fail(400,'A unique send ID is required.');const clientId='owner:'+data.clientId;
  if(await one('SELECT id FROM messages WHERE conversation_id=? AND client_id=?',chat.id,clientId))return result(await view(await get(chat.id),true));
  if(data.version!==chat.version)throw fail(409,'The chat changed. Review it and send again.');if(typeof data.body!=='string'||data.body.length>4000)throw fail(400,'Message text must be 4,000 characters or less.');
  if('answersPending' in data&&typeof data.answersPending!=='boolean')throw fail(400,'Invalid reply setting.');
  const selected=await attachments(data.mediaIds||[],chat.id);let title='',library=[];
  if(data.collectionId){const collection=await one('SELECT * FROM media_collections WHERE id=?',data.collectionId);if(!collection)throw fail(404,'Collection not found.');data.itemIds=JSON.parse(collection.item_ids);title=collection.title;}
  if(data.itemIds?.length){if(!Array.isArray(data.itemIds)||data.itemIds.length>20||new Set(data.itemIds).size!==data.itemIds.length||!data.itemIds.every(messagingId))throw fail(400,'Choose up to 20 different media items.');const available=await all('SELECT * FROM media_items WHERE archived=0 AND id IN (SELECT value FROM json_each(?))',JSON.stringify(data.itemIds)),byId=new Map(available.map(item=>[item.id,item]));library=data.itemIds.map(id=>byId.get(id));if(library.some(f=>!f))throw fail(409,'A selected item is unavailable.');selected.push(...library.map(m=>({id:m.id,title:m.title,type:m.type,url:m.object_key?'/api/media/'+m.id:m.url,mime:m.mime,size:m.size})));}
  if(!data.body.trim()&&!selected.length)throw fail(400,'Write a message or attach media.');
  const replyTo=await quote(data.replyTo,chat.id),waiting=await pending(chat.id),answers=data.answersPending===true||(!('answersPending' in data)&&replyTo!==null&&waiting?.id===replyTo),answerId=answers?waiting?.id:null;
  const kind=selected.length?'media':answerId!=null?'human':'owner-message',payload=selected.length?JSON.stringify({text:data.body.trim(),title,items:selected}):data.body.trim(),now=Date.now();
  // Version advances only at the end of this atomic batch. A losing duplicate
  // cannot answer different questions, clear a newer draft or grant other media.
  const guard='EXISTS(SELECT 1 FROM conversations WHERE id=? AND version=?) AND EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND client_id=? AND body=? AND kind=?)',guardArgs=[chat.id,data.version,chat.id,clientId,payload,kind];
  const inserted=await env.DB.batch([
    stmt("INSERT OR IGNORE INTO messages(conversation_id,role,kind,body,status,client_id,created) SELECT ?,'assistant',?,?,'sent',?,? WHERE EXISTS(SELECT 1 FROM conversations WHERE id=? AND version=?)",chat.id,kind,payload,clientId,now,chat.id,data.version),
    stmt('INSERT OR IGNORE INTO message_messaging(message_id,reply_to) SELECT id,? FROM messages WHERE conversation_id=? AND client_id=? AND '+guard,replyTo,chat.id,clientId,...guardArgs),
    stmt("UPDATE messages SET status='answered' WHERE conversation_id=? AND role='user' AND id<=? AND status IN ('pending','failed') AND "+guard,chat.id,answerId??-1,...guardArgs),
    stmt('DELETE FROM drafts WHERE conversation_id=? AND '+guard,chat.id,...guardArgs),
    ...(library.length?[stmt('INSERT OR IGNORE INTO media_grants(conversation_id,media_id) SELECT ?,value FROM json_each(?) WHERE '+guard,chat.id,JSON.stringify(library.map(item=>item.id)),...guardArgs)]:[]),
    stmt("UPDATE conversations SET free_used=(SELECT COUNT(*) FROM messages WHERE conversation_id=? AND role='assistant' AND kind NOT IN ('welcome','owner-message','media')) WHERE id=? AND "+guard,chat.id,chat.id,...guardArgs),
    stmt('UPDATE chat_messaging SET owner_typing=0 WHERE conversation_id=? AND '+guard,chat.id,...guardArgs),
    stmt("UPDATE conversations SET mode=CASE WHEN mode='ai' THEN 'manual' ELSE mode END,version=version+1,updated=? WHERE id=? AND "+guard,now,chat.id,...guardArgs),
  ]);
  if(!inserted[0].meta.changes){if(await one('SELECT id FROM messages WHERE conversation_id=? AND client_id=?',chat.id,clientId))return result(await view(await get(chat.id),true));throw fail(409,'The chat changed. Review it and send again.');}return result(await view(await get(chat.id),true),201);
}
