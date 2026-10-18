// Matches the existing-chat request in whatsapp-web.js Client.syncHistory.
// It asks the owner's phone for history; it does not send a customer message.
export async function requestNativeChatHistory({peer}){
 const collections=globalThis.require?.('WAWebCollections'),factory=globalThis.require?.('WAWebWidFactory');
 const chat=collections?.Chat?.get(factory.createWid(peer));
 if(!chat)return{requested:false,reason:'This chat has not reached the linked WhatsApp session yet.'};
 if(chat.endOfHistoryTransferType!==0)return{requested:false,reason:'WhatsApp has not offered additional history for this chat.'};
 const utils=globalThis.require('WAWebNonMessageDataRequestHistorySyncOnDemandUtils'),failures=utils.historySyncOnDemandRequestsFailureRecord;
 if(failures?.disableRequestSending)return{requested:false,reason:'WhatsApp has temporarily paused history requests. Try later.'};
 const inflight=utils.inFlightHistorySyncOnDemandRequests,key=chat.id?._serialized;
 if(inflight?.has?.(key)||inflight?.get?.(key)||inflight&&key&&Object.hasOwn(inflight,key))return{requested:false,reason:'WhatsApp is already checking this chat’s history.'};
 await globalThis.require('WAWebSendNonMessageDataRequest').sendPeerDataOperationRequest(3,{chatId:chat.id});
 return{requested:true,reason:'History requested from your phone. Additional messages may arrive shortly.'};
}

export function createPhoneHistory({evaluate,get=()=>null,put=()=>{},now=()=>Date.now(),cooldownMs=600000,timeoutMs=10000}){
 let busy=false,lastGlobalAttempt=0;
 return{get busy(){return busy;},async request(peer){
  const key='phone-history:'+peer,last=get(key)?.attemptedAt||0,at=now();
  if(busy)return{requested:false,reason:'A WhatsApp history check is already running.'};
  if(last&&at-last<cooldownMs)return{requested:false,reason:'This chat was checked recently. Waiting avoids repeated phone requests.'};
  if(lastGlobalAttempt&&at-lastGlobalAttempt<15000)return{requested:false,reason:'Please wait a few seconds before checking another chat.'};
  busy=true;lastGlobalAttempt=at;put({key,kind:'settings',peer,attemptedAt:at});
  let timer;
  try{return await Promise.race([evaluate(requestNativeChatHistory,{peer}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('History check timed out')),timeoutMs);})]);}
  catch{return{requested:false,reason:'WhatsApp could not refresh this chat. The saved login is unchanged.'};}
  finally{clearTimeout(timer);busy=false;}
 }};
}
