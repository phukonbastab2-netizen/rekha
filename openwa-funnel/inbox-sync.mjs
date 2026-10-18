import {validPeer} from './engine.mjs';

export const idOf = value => typeof value === 'string' ? value : value?._serialized || '';
// Self-contained so the provider's existing private browser and its IndexedDB
// journal can use the same plain snapshot contract without an SDK serializer.
export function serializeNativeMessage(model,{peer:providedPeer,name:providedName,ownIds:providedOwnIds}={}){
  const root=globalThis,id=value=>typeof value==='string'?value:value?._serialized||'';
  const outgoing=typeof model?.id?.fromMe==='boolean'?model.id.fromMe:model?.fromMe===true||model?.self==='out',peer=providedPeer||id(model?.id?.remote)||id(outgoing?model?.to:model?.from)||id(model?.chatId);
  const chat=root.Store?.Chat?.get?.(model?.id?.remote),contact=(!outgoing&&model?.senderObj)||chat?.contact||root.Store?.Contact?.get?.(model?.id?.remote);
  const nativeContact=root.Store?.Contact?.get?.(peer),phone=id(nativeContact?.phoneNumber),name=[providedName,contact?.pushname,contact?.formattedName,chat?.name,nativeContact?.pushname,nativeContact?.formattedName].find(value=>typeof value==='string'&&value.trim())||(/^\d{5,15}@(c\.us|s\.whatsapp\.net)$/.test(phone)?'+'+phone.split('@')[0]:'');
  let ownIds=providedOwnIds||[];if(!providedOwnIds)try{const me=root.require?.('WAWebUserPrefsMeUser');ownIds=[id(me?.getMaybeMePnUser?.()),id(me?.getMaybeMeLidUser?.())].filter(Boolean);}catch{}
  return{id:id(model?.id),from:peer,to:peer,fromMe:outgoing,isGroupMsg:!!model?.isGroupMsg,isNotification:!!model?.isNotification,isPSA:!!model?.isPSA,type:model?.type,timestamp:model?.t??model?.timestamp,body:typeof model?.body==='string'?model.body:'',caption:model?.caption||'',sender:{pushname:name,isPSA:!!contact?.isPSA},ack:model?.ack,mimetype:model?.mimetype,mediaKey:model?.mediaKey,clientUrl:model?.clientUrl,deprecatedMms3Url:model?.deprecatedMms3Url,filehash:model?.filehash,encFilehash:model?.encFilehash,directPath:model?.directPath,size:model?.size,filename:model?.filename,vcardList:Array.isArray(model?.vcardList)?model.vcardList.slice(0,25).map(c=>({displayName:c?.displayName,vcard:c?.vcard})):undefined,lat:model?.lat,lng:model?.lng,loc:model?.loc,name:model?.name,isLive:model?.isLive,latestEditSenderTimestampMs:model?.latestEditSenderTimestampMs,latestEditMsgKey:id(model?.latestEditMsgKey),protocolMessageKey:id(model?.protocolMessageKey),isSelf:!!model?.isSelf||ownIds.includes(peer)};
}
const types=new Set(['text','image','video','audio','ptt','document','sticker','payment','vcard','multi_vcard','location','live_location']);
const internalTypes=new Set(['ciphertext','e2e_notification','notification_template','notification','gp2','protocol','call_log','debug','sender_key_distribution_message']);
function sharedPayload(message,type){
  const text=value=>typeof value==='string'?value:'';
  if(type==='vcard')return{body:text(message.body)||text(message.vcard)||text(message.caption)};
  if(type==='multi_vcard'){
    const cards=Array.isArray(message.vcardList)?message.vcardList.slice(0,25):[];
    return{body:cards.map(card=>[text(card?.displayName),text(card?.vcard)].filter(Boolean).join('\n')).filter(Boolean).join('\n\n')||text(message.body)||text(message.caption)};
  }
  if(type==='location'||type==='live_location'){
    const rawLatitude=message.lat??message.latitude??message.location?.latitude,rawLongitude=message.lng??message.longitude??message.location?.longitude;
    const latitude=rawLatitude===null||rawLatitude===undefined||rawLatitude===''?NaN:Number(rawLatitude),longitude=rawLongitude===null||rawLongitude===undefined||rawLongitude===''?NaN:Number(rawLongitude);
    const label=[text(message.body),text(message.caption),text(message.loc),text(message.name),text(message.location?.description)].filter(Boolean);
    const valid=Number.isFinite(latitude)&&latitude>=-90&&latitude<=90&&Number.isFinite(longitude)&&longitude>=-180&&longitude<=180;
    return{body:[...new Set([...label,...(valid?[latitude+', '+longitude]:[])])].join('\n'),...(valid?{sharedLocation:{latitude,longitude,label:[...new Set(label)].join('\n').slice(0,1000),live:type==='live_location'||!!message.isLive}}:{})};
  }
  return{body:type==='text'?text(message.body)||text(message.content):text(message.caption)||text(message.body)};
}
// Some synced/decrypted incoming models have isNewMsg=false, so the SDK's
// legacy onAnyMessage filter misses them. Listen to those model transitions as
// well; the gateway's durable time boundary and receipt IDs remain authoritative.
export function installFastInboxBridge({since}) {
  const root=globalThis,collection=root.Store?.Msg,emit=root.OpenWA_RuntimeMessageReceived;
  if(!collection?.on||typeof emit!=='function')return{ready:false};
  let state=root.__REKHA_INBOX_BRIDGE__;
  if(state?.collection===collection&&state.version===6&&state.failed===0){state.since=since;return{ready:true,emitted:state.emitted,failed:state.failed,socket:root.Store?.State?.Socket?.state||root.Store?.State?.default?.state||null};}
  if(state?.collection?.off)for(const event of ['add','change:type','change:body','change:caption','change:latestEditMsgKey','change:latestEditSenderTimestampMs'])state.collection.off(event,state.handler);
  if(state?.collection?.off&&state.editHandler)for(const event of ['change:body','change:caption','change:latestEditMsgKey','change:latestEditSenderTimestampMs'])state.collection.off(event,state.editHandler);
  if(state?.collection?.off&&state.ackHandler)state.collection.off('change:ack',state.ackHandler);
  state={collection,since,version:6,emitted:0,failed:0};
  state.dispatch=(model,changed=false)=>{
    if(!model||model.type==='album'||Number(model.t||0)*1000<state.since&&model.type!=='revoked'&&!model.latestEditSenderTimestampMs)return;
    try{
      // The installed live WAPI patch can return a Promise from its serializer;
      // the legacy listener then emits an empty object. Read stable model fields
      // directly so message identity never depends on that serializer.
      const id=value=>typeof value==='string'?value:value?._serialized||'';
      const outgoing=!!model.id?.fromMe,peer=id(model.id?.remote)||id(outgoing?model.to:model.from),chat=root.Store.Chat?.get(model.id?.remote),contact=(!outgoing&&model.senderObj)||chat?.contact||root.Store.Contact?.get(model.id?.remote);
      const nativeContact=root.Store.Contact?.get?.(peer),phone=id(nativeContact?.phoneNumber),name=[contact?.pushname,contact?.formattedName,chat?.name,nativeContact?.pushname,nativeContact?.formattedName].find(value=>typeof value==='string'&&value.trim())||(/^\d{5,15}@(c\.us|s\.whatsapp\.net)$/.test(phone)?'+'+phone.split('@')[0]:'');
      let isSelf=!!model.isSelf;try{const me=root.require?.('WAWebUserPrefsMeUser');isSelf||=[id(me?.getMaybeMePnUser?.()),id(me?.getMaybeMeLidUser?.())].filter(Boolean).includes(peer);}catch{}
      const message={id:id(model.id),from:peer,to:peer,fromMe:outgoing,isGroupMsg:!!model.isGroupMsg,isNotification:!!model.isNotification,isPSA:!!model.isPSA,type:model.type,timestamp:model.t,body:typeof model.body==='string'?model.body:'',caption:model.caption||'',sender:{pushname:contact?.pushname||contact?.formattedName||chat?.name||'',isPSA:!!contact?.isPSA},ack:model.ack,mimetype:model.mimetype,mediaKey:model.mediaKey,clientUrl:model.clientUrl,deprecatedMms3Url:model.deprecatedMms3Url,filehash:model.filehash,encFilehash:model.encFilehash,directPath:model.directPath,size:model.size,filename:model.filename,vcardList:Array.isArray(model.vcardList)?model.vcardList.slice(0,25).map(c=>({displayName:c?.displayName,vcard:c?.vcard})):undefined,lat:model.lat,lng:model.lng,loc:model.loc,name:model.name,isLive:model.isLive,latestEditSenderTimestampMs:model.latestEditSenderTimestampMs,latestEditMsgKey:id(model.latestEditMsgKey),protocolMessageKey:id(model.protocolMessageKey),isSelf:!!model.isSelf};
      message.sender.pushname=name;message.isSelf=isSelf;if(changed&&model.latestEditSenderTimestampMs)message.mutation='edit';
      const emit=outgoing?root.OpenWA_RuntimeAnyMessage:root.OpenWA_RuntimeMessageReceived;
      if(typeof emit!=='function'){state.failed++;return;}
      state.emitted++;Promise.resolve(emit(message)).catch(()=>{state.failed++;});
    }catch{state.failed++;}
  };
  state.handler=model=>state.dispatch(model);
  state.editHandler=model=>state.dispatch(model,true);
  for(const event of ['add','change:type'])collection.on(event,state.handler);
  for(const event of ['change:body','change:caption','change:latestEditMsgKey','change:latestEditSenderTimestampMs'])collection.on(event,state.editHandler);
  state.ackHandler=model=>{
    const id=typeof model?.id==='string'?model.id:model?.id?._serialized;
    if(!id||!model?.id?.fromMe||!Number.isFinite(Number(model.ack))||typeof root.OpenWA_RuntimeAckChanged!=='function')return;
    try{Promise.resolve(root.OpenWA_RuntimeAckChanged({id,ack:Number(model.ack),fromMe:true,type:model.type,timestamp:model.t})).catch(()=>{state.failed++;});}catch{state.failed++;}
  };
  collection.on('change:ack',state.ackHandler);
  root.__REKHA_INBOX_BRIDGE__=state;return{ready:true,emitted:0,failed:0,socket:root.Store?.State?.Socket?.state||root.Store?.State?.default?.state||null};
}
export function normalizeIncoming(message, since, now=Date.now()) {
  const peer=idOf(message.from),at=Number(message.timestamp??message.t)*1000;
  const rawType=typeof message.type==='string'?message.type.slice(0,80):'',revoked=rawType==='revoked';
  const id=revoked?idOf(message.protocolMessageKey)||idOf(message.id):idOf(message.id);
  const type=revoked?'revoked':rawType==='chat'?'text':types.has(rawType)?rawType:'unsupported';
  const editedAt=Number(message.latestEditSenderTimestampMs??message.editedAt),hasEdit=Number.isFinite(editedAt)&&editedAt>=at&&editedAt<=now+300000;
  const mutation=revoked?'revoke':hasEdit&&(message.mutation==='edit'||at<since)?'edit':null;
  const name=String(message.sender?.pushname||message.sender?.formattedName||message.chat?.name||'').slice(0,100);
  const service=message.isPSA||message.sender?.isPSA||message.chat?.contact?.isPSA||/^(?:Facebook Business|Meta Business|WhatsApp)$/i.test(name.trim());
  const payload=sharedPayload(message,type);
  const reason=!validPeer(peer)?'peer':!id?'id':message.fromMe||message.id?.fromMe||message.self==='out'?'outgoing':message.isSelf?'self':message.isGroupMsg||message.chat?.isGroup?'group':service?'service':message.isNotification&&type!=='payment'&&!revoked?'notification':!Number.isFinite(at)||at<=0?'timestamp':message.mutation==='edit'&&!hasEdit?'mutation_timestamp':at<since&&!mutation&&!hasEdit?'older_than_start':at>now+300000?'future_timestamp':rawType==='album'?'album_container':!rawType||internalTypes.has(rawType)?'type':type==='text'&&!payload.body&&!mutation?'empty_message':null;
  return reason?{reason}:{input:{peer,id,at,type,name,...payload,...(type==='unsupported'?{providerType:rawType,passive:true}:{}),...(hasEdit?{editedAt,editKey:idOf(message.latestEditMsgKey)}:{}),...(mutation?{mutation,observedAt:now,...(revoked&&idOf(message.protocolMessageKey)?{targetKey:idOf(message.protocolMessageKey)}:{})}:{}),...(typeof message.filename==='string'?{filename:message.filename.slice(0,500)}:{})}};
}

export function normalizeOutgoing(message,since,now=Date.now()){
  if(!message.fromMe&&!message.id?.fromMe&&message.self!=='out')return{reason:'incoming'};
  const peer=idOf(message.to)||idOf(message.id?.remote)||idOf(message.chatId)||idOf(message.from);
  const normalized=normalizeIncoming({...message,from:peer,fromMe:false,id:idOf(message.id),self:'in',isSelf:false},since,now);
  return normalized.reason?normalized:{input:{...normalized.input,ack:message.ack,since,fromMe:true,isSelf:!!message.isSelf}};
}

// Executed by the provider SDK in its existing private session. Read operations
// only: do not open chats, send receipts or request a new device login.
export async function readProviderInbox({after=0,offset=0,limit=20,recentAfter=0,messageOffset=0}) {
  const models=c=>typeof c?.getModelsArray==='function'?c.getModelsArray():Array.isArray(c?._models)?c._models:Array.isArray(c?.models)?c.models:[];
  const id=value=>typeof value==='string'?value:value?._serialized||'';
  const store=globalThis.Store;
  if(!store?.Chat)throw Error('Chat store unavailable');
  const nameFor=(peer,...names)=>{const nativeContact=store.Contact?.get?.(peer),phone=id(nativeContact?.phoneNumber);return [...names,nativeContact?.pushname,nativeContact?.formattedName].find(value=>typeof value==='string'&&value.trim())||(/^\d{5,15}@(c\.us|s\.whatsapp\.net)$/.test(phone)?'+'+phone.split('@')[0]:'');};
  let ownIds=[];try{const me=globalThis.require?.('WAWebUserPrefsMeUser');ownIds=[id(me?.getMaybeMePnUser?.()),id(me?.getMaybeMeLidUser?.())].filter(Boolean);}catch{}
  const all=models(store.Chat).filter(c=>/^\d{5,25}@(c\.us|lid|s\.whatsapp\.net)$/.test(id(c.id))&&!c.isGroup);
  const serialize=(m,peer,name)=>({id:id(m.id),from:peer,to:peer,fromMe:!!m.id?.fromMe,isGroupMsg:!!m.isGroupMsg,isNotification:!!m.isNotification,isPSA:!!m.isPSA,type:m.type,timestamp:m.t,body:typeof m.body==='string'?m.body:'',caption:m.caption||'',sender:{pushname:String(name||'').slice(0,100)},ack:m.ack,mimetype:m.mimetype,mediaKey:m.mediaKey,clientUrl:m.clientUrl,deprecatedMms3Url:m.deprecatedMms3Url,filehash:m.filehash,encFilehash:m.encFilehash,directPath:m.directPath,size:m.size,filename:m.filename,vcardList:Array.isArray(m.vcardList)?m.vcardList.slice(0,25).map(c=>({displayName:c?.displayName,vcard:c?.vcard})):undefined,lat:m.lat,lng:m.lng,loc:m.loc,name:m.name,isLive:m.isLive,latestEditSenderTimestampMs:m.latestEditSenderTimestampMs,latestEditMsgKey:id(m.latestEditMsgKey),protocolMessageKey:id(m.protocolMessageKey),isSelf:!!m.isSelf||ownIds.includes(peer)});
  const chats=all.filter(c=>Number(c.t||0)*1000>=after).sort((a,b)=>Number(b.t||0)-Number(a.t||0)).slice(offset,offset+limit);
  const results=[];
  for(const chat of chats){
    const peer=id(chat.id),contact=chat.contact||store.Contact?.get(chat.id);
    const name=nameFor(peer,contact?.pushname,contact?.formattedName,chat.name,chat.formattedTitle);
    if(contact?.isPSA||/^(?:Facebook Business|Meta Business|WhatsApp)$/i.test(String(name).trim()))continue;
    let loaded=models(chat.msgs),error=false;
    if(loaded.length<2){
      try{
        const loader=globalThis.require?.('WAWebChatLoadMessages');
        const loading=loader?.loadEarlierMsgs?loader.loadEarlierMsgs({chat}):typeof chat.loadEarlierMsgs==='function'?chat.loadEarlierMsgs():Promise.resolve([]);
        let timer;const extra=await Promise.race([loading,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('History load timeout')),3000);})]).finally(()=>clearTimeout(timer));
        loaded=[...models(chat.msgs),...(extra||[])];
      }catch{error=true;}
    }
    const messages=[...new Map(loaded.map(m=>[id(m.id),m])).values()].sort((a,b)=>Number(a.t||0)-Number(b.t||0)).slice(-100).map(m=>serialize(m,peer,name));
    results.push({peer,name:String(name).slice(0,100),at:Number(chat.t||0)*1000,messages,error});
  }
  // A decrypted message can exist before its chat metadata or chat timestamp is
  // updated. Page the native message collection independently as a fallback.
  const recent=models(store.Msg).filter(m=>Number(m.t||0)*1000>=recentAfter&&/^\d{5,25}@(c\.us|lid|s\.whatsapp\.net)$/.test(id(m.id?.remote)||id(m.id?.fromMe?m.to:m.from))).sort((a,b)=>Number(a.t||0)-Number(b.t||0)||id(a.id).localeCompare(id(b.id)));
  const page=recent.slice(messageOffset,messageOffset+100);
  const recentMessages=page.map(m=>{const peer=id(m.id?.remote)||id(m.id?.fromMe?m.to:m.from),chat=store.Chat?.get?.(m.id?.remote),contact=chat?.contact||store.Contact?.get?.(m.id?.remote);return serialize(m,peer,nameFor(peer,contact?.pushname,contact?.formattedName,chat?.name));});
  return{total:all.length,eligible:all.filter(c=>Number(c.t||0)*1000>=after).length,next:offset+chats.length,chats:results,recentMessages,messageTotal:recent.length,messageNext:messageOffset+page.length};
}

export function createInboxSync({engine,evaluate,onIncoming,onOutgoing=async()=>false,now=()=>Date.now()}) {
  const saved=engine.get('inbox-recovery');
  const oldest=engine.db.prepare("SELECT min(json_extract(json,'$.firstAt')) AS at FROM records WHERE kind='contact'").get()?.at;
  const since=saved?.since||Number(oldest)||now();
  if(!saved||saved.kind!=='settings')engine.put({key:'inbox-recovery',kind:'settings',since});
  const status={running:false,checkedAt:null,providerChats:0,imported:0,recovered:0,outgoingMirrored:0,error:''};
  let offset=0,scanningAfter=0,messageOffset=0,messageAfter=0;
  return{status,since,async scan(){
    if(status.running)return;
    status.running=true;
    try{
      // Initial pages include chat metadata. Following sweeps overlap the recovery
      // boundary; SQLite receipt IDs, not an in-memory watermark, prevent repeats.
      const result=await evaluate(readProviderInbox,{after:scanningAfter,offset,limit:10,recentAfter:messageAfter,messageOffset});
      status.providerChats=result.total;
      const candidates=[...result.chats.flatMap(chat=>chat.messages),...(result.recentMessages||[])];
      for(const message of new Map(candidates.map(m=>[idOf(m.id),m])).values()){
          if(message.fromMe||message.id?.fromMe||message.self==='out'){
            if(await onOutgoing(message))status.outgoingMirrored++;
            continue;
          }
          const normalized=normalizeIncoming(message,0,now());
          if(normalized.reason)continue;
          if(normalized.input.mutation||normalized.input.editedAt&&engine.get('in:'+normalized.input.id)?.kind==='message'){
            await onIncoming({...message,...(normalized.input.mutation?{}:{mutation:'edit'})});
            continue;
          }
          if(normalized.input.at>=since){const accepted=await onIncoming(message);if(accepted)status.recovered++;}
          else if(engine.importHistory(normalized.input))status.imported++;
      }
      offset=result.next;
      if(offset>=result.eligible){offset=0;scanningAfter=Math.max(since,now()-86400000);}
      messageOffset=result.messageNext||0;if(messageOffset>=(result.messageTotal||0)){messageOffset=0;messageAfter=Math.max(0,now()-86400000);}
      status.checkedAt=now();status.error=result.chats.some(c=>c.error)?'Some chat history could not be loaded.':'';
    }catch{status.error='WhatsApp inbox sync failed; retrying.';}
    finally{status.running=false;}
  }};
}
