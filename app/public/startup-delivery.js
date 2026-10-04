// Only explicit deliveryAt metadata paces a row. Ordinary future-dated messages
// remain ordinary messages; no network request is made at a reveal boundary.
export const MAX_CLOCK_OFFSET_MS=3660*86400000;
export const DELIVERY_TYPING_LEAD_MS=5000;
const timestamp=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000;
export const validClockOffset=value=>Number.isSafeInteger(value)&&Math.abs(value)<=MAX_CLOCK_OFFSET_MS;
const dueAt=message=>message?.role==='assistant'&&timestamp(message.deliveryAt)?message.deliveryAt:null;
export function orderDeliveredMessages(messages){
  const time=message=>typeof message.created==='number'?message.created:Date.parse(message.created)||0;
  const id=message=>Number.isSafeInteger(Number(message.id))?Number(message.id):Number.MAX_SAFE_INTEGER;
  return [...messages].sort((a,b)=>time(a)-time(b)||id(a)-id(b));
}

export function startupDeliveryState(messages,now){
  const visible=[];let nextDueAt=null,nextSendingAt=null,pending=false,readLimit=null;
  for(const message of messages||[]){
    const due=dueAt(message);
    if(due!==null&&due>now){nextDueAt=nextDueAt===null?due:Math.min(nextDueAt,due);if(!message.deleted){pending=true;nextSendingAt=nextSendingAt===null?due:Math.min(nextSendingAt,due);}if(Number.isSafeInteger(message.id)&&message.id>0)readLimit=readLimit===null?message.id-1:Math.min(readLimit,message.id-1);}
    else visible.push(message);
  }
  const sending=nextSendingAt!==null&&nextSendingAt-now<=DELIVERY_TYPING_LEAD_MS;
  const nextWakeAt=nextDueAt===null?null:nextSendingAt!==null&&!sending?Math.min(nextDueAt,nextSendingAt-DELIVERY_TYPING_LEAD_MS):nextDueAt;
  return {messages:visible,nextDueAt,pending,sending,nextWakeAt,readLimit};
}

export function createStartupDelivery({getChat=()=>null,onReveal=()=>{},canRun=()=>true,now=Date.now,monotonic=()=>globalThis.performance?.now?.()??now(),setTimer=setTimeout,clearTimer=clearTimeout,documentTarget=globalThis.document,windowTarget=globalThis.window}={}){
  let chatId=null,anchorServer=now(),anchorElapsed=monotonic(),lastServerTime=0,timer=null,started=false,destroyed=false,pageHidden=false;
  const serverNow=()=>anchorServer+Math.max(0,monotonic()-anchorElapsed);
  const available=()=>started&&!destroyed&&!pageHidden&&!documentTarget?.hidden&&documentTarget?.visibilityState!=='hidden'&&canRun();
  const state=(chat=getChat())=>startupDeliveryState(chat?.messages||[],serverNow());
  function cancel(){if(timer!==null)clearTimer(timer);timer=null;}
  function schedule(){
    cancel();if(!available())return;const next=state().nextWakeAt;if(next===null)return;
    timer=setTimer(()=>{timer=null;if(!available())return;onReveal();schedule();},Math.max(1,Math.min(2147483647,Math.ceil(next-serverNow()))));
  }
  function accept(view,{cached=false}={}){
    const nextId=view?.id??null;
    if(nextId!==chatId){chatId=nextId;lastServerTime=0;anchorServer=now();anchorElapsed=monotonic();}
    if(cached){
      const offset=validClockOffset(view?.clockOffsetMs)?view.clockOffsetMs:0;
      anchorServer=now()+offset;anchorElapsed=monotonic();lastServerTime=0;
    }else if(timestamp(view?.serverTime)&&view.serverTime>=lastServerTime&&validClockOffset(Math.round(view.serverTime-now()))){
      anchorServer=view.serverTime;anchorElapsed=monotonic();lastServerTime=view.serverTime;
    }
    schedule();return clockOffsetMs();
  }
  function clockOffsetMs(){const offset=Math.round(serverNow()-now());return validClockOffset(offset)?offset:0;}
  const visibility=()=>{if(!available()){cancel();return;}onReveal();schedule();};
  const pageHide=()=>{pageHidden=true;cancel();};
  const pageShow=()=>{pageHidden=false;if(available()){onReveal();schedule();}};
  documentTarget?.addEventListener('visibilitychange',visibility);
  windowTarget?.addEventListener('pagehide',pageHide);windowTarget?.addEventListener('pageshow',pageShow);
  return {
    accept,state,now:serverNow,clockOffsetMs,
    view(view=getChat()){const projection=state(view);return view?{...view,messages:projection.messages,startupReadLimit:projection.readLimit}:view;},
    start(){started=true;schedule();},
    refresh:schedule,
    stop(){started=false;cancel();},
    destroy(){if(destroyed)return;destroyed=true;started=false;cancel();documentTarget?.removeEventListener('visibilitychange',visibility);windowTarget?.removeEventListener('pagehide',pageHide);windowTarget?.removeEventListener('pageshow',pageShow);},
  };
}
