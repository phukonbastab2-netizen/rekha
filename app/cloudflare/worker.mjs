import { rewardCallback } from './rewards.mjs';
import { ownerRoutes, mediaResponse } from './owner.mjs';
import { messagingRoutes, messagingView, messagingDeleteAttachments, messagingHistory } from './messaging.mjs';
import { callsRoutes } from './calls.mjs';
import { workflowRoutes, flowOnStart, flowOnCustomer, workflowProcessDue, workflowIsEnrolled, workflowRecoverMessages } from './workflow.mjs';
import { appSettingsRoutes, appSettingsPublic, appSettingsDefaults } from './app-settings.mjs';
import { generateReply } from '../src/ai.mjs';
const fail=(status,message)=>Object.assign(new Error(message),{status});
const encoder=new TextEncoder();
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
const welcome={en:'Namaste. This is a quiet space for your questions. What’s on your mind today? A full kundli also needs birth time and birthplace; no chart has been calculated yet.',hi:'नमस्ते। आज आप किस विषय पर बात करना चाहते हैं? पूरी कुंडली के लिए जन्म समय और जन्म स्थान भी चाहिए। अभी कुंडली की गणना नहीं हुई है।',hinglish:'Namaste. Aaj aap kis baare mein baat karna chahte hain? Poori kundli ke liye birth time aur birthplace bhi chahiye. Abhi chart calculate nahi hua hai.'};
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Strict-Transport-Security':'max-age=31536000','Permissions-Policy':'camera=(self), microphone=(self), geolocation=(self)','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
function prefs(value={}){let location=null;if(value.location!=null){const {latitude,longitude}=value.location;if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180)throw fail(400,'Invalid location.');location={latitude:Math.round(latitude*10)/10,longitude:Math.round(longitude*10)/10};}return{remember:value.remember===true,location,consentVersion:'2026-09-24'};}
function cookie(name,value,remember=false,remove=false){return`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict${remove?'; Max-Age=0':remember?'; Max-Age=2592000':''}`;}
function validDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1900-01-01')return false;const date=new Date(`${value}T00:00:00Z`),cutoff=new Date();cutoff.setUTCFullYear(cutoff.getUTCFullYear()-18);return Number.isFinite(+date)&&date.toISOString().slice(0,10)===value&&date<=cutoff;}
// Registered idle/manual/blocked profiles never enter this indexed window.
// A persisted cursor makes skipped guided/drafted/backoff rows fair and bounded.
export const replyCandidateSql="WITH candidates AS MATERIALIZED (\n SELECT * FROM conversations INDEXED BY conversations_reply_waiting\n WHERE waiting_count>0 AND mode IN ('ai','assist') AND inbox_blocked=0\n AND (updated,id)>(?,?) ORDER BY updated,id LIMIT 200\n)\nSELECT c.id,c.updated,CASE WHEN\n NOT(c.mode='ai' AND EXISTS(SELECT 1 FROM chat_workflow f WHERE f.conversation_id=c.id))\n AND (c.entitlement!='free' OR c.free_used<?+(SELECT COUNT(*) FROM reward_grants r WHERE r.conversation_id=c.id) OR EXISTS(SELECT 1 FROM chat_workflow f WHERE f.conversation_id=c.id))\n AND NOT EXISTS(SELECT 1 FROM rate_limits l WHERE l.key='reply-lease:'||c.id AND l.expires>?)\n AND NOT(c.mode='assist' AND EXISTS(SELECT 1 FROM drafts d WHERE d.conversation_id=c.id AND d.version=c.version AND d.message_id=(SELECT id FROM messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.status IN ('pending','failed') ORDER BY id DESC LIMIT 1)))\n THEN 1 ELSE 0 END AS eligible FROM candidates c ORDER BY c.updated,c.id";
export const retentionSql='SELECT id FROM conversations WHERE updated<? ORDER BY updated,id LIMIT 25';
export const chatDueCheckSql="SELECT 1 FROM workflow_jobs WHERE conversation_id=? AND status='pending' AND due<=? UNION ALL SELECT 1 FROM workflow_jobs WHERE conversation_id=? AND status='processing' AND lease_until<=? UNION ALL SELECT 1 FROM workflow_recovery WHERE conversation_id=? LIMIT 1";

async function finishChatReply(ctx,chat,message,text,kind,lease=null){
  const {env,stmt}=ctx,replyId=`reply:${message.id}`,leaseGuard=lease?' AND EXISTS(SELECT 1 FROM rate_limits WHERE key=? AND count=? AND expires=?)':'',leaseArgs=lease?[lease.key,lease.messageId,lease.until]:[];
  const batch=await env.DB.batch([
    stmt(`INSERT OR IGNORE INTO messages(conversation_id,role,kind,body,status,client_id,created)
      SELECT ?,'assistant',?,?,'sent',?,? WHERE EXISTS(SELECT 1 FROM conversations WHERE id=? AND version=? AND mode=?)
      AND EXISTS(SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND status IN ('pending','failed'))${leaseGuard}`,chat.id,kind,text,replyId,Date.now(),chat.id,chat.version,chat.mode,message.id,chat.id,...leaseArgs),
    // changes() belongs to the immediately preceding INSERT in this atomic batch.
    // Concurrent completions or an obsolete reply cannot increment the chat twice.
    stmt("UPDATE conversations SET version=version+1,free_used=(SELECT COUNT(*) FROM messages WHERE conversation_id=? AND role='assistant' AND kind NOT IN ('welcome','owner-message','media')),updated=? WHERE id=? AND changes()=1",chat.id,Date.now(),chat.id),
    stmt("UPDATE messages SET status='answered' WHERE conversation_id=? AND role='user' AND id<=? AND status IN ('pending','failed') AND EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND client_id=?)",chat.id,message.id,chat.id,replyId),
    stmt('DELETE FROM drafts WHERE conversation_id=? AND message_id<=? AND EXISTS(SELECT 1 FROM messages WHERE conversation_id=? AND client_id=?)',chat.id,message.id,chat.id,replyId),
  ]);
  return !!batch[0].meta.changes;
}
async function generateChatReply(ctx,id){
  if(ctx.queryBudget&&!ctx.queryBudget.can(20))return false;
  const {stmt,one,all,appSettings}=ctx;
  const get=()=>one('SELECT *, (SELECT COUNT(*) FROM reward_grants WHERE conversation_id=conversations.id) AS rewards FROM conversations WHERE id=?',id);
  let chat=await get();if(!chat||chat.mode==='manual')return false;
  const [message,guided,blocked,draft]=await Promise.all([
    one("SELECT * FROM messages WHERE conversation_id=? AND role='user' AND status IN ('pending','failed') ORDER BY id DESC LIMIT 1",id),
    workflowIsEnrolled(one,id),one('SELECT blocked FROM chat_messaging WHERE conversation_id=?',id),
    chat.mode==='assist'?one('SELECT message_id,version FROM drafts WHERE conversation_id=?',id):null,
  ]);
  if(!message||(chat.mode==='ai'&&guided)||blocked?.blocked||(!guided&&chat.entitlement==='free'&&chat.free_used>=appSettings.service.freeReplies+(chat.rewards||0))||draft?.message_id===message.id&&draft.version===chat.version)return false;
  // Durable, atomic D1 lease: correctness does not depend on one Worker isolate.
  // Pending rows survive interrupted waitUntil work and are recovered by polls/cron.
  const now=Date.now(),lease={key:'reply-lease:'+id,messageId:message.id,until:now+60000};
  const claimed=await stmt('INSERT INTO rate_limits(key,count,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires=excluded.expires WHERE rate_limits.expires<=? RETURNING count',lease.key,lease.messageId,lease.until,now).first();
  if(!claimed)return false;let failed=false;
  try{
    chat=await get();if(!chat||chat.mode==='manual'||chat.mode==='ai'&&await workflowIsEnrolled(one,id))return false;
    if((await one('SELECT blocked FROM chat_messaging WHERE conversation_id=?',id))?.blocked)return false;
    const current=await one("SELECT * FROM messages WHERE conversation_id=? AND role='user' AND status IN ('pending','failed') ORDER BY id DESC LIMIT 1",id);
    if(current?.id!==message.id)return false;
    const history=(await all('SELECT id,role,kind,body,status,created FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 16',id)).reverse();
    const reply=await generateReply({aiMode:'demo'},chat,history);
    if(chat.mode==='assist'){
      const saved=await stmt(`INSERT OR REPLACE INTO drafts(conversation_id,message_id,body,kind,version)
        SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM conversations WHERE id=? AND mode='assist' AND version=?)
        AND EXISTS(SELECT 1 FROM messages WHERE id=? AND status IN ('pending','failed'))
        AND EXISTS(SELECT 1 FROM rate_limits WHERE key=? AND count=? AND expires=?)`,id,message.id,reply.body,reply.kind,chat.version,id,chat.version,message.id,lease.key,lease.messageId,lease.until).run();return !!saved.meta.changes;
    }
    return await finishChatReply(ctx,chat,message,reply.body,reply.kind,lease);
  }catch{
    failed=true;await ctx.env.DB.batch([
      stmt("UPDATE messages SET status='failed' WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM conversations WHERE id=? AND version=?) AND EXISTS(SELECT 1 FROM rate_limits WHERE key=? AND count=? AND expires=?)",message.id,id,chat.version,lease.key,lease.messageId,lease.until),
      stmt('UPDATE conversations SET version=version+1,updated=? WHERE id=? AND changes()=1',Date.now(),id),
      stmt('UPDATE rate_limits SET count=-count,expires=? WHERE key=? AND count=? AND expires=?',Date.now()+30000,lease.key,lease.messageId,lease.until),
    ]);return false;
  }finally{if(!failed)await stmt('DELETE FROM rate_limits WHERE key=? AND count=? AND expires=?',lease.key,lease.messageId,lease.until).run();}
}
export async function handleApi(request,env,executionContext){
  const url=new URL(request.url),route=url.pathname,method=request.method,db=env.DB;
  const queryBudget={used:0,limit:50,can(reserve){return this.used+reserve<=this.limit;}},stmt=(sql,...args)=>{queryBudget.used++;return db.prepare(sql).bind(...args);},one=(sql,...args)=>stmt(sql,...args).first(),all=async(sql,...args)=>(await stmt(sql,...args).all()).results;
  let releaseBackground;const backgroundStart=new Promise(resolve=>{releaseBackground=resolve;});
  let appSettings=appSettingsDefaults,settingsRevision=0;
  const result=(data,status=200,extra={})=>Response.json(data,{status,headers:{...headers,...extra}});
  const cookies=Object.fromEntries((request.headers.get('Cookie')||'').split(';').map(x=>x.trim().split('=')));
  const get=id=>one('SELECT *, (SELECT COUNT(*) FROM reward_grants WHERE conversation_id=conversations.id) AS rewards FROM conversations WHERE id=?',id);
  const messages=id=>all("SELECT id,role,kind,body,status,created,change_revision AS changeRevision,CASE WHEN role='user' THEN client_id ELSE NULL END AS clientId FROM messages WHERE conversation_id=? ORDER BY id",id);
  const pending=id=>one("SELECT * FROM messages WHERE conversation_id=? AND role='user' AND status IN ('pending','failed') ORDER BY id DESC LIMIT 1",id);
  const insert=(id,role,kind,body,status='sent',clientId=null)=>stmt('INSERT INTO messages(conversation_id,role,kind,body,status,client_id,created) VALUES(?,?,?,?,?,?,?)',id,role,kind,body,status,clientId,Date.now());
  async function view(chat,admin=false,options={}){
    const bounded=request.headers.get('X-Rekha-History')==='bounded-v1',history=bounded?await messagingHistory({request,chat,all,fail,options}):{rows:messages(chat.id)};
    const [guidedConversation,messaging,draft]=await Promise.all([workflowIsEnrolled(one,chat.id),messagingView({chat,messages:history.rows,admin,one,all,bounded,acknowledgedId:options.acknowledgedId}),admin?one('SELECT * FROM drafts WHERE conversation_id=?',chat.id):null]),freeTurns=appSettings.service.freeReplies;
    return{id:chat.id,name:chat.name,dob:chat.dob,language:chat.language,preferences:JSON.parse(chat.preferences),version:chat.version,updated:chat.updated,...(admin?{mode:chat.mode,inboxRevision:chat.inbox_revision||0}:{}),guidedConversation,rewardedReplies:chat.rewards||0,freeUsed:chat.free_used,freeRemaining:Math.max(0,freeTurns+(chat.rewards||0)-chat.free_used),entitlement:chat.entitlement,locked:!guidedConversation&&chat.entitlement==='free'&&chat.free_used>=freeTurns+(chat.rewards||0),...messaging,...(bounded?history.metadata:{}),...(admin?{draft}:{})};
  }
  async function customer(){const c=cookies.ar_session&&await one('SELECT *, (SELECT COUNT(*) FROM reward_grants WHERE conversation_id=conversations.id) AS rewards FROM conversations WHERE token_hash=?',await hash(cookies.ar_session));if(!c)throw fail(401,'Your chat session has ended. Please start again.');return c;}
  async function owner(){if(!cookies.ar_admin||!await one('SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires>?',await hash(cookies.ar_admin),Date.now()))throw fail(401,'Please sign in to the owner panel.');}
  async function rate(key,max,ms=60000){const bucket=Math.floor(Date.now()/ms),hashed=await hash(`${key}:${bucket}`);const row=await stmt('INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',hashed,Date.now()+ms).first();if(row.count>max)throw fail(429,'Too many requests. Please wait and try again.');}
  async function body(){if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw fail(415,'JSON required.');const limit=['/api/admin/app-settings','/api/admin/workflow/settings'].includes(route)&&method==='PATCH'?128*1024:16384,reader=request.body?.getReader();let bytes=0,chunks=[];if(reader){for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit){await reader.cancel();throw fail(413,'Request too large.');}chunks.push(value);}}const content=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){content.set(chunk,offset);offset+=chunk.length;}try{const d=JSON.parse(new TextDecoder().decode(content)||'{}');if(!d||typeof d!=='object'||Array.isArray(d))throw Error();return d;}catch{throw fail(400,'Invalid request.');}}
  const finish=(chat,message,text,kind)=>finishChatReply(workflowCtx,chat,message,text,kind);
  const generate=id=>generateChatReply(workflowCtx,id);
  const workflowCtx={env,stmt,one,all,fail,owner,body,result,get,route,method,queryBudget};
  async function onCustomerMessage(chat,message){await flowOnCustomer(workflowCtx,chat,message);}
  async function scheduleChatWork(id,knownChat=null){
    if(knownChat){
      if(knownChat.mode==='manual'||knownChat.inbox_blocked)return;
      let pendingReply=knownChat.waiting_count>0&&(knownChat.entitlement!=='free'||knownChat.free_used<appSettings.service.freeReplies+(knownChat.rewards||0));
      if(pendingReply&&knownChat.mode==='ai'&&await workflowIsEnrolled(one,id))pendingReply=false;
      if(pendingReply&&knownChat.mode==='assist'&&await one("SELECT 1 FROM drafts WHERE conversation_id=? AND version=? AND message_id=(SELECT id FROM messages WHERE conversation_id=? AND role='user' AND status IN ('pending','failed') ORDER BY id DESC LIMIT 1)",id,knownChat.version,id))pendingReply=false;
      if(!pendingReply&&!await one(chatDueCheckSql,id,Date.now(),id,Date.now(),id))return;
    }
    const run=async()=>{if(!queryBudget.can(8))return;await workflowRecoverMessages(workflowCtx,id);await workflowProcessDue(workflowCtx,{chatId:id});await generate(id);};
    if(executionContext?.waitUntil){executionContext.waitUntil(backgroundStart.then(run).catch(()=>{}));return;}await run();
  }
  try{
    // Receipt/typing updates and sign-in do not need a second settings read.
    const needsSettings=!['/api/health','/api/admin/login','/api/admin/logout','/api/rewards/ssv'].includes(route)&&!/^\/api\/(?:chat|admin\/conversations\/[a-f0-9-]{36})\/(?:read|typing)$/.test(route);
    if(needsSettings){const published=await appSettingsPublic(workflowCtx);appSettings=published.settings;settingsRevision=published.revision;}workflowCtx.appSettings=appSettings;
    if(method==='GET'&&route==='/api/health')return result({ok:true,build:'rekha-scale-0.9.0'});
    if(method==='GET'&&route==='/api/config')return result({aiMode:'demo',paymentMode:'demo',freeTurns:appSettings.service.freeReplies,amount:appSettings.service.unlockPriceRupees*100,retentionDays:appSettings.service.retentionDays,rewardsEnabled:false,appSettings,settingsRevision});
    if(route==='/api/rewards/ssv'&&method==='GET')return await rewardCallback({url,stmt,one});
    if(!env.ADMIN_PASSWORD_HASH)throw fail(503,'Owner setup is incomplete.');
    if(['POST','PUT','PATCH','DELETE'].includes(method)){if(request.headers.get('Origin')!==url.origin)throw fail(403,'Request origin not allowed.');await rate(`write:${request.headers.get('CF-Connecting-IP')||'unknown'}`,240);}
    const edited=await appSettingsRoutes(workflowCtx);if(edited)return edited;
    const workflow=await workflowRoutes(workflowCtx);if(workflow)return workflow;
    const messaging=await messagingRoutes({request,env,route,method,stmt,one,all,result,body,get,view,pending,generate,scheduleChatWork,customer,owner,fail,rate,onCustomerMessage,isGuided:id=>workflowIsEnrolled(one,id),appSettings});if(messaging)return messaging;
    const calls=await callsRoutes({request,env,route,method,stmt,one,all,result,body,get,customer,owner,fail,rate,appSettings});if(calls)return calls;
    if(route==='/api/start'&&method==='POST'){
      await rate(`signup:${request.headers.get('CF-Connecting-IP')||'unknown'}`,12,3600000);const data=await body();
      if(typeof data.name!=='string'||!data.name.trim()||data.name.trim().length>60||!validDate(data.dob)||!['en','hi','hinglish'].includes(data.language)||data.consent!==true)throw fail(400,'Enter a valid name, adult birth date and consent.');
      if(cookies.ar_session&&await one('SELECT 1 FROM conversations WHERE token_hash=?',await hash(cookies.ar_session)))throw fail(409,'You already have a chat. Reload to continue.');
      const id=crypto.randomUUID(),session=token(),preferences=prefs(data.preferences);
      await db.batch([stmt('INSERT INTO conversations(id,token_hash,name,dob,language,preferences,created,updated) VALUES(?,?,?,?,?,?,?,?)',id,await hash(session),data.name.trim(),data.dob,data.language,JSON.stringify(preferences),Date.now(),Date.now()),insert(id,'assistant','welcome',welcome[data.language])]);
      // A missing or archived library item must not prevent a customer signing up.
      try{await flowOnStart(workflowCtx,await get(id));}catch{}
      return result(await view(await get(id)),201,{'Set-Cookie':cookie('ar_session',session,preferences.remember)});
    }
    if(route==='/api/rewards/attempt'&&method==='POST'){
      const chat=await customer();
      if(true||!await one("SELECT 1 FROM reward_settings WHERE key='ssv_verified'"))throw fail(503,'Rewarded ads are still being set up.');
      if(chat.entitlement!=='free')throw fail(409,'Your chat is already unlocked; no ad is needed for extra replies.');
      await rate('reward:'+chat.id,4,60000);
      const attempt=token();await stmt('INSERT INTO reward_attempts(id,conversation_id,created,expires) VALUES(?,?,?,?)',attempt,chat.id,Date.now(),Date.now()+3600000).run();
      return result({attempt},201);
    }
    if(route.startsWith('/api/media/'))return await mediaResponse({request,env,route,one,owner,customer,fail});
    if(route==='/api/chat'&&method==='GET'){const chat=await customer();await scheduleChatWork(chat.id,chat);return result(await view(chat));}
    if(route==='/api/chat'&&method==='DELETE'){const chat=await customer();await messagingDeleteAttachments({env,all,chatId:chat.id});await stmt('DELETE FROM conversations WHERE id=?',chat.id).run();return result({deleted:true},200,{'Set-Cookie':cookie('ar_session','',false,true)});}
    if(route==='/api/preferences'&&method==='PATCH'){const chat=await customer(),data=prefs(await body());await db.batch([stmt('UPDATE conversations SET preferences=?,version=version+1,updated=? WHERE id=?',JSON.stringify(data),Date.now(),chat.id),stmt('DELETE FROM drafts WHERE conversation_id=?',chat.id)]);await scheduleChatWork(chat.id);return result(await view(await get(chat.id)),200,{'Set-Cookie':cookie('ar_session',cookies.ar_session,data.remember)});}
    if(route==='/api/retry'&&method==='POST'){const chat=await customer();await rate(`retry:${chat.id}`,5);if(chat.mode==='manual'||!await pending(chat.id))throw fail(409,'No reply to retry.');await db.batch([stmt("UPDATE messages SET status='pending' WHERE conversation_id=? AND status='failed'",chat.id),stmt('UPDATE conversations SET version=version+1,updated=? WHERE id=? AND changes()=1',Date.now(),chat.id),stmt('DELETE FROM rate_limits WHERE key=? AND count<0','reply-lease:'+chat.id)]);await scheduleChatWork(chat.id);return result(await view(await get(chat.id)),202);}
    if(route==='/api/payment/demo'&&method==='POST'){const chat=await customer();await db.batch([stmt("INSERT OR IGNORE INTO messages(conversation_id,role,kind,body,status,client_id,created) VALUES(?,'system','demo-payment',?,'sent','demo-unlock',?)",chat.id,'₹'+appSettings.service.unlockPriceRupees,Date.now()),stmt("UPDATE conversations SET entitlement='demo',version=version+CASE WHEN entitlement!='demo' OR changes()=1 THEN 1 ELSE 0 END,updated=? WHERE id=?",Date.now(),chat.id)]);await scheduleChatWork(chat.id);return result(await view(await get(chat.id)));}
    if(route.startsWith('/api/payment'))throw fail(409,'Real payments are not enabled in this preview. No charge is taken.');
    if(route==='/api/admin/login'&&method==='POST'){await rate(`login:${request.headers.get('CF-Connecting-IP')||'unknown'}`,6,300000);const data=await body();if(typeof data.password!=='string'||await hash(data.password)!==env.ADMIN_PASSWORD_HASH)throw fail(401,'Incorrect owner password.');const session=token();await stmt('INSERT INTO admin_sessions(token_hash,expires) VALUES(?,?)',await hash(session),Date.now()+8*3600000).run();return result({ok:true},200,{'Set-Cookie':cookie('ar_admin',session)});}
    if(route.startsWith('/api/admin/')){
      await owner();
      const intro=route.match(/^\/api\/admin\/intro\/(welcome|introduction|testimonials)$/);
      if(intro&&method==='PUT'){
        if(request.headers.get('Content-Type')!=='video/mp4')throw fail(415,'MP4 required.');
        const reader=request.body?.getReader();if(!reader)throw fail(400,'Video required.');
        const chunks=[];let size=0;for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>25*1024*1024){await reader.cancel();throw fail(413,'Video exceeds 25 MB.');}chunks.push(next.value);}
        const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
        if(size<12||String.fromCharCode(...bytes.slice(4,8))!=='ftyp')throw fail(400,'Invalid MP4.');
        await env.MEDIA.put('intro/'+intro[1]+'.mp4',bytes,{httpMetadata:{contentType:'video/mp4'}});
        return result({ok:true,size});
      }
      if(['/api/admin/release','/api/admin/releases/admin'].includes(route)&&method==='PUT'){
        if(request.headers.get('Content-Type')!=='application/vnd.android.package-archive')throw fail(415,'APK required.');
        const reader=request.body?.getReader();if(!reader)throw fail(400,'APK required.');
        const chunks=[];let size=0;for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>40*1024*1024){await reader.cancel();throw fail(413,'APK exceeds 40 MB.');}chunks.push(next.value);}
        const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
        if(size<1000||bytes[0]!==80||bytes[1]!==75||bytes[2]!==3||bytes[3]!==4)throw fail(400,'Invalid APK.');
        const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
        await env.MEDIA.put(route.endsWith('/admin')?'releases/RekhaAdmin.apk':'releases/AstroRani.apk',bytes,{httpMetadata:{contentType:'application/vnd.android.package-archive'},customMetadata:{sha256}});
        return result({ok:true,size,sha256});
      }
      const handled=await ownerRoutes({request,env,route,method,stmt,one,all,result,body,get,view,pending,fail});if(handled)return handled;
      if(route==='/api/admin/logout'&&method==='POST'){await stmt('DELETE FROM admin_sessions WHERE token_hash=?',await hash(cookies.ar_admin)).run();return result({ok:true},200,{'Set-Cookie':cookie('ar_admin','',false,true)});}
      const match=route.match(/^\/api\/admin\/conversations\/([a-f0-9-]+)(?:\/(mode|reply|retry))?$/);
      if(match){const chat=await get(match[1]);if(!chat)throw fail(404,'Conversation not found.');if(!match[2]&&method==='GET'){await scheduleChatWork(chat.id,chat);return result(await view(chat,true));}const data=await body();
        if(match[2]==='mode'&&method==='PATCH'){if(!['ai','assist','manual'].includes(data.mode))throw fail(400,'Invalid mode.');if(chat.mode!==data.mode){await db.batch([stmt('UPDATE conversations SET mode=?,version=version+1,updated=? WHERE id=?',data.mode,Date.now(),chat.id),stmt('DELETE FROM drafts WHERE conversation_id=?',chat.id),stmt("UPDATE messages SET status='pending' WHERE conversation_id=? AND status='failed'",chat.id)]);await generate(chat.id);}return result(await view(await get(chat.id),true));}
        if(match[2]==='retry'&&method==='POST'){if(chat.mode==='manual')throw fail(409,'Manual mode is active.');await db.batch([stmt("UPDATE messages SET status='pending' WHERE conversation_id=? AND status='failed'",chat.id),stmt('UPDATE conversations SET version=version+1,updated=? WHERE id=? AND changes()=1',Date.now(),chat.id),stmt('DELETE FROM rate_limits WHERE key=? AND count<0','reply-lease:'+chat.id)]);await generate(chat.id);return result(await view(await get(chat.id),true));}
        if(match[2]==='reply'&&method==='POST'){const message=await pending(chat.id);if(chat.mode==='ai'||!message||message.id!==data.messageId||chat.version!==data.version)throw fail(409,'The chat changed. Refresh before sending.');if(typeof data.body!=='string'||!data.body.trim()||data.body.length>4000)throw fail(400,'Write a reply of 1–4000 characters.');await finish(chat,message,data.body.trim(),chat.mode==='assist'?'human-assisted':'human');return result(await view(await get(chat.id),true));}
      }
    }
    throw fail(404,'Not found.');
  }catch(error){return result({error:error.status?error.message:'Service temporarily unavailable. Please try again.'},error.status||503);}finally{releaseBackground();}
}

export default {
  async fetch(request,env,executionContext){
    const url=new URL(request.url);
    const downloadHost=url.hostname==='rekhaastrology.in';
    if(downloadHost&&url.pathname!=='/'&&!url.pathname.startsWith('/astrorani'))return fetch(request);
    if(url.pathname.startsWith('/api/'))return handleApi(request,env,executionContext);
    if(url.pathname==='/brand/logo'){
      if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers});
      const stmt=(sql,...args)=>env.DB.prepare(sql).bind(...args),one=(sql,...args)=>stmt(sql,...args).first();
      const published=await appSettingsPublic({env,stmt,one}),id=published.settings.brand.logoMediaId;
      const item=id&&await one("SELECT object_key,mime FROM media_items WHERE id=? AND type='image' AND archived=0",id);
      // Only the published branding image is public; no arbitrary library IDs are accepted.
      if(!item?.object_key||!['image/jpeg','image/png','image/webp'].includes(item.mime))return new Response('Logo unavailable',{status:404,headers});
      const object=await env.MEDIA.get(item.object_key);if(!object)return new Response('Logo unavailable',{status:404,headers});
      return new Response(request.method==='HEAD'?null:object.body,{headers:{...headers,'Content-Type':item.mime,'Content-Length':String(object.size)}});
    }
    if(/^\/intro\/(welcome|introduction|testimonials)\.mp4$/.test(url.pathname)){
      if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
      const key=url.pathname.slice(1),meta=await env.MEDIA.head(key);
      if(!meta)return new Response('Video unavailable',{status:404});
      const range=request.headers.get('Range');let start=0,end=meta.size-1;
      if(range){const match=range.match(/^bytes=(\d*)-(\d*)$/);if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${meta.size}`}});
        if(!match[1])start=Math.max(0,meta.size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
        if(start>end||start>=meta.size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${meta.size}`}});
      }
      const object=request.method==='HEAD'?null:await env.MEDIA.get(key,{range:{offset:start,length:end-start+1}});
      return new Response(object?.body||null,{status:range?206:200,headers:{'Content-Type':'video/mp4','Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff','ETag':meta.httpEtag,...(range?{'Content-Range':`bytes ${start}-${end}/${meta.size}`}:{})}});
    }
    let asset=url.pathname;
    if(downloadHost&&asset==='/')asset='/download.html';
    if(asset==='/admin'||asset==='/admin/')asset='/admin.html';
    if(asset==='/astrorani'||asset==='/astrorani/')asset='/download.html';
    if(asset==='/astrorani/rekha-portrait.png')asset='/rekha-portrait.png';
    if(asset==='/astrorani/icon-192.png')asset='/icon-192.png';
    if(asset==='/astrorani/AstroRani.apk')asset='/AstroRani.apk';
    if(asset==='/astrorani/RekhaAstrology.apk')asset='/AstroRani.apk';
    if(asset==='/astrorani/RekhaAdmin.apk')asset='/RekhaAdmin.apk';
    if(['GET','HEAD'].includes(request.method)&&asset==='/RekhaAdmin.apk'){
      const release=await env.MEDIA.get('releases/RekhaAdmin.apk');
      if(!release)return new Response('Admin app unavailable',{status:404});
      return new Response(request.method==='HEAD'?null:release.body,{headers:{...headers,'Content-Type':'application/vnd.android.package-archive','Content-Disposition':'attachment; filename="RekhaAdmin.apk"','Content-Length':String(release.size)}});
    }
    if(asset==='/astrorani/SHA256.txt')asset='/SHA256.txt';
    if(['GET','HEAD'].includes(request.method)&&['/AstroRani.apk','/SHA256.txt'].includes(asset)){
      const release=await env.MEDIA.get('releases/AstroRani.apk');
      if(release)return new Response(request.method==='HEAD'?null:asset==='/SHA256.txt'?`${release.customMetadata.sha256}  AstroRani.apk\n`:release.body,{headers:{...headers,'Content-Type':asset.endsWith('.apk')?'application/vnd.android.package-archive':'text/plain; charset=utf-8',...(asset.endsWith('.apk')?{'Content-Disposition':'attachment; filename="AstroRani.apk"','Content-Length':String(release.size)}:{})}});
    }
    const target=new URL(asset,url.origin);const response=await env.ASSETS.fetch(new Request(target,request));
    const out=new Response(response.body,response);for(const [key,value]of Object.entries(headers))out.headers.set(key,value);
    if(asset.endsWith('.apk')){out.headers.set('Content-Type','application/vnd.android.package-archive');out.headers.set('Content-Disposition','attachment; filename="AstroRani.apk"');out.headers.set('Cache-Control','public, max-age=300');}
    return out;
  },
  async scheduled(controller,env){
    const queryBudget={used:0,limit:47,can(reserve){return this.used+reserve<=this.limit;}},stmt=(sql,...args)=>{queryBudget.used++;return env.DB.prepare(sql).bind(...args);},one=(sql,...args)=>stmt(sql,...args).first(),all=async(sql,...args)=>(await stmt(sql,...args).all()).results;
    const ctx={env,stmt,one,all,fail,queryBudget,get:id=>one('SELECT * FROM conversations WHERE id=?',id)};ctx.appSettings=(await appSettingsPublic(ctx)).settings;const deadline=Date.now()+20000;
    if(controller.cron==='17 2 * * *')await stmt("INSERT INTO workflow_settings(key,value) VALUES('retention-before',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(Date.now()-ctx.appSettings.service.retentionDays*86400000)).run();
    const sweeping=await one("SELECT 1 FROM workflow_settings WHERE key='retention-before'");if(sweeping)queryBudget.limit=36;
    await workflowRecoverMessages(ctx,null,1);
    let cursor={updated:-1,id:''};try{const saved=JSON.parse((await one("SELECT value FROM workflow_settings WHERE key='reply-scan-cursor'"))?.value||'null');if(saved&&Number.isSafeInteger(saved.updated)&&typeof saved.id==='string')cursor=saved;}catch{}
    const replyChats=await all(replyCandidateSql,cursor.updated,cursor.id,ctx.appSettings.service.freeReplies,Date.now());
    let examined=null,generated=0;
    for(const chat of replyChats){if(Date.now()>=deadline||generated>=20)break;if(chat.eligible&&!queryBudget.can(sweeping?23:40))break;examined={updated:chat.updated,id:chat.id};if(chat.eligible){generated++;await generateChatReply(ctx,chat.id);}}
    if(examined||!replyChats.length){
      const completedWindow=!replyChats.length||examined.id===replyChats.at(-1).id&&replyChats.length<200,next=completedWindow?{updated:-1,id:''}:examined;
      await stmt("INSERT INTO workflow_settings(key,value) VALUES('reply-scan-cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(next)).run();
    }
    // Polling delivers foreground steps; cron continues the same sequence when closed.
    for(;;){if(!queryBudget.can(8))break;await workflowProcessDue(ctx,{limit:20});if(!queryBudget.can(3))break;const next=await one("SELECT due FROM workflow_jobs WHERE status='pending' ORDER BY due,id LIMIT 1");if(!next?.due||next.due>deadline||Date.now()>=deadline||!await one("SELECT 1 FROM workflow_settings WHERE key='config' AND json_extract(value,'$.enabled')=1"))break;await new Promise(resolve=>setTimeout(resolve,Math.max(100,next.due-Date.now())));}
    // A daily trigger starts a sweep; minute ticks continue bounded pages.
    // Soft query guards stop before complete units and leave durable work queued.
    queryBudget.limit=50;
    if(queryBudget.can(11)){
      const marker=await one("SELECT value FROM workflow_settings WHERE key='retention-before'");
      if(marker){
        const before=Math.min(Number(marker.value),Date.now()-ctx.appSettings.service.retentionDays*86400000),ids=await all(retentionSql,before),selected=JSON.stringify(ids.map(row=>row.id)),now=Date.now();
        await env.DB.batch([
          // Deletion and activity guard are one transaction. A customer who has
          // returned before the transaction retains their profile and files.
          stmt("DELETE FROM chat_attachments WHERE id IN (SELECT a.id FROM chat_attachments a JOIN conversations c ON c.id=a.conversation_id WHERE c.id IN (SELECT value FROM json_each(?)) AND c.updated<? ORDER BY a.id LIMIT 100)",selected,before),
          stmt("DELETE FROM conversations WHERE id IN (SELECT value FROM json_each(?)) AND updated<? AND NOT EXISTS(SELECT 1 FROM chat_attachments a WHERE a.conversation_id=conversations.id)",selected,before),
          stmt("DELETE FROM calls WHERE id IN (SELECT id FROM calls WHERE created<? ORDER BY created,id LIMIT 100)",before),
          stmt("DELETE FROM reward_attempts WHERE id IN (SELECT id FROM reward_attempts WHERE expires<? ORDER BY expires,id LIMIT 100)",now-86400000),
          stmt("DELETE FROM admin_sessions WHERE token_hash IN (SELECT token_hash FROM admin_sessions WHERE expires<? ORDER BY expires,token_hash LIMIT 100)",now),
          stmt("DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires<? ORDER BY expires,key LIMIT 100)",now),
        ]);
        if(!ids.length&&!await one("SELECT 1 FROM calls WHERE created<? UNION ALL SELECT 1 FROM reward_attempts WHERE expires<? UNION ALL SELECT 1 FROM admin_sessions WHERE expires<? UNION ALL SELECT 1 FROM rate_limits WHERE expires<? LIMIT 1",before,now-86400000,now,now))await stmt("DELETE FROM workflow_settings WHERE key='retention-before'").run();
      }
    }
    if(queryBudget.can(3)){
      const objects=await all('SELECT object_key FROM object_cleanup ORDER BY object_key LIMIT 20'),deleted=[];
      for(const item of objects){try{await env.MEDIA.delete(item.object_key);deleted.push(item.object_key);}catch{}}
      if(deleted.length)await stmt('DELETE FROM object_cleanup WHERE object_key IN (SELECT value FROM json_each(?))',JSON.stringify(deleted)).run();
    }
  },
};
