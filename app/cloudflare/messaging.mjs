// Additive private messaging data. Every action resolves its authenticated chat first.
const messagingEmoji=new Set(['👍','❤️','😂','😮','😢','🙏']);
const messagingMimes=new Set(['image/jpeg','image/png','image/webp','video/mp4','video/webm','audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/wav','application/pdf']);
const messagingId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const messagingClient=value=>typeof value==='string'&&/^[\w-]{16,80}$/.test(value);
const messagingSafeName=value=>(typeof value==='string'?value:'Attachment').replace(/[\x00-\x1f\x7f/\\]/g,' ').trim().slice(0,120)||'Attachment';
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
export async function messagingView({chat,messages,admin,one,all}){
  // These private reads are independent. Start them together rather than paying
  // a separate D1 round trip for every part of a chat on each refresh.
  const [settingsRow,details,stars,reactions,rows]=await Promise.all([
    one('SELECT * FROM chat_messaging WHERE conversation_id=?',chat.id),
    all('SELECT d.* FROM message_messaging d JOIN messages m ON m.id=d.message_id WHERE m.conversation_id=?',chat.id),
    all('SELECT s.message_id FROM message_stars s JOIN messages m ON m.id=s.message_id WHERE m.conversation_id=? AND s.side=?',chat.id,admin?'owner':'customer'),
    all('SELECT r.message_id,r.side,r.emoji FROM message_reactions r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=?',chat.id),
    messages,
  ]);
  const settings=settingsRow||{},byId=new Map(details.map(d=>[d.message_id,d])),starred=new Set(stars.map(s=>s.message_id)),byReaction=new Map(),now=Date.now();
  for(const reaction of reactions){let items=byReaction.get(reaction.message_id);if(!items)byReaction.set(reaction.message_id,items=[]);items.push({emoji:reaction.emoji,by:reaction.side});}
  return {messages:rows.map(m=>{const d=byId.get(m.id)||{};return{...m,body:d.deleted?'':m.body,replyTo:d.reply_to??null,edited:d.edited??null,deleted:!!d.deleted,starred:starred.has(m.id),reactions:d.deleted?[]:byReaction.get(m.id)||[],readByOther:m.role==='user'?m.id<=(settings.owner_read||0):m.role==='assistant'?m.id<=(settings.customer_read||0):false};}),typing:{customer:(settings.customer_typing||0)>now,owner:(settings.owner_typing||0)>now},blocked:!!settings.blocked,...(admin?{pinned:!!settings.pinned,archived:!!settings.archived,labels:JSON.parse(settings.labels||'[]'),notes:settings.notes||''}:{})};
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
  const {request,env,route,method,stmt,one,all,result,body,get,view,pending,generate,scheduleChatWork,customer,owner,fail,rate,onCustomerMessage,isGuided}=ctx;
  const schedule=scheduleChatWork||generate;
  const appChat=ctx.appSettings?.chat||{},freeTurns=ctx.appSettings?.service?.freeReplies??3,unlockPrice=ctx.appSettings?.service?.unlockPriceRupees??49;
  const customerMayWrite=()=>{if(appChat.customerMessagingEnabled===false)throw fail(403,'Customer messages are currently paused.');};
  const ensure=chatId=>stmt('INSERT OR IGNORE INTO chat_messaging(conversation_id) VALUES(?)',chatId).run();
  const settings=async chatId=>await one('SELECT * FROM chat_messaging WHERE conversation_id=?',chatId)||{};
  const attachmentItem=m=>({id:m.id,title:m.title,type:m.type,url:`/api/attachments/${m.id}`,mime:m.mime,size:m.size});
  async function attachments(ids,chatId){if(!Array.isArray(ids)||ids.length>10||new Set(ids).size!==ids.length||!ids.every(messagingId))throw fail(400,'Choose up to 10 different attachments.');const files=await Promise.all(ids.map(id=>one('SELECT * FROM chat_attachments WHERE id=? AND conversation_id=? AND ready=1',id,chatId)));if(files.some(f=>!f))throw fail(404,'Attachment not found.');return files.map(attachmentItem);}
  async function quote(id,chatId){if(id==null)return null;if(!Number.isSafeInteger(id)||id<1||!await one('SELECT m.id FROM messages m LEFT JOIN message_messaging d ON d.message_id=m.id WHERE m.id=? AND m.conversation_id=? AND d.deleted IS NULL',id,chatId))throw fail(400,'The quoted message is unavailable.');return id;}
  if(route.startsWith('/api/attachments/'))return messagingAttachmentResponse(ctx);
  if(route==='/api/uploads'&&method==='POST'){
    const chat=await customer();customerMayWrite();if(appChat.attachmentsEnabled===false)throw fail(403,'Customer attachments are currently unavailable.');if((await settings(chat.id)).blocked)throw fail(403,'Messages to this chat are paused.');await rate('upload:'+chat.id,8,60000);
    if(chat.entitlement==='free'&&chat.free_used>=freeTurns+(chat.rewards||0)&&!await isGuided?.(chat.id))throw fail(402,`Unlock continued chat for ₹${unlockPrice}.`);
    if(!env.MEDIA)throw fail(503,'Media storage is unavailable.');
    const mime=request.headers.get('Content-Type')?.split(';')[0].trim();if(!messagingMimes.has(mime))throw fail(415,'Choose an image, video, audio file or PDF.');
    if(mime.startsWith('audio/')&&appChat.voiceNotesEnabled===false)throw fail(403,'Customer voice notes are currently unavailable.');
    const bytes=await messagingReadUpload(request,20*1024*1024,fail);if(!messagingFileValid(bytes,mime))throw fail(400,'File contents do not match its format.');
    const id=crypto.randomUUID(),objectKey='chat-attachments/'+id,title=messagingSafeName(new URL(request.url).searchParams.get('name')),type=mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':'document';
    const reserved=await stmt('INSERT INTO chat_attachments(id,conversation_id,title,type,object_key,mime,size,created) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM chat_attachments WHERE conversation_id=?)<80 AND (SELECT COALESCE(SUM(size),0) FROM chat_attachments WHERE conversation_id=?)+?<=209715200 AND (SELECT COALESCE(SUM(size),0) FROM chat_attachments)+?<=1073741824',id,chat.id,title,type,objectKey,mime,bytes.length,Date.now(),chat.id,chat.id,bytes.length,bytes.length).run();
    if(!reserved.meta.changes)throw fail(409,'Attachment storage for this chat is full.');
    try{await env.MEDIA.put(objectKey,bytes,{httpMetadata:{contentType:mime}});await stmt('UPDATE chat_attachments SET ready=1 WHERE id=?',id).run();}catch(error){await env.MEDIA.delete(objectKey);await stmt('DELETE FROM chat_attachments WHERE id=?',id).run();throw error;}
    return result(attachmentItem(await one('SELECT * FROM chat_attachments WHERE id=?',id)),201);
  }
  if(route==='/api/messages'&&method==='POST'){
    const chat=await customer(),data=await body();
    if(!messagingClient(data.clientId)||typeof data.body!=='string'||data.body.length>2000)throw fail(400,'Write a message of up to 2,000 characters.');
    const existingMessage=await one('SELECT * FROM messages WHERE conversation_id=? AND client_id=?',chat.id,data.clientId);
    if(existingMessage){try{await onCustomerMessage?.(await get(chat.id),existingMessage);}catch{}await schedule(chat.id);return result(await view(await get(chat.id)));}
    customerMayWrite();const guided=!!await isGuided?.(chat.id);await rate('chat:'+chat.id,guided?60:48);
    if(data.mediaIds?.length&&appChat.attachmentsEnabled===false)throw fail(403,'Customer attachments are currently unavailable.');
    const selected=await attachments(data.mediaIds||[],chat.id);
    if(selected.some(item=>item.type==='audio')&&appChat.voiceNotesEnabled===false)throw fail(403,'Customer voice notes are currently unavailable.');
    if((await settings(chat.id)).blocked)throw fail(403,'Messages to this chat are paused.');
    if(chat.entitlement==='free'&&chat.free_used>=freeTurns+(chat.rewards||0)&&!guided)throw fail(402,`Unlock continued chat for ₹${unlockPrice}.`);
    const replyTo=await quote(data.replyTo,chat.id);
    if(!data.body.trim()&&!selected.length)throw fail(400,'Write a message or attach a file.');
    const payload=selected.length?JSON.stringify({text:data.body.trim(),title:'',items:selected}):data.body.trim(),kind=selected.length?'media':'customer',now=Date.now();
    const batch=await env.DB.batch([
      stmt("INSERT OR IGNORE INTO messages(conversation_id,role,kind,body,status,client_id,created) SELECT ?,'user',?,?,'pending',?,? WHERE EXISTS(SELECT 1 FROM conversations WHERE id=? AND (entitlement!='free' OR free_used<?+(SELECT COUNT(*) FROM reward_grants WHERE conversation_id=conversations.id) OR EXISTS(SELECT 1 FROM chat_workflow WHERE conversation_id=conversations.id))) AND NOT EXISTS(SELECT 1 FROM chat_messaging WHERE conversation_id=? AND blocked=1)",chat.id,kind,payload,data.clientId,now,chat.id,freeTurns,chat.id),
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
    await schedule(chat.id);return result(await view(await get(chat.id)),batch[0].meta.changes?202:200);
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
    await owner();const list=await all(`SELECT c.id,c.name,c.language,c.mode,c.entitlement,c.updated,c.free_used,COALESCE(s.pinned,0) AS pinned,COALESCE(s.archived,0) AS archived,COALESCE(s.blocked,0) AS blocked,COALESCE(s.labels,'[]') AS labels,COALESCE(s.notes,'') AS notes,(SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status IN ('pending','failed')) AS waiting,(SELECT COUNT(*) FROM messages m LEFT JOIN message_messaging d ON d.message_id=m.id WHERE m.conversation_id=c.id AND m.role='user' AND m.id>COALESCE(s.owner_read,0) AND d.deleted IS NULL) AS unread,(SELECT COALESCE(MAX(m.id),0) FROM messages m WHERE m.conversation_id=c.id AND m.role='user') AS latestUserMessageId,(SELECT COALESCE(MAX(m.id),0) FROM messages m WHERE m.conversation_id=c.id) AS latestMessageId FROM conversations c LEFT JOIN chat_messaging s ON s.conversation_id=c.id ORDER BY COALESCE(s.pinned,0) DESC,c.updated DESC LIMIT 500`);
    return result(list.map(c=>({...c,pinned:!!c.pinned,archived:!!c.archived,blocked:!!c.blocked,labels:JSON.parse(c.labels)})));
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
  const {env,chat,data,stmt,one,get,view,result,pending,fail,attachments,quote}=ctx;
  if(!messagingClient(data.clientId))throw fail(400,'A unique send ID is required.');const clientId='owner:'+data.clientId;
  if(await one('SELECT id FROM messages WHERE conversation_id=? AND client_id=?',chat.id,clientId))return result(await view(await get(chat.id),true));
  if(data.version!==chat.version)throw fail(409,'The chat changed. Review it and send again.');if(typeof data.body!=='string'||data.body.length>4000)throw fail(400,'Message text must be 4,000 characters or less.');
  if('answersPending' in data&&typeof data.answersPending!=='boolean')throw fail(400,'Invalid reply setting.');
  const selected=await attachments(data.mediaIds||[],chat.id);let title='',library=[];
  if(data.collectionId){const collection=await one('SELECT * FROM media_collections WHERE id=?',data.collectionId);if(!collection)throw fail(404,'Collection not found.');data.itemIds=JSON.parse(collection.item_ids);title=collection.title;}
  if(data.itemIds?.length){if(!Array.isArray(data.itemIds)||data.itemIds.length>20||new Set(data.itemIds).size!==data.itemIds.length||!data.itemIds.every(messagingId))throw fail(400,'Choose up to 20 different media items.');library=await Promise.all(data.itemIds.map(id=>one('SELECT * FROM media_items WHERE id=? AND archived=0',id)));if(library.some(f=>!f))throw fail(409,'A selected item is unavailable.');selected.push(...library.map(m=>({id:m.id,title:m.title,type:m.type,url:m.object_key?'/api/media/'+m.id:m.url,mime:m.mime,size:m.size})));}
  if(!data.body.trim()&&!selected.length)throw fail(400,'Write a message or attach media.');
  const replyTo=await quote(data.replyTo,chat.id),waiting=await pending(chat.id),answers=data.answersPending===true||(!('answersPending' in data)&&replyTo!==null&&waiting?.id===replyTo),answerId=answers?waiting?.id:null;
  const kind=selected.length?'media':answerId!=null?'human':'owner-message',payload=selected.length?JSON.stringify({text:data.body.trim(),title,items:selected}):data.body.trim(),now=Date.now();
  const inserted=await env.DB.batch([
    stmt("INSERT OR IGNORE INTO messages(conversation_id,role,kind,body,status,client_id,created) SELECT ?,'assistant',?,?,'sent',?,? WHERE EXISTS(SELECT 1 FROM conversations WHERE id=? AND version=?)",chat.id,kind,payload,clientId,now,chat.id,data.version),
    stmt('INSERT OR IGNORE INTO message_messaging(message_id,reply_to) SELECT id,? FROM messages WHERE conversation_id=? AND client_id=?',replyTo,chat.id,clientId),
    stmt("UPDATE conversations SET mode=CASE WHEN mode='ai' THEN 'manual' ELSE mode END,version=version+1,updated=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND client_id=?)",now,chat.id,data.version,chat.id,clientId),
    stmt("UPDATE messages SET status='answered' WHERE conversation_id=? AND role='user' AND id<=? AND status IN ('pending','failed') AND EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND client_id=?)",chat.id,answerId??-1,chat.id,clientId),
    stmt('DELETE FROM drafts WHERE conversation_id=? AND EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND client_id=?)',chat.id,chat.id,clientId),
    ...library.map(m=>stmt('INSERT OR IGNORE INTO media_grants(conversation_id,media_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND client_id=?)',chat.id,m.id,chat.id,clientId)),
    stmt("UPDATE conversations SET free_used=(SELECT COUNT(*) FROM messages WHERE conversation_id=? AND role='assistant' AND kind NOT IN ('welcome','owner-message','media')) WHERE id=?",chat.id,chat.id),
    stmt('UPDATE chat_messaging SET owner_typing=0 WHERE conversation_id=?',chat.id),
  ]);
  if(!inserted[0].meta.changes){if(await one('SELECT id FROM messages WHERE conversation_id=? AND client_id=?',chat.id,clientId))return result(await view(await get(chat.id),true));throw fail(409,'The chat changed. Review it and send again.');}return result(await view(await get(chat.id),true),201);
}
