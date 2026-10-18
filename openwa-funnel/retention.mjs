// Maintenance yields between bounded database passes. It never reserves jobs,
// sends messages, changes consent or starts a new customer sequence.
export function createRetentionScheduler({prune,schedule=setTimeout,cancel=clearTimeout,now=Date.now,activeDelayMs=1000,idleDelayMs=60000}={}){
  if(typeof prune!=='function'||!Number.isFinite(activeDelayMs)||activeDelayMs<250||!Number.isFinite(idleDelayMs)||idleDelayMs<activeDelayMs)throw Error('Invalid retention scheduler');
  let timer=null,closed=false;
  const status={checkedAt:null,scanned:0,expired:0,more:false,error:null};
  function arm(delay){if(!closed){timer=schedule(run,delay);timer?.unref?.();}}
  function run(){
    timer=null;if(closed)return;
    let delay=idleDelayMs;
    try{
      const result=prune({limit:200,budgetMs:75});
      Object.assign(status,{checkedAt:now(),scanned:result.scanned,expired:result.expired,more:result.more,error:null});
      if(result.more)delay=activeDelayMs;
    }catch{Object.assign(status,{checkedAt:now(),error:'Saved-content maintenance will retry.'});}
    arm(delay);
  }
  arm(activeDelayMs);
  return{status,close(){closed=true;if(timer!==null)cancel(timer);timer=null;}};
}
