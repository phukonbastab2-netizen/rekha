import { messageBody, syncThread } from './media.js';
import { languages } from './locales.js';
import { createMessagingUI, messageExtras } from './messaging-ui.js';
import { installCalls } from './calls.js';
const app = document.querySelector('#app'), dialog = document.querySelector('#privacy-dialog');
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let lang = 'en', config, chat, stage = 'splash', profile = {}, interval, busy = false, checkoutBusy = false, fingerprint = '', offline = false, pendingSend = null, messaging = null;
let calls, configReadAt=0, sessionEnded=false,chatMutation=0;
const messageMarkup=new Map(),dateFormatters=new Map();
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
  if(stage==='chat'){app.querySelector('.chat-name').textContent=brandName();app.querySelector('.chat-caption').textContent=text('tagline');app.querySelector('.composer .footnote').textContent=text('reflection');app.querySelector('.send').setAttribute('aria-label',text('send'));fingerprint='';drawChat();}
  window.dispatchEvent(new CustomEvent('rekha:app-settings',{detail:{appSettings:config.appSettings,settingsRevision:config.settingsRevision}}));
}
const previewLabel = () => [!chat?.guidedConversation && config.aiMode === 'demo' ? (lang === 'hi' ? 'नमूना उत्तर' : 'Sample replies') : '', config.paymentMode === 'demo' || config.paymentTest ? (lang === 'hi' ? 'परीक्षण भुगतान · कोई असली शुल्क नहीं' : 'Payment preview · no real charges') : ''].filter(Boolean).join(' · ');
async function api(route, method = 'GET', body) {
  const response = await fetch(route, { method, credentials: 'same-origin', cache: 'no-store', headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || text('generalError')), { status: response.status });
  return data;
}
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
  screen(2, `<h2>${t('detailsTitle')}</h2><p class="subtitle">${t('detailsSubtitle')}</p><form id="details-form"><label class="field">${t('name')}<input name="name" autocomplete="given-name" maxlength="60" required placeholder="${t('namePlaceholder')}" value="${esc(profile.name || '')}"></label><label class="field">${t('dob')}<input name="dob" type="date" required min="1900-01-01" max="${max.toISOString().slice(0,10)}" value="${esc(profile.dob || '')}"></label><div class="kundli-note"><strong>${t('kundli')}</strong><small>${t('kundliNote')}</small></div><label class="check-row"><input type="checkbox" name="consent" required ${profile.consent ? 'checked' : ''}><span>${t('consent')}</span></label><p class="error" id="form-error" role="alert"></p><button class="primary" type="submit">${t('continue')} <span aria-hidden="true">→</span></button><button class="text-button" id="details-back" type="button">← ${t('back')}</button></form>`);
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
  chatMutation++;
  messageMarkup.clear();
  messaging?.destroy(); messaging = null;
  stage = 'chat';sessionEnded=false; updateLanguage(chat.language); fingerprint = '';
  document.body.classList.add('chat-mode');
  const previewNotes = previewLabel();
  app.innerHTML = `<section class="chat"><header class="chat-head"><img class="avatar" src="${esc(logo())}" alt=""><div><h1 class="chat-name">${esc(brandName())}</h1><div class="chat-caption">${t('tagline')}</div></div><button class="icon-button" id="chat-privacy" aria-label="${t('privacy')}" title="${t('privacy')}">⋯</button></header><div class="demo-ribbon">${esc(previewNotes)}</div><div class="chat-ribbon" id="chat-ribbon"></div><div class="chat-scroll" id="chat-scroll" role="log" aria-live="polite" aria-relevant="additions text"><div class="date-divider">${t('newChapter')}</div><div id="messages"></div><div id="chat-bottom"></div></div><form class="composer" id="composer"><div class="compose-row"><textarea id="message-input" rows="1" maxlength="2000" aria-label="${t('messagePlaceholder')}" placeholder="${t('messagePlaceholder')}"></textarea><button class="send" type="submit" aria-label="${t('send')}">↑</button></div><p class="error" id="send-error" role="alert"></p><p class="footnote">${t('reflection')}</p></form></section>`;
  app.querySelector('#chat-privacy').textContent='⋮';
  app.querySelector('.send').innerHTML='<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="m3 3 19 9-19 9v-7l13-2L3 10z"/></svg>';
  app.querySelector('.date-divider').textContent=lang==='hi'?'बातचीत की शुरुआत':'Start of conversation';
  const composerInput=app.querySelector('#message-input');
  composerInput.oninput=()=>{composerInput.style.height='auto';composerInput.style.height=Math.min(composerInput.scrollHeight,120)+'px';};
  app.querySelector('#chat-privacy').onclick = () => privacy(true);
  app.querySelector('#composer').onsubmit = send;
  app.querySelector('#message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); app.querySelector('#composer').requestSubmit(); } };
  messaging=createMessagingUI({app,api,getChat:()=>chat,getAppSettings:()=>config?.appSettings,setChat:next=>{chatMutation++;chat=next;drawChat();},toast,getLang:()=>lang,privacy,introduction,isBusy:()=>busy});
  window.RekhaChatUI=messaging;
  drawChat(); clearInterval(interval); interval = setInterval(refresh, 2200);
  window.dispatchEvent(new CustomEvent('rekha:chat-mounted',{detail:{header:app.querySelector('.chat-head'),conversationId:chat.id}}));
  if(!calls)calls=installCalls({role:'customer',getConversationId:()=>chat?.id,getAppSettings:()=>config?.appSettings,notify:toast});
  calls.mount(app.querySelector('.chat-head'));calls.poll();
}
function drawChat() {
  if (stage !== 'chat') return;
  const print = JSON.stringify(chat); if (print === fingerprint) return; fingerprint = print;
  app.querySelector('.demo-ribbon').textContent = previewLabel();
  const scroller = app.querySelector('#chat-scroll'), nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  app.querySelector('#chat-ribbon').textContent = chat.guidedConversation ? (lang === 'hi' ? `${astrologerName()} के साथ आपकी बातचीत` : lang === 'hinglish' ? `${astrologerName()} ke saath aapki baatcheet` : `Your conversation with ${astrologerName()}`) : chat.entitlement !== 'free' ? text('unlocked') : `${chat.freeRemaining} ${text('free')}`;
  let lastDay='';const format=dates(),quoteById=new Map(chat.messages.map(m=>[m.id,m])),active=new Set();
  const renderedMessages = chat.messages.map(m => {
    active.add(m.id);const date=new Date(m.created),day=`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,separatorDay=m.role!=='system'&&day!==lastDay,key=JSON.stringify([m,lang,astrologerName(),config.settingsRevision,separatorDay,quoteById.get(m.replyTo)]),cached=messageMarkup.get(m.id);if(m.role!=='system')lastDay=day;
    if(cached?.key===key)return{id:m.id,html:cached.html};
    if(m.role==='system'){const html=`<div class="system-note" data-message="${m.id}">${esc(m.kind === 'demo-payment' ? text('demoPaid') : m.kind === 'payment' ? text('paid') : m.kind === 'refund' ? text('refund') : m.body)}</div>`;messageMarkup.set(m.id,{key,html});return{id:m.id,html};}
    const separator=separatorDay?`<div class="day-label">${esc(format.day.format(date))}</div>`:'';
    const extras=messageExtras(m,chat,astrologerName());
    const html=`<article data-message="${m.id}" class="message ${m.role === 'user' ? 'user' : ''}">${separator}<span class="sender">${m.role === 'user' ? t('you') : esc(astrologerName())}</span><div class="bubble">${extras.actions}${extras.reply}<div class="message-content">${messageBody(m)}</div><span class="stamp">${extras.metadata}${format.time.format(date)}${extras.receipt}</span>${extras.reactionHtml}</div></article>`;messageMarkup.set(m.id,{key,html});return{id:m.id,html};
  });
  for(const id of messageMarkup.keys())if(!active.has(id))messageMarkup.delete(id);
  syncThread(app.querySelector('#messages'),renderedMessages);
  const waiting = chat.messages.find(m => m.role === 'user' && ['pending','failed'].includes(m.status));
  let bottom = '';
  if (waiting?.status === 'pending') bottom = `<div class="waiting"><span class="flame" aria-hidden="true"></span>${t('thinking')}</div>`;
  if (waiting?.status === 'failed') bottom = `<p class="error">${t('failed')}</p><button class="secondary" id="retry">${t('retry')}</button>`;
  if (chat.locked) bottom = `<section class="offer"><span class="eyebrow">${t('offerEyebrow')}</span><h3>${t('offerTitle')}</h3><p>${t('offerText')}</p><div class="price-line"><span class="price">${esc(price())}</span><span>${t('oneTime')}</span></div><button class="primary" id="unlock" ${checkoutBusy ? 'disabled' : ''}>${config.paymentMode === 'demo' ? t('demoUnlock') : t('unlock')}</button><p class="footnote">${t('offerFooter')}</p></section>`;
  if (chat.messages.length === 1) bottom = `<div class="prompt-chips">${t('topics').map(text => `<button class="chip" data-prompt="${esc(text)}">${esc(text)}</button>`).join('')}</div>`;
  app.querySelector('#chat-bottom').innerHTML = bottom;
  const input = app.querySelector('#message-input'); input.disabled = chat.locked;
  input.placeholder = chat.blocked ? 'This conversation is unavailable.' : messagingPaused() ? (lang==='hi'?'संदेश भेजना अभी रोका गया है।':'Messaging is paused. You can still read your chat.') : chat.locked ? text('lockedPlaceholder') : text('messagePlaceholder');
  input.setAttribute('aria-label',text('messagePlaceholder'));
  input.disabled = (chat.locked && !messaging?.isEditing()) || chat.blocked || busy || messagingPaused() || sessionEnded;
  app.querySelector('.send').disabled = input.disabled;
  for (const button of app.querySelectorAll('[data-prompt]')) button.onclick = () => { input.value = button.dataset.prompt; input.focus(); };
  if (app.querySelector('#retry')) app.querySelector('#retry').onclick = async () => { try { chat = await api('/api/retry','POST',{}); drawChat(); } catch (error) { toast(error.message); } };
  if (app.querySelector('#unlock')) app.querySelector('#unlock').onclick = checkout;
  if (nearBottom || chat.locked) scroller.scrollTop = scroller.scrollHeight;
  messaging?.refresh();
  window.dispatchEvent(new CustomEvent('rekha:chat-refreshed',{detail:{conversationId:chat.id}}));
  calls?.poll();
}
async function send(event) {
  event.preventDefault(); if (busy) return;
  const input = app.querySelector('#message-input'), body = input.value.trim(); if ((!body&&!messaging?.hasContent()) || input.disabled) return;
  chatMutation++;busy = true; input.disabled = true; app.querySelector('.send').disabled = true; app.querySelector('#send-error').textContent = '';
  const signature=messaging?.draftSignature()||'';
  if (!pendingSend || pendingSend.body !== body || pendingSend.signature!==signature) pendingSend = { body, clientId: crypto.randomUUID(), signature };
  try {
    const payload=await messaging.preparePayload(body,pendingSend.clientId);if(!payload)return;
    chat=payload.editId?await api(`/api/messages/${payload.editId}`,'PATCH',{body:payload.body}):await api('/api/messages','POST',payload);
    pendingSend = null; input.value = ''; input.style.height='44px'; messaging.sent(); drawChat(); app.querySelector('#chat-scroll').scrollTop = app.querySelector('#chat-scroll').scrollHeight;
  }
  catch (error) { app.querySelector('#send-error').textContent = error.message; }
  finally { busy = false; input.disabled=Boolean((chat?.locked&&!messaging?.isEditing())||chat?.blocked||messagingPaused()||sessionEnded);app.querySelector('.send').disabled=input.disabled; }
}
async function refresh() {
  if (stage !== 'chat' || document.hidden || busy || refresh.pending) return;
  refresh.pending = true;
  const generation=chatMutation;
  try {
    if(Date.now()-configReadAt>=60000){configReadAt=Date.now();try{const nextConfig=await api('/api/config');if(stage==='chat')applyPublishedConfig(nextConfig);}catch{/* Existing chat remains usable while published settings are unavailable. */}}
    const next = await api('/api/chat'); if (stage !== 'chat'||busy||generation!==chatMutation) return;
    chat = next; drawChat(); messaging?.refresh(); if (offline) { toast(text('restored')); offline = false; }
  } catch (error) {
    if (error.status === 401) { clearInterval(interval);sessionEnded=true; messaging?.destroy(); messaging=null;calls?.destroy();calls=null; toast(text('expired')); app.querySelector('#message-input').disabled = true; app.querySelector('.send').disabled = true; }
    else if (!offline) { offline = true; toast(text('connection')); }
  } finally { refresh.pending = false; }
}
async function checkout() {
  if (checkoutBusy) return;chatMutation++;checkoutBusy = true; app.querySelector('#unlock').disabled = true;
  const reset = () => { checkoutBusy = false; fingerprint = ''; drawChat(); };
  try {
    if (config.paymentMode === 'demo') { chat = await api('/api/payment/demo','POST',{}); reset(); return; }
    const order = await api('/api/payment/order','POST',{});
    if (!window.Razorpay) await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://checkout.razorpay.com/v1/checkout.js'; script.onload = resolve; script.onerror = reject; document.head.append(script); });
    const payment = new window.Razorpay({ key: order.key, amount: order.amount, currency: order.currency, order_id: order.id, name: brandName(), description: 'Continued conversation with '+astrologerName(), theme: { color: getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim()||'#075e54' },
      handler: async result => { try { chat = await api('/api/payment/verify','POST',result); } catch (error) { toast(error.message); } finally { reset(); } },
      modal: { ondismiss: () => { toast(text('checkoutCancelled')); reset(); } },
    });
    payment.on('payment.failed', () => { toast(text('generalError')); reset(); }); payment.open();
  } catch (error) { toast(error.message || text('generalError')); reset(); }
}
function privacy(editable) {
  dialog.innerHTML = `<h2 id="privacy-title">${t('privacy')}</h2><p>${t('privacyUse')}</p><p>${esc(text('retention').replace('{days}',config.retentionDays??config.appSettings?.service?.retentionDays??30))}</p>${editable ? `<h3>${t('optionalEdit')}</h3>${choices(chat.preferences)}<button class="primary" id="save-privacy">${t('save')}</button><button class="text-button danger" id="delete-chat">${t('delete')}</button>` : ''}<div class="dialog-actions"><button class="secondary" id="close-dialog">${t('close')}</button></div>`;
  dialog.querySelector('#close-dialog').onclick = () => dialog.close();
  if(introEnabled()){const introButton=document.createElement('button');introButton.className='text-button';introButton.textContent='Watch our introduction';introButton.onclick=()=>{dialog.close();introduction();};dialog.querySelector('.dialog-actions').before(introButton);}
  if (editable) {
    dialog.querySelector('#save-privacy').onclick = async event => { const button = event.currentTarget; button.disabled = true; try { const prefs = await readChoices(dialog); chat = await api('/api/preferences','PATCH',prefs); drawChat(); dialog.close(); toast(text('privacySaved')); } catch (error) { toast(error.message); } finally { button.disabled = false; } };
    dialog.querySelector('#delete-chat').onclick = confirmDelete;
  }
  if (!dialog.open) dialog.showModal();
}
function confirmDelete() {
  dialog.innerHTML = `<h2 id="privacy-title">${t('deleteTitle')}</h2><p>${t('deleteText')}</p><div class="dialog-actions"><button class="secondary" id="cancel-delete">${t('cancel')}</button><button class="secondary danger" id="confirm-delete">${t('confirmDelete')}</button></div>`;
  dialog.querySelector('#cancel-delete').onclick = () => privacy(true);
  dialog.querySelector('#confirm-delete').onclick = async event => { event.currentTarget.disabled = true; try { await api('/api/chat','DELETE',{}); clearInterval(interval); chat = null; pendingSend = null; stage = 'language'; dialog.close(); chooseLanguage(); } catch (error) { toast(error.message); event.currentTarget.disabled = false; } };
}
function introduction() {
  if(!introEnabled()){if(stage==='chat'){toast(lang==='hi'?'परिचय अभी उपलब्ध नहीं है।':'The introduction is currently unavailable.');return;}if(chat)renderChat();else chooseLanguage();return;}
  calls?.destroy();calls=null;
  messaging?.destroy(); messaging=null;
  document.body.classList.remove('chat-mode');
  stage='intro';clearInterval(interval);
  const labels={welcome:'Welcome',introduction:'Meet us',testimonials:'Testimonials'},configured=config.appSettings?.onboarding?.introOrder,order=Array.isArray(configured)&&configured.length===3&&new Set(configured).size===3&&configured.every(id=>Object.hasOwn(labels,id))?configured:['welcome','introduction','testimonials'],first=order[0];
  app.innerHTML=`<section class="intro screen"><span class="eyebrow">WELCOME · स्वागत है</span><h1>${esc(brandName())}</h1><p class="subtitle">${t('tagline')}</p><video id="intro-video" controls playsinline preload="none" poster="${esc(logo(true))}" src="/intro/${first}.mp4"></video><p id="video-note" class="footnote" role="status">Tap play to watch. You can continue whenever you are ready.</p><div class="intro-choices" role="group" aria-label="Introduction videos">${order.map((id,index)=>`<button class="intro-choice ${id===first?'selected':''}" data-video="${id}" aria-pressed="${id===first}"><small>0${index+1}</small>${labels[id]}</button>`).join('')}</div><button class="primary" id="intro-continue">Continue to chat →</button><p class="footnote">Your own space for questions and conversation.</p></section>`;
  const video=app.querySelector('video');
  video.onerror=()=>{app.querySelector('#video-note').textContent='The video could not load. You can still continue to chat.';};
  for(const button of app.querySelectorAll('[data-video]'))button.onclick=()=>{video.pause();video.src='/intro/'+button.dataset.video+'.mp4';video.load();for(const item of app.querySelectorAll('[data-video]')){item.classList.toggle('selected',item===button);item.setAttribute('aria-pressed',String(item===button));}app.querySelector('#video-note').textContent='Tap play to watch.';};
  app.querySelector('#intro-continue').onclick=()=>{video.pause();try{localStorage.setItem('rekha-intro-v1','seen');}catch{}if(chat)renderChat();else chooseLanguage();};
}
async function boot() {
  try {
    applyPublishedConfig(await api('/api/config'));
    try {chat=await api('/api/chat');}catch(error){if(error.status!==401)throw error;}
    let seen=false;try{seen=localStorage.getItem('rekha-intro-v1')==='seen';}catch{}
    if(chat&&(seen||!introEnabled()))renderChat();else if(introEnabled())introduction();else chooseLanguage();
  }catch(error){app.innerHTML=`<section class="loading"><h1>A quiet pause.</h1><p>${esc(error.message)}</p><button class="primary" id="reload">Try again</button></section>`;app.querySelector('#reload').onclick=boot;}
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
boot();
