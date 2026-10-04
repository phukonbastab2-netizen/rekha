// A private, device-local archive. This database is never an authentication
// mechanism: the server still verifies its HttpOnly session on every request.
// Browsers/the OS may remove site data, and uninstall recovery is not promised.
const MAX_ID=Number.MAX_SAFE_INTEGER;
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=128;
const number=value=>Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):0;
const messageId=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const fields=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
const privateMediaUrl=value=>typeof value==='string'&&/^\/api\/(?:media|attachments)\/[a-f0-9-]{36}$/.test(value)?value:null;
function mediaItem(value){
  if(!value||typeof value!=='object')return null;
  const item=fields(value,['id','title','type','mime','size']);
  for(const key of ['id','title','type','mime'])if(typeof item[key]!=='string')delete item[key];
  if(value.presentation==='voice-note'&&item.type==='audio')item.presentation='voice-note';
  if(!Number.isFinite(item.size)||item.size<0)delete item.size;
  const privateUrl=privateMediaUrl(value.url);if(privateUrl)item.url=privateUrl;
  else if(item.type==='link')try{const url=new URL(value.url);if(url.protocol==='https:'&&!url.username&&!url.password)item.url=url.href;}catch{}
  return item;
}
function bodyOf(message){
  if(message.deleted)return '';
  const body=typeof message.body==='string'?message.body:'';
  if(message.kind!=='media')return body;
  try{const data=JSON.parse(body),donation=data.donation?.action==='interest-v1'?{label:'मैं दान करना चाहता/चाहती हूँ · I want to donate',action:'interest-v1'}:null;return JSON.stringify({text:typeof data.text==='string'?data.text:'',title:typeof data.title==='string'?data.title:'',items:Array.isArray(data.items)?data.items.slice(0,20).map(mediaItem).filter(Boolean):[],...(donation?{donation}:{})});}catch{return '';}
}
function rowOf(value){
  const id=messageId(value?.id);if(!id||!['user','assistant','system'].includes(value.role))return null;
  const row={id,role:value.role,kind:typeof value.kind==='string'?value.kind:'',body:bodyOf(value),status:typeof value.status==='string'?value.status:'',created:number(value.created),changeRevision:number(value.changeRevision??value.change_revision),deleted:value.deleted===true,readByOther:value.readByOther===true,starred:value.starred===true};
  if(value.role==='assistant'&&Number.isSafeInteger(value.deliveryAt)&&value.deliveryAt>0&&value.deliveryAt<=8640000000000000)row.deliveryAt=value.deliveryAt;
  if(typeof value.clientId==='string'&&value.role==='user')row.clientId=value.clientId;
  row.replyTo=messageId(value.replyTo);row.edited=messageId(value.edited);
  row.reactions=row.deleted?[]:Array.isArray(value.reactions)?value.reactions.filter(item=>item&&typeof item.emoji==='string').map(item=>({emoji:item.emoji,...(['owner','customer'].includes(item.by)?{by:item.by}:{})})):[];
  return row;
}
function mergeRow(previous,next){
  if(!previous)return next;
  // Deleted messages are irreversible, even when a delayed page has no row
  // revision. Their old text/media references must never return to the device.
  if(previous.deleted&&!next.deleted)return {...previous,readByOther:previous.readByOther||next.readByOther};
  if(next.changeRevision<previous.changeRevision&&(!next.deleted||previous.deleted))return {...previous,readByOther:previous.readByOther||next.readByOther};
  return {...next,readByOther:previous.readByOther||next.readByOther};
}
function metadataOf(view){
  const data=fields(view,['id','name','dob','language','version','updated','inboxRevision','guidedConversation','rewardedReplies','freeUsed','freeRemaining','entitlement','locked','blocked']);
  for(const key of ['version','updated','inboxRevision','rewardedReplies','freeUsed','freeRemaining'])if(key in data)data[key]=number(data[key]);
  for(const key of ['name','dob','language','entitlement'])if(key in data&&typeof data[key]!=='string')delete data[key];
  for(const key of ['guidedConversation','locked','blocked'])if(key in data)data[key]=data[key]===true;
  if(typeof view.kundliChoiceAnswered==='boolean')data.kundliChoiceAnswered=view.kundliChoiceAnswered;
  if(typeof view.kundliDonationInterested==='boolean')data.kundliDonationInterested=view.kundliDonationInterested;
  const hold=view.customerSendHold;if(Number.isSafeInteger(hold?.startsAt)&&hold.startsAt>0&&Number.isSafeInteger(hold?.endsAt)&&hold.endsAt>hold.startsAt&&hold.endsAt<=8640000000000000)data.customerSendHold={startsAt:hold.startsAt,endsAt:hold.endsAt};
  if(Number.isSafeInteger(view.clockOffsetMs)&&Math.abs(view.clockOffsetMs)<=3660*86400000)data.clockOffsetMs=view.clockOffsetMs;
  if(view.preferences&&typeof view.preferences==='object'){
    data.preferences={remember:view.preferences.remember===true};
    if(typeof view.preferences.consentVersion==='string')data.preferences.consentVersion=view.preferences.consentVersion;
    const {latitude,longitude}=view.preferences.location||{};data.preferences.location=Number.isFinite(latitude)&&Number.isFinite(longitude)?{latitude,longitude}:null;
  }
  if(view.receiptCursors)data.receiptCursors={ownerRead:number(view.receiptCursors.ownerRead),customerRead:number(view.receiptCursors.customerRead)};
  return data;
}
function mergeMetadata(previous,next,kind){
  if(!previous)return next;
  const newer=kind!=='older'&&(number(next.version)>number(previous.version)||number(next.version)===number(previous.version)&&number(next.updated)>=number(previous.updated));
  const data={...previous,...(newer?next:{})};
  if(previous.kundliChoiceAnswered===true||next.kundliChoiceAnswered===true)data.kundliChoiceAnswered=true;
  if(previous.kundliDonationInterested===true||next.kundliDonationInterested===true)data.kundliDonationInterested=true;
  if(next.customerSendHold)data.customerSendHold=next.customerSendHold;
  if(Number.isSafeInteger(next.clockOffsetMs)&&Math.abs(next.clockOffsetMs)<=3660*86400000)data.clockOffsetMs=next.clockOffsetMs;
  if(kind!=='older'){const settings=number(next.inboxRevision)>=number(previous.inboxRevision)?next:previous;for(const key of ['inboxRevision','blocked'])if(key in settings)data[key]=settings[key];}
  if(next.receiptCursors)data.receiptCursors={ownerRead:Math.max(number(previous.receiptCursors?.ownerRead),next.receiptCursors.ownerRead),customerRead:Math.max(number(previous.receiptCursors?.customerRead),next.receiptCursors.customerRead)};
  return data;
}
function historyOf(value,id){
  if(!value||value.id!==id)return null;
  return{id,revision:value.revision===null||value.revision===undefined?null:number(value.revision),oldestId:messageId(value.oldestId),hasOlder:value.hasOlder===true};
}
function snapshotOf(value){
  if(!value||typeof value!=='object')return null;
  const attachments=[];
  for(const item of Array.isArray(value.attachments)?value.attachments.slice(0,10):[]){
    // Blob/File structured cloning retains bytes, unlike expiring blob: URLs.
    if(!item||typeof Blob==='undefined'||!(item.file instanceof Blob))continue;
    const name=typeof item.file.name==='string'?item.file.name:typeof item.name==='string'?item.name:'attachment',lastModified=number(item.file.lastModified??item.lastModified);
    const file=typeof File==='function'&&typeof item.file.name!=='string'?new File([item.file],name,{type:item.file.type,lastModified}):item.file;
    const uploaded=mediaItem(item.uploaded);attachments.push({file,name,lastModified,uploaded:uploaded?.id?uploaded:null});
  }
  return{body:typeof value.body==='string'?value.body:'',...(typeof value.clientId==='string'?{clientId:value.clientId}:{}),editId:messageId(value.editId),replyTo:messageId(value.replyTo),editBackup:value.editBackup?{body:typeof value.editBackup.body==='string'?value.editBackup.body:'',replyTo:messageId(value.editBackup.replyTo)}:null,attachments,previewRevoked:true,finished:false};
}
function pendingOf(id,value={}){
  const seen=new Set(),records=[];
  for(const record of Array.isArray(value.records)?value.records:[]){
    if(record?.conversationId!==id||typeof record.clientId!=='string'||!record.clientId||seen.has(record.clientId))continue;
    const snapshot=snapshotOf(record.snapshot);if(!snapshot||snapshot.clientId!==record.clientId)continue;
    seen.add(record.clientId);records.push({clientId:record.clientId,conversationId:id,created:number(record.created),baseVersion:number(record.baseVersion),snapshot,state:record.state==='failed'?'failed':'queued',uncertain:record.uncertain===true||record.state==='sending',attempts:number(record.attempts)});
  }
  return{records,draft:snapshotOf(value.draft)};
}
const requested=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error||new Error('Device storage is unavailable.'));});
const completed=transaction=>new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onabort=transaction.onerror=()=>reject(transaction.error||new Error('Device storage could not be saved.'));});
function pageRows(store,range,limit){
  return new Promise((resolve,reject)=>{const rows=[],request=store.openCursor(range,'prev');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const cursor=request.result;if(!cursor)return resolve(rows);rows.push(cursor.value);if(rows.length>limit)return resolve(rows);cursor.continue();};});
}
function deleteRows(store,range){
  return new Promise((resolve,reject)=>{const request=store.openCursor(range);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const cursor=request.result;if(!cursor)return resolve();cursor.delete();cursor.continue();};});
}
export function createDeviceChatStore({indexedDB=globalThis.indexedDB,IDBKeyRange=globalThis.IDBKeyRange,dbName='rekha-device-chats-v1',pageSize=80,onError=()=>{}}={}){
  let opening=null,database=null,tail=Promise.resolve(),closed=false,state='idle';const erased=new Set();
  function unavailable(error){state=error?.name==='QuotaExceededError'?'full':error?.name==='BlockedError'?'blocked':'unavailable';try{onError({state,message:state==='full'?'Device storage is full. Recent changes may not be saved.':'Device storage is unavailable. Recent changes may not be saved.'});}catch{}}
  function open(){
    if(closed)return Promise.reject(new Error('Device storage is closed.'));
    if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      if(!indexedDB?.open||!IDBKeyRange)return reject(new Error('Device storage is unavailable.'));
      const request=indexedDB.open(dbName,1);let rejected=false;
      request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('messages')){const messages=db.createObjectStore('messages',{keyPath:['conversationId','id']});messages.createIndex('client',['conversationId','clientId']);}if(!db.objectStoreNames.contains('metadata'))db.createObjectStore('metadata',{keyPath:'key'});if(!db.objectStoreNames.contains('pending'))db.createObjectStore('pending',{keyPath:'id'});};
      request.onerror=()=>reject(request.error||new Error('Device storage is unavailable.'));
      request.onblocked=()=>{rejected=true;reject(Object.assign(new Error('Device storage is blocked.'),{name:'BlockedError'}));};
      request.onsuccess=()=>{if(rejected||closed){request.result.close();if(closed)reject(new Error('Device storage is closed.'));return;}database=request.result;database.onversionchange=()=>{database?.close();database=null;opening=null;state='unavailable';};state='available';resolve(database);};
    });return opening;
  }
  function serial(work,fallback){const result=tail.then(async()=>{try{return await work(await open());}catch(error){unavailable(error);return fallback;}});tail=result.then(()=>{});return result;}
  async function transaction(db,stores,mode,work){const tx=db.transaction(stores,mode),done=completed(tx);try{const value=await work(tx);await done;return value;}catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}}
  const range=(id,before=null)=>IDBKeyRange.bound([id,0],[id,before??MAX_ID],false,before!==null);
  const emptyPending=()=>({records:[],draft:null});
  return{
    merge(view,{kind='mutation',history=null}={}){
      if(!validId(view?.id)||!Array.isArray(view.messages))return Promise.resolve(false);
      const id=view.id,metadata=metadataOf(view),rows=view.messages.map(rowOf).filter(Boolean),cursor=historyOf(history,id);
      return serial(db=>transaction(db,['messages','metadata','pending'],'readwrite',async tx=>{
        if(erased.has(id))return false;const meta=tx.objectStore('metadata'),messages=tx.objectStore('messages'),old=await requested(meta.get('chat:'+id));
        if(await requested(meta.get('erased:'+id)))return false;
        const merged=mergeMetadata(old?.chat,metadata,kind);
        for(const row of rows){const previous=await requested(messages.get([id,row.id]));await requested(messages.put({conversationId:id,...mergeRow(previous,row)}));}
        let durableHistory=old?.history||null;
        if(cursor){const oldRevision=durableHistory?.revision;if(oldRevision==null||cursor.revision!=null&&cursor.revision>=oldRevision)durableHistory=cursor;}
        await requested(meta.put({key:'chat:'+id,chat:merged,history:durableHistory}));await requested(meta.put({key:'active',id}));
        // Server confirmations remove already delivered sends after a crash,
        // including when the ACK reached IndexedDB before the outbox snapshot.
        const pending=await requested(tx.objectStore('pending').get(id));
        if(pending){const clients=new Set(rows.filter(row=>row.role==='user'&&row.clientId).map(row=>row.clientId)),byId=new Map(rows.map(row=>[row.id,row]));pending.records=pending.records.filter(record=>{const edited=byId.get(record.snapshot.editId);return!clients.has(record.clientId)&&!(edited&&!edited.deleted&&edited.body.trim()===record.snapshot.body.trim()&&number(merged.version)>=record.baseVersion);});await requested(tx.objectStore('pending').put(pending));}
        state='available';return true;
      }),false);
    },
    savePending(id,value){
      if(!validId(id))return Promise.resolve(false);const pending=pendingOf(id,value);
      return serial(db=>transaction(db,['messages','metadata','pending'],'readwrite',async tx=>{
        if(erased.has(id)||await requested(tx.objectStore('metadata').get('erased:'+id)))return false;
        // Check confirmed clientIds using one bounded row lookup per queued
        // record rather than reading all conversation messages into memory.
        const chat=await requested(tx.objectStore('metadata').get('chat:'+id));
        if(!chat)return false;
        if(Number.isSafeInteger(value?.clockOffsetMs)&&Math.abs(value.clockOffsetMs)<=3660*86400000){chat.chat.clockOffsetMs=value.clockOffsetMs;await requested(tx.objectStore('metadata').put(chat));}
        const messages=tx.objectStore('messages'),records=[];
        for(const record of pending.records){const confirmed=record.snapshot.editId?await requested(messages.get([id,record.snapshot.editId])):await requested(messages.index('client').get([id,record.clientId]));if(!confirmed||record.snapshot.editId&&(confirmed.deleted||confirmed.body.trim()!==record.snapshot.body.trim()||number(chat.chat.version)<record.baseVersion))records.push(record);}
        await requested(tx.objectStore('pending').put({id,...pending,records}));state='available';return true;
      }),false);
    },
    read({id=null,beforeId=null,limit=pageSize}={}){
      const count=Math.max(1,Math.min(200,number(limit)||pageSize)),before=messageId(beforeId);
      return serial(db=>transaction(db,['messages','metadata','pending'],'readonly',async tx=>{
        const meta=tx.objectStore('metadata'),active=id===null?await requested(meta.get('active')):null,chatId=id??active?.id;
        if(!validId(chatId)||erased.has(chatId))return null;
        const saved=await requested(meta.get('chat:'+chatId));if(!saved)return null;
        const [rows,pending]=await Promise.all([pageRows(tx.objectStore('messages'),range(chatId,before),count),requested(tx.objectStore('pending').get(chatId))]);
        const hasOlderLocal=rows.length>count,messages=rows.slice(0,count).reverse().map(row=>rowOf(row)),oldestId=messages[0]?.id??null,receipt=saved.chat.receiptCursors;
        for(const message of messages)if(['user','assistant'].includes(message.role)&&message.id<=number(receipt?.[message.role==='user'?'ownerRead':'customerRead']))message.readByOther=true;
        const chat={...saved.chat,messages,historyComplete:false,typing:{customer:false,owner:false},page:{oldestId,hasOlder:hasOlderLocal||saved.history?.hasOlder===true}};
        return{chat,history:saved.history||{id:chatId,revision:null,oldestId,hasOlder:false},hasOlderLocal,oldestId,pending:pending?pendingOf(chatId,pending):emptyPending()};
      }),null);
    },
    allowRestore(id){
      if(!validId(id))return Promise.resolve(false);
      // Callers must first verify the same server UUID and receive an explicit
      // request to reopen it. Ordinary sync never removes deletion markers.
      return serial(async db=>{await transaction(db,['metadata'],'readwrite',async tx=>{await requested(tx.objectStore('metadata').delete('erased:'+id));});erased.delete(id);state='available';return true;},false);
    },
    erase(id=null){
      if(id!==null&&!validId(id))return Promise.resolve(false);if(id!==null)erased.add(id);
      return serial(db=>transaction(db,['messages','metadata','pending'],'readwrite',async tx=>{
        const meta=tx.objectStore('metadata');
        if(id===null){const request=meta.openCursor();await new Promise((resolve,reject)=>{request.onerror=()=>reject(request.error);request.onsuccess=()=>{const cursor=request.result;if(!cursor)return resolve();if(cursor.key.startsWith('chat:')){const chatId=cursor.value.chat.id;erased.add(chatId);meta.put({key:'erased:'+chatId});}if(!cursor.key.startsWith('erased:'))cursor.delete();cursor.continue();};});tx.objectStore('messages').clear();tx.objectStore('pending').clear();}
        else{await deleteRows(tx.objectStore('messages'),range(id));tx.objectStore('pending').delete(id);meta.delete('chat:'+id);meta.put({key:'erased:'+id});const active=await requested(meta.get('active'));if(active?.id===id)meta.delete('active');}
        state='available';return true;
      }),false);
    },
    flush:()=>tail,
    status:()=>({state,available:state==='available'}),
    close(){closed=true;database?.close();database=null;},
  };
}
