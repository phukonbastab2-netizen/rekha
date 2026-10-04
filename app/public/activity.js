// Optional first-party product activity. Only fixed labels leave this document.
export const ACTIVITY_ACTIONS=Object.freeze(['page_view','app_open','first_app_open','download_start','button_click','link_click','input_click','page_click','language_select','install_help','privacy_open','chat_send','chat_attach','chat_voice','chat_call','chat_video_call','chat_menu','profile_send','donate_interest','yes_choice','media_play','media_ended','screen_view','install_home','open_app','download_app','language_hi','language_en','platform_android','platform_ios','privacy_policy','terms','support','contact','policies','delete_data','about','disclaimer','refunds','delivery','details_submit','intro_play','intro_pause','intro_end','send_message','open_settings','attachment_menu','attachment_open','voice_record','call_audio','call_video','media_pause','media_end','media_open','kundli_open','yes_reply','back_chat','consent_accept','consent_decline','profile_name','profile_dob','intro_retry','chat_input','chat_camera','chat_emoji','chat_cancel_context','voice_cancel','voice_stop','chat_search','chat_starred','chat_media','chat_export','feature_access','message_alerts','chat_sounds','privacy_save','chat_delete','dialog_close','delete_cancel','delete_confirm','activity_settings','chat_retry','chat_latest','chat_history','chat_unlock','app_retry','chat_reopen','call_answer','call_mute','call_end','call_audio_enable','message_reply','message_star','message_copy','message_edit','message_delete','message_react','chat_emoji_insert','attachment_remove','chat_result_open','message_options','message_quote_open','attachment_gallery','attachment_document','camera_capture','camera_cancel','chat_prompt']);
export const ACTIVITY_SCREENS=Object.freeze(['website','splash','language','profile','permissions','kundli_loading','chat','privacy','install_help','download','install','details','intro','policy','offline']);
const actions=new Set(ACTIVITY_ACTIONS),screens=new Set(ACTIVITY_SCREENS);
const policyFiles=['privacy-policy.html','terms-and-conditions.html','terms.html','support.html','contact.html','data-deletion.html','about.html','disclaimer.html','refund-cancellation.html','shipping-policy.html'];
const pages=new Set(['/','/astrorani','/astrorani/','/download.html','/home-install.html','/install','/install/',...policyFiles.map(file=>'/'+file),...policyFiles.map(file=>'/astrorani/'+file)]);
const controlActions=Object.freeze({'download-apk':'download_start','download-app':'download_start','android-download':'download_start','browser-chat':'open_app','onboarding-language':'language_select','file-help':'install_help','permission-help':'install_help','ios-help':'install_help','chat-privacy':'chat_menu','chat-back':'back_chat','chat-contact':'chat_menu','attach-file':'chat_attach','voice-note':'chat_voice','call-audio':'chat_call','call-video':'chat_video_call','kundli-send':'profile_send','signup-name':'profile_name','signup-dob':'profile_dob','reload-onboarding-video':'intro_retry','message-input':'chat_input','camera-photo':'chat_camera','emoji-picker':'chat_emoji','cancel-context':'chat_cancel_context','cancel-record':'voice_cancel','stop-record':'voice_stop','cancel-capture':'voice_cancel','attachment-picker':'chat_attach','search-chat':'chat_search','location-choice':'feature_access','save-privacy':'privacy_save','delete-chat':'chat_delete','close-dialog':'dialog_close','cancel-delete':'delete_cancel','confirm-delete':'delete_confirm','activity-settings':'activity_settings','connection-retry':'chat_retry','jump-latest':'chat_latest','load-earlier':'chat_history','retry':'chat_retry','unlock':'chat_unlock','reload':'app_retry','reopen-chat':'chat_reopen'});
const fixedAttributes=Object.freeze({'data-menu':Object.freeze({search:'chat_search',starred:'chat_starred',media:'chat_media',export:'chat_export',access:'feature_access',alerts:'message_alerts',privacy:'privacy_open',sounds:'chat_sounds'}),'data-action':Object.freeze({reply:'message_reply',star:'message_star',copy:'message_copy',edit:'message_edit',delete:'message_delete'}),'data-attach':Object.freeze({gallery:'attachment_gallery',document:'attachment_document',camera:'chat_camera'}),'data-language':Object.freeze({hi:'language_hi',en:'language_en'}),'data-platform':Object.freeze({android:'platform_android',ios:'platform_ios'})});
// Presence identifies a control's function; private numeric IDs, emoji, URLs
// and filenames in these attributes are never read or included in events.
const presenceActions=Object.freeze({'data-followup-yes':'yes_choice','data-donation-interest':'donate_interest','data-retry-send':'chat_retry','data-remove-draft':'attachment_remove','data-insert-emoji':'chat_emoji_insert','data-react':'message_react','data-result-id':'chat_result_open','data-message-actions':'message_options','data-jump-message':'message_quote_open','data-reaction-message':'message_react','data-media-url':'media_open','data-prompt':'chat_prompt','data-close':'dialog_close'});
const classActions=Object.freeze({'call-answer':'call_answer','call-mute':'call_mute','call-end':'call_end','call-audio-enable':'call_audio_enable','camera-take':'camera_capture','camera-cancel':'camera_cancel'});
const keys={consent:'rekha:activity-consent-v1',visitor:'rekha:activity-visitor-v1',firstOpen:'rekha:activity-first-app-open-v1'};
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventType=action=>['media_play','media_ended','media_pause','media_end','intro_play','intro_pause','intro_end'].includes(action)?'media':['page_view','screen_view','app_open','first_app_open'].includes(action)?'screen':'click';

// Dependency injection keeps privacy and retry checks independent of real data.
export function createActivityTracker({windowTarget=globalThis.window,documentTarget=globalThis.document,navigatorTarget=globalThis.navigator,storage,cryptoTarget=globalThis.crypto,fetchActivity=globalThis.fetch,now=()=>Date.now(),setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout}={}){
  let started=false,enabled=false,surface=null,screen='website',page=null,choice=null,visitorId=null,sessionId=null,queue=[],timer=null,inFlight=null,prompt=null,generation=0,pausedUntil=0,lastDownload=null,foregroundPending=false;
  const window=windowTarget,document=documentTarget,navigator=navigatorTarget||{};
  if(!storage)try{storage=window?.localStorage;}catch{}
  const read=key=>{try{return storage?.getItem(key)??null;}catch{return null;}};
  const write=(key,value)=>{try{storage?.setItem(key,value);}catch{}};
  const remove=key=>{try{storage?.removeItem(key);}catch{}};
  const nativeCustomer=()=>!!window?.RekhaDevice||/\b(?:RekhaAstrology|AstroRani)Android(?:\/|\b)/i.test(navigator.userAgent||'');
  const allowed=()=>!!window&&!!document&&pages.has(window.location?.pathname)&&!/^\/admin(?:\/|\.html|$)/i.test(window.location?.pathname||'')&&!/\bRekhaAdminAndroid(?:\/|\b)/i.test(navigator.userAgent||'');
  function uuid(){
    try{if(typeof cryptoTarget?.randomUUID==='function'){const value=cryptoTarget.randomUUID();return uuidPattern.test(value)?value:null;}if(typeof cryptoTarget?.getRandomValues==='function'){const bytes=cryptoTarget.getRandomValues(new Uint8Array(16));bytes[6]=bytes[6]&15|64;bytes[8]=bytes[8]&63|128;const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);}}catch{}return null;
  }
  function clearScheduled(){if(timer!==null){clearTimer(timer);timer=null;}}
  function schedule(delay=5000){
    if(!enabled||!queue.length||timer!==null||inFlight||navigator.onLine===false||document.hidden)return;
    const wait=Math.max(delay,pausedUntil-now(),0);
    timer=setTimer(()=>{timer=null;void flush();},wait);
  }
  function record(action,{type}={}){
    if(!started||!enabled||!allowed()||!actions.has(action)||type&&type!==eventType(action))return false;
    const at=now();if(!Number.isSafeInteger(at)||at<0)return false;
    if(action==='download_start'&&lastDownload!==null&&at-lastDownload<1500)return false;
    const id=uuid();if(!id)return false;
    if(action==='download_start')lastDownload=at;
    queue.push({event:{id,type:eventType(action),page,screen,action,at},attempts:0});if(queue.length>200)queue.splice(0,queue.length-200);
    schedule(queue.length>=20?0:5000);return true;
  }
  function retryDelay(response,attempts){
    if(response?.status===429){const header=response.headers?.get?.('Retry-After');let delay=Number(header)*1000;if(!header||!Number.isFinite(delay)||delay<0)delay=header?Date.parse(header)-now():60000;if(!Number.isFinite(delay)||delay<0)delay=60000;return Math.max(1000,Math.min(24*60*60*1000,delay));}
    return Math.min(15000,1000*2**Math.max(0,attempts-1));
  }
  async function flush({keepalive=false}={}){
    if(!enabled||inFlight||!queue.length||navigator.onLine===false)return false;
    if(now()<pausedUntil){schedule();return false;}
    clearScheduled();queue=queue.filter(item=>item.event.at>=now()-24*60*60*1000);if(!queue.length)return false;
    const batch=queue.splice(0,20),epoch=generation,controller=typeof AbortController==='function'?new AbortController():null;
    for(const item of batch)item.attempts++;
    const body=JSON.stringify({visitorId,sessionId,consent:true,surface,events:batch.map(item=>item.event)});
    if(body.length>8192)return false;
    const request={controller,epoch};inFlight=request;const timeout=setTimer(()=>controller?.abort(),10000);let response=null;
    // An existing HttpOnly customer cookie can associate consenting activity;
    // this collector never reads cookies or customer tokens into its payload.
    const endpoint=surface==='website'?'/astrorani/api/activity':'/api/activity';
    try{response=await fetchActivity(endpoint,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body,keepalive,signal:controller?.signal});}
    catch{}
    finally{clearTimer(timeout);if(inFlight===request)inFlight=null;}
    if(epoch!==generation||!enabled)return false;
    if(!response?.ok&&(!response||response.status===429||response.status>=500)){
      const attempts=Math.max(...batch.map(item=>item.attempts)),delay=retryDelay(response,attempts);pausedUntil=now()+delay;
      queue=[...batch.filter(item=>item.attempts<3),...queue].slice(-200);
    }
    if(!keepalive)schedule();return !!response?.ok;
  }
  function removePrompt(){prompt?.remove();prompt=null;}
  function showPrompt(){
    if(!started||!allowed()||!document.body)return;removePrompt();
    const ribbon=document.createElement('section');ribbon.className='activity-consent-ribbon';ribbon.setAttribute('data-activity-consent','true');ribbon.setAttribute('role','region');ribbon.setAttribute('aria-label','Optional activity sharing / वैकल्पिक गतिविधि साझा करना');
    const message=document.createElement('p');message.textContent='Share button and screen activity to help improve the app?';
    const hindi=document.createElement('p');hindi.lang='hi';hindi.textContent='ऐप बेहतर बनाने के लिए बटन और स्क्रीन की गतिविधि साझा करें?';
    const controls=document.createElement('div');controls.className='activity-consent-actions';
    const allow=document.createElement('button');allow.type='button';allow.className='activity-consent-allow';allow.textContent='Allow / अनुमति दें';allow.onclick=()=>setConsent(true);
    const decline=document.createElement('button');decline.type='button';decline.className='activity-consent-decline';decline.textContent='No thanks / नहीं, धन्यवाद';decline.onclick=()=>setConsent(false);
    controls.append(allow,decline);ribbon.append(message,hindi,controls);document.body.append(ribbon);prompt=ribbon;
  }
  function enable(){
    if(enabled||!started||!allowed())return;
    const saved=read(keys.visitor);visitorId=uuidPattern.test(saved||'')?saved:uuid();sessionId=uuid();
    if(!visitorId||!sessionId){visitorId=null;sessionId=null;return;}
    enabled=true;foregroundPending=!!document.hidden;write(keys.visitor,visitorId);record('page_view');
    if(surface==='customer'&&nativeCustomer()){record('app_open');if(read(keys.firstOpen)!=='yes'&&record('first_app_open'))write(keys.firstOpen,'yes');}
  }
  function disable(){enabled=false;generation++;queue=[];clearScheduled();inFlight?.controller?.abort();inFlight=null;visitorId=null;sessionId=null;lastDownload=null;pausedUntil=0;foregroundPending=false;remove(keys.visitor);}
  function setConsent(value){if(!started||!allowed()||typeof value!=='boolean')return false;choice=value;write(keys.consent,value?'yes':'no');removePrompt();if(value)enable();else disable();return true;}
  function pathFor(target){const result=[];for(let node=target;node&&result.length<12;node=node.parentElement)result.push(node);return result;}
  function sensitive(nodes){return nodes.some(node=>{const tag=String(node?.tagName||'').toLowerCase(),id=node?.id||'',autocomplete=node?.getAttribute?.('autocomplete')||'';return node?.getAttribute?.('data-activity-consent')==='true'||/(?:password|passcode|credential|otp|cvv|card|bank|auth)/i.test(id)||(tag==='input'||tag==='textarea')&&(String(node.type).toLowerCase()==='password'||/(?:password|one-time-code|cc-|transaction-)/i.test(autocomplete));});}
  function namedControl(nodes){
    for(const node of nodes){
      if(Object.hasOwn(controlActions,node?.id))return controlActions[node.id];
      for(const [attribute,values]of Object.entries(fixedAttributes)){const value=node?.getAttribute?.(attribute);if(Object.hasOwn(values,value))return values[value];}
      for(const [attribute,action]of Object.entries(presenceActions))if(node?.hasAttribute?.(attribute))return action;
      if(node?.classList?.contains('compose-primary'))return node?.getAttribute?.('data-mode')==='voice'?'chat_voice':'chat_send';
      if(node?.classList?.contains('call-launch')){const type=node.getAttribute('data-call-type');if(type==='voice')return 'chat_call';if(type==='video')return 'chat_video_call';}
      for(const [name,action]of Object.entries(classActions))if(node?.classList?.contains(name))return action;
    }
    return null;
  }
  function click(event){
    if(event.isTrusted!==true||!enabled)return;
    const nodes=pathFor(event.target);if(sensitive(nodes))return;
    const control=nodes.find(node=>['button','a','input','textarea','select','summary'].includes(String(node?.tagName||'').toLowerCase()));
    const fixed=nodes.map(node=>node?.getAttribute?.('data-activity')).find(value=>actions.has(value));
    const mapped=namedControl(nodes);
    if(fixed||mapped){const action=fixed||mapped;if(eventType(action)==='click')record(action);return;}
    const tag=String(control?.tagName||'').toLowerCase();record(tag==='button'||tag==='summary'?'button_click':tag==='a'?'link_click':['input','textarea','select'].includes(tag)?'input_click':'page_click');
  }
  function media(event){if(event.isTrusted!==true||!['video','audio'].includes(String(event.target?.tagName||'').toLowerCase()))return;record(event.type==='ended'?'media_ended':'media_play');}
  function setScreen(value){if(!screens.has(value))return false;if(screen===value)return true;screen=value;if(enabled)record('page_view');return true;}
  function init(options={}){
    if(started)return api;if(!['website','customer'].includes(options.surface)||!allowed())return api;
    started=true;surface=options.surface;screen=surface==='website'?'website':'splash';page=window.location.pathname;
    const stored=read(keys.consent);choice=stored==='yes'?true:stored==='no'?false:null;
    document.addEventListener('click',click,true);document.addEventListener('play',media,true);document.addEventListener('ended',media,true);
    window.addEventListener('online',()=>schedule(0));window.addEventListener('pagehide',()=>{clearScheduled();void flush({keepalive:true});});
    // A foreground return is a hidden-to-visible WebView document transition;
    // it does not claim to distinguish OS permission dialogs from app switches.
    document.addEventListener('visibilitychange',()=>{if(document.hidden){foregroundPending=enabled;clearScheduled();}else{if(enabled&&foregroundPending&&surface==='customer'&&nativeCustomer())record('app_open');foregroundPending=false;schedule(0);}});
    window.addEventListener('storage',event=>{if(event.key!==keys.consent)return;choice=event.newValue==='yes'?true:event.newValue==='no'?false:null;removePrompt();if(choice===true)enable();else{disable();if(choice===null)showPrompt();}});
    if(choice===true)enable();else{remove(keys.visitor);if(choice===null){if(document.body)showPrompt();else document.addEventListener('DOMContentLoaded',showPrompt,{once:true});}}
    return api;
  }
  const api={init,setScreen,record,getConsent:()=>choice,setConsent,manageConsent:()=>showPrompt(),flush};return api;
}
let singleton=null;
const instance=()=>singleton||(singleton=createActivityTracker());
export function initActivity(options){return instance().init(options);}
export function setActivityScreen(screen){return instance().setScreen(screen);}
export function recordActivity(action,options){return instance().record(action,options);}
export function getActivityConsent(){return instance().getConsent();}
export function setActivityConsent(value){return instance().setConsent(value);}
export function manageActivityConsent(){return instance().manageConsent();}
