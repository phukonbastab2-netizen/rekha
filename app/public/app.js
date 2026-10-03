import { messageBody, syncThread } from './media.js';
import { languages } from './locales.js';
import { createMessagingUI, messageExtras } from './messaging-ui.js';
import { installCalls } from './calls.js';
import { createSendQueue } from './send-queue.js';
import { createAdaptivePoll } from './adaptive-poll.js';
import { createChatHistory,historyHeaders,compactAcknowledgement,captureThreadAnchor,restoreThreadAnchor } from './chat-history.js';
import { chatIcon } from './chat-icons.js';
import { createChatSounds } from './chat-sounds.js';
import { mountVideoSignup,renderKundliPreparation,waitForPreparation } from './video-onboarding.js';
import { createDeviceChatStore } from './device-chat-store.js';
const app = document.querySelector('#app'), dialog = document.querySelector('#privacy-dialog');
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let lang = 'en', config, chat, stage = 'splash', profile = {}, busy = false, checkoutBusy = false, fingerprint = '', offline = false, messaging = null, composerDraft=null;
let calls, configReadAt=0, sessionEnded=false,chatMutation=0,outboxChatId=null;
let onboarding=null,releaseOnboarding=()=>{};
let sessionVerified=false,closingApp=false,pendingSaveTimer=null,suppressDeviceSave=false,localOlder=false,localOldestId=null,booting=false,allowDeviceRestore=false;
const deviceStore=createDeviceChatStore({onError:()=>{if(stage==='chat')toast(lang==='hi'?'डिवाइस पर चैट सहेजना उपलब्ध नहीं है।':'This device could not save recent chat changes.');}});
const history=createChatHistory();let olderLoading=false;
const messageMarkup=new Map(),dateFormatters=new Map();
let drawFrame=null,releaseChatLayout=()=>{},forceLatest=false,incomingHighWater=0,unreadIncoming=0,networkOffline=navigator.onLine===false;
function requestChatDraw(){if(stage!=='chat'||drawFrame!==null)return;drawFrame=requestAnimationFrame(()=>{drawFrame=null;if(stage==='chat')drawChat();});}
const sounds=createChatSounds({scope:'customer',incomingRole:'assistant',canPlay:()=>stage==='chat'&&!sessionEnded&&!messaging?.hasLiveCapture?.()&&!document.querySelector('.call-panel')});
const outbox=createSendQueue({
  online:()=>sessionVerified&&!closingApp&&!networkOffline&&navigator.onLine!==false&&!sessionEnded&&Boolean(chat),
  send:async(record,{signal})=>{if(!chat||chat.id!==record.conversationId||sessionEnded)throw Object.assign(new Error('This chat session has ended. Your message was not sent.'),{status:401});const payload=await record.prepare(record.snapshot,{signal});if(!chat||chat.id!==record.conversationId||sessionEnded||signal.aborted)throw Object.assign(new Error('This chat session has ended. Your message was not sent.'),{status:401});if(!payload)throw Object.assign(new Error('There is no message to send.'),{status:400});if(payload.editId)return api(`/api/messages/${payload.editId}`,'PATCH',{body:payload.body},{signal});const next=await api('/api/messages','POST',payload,{signal,compactAck:true});return compactAcknowledgement(chat,next,record.clientId);},
  onAck:next=>{acceptServerChat(next);offline=false;updateConnection();chatPoll.poke({immediate:true});},
  onConfirmed:record=>{record.finish?.(record.snapshot);if(!record.snapshot.editId)sounds.play('sent');},
  onError:error=>{if(error.status===401)endSession();else if(!error.status||error.status>=500){offline=true;updateConnection();}},
  onChange:()=>{requestChatDraw();schedulePendingSave();},
});
const chatPoll=createAdaptivePoll({task:refresh,canRun:()=>stage==='chat'&&!sessionEnded,hot:()=>outbox.list().some(record=>record.state==='queued'||record.state==='sending')||chat?.typing?.owner,idleMs:30000});
function dates(){const locale=lang==='hi'?'hi-IN':'en-IN';if(!dateFormatters.has(locale))dateFormatters.set(locale,{day:new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',year:'numeric'}),time:new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit'})});return dateFormatters.get(locale);}
const copyKeys=new Set(['tagline','languageTitle','languageSubtitle','detailsTitle','detailsSubtitle','kundli','kundliNote','permissionsTitle','permissionsSubtitle','messagePlaceholder','reflection','offerTitle','offerText','topics']);
const brand=()=>config?.appSettings?.brand||{};
const brandName=()=>typeof brand().name==='string'&&brand().name.trim()?brand().name:'Rekha Astrology';
const astrologerName=()=>typeof brand().astrologerName==='string'&&brand().astrologerName.trim()?brand().astrologerName:'Rekha';
const amount=()=>Number.isFinite(config?.amount)&&config.amount>=0?config.amount/100:Number.isFinite(config?.appSettings?.service?.unlockPriceRupees)?config.appSettings.service.unlockPriceRupees:49;
const price=()=>`₹${new Intl.NumberFormat('en-IN',{maximumFractionDigits:2}).format(amount())}`;
function text(key){
  const override=copyKeys.has(key)?config?.appSettings?.copy?.[lang]?.[key]:undefined;
  if(key==='topics')return Array.isArray(override)&&override.every(value=>typeof value==='string')?override:languages[lang]?.topics||languages.en.topics;
  if(typeof override==='string')return override;
  if(key==='tagline'&&typeof brand().tagline==='string')return brand().tagline;
  return String(languages[lang]?.[key]??languages.en[key]??'').replace(/<br\s*\/?\s*>/gi,'\n').replaceAll('₹49',price()).replaceAll('Rekha',astrologerName()).replaceAll('रेखा',astrologerName()==='Rekha'?'रेखा':astrologerName());
}
const t=key=>key==='topics'?text(key):esc(text(key));
const automationEnabled=()=>config?.automationEnabled===true;
const messagingPaused=()=>config?.appSettings?.chat?.customerMessagingEnabled===false;
const messagePlaceholder=()=>config?.appSettings?.copy?.[lang]?.messagePlaceholder||(lang==='hi'?'संदेश':lang==='hinglish'?'Message':'Message');
const logo=(portrait=false)=>brand().logoMediaId?`/brand/logo?revision=${encodeURIComponent(String(config?.settingsRevision??0))}`:portrait?'/rekha-portrait.png':'/icon-192.png';
function applyPublishedConfig(next){
  const previous=JSON.stringify([config?.appSettings,config?.settingsRevision,config?.amount,config?.retentionDays,config?.automationEnabled]);
  config=next;configReadAt=Date.now();
  try{localStorage.setItem('rekha-public-config-v1',JSON.stringify(next));}catch{}
  const changed=previous!==JSON.stringify([config?.appSettings,config?.settingsRevision,config?.amount,config?.retentionDays,config?.automationEnabled]);
  if(!changed)return;
  const primary=/^#[\da-f]{6}$/i.test(brand().primaryColor||'')?brand().primaryColor:'#075e54',accent=/^#[\da-f]{6}$/i.test(brand().accentColor||'')?brand().accentColor:'#008069';
  const contrast=color=>{const channels=color.slice(1).match(/../g).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722>.179?'#111b21':'#ffffff';};
  for(const [key,value]of Object.entries({'--brand-primary':primary,'--brand-accent':accent,'--brand-on-primary':contrast(primary),'--brand-on-accent':contrast(accent)}))document.documentElement.style.setProperty(key,value);
  if(config.appSettings){document.documentElement.style.setProperty('--wine',primary);document.documentElement.style.setProperty('--gold',accent);}
  document.title=brandName();document.querySelector('meta[name="theme-color"]')?.setAttribute('content',primary);
  document.querySelector('meta[name="description"]')?.setAttribute('content',text('tagline'));
  for(const selector of ['link[rel="icon"]','link[rel="apple-touch-icon"]'])document.querySelector(selector)?.setAttribute('href',logo());
  const mark=document.querySelector('.wordmark');if(mark){mark.replaceChildren();const image=document.createElement('img');image.src=logo();image.alt='';image.width=image.height=34;const label=document.createElement('span');label.className='brand-wordmark-label';label.textContent=brandName();mark.append(image,label);mark.setAttribute('aria-label',brandName()+' home');}
  document.querySelector('.story')?.setAttribute('aria-label',astrologerName());app.setAttribute('aria-label',brandName()+' app');
  if(config.appSettings){const title=document.querySelector('.story-copy h1'),subtitle=document.querySelector('.story-copy p');if(title)title.textContent=brandName();if(subtitle)subtitle.textContent=text('tagline');}
  for(const image of document.querySelectorAll('.rani-portrait,.loading>img,.avatar')){image.src=logo(image.classList.contains('rani-portrait'));image.alt=image.classList.contains('rani-portrait')?astrologerName():'';}
  const loadingTitle=app.querySelector('.loading h1');if(loadingTitle)loadingTitle.textContent=brandName();
  if(stage==='chat'){app.querySelector('.chat-name').textContent=astrologerName();app.querySelector('.chat-caption').textContent=chatAvailability();app.querySelector('.composer .footnote').textContent=text('reflection');fingerprint='';drawChat();updateComposePrimary();}
  window.dispatchEvent(new CustomEvent('rekha:app-settings',{detail:{appSettings:config.appSettings,settingsRevision:config.settingsRevision}}));
}
// A fixed availability label for the chat, independent of owner presence.
const chatAvailability = () => lang === 'hi' ? 'ऑनलाइन' : 'Online';
const conversationNotice = () => lang === 'hi' ? 'सुरक्षित बातचीत' : 'Safe and secure conversation';
async function api(route, method = 'GET', body, {signal,compactAck=false}={}) {
  if(stage==='chat'&&method!=='GET'&&!sessionVerified)throw Object.assign(new Error('Reconnect to this chat before changing it. Your saved messages are kept.'),{status:503});
  let response;
  try{response=await fetch(route,{method,credentials:'same-origin',cache:'no-store',headers:{...historyHeaders,...(method!=='GET'&&stage==='chat'&&chat?.id?{'X-Rekha-Chat':chat.id}:{}),...(compactAck&&method==='POST'&&route==='/api/messages'?{'X-Rekha-Ack':'compact-v1'}:{}),...(method!=='GET'?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(40000)]):AbortSignal.timeout(40000)});}catch(error){if(signal?.aborted)throw error;throw new Error(navigator.onLine===false?'You are offline. Your unsent message is kept.':'Could not confirm delivery. Please retry your message.');}
  let data;try{data=await response.json();}catch{throw Object.assign(new Error('The connection returned an unreadable response. Please try again.'),{status:response.ok?undefined:response.status});}
  if(!response.ok){const queuedWrite=method==='POST'&&route==='/api/messages'||method==='PATCH'&&/^\/api\/messages\/\d+$/.test(route);if(response.status===401&&stage==='chat'&&!queuedWrite)endSession();throw Object.assign(new Error(data.error||text('generalError')),{status:response.status});}
  return data;
}
function endSession(){if(sessionEnded){updateConnection();return;}sessionVerified=false;chatPoll.stop();sessionEnded=true;composerDraft=messaging?.preserveDraft?.()||composerDraft;void persistPending();outbox.pause({abort:true});messaging?.destroy();messaging=null;calls?.destroy();calls=null;toast(text('expired'));const input=app.querySelector('#message-input'),send=app.querySelector('.send');if(input)input.disabled=true;if(send)send.disabled=true;updateConnection();}
function acceptServerChat(next,{kind='mutation'}={}){
  if(!next||!Array.isArray(next.messages)||chat&&next.id!==chat.id)return false;
  chat=history.accept(chat,next,{kind});
  void deviceStore.merge({...chat,messages:next.messages},{kind,history:history.state()});
  chatMutation++;outbox.reconcile(chat);sounds.observe(chat,{kind});if(stage==='chat')drawChat();return true;
}
function drawHistory(){const button=app.querySelector('#load-earlier');if(!button)return;button.hidden=!localOlder&&!history.state().hasOlder;button.disabled=olderLoading;button.textContent=olderLoading?(lang==='hi'?'पुराने संदेश खुल रहे हैं…':'Loading earlier messages…'):(lang==='hi'?'पुराने संदेश देखें':'Load earlier messages');}
function nearLatest(scroller){return !scroller||scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<96;}
function updateJump(){
  const scroller=app.querySelector('#chat-scroll'),button=app.querySelector('#jump-latest');if(!scroller||!button)return;
  const near=nearLatest(scroller);if(near)unreadIncoming=0;
  button.hidden=near;button.setAttribute('aria-label',unreadIncoming?(lang==='hi'?`${unreadIncoming} नए संदेश देखें`:`View ${unreadIncoming} new messages`):(lang==='hi'?'नए संदेशों पर जाएँ':'Go to latest messages'));
  const count=button.querySelector('.jump-latest-count');count.hidden=!unreadIncoming;count.textContent=unreadIncoming>99?'99+':String(unreadIncoming);
}
function updateConnection(){
  const banner=app.querySelector('#chat-connection');if(!banner)return;
  const unavailable=networkOffline||navigator.onLine===false;banner.hidden=!unavailable&&!offline&&!sessionEnded;
  banner.dataset.state=unavailable?'offline':'reconnecting';
  const label=sessionEnded?(lang==='hi'?'सहेजी गई चैट उपलब्ध है। इस बातचीत तक ऑनलाइन पहुँच समाप्त हो गई है।':'Your saved chat is available. Online access to this conversation has ended.'):unavailable?(lang==='hi'?'आप ऑफ़लाइन हैं। भेजे नहीं गए संदेश यहीं हैं।':'You are offline. Your unsent messages are kept.'):(lang==='hi'?'फिर जुड़ रहे हैं… भेजे नहीं गए संदेश यहीं हैं।':'Reconnecting… Your unsent messages are kept.');
  const note=banner.querySelector('span');if(note.textContent!==label)note.textContent=label;
  const retry=banner.querySelector('button');retry.hidden=unavailable||sessionEnded;retry.textContent=lang==='hi'?'फिर कोशिश करें':'Try again';
}
function bindChatLayout(){
  releaseChatLayout();const section=app.querySelector('.chat'),scroller=app.querySelector('#chat-scroll'),composer=app.querySelector('#composer');let frame=null;
  const resize=()=>{if(frame!==null)return;frame=requestAnimationFrame(()=>{frame=null;if(stage!=='chat'||!section.isConnected)return;const pinned=nearLatest(scroller),anchor=pinned?null:captureThreadAnchor(scroller),viewport=window.visualViewport;const height=Math.round(viewport&&viewport.scale===1?viewport.height:window.innerHeight);document.documentElement.style.setProperty('--chat-viewport-height',`${height}px`);section.style.setProperty('--chat-composer-height',`${Math.ceil(composer.getBoundingClientRect().height)}px`);if(pinned)scroller.scrollTop=scroller.scrollHeight;else restoreThreadAnchor(scroller,anchor);updateJump();});};
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(resize):null;observer?.observe(composer);
  window.addEventListener('resize',resize,{passive:true});window.visualViewport?.addEventListener('resize',resize,{passive:true});
  scroller.addEventListener('scroll',updateJump,{passive:true});resize();
  releaseChatLayout=()=>{observer?.disconnect();window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize);scroller.removeEventListener('scroll',updateJump);if(frame!==null)cancelAnimationFrame(frame);document.documentElement.style.removeProperty('--chat-viewport-height');releaseChatLayout=()=>{};};
}
async function loadEarlier(){
  if(olderLoading||!localOlder&&!history.state().hasOlder)return;
  const id=chat.id;olderLoading=true;drawHistory();
  try{const scroller=app.querySelector('#chat-scroll'),anchor=captureThreadAnchor(scroller);if(localOlder){const saved=await deviceStore.read({id,beforeId:localOldestId});if(chat?.id!==id||stage!=='chat')return;if(saved){localOlder=saved.hasOlderLocal;localOldestId=saved.oldestId??localOldestId;chat=history.accept(chat,{...saved.chat,page:undefined},{kind:'older'});fingerprint='';drawChat();restoreThreadAnchor(scroller,anchor);return;}localOlder=false;}if(sessionEnded||!sessionVerified||networkOffline)return;const next=await api(history.route('/api/chat',{older:true}));if(chat?.id!==id||stage!=='chat')return;acceptServerChat(next,{kind:'older'});restoreThreadAnchor(scroller,anchor);}
  catch(error){if(error.status===401)endSession();else toast(error.message);}
  finally{olderLoading=false;drawHistory();}
}
function pendingMessages(){return outbox.list().filter(r=>r.conversationId===chat?.id).map(record=>({id:record.snapshot.editId||'local-'+record.clientId,clientId:record.clientId,role:'user',kind:'customer',body:[record.snapshot.body,...(record.snapshot.attachments||[]).map(a=>'📎 '+(a.file?.name||a.uploaded?.title||'Attachment'))].filter(Boolean).join('\n'),created:record.created,status:'outgoing',replyTo:record.snapshot.replyTo||null,reactions:[],sendState:record.state,sendError:record.error,sendUncertain:record.uncertain,editId:record.snapshot.editId||null}));}
function displayMessages(){const local=pendingMessages(),edits=new Map(local.filter(m=>m.editId).map(m=>[m.editId,m]));return[...chat.messages.map(m=>edits.has(m.id)?{...m,...edits.get(m.id),created:m.created}:m),...local.filter(m=>!m.editId)];}
function savedConfig(){try{return JSON.parse(localStorage.getItem('rekha-public-config-v1')||'null');}catch{return null;}}
function erasedDeviceChat(id){try{return localStorage.getItem('rekha-erased-chat-v1')===id;}catch{return false;}}
function showClearedDeviceChat(){stage='splash';chatPoll.stop();messaging?.destroy();messaging=null;calls?.destroy();calls=null;app.innerHTML=`<section class="loading"><h1>${lang==='hi'?'डिवाइस की चैट मिटा दी गई':'Saved device chat cleared'}</h1><p>${lang==='hi'?'सर्वर की कॉपी मिटाने के लिए सहायता लें या फिर ऑनलाइन बातचीत खोलें।':'The server copy remains. Contact support to delete it, or reopen the connected conversation.'}</p><p><a href="https://rekhaastrology.in/astrorani/data-deletion.html" target="_blank" rel="noopener noreferrer">${t('deletionHelp')}</a></p><button class="primary" id="reopen-chat">${lang==='hi'?'बातचीत खोलें':'Open conversation'}</button></section>`;app.querySelector('#reopen-chat').onclick=()=>{allowDeviceRestore=true;void boot();};}
function persistPending(){
  clearTimeout(pendingSaveTimer);pendingSaveTimer=null;
  if(suppressDeviceSave||!chat||stage!=='chat')return Promise.resolve(false);
  return deviceStore.savePending(chat.id,{records:outbox.list(),draft:messaging?.preserveDraft?.()||composerDraft});
}
function schedulePendingSave(){if(suppressDeviceSave||closingApp||stage!=='chat')return;clearTimeout(pendingSaveTimer);pendingSaveTimer=setTimeout(()=>void persistPending(),120);}
function restorePending(saved){
  if(!saved?.pending||saved.chat.id!==chat?.id)return;
  suppressDeviceSave=true;
  try{if(saved.pending.draft)messaging?.restoreDraft?.(saved.pending.draft);for(const pending of saved.pending.records){const record=outbox.enqueue({...pending,prepare:(draft,options)=>messaging.prepareDraft(draft,options),finish:draft=>messaging?.finishDraft?.(draft)});record.state=pending.state;record.uncertain=pending.uncertain;record.attempts=pending.attempts||0;}outbox.reconcile(chat);}
  finally{suppressDeviceSave=false;}
  fingerprint='';drawChat();
}
async function closeCurrentApp(){
  if(closingApp)return;closingApp=true;
  try{const draft=messaging?.preserveDraft?.()||composerDraft,hasPending=outbox.list().length>0||Boolean(draft&&(draft.body||draft.attachments?.length||draft.replyTo||draft.editId));for(const record of outbox.list())if(record.state==='sending')record.uncertain=true;outbox.pause({abort:true});const saved=await persistPending();await deviceStore.flush();
    if(hasPending&&!saved){closingApp=false;toast(lang==='hi'?'संदेश सहेज नहीं पाए। आपकी चैट खुली है; डिवाइस में जगह खाली करके फिर कोशिश करें।':'Could not save your unsent messages. Your chat is still open; free device storage and try again.');return;}
    if(typeof window.RekhaDevice?.closeApp==='function'){chatPoll.stop();calls?.destroy();messaging?.destroy();window.RekhaDevice.closeApp();return;}
    window.close();toast(lang==='hi'?'बाहर जाने के लिए यह टैब बंद करें। आपकी चैट सहेजी गई है।':'Close this tab to exit. Your chat is saved on this device.');
  }finally{if(!closingApp||!window.RekhaDevice?.closeApp){closingApp=false;if(stage==='chat'&&!sessionEnded)outbox.resume({retryUncertain:true});}}
}
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 5500); }
function updateLanguage(value) { lang = Object.hasOwn(languages,value)?value:'en'; document.documentElement.lang = lang === 'hinglish' ? 'hi-Latn' : lang;if(config?.appSettings){const subtitle=document.querySelector('.story-copy p');if(subtitle)subtitle.textContent=text('tagline');document.querySelector('meta[name="description"]')?.setAttribute('content',text('tagline'));} }
function choices(prefs = {}) { return `<label class="permission"><input id="location-choice" type="checkbox" ${prefs.location ? 'checked' : ''}><span><strong>${t('location')}</strong><p>${t('locationText')}</p></span></label><p class="footnote">${lang==='hi'?'आपकी चैट इस डिवाइस पर सहेजी जाती है और ऐप दोबारा खोलने पर लौटती है।':'Your chat is saved on this device and resumes when you reopen the app.'}</p>`; }
async function readChoices(container, skip = false) {
  const result = { remember: true, location: null };
  if (!skip && container.querySelector('#location-choice').checked) {
    if (chat?.preferences.location) result.location = chat.preferences.location;
    else try {
      const position = await new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error());
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
      });
      result.location = { latitude: Math.round(position.coords.latitude * 10) / 10, longitude: Math.round(position.coords.longitude * 10) / 10 };
    } catch { toast(text('locationDenied')); }
  }
  return result;
}
function renderChat() {
  releaseOnboarding();
  releaseChatLayout();forceLatest=true;unreadIncoming=0;incomingHighWater=Math.max(0,...chat.messages.filter(message=>message.role==='assistant').map(message=>Number(message.id)||0));
  if(outboxChatId&&outboxChatId!==chat.id){outbox.clear();composerDraft=null;}outboxChatId=chat.id;
  if(history.state().id!==chat.id)history.reset(chat);
  chatMutation++;
  messageMarkup.clear();
  messaging?.destroy(); messaging = null;
  stage = 'chat';sessionEnded=false; updateLanguage(chat.language); fingerprint = '';
  sounds.observe(chat,{kind:'initial'});
  document.body.classList.add('chat-mode');
  const securityNote = conversationNotice();
  app.innerHTML = `<section class="chat" aria-label="${esc(astrologerName())} chat"><header class="chat-head"><button type="button" class="chat-back" id="chat-back" aria-label="Conversation settings">${chatIcon('back')}</button><button type="button" class="chat-contact" id="chat-contact" aria-label="${esc(astrologerName())} conversation details"><img class="avatar" src="${esc(logo())}" alt=""><span class="chat-contact-copy"><strong class="chat-name">${esc(astrologerName())}</strong><span class="chat-caption" title="Chat availability; replies may arrive later">${esc(chatAvailability())}</span></span></button><button type="button" class="icon-button" id="chat-privacy" aria-label="Conversation menu" title="Conversation menu">${chatIcon('more')}</button></header><div class="chat-scroll" id="chat-scroll" role="log" aria-live="polite" aria-relevant="additions text"><div class="chat-notices"><div class="conversation-security">${chatIcon('lock',12)}<span class="conversation-security-text">${esc(securityNote)}</span></div><div class="chat-ribbon" id="chat-ribbon"></div></div><div class="date-divider">${t('newChapter')}</div><div id="messages"></div><div id="chat-bottom"></div></div><form class="composer" id="composer"><div class="compose-row"><div class="compose-input"><textarea id="message-input" rows="1" maxlength="2000" aria-label="${t('messagePlaceholder')}" placeholder="${esc(messagePlaceholder())}"></textarea></div><button class="send compose-primary" type="submit" aria-label="${t('send')}">${chatIcon('send')}</button></div><p class="error" id="send-error" role="alert"></p><p class="footnote">${t('reflection')}</p></form></section>`;
  const connection=document.createElement('div');connection.id='chat-connection';connection.className='chat-connection';connection.hidden=true;connection.setAttribute('role','status');connection.setAttribute('aria-live','polite');connection.innerHTML='<span></span><button type="button" id="connection-retry"></button>';app.querySelector('.chat-head').after(connection);
  connection.querySelector('button').onclick=()=>{if(networkOffline||navigator.onLine===false)return;outbox.resume({retryUncertain:true});chatPoll.poke({immediate:true});};
  const jump=document.createElement('button');jump.id='jump-latest';jump.className='jump-latest';jump.type='button';jump.hidden=true;jump.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 7 6 6 6-6M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="jump-latest-count" hidden></span>';app.querySelector('#composer').before(jump);jump.onclick=()=>{const scroller=app.querySelector('#chat-scroll');scroller.scrollTop=scroller.scrollHeight;unreadIncoming=0;updateJump();};
  app.querySelector('.date-divider').textContent=lang==='hi'?'बातचीत की शुरुआत':'Start of conversation';
  const older=document.createElement('button');older.id='load-earlier';older.className='history-more';older.type='button';older.onclick=loadEarlier;app.querySelector('.date-divider').before(older);
  const composerInput=app.querySelector('#message-input');
  composerInput.oninput=()=>{composerInput.style.height='auto';composerInput.style.height=Math.max(48,Math.min(composerInput.scrollHeight,120))+'px';};
  composerInput.setAttribute('enterkeyhint',matchMedia('(pointer: coarse)').matches?'enter':'send');
  app.querySelector('#chat-back').setAttribute('aria-label','Close app');
  app.querySelector('#chat-back').onclick=closeCurrentApp;
  app.querySelector('#chat-contact').onclick=()=>privacy(true);
  app.querySelector('#chat-privacy').onclick = () => privacy(true);
  app.querySelector('#composer').onsubmit = send;
  app.querySelector('#composer').addEventListener('rekha:compose-state',event=>updateComposePrimary(event.detail));
  let composing=false;composerInput.addEventListener('compositionstart',()=>composing=true);composerInput.addEventListener('compositionend',()=>composing=false);
  app.querySelector('#message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing&&!composing&&event.keyCode!==229&&(!matchMedia('(pointer: coarse)').matches||event.ctrlKey||event.metaKey)) { event.preventDefault(); app.querySelector('#composer').requestSubmit(); } };
  messaging=createMessagingUI({app,api,getChat:()=>chat,getAppSettings:()=>config?.appSettings,setChat:acceptServerChat,toast,getLang:()=>lang,privacy,isBusy:()=>busy,sounds});
  app.querySelector('#composer').addEventListener('input',schedulePendingSave);
  app.querySelector('#composer').addEventListener('rekha:compose-state',schedulePendingSave);
  if(composerDraft){messaging.restoreDraft?.(composerDraft);composerDraft=null;}
  window.RekhaChatUI=messaging;
  outbox.resume();
  drawChat();chatPoll.start();
  window.dispatchEvent(new CustomEvent('rekha:chat-mounted',{detail:{header:app.querySelector('.chat-head'),conversationId:chat.id}}));
  if(!calls)calls=installCalls({role:'customer',getConversationId:()=>sessionVerified?chat?.id:null,getAppSettings:()=>config?.appSettings,notify:toast});
  calls.mount(app.querySelector('.chat-head'));
  updateComposePrimary();
  bindChatLayout();updateConnection();updateJump();
}
function updateComposePrimary(state){
  const button=app.querySelector('.compose-primary');if(!button)return;
  const hasContent=state?.hasContent??messaging?.hasContent()??false;
  app.querySelector('#composer').dataset.hasContent=String(hasContent);
  const canRecord=state?.canRecord??messaging?.canRecord?.()??false;
  const voice=!hasContent&&canRecord;
  const mode=voice?'voice':'send';if(button.dataset.mode!==mode){button.dataset.mode=mode;button.innerHTML=chatIcon(voice?'mic':'send');}
  button.type=voice?'button':'submit';button.title=voice?(lang==='hi'?'वॉइस संदेश रिकॉर्ड करें':'Record voice note'):messaging?.isEditing()?'Save edited message':text('send');button.setAttribute('aria-label',button.title);
  button.onclick=voice?()=>messaging?.startRecord?.():null;
  const disabled=voice?!canRecord:!(state?.canSend??messaging?.canSend?.()??hasContent);
  button.disabled=Boolean(disabled||sessionEnded||chat?.blocked||messagingPaused()||(chat?.locked&&!messaging?.isEditing()));
}
function drawChat() {
  if (stage !== 'chat') return;
  drawHistory();app.querySelector('.date-divider').hidden=history.state().hasOlder||chat.messages.some(message=>message.role!=='system');
  const visibleMessages=displayMessages(),{messages,...metadata}=chat,print=JSON.stringify([metadata,visibleMessages]);if(print===fingerprint){updateJump();return;}fingerprint=print;
  app.querySelector('.conversation-security-text').textContent = conversationNotice();
  app.querySelector('.chat-caption').textContent = chatAvailability();
  const scroller = app.querySelector('#chat-scroll'), nearBottom=nearLatest(scroller),anchor=!nearBottom&&!forceLatest?captureThreadAnchor(scroller):null;
  const incoming=visibleMessages.filter(message=>message.role==='assistant'&&Number(message.id)>incomingHighWater);if(incoming.length){incomingHighWater=Math.max(incomingHighWater,...incoming.map(message=>Number(message.id)));if(!nearBottom&&!forceLatest)unreadIncoming+=incoming.length;}
  app.querySelector('#chat-ribbon').textContent = !automationEnabled() || chat.guidedConversation ? '' : chat.entitlement !== 'free' ? text('unlocked') : `${chat.freeRemaining} ${text('free')}`;
  let lastDay='',lastRole='',lastTime=0;const format=dates(),quoteById=new Map(visibleMessages.map(m=>[m.id,m])),active=new Set();
  const renderedMessages = visibleMessages.map(m => {
    active.add(m.id);const date=new Date(m.created),day=`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,separatorDay=m.role!=='system'&&day!==lastDay,groupStart=separatorDay||m.role!==lastRole||date.getTime()-lastTime>300000,key=JSON.stringify([m,lang,astrologerName(),config.settingsRevision,separatorDay,groupStart,quoteById.get(m.replyTo)]),cached=messageMarkup.get(m.id);if(m.role!=='system')lastDay=day;lastRole=m.role;lastTime=date.getTime();
    if(cached?.key===key)return{id:m.id,html:cached.html};
    if(m.role==='system'){const html=`<div class="system-note" data-message="${m.id}">${esc(m.kind === 'demo-payment' ? text('demoPaid') : m.kind === 'payment' ? text('paid') : m.kind === 'refund' ? text('refund') : m.body)}</div>`;messageMarkup.set(m.id,{key,html});return{id:m.id,html};}
    const separator=separatorDay?`<div class="day-label">${esc(format.day.format(date))}</div>`:'';
    const extras=messageExtras(m,{...chat,messages:visibleMessages},astrologerName());
    if(m.sendState){extras.actions='';extras.receipt='';const label=m.sendState==='sending'?(lang==='hi'?'भेजा जा रहा है…':'Sending…'):m.sendState==='queued'?(navigator.onLine===false?(lang==='hi'?'कनेक्शन का इंतज़ार':'Waiting for connection'):(lang==='hi'?'भेजने की कतार में':'Queued')):m.sendUncertain?(lang==='hi'?'डिलीवरी की पुष्टि नहीं हुई':'Delivery not confirmed'):(lang==='hi'?'भेजा नहीं गया':'Not sent');extras.metadata+=`<span class="outbox-state ${m.sendState}" data-send-state="${m.sendState}" title="${esc(m.sendError||label)}" aria-label="${esc(label)}">${esc(label)}</span>${m.sendState==='failed'?`<button type="button" class="outbox-retry" data-retry-send="${esc(m.clientId)}" ${sessionEnded?'disabled':''}>${lang==='hi'?'फिर भेजें':'Retry'}</button>`:''}`;}
    const html=`<article data-message="${m.id}" class="message ${m.role === 'user' ? 'user' : ''} ${groupStart?'group-start':'group-continuation'}">${separator}<span class="sender">${m.role === 'user' ? t('you') : esc(astrologerName())}</span><div class="bubble">${extras.actions}${extras.reply}<div class="message-content">${messageBody(m)}</div><span class="stamp">${extras.metadata}<time datetime="${esc(date.toISOString())}">${format.time.format(date)}</time>${extras.receipt}</span>${extras.reactionHtml}</div></article>`;messageMarkup.set(m.id,{key,html});return{id:m.id,html};
  });
  for(const id of messageMarkup.keys())if(!active.has(id))messageMarkup.delete(id);
  syncThread(app.querySelector('#messages'),renderedMessages);
  const waiting = chat.messages.find(m => m.role === 'user' && ['pending','failed'].includes(m.status));
  let bottom = '';
  if (automationEnabled() && waiting?.status === 'pending') bottom = `<div class="waiting"><span class="flame" aria-hidden="true"></span>${t('thinking')}</div>`;
  if (automationEnabled() && waiting?.status === 'failed') bottom = `<p class="error">${t('failed')}</p><button class="secondary" id="retry">${t('retry')}</button>`;
  if (automationEnabled() && chat.locked) bottom = `<section class="offer"><span class="eyebrow">${t('offerEyebrow')}</span><h3>${t('offerTitle')}</h3><p>${t('offerText')}</p><div class="price-line"><span class="price">${esc(price())}</span><span>${t('oneTime')}</span></div><button class="primary" id="unlock" ${checkoutBusy ? 'disabled' : ''}>${config.paymentMode === 'demo' ? t('demoUnlock') : t('unlock')}</button><p class="footnote">${t('offerFooter')}</p></section>`;
  if (automationEnabled() && visibleMessages.length === 1) bottom = `<div class="prompt-chips">${t('topics').map(text => `<button class="chip" data-prompt="${esc(text)}">${esc(text)}</button>`).join('')}</div>`;
  const bottomElement=app.querySelector('#chat-bottom');if(bottomElement.innerHTML!==bottom)bottomElement.innerHTML=bottom;
  const input = app.querySelector('#message-input'); input.disabled = chat.locked;
  input.placeholder = chat.blocked ? 'This conversation is unavailable.' : messagingPaused() ? (lang==='hi'?'संदेश भेजना अभी रोका गया है।':'Messaging is paused. You can still read your chat.') : chat.locked ? text('lockedPlaceholder') : messagePlaceholder();
  input.setAttribute('aria-label',text('messagePlaceholder'));
  input.disabled = (chat.locked && !messaging?.isEditing()) || chat.blocked || busy || messagingPaused() || sessionEnded;
  app.querySelector('.send').disabled = input.disabled;
  for (const button of app.querySelectorAll('[data-prompt]')) button.onclick = () => { input.value = button.dataset.prompt; input.dispatchEvent(new Event('input',{bubbles:true}));input.focus(); };
  if(app.querySelector('#retry'))app.querySelector('#retry').onclick=async()=>{try{acceptServerChat(await api('/api/retry','POST',{}));}catch(error){toast(error.message);} };
  if (app.querySelector('#unlock')) app.querySelector('#unlock').onclick = checkout;
  for(const button of app.querySelectorAll('[data-retry-send]'))button.onclick=()=>{if(sessionEnded||chat.blocked||messagingPaused())return toast('Messages are currently unavailable. Your unsent message is kept.');outbox.retry(button.dataset.retrySend);};
  if(nearBottom||forceLatest){scroller.scrollTop=scroller.scrollHeight;unreadIncoming=0;}else restoreThreadAnchor(scroller,anchor);forceLatest=false;updateJump();
  messaging?.refresh();
  updateComposePrimary();
  window.dispatchEvent(new CustomEvent('rekha:chat-refreshed',{detail:{conversationId:chat.id}}));
}
function send(event) {
  event.preventDefault(); if (busy) return;
  const input = app.querySelector('#message-input'), body = input.value.trim(); if ((!body&&!messaging?.hasContent()) || input.disabled) return;
  app.querySelector('#send-error').textContent='';
  try {
    const snapshot=messaging.takeDraft(body,crypto.randomUUID());if(!snapshot)return;
    chatMutation++;forceLatest=true;outbox.enqueue({snapshot,conversationId:chat.id,baseVersion:Number(chat.version)||0,prepare:messaging.prepareDraft,finish:messaging.finishDraft});
    chatPoll.poke({immediate:true});
    if(!input.value)input.style.height='48px';input.focus();
  }
  catch (error) { app.querySelector('#send-error').textContent = error.message; }
}
async function refresh({signal}={}) {
  if (stage !== 'chat' || document.hidden || networkOffline || navigator.onLine===false || busy || refresh.pending) return;
  refresh.pending = true;
  try {
    const id=chat.id,previous=JSON.stringify([chat.version,chat.updated,chat.typing,history.state().revision]),kind=history.state().revision===null?'initial':'delta';
    let settings=null;if(Date.now()-configReadAt>=120000){configReadAt=Date.now();settings=api('/api/config','GET',undefined,{signal}).then(value=>{if(stage==='chat')applyPublishedConfig(value);}).catch(()=>{});}
    const next=await api(history.route('/api/chat'),'GET',undefined,{signal});await settings;if(stage!=='chat'||chat?.id!==id||signal?.aborted)return;
    if(next.id!==id){endSession();return;}sessionVerified=true;
    acceptServerChat(next,{kind});messaging?.refresh();if(offline){toast(text('restored'));offline=false;}outbox.resume({retryUncertain:true});calls?.poll();updateConnection();
    return{changed:previous!==JSON.stringify([chat.version,chat.updated,chat.typing,history.state().revision]),again:!!next.hasMoreChanges};
  } catch (error) {
    if(signal?.aborted)return;
    if (error.status === 401) endSession();
    else if (!offline) { offline = true; toast(text('connection')); }
    updateConnection();throw error;
  } finally { refresh.pending = false; }
}
async function checkout() {
  if (checkoutBusy) return;chatMutation++;checkoutBusy = true; app.querySelector('#unlock').disabled = true;
  const reset = () => { checkoutBusy = false;fingerprint='';drawChat();outbox.resume({retryUncertain:true}); };
  try {
    if (config.paymentMode === 'demo') { acceptServerChat(await api('/api/payment/demo','POST',{})); reset(); return; }
    const order = await api('/api/payment/order','POST',{});
    if (!window.Razorpay) await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://checkout.razorpay.com/v1/checkout.js'; script.onload = resolve; script.onerror = reject; document.head.append(script); });
    const payment = new window.Razorpay({ key: order.key, amount: order.amount, currency: order.currency, order_id: order.id, name: brandName(), description: 'Continued conversation with '+astrologerName(), theme: { color: getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim()||'#075e54' },
      handler: async result => { try {acceptServerChat(await api('/api/payment/verify','POST',result));}catch(error){toast(error.message);}finally{reset();} },
      modal: { ondismiss: () => { toast(text('checkoutCancelled')); reset(); } },
    });
    payment.on('payment.failed', () => { toast(text('generalError')); reset(); }); payment.open();
  } catch (error) { toast(error.message || text('generalError')); reset(); }
}
function privacy(editable) {
  dialog.innerHTML = `<h2 id="privacy-title">${t('privacy')}</h2><p>${t('privacyUse')}</p><p><a href="https://rekhaastrology.in/astrorani/privacy-policy.html" target="_blank" rel="noopener noreferrer">${t('fullPrivacy')}</a> · <a href="https://rekhaastrology.in/astrorani/data-deletion.html" target="_blank" rel="noopener noreferrer">${t('deletionHelp')}</a></p><p>${esc(text('retention').replace('{days}',config.retentionDays??config.appSettings?.service?.retentionDays??30))}</p>${editable ? `<h3>${t('optionalEdit')}</h3>${choices(chat.preferences)}<button class="primary" id="save-privacy">${t('save')}</button><button class="text-button danger" id="delete-chat">${t('delete')}</button>` : ''}<div class="dialog-actions"><button class="secondary" id="close-dialog">${t('close')}</button></div>`;
  dialog.querySelector('#close-dialog').onclick = () => dialog.close();
  if (editable) {
    dialog.querySelector('#save-privacy').onclick = async event => { const button = event.currentTarget; button.disabled = true; try { const prefs = await readChoices(dialog);acceptServerChat(await api('/api/preferences','PATCH',prefs));dialog.close();toast(text('privacySaved'));}catch(error){toast(error.message);}finally{button.disabled=false;} };
    dialog.querySelector('#delete-chat').onclick = confirmDelete;
  }
  const title=dialog.querySelector('#privacy-title');title.tabIndex=-1;
  if (!dialog.open) dialog.showModal();
  title.focus({preventScroll:true});dialog.scrollTop=0;
}
function confirmDelete() {
  const localOnly=sessionEnded||!sessionVerified||networkOffline||navigator.onLine===false;let serverDeleted=false;
  const title=localOnly?(lang==='hi'?'इस डिवाइस की सहेजी चैट मिटाएँ?':'Clear saved chat on this device?'):text('deleteTitle'),description=localOnly?(lang==='hi'?'यह केवल इस डिवाइस की चैट, ड्राफ़्ट और न भेजे संदेश मिटाएगा। सर्वर की कॉपी नहीं मिटेगी; उसे मिटाने के लिए ऑनलाइन जुड़ें या सहायता लें।':'This clears only this device’s saved chat, drafts and unsent messages. The server copy remains; reconnect or contact support to delete it.'):text('deleteText');
  dialog.innerHTML = `<h2 id="privacy-title">${esc(title)}</h2><p>${esc(description)}</p><div class="dialog-actions"><button class="secondary" id="cancel-delete">${t('cancel')}</button><button class="secondary danger" id="confirm-delete">${localOnly?(lang==='hi'?'इस डिवाइस से मिटाएँ':'Clear from this device'):t('confirmDelete')}</button></div>`;
  dialog.querySelector('#cancel-delete').onclick = () => privacy(true);
  dialog.querySelector('#confirm-delete').onclick = async event => {const button=event.currentTarget;button.disabled=true;outbox.pause({abort:true});try{const id=chat.id;if(!localOnly&&!serverDeleted){await api('/api/chat','DELETE',{});serverDeleted=true;}suppressDeviceSave=true;clearTimeout(pendingSaveTimer);if(!await deviceStore.erase(id))throw new Error('Could not clear the saved device chat. Please retry or clear this app’s storage in your device settings.');try{localStorage.setItem('rekha-erased-chat-v1',id);}catch{}chatPoll.stop();messaging?.destroy();messaging=null;calls?.destroy();calls=null;outbox.clear();composerDraft=null;chat=null;sessionVerified=false;localOlder=false;localOldestId=null;history.reset();sounds.reset();dialog.close();suppressDeviceSave=false;if(localOnly)showClearedDeviceChat();else videoSignup();}catch(error){suppressDeviceSave=false;toast(error.message);button.disabled=false;if(!serverDeleted)outbox.resume();else endSession();} };
}
function videoSignup(progress={}){
  releaseOnboarding();releaseChatLayout();calls?.destroy();calls=null;messaging?.destroy();messaging=null;chatPoll.stop();outbox.pause();
  document.body.classList.remove('chat-mode');stage='onboarding';
  onboarding=mountVideoSignup(app,{brandName:brandName(),language:lang,profile,progress,onLanguage:updateLanguage,onSubmit:createKundliChat});
  releaseOnboarding=()=>{onboarding?.dispose();onboarding=null;releaseOnboarding=()=>{};};
}
async function createKundliChat(details,progress){
  if(busy||stage!=='onboarding')return;busy=true;profile={...details};updateLanguage(details.language);
  releaseOnboarding();stage='preparing';renderKundliPreparation(app,lang);const started=performance.now();
  try{
    let next;
    try{next=await api('/api/start','POST',{...details,onboarding:'video-kundli-v1',preferences:{remember:true,location:null}});}
    catch(error){
      // A lost response may already have set the private session cookie.
      // Recover that conversation before allowing another signup attempt.
      if(!error.status||error.status>=500||error.status===409){const existing=await api('/api/chat').catch(()=>null);if(existing)next=existing;else throw error;}else throw error;
    }
    await waitForPreparation(started);chat=next;sessionVerified=true;history.reset(next);await deviceStore.merge(next,{kind:'initial',history:history.state()});profile={};renderChat();
  }catch(error){videoSignup(progress);onboarding.setError(error.message);}
  finally{busy=false;}
}
async function boot() {
  if(booting)return;booting=true;sessionVerified=false;
  const saved=await deviceStore.read(),cached=saved&&!erasedDeviceChat(saved.chat.id)?saved:null,cachedConfig=savedConfig();
  if(cached){applyPublishedConfig(cachedConfig||{automationEnabled:false,rewardsEnabled:false,paymentMode:'demo',amount:4900,retentionDays:30});chat=cached.chat;history.reset({id:chat.id,changeRevision:cached.history?.revision,page:{oldestId:cached.history?.oldestId,hasOlder:cached.history?.hasOlder}});localOlder=cached.hasOlderLocal;localOldestId=cached.oldestId;suppressDeviceSave=true;renderChat();restorePending(cached);suppressDeviceSave=false;offline=true;updateConnection();}
  try {
    const resumeKind=cached&&history.state().revision!==null?'delta':'initial';
    let [nextConfig,nextChat]=await Promise.all([api('/api/config').catch(error=>{if(cachedConfig)return cachedConfig;throw error;}),api(cached?history.route('/api/chat'):'/api/chat').catch(error=>{if(error.status===401)return null;throw error;})]);applyPublishedConfig(nextConfig);
    // Resume the saved change cursor so edits and deletions outside the latest
    // page are not skipped. A different private session needs its own first page.
    if(nextChat&&cached&&nextChat.id!==cached.chat.id&&resumeKind==='delta')nextChat=await api('/api/chat');
    if(nextChat&&erasedDeviceChat(nextChat.id)){
      if(!allowDeviceRestore){showClearedDeviceChat();return;}
      if(!await deviceStore.allowRestore(nextChat.id))throw new Error('Could not reopen saved device storage. Please retry.');
      try{localStorage.removeItem('rekha-erased-chat-v1');}catch{}
    }
    if(nextChat){
      if(chat&&chat.id===nextChat.id){sessionVerified=true;acceptServerChat(nextChat,{kind:resumeKind});messaging?.refresh();}
      else{if(chat)await persistPending();suppressDeviceSave=true;outbox.clear();composerDraft=null;calls?.destroy();calls=null;chat=nextChat;history.reset(nextChat);localOlder=false;localOldestId=null;sessionVerified=true;await deviceStore.merge(nextChat,{kind:'initial',history:history.state()});renderChat();suppressDeviceSave=false;}
      offline=false;outbox.resume({retryUncertain:true});calls?.poll();updateConnection();schedulePendingSave();if(nextChat.hasMoreChanges)chatPoll.poke({immediate:true});
    }else if(cached)endSession();else{chat=null;videoSignup();}
  }catch(error){if(chat&&stage==='chat'){offline=true;updateConnection();}else{app.innerHTML=`<section class="loading"><h1>A quiet pause.</h1><p>${esc(error.message)}</p><button class="primary" id="reload">Try again</button></section>`;app.querySelector('#reload').onclick=boot;}}
  finally{booting=false;allowDeviceRestore=false;}
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
document.addEventListener('visibilitychange',()=>{if(document.hidden)void persistPending();else if(stage==='chat')outbox.resume({retryUncertain:true});});
window.addEventListener('pagehide',()=>void persistPending());
window.addEventListener('rekha:native-back',event=>{event.preventDefault();void closeCurrentApp();});
window.addEventListener('offline',()=>{networkOffline=true;offline=true;updateConnection();requestChatDraw();});
window.addEventListener('online',()=>{networkOffline=false;if(stage==='chat'){updateConnection();outbox.resume({retryUncertain:true});chatPoll.poke({immediate:true});}});
window.addEventListener('beforeunload',event=>{void persistPending();if(!closingApp&&(stage==='preparing'||stage==='onboarding'&&onboarding?.draft().name||outbox.isPending()||messaging?.hasContent()||messaging?.hasLiveCapture?.()||composerDraft&&(composerDraft.body||composerDraft.attachments?.length))){event.preventDefault();event.returnValue='';}});
boot();
