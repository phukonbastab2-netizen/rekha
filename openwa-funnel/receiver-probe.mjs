import {randomBytes} from 'node:crypto';

// This travels only through the existing local runtime bindings. It has no
// WhatsApp peer or message ID and is intercepted before persistence or sending.
export async function emitReceiverProbe({token}){
 const routes=[['in','OpenWA_RuntimeMessageReceived'],['out','OpenWA_RuntimeAnyMessage']];
 if(routes.some(([,name])=>typeof globalThis[name]!=='function'))return false;
 await Promise.all(routes.map(([direction,name])=>globalThis[name]({__rekhaReceiverProbe:token,__rekhaProbeDirection:direction,fromMe:direction==='out'})));
 return true;
}

export function createReceiverProbe({now=()=>Date.now(),timeoutMs=2000,intervalMs=30000}={}){
 let pending=null,last=null,checking=null;
 function consume(message,direction){
  if(!pending||message?.__rekhaReceiverProbe!==pending.token||message.__rekhaProbeDirection!==direction)return false;
  pending.seen.add(direction);
  if(pending.seen.size===2)pending.finish(true);
  return true;
 }
 function cancel(){pending?.finish(false);}
 async function check(evaluate,{force=false}={}){
  if(checking)return checking;
  if(!force&&last&&now()-last.checkedAt<intervalMs)return last;
  checking=(async()=>{
   const token=randomBytes(16).toString('hex');
   const cancelThis=()=>{if(pending?.token===token)pending.finish(false);};
   let timer;
   const witnessed=new Promise(resolve=>{
    pending={token,seen:new Set(),finish:ready=>{clearTimeout(timer);pending=null;resolve(ready);}};
    timer=setTimeout(cancelThis,timeoutMs);
   });
   // Do not trust a resolved browser binding: the SDK callback must be observed
   // in both gateway handlers as well.
   void Promise.resolve().then(()=>evaluate(emitReceiverProbe,{token})).then(callable=>{if(!callable)cancelThis();},cancelThis);
   const ready=await witnessed;
   last={ready,checkedAt:now()};return last;
  })();
  try{return await checking;}finally{checking=null;}
 }
 return{consume,check,cancel};
}

export function readMirrorSnapshot(){
 const root=globalThis,store=root.Store,models=c=>c?.getModelsArray?.()||c?._models||[];
 const allowed=new Set(['chat','text','image','video','audio','ptt','document','sticker','payment','vcard','multi_vcard','location','live_location']);
 let lastIncomingAt=0,lastOutgoingAt=0;
 const messages=models(store?.Msg);
 for(const message of messages){
  if(!allowed.has(message.type)||message.isNotification||message.isPSA)continue;
  const at=Number(message.t||0)*1000;if(!Number.isFinite(at)||at<=0||at>Date.now()+300000)continue;
  if(message.id?.fromMe)lastOutgoingAt=Math.max(lastOutgoingAt,at);else lastIncomingAt=Math.max(lastIncomingAt,at);
 }
 return{checkedAt:Date.now(),lastIncomingAt:lastIncomingAt||null,lastOutgoingAt:lastOutgoingAt||null,lastProviderMessageAt:Math.max(lastIncomingAt,lastOutgoingAt)||null,loadedMessages:messages.length,providerChats:models(store?.Chat).length};
}
