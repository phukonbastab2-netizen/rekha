import { messageBody, syncThread } from './media.js';
import { languages } from './locales.js';
import { createMessagingUI, messageExtras } from './messaging-ui.js';
import { installCalls } from './calls.js';
import { createSendQueue } from './send-queue.js';
import { createAdaptivePoll } from './adaptive-poll.js';
import { createChatHistory,historyHeaders,captureThreadAnchor,restoreThreadAnchor } from './chat-history.js';
import { chatIcon } from './chat-icons.js';
import { createChatSounds } from './chat-sounds.js';
const app = document.querySelector('#app'), dialog = document.querySelector('#privacy-dialog');
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let lang = 'en', config, chat, stage = 'splash', profile = {}, busy = false, checkoutBusy = false, fingerprint = '', offline = false, messaging = null, composerDraft=null;
let calls, configReadAt=0, sessionEnded=false,chatMutation=0,outboxChatId=null;
const history=createChatHistory();let olderLoading=false;
const messageMarkup=new Map(),dateFormatters=new Map();
const sounds=createChatSounds({scope:'customer',incomingRole:'assistant',canPlay:()=>stage==='chat'&&!sessionEnded&&!messaging?.hasLiveCapture?.()&&!document.querySelector('.call-panel')});
const outbox=createSendQueue({
  online:()=>navigator.onLine!==false&&!sessionEnded&&Boolean(chat),
  send:async(record,{signal})=>{if(!chat||chat.id!==record.conversationId||sessionEnded)throw Object.assign(new Error('This chat session has ended. Your message was not sent.'),{status:401});const payload=await record.prepare(record.snapshot,{signal});if(!payload)throw Object.assign(new Error('There is no message to send.'),{status:400});return payload.editId?api(`/api/messages/${payload.editId}`,'PATCH',{body:payload.body},{signal}):api('/api/messages','POST',payload,{signal});},
  onAck:next=>{acceptServerChat(next);chatPoll.poke({immediate:true});},
  onConfirmed:record=>{record.finish?.(record.snapshot);if(!record.snapshot.editId)sounds.play('sent');},
  onError:error=>{if(error.status===401)endSession();},
  onChange:()=>{fingerprint='';if(stage==='chat')drawChat();},
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
const introEnabled=()=>config?.appSettings?.onboarding?.introEnabled!==false;
const messagingPaused=()=>config?.appSettings?.chat?.customerMessagingEnabled===false;
const messagePlaceholder=()=>config?.appSettings?.copy?.[lang]?.messagePlaceholder||(lang==='hi'?'संदेश':lang==='hinglish'?'Message':'Message');
const logo=(portrait=false)=>brand().logoMediaId?`/brand/logo?revision=${encodeURIComponent(String(config?.settingsRevision??0))}`:portrait?'/rekha-portrait.png':'/icon-192.png';
function applyPublishedConfig(next){
  const previous=JSON.stringify([config?.appSettings,config?.settingsRevision,config?.amount,config?.retentionDays]);
  config=next;configReadAt=Date.now();
  const changed=previous!==JSON.stringify([config?.appSettings,config?.settingsRevision,config?.amount,config?.retentionDays]);
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
  if(stage==='chat'){app.querySelector('.chat-name').textContent=astrologerName();app.querySelector('.chat-caption').textContent=text('tagline');app.querySelector('.composer .footnote').textContent=text('reflection');fingerprint='';drawChat();updateComposePrimary();}
  window.dispatchEvent(new CustomEvent('rekha:app-settings',{detail:{appSettings:config.appSettings,settingsRevision:config.settingsRevision}}));
}
const previewLabel = () => [!chat?.guidedConversation && config.aiMode === 'demo' ? (lang === 'hi' ? 'नमूना उत्तर' : 'Sample replies') : '', config.paymentMode === 'demo' || config.paymentTest ? (lang === 'hi' ? 'परीक्षण भुगतान · कोई असली शुल्क नहीं' : 'Payment preview · no real charges') : ''].filter(Boolean).join(' · ');
async function api(route, method = 'GET', body, {signal}={}) {
  let response;
  try{response=await fetch(route,{method,credentials:'same-origin',cache:'no-store',headers:{...historyHeaders,...(method!=='GET'?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(40000)]):AbortSignal.timeout(40000)});}catch(error){if(signal?.aborted)throw error;throw new Error(navigator.onLine===false?'You are offline. Your unsent message is kept.':'Could not confirm delivery. Please retry your message.');}
  let data;try{data=await response.json();}catch{throw Object.assign(new Error('The connection returned an unreadable response. Please try again.'),{status:response.ok?undefined:response.status});}
  if(!response.ok){const queuedWrite=method==='POST'&&route==='/api/messages'||method==='PATCH'&&/^\/api\/messages\/\d+$/.test(route);if(response.status===401&&stage==='chat'&&!queuedWrite)endSession();throw Object.assign(new Error(data.error||text('generalError')),{status:response.status});}
  return data;
}
function endSession(){chatPoll.stop();sessionEnded=true;outbox.pause({abort:true});messaging?.destroy();messaging=null;calls?.destroy();calls=null;toast(text('expired'));const input=app.querySelector('#message-input'),send=app.querySelector('.send');if(input)input.disabled=true;if(send)send.disabled=true;}
function acceptServerChat(next,{kind='mutation'}={}){
  if(!next||!Array.isArray(next.messages)||chat&&next.id!==chat.id)return false;
  chat=history.accept(chat,next,{kind});
  chatMutation++;outbox.reconcile(chat);sounds.observe(chat,{kind});if(stage==='chat')drawChat();return true;
}
function drawHistory(){const button=app.querySelector('#load-earlier');if(!button)return;button.hidden=!history.state().hasOlder;button.disabled=olderLoading;button.textContent=olderLoading?(lang==='hi'?'पुराने संदेश खुल रहे हैं…':'Loading earlier messages…'):(lang==='hi'?'पुराने संदेश देखें':'Load earlier messages');}
async function loadEarlier(){
  if(olderLoading||!history.state().hasOlder||sessionEnded)return;
  const id=chat.id;olderLoading=true;drawHistory();
  try{const next=await api(history.route('/api/chat',{older:true}));if(chat?.id!==id||stage!=='chat')return;const scroller=app.querySelector('#chat-scroll'),anchor=captureThreadAnchor(scroller);acceptServerChat(next,{kind:'older'});restoreThreadAnchor(scroller,anchor);}
  catch(error){if(error.status===401)endSession();else toast(error.message);}
  finally{olderLoading=false;drawHistory();}
}
function pendingMessages(){return outbox.list().filter(r=>r.conversationId===chat?.id).map(record=>({id:record.snapshot.editId||'local-'+record.clientId,clientId:record.clientId,role:'user',kind:'customer',body:[record.snapshot.body,...(record.snapshot.attachments||[]).map(a=>'📎 '+(a.file?.name||a.uploaded?.title||'Attachment'))].filter(Boolean).join('\n'),created:record.created,status:'outgoing',replyTo:record.snapshot.replyTo||null,reactions:[],sendState:record.state,sendError:record.error,sendUncertain:record.uncertain,editId:record.snapshot.editId||null}));}
function displayMessages(){const local=pendingMessages(),edits=new Map(local.filter(m=>m.editId).map(m=>[m.editId,m]));return[...chat.messages.map(m=>edits.has(m.id)?{...m,...edits.get(m.id),created:m.created}:m),...local.filter(m=>!m.editId)];}
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 5500); }
function updateLanguage(value) { lang = Object.hasOwn(languages,value)?value:'en'; document.documentElement.lang = lang === 'hinglish' ? 'hi-Latn' : lang;if(config?.appSettings){const subtitle=document.querySelector('.story-copy p');if(subtitle)subtitle.textContent=text('tagline');document.querySelector('meta[name="description"]')?.setAttribute('content',text('tagline'));} }
function screen(number, body) {
  calls?.destroy(); calls=null;
  messaging?.destroy(); messaging = null;
  document.body.classList.remove('chat-mode');
  app.innerHTML = `<section class="screen"><div class="screen-top"><span class="small-brand">${esc(brandName())} <span aria-hidden="true">✦</span></span><span class="step">${t('step')} 0${number} ${t('of')} 03</span></div><div class="steps" aria-hidden="true">${[1,2,3].map(n => `<span class="${n <= number ? 'active' : ''}"></span>`).join('')}</div>${body}<div class="center"><button class="text-button privacy-open">${t('privacy')}</button></div></section>`;
  app.querySelector('.privacy-open').onclick = () => privacy(false);
}
function chooseLanguage() {
  stage = 'language';
  screen(1, `<h2>${t('languageTitle')}</h2><p class="subtitle">${t('languageSubtitle')}</p><div class="language-grid" role="group" aria-label="Language">${[['hi','अ','हिन्दी','Hindi'],['en','Aa','English','English'],['hinglish','अa','Hinglish','Hindi, in English letters']].map(([key,glyph,title,sub]) => `<button class="language ${lang === key ? 'selected' : ''}" data-language="${key}" aria-pressed="${lang === key}"><span class="glyph">${glyph}</span><span><strong>${title}</strong><small>${sub}</small></span><span class="radio" aria-hidden="true"></span></button>`).join('')}</div><button class="primary" id="language-next">${t('continue')} <span aria-hidden="true">→</span></button><div class="ornament" aria-hidden="true">✧</div>`);
  for (const button of app.querySelectorAll('[data-language]')) button.onclick = () => { updateLanguage(button.dataset.language); chooseLanguage(); app.querySelector(`[data-language="${lang}"]`).focus(); };
  app.querySelector('#language-next').onclick = details;
}
function details() {
  stage = 'details'; const max = new Date(); max.setUTCFullYear(max.getUTCFullYear() - 18);
  screen(2, `<h2>${t('detailsTitle')}</h2><p class="subtitle">${t('detailsSubtitle')}</p><form id="details-form"><label class="field">${t('name')}<input name="name" autocomplete="given-name" maxlength="60" required placeholder="${t('namePlaceholder')}" value="${esc(profile.name || '')}"></label><label class="field">${t('dob')}<input name="dob" type="date" required min="1900-01-01" max="${max.toISOString().slice(0,10)}" value="${esc(profile.dob || '')}"></label><div class="kundli-note"><strong>${t('kundli')}</strong><small>${t('kundliNote')}</small></div><p class="privacy-note"><a href="https://rekhaastrology.in/astrorani/privacy-policy.html" target="_blank" rel="noopener noreferrer">${t('fullPrivacy')}</a></p><label class="check-row"><input type="checkbox" name="consent" required ${profile.consent ? 'checked' : ''}><span>${t('consent')}</span></label><p class="error" id="form-error" role="alert"></p><button class="primary" type="submit">${t('continue')} <span aria-hidden="true">→</span></button><button class="text-button" id="details-back" type="button">← ${t('back')}</button></form>`);
  app.querySelector('#details-form').onsubmit = event => { event.preventDefault(); const data = new FormData(event.target); profile = { name: data.get('name').trim(), dob: data.get('dob'), consent: data.get('consent') === 'on' }; if (!profile.name) { app.querySelector('#form-error').textContent = text('required'); return; } permissionScreen(); };
  app.querySelector('#details-back').onclick = chooseLanguage;
}
function choices(prefs = {}) { return `<label class="permission"><input id="location-choice" type="checkbox" ${prefs.location ? 'checked' : ''}><span><strong>${t('location')}</strong><p>${t('locationText')}</p></span></label><label class="permission"><input id="remember-choice" type="checkbox" ${prefs.remember ? 'checked' : ''}><span><strong>${t('remember')}</strong><p>${t('rememberText')}</p></span></label>`; }
function permissionScreen() {
  stage = 'permissions';
  screen(3, `<h2>${t('permissionsTitle')}</h2><p class="subtitle">${t('permissionsSubtitle')}</p>${choices()}<p class="privacy-note"><span aria-hidden="true">◇</span>${t('permissionNote')}</p><button class="primary" id="enter-chat">${t('enterChat')} <span aria-hidden="true">→</span></button><div class="center"><button class="text-button" id="skip-permissions">${t('skip')}</button></div><p class="error" id="form-error" role="alert"></p><button class="text-button" id="permissions-back">← ${t('back')}</button>`);
  app.querySelector('#enter-chat').onclick = () => start(false);
  app.querySelector('#skip-permissions').onclick = () => start(true);
  app.querySelector('#permissions-back').onclick = details;
}
async function readChoices(container, skip = false) {
  const result = { remember: !skip && container.querySelector('#remember-choice').checked, location: null };
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
async function start(skip) {
  if (busy) return; busy = true;
  app.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try { const preferences = await readChoices(app, skip); chat = await api('/api/start', 'POST', { ...profile, language: lang, preferences }); profile = {}; renderChat(); }
  catch (error) { app.querySelector('#form-error').textContent = error.message; }
  finally { busy = false; if(stage==='chat'){fingerprint='';drawChat();}else app.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
}
function renderChat() {
  if(outboxChatId&&outboxChatId!==chat.id){outbox.clear();composerDraft=null;}outboxChatId=chat.id;
  if(history.state().id!==chat.id)history.reset(chat);
  chatMutation++;
  messageMarkup.clear();
  messaging?.destroy(); messaging = null;
  stage = 'chat';sessionEnded=false; updateLanguage(chat.language); fingerprint = '';
  sounds.observe(chat,{kind:'initial'});
  document.body.classList.add('chat-mode');
  const previewNotes = previewLabel();
  app.innerHTML = `<section class="chat" aria-label="${esc(astrologerName())} chat"><header class="chat-head"><button type="button" class="chat-back" id="chat-back" aria-label="${introEnabled()?'Back to introduction':'Conversation settings'}">${chatIcon('back')}</button><button type="button" class="chat-contact" id="chat-contact" aria-label="${esc(astrologerName())} conversation details"><img class="avatar" src="${esc(logo())}" alt=""><span class="chat-contact-copy"><strong class="chat-name">${esc(astrologerName())}</strong><span class="chat-caption">${t('tagline')}</span></span></button><button type="button" class="icon-button" id="chat-privacy" aria-label="Conversation menu" title="Conversation menu">${chatIcon('more')}</button></header><div class="chat-scroll" id="chat-scroll" role="log" aria-live="polite" aria-relevant="additions text"><div class="chat-notices"><div class="demo-ribbon">${esc(previewNotes)}</div><div class="chat-ribbon" id="chat-ribbon"></div></div><div class="date-divider">${t('newChapter')}</div><div id="messages"></div><div id="chat-bottom"></div></div><form class="composer" id="composer"><div class="compose-row"><div class="compose-input"><textarea id="message-input" rows="1" maxlength="2000" aria-label="${t('messagePlaceholder')}" placeholder="${esc(messagePlaceholder())}"></textarea></div><button class="send compose-primary" type="submit" aria-label="${t('send')}">${chatIcon('send')}</button></div><p class="error" id="send-error" role="alert"></p><p class="footnote">${t('reflection')}</p></form></section>`;
  app.querySelector('.date-divider').textContent=lang==='hi'?'बातचीत की शुरुआत':'Start of conversation';
  const older=document.createElement('button');older.id='load-earlier';older.className='history-more';older.type='button';older.onclick=loadEarlier;app.querySelector('.date-divider').before(older);
  const composerInput=app.querySelector('#message-input');
  composerInput.oninput=()=>{composerInput.style.height='auto';composerInput.style.height=Math.min(composerInput.scrollHeight,120)+'px';};
  app.querySelector('#chat-back').onclick=()=>introEnabled()?introduction():privacy(true);
  app.querySelector('#chat-contact').onclick=()=>privacy(true);
  app.querySelector('#chat-privacy').onclick = () => privacy(true);
  app.querySelector('#composer').onsubmit = send;
  app.querySelector('#composer').addEventListener('rekha:compose-state',event=>updateComposePrimary(event.detail));
  let composing=false;composerInput.addEventListener('compositionstart',()=>composing=true);composerInput.addEventListener('compositionend',()=>composing=false);
  app.querySelector('#message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing&&!composing&&event.keyCode!==229) { event.preventDefault(); app.querySelector('#composer').requestSubmit(); } };
  messaging=createMessagingUI({app,api,getChat:()=>chat,getAppSettings:()=>config?.appSettings,setChat:acceptServerChat,toast,getLang:()=>lang,privacy,introduction,isBusy:()=>busy,sounds});
  if(composerDraft){messaging.restoreDraft?.(composerDraft);composerDraft=null;}
  window.RekhaChatUI=messaging;
  outbox.resume();
  drawChat();chatPoll.start();
  window.dispatchEvent(new CustomEvent('rekha:chat-mounted',{detail:{header:app.querySelector('.chat-head'),conversationId:chat.id}}));
  if(!calls)calls=installCalls({role:'customer',getConversationId:()=>chat?.id,getAppSettings:()=>config?.appSettings,notify:toast});
  calls.mount(app.querySelector('.chat-head'));
  updateComposePrimary();
}
function updateComposePrimary(state){
  const button=app.querySelector('.compose-primary');if(!button)return;
  const hasContent=state?.hasContent??messaging?.hasContent()??false;
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
  const visibleMessages=displayMessages(),print=JSON.stringify([chat,visibleMessages]);if(print===fingerprint)return;fingerprint=print;
  app.querySelector('.demo-ribbon').textContent = previewLabel();
  const scroller = app.querySelector('#chat-scroll'), nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  app.querySelector('#chat-ribbon').textContent = chat.guidedConversation ? '' : chat.entitlement !== 'free' ? text('unlocked') : `${chat.freeRemaining} ${text('free')}`;
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
  if (waiting?.status === 'pending') bottom = `<div class="waiting"><span class="flame" aria-hidden="true"></span>${t('thinking')}</div>`;
  if (waiting?.status === 'failed') bottom = `<p class="error">${t('failed')}</p><button class="secondary" id="retry">${t('retry')}</button>`;
  if (chat.locked) bottom = `<section class="offer"><span class="eyebrow">${t('offerEyebrow')}</span><h3>${t('offerTitle')}</h3><p>${t('offerText')}</p><div class="price-line"><span class="price">${esc(price())}</span><span>${t('oneTime')}</span></div><button class="primary" id="unlock" ${checkoutBusy ? 'disabled' : ''}>${config.paymentMode === 'demo' ? t('demoUnlock') : t('unlock')}</button><p class="footnote">${t('offerFooter')}</p></section>`;
  if (visibleMessages.length === 1) bottom = `<div class="prompt-chips">${t('topics').map(text => `<button class="chip" data-prompt="${esc(text)}">${esc(text)}</button>`).join('')}</div>`;
  app.querySelector('#chat-bottom').innerHTML = bottom;
  const input = app.querySelector('#message-input'); input.disabled = chat.locked;
  input.placeholder = chat.blocked ? 'This conversation is unavailable.' : messagingPaused() ? (lang==='hi'?'संदेश भेजना अभी रोका गया है।':'Messaging is paused. You can still read your chat.') : chat.locked ? text('lockedPlaceholder') : messagePlaceholder();
  input.setAttribute('aria-label',text('messagePlaceholder'));
  input.disabled = (chat.locked && !messaging?.isEditing()) || chat.blocked || busy || messagingPaused() || sessionEnded;
  app.querySelector('.send').disabled = input.disabled;
  for (const button of app.querySelectorAll('[data-prompt]')) button.onclick = () => { input.value = button.dataset.prompt; input.dispatchEvent(new Event('input',{bubbles:true}));input.focus(); };
  if(app.querySelector('#retry'))app.querySelector('#retry').onclick=async()=>{try{acceptServerChat(await api('/api/retry','POST',{}));}catch(error){toast(error.message);} };
  if (app.querySelector('#unlock')) app.querySelector('#unlock').onclick = checkout;
  for(const button of app.querySelectorAll('[data-retry-send]'))button.onclick=()=>{if(sessionEnded||chat.blocked||messagingPaused())return toast('Messages are currently unavailable. Your unsent message is kept.');outbox.retry(button.dataset.retrySend);};
  if (nearBottom || chat.locked) scroller.scrollTop = scroller.scrollHeight;
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
    chatMutation++;outbox.enqueue({snapshot,conversationId:chat.id,baseVersion:Number(chat.version)||0,prepare:messaging.prepareDraft,finish:messaging.finishDraft});
    chatPoll.poke({immediate:true});
    if(!input.value)input.style.height='44px';input.focus();app.querySelector('#chat-scroll').scrollTop=app.querySelector('#chat-scroll').scrollHeight;
  }
  catch (error) { app.querySelector('#send-error').textContent = error.message; }
}
async function refresh({signal}={}) {
  if (stage !== 'chat' || document.hidden || navigator.onLine===false || busy || refresh.pending) return;
  refresh.pending = true;
  try {
    const id=chat.id,previous=JSON.stringify([chat.version,chat.updated,chat.typing,history.state().revision]),kind=history.state().revision===null?'initial':'delta';
    let settings=null;if(Date.now()-configReadAt>=120000){configReadAt=Date.now();settings=api('/api/config','GET',undefined,{signal}).then(value=>{if(stage==='chat')applyPublishedConfig(value);}).catch(()=>{});}
    const next=await api(history.route('/api/chat'),'GET',undefined,{signal});await settings;if(stage!=='chat'||chat?.id!==id||signal?.aborted)return;
    acceptServerChat(next,{kind});messaging?.refresh();if(offline){toast(text('restored'));offline=false;}
    return{changed:previous!==JSON.stringify([chat.version,chat.updated,chat.typing,history.state().revision]),again:!!next.hasMoreChanges};
  } catch (error) {
    if(signal?.aborted)return;
    if (error.status === 401) endSession();
    else if (!offline) { offline = true; toast(text('connection')); }
    throw error;
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
  if(introEnabled()){const introButton=document.createElement('button');introButton.className='text-button';introButton.textContent='Watch our introduction';introButton.onclick=()=>{dialog.close();introduction();};dialog.querySelector('.dialog-actions').before(introButton);}
  if (editable) {
    dialog.querySelector('#save-privacy').onclick = async event => { const button = event.currentTarget; button.disabled = true; try { const prefs = await readChoices(dialog);acceptServerChat(await api('/api/preferences','PATCH',prefs));dialog.close();toast(text('privacySaved'));}catch(error){toast(error.message);}finally{button.disabled=false;} };
    dialog.querySelector('#delete-chat').onclick = confirmDelete;
  }
  const title=dialog.querySelector('#privacy-title');title.tabIndex=-1;
  if (!dialog.open) dialog.showModal();
  title.focus({preventScroll:true});dialog.scrollTop=0;
}
function confirmDelete() {
  dialog.innerHTML = `<h2 id="privacy-title">${t('deleteTitle')}</h2><p>${t('deleteText')}</p><div class="dialog-actions"><button class="secondary" id="cancel-delete">${t('cancel')}</button><button class="secondary danger" id="confirm-delete">${t('confirmDelete')}</button></div>`;
  dialog.querySelector('#cancel-delete').onclick = () => privacy(true);
  dialog.querySelector('#confirm-delete').onclick = async event => {event.currentTarget.disabled=true;outbox.pause({abort:true});try{await api('/api/chat','DELETE',{});chatPoll.stop();stage='language';outbox.clear();composerDraft=null;chat=null;history.reset();sounds.reset();dialog.close();chooseLanguage();}catch(error){toast(error.message);event.currentTarget.disabled=false;outbox.resume();} };
}
function introduction() {
  if(!introEnabled()){if(stage==='chat'){toast(lang==='hi'?'परिचय अभी उपलब्ध नहीं है।':'The introduction is currently unavailable.');return;}if(chat)renderChat();else chooseLanguage();return;}
  if(messaging?.hasLiveCapture?.()){toast('Finish or cancel your recording or permission request first.');return;}
  calls?.destroy();calls=null;
  if(stage==='chat'&&messaging)composerDraft=messaging.preserveDraft?.()||null;
  outbox.pause();
  messaging?.destroy(); messaging=null;
  document.body.classList.remove('chat-mode');
  stage='intro';chatPoll.stop();
  const labels={welcome:'Welcome',introduction:'Meet us',testimonials:'Testimonials'},configured=config.appSettings?.onboarding?.introOrder,order=Array.isArray(configured)&&configured.length===3&&new Set(configured).size===3&&configured.every(id=>Object.hasOwn(labels,id))?configured:['welcome','introduction','testimonials'],first=order[0];
  app.innerHTML=`<section class="intro screen"><span class="eyebrow">WELCOME · स्वागत है</span><h1>${esc(brandName())}</h1><p class="subtitle">${t('tagline')}</p><video id="intro-video" controls playsinline preload="none" poster="${esc(logo(true))}" src="/intro/${first}.mp4"></video><p id="video-note" class="footnote" role="status">Tap play to watch. You can continue whenever you are ready.</p><div class="intro-choices" role="group" aria-label="Introduction videos">${order.map((id,index)=>`<button class="intro-choice ${id===first?'selected':''}" data-video="${id}" aria-pressed="${id===first}"><small>0${index+1}</small>${labels[id]}</button>`).join('')}</div><button class="primary" id="intro-continue">Continue to chat →</button><p class="footnote">Your own space for questions and conversation.</p></section>`;
  const video=app.querySelector('video');
  video.onerror=()=>{app.querySelector('#video-note').textContent='The video could not load. You can still continue to chat.';};
  for(const button of app.querySelectorAll('[data-video]'))button.onclick=()=>{video.pause();video.src='/intro/'+button.dataset.video+'.mp4';video.load();for(const item of app.querySelectorAll('[data-video]')){item.classList.toggle('selected',item===button);item.setAttribute('aria-pressed',String(item===button));}app.querySelector('#video-note').textContent='Tap play to watch.';};
  app.querySelector('#intro-continue').onclick=()=>{video.pause();try{localStorage.setItem('rekha-intro-v1','seen');}catch{}if(chat)renderChat();else chooseLanguage();};
}
async function boot() {
  try {
    const [nextConfig,nextChat]=await Promise.all([api('/api/config'),api('/api/chat').catch(error=>{if(error.status===401)return null;throw error;})]);applyPublishedConfig(nextConfig);chat=nextChat;
    let seen=false;try{seen=localStorage.getItem('rekha-intro-v1')==='seen';}catch{}
    if(chat&&(seen||!introEnabled()))renderChat();else if(introEnabled())introduction();else chooseLanguage();
  }catch(error){app.innerHTML=`<section class="loading"><h1>A quiet pause.</h1><p>${esc(error.message)}</p><button class="primary" id="reload">Try again</button></section>`;app.querySelector('#reload').onclick=boot;}
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&stage==='chat')outbox.resume({retryUncertain:true});});
window.addEventListener('online',()=>{if(stage==='chat')outbox.resume({retryUncertain:true});});
window.addEventListener('beforeunload',event=>{if(outbox.isPending()||messaging?.hasContent()||messaging?.hasLiveCapture?.()||composerDraft&&(composerDraft.body||composerDraft.attachments?.length)){event.preventDefault();event.returnValue='';}});
boot();
