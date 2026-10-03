// Private media library and owner-initiated messages. R2 objects are never public.
import { messagingFileValid } from './messaging.mjs';
export async function ownerRoutes(ctx) {
  const {request,env,route,method,stmt,one,all,result,body,get,view,pending,fail}=ctx;
  const uuid=()=>crypto.randomUUID();
  const item=id=>one('SELECT * FROM media_items WHERE id=?',id);
  const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
  const title=value=>{if(typeof value!=='string'||!value.trim()||value.length>120)throw fail(400,'Enter a title of 1–120 characters.');return value.trim();};
  const publicItem=m=>({id:m.id,title:m.title,type:m.type,url:m.object_key?`/api/media/${m.id}`:m.url,mime:m.mime,size:m.size});
  async function items(ids){if(!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length||!ids.every(validId))throw fail(400,'Choose 1–20 different media items.');const found=await Promise.all(ids.map(item));if(found.some(m=>!m||m.archived))throw fail(409,'A selected item is unavailable.');return found;}
  if(route==='/api/admin/library'&&method==='GET')return result({items:await all('SELECT id,title,type,category,url,size,archived,created FROM media_items ORDER BY created DESC LIMIT 500'),collections:await all('SELECT * FROM media_collections ORDER BY created DESC LIMIT 200'),uploadLimit:25*1024*1024});
  if(route==='/api/admin/uploads'&&method==='POST'){
    const url=new URL(request.url),name=title(url.searchParams.get('title')),category=url.searchParams.get('category')==='testimonial'?'testimonial':'general';
    const mime=request.headers.get('Content-Type')?.split(';')[0];
    if(!['image/jpeg','image/png','image/webp','video/mp4','video/webm','audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/wav','application/pdf'].includes(mime))throw fail(415,'Upload an image, video, audio file or PDF.');
    if(!env.MEDIA)throw fail(503,'Media storage is not configured.');
    const reader=request.body?.getReader();if(!reader)throw fail(400,'Choose a file.');
    let size=0;const chunks=[],limit=(mime.startsWith('audio/')||mime==='application/pdf'?20:25)*1024*1024;
    for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit){await reader.cancel();throw fail(413,'The file exceeds the upload limit.');}chunks.push(next.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    if(!messagingFileValid(bytes,mime))throw fail(400,'File contents do not match the selected format.');
    const id=uuid(),key=`library/${id}`,now=Date.now();
    const reserved=await stmt("INSERT INTO media_items(id,title,type,category,object_key,mime,size,archived,created) SELECT ?,?,?,?,?,?,?,1,? WHERE (SELECT COUNT(*) FROM media_items)<500 AND (SELECT COALESCE(SUM(size),0) FROM media_items)+?<=536870912",id,name,mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':'document',category,key,mime,size,now,size).run();
    if(!reserved.meta.changes)throw fail(409,'The library has reached its 500 MB / 500 item limit.');
    try{await env.MEDIA.put(key,bytes,{httpMetadata:{contentType:mime}});await stmt('UPDATE media_items SET archived=0 WHERE id=?',id).run();}catch(error){await env.MEDIA.delete(key);await stmt('DELETE FROM media_items WHERE id=?',id).run();throw error;}
    return result(publicItem(await item(id)),201);
  }
  if(route==='/api/admin/library/links'&&method==='POST'){
    const data=await body();let link;try{link=new URL(data.url);}catch{throw fail(400,'Enter a valid HTTPS video or playlist link.');}
    if(link.protocol!=='https:'||link.username||link.password||link.href.length>2048)throw fail(400,'Use a public HTTPS link without login details.');
    const id=uuid();await stmt("INSERT INTO media_items(id,title,type,category,url,size,created) VALUES(?,?,'link',?,?,0,?)",id,title(data.title),data.category==='testimonial'?'testimonial':'general',link.href,Date.now()).run();return result(publicItem(await item(id)),201);
  }
  const mediaMatch=route.match(/^\/api\/admin\/library\/([a-f0-9-]{36})$/);
  if(mediaMatch&&method==='PATCH'){const data=await body();if(!await item(mediaMatch[1]))throw fail(404,'Item not found.');if(typeof data.archived!=='boolean')throw fail(400,'Choose archive or restore.');await stmt('UPDATE media_items SET archived=? WHERE id=?',data.archived?1:0,mediaMatch[1]).run();return result({ok:true});}
  if(route==='/api/admin/collections'&&method==='POST'){
    const data=await body();await items(data.itemIds);const id=uuid();await stmt('INSERT INTO media_collections(id,title,item_ids,created) VALUES(?,?,?,?)',id,title(data.title),JSON.stringify(data.itemIds),Date.now()).run();return result({id},201);
  }
  const collectionMatch=route.match(/^\/api\/admin\/collections\/([a-f0-9-]{36})$/);
  if(collectionMatch&&method==='PATCH'){const data=await body();if(!await one('SELECT id FROM media_collections WHERE id=?',collectionMatch[1]))throw fail(404,'Collection not found.');await items(data.itemIds);await stmt('UPDATE media_collections SET title=?,item_ids=? WHERE id=?',title(data.title),JSON.stringify(data.itemIds),collectionMatch[1]).run();return result({ok:true});}
  const sendMatch=route.match(/^\/api\/admin\/conversations\/([a-f0-9-]+)\/send$/);
  if(sendMatch&&method==='POST'){
    const chat=await get(sendMatch[1]);if(!chat)throw fail(404,'Conversation not found.');const data=await body();
    if(typeof data.clientId!=='string'||!/^[\w-]{16,80}$/.test(data.clientId))throw fail(400,'A unique send ID is required.');
    const clientId=`owner:${data.clientId}`;
    if(await one('SELECT id FROM messages WHERE conversation_id=? AND client_id=?',chat.id,clientId))return result(await view(chat,true));
    if(data.version!==chat.version)throw fail(409,'The chat changed. Review it and send again.');
    if(typeof data.body!=='string'||data.body.length>4000)throw fail(400,'Message text must be 4,000 characters or less.');
    let selected=[],heading='';
    if(data.collectionId){const c=await one('SELECT * FROM media_collections WHERE id=?',data.collectionId);if(!c)throw fail(404,'Collection not found.');selected=await items(JSON.parse(c.item_ids));heading=c.title;}
    else if(data.itemIds?.length)selected=await items(data.itemIds);
    if(!data.body.trim()&&!selected.length)throw fail(400,'Write a message or attach media.');
    const waiting=await pending(chat.id),replyTo=data.replyTo??null;
    if(replyTo!==null&&waiting?.id!==replyTo)throw fail(409,'The pending question changed. Refresh and review before sending.');
    const kind=selected.length?'media':replyTo!==null?'human':'owner-message';
    const payload=selected.length?JSON.stringify({text:data.body.trim(),title:heading,items:selected.map(publicItem)}):data.body.trim();
    const inserted=await env.DB.batch([
      stmt("INSERT OR IGNORE INTO messages(conversation_id,role,kind,body,status,client_id,created) SELECT ?,'assistant',?,?,'sent',?,? WHERE EXISTS(SELECT 1 FROM conversations WHERE id=? AND version=?)",chat.id,kind,payload,clientId,Date.now(),chat.id,data.version),
      // Invalidate an in-flight generated answer before it can overwrite an owner send.
      stmt("UPDATE conversations SET mode=CASE WHEN mode='ai' THEN 'manual' ELSE mode END,version=version+1,updated=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND client_id=?)",Date.now(),chat.id,data.version,chat.id,clientId),
      stmt("UPDATE messages SET status='answered' WHERE conversation_id=? AND role='user' AND id<=? AND status IN ('pending','failed') AND EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND client_id=?)",chat.id,replyTo??-1,chat.id,clientId),
      stmt("DELETE FROM drafts WHERE conversation_id=? AND EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND client_id=?)",chat.id,chat.id,clientId),
      ...selected.map(m=>stmt('INSERT OR IGNORE INTO media_grants(conversation_id,media_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND client_id=?)',chat.id,m.id,chat.id,clientId)),
      stmt("UPDATE conversations SET free_used=(SELECT COUNT(*) FROM messages WHERE conversation_id=? AND role='assistant' AND kind NOT IN ('welcome','owner-message','media')) WHERE id=?",chat.id,chat.id),
    ]);
    if(!inserted[0].meta.changes)throw fail(409,'The chat changed. Review it and send again.');
    return result(await view(await get(chat.id),true),201);
  }
  return null;
}

export async function mediaResponse({request,env,route,one,owner,customer,fail}) {
  const match=route.match(/^\/api\/media\/([a-f0-9-]{36})$/);if(!match||!['GET','HEAD'].includes(request.method))throw fail(404,'Not found.');
  let isOwner=false;try{await owner();isOwner=true;}catch(error){if(error.status!==401)throw error;}
  if(!isOwner){const chat=await customer();if(!await one('SELECT 1 FROM media_grants WHERE conversation_id=? AND media_id=?',chat.id,match[1]))throw fail(404,'Not found.');}
  const item=await one('SELECT * FROM media_items WHERE id=?',match[1]);if(!item?.object_key)throw fail(404,'Media not found.');
  const rangeHeader=request.headers.get('Range');let range;
  if(rangeHeader){const r=/^bytes=(\d+)-(\d*)$/.exec(rangeHeader);if(!r)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${item.size}`}});const start=Number(r[1]),end=r[2]?Math.min(Number(r[2]),item.size-1):item.size-1;if(start>end||start>=item.size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${item.size}`}});range={offset:start,length:end-start+1};}
  const object=await env.MEDIA.get(item.object_key,range?{range}:undefined);if(!object)throw fail(404,'Media not found.');
  const h={'Content-Type':item.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Content-Length':String(range?.length??item.size),'Content-Security-Policy':"default-src 'none'; sandbox",'Cross-Origin-Resource-Policy':'same-origin'};
  if(item.mime==='application/pdf')h['Content-Disposition']=`attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(item.title)}`;
  if(range)h['Content-Range']=`bytes ${range.offset}-${range.offset+range.length-1}/${item.size}`;
  return new Response(request.method==='HEAD'?null:object.body,{status:range?206:200,headers:h});
}
