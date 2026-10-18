import { createHmac, timingSafeEqual } from 'node:crypto';
import { validPeer } from './engine.mjs';

const ackValues={pending:0,sent:1,delivered:2,read:3,played:4,failed:-1};
export const providerAck=value=>typeof value==='number'&&Number.isFinite(value)?value:ackValues[value];
const id=value=>typeof value==='string'?value:value?._serialized||'';
const normalizePeer=value=>id(value).replace(/@s\.whatsapp\.net$/,'@c.us');

export function classifySendFailure(error){
  const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:null;
  const providerCode=['SEND_PACING_LIMITED','ENGINE_NOT_READY'].includes(error?.providerCode)?error.providerCode:null;
  const providerReason=providerCode==='ENGINE_NOT_READY'&&['not_connected','reinjecting'].includes(error?.providerReason)?error.providerReason:null;
  const category=status===409&&providerCode==='ENGINE_NOT_READY'&&providerReason?'engine_not_ready':status===429&&providerCode==='SEND_PACING_LIMITED'?'send_pacing_rejected':status===429?'api_rate_limited':status===400?'api_request_rejected':status===401||status===403?'api_auth_rejected':status?'api_http_error':error?.code==='MISSING_MESSAGE_ID'?'missing_message_id':['AbortError','TimeoutError'].includes(error?.name)||error?.message==='Send timed out'?'request_timeout':'transport_or_provider_failure';
  // Only this documented pre-send gate proves the adapter was never asked to
  // send. A generic 400 can also be raised by an engine after processing began.
  const retryAfterSeconds=Number.isFinite(error?.retryAfterSeconds)&&error.retryAfterSeconds>=0?Math.min(86400,error.retryAfterSeconds):null;
  const notSent=['engine_not_ready','send_pacing_rejected'].includes(category);
  return{category,status,providerCode,providerReason,outcome:notSent?'not_sent':'unknown',retryAfterSeconds,automaticRetry:notSent};
}

// rmyndharis/OpenWA v0.23.6's stored REST rows and live webhook messages have
// different IDs: the database UUID is NEVER a WhatsApp message identity.
export function openwaMessage(value,{ownerPhone='',chatName=''}={}){
  if(!value||typeof value!=='object')return null;
  const stored=Object.hasOwn(value,'waMessageId'),messageId=id(stored?value.waMessageId:value.id);
  const fromMe=stored?value.direction==='outgoing':value.fromMe===true;
  const peer=normalizePeer(value.chatId|| (fromMe?value.to:value.from));
  const seconds=Number(value.timestamp);
  if(!messageId||messageId.length>300||!validPeer(peer)||!Number.isFinite(seconds)||seconds<=0)return null;
  const media=value.media||value.metadata?.media;
  const rawType=value.type, type=rawType==='voice'?'ptt':rawType==='contact'?'vcard':rawType;
  const name=value.chatName||chatName||value.contact?.pushName||value.contact?.name||'';
  return{id:messageId,from:peer,to:peer,chatId:peer,fromMe,timestamp:seconds,
    type,body:typeof value.body==='string'?value.body:'',caption:typeof value.body==='string'?value.body:'',
    isGroupMsg:!!value.isGroup||value.kind==='group',isSelf:!!value.isSelf||peer===normalizePeer(ownerPhone+'@c.us'),
    isNotification:!!value.isStatusBroadcast,sender:{pushname:name},ack:providerAck(value.status??value.ack),
    ...(media?{openwaMedia:media,mimetype:media.mimetype,filename:media.filename}:{}),
    ...(value.location?{location:value.location,lat:value.location.latitude,lng:value.location.longitude,loc:value.location.description||value.location.address||''}:{}),
    ...(rawType==='revoked'?{protocolMessageKey:messageId}:{}),openwaRowId:stored?value.id:undefined};
}

export function verifyOpenwaWebhook(raw,signature,secret){
  if(!secret||typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature))return false;
  const expected='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
  return timingSafeEqual(Buffer.from(expected),Buffer.from(signature));
}

async function boundedBytes(response,maxBytes){
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>maxBytes)throw Error('OpenWA response exceeded the size limit');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw Error('OpenWA response exceeded the size limit');chunks.push(chunk);}
  return Buffer.concat(chunks,size);
}

export function createOpenwaProvider({baseUrl,apiKey,sessionId,webhookSecret='',activatedAt,get,put,onMessage,onAck=()=>{},onMutation=()=>{},fetchImpl=fetch,now=Date.now}){
  const parsed=new URL(baseUrl);
  // This integration deliberately talks to a private gateway on the same host.
  if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('OpenWA API must use a private loopback URL');
  if(!apiKey||!sessionId)throw Error('OpenWA API credentials and session ID are required');
  const base=baseUrl.replace(/\/$/,''),sessionRoute='/sessions/'+encodeURIComponent(sessionId);
  const checkpointKey='openwa-rest-cursor:'+sessionId;
  const boundary=activatedAt===undefined||activatedAt===''?now():Number(activatedAt);
  if(!Number.isFinite(boundary)||boundary<=0||boundary>now()+300000)throw Error('OpenWA activation boundary must be a valid timestamp');
  let checkpoint=get(checkpointKey)||{key:checkpointKey,kind:'settings',activatedAt:boundary,cursor:'',completedPasses:0,chatOffset:0};
  if(!get(checkpointKey))put(checkpoint);
  let stopped=false,scanning=false,session=null,lastSessionCheck=0,lastChatCheck=0,notReadyUntil=0,chatQueue=Array.isArray(checkpoint.pendingChats)?checkpoint.pendingChats.filter(c=>validPeer(c?.id)).slice(0,100):[],chatNames=new Map();
  const active=new Set();
  const status={running:false,checkedAt:null,error:null,scanned:0,total:0,providerChats:0,completedPasses:checkpoint.completedPasses||0,mobileHistoryComplete:false,activatedAt:checkpoint.activatedAt,lastWebhookAt:null,lastHistoryAt:null};
  const persist=updates=>{checkpoint={...checkpoint,...updates};put(checkpoint);};
  async function request(route,{method='GET',body,timeout=15000,binary=false,maxBytes=4*1024**2}={}){
    if(stopped)throw Error('OpenWA adapter stopped');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
    let resolveSettled;
    const operation={controller,method,settled:new Promise(resolve=>{resolveSettled=resolve;})};active.add(operation);
    try{
      const response=await fetchImpl(base+route,{method,headers:{'X-API-Key':apiKey,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,redirect:'error'});
      if(!response.ok){
        const error=Error('OpenWA API request failed ('+response.status+')');error.status=response.status;
        const retryAfter=response.headers.get('retry-after');if(retryAfter!==null&&/^\d+(?:\.\d+)?$/.test(retryAfter))error.retryAfterSeconds=Number(retryAfter);
        // Retain only an allowlisted machine code. Error response text can
        // contain chat content, session details or URLs and is never recorded.
        try{
          const payload=JSON.parse((await boundedBytes(response,16384)).toString('utf8'));
          const sendRoute=method==='POST'&&/\/messages\/send-(?:text|image|video|audio|document)$/.test(route);
          if(sendRoute&&response.status===429&&payload?.code==='SEND_PACING_LIMITED')error.providerCode='SEND_PACING_LIMITED';
          const reason=payload?.message==='Session is not connected. The WhatsApp client is not ready.'?'not_connected':payload?.message==='WhatsApp Web is reloading its page and the session is re-injecting. Retry in a few seconds.'?'reinjecting':null;
          if(sendRoute&&response.status===409&&payload?.statusCode===409&&payload?.error==='Conflict'&&payload?.code==='ENGINE_NOT_READY'&&reason){error.providerCode='ENGINE_NOT_READY';error.providerReason=reason;notReadyUntil=now()+10000;status.sendReadyAfter=notReadyUntil;}
        }catch{}
        throw error;
      }
      const bytes=await boundedBytes(response,maxBytes);
      if(binary)return{bytes,mime:(response.headers.get('content-type')||'application/octet-stream').split(';')[0].trim()};
      const result=bytes.length?JSON.parse(bytes.toString('utf8')):{};
      return result;
    }finally{clearTimeout(timer);active.delete(operation);resolveSettled();}
  }
  async function checkSession(force=false){
    if(!force&&session&&now()-lastSessionCheck<10000)return session;
    session=await request(sessionRoute);lastSessionCheck=now();return session;
  }
  async function deliver(value,{historical=false,name='',source='rest',observedAt=now()}={}){
    const message=openwaMessage(value,{ownerPhone:session?.phone||'',chatName:name||chatNames.get(normalizePeer(value.chatId))||''});
    if(!message)return false;
    // Old messages newly imported by the provider do not become new customers.
    const isHistory=historical||message.timestamp*1000<checkpoint.activatedAt;
    await onMessage(message,{historical:isHistory,source,observedAt});
    if(message.fromMe&&message.ack!==undefined)await onAck(message.id,message.ack);
    return true;
  }
  async function page(after=''){
    const observedAt=now();
    const result=await request(sessionRoute+'/messages?limit=100&inlineMedia=false'+(after?'&after='+encodeURIComponent(after):''));
    if(!Array.isArray(result.messages)||!Number.isFinite(result.total))throw Error('OpenWA returned an invalid message page');
    // Oldest first within a page preserves STOP/START and message ordering.
    for(const row of [...result.messages].reverse()){await deliver(row,{source:'rest',observedAt});status.scanned++;}
    status.total=result.total;return result.messages;
  }
  async function readHistory(peer,{deep=false}={}){
    if(!validPeer(peer))throw Error('Invalid chat');
    const observedAt=now();
    const result=await request(sessionRoute+'/messages/'+encodeURIComponent(peer)+'/history?limit='+(deep?'2000':'100')+'&includeMedia=false&deep='+(deep?'true':'false'),{timeout:deep?45000:15000});
    if(!Array.isArray(result))throw Error('OpenWA returned invalid chat history');
    for(const row of [...result].sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)))await deliver(row,{historical:Number(row.timestamp)*1000<checkpoint.activatedAt,name:chatNames.get(peer)||'',source:'history',observedAt});
    status.lastHistoryAt=now();return{requested:true,checked:result.length,reason:'Read the history available to the linked session.'};
  }
  async function scan(){
    if(scanning||stopped)return{busy:scanning};scanning=true;status.running=true;
    try{
      await checkSession();
      // Always revisit the head for new messages and delivery/edit changes. The
      // separate durable keyset walk covers bursts larger than a single page.
      await page();
      for(let n=0;n<2&&!stopped;n++){
        let rows;
        try{rows=await page(checkpoint.cursor||'');}
        catch(error){if(error.status===400&&checkpoint.cursor){persist({cursor:''});break;}throw error;}
        const tail=rows.at(-1)?.id;
        if(rows.length<100){persist({cursor:'',completedPasses:(checkpoint.completedPasses||0)+1});status.completedPasses=checkpoint.completedPasses;break;}
        if(!tail||tail===checkpoint.cursor)throw Error('OpenWA message cursor did not advance');
        // A failed callback never advances this cursor, so it is retried after
        // restart. Engine receipts supply idempotency for an already-saved row.
        persist({cursor:tail});
      }
      status.checkedAt=now();status.error=null;
      if(session.status==='ready'&&now()-lastChatCheck>=15000){
        lastChatCheck=now();
        if(!chatQueue.length){
          const chats=await request(sessionRoute+'/chats?limit=100&offset='+(checkpoint.chatOffset||0));
          if(!Array.isArray(chats))throw Error('OpenWA returned invalid chats');
          status.providerChats=Math.max(status.providerChats,(checkpoint.chatOffset||0)+chats.length);
          chatQueue=chats.filter(c=>validPeer(normalizePeer(c.id)));
          for(const c of chatQueue)chatNames.set(normalizePeer(c.id),typeof c.name==='string'?c.name:'');
          // Limit the in-memory name map; the actual inbox is durable in Engine.
          while(chatNames.size>2000)chatNames.delete(chatNames.keys().next().value);
          persist({chatOffset:chats.length===100?(checkpoint.chatOffset||0)+100:0,pendingChats:chatQueue.map(c=>({id:normalizePeer(c.id)}))});
        }
        // Four chats per turn, at most two reads in flight; persist the remaining
        // native-history queue so a process restart cannot skip a partly-read page.
        let failed=false;
        for(let n=0;n<2&&chatQueue.length&&!stopped;n++){
          const chunk=chatQueue.slice(0,2),results=await Promise.allSettled(chunk.map(chat=>readHistory(normalizePeer(chat.id))));
          failed||=results.some(r=>r.status==='rejected');chatQueue.splice(0,chunk.length);
          persist({pendingChats:chatQueue.map(c=>({id:normalizePeer(c.id)}))});
        }
        status.historyError=failed?'Some linked-device history is unavailable.':null;
        status.historyChatsPending=chatQueue.length;
      }
      return{checkedAt:status.checkedAt,total:status.total};
    }catch(error){status.error=error.status===401||error.status===403?'OpenWA API authentication failed.':'OpenWA inbox check failed; the saved cursor will retry.';throw error;}
    finally{scanning=false;status.running=false;}
  }
  async function webhook(raw,signature){
    if(!verifyOpenwaWebhook(raw,signature,webhookSecret))return{status:401};
    let event;try{event=JSON.parse(raw);}catch{return{status:400};}
    if(event.sessionId!==sessionId)return{status:403};
    if(!event.data||typeof event.data!=='object')return{status:400};
    const value=event.data;
    if(['message.received','message.sent'].includes(event.event))await deliver(value,{source:'webhook',observedAt:now()});
    else if(['message.ack','message.failed'].includes(event.event)){
      const ack=providerAck(value.status??value.ack),messageId=id(value.messageId||value.id);
      if(messageId&&ack!==undefined)await onAck(messageId,ack);
    }else if(['message.edited','message.revoked'].includes(event.event)){
      // `data.timestamp` on a wwjs edit can be the ORIGINAL message time.
      // The signed envelope describes this occurrence and is stable across
      // delivery retries, so delayed/retried edits cannot undo a newer edit.
      const observedAt=Date.parse(event.timestamp);
      if(!Number.isFinite(observedAt)||observedAt>now()+300000)return{status:400};
      await onMutation(event.event,value,{source:'webhook',observedAt,eventId:typeof event.idempotencyKey==='string'?event.idempotencyKey:undefined});
    }
    status.lastWebhookAt=now();return{status:200};
  }
  async function send(type,peer,body,url,filename){
    if(!validPeer(peer))throw Error('Invalid recipient');
    const route=type==='text'?'send-text':type==='image'?'send-image':type==='video'?'send-video':type==='audio'||type==='ptt'?'send-audio':'send-document';
    const payload=type==='text'?{chatId:peer,text:body}:{chatId:peer,url,filename,caption:body,...(type==='ptt'?{ptt:true}:{})};
    // POST is intentionally never retried. A network timeout may still have
    // delivered the message; the existing Engine marks that job uncertain.
    const result=await request(sessionRoute+'/messages/'+route,{method:'POST',body:payload,timeout:55000});
    if(typeof result.messageId!=='string'||!result.messageId||result.messageId.length>300){const error=Error('OpenWA returned no trackable message ID');error.code='MISSING_MESSAGE_ID';throw error;}
    return result.messageId;
  }
  return{status,sessionId,scan,checkSession,readHistory,webhook,
    sendText:(peer,text)=>send('text',peer,text),
    sendFile:(peer,url,filename,options={})=>send(options.type||(/\.(png|jpe?g|webp)$/i.test(filename)?'image':/\.mp4$/i.test(filename)?'video':/\.(mp3|ogg|wav|m4a)$/i.test(filename)?'audio':'document'),peer,options.caption||'',url,filename),
    sendSeen:async peer=>{const result=await request(sessionRoute+'/chats/read',{method:'POST',body:{chatId:peer}});if(result.success!==true)throw Error('Read receipt was declined');return true;},
    getHostNumber:async()=>(await checkSession()).phone||'',
    decryptMedia:async message=>{
      const media=message.openwaMedia;
      if(typeof media?.data==='string'&&media.data.length<=35*1024**2)return'data:'+media.mimetype+';base64,'+media.data;
      const result=await request(sessionRoute+'/messages/'+encodeURIComponent(message.chatId||message.from)+'/'+encodeURIComponent(message.id)+'/media',{binary:true,maxBytes:25*1024**2,timeout:30000});
      return'data:'+result.mime+';base64,'+result.bytes.toString('base64');
    },
    stop:async()=>{
      stopped=true;
      const operations=[...active];
      // Shutdown must not turn an accepted send into an unknown outcome merely
      // by cancelling its response. Stop reads promptly, but let mutations
      // finish under their existing deadlines (55 seconds for message sends).
      for(const operation of operations)if(['GET','HEAD'].includes(operation.method))operation.controller.abort();
      await Promise.all(operations.filter(operation=>!['GET','HEAD'].includes(operation.method)).map(operation=>operation.settled));
    },
    getReadiness:()=>({ready:!stopped&&session?.status==='ready'&&lastSessionCheck>now()-30000&&status.checkedAt!==null&&status.error===null&&now()>=notReadyUntil,pending:stopped?['adapter stopped']:session?.status!=='ready'?['provider session']:now()<notReadyUntil?['provider readiness grace']:status.error!==null||status.checkedAt===null?['inbox synchronization']:[],blockers:[]}),
    getState:()=>stopped?'stopped':session?.status||'disconnected',
  };
}
