import {validPeer} from './engine.mjs';

export const idOf = value => typeof value === 'string' ? value : value?._serialized || '';
const types=new Set(['text','image','video','audio','ptt','document','sticker','payment']);
export function normalizeIncoming(message, since, now=Date.now()) {
  const peer=idOf(message.from),id=idOf(message.id),at=Number(message.timestamp??message.t)*1000;
  const type=message.type==='chat'?'text':message.type;
  const name=String(message.sender?.pushname||message.sender?.formattedName||message.chat?.name||'').slice(0,100);
  const service=message.isPSA||message.sender?.isPSA||message.chat?.contact?.isPSA||/^(?:Facebook Business|Meta Business|WhatsApp)$/i.test(name.trim());
  const reason=!validPeer(peer)?'peer':!id?'id':message.fromMe||message.id?.fromMe||message.self==='out'?'outgoing':message.isGroupMsg||message.chat?.isGroup?'group':service?'service':message.isNotification&&type!=='payment'?'notification':!Number.isFinite(at)||at<=0?'timestamp':at<since?'older_than_start':at>now+300000?'future_timestamp':!types.has(type)?'type':null;
  return reason?{reason}:{input:{peer,id,at,type,name,body:type==='text'?message.body||message.content||'':message.caption||''}};
}

// Executed by the provider SDK in its existing private session. Read operations
// only: do not open chats, send receipts or request a new device login.
export async function readProviderInbox({after=0,offset=0,limit=20}) {
  const models=c=>typeof c?.getModelsArray==='function'?c.getModelsArray():Array.isArray(c?._models)?c._models:Array.isArray(c?.models)?c.models:[];
  const id=value=>typeof value==='string'?value:value?._serialized||'';
  const store=globalThis.Store;
  if(!store?.Chat)throw Error('Chat store unavailable');
  const all=models(store.Chat).filter(c=>/^\d{5,25}@(c\.us|lid|s\.whatsapp\.net)$/.test(id(c.id))&&!c.isGroup);
  const chats=all.filter(c=>Number(c.t||0)*1000>=after).sort((a,b)=>Number(b.t||0)-Number(a.t||0)).slice(offset,offset+limit);
  const results=[];
  for(const chat of chats){
    const peer=id(chat.id),contact=chat.contact||store.Contact?.get(chat.id);
    const name=contact?.pushname||contact?.formattedName||chat.name||chat.formattedTitle||'';
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
    const messages=[...new Map(loaded.map(m=>[id(m.id),m])).values()].sort((a,b)=>Number(a.t||0)-Number(b.t||0)).slice(-100).map(m=>({
      id:id(m.id),from:m.id?.fromMe?peer:id(m.from)||peer,fromMe:!!m.id?.fromMe,isGroupMsg:!!m.isGroupMsg,isNotification:!!m.isNotification,isPSA:!!m.isPSA,type:m.type,timestamp:m.t,body:m.type==='chat'?m.body||'':'',caption:m.caption||'',sender:{pushname:String(name).slice(0,100)},ack:m.ack
    }));
    results.push({peer,name:String(name).slice(0,100),at:Number(chat.t||0)*1000,messages,error});
  }
  return{total:all.length,eligible:all.filter(c=>Number(c.t||0)*1000>=after).length,next:offset+chats.length,chats:results};
}

export function createInboxSync({engine,evaluate,onIncoming,now=()=>Date.now()}) {
  const saved=engine.get('inbox-recovery');
  const oldest=engine.db.prepare("SELECT min(json_extract(json,'$.firstAt')) AS at FROM records WHERE kind='contact'").get()?.at;
  const since=saved?.since||Number(oldest)||now();
  if(!saved||saved.kind!=='settings')engine.put({key:'inbox-recovery',kind:'settings',since});
  const status={running:false,checkedAt:null,providerChats:0,imported:0,recovered:0,error:''};
  let offset=0,scanningAfter=0;
  return{status,since,async scan(){
    if(status.running)return;
    status.running=true;
    try{
      // Initial pages include chat metadata. Following sweeps overlap the recovery
      // boundary; SQLite receipt IDs, not an in-memory watermark, prevent repeats.
      const result=await evaluate(readProviderInbox,{after:scanningAfter,offset,limit:10});
      status.providerChats=result.total;
      for(const chat of result.chats){
        for(const message of chat.messages){
          const normalized=normalizeIncoming(message,0,now());
          if(normalized.reason)continue;
          if(normalized.input.at>=since){const accepted=await onIncoming(message);if(accepted)status.recovered++;}
          else if(engine.importHistory(normalized.input))status.imported++;
        }
      }
      offset=result.next;
      if(offset>=result.eligible){offset=0;scanningAfter=Math.max(since,now()-86400000);}
      status.checkedAt=now();status.error=result.chats.some(c=>c.error)?'Some chat history could not be loaded.':'';
    }catch{status.error='WhatsApp inbox sync failed; retrying.';}
    finally{status.running=false;}
  }};
}
