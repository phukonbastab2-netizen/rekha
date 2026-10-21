import entry from './entry.mjs';
import {FunnelConversation as ExistingConversation,CloudApiControl} from './worker.mjs';
export {CloudApiControl};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
async function authenticated(request,env){
 if(!env.ADMIN_TOKEN)return false;
 const digest=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
 const [a,b]=await Promise.all([digest(request.headers.get('authorization')||''),digest('Bearer '+env.ADMIN_TOKEN)]);let diff=0;
 for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
export class FunnelConversation extends ExistingConversation {
 async fetch(request){
  const url=new URL(request.url);
  if(request.method==='GET'&&url.pathname==='/owner-inbox-read')return this.exclusive(async()=>{
   // Direct reads avoid load()/schedule(): opening the inbox cannot mutate the
   // automated funnel, mark anything read, release a hold or create a job.
   const state=await this.storage.get('state');
   if(!state?.waId||state.phoneNumberId!==this.env.WA_PHONE_NUMBER_ID)return json({found:false});
   const after=url.searchParams.get('after')||'';
   const records=[...await this.storage.list({prefix:'inbound:',limit:200,...(after?{startAfter:after}:{})})];
   return json({found:true,phoneNumberId:state.phoneNumberId,waId:state.waId,lastInboundAt:state.lastInboundAt,optedOut:state.optedOut,restricted:state.restricted,
    nameApprovalRequired:Boolean(state.nameApprovalRequired),firstStarted:state.firstStarted,reminderScheduled:state.reminderScheduled,mediaScheduled:state.mediaScheduled,
    jobs:state.jobs,ownerReceipts:state.ownerReceipts||{},records,next:records.length===200?records.at(-1)[0]:null});
  });
  return super.fetch(request);
 }
}
export default {async fetch(request,env,ctx){
 const url=new URL(request.url);
 if(['/admin/inbox-index','/admin/inbox-sync'].includes(url.pathname)){
  if(request.method!=='GET')return json({error:'method_not_allowed'},405);
  if(!await authenticated(request,env))return json({error:'unauthorized'},401);
  if(url.pathname==='/admin/inbox-index'){
   const response=await env.CONTROL.get(env.CONTROL.idFromName('account:'+env.WA_PHONE_NUMBER_ID)).fetch('https://control.internal/state');
   return json({phoneNumberId:env.WA_PHONE_NUMBER_ID,ownerTestOnly:Boolean(env.TEST_CONVERSATION_ID),testConversationId:env.TEST_CONVERSATION_ID||null,account:await response.json()});
  }
  const id=url.searchParams.get('id');if(!/^[a-f0-9]{64}$/i.test(id||''))return json({error:'invalid_object_id'},400);
  const after=url.searchParams.get('after')||'';if(after.length>600||(after&&!after.startsWith('inbound:')))return json({error:'invalid_cursor'},400);
  return env.CONVERSATIONS.get(env.CONVERSATIONS.idFromString(id)).fetch('https://conversation.internal/owner-inbox-read?'+new URLSearchParams({after}));
 }
 return entry.fetch(request,env,ctx);
}};
