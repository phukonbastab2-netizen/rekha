// A chat timer uses the persisted message timestamp, never the time it is opened.
export const KUNDLI_WAIT_MS=300000;
const remainingLabel='समय बाकी · Samay baaki';
const completeLabel='5 मिनट पूरे · 5 minute poore';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const controllers=new WeakMap();

export function kundliWaitDeadline(message){
  if(message?.kind!=='kundli-wait'||message.deleted)return null;
  const value=message.created;
  const created=typeof value==='number'?value:typeof value==='string'&&value.trim()?(/^\d+$/.test(value)?Number(value):Date.parse(value)):NaN;
  return Number.isFinite(created)&&created>=0&&created<=8640000000000000-KUNDLI_WAIT_MS?created+KUNDLI_WAIT_MS:null;
}

export function kundliWaitState(deadline,now=Date.now()){
  const remainingMs=Math.min(KUNDLI_WAIT_MS,Math.max(0,Number(deadline)-Number(now)));
  const seconds=Number.isFinite(remainingMs)?Math.ceil(remainingMs/1000):0;
  return {remainingMs:Number.isFinite(remainingMs)?remainingMs:0,seconds,text:`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`,complete:seconds===0};
}

export function kundliWaitBody(message){
  const deadline=kundliWaitDeadline(message);
  if(deadline===null)return escape(message?.body);
  // Keep source markup stable for the same message. bindCountdowns sets the
  // current value synchronously after insertion, before the next paint.
  const state=kundliWaitState(deadline,deadline-KUNDLI_WAIT_MS),label=remainingLabel;
  return `<section class="kundli-wait ${state.complete?'is-complete':''}" data-kundli-wait="${deadline}" aria-label="कुंडली का समय · Kundli ka samay"><p class="kundli-wait-title">${escape(message.body)}</p><div class="kundli-wait-row"><time class="kundli-wait-clock" data-wait-clock role="timer" aria-live="off" aria-label="${label} ${state.text}" datetime="PT${state.seconds}S">${state.text}</time><span class="kundli-wait-label" data-wait-label>${label}</span></div><progress class="kundli-wait-progress" data-wait-progress max="${KUNDLI_WAIT_MS}" value="${state.remainingMs}" aria-label="${remainingLabel}"></progress></section>`;
}

function createController(doc){
  const view=doc.defaultView||globalThis,active=new Map(),containers=new WeakMap();
  let timeout=null,listening=false,pageHidden=false;
  const visible=()=>!pageHidden&&doc.visibilityState!=='hidden';
  function stop(){if(timeout!==null){view.clearTimeout(timeout);timeout=null;}}
  function listen(enabled){
    if(enabled===listening)return;listening=enabled;
    const method=enabled?'addEventListener':'removeEventListener';
    doc[method]('visibilitychange',visibilityChanged);
    view[method]('pagehide',pageHide);
    view[method]('pageshow',pageShow);
  }
  function render(record,now){
    const state=kundliWaitState(record.deadline,now);
    if(record.seconds!==state.seconds){
      record.seconds=state.seconds;
      const label=state.complete?completeLabel:remainingLabel;
      if(record.clock){record.clock.textContent=state.text;record.clock.setAttribute('datetime',`PT${state.seconds}S`);record.clock.setAttribute('aria-label',`${label} ${state.text}`);}
      if(record.label)record.label.textContent=label;
      record.node.classList.toggle('is-complete',state.complete);
    }
    if(record.progress)record.progress.value=state.remainingMs;
    return state;
  }
  function refresh(){
    stop();const now=Date.now();let nextDelay=1000;
    for(const [node,record] of active){
      if(!node.isConnected){active.delete(node);continue;}
      const state=render(record,now);
      if(state.complete){active.delete(node);continue;}
      nextDelay=Math.min(nextDelay,state.remainingMs%1000||1000);
    }
    listen(active.size>0);
    if(active.size&&visible())timeout=view.setTimeout(()=>{timeout=null;refresh();},Math.max(20,nextDelay));
  }
  function visibilityChanged(){if(visible())refresh();else stop();}
  function pageHide(){pageHidden=true;stop();}
  function pageShow(){pageHidden=false;refresh();}
  function bind(container){
    const nodes=new Set(container.querySelectorAll('[data-kundli-wait]'));
    for(const previous of containers.get(container)||[])if(!nodes.has(previous))active.delete(previous);
    containers.set(container,nodes);
    const now=Date.now();
    for(const node of nodes){
      const deadline=Number(node.dataset.kundliWait);
      if(!Number.isFinite(deadline)||deadline<0)continue;
      const record=active.get(node)||{node,deadline,seconds:null,clock:node.querySelector('[data-wait-clock]'),label:node.querySelector('[data-wait-label]'),progress:node.querySelector('[data-wait-progress]')};
      record.deadline=deadline;
      const state=render(record,now);
      if(node.isConnected&&!state.complete)active.set(node,record);else active.delete(node);
    }
    refresh();
  }
  return {bind};
}

// One document scheduler updates only digits/progress; it never redraws a chat.
export function bindCountdowns(container){
  if(!container?.ownerDocument)return;
  const doc=container.ownerDocument;
  let controller=controllers.get(doc);
  if(!controller){controller=createController(doc);controllers.set(doc,controller);}
  controller.bind(container);
}
