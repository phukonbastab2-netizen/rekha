// First-party, optional activity metadata. Never accepts messages, forms, URLs or device data.
export const activityScreens=['website','splash','language','profile','permissions','kundli_loading','chat','privacy','install_help','download','install','details','intro','policy','offline'];
export const activityActions=['page_view','app_open','first_app_open','download_start','button_click','link_click','input_click','page_click','language_select','install_help','privacy_open','chat_send','chat_attach','chat_voice','chat_call','chat_video_call','chat_menu','profile_send','donate_interest','yes_choice','media_play','media_ended','screen_view','install_home','open_app','download_app','language_hi','language_en','platform_android','platform_ios','privacy_policy','terms','support','contact','policies','delete_data','about','disclaimer','refunds','delivery','details_submit','intro_play','intro_pause','intro_end','send_message','open_settings','attachment_menu','attachment_open','voice_record','call_audio','call_video','media_pause','media_end','media_open','kundli_open','yes_reply','back_chat','consent_accept','consent_decline','profile_name','profile_dob','intro_retry','chat_input','chat_camera','chat_emoji','chat_cancel_context','voice_cancel','voice_stop','chat_search','chat_starred','chat_media','chat_export','feature_access','message_alerts','chat_sounds','privacy_save','chat_delete','dialog_close','delete_cancel','delete_confirm','activity_settings','chat_retry','chat_latest','chat_history','chat_unlock','app_retry','chat_reopen','call_answer','call_mute','call_end','call_audio_enable','message_reply','message_star','message_copy','message_edit','message_delete','message_react','chat_emoji_insert','attachment_remove','chat_result_open','message_options','message_quote_open','attachment_gallery','attachment_document','camera_capture','camera_cancel','chat_prompt'];
export const activityPolicyPages=['privacy-policy.html','terms-and-conditions.html','terms.html','support.html','contact.html','data-deletion.html','about.html','disclaimer.html','refund-cancellation.html','shipping-policy.html'];
export const activityPages=['/','/index.html','/astrorani','/astrorani/','/download.html','/install','/install/','/home-install.html',...activityPolicyPages.flatMap(name=>['/'+name,'/astrorani/'+name])];
export const activityRetentionMs=30*86400000,activityDailyLimit=5000;
const activityUuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const activityNow=ctx=>typeof ctx.now==='function'?ctx.now():Date.now();
const activityDay=now=>Math.floor(now/86400000)*86400000;
const activityExact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const activityHash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
async function activityBody({request,fail}){
  if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw fail(415,'JSON required.');
  const reader=request.body?.getReader();if(!reader)throw fail(400,'Activity metadata is required.');
  let size=0;const chunks=[];for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();throw fail(413,'Activity batch is too large.');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw fail(400,'Invalid activity metadata.');}
}
function activityEventValid(event,now){
  return activityExact(event,['id','type','page','screen','action','at'])&&activityUuid(event.id)&&['click','screen','media'].includes(event.type)&&activityPages.includes(event.page)&&activityScreens.includes(event.screen)&&activityActions.includes(event.action)&&Number.isSafeInteger(event.at)&&event.at>=now-86400000&&event.at<=now+300000;
}
function activityCursor(value,fail){
  if(value===null||value==='')return null;
  if(value.length>100||!/^[0-9]+\.[0-9a-f-]{36}$/i.test(value))throw fail(400,'Invalid activity cursor.');
  const [time,id]=value.split('.'),received=Number(time);if(!Number.isSafeInteger(received)||received<=0||!activityUuid(id))throw fail(400,'Invalid activity cursor.');return{received,id:id.toLowerCase()};
}
export async function activityRoutes(ctx){
  const {request,env,route,method,stmt,one,all,result,fail,rate}=ctx;
  if(route!=='/api/activity'&&route!=='/api/admin/activity')return null;
  const now=activityNow(ctx);
  if(route==='/api/activity'){
    if(method!=='POST')throw fail(405,'Activity collection only accepts consented metadata.');
    if(request.headers.get('Origin')!==new URL(request.url).origin)throw fail(403,'Request origin not allowed.');
    const data=await activityBody(ctx);
    if(!activityExact(data,['visitorId','sessionId','consent','surface','events'])||data.consent!==true||!activityUuid(data.visitorId)||!activityUuid(data.sessionId)||!['website','customer'].includes(data.surface)||!Array.isArray(data.events)||data.events.length<1||data.events.length>20||!data.events.every(event=>activityEventValid(event,now)))throw fail(400,'Only consented, allowlisted activity metadata is accepted.');
    const visitorId=data.visitorId.toLowerCase(),sessionId=data.sessionId.toLowerCase(),native=/RekhaAstrologyAndroid|AstroRaniAndroid/i.test(request.headers.get('User-Agent')||''),events=[...new Map(data.events.filter(event=>!['app_open','first_app_open'].includes(event.action)||native&&data.surface==='customer').map(event=>[event.id.toLowerCase(),{...event,id:event.id.toLowerCase()}])).values()];
    // Native-open counters require the wrapper's marker, checked transiently and never stored.
    if(!events.length)return result({ok:true,accepted:0,received:now},202);
    await rate('activity-visitor:'+visitorId,12);await rate('activity-session:'+sessionId,8);
    const day=activityDay(now),budgetKey='activity-budget:'+day;
    const reserved=await stmt('INSERT INTO rate_limits(key,count,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+excluded.count WHERE rate_limits.count+excluded.count<=? RETURNING count',budgetKey,events.length,day+2*86400000,activityDailyLimit).first();
    if(!reserved)throw Object.assign(fail(429,'Optional activity collection is paused for today. Customer chat is unaffected.'),{retryAfter:Math.max(1,Math.ceil((day+86400000-now)/1000))});
    let conversationId=null;const raw=(request.headers.get('Cookie')||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('ar_session='))?.slice(11);
    if(raw&&/^[0-9a-f]{64}$/.test(raw))conversationId=(await one('SELECT id FROM conversations WHERE token_hash=?',await activityHash(raw)))?.id||null;
    const saved=await stmt("INSERT OR IGNORE INTO activity_events(id,visitor_id,session_id,conversation_id,surface,page,screen,action,type,at,received) SELECT json_extract(value,'$.id'),?,?,?, ?,json_extract(value,'$.page'),json_extract(value,'$.screen'),json_extract(value,'$.action'),json_extract(value,'$.type'),json_extract(value,'$.at'),? FROM json_each(?)",visitorId,sessionId,conversationId,data.surface,now,JSON.stringify(events)).run();
    return result({ok:true,accepted:Number(saved.meta.changes)||0,received:now},202);
  }
  // The caller must authenticate the owner before dispatching this private route.
  if(method!=='GET')throw fail(405,'Activity reports are read-only.');
  const params=new URL(request.url).searchParams,allowed=['surface','conversationId','visitorId','before','hours'];
  if([...params.keys()].some(key=>!allowed.includes(key))||allowed.some(key=>params.getAll(key).length>1))throw fail(400,'Invalid activity filter.');
  const surface=params.get('surface'),conversationId=params.get('conversationId'),visitorId=params.get('visitorId'),hours=params.has('hours')?Number(params.get('hours')):24,cursor=activityCursor(params.get('before'),fail);
  if(surface&&!['website','customer'].includes(surface)||conversationId&&!activityUuid(conversationId)||visitorId&&!activityUuid(visitorId)||!Number.isSafeInteger(hours)||hours<1||hours>720)throw fail(400,'Invalid activity filter.');
  const since=Math.max(now-activityRetentionMs,now-hours*3600000),clauses=['e.received>=?'],args=[since];
  if(surface){clauses.push('e.surface=?');args.push(surface);}if(conversationId){clauses.push('e.conversation_id=?');args.push(conversationId.toLowerCase());}if(visitorId){clauses.push('e.visitor_id=?');args.push(visitorId.toLowerCase());}
  const where=clauses.join(' AND '),pageWhere=where+(cursor?' AND (e.received,e.id)<(?,?)':''),pageArgs=cursor?[...args,cursor.received,cursor.id]:args;
  const rows=await all('SELECT e.id,e.visitor_id AS visitorId,e.session_id AS sessionId,e.conversation_id AS conversationId,c.name AS customerName,e.surface,e.page,e.screen,e.action,e.type,e.at,e.received FROM activity_events e LEFT JOIN conversations c ON c.id=e.conversation_id WHERE '+pageWhere+' ORDER BY e.received DESC,e.id DESC LIMIT 51',...pageArgs);
  const sampled=await one('WITH sample_window AS MATERIALIZED (SELECT visitor_id,type,action FROM activity_events e WHERE '+where+' ORDER BY received DESC,id DESC LIMIT 10001),recent AS (SELECT * FROM sample_window LIMIT 10000) SELECT COUNT(*) AS events,COUNT(DISTINCT visitor_id) AS visitors,SUM(type=\'click\') AS clicks,SUM(action=\'app_open\') AS appOpens,SUM(action=\'first_app_open\') AS firstAppOpens,(SELECT COUNT(*)>10000 FROM sample_window) AS sampled FROM recent',...args);
  const topActions=await all('WITH recent AS MATERIALIZED (SELECT action FROM activity_events e WHERE '+where+' ORDER BY received DESC,id DESC LIMIT 10000) SELECT action,COUNT(*) AS count FROM recent GROUP BY action ORDER BY count DESC,action LIMIT 15',...args);
  const downloadSince=activityDay(since),downloadStarts=!conversationId&&!visitorId&&surface!=='customer'?(await one('SELECT COALESCE(SUM(download_requests),0) AS count FROM activity_daily WHERE day>=? AND day<=?',downloadSince,activityDay(now))).count:null;
  const day=activityDay(now),budgetRow=await one('SELECT count FROM rate_limits WHERE key=?','activity-budget:'+day),used=Number(budgetRow?.count)||0;
  const hasMore=rows.length>50,events=rows.slice(0,50),last=events.at(-1);
  return result({events,nextCursor:hasMore?last.received+'.'+last.id:null,summary:{events:Number(sampled.events)||0,visitors:Number(sampled.visitors)||0,clicks:Number(sampled.clicks)||0,appOpens:Number(sampled.appOpens)||0,firstAppOpens:Number(sampled.firstAppOpens)||0,sampled:!!sampled.sampled,windowHours:hours,downloadStarts:downloadStarts===null?null:Number(downloadStarts)||0,downloadSource:'served-downloads',downloadWindowDays:Math.round((activityDay(now)-downloadSince)/86400000)+1,downloadSince},topActions,budget:{used,limit:activityDailyLimit,remaining:Math.max(0,activityDailyLimit-used),resetAt:day+86400000,paused:used>=activityDailyLimit}});
}
export async function activityRecordDownload(ctx){
  const {request,stmt}=ctx;if(!request||request.method!=='GET'||request.headers.has('Range')||ctx.status!==undefined&&ctx.status!==200)return false;
  if(!['/astrorani/RekhaAstrology.apk','/RekhaAstrology.apk','/downloads/RekhaAstrology.apk'].includes(new URL(request.url).pathname))return false;
  try{await stmt('INSERT INTO activity_daily(day,download_requests) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET download_requests=download_requests+1',activityDay(activityNow(ctx))).run();return true;}catch{return false;}
}
export async function activityPrune(ctx,{daily=false}={}){
  if(ctx.queryBudget&&!ctx.queryBudget.can(daily?2:1))return{deleted:0,skipped:true};
  const before=activityNow(ctx)-activityRetentionMs;
  const statements=[ctx.stmt('DELETE FROM activity_events WHERE id IN (SELECT id FROM activity_events INDEXED BY activity_received WHERE received<? ORDER BY received,id LIMIT '+(daily?'990':'1000')+')',before)];
  if(daily)statements.push(ctx.stmt('DELETE FROM activity_daily WHERE day IN (SELECT day FROM activity_daily WHERE day<? ORDER BY day LIMIT 10)',activityDay(before)));
  const results=await ctx.env.DB.batch(statements);
  return{deleted:results.reduce((sum,value)=>sum+(Number(value.meta.changes)||0),0),skipped:false};
}
