// A quiet inbox is healthy. Recover only from failed functional probes, never
// from an arbitrary period without customer traffic.
export function createReceiverWatchdog({probe,reconnect,canReconnect=()=>true,now=()=>Date.now(),recoveryDelayMs=30000}){
 const status={healthy:null,lastCheckedAt:null,lastHealthyAt:null,consecutiveFailures:0,reconnects:0,nextRetryAt:0,error:''};
 let busy=false,failedSince=null;
 return{status,get busy(){return busy;},async tick(){
  if(busy)return;busy=true;
  try{
   let result;try{result=await probe();}catch{result={ready:false};}
   const healthy=!!result?.ready&&(!result.socket||result.socket==='CONNECTED');
   status.lastCheckedAt=now();status.healthy=healthy;
   if(healthy){status.lastHealthyAt=now();status.consecutiveFailures=0;status.nextRetryAt=0;status.error='';failedSince=null;return;}
   failedSince??=now();
   status.consecutiveFailures++;status.error='Restoring the WhatsApp connection using the saved login.';
   if(status.consecutiveFailures<3||now()-failedSince<recoveryDelayMs||now()<status.nextRetryAt||!canReconnect())return;
   const retry=Math.min(300000,30000*2**Math.min(4,status.reconnects));
   status.nextRetryAt=now()+retry;status.reconnects++;
   try{await reconnect();}catch{status.error='WhatsApp reconnect failed; retry scheduled.';}
  }finally{busy=false;}
 }};
}
