// One request at a time. Idle tabs back off, and hidden/offline tabs do no work.
// Injected clocks and event targets keep the scheduling contract portable.
export function createAdaptivePoll({task,canRun=()=>true,hot=()=>false,fastMs=2200,hotMs=fastMs,idleMs=30000,activeForMs=20000,maxErrorMs=120000,random=Math.random,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,documentTarget=globalThis.document,windowTarget=globalThis.window,online=()=>globalThis.navigator?.onLine!==false}={}){
  if(typeof task!=='function')throw new TypeError('A polling task is required.');
  let started=false,destroyed=false,timer=null,due=0,running=null,urgent=false,lastActivity=now(),idle=0,errors=0;
  const available=()=>started&&!destroyed&&!documentTarget?.hidden&&online()&&canRun();
  const jitter=delay=>Math.max(25,Math.round(delay*(.8+Math.max(0,Math.min(1,random()))*.4)));
  const delay=()=>errors?jitter(Math.min(maxErrorMs,fastMs*2**Math.min(errors,8))):jitter(hot()?hotMs:now()-lastActivity<activeForMs?fastMs:Math.min(idleMs,fastMs*1.7**Math.min(idle,12)));
  function cancel(){if(timer!==null)clearTimer(timer);timer=null;due=0;}
  function schedule(wait=delay()){
    if(!available()||running)return;
    const next=now()+wait;if(timer!==null&&due<=next)return;cancel();due=next;timer=setTimer(run,wait);
  }
  async function run(){
    cancel();if(!available()||running)return;
    const controller=new AbortController();running=controller;urgent=false;
    try{const result=await task({signal:controller.signal});if(!controller.signal.aborted){errors=0;if(result===true||result?.changed){lastActivity=now();idle=0;}else idle++;if(result?.again)urgent=true;}}
    catch(error){if(!controller.signal.aborted&&error?.name!=='AbortError')errors++;}
    finally{if(running===controller)running=null;if(available())schedule(urgent?jitter(150):delay());}
  }
  function poke({immediate=false,activity=true}={}){if(destroyed)return;if(activity){lastActivity=now();idle=0;}if(!available())return;if(running){if(immediate)urgent=true;return;}schedule(immediate?jitter(100):delay());}
  function suspend(){cancel();running?.abort();}
  const visibility=()=>{if(documentTarget?.hidden)suspend();else poke({immediate:true});};
  const connection=()=>{if(!online())suspend();else poke({immediate:true});};
  const interaction=()=>poke();
  documentTarget?.addEventListener('visibilitychange',visibility);
  for(const event of ['pointerdown','keydown','input'])documentTarget?.addEventListener(event,interaction,{passive:true});
  windowTarget?.addEventListener('online',connection);windowTarget?.addEventListener('offline',connection);
  return{
    start({immediate=false}={}){if(destroyed)return;started=true;poke({immediate});},
    poke,
    stop(){started=false;urgent=false;suspend();},
    destroy(){if(destroyed)return;started=false;destroyed=true;suspend();documentTarget?.removeEventListener('visibilitychange',visibility);for(const event of ['pointerdown','keydown','input'])documentTarget?.removeEventListener(event,interaction);windowTarget?.removeEventListener('online',connection);windowTarget?.removeEventListener('offline',connection);},
  };
}
