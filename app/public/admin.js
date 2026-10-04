import { messageBody, syncThread } from './media.js';
import { chatIcon } from './chat-icons.js';
import { openLibrary } from './library.js';
import { installCalls } from './calls.js';
import { openWorkflowSettings,openChatWorkflow } from './workflow-admin.js';
import { openAppSettings } from './app-settings-ui.js';
import { openFeatureAccess,getFeatureMedia,createRequestAbort } from './permissions.js';
import { createVoiceRecorder,voiceRecordingFile } from './messaging-ui.js';
import {createAdaptivePoll} from './adaptive-poll.js';
import {createChatHistory,historyHeaders,captureThreadAnchor,restoreThreadAnchor} from './chat-history.js';
import {createInboxPages} from './inbox-pages.js';
import {createChatSounds} from './chat-sounds.js';
import {openCustomerActivity,closeCustomerActivity} from './activity-admin.js';

const app = document.querySelector('#admin-app');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let selected=null, chats=[], current=null, dirty=false, fingerprint='', lastDraft='', loading=false, actionBusy=false;
let attachment=null, sendAttempt=null, quoted=null, filter='all', config={}, threadSearch='', onlyStarred=false, typingAt=0;
let recorder=null, recordingStream=null, recordingTimer=null, recordingSession=null, recordingRequest=null;
let calls;
const history=createChatHistory(),inboxPages=createInboxPages();
let inboxController=null,inboxLoading=false,searchTimer=null,olderLoading=false,connectionPaused=false;
let lastInboxSync=0,replySending=false,replyFailure='';
const ownerTextDrafts=new Map(),ownerDraftStorageKey='rekha:owner-text-drafts';
const sounds=createChatSounds({scope:'admin',incomingRole:'user',canPlay:()=>app.dataset.view!=='login'&&!startRecording.pending&&!recordingStream&&!document.querySelector('.call-panel')});
const soundedSends=new Set();
const inboxPoll=createAdaptivePoll({task:loadInbox,canRun:()=>app.dataset.view!=='login',fastMs:8000,idleMs:60000});
const threadPoll=createAdaptivePoll({task:poll,canRun:()=>Boolean(selected)&&app.dataset.view==='chat',hot:()=>current?.typing?.customer,idleMs:30000});
const readThrough=new Map();
const messageMarkup=new Map(),inboxMarkup=new Map();let inboxFingerprint='';
const timeFormatter=new Intl.DateTimeFormat('en-IN',{hour:'2-digit',minute:'2-digit'}),dayFormatter=new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',year:'numeric'}),inboxDateFormatter=new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short'});
async function api(route, method='GET', body,{signal}={}) {
  const request=createRequestAbort({signal,timeoutMs:40000});
  try{
    const response=await fetch(route,{method,credentials:'same-origin',cache:'no-store',headers:{...historyHeaders,...(method!=='GET'?{'Content-Type':'application/json'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:request.signal});
    let data;try{data=await response.json();}catch{throw Object.assign(new Error('The connection returned an unreadable response. Please try again.'),{status:response.ok?undefined:response.status});}if(!response.ok)throw Object.assign(new Error(data.error||'Please try again.'),{status:response.status});if(method==='POST'&&route==='/api/admin/app-settings/publish'){config={...config,appSettings:data.published,settingsRevision:data.revision};window.dispatchEvent(new CustomEvent('rekha:app-settings',{detail:{appSettings:config.appSettings,settingsRevision:config.settingsRevision}}));}return data;
  }finally{request.dispose();}
}
function notice(text) { const n=document.querySelector('#notice');n.textContent=text;n.hidden=false;clearTimeout(notice.timer);notice.timer=setTimeout(()=>n.hidden=true,5000); }
function mobileView(view){app.dataset.view=view;if(view==='chat')threadPoll.start({immediate:true});else threadPoll.stop();}
function sender(m){return m.role==='user'?current?.name||'Customer':config.appSettings?.brand?.astrologerName||'Rekha';}
function readable(m){if(m.deleted)return 'This message was deleted';if(m.kind==='media'){try{const d=JSON.parse(m.body);return [d.text,d.title,...(d.items||[]).map(i=>i.title)].filter(Boolean).join(' · ')||'Attachment';}catch{return 'Attachment';}}return m.body||'';}
function time(value){return timeFormatter.format(new Date(value));}
function latestPreview(c){return c.preview||c.lastMessage||c.last_message||`${c.language} · ${c.mode==='ai'?'Automatic':c.mode==='assist'?'Drafts':'Personal'}`;}
function loadOwnerDrafts(){
  ownerTextDrafts.clear();
  try{const saved=JSON.parse(sessionStorage.getItem(ownerDraftStorageKey)||'[]');if(!Array.isArray(saved))return;for(const row of saved.slice(-40))if(typeof row?.id==='string'&&typeof row.body==='string'&&row.body.trim()&&Number.isFinite(row.updated)&&Date.now()-row.updated<86400000)ownerTextDrafts.set(row.id,{body:row.body.slice(0,4000),updated:row.updated});}catch{/* Drafts remain in memory when browser storage is unavailable. */}
}
function writeOwnerDrafts(){
  while(ownerTextDrafts.size>40)ownerTextDrafts.delete(ownerTextDrafts.keys().next().value);
  try{if(ownerTextDrafts.size)sessionStorage.setItem(ownerDraftStorageKey,JSON.stringify([...ownerTextDrafts].map(([id,draft])=>({id,...draft}))));else sessionStorage.removeItem(ownerDraftStorageKey);}catch{/* A full or unavailable session store must not interrupt replies. */}
}
function saveOwnerDraft(id=selected,body=app.querySelector('#reply')?.value){
  if(!id||typeof body!=='string')return;
  ownerTextDrafts.delete(id);if(body.trim())ownerTextDrafts.set(id,{body:body.slice(0,4000),updated:Date.now()});writeOwnerDrafts();drawDraftStatus();
}
function clearOwnerDrafts(){ownerTextDrafts.clear();try{sessionStorage.removeItem(ownerDraftStorageKey);}catch{}}
function drawDraftStatus(){const label=app.querySelector('#local-draft-status');if(label)label.textContent=replySending?'Sending message…':replyFailure?'Reply kept here. Check your connection and retry.':ownerTextDrafts.has(selected)?'Unsent text saved in this tab.':'';}
function drawInboxStatus(){
  const status=app.querySelector('#inbox-status'),label=app.querySelector('#inbox-status-label'),retry=app.querySelector('#inbox-retry'),refresh=app.querySelector('#refresh-inbox');if(!status||!label)return;
  const offline=navigator.onLine===false;status.dataset.state=offline?'offline':connectionPaused?'retrying':inboxLoading?'loading':'live';
  label.textContent=offline?'You are offline. Saved messages stay visible.':connectionPaused?'Connection interrupted. Retrying automatically…':inboxLoading?'Updating your inbox…':lastInboxSync?'Inbox up to date':'Ready to receive customer messages';
  if(retry){retry.hidden=!connectionPaused||offline;retry.disabled=inboxLoading;}if(refresh)refresh.disabled=inboxLoading||offline;
  const summary=app.querySelector('#inbox-summary-label');if(summary){const waiting=chats.filter(c=>!c.archived&&!c.blocked&&c.waiting).length,unread=chats.filter(c=>!c.archived&&c.unread>0).length;summary.textContent=`Loaded: ${waiting} waiting · ${unread} unread`;}
}
function closeOwnerTools(){const menu=app.querySelector('.owner-tools-menu');if(menu)menu.open=false;}
function closeRecorder(cancel=true){
  recordingRequest?.abort();
  const session=recordingSession;
  if(session)session.cancelled=cancel;
  if(recorder&&recorder.state!=='inactive'){try{recorder.stop();}catch{if(session)session.cancelled=true;}}
  recordingStream?.getTracks().forEach(t=>t.stop());recordingStream=null;clearInterval(recordingTimer);recordingTimer=null;
  const row=app.querySelector('.recording-row');if(row)row.hidden=true;
  const button=app.querySelector('#voice-record');if(button)button.disabled=actionBusy||startRecording.pending;
}
function login({clearDrafts=true}={}) {
  closeCustomerActivity();
  sounds.reset();soundedSends.clear();
  if(clearDrafts)clearOwnerDrafts();dirty=false;attachment=null;quoted=null;sendAttempt=null;replySending=false;replyFailure='';lastInboxSync=0;connectionPaused=false;
  calls?.destroy();calls=null;
  inboxPoll.stop();threadPoll.stop();inboxController?.abort();clearTimeout(searchTimer);closeRecorder();readThrough.clear();selected=null;current=null;chats=[];history.reset();inboxPages.reset();mobileView('login');
  app.innerHTML=`<main class="login"><section class="login-card"><div class="brand"><img src="/icon-192.png" alt="">Rekha Astrology</div><h1>Your customer inbox.</h1><p class="muted">Read conversations, send messages and manage replies from your private admin app.</p><form id="login-form"><label>Owner password<input id="password" type="password" autocomplete="current-password" required minlength="16"></label><p id="login-error" class="error" role="alert"></p><button class="primary">Sign in securely →</button></form><a class="install-owner" href="/astrorani/RekhaAdmin.apk" download>Download private admin app ↓</a><p class="muted">Only the owner can access this panel.</p></section></main>`;
  app.querySelector('#login-form').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{await api('/api/admin/login','POST',{password:app.querySelector('#password').value});await workspace();}catch(error){if(error.status===401)clearOwnerDrafts();app.querySelector('#login-error').textContent=error.message;}finally{button.disabled=false;}};
}
async function workspace() {
  inboxFingerprint='';inboxMarkup.clear();messageMarkup.clear();
  inboxPages.reset('',filter);const request=inboxPages.request();const [list,nextConfig]=await Promise.all([api(request.route),api('/api/config')]);inboxPages.accept(list,request);chats=inboxPages.state().items;config=nextConfig;sounds.observeInbox(chats,{kind:'initial'});loadOwnerDrafts();lastInboxSync=Date.now();connectionPaused=false;
  if(!calls)calls=installCalls({role:'admin',getConversationId:()=>selected,notify:notice,getAppSettings:()=>config?.appSettings});
  app.innerHTML=`<header class="topbar"><div class="brand"><img src="/icon-192.png" alt=""><span class="brand-copy">Rekha <span class="brand-subtitle">Owner workspace</span></span><span class="private">PRIVATE ADMIN</span></div><div class="links"><button type="button" id="open-library">Media library</button><button type="button" id="open-quick-replies">Quick replies</button><details class="owner-tools-menu"><summary aria-label="Owner tools and settings">Owner tools <span aria-hidden="true">⌄</span></summary><div class="owner-tools-panel"><a class="install-owner" href="/astrorani/RekhaAdmin.apk" download>Download admin app ↓</a><button type="button" id="logout">Sign out</button></div></details></div></header><main class="workspace"><aside class="inbox"><div class="inbox-head"><h2>Chats <span id="count" class="badge"></span></h2><div class="inbox-summary"><span id="inbox-summary-label"></span><button type="button" id="refresh-inbox" aria-label="Refresh customer inbox">Refresh</button></div><input class="search" id="search" placeholder="Search customers or labels" aria-label="Search conversations"><nav class="inbox-filters" aria-label="Filter customers">${[['all','All'],['waiting','Waiting'],['unread','Unread'],['pinned','Pinned'],['archived','Archived'],['blocked','Blocked']].map(([key,label])=>`<button type="button" data-filter="${key}" aria-pressed="${filter===key}">${label}</button>`).join('')}</nav><div class="inbox-status" id="inbox-status" role="status" aria-live="polite"><span id="inbox-status-label"></span><button type="button" id="inbox-retry" hidden>Retry</button></div></div><div id="inbox-list"></div></aside><section class="conversation" id="conversation"><div class="empty"><div class="empty-icon">✧</div><h2>Your customer conversations.</h2><p>Choose a chat to reply, share media or update customer settings. You can send follow-ups anytime.</p></div></section><aside class="controls" id="controls"><h3>Customer & reply settings</h3><p class="muted">Open a chat to manage reply mode, notes and customer details.</p></aside></main>`;
  mobileView(selected?'chat':'inbox');
  app.querySelector('#open-library').onclick=()=>openLibrary({api,notice});
  app.querySelector('#open-quick-replies').onclick=()=>quickReplies(false);
  const tools=app.querySelector('.owner-tools-panel'),signOut=app.querySelector('#logout');
  const appEditor=document.createElement('button');appEditor.type='button';appEditor.textContent='Edit customer app';appEditor.id='open-app-settings';appEditor.onclick=()=>openAppSettings({api,notice});tools.prepend(appEditor);
  const access=document.createElement('button');access.type='button';access.textContent='Feature access';access.id='feature-access';access.onclick=()=>openFeatureAccess();tools.insertBefore(access,signOut);
  const soundToggle=document.createElement('button');soundToggle.id='chat-sounds';soundToggle.type='button';const drawSounds=()=>{soundToggle.textContent='Chat sounds · '+(sounds.enabled()?'On':'Off');soundToggle.setAttribute('aria-pressed',String(sounds.enabled()));};drawSounds();soundToggle.onclick=()=>{sounds.setEnabled(!sounds.enabled());drawSounds();};tools.insertBefore(soundToggle,signOut);
  const flowSettings=document.createElement('button');flowSettings.type='button';flowSettings.textContent='Replies & video flow';flowSettings.id='open-workflow';flowSettings.onclick=()=>openWorkflowSettings({api,notice,automationEnabled:config.automationEnabled===true});tools.insertBefore(flowSettings,signOut);
  const activityButton=document.createElement('button');activityButton.type='button';activityButton.textContent='Customer activity';activityButton.id='open-customer-activity';activityButton.onclick=()=>openCustomerActivity({api,notice,conversationId:selected,customerName:current?.name||'',onOpenConversation:select});tools.insertBefore(activityButton,signOut);
  app.querySelector('#logout').onclick=async()=>{try{await api('/api/admin/logout','POST',{});login();}catch(error){notice(error.message);}};
  if(typeof window.RekhaDevice?.showAlertSettings==='function'){
    app.classList.add('native-owner');
    const alerts=document.createElement('button');alerts.type='button';alerts.id='message-alerts';alerts.textContent='Message alerts';alerts.onclick=()=>{try{window.RekhaDevice.showAlertSettings();}catch{notice('Could not open message alert settings.');}};
    tools.insertBefore(alerts,signOut);
  }
  tools.addEventListener('click',event=>{if(event.target.closest('button,a'))closeOwnerTools();});
  app.querySelector('#refresh-inbox').onclick=()=>loadInbox().catch(error=>notice(error.message));app.querySelector('#inbox-retry').onclick=()=>loadInbox().catch(error=>notice(error.message));
  const more=document.createElement('button');more.id='inbox-more';more.className='inbox-more';more.type='button';more.onclick=()=>loadInbox({more:true}).catch(error=>notice(error.message));app.querySelector('#inbox-list').after(more);
  app.querySelector('#search').placeholder='Search customer name';app.querySelector('#search').setAttribute('aria-label','Search customer names starting with these letters');app.querySelector('#search').title='Search by the beginning of a customer name';
  app.querySelector('#search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>searchInbox(),300);};
  app.querySelector('#inbox-list').onclick=event=>{const button=event.target.closest('[data-id]');if(button&&app.querySelector('#inbox-list').contains(button))select(button.dataset.id);};
  app.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;app.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',x===b));searchInbox();});
  drawList();inboxPoll.start();
  app.querySelector('.topbar .brand').title=`AI: ${config.aiMode} · Payment: ${config.paymentMode}`;
}
function drawInboxPaging(){drawInboxStatus();const button=app.querySelector('#inbox-more');if(!button)return;button.hidden=!inboxPages.state().hasMore;button.disabled=inboxLoading;button.textContent=inboxLoading?'Loading customers…':'Load more customers';}
async function loadInbox({more=false,signal,kind='delta'}={}){
  if(document.hidden||navigator.onLine===false||app.dataset.view==='login'){drawInboxStatus();return;}
  if(inboxLoading)return;
  const request=inboxPages.request({more}),controller=new AbortController();inboxController=controller;inboxLoading=true;drawList();
  const before=JSON.stringify(chats),combined=createRequestAbort({signals:[signal,controller.signal]});
  try{const data=await api(request.route,'GET',undefined,{signal:combined.signal});if(controller.signal.aborted||!inboxPages.accept(data,request))return;chats=inboxPages.state().items;for(const row of chats)if(row.latestUserId&&row.latestUserId<=(readThrough.get(row.id)||0))row.unread=0;sounds.observeInbox(chats,{kind:more?'older':kind});connectionPaused=false;lastInboxSync=Date.now();drawList();return{changed:before!==JSON.stringify(chats)};}
  catch(error){if(controller.signal.aborted||signal?.aborted)return;if(error.status===401)login();else if(!connectionPaused){connectionPaused=true;notice('Connection paused. Trying again…');}throw error;}
  finally{combined.dispose();if(inboxController===controller){inboxLoading=false;inboxController=null;drawList();}}
}
async function searchInbox(){
  clearTimeout(searchTimer);inboxPoll.stop();inboxController?.abort();inboxController=null;inboxLoading=false;inboxPages.reset(app.querySelector('#search')?.value||'',filter);chats=[];inboxFingerprint='';drawList();
  try{await loadInbox({kind:'initial'});}catch{/* The list retains a retrying state. */}finally{if(app.dataset.view!=='login')inboxPoll.start();}
}
function drawList(){
  const search=app.querySelector('#search');if(!search)return;
  drawInboxPaging();const print=JSON.stringify([chats,filter,selected,inboxLoading,connectionPaused,navigator.onLine,inboxPages.state().query]);if(print===inboxFingerprint)return;inboxFingerprint=print;app.querySelector('#count').textContent=`${chats.length} loaded`;
  const list=chats.filter(c=>filter==='archived'?c.archived:!c.archived&&(filter==='blocked'?c.blocked:filter==='waiting'?c.waiting:filter==='unread'?c.unread>0:filter==='pinned'?c.pinned:true)).sort(inboxPages.state().query?(a,b)=>a.name.toLowerCase().localeCompare(b.name.toLowerCase())||String(a.id).localeCompare(String(b.id)):(a,b)=>Number(b.pinned)-Number(a.pinned)||new Date(b.updated)-new Date(a.updated)||String(b.id).localeCompare(String(a.id)));
  const active=new Set(),fragments=list.map(c=>{active.add(c.id);const key=JSON.stringify([c,selected===c.id]),cached=inboxMarkup.get(c.id);if(cached?.key===key)return{id:c.id,html:cached.html};const html=`<button class="chat-item ${selected===c.id?'selected':''} ${c.unread?'has-unread':''}" data-id="${esc(c.id)}" data-message="${esc(c.id)}"><span class="customer-avatar" aria-hidden="true">${esc(c.name.slice(0,1).toUpperCase())}</span><span class="chat-summary"><span class="row"><strong>${esc(c.name)}</strong><span class="inbox-date">${inboxDateFormatter.format(new Date(c.updated))}</span></span><span class="row"><small>${esc(latestPreview(c))}</small><span class="inbox-markers">${c.pinned?'<span title="Pinned">⌖</span>':''}${c.blocked?'<span title="Blocked">⊘</span>':''}${c.unread?`<span class="unread-count">${Number(c.unread)}</span>`:c.waiting?'<span class="waiting-dot" title="Waiting for your reply"></span>':''}</span></span>${c.labels?.length?`<span class="inbox-labels">${c.labels.map(x=>`<span>${esc(x)}</span>`).join('')}</span>`:''}</span></button>`;inboxMarkup.set(c.id,{key,html});return{id:c.id,html};});for(const id of inboxMarkup.keys())if(!active.has(id))inboxMarkup.delete(id);
  const query=inboxPages.state().query,emptyText=navigator.onLine===false?'Connect to the internet to load your customer inbox.':inboxLoading?'Loading customer chats…':connectionPaused?'Could not update the inbox. Tap Retry above.':query?`No customer names start with “${query}”.`:{waiting:'No customers are waiting for your reply.',unread:'You have read every loaded chat.',pinned:'Pin a chat from Customer settings to keep it here.',archived:'No archived customer chats.',blocked:'No blocked customer chats.'}[filter]||'New customer conversations will appear here.';
  syncThread(app.querySelector('#inbox-list'),fragments.length?fragments:[{id:'empty-inbox',html:`<div data-message="empty-inbox" class="empty inbox-empty"><p>${esc(emptyText)}</p></div>`}]);app.querySelectorAll('#inbox-list [data-id]').forEach(button=>button.setAttribute('aria-current',String(button.dataset.id===selected)));
}
async function select(id){
  if(selected===id&&current?.id===id){mobileView('chat');await markRead();return;}
  if(actionBusy)return;if(attachment&&!confirm('Remove the unsent attachment and open another conversation? Your text reply stays saved in this tab.'))return;saveOwnerDraft();
  threadPoll.stop();closeRecorder();selected=id;current=null;history.reset();attachment=null;sendAttempt=null;quoted=null;dirty=false;replyFailure='';replySending=false;fingerprint='';lastDraft='';threadSearch='';onlyStarred=false;app.querySelector('#controls')?.classList.remove('mobile-open');drawList();mobileView('chat');
  app.querySelector('#conversation').innerHTML='<div class="empty" role="status"><p>Opening this private conversation…</p></div>';app.querySelector('#controls').innerHTML='<p class="muted">Loading customer settings…</p>';
  messageMarkup.clear();
  try{const data=await api(`/api/admin/conversations/${id}`);if(selected!==id)return;acceptConversation(data,{kind:'initial'});drawConversation(true);await markRead();threadPoll.start();}catch(error){if(selected!==id)return;if(error.status===401)login();else if(error.status===404)removeDeletedChat(id);else{app.querySelector('#conversation').innerHTML='<div class="empty" role="status"><h2>Could not open this chat.</h2><p>Your unsent text is safe in this tab.</p><button type="button" id="retry-chat">Try again</button><button type="button" class="back-inbox">Back to inbox</button></div>';app.querySelector('#retry-chat').onclick=()=>select(id);app.querySelector('.back-inbox').onclick=toInbox;}notice(error.message);}
}
function removeDeletedChat(id){ownerTextDrafts.delete(id);writeOwnerDrafts();inboxPages.remove(id);chats=inboxPages.state().items;if(selected===id){selected=null;current=null;dirty=false;history.reset();mobileView('inbox');app.querySelector('#conversation').innerHTML='<div class="empty"><p>This conversation was deleted. Choose another customer.</p></div>';}inboxFingerprint='';drawList();}
function acceptConversation(data,{kind='mutation'}={}){if(data?.id!==selected||!Array.isArray(data.messages))return false;current=history.accept(current,data,{kind});sounds.observe(current,{kind});const row=chats.find(item=>item.id===current.id);if(row)for(const key of ['name','mode','version','inboxRevision','updated','pinned','archived','blocked','labels'])if(key in current)row[key]=current[key];return true;}
async function loadEarlier(){
  if(olderLoading||!history.state().hasOlder||!current)return;const id=selected;olderLoading=true;drawHistory();
  try{const data=await api(history.route(`/api/admin/conversations/${id}`,{older:true}));if(selected!==id||!current)return;const thread=app.querySelector('#thread'),anchor=captureThreadAnchor(thread);acceptConversation(data,{kind:'older'});fingerprint='';drawConversation();restoreThreadAnchor(thread,anchor);}
  catch(error){notice(error.message);}finally{olderLoading=false;drawHistory();}
}
function drawHistory(){const button=app.querySelector('#owner-load-earlier');if(!button)return;button.hidden=!history.state().hasOlder;button.disabled=olderLoading;button.textContent=olderLoading?'Loading earlier messages…':'Load earlier messages';}
function toInbox(){if(actionBusy)return;saveOwnerDraft();closeRecorder();mobileView('inbox');app.querySelector('#controls')?.classList.remove('mobile-open');app.querySelector('#customer-settings')?.setAttribute('aria-expanded','false');}
async function markRead(){
  const lastId=current?.messages?.findLast(m=>m.role==='user')?.id;if(!lastId||lastId<=(readThrough.get(current.id)||0)||document.hidden||app.dataset.view!=='chat')return;
  const id=current.id;try{await api(`/api/admin/conversations/${id}/read`,'POST',{lastId});readThrough.set(id,lastId);const row=chats.find(c=>c.id===id);if(row)row.unread=0;drawList();}catch(error){if(error.status===401)login();}
}
function renderMessage(m){
  if(m.role==='system')return `<div data-message="${m.id}" class="entry system">${esc(m.body)}</div>`;
  const own=m.role!=='user',reply=current.messages.find(x=>x.id===m.replyTo),key=JSON.stringify([m,reply,sender(m),sender(reply||m)]),cached=messageMarkup.get(m.id);if(cached?.key===key)return cached.html;
  const reactions=(m.reactions||[]).map(r=>`<button type="button" class="reaction-pill ${r.by==='owner'?'mine':''}" data-react-existing="${m.id}" data-emoji="${esc(r.emoji)}" aria-label="${esc(r.emoji)} reaction">${esc(r.emoji)}</button>`).join('');
  const html=`<article data-message="${m.id}" class="entry ${own?'owner':'user'} ${m.deleted?'deleted':''}"><div class="body">${reply?`<button class="quoted-message" data-jump="${reply.id}"><strong>${esc(sender(reply))}</strong><span>${esc(readable(reply).slice(0,140))}</span></button>`:''}${m.deleted?'<span class="deleted-text">This message was deleted</span>':messageBody(m)}<span class="bubble-meta">${m.starred?'<span title="Starred">★</span>':''}${m.edited?'<span>edited</span>':''}<time>${time(m.created)}</time>${own?`<span class="message-ticks delivered ${m.readByOther?'read':''}" aria-label="${m.readByOther?'Read by customer':"Received by customer's chat"}">${chatIcon('checks',16)}</span>`:''}</span></div>${reactions?`<div class="message-reactions">${reactions}</div>`:''}<button type="button" class="message-options" data-message-menu="${m.id}" aria-label="Message actions">⌄</button></article>`;messageMarkup.set(m.id,{key,html});return html;
}
function drawConversation(initial=false){
  queueMicrotask(()=>calls?.mount(app.querySelector('.owner-call-actions')));
  if(!current||selected!==current.id)return;
  const print=JSON.stringify([current,threadSearch,onlyStarred]);if(print===fingerprint&&!initial)return;fingerprint=print;
  const pane=app.querySelector('#conversation');
  if(initial)pane.innerHTML=`<header class="conversation-head"><button type="button" class="back-inbox" aria-label="Back to customer inbox">←</button><span class="customer-avatar" id="header-avatar"></span><div class="conversation-heading"><h2 id="customer-name"></h2><p id="customer-state"></p></div><div class="owner-call-actions"></div><button type="button" id="thread-find" aria-label="Search messages">⌕</button><button type="button" id="customer-settings" aria-label="Customer settings">⋮</button></header><div class="thread-search" hidden><input id="message-search" type="search" placeholder="Find in this conversation" aria-label="Find messages"><button id="starred-messages" aria-pressed="false">★ Starred</button><button id="close-find" aria-label="Close search">✕</button></div><div class="thread" id="thread"></div><div class="customer-typing" id="customer-typing" hidden>Customer is typing…</div><form class="reply-box" id="reply-form"><div class="quote-composer" id="quote-composer" hidden></div><div class="attachment-row" id="attachment-row" hidden><span id="attached-label"></span><button type="button" id="remove-attachment">✕</button></div><div class="recording-row" hidden><span class="recording-dot"></span><span id="recording-time">0:00</span><span>Recording voice message</span><button type="button" id="cancel-recording">Cancel</button><button type="button" id="finish-recording">Use recording</button></div><div class="composer-main"><button type="button" id="emoji-picker" aria-label="Add emoji">☺</button><button type="button" id="attach-menu" aria-label="Attach file or collection">＋</button><textarea id="reply" maxlength="4000" rows="1" placeholder="Message as Rekha" aria-label="Message as Rekha"></textarea><button type="button" id="voice-record" aria-label="Record voice message">🎙</button><button class="primary" id="send-reply" aria-label="Send message">➤</button></div><div class="composer-tools"><button type="button" id="insert-quick-reply">⚡ Quick replies</button><span id="draft-label"></span><label class="answer-toggle"><input type="checkbox" id="answer-pending" checked> Answer waiting messages</label></div><p id="reply-hint" class="reply-hint"></p><p class="error" id="reply-error" role="alert"></p><input id="owner-file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,audio/*,application/pdf" hidden></form>`;
  if(initial){const older=document.createElement('button');older.id='owner-load-earlier';older.type='button';older.className='history-more';older.onclick=loadEarlier;pane.querySelector('#thread').before(older);const field=pane.querySelector('#message-search');field.placeholder='Find in loaded messages';field.setAttribute('aria-label','Find in loaded messages. Load earlier for older results.');const saved=document.createElement('p');saved.id='local-draft-status';saved.className='draft-status';saved.setAttribute('role','status');saved.setAttribute('aria-live','polite');pane.querySelector('#reply-hint').after(saved);const retry=document.createElement('button');retry.id='retry-reply';retry.type='button';retry.className='reply-retry';retry.textContent='Retry sending';retry.hidden=true;retry.onclick=()=>pane.querySelector('#reply-form').requestSubmit();pane.querySelector('#reply-error').after(retry);pane.querySelector('#customer-settings').setAttribute('aria-controls','controls');}drawHistory();
  app.querySelector('#customer-name').textContent=current.name;app.querySelector('#header-avatar').textContent=current.name.slice(0,1).toUpperCase();
  app.querySelector('#customer-state').textContent=current.typing?.customer?'typing…':config.automationEnabled!==true?'Personal reply · automatic flows stopped':`${current.mode==='ai'?'Auto reply':current.mode==='assist'?'Draft approval':'Personal reply'}${current.blocked?' · Customer blocked':''}`;
  const thread=app.querySelector('#thread'),bottom=thread.scrollHeight-thread.scrollTop-thread.clientHeight<110;
  const messages=current.messages.filter(m=>(!onlyStarred||m.starred)&&(!threadSearch||readable(m).toLowerCase().includes(threadSearch.toLowerCase())));
  let previousDate='';const threadHtml=[];for(const m of messages){const date=new Date(m.created),day=`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;if(day!==previousDate)threadHtml.push({id:'date-'+m.id,html:`<div data-message="date-${m.id}" class="day-divider">${esc(dayFormatter.format(date))}</div>`});previousDate=day;threadHtml.push({id:m.id,html:renderMessage(m)});}const activeIds=new Set(current.messages.map(m=>m.id));for(const id of messageMarkup.keys())if(!activeIds.has(id))messageMarkup.delete(id);
  syncThread(thread,threadHtml.length?threadHtml:[{id:'empty-search',html:'<div data-message="empty-search" class="empty"><p>No messages found.</p></div>'}]);
  if(initial||bottom)thread.scrollTop=thread.scrollHeight;
  const pending=current.messages.findLast(m=>m.role==='user'&&['pending','failed'].includes(m.status));const reply=app.querySelector('#reply');
  if(initial&&ownerTextDrafts.has(current.id)){reply.value=ownerTextDrafts.get(current.id).body;dirty=true;}
  if(!dirty&&current.draft&&lastDraft!==current.draft.body){reply.value=current.draft.body;lastDraft=current.draft.body;}
  if(!pending&&!dirty){reply.value='';lastDraft='';}if(current.mode==='ai'&&!dirty){reply.value='';lastDraft='';}
  app.querySelectorAll('.composer-main button,.composer-main textarea,#insert-quick-reply,#answer-pending,#remove-attachment').forEach(control=>control.disabled=actionBusy);app.querySelector('#send-reply').setAttribute('aria-label',replySending?'Sending message':'Send message');app.querySelector('#voice-record').disabled=actionBusy||startRecording.pending||recorder?.state==='recording';
  app.querySelector('#draft-label').textContent=current.draft&&!dirty?'AI draft · review before sending':'';app.querySelector('#reply-error').textContent=replyFailure;app.querySelector('#retry-reply').hidden=!replyFailure;app.querySelector('#retry-reply').disabled=actionBusy;drawDraftStatus();
  app.querySelector('#reply-hint').textContent=current.mode==='ai'?'Sending changes this chat to personal reply.':'You can send follow-ups anytime.';
  app.querySelector('.answer-toggle').hidden=!pending;
  app.querySelector('#customer-typing').hidden=!current.typing?.customer;
  app.querySelector('#attachment-row').hidden=!attachment;app.querySelector('#attached-label').textContent=attachment?.label||'';
  const quote=app.querySelector('#quote-composer');quote.hidden=!quoted;quote.innerHTML=quoted?`<div><strong>Reply to ${esc(sender(quoted))}</strong><span>${esc(readable(quoted).slice(0,160))}</span></div><button type="button" id="clear-quote" aria-label="Cancel reply">✕</button>`:'';
  app.querySelector('#clear-quote')?.addEventListener('click',()=>{quoted=null;sendAttempt=null;fingerprint='';drawConversation();});
  app.querySelector('#remove-attachment').onclick=()=>{attachment=null;sendAttempt=null;dirty=true;fingerprint='';drawConversation();};
  app.querySelector('.back-inbox').onclick=toInbox;
  app.querySelector('#customer-settings').setAttribute('aria-expanded',String(app.querySelector('#controls').classList.contains('mobile-open')));
  app.querySelector('#customer-settings').onclick=()=>{const controls=app.querySelector('#controls'),open=controls.classList.toggle('mobile-open');app.querySelector('#customer-settings').setAttribute('aria-expanded',String(open));if(open)controls.querySelector('#close-settings')?.focus();};
  app.querySelector('#thread-find').onclick=()=>{app.querySelector('.thread-search').hidden=false;app.querySelector('#message-search').focus();};
  app.querySelector('#close-find').onclick=()=>{threadSearch='';onlyStarred=false;app.querySelector('#message-search').value='';app.querySelector('.thread-search').hidden=true;fingerprint='';drawConversation();};
  app.querySelector('#message-search').oninput=e=>{threadSearch=e.target.value;fingerprint='';drawConversation();};
  app.querySelector('#starred-messages').setAttribute('aria-pressed',onlyStarred);app.querySelector('#starred-messages').onclick=()=>{onlyStarred=!onlyStarred;fingerprint='';drawConversation();};
  app.querySelector('#insert-quick-reply').onclick=()=>quickReplies(true);
  app.querySelector('#attach-menu').onclick=attachmentMenu;
  app.querySelector('#owner-file').onchange=async e=>{const file=e.target.files?.[0];e.target.value='';if(file)await uploadAttachment(file);};
  app.querySelector('#emoji-picker').onclick=emojiPicker;
  app.querySelector('#voice-record').onclick=startRecording;app.querySelector('#cancel-recording').onclick=()=>closeRecorder(true);app.querySelector('#finish-recording').onclick=()=>closeRecorder(false);
  app.querySelector('#answer-pending').onchange=()=>{sendAttempt=null;replyFailure='';app.querySelector('#reply-error').textContent='';app.querySelector('#retry-reply').hidden=true;drawDraftStatus();};
  reply.oninput=()=>{dirty=true;sendAttempt=null;replyFailure='';saveOwnerDraft();app.querySelector('#reply-error').textContent='';app.querySelector('#retry-reply').hidden=true;growReply();const now=Date.now();if(now-typingAt>3500){typingAt=now;api(`/api/admin/conversations/${current.id}/typing`,'POST',{active:true}).catch(()=>{});}};
  reply.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();app.querySelector('#reply-form').requestSubmit();}};
  growReply();
  app.querySelectorAll('[data-message-menu]').forEach(b=>b.onclick=()=>messageMenu(Number(b.dataset.messageMenu)));
  app.querySelectorAll('[data-jump]').forEach(b=>b.onclick=()=>jumpMessage(Number(b.dataset.jump)));
  app.querySelectorAll('[data-react-existing]').forEach(b=>b.onclick=()=>react(Number(b.dataset.reactExisting),b.classList.contains('mine')?'':b.dataset.emoji));
  app.querySelector('#reply-form').onsubmit=async event=>{
    event.preventDefault();if(actionBusy||(!reply.value.trim()&&!attachment))return;
    if(navigator.onLine===false){dirty=true;replyFailure='You are offline. Connect to the internet, then retry.';saveOwnerDraft();fingerprint='';drawConversation();return;}
    const id=current.id,body=reply.value,content={body,replyTo:quoted?.id||null,...(attachment?.collectionId?{collectionId:attachment.collectionId}:attachment?{itemIds:[...(attachment.itemIds||[])]}:{})};
    // A lost acknowledgement must retry the original action even if a poll updates waiting status.
    const signature=JSON.stringify(content);if(!sendAttempt||sendAttempt.signature!==signature)sendAttempt={signature,clientId:crypto.randomUUID(),payload:{...content,version:current.version,answersPending:!!pending&&app.querySelector('#answer-pending').checked}};const {clientId,payload}=sendAttempt;
    saveOwnerDraft(id,body);dirty=true;actionBusy=true;replySending=true;replyFailure='';fingerprint='';drawConversation();
    try{const data=await api(`/api/admin/conversations/${id}/send`,'POST',{...payload,clientId});if(!soundedSends.has(clientId)){soundedSends.add(clientId);if(soundedSends.size>512)soundedSends.delete(soundedSends.values().next().value);sounds.play('sent');}ownerTextDrafts.delete(id);writeOwnerDrafts();attachment=null;sendAttempt=null;quoted=null;if(selected===id){acceptConversation(data);dirty=false;reply.value='';lastDraft='';}threadPoll.poke({immediate:true});inboxPoll.poke({immediate:true});api(`/api/admin/conversations/${id}/typing`,'POST',{active:false}).catch(()=>{});}
    catch(error){if(error.status===401){login();return;}if(selected===id){dirty=true;replyFailure=error.message||'Could not send your reply. Please retry.';saveOwnerDraft(id,body);if(error.status===409){try{await refreshSelected();}catch{}sendAttempt=null;replyFailure='This chat changed while you were replying. Your text is saved; review it and retry.';}}}
    finally{actionBusy=false;replySending=false;fingerprint='';drawConversation();}
  };
  if(initial)app.querySelector('#controls').dataset.formEditing='false';
  drawControls(pending);
}
function growReply(){const el=app.querySelector('#reply');if(!el)return;el.style.height='auto';el.style.height=`${Math.min(el.scrollHeight,140)}px`;}
function drawControls(pending){
  const controls=app.querySelector('#controls');
  if(controls.dataset.formEditing==='true')return;
  const previousScroll=controls.scrollTop;
  controls.innerHTML=`<div class="controls-head"><h3>Customer settings</h3><button id="close-settings" aria-label="Close customer settings">✕</button></div><section class="customer-actions"><button data-setting="pinned" aria-pressed="${!!current.pinned}">${current.pinned?'Unpin':'Pin'} chat</button><button data-setting="archived">${current.archived?'Unarchive':'Archive'}</button><button data-setting="blocked" class="${current.blocked?'danger-active':''}">${current.blocked?'Unblock customer':'Block customer'}</button></section><section class="customer-notes"><h3>Private notes & labels</h3><form id="customer-details-form"><label>Labels<input id="customer-labels" maxlength="300" value="${esc((current.labels||[]).join(', '))}" placeholder="Paid, Follow up, New"></label><label>Notes<textarea id="customer-notes" maxlength="4000" rows="3" placeholder="Visible only to you">${esc(current.notes||'')}</textarea></label><button class="primary">Save details</button><span id="details-status" role="status"></span></form></section><h3>Reply mode</h3>${config.automationEnabled!==true?'<p class="control-note">Only the kundli image sends at signup. Previous automatic replies and video flows are stopped. You can reply and share media yourself.</p>':''}${[['ai','AI auto-reply','Automatic replies for this customer.'],['assist','AI assisted','Review or edit a draft, then send.'],['manual','Personal reply','Reply yourself whenever you like.']].map(([key,name,description])=>`<button class="mode ${current.mode===key?'active':''}" data-mode="${key}" aria-pressed="${current.mode===key}" ${actionBusy||config.automationEnabled!==true&&key!=='manual'?'disabled':''}><strong>${name}</strong><span>${description}</span></button>`).join('')}<p class="control-note">These settings are private. Your customer sees Rekha.</p>${config.automationEnabled===true&&pending?.status==='failed'?'<button id="retry-ai">Retry failed draft / reply</button>':''}<section class="profile"><h3>Customer details</h3><dl><dt>Date of birth</dt><dd>${esc(current.dob)}</dd><dt>Language</dt><dd>${esc(current.language)}</dd><dt>Conversation</dt><dd>${current.entitlement==='demo'?'Preview unlock · not paid':current.entitlement==='paid'?'₹49 paid':'Free'}</dd><dt>Free replies used</dt><dd>${current.freeUsed}</dd><dt>Location</dt><dd>${current.preferences?.location?esc(`${current.preferences.location.latitude}, ${current.preferences.location.longitude}`):'Not shared'}</dd><dt>Kundli</dt><dd>Not calculated in this preview.</dd></dl></section>`;
  controls.querySelector('#close-settings').onclick=()=>{controls.classList.remove('mobile-open');app.querySelector('#customer-settings')?.setAttribute('aria-expanded','false');app.querySelector('#customer-settings')?.focus();};
  const flowButton=document.createElement('button');flowButton.className='flow-tools-button';flowButton.textContent='Customer video & reply flow →';flowButton.type='button';flowButton.onclick=()=>openChatWorkflow({api,notice,conversationId:current.id,customerName:current.name,automationEnabled:config.automationEnabled===true});controls.querySelector('.customer-actions').after(flowButton);
  const activityShortcut=document.createElement('button');activityShortcut.type='button';activityShortcut.className='activity-tools-button';activityShortcut.textContent='This customer’s activity →';activityShortcut.onclick=()=>openCustomerActivity({api,notice,conversationId:current.id,customerName:current.name,currentCustomerOnly:true,onOpenConversation:select});flowButton.after(activityShortcut);
  controls.querySelectorAll('[data-setting]').forEach(b=>b.onclick=async()=>{const key=b.dataset.setting;if(key==='blocked'&&!current.blocked&&!confirm('Block this customer from sending new messages? You can unblock them later.'))return;try{const result=await api(`/api/admin/conversations/${current.id}/settings`,'PATCH',{[key]:!current[key]});if(!acceptConversation(result))return;fingerprint='';drawConversation();drawList();inboxPoll.poke({immediate:true});notice('Customer settings saved.');}catch(error){notice(error.message);}});
  controls.querySelector('#customer-details-form').onsubmit=async e=>{e.preventDefault();const labels=controls.querySelector('#customer-labels').value.split(',').map(x=>x.trim()).filter(Boolean);if(labels.some(x=>x.length>30)||labels.length>8)return notice('Use up to 8 labels, with 30 characters each.');try{const result=await api(`/api/admin/conversations/${current.id}/settings`,'PATCH',{labels,notes:controls.querySelector('#customer-notes').value});if(!acceptConversation(result))return;controls.dataset.formEditing='false';if(controls.querySelector('#details-status'))controls.querySelector('#details-status').textContent=' Saved';drawList();}catch(error){notice(error.message);}};
  controls.dataset.formEditing='false';controls.querySelector('#customer-details-form').addEventListener('input',()=>controls.dataset.formEditing='true');
  controls.querySelectorAll('[data-mode]').forEach(button=>button.onclick=async()=>{
    if(actionBusy||button.dataset.mode===current.mode)return;saveOwnerDraft();actionBusy=true;
    try{acceptConversation(await api(`/api/admin/conversations/${current.id}/mode`,'PATCH',{mode:button.dataset.mode}));lastDraft='';notice('Reply mode updated.');}catch(error){notice(error.message);}finally{actionBusy=false;fingerprint='';drawConversation();}
  });
  controls.querySelector('#retry-ai')?.addEventListener('click',async()=>{try{acceptConversation(await api(`/api/admin/conversations/${current.id}/retry`,'POST',{}));fingerprint='';drawConversation();threadPoll.poke({immediate:true});}catch(error){notice(error.message);}});
  controls.scrollTop=previousScroll;
}
function dialog(title,content,className='owner-dialog'){
  const d=document.createElement('dialog');d.className=className;d.innerHTML=`<header><h2>${esc(title)}</h2><button type="button" data-close aria-label="Close">✕</button></header>${content}`;document.body.append(d);d.querySelector('[data-close]').onclick=()=>d.close();d.addEventListener('close',()=>d.remove());d.showModal();return d;
}
function attachmentMenu(){const d=dialog('Attach to this chat','<div class="attachment-options"><button id="choose-file">File, photo or video</button><button id="choose-library">Media library & collections</button></div><p class="muted">Images and videos up to 25 MB. Voice messages and PDF files up to 20 MB.</p>');d.querySelector('#choose-file').onclick=()=>{d.close();app.querySelector('#owner-file').click();};d.querySelector('#choose-library').onclick=()=>{d.close();openLibrary({api,notice,onAttach:value=>{attachment=value;sendAttempt=null;dirty=true;fingerprint='';drawConversation();}});};}
async function uploadAttachment(file){
  const id=selected;if(!id||actionBusy)return;const limit=file.type.startsWith('audio/')||file.type==='application/pdf'?20:25;
  if(file.size>limit*1024*1024)return notice(`Choose a file up to ${limit} MB.`);if(!file.size)return notice('This file is empty.');
  actionBusy=true;fingerprint='';drawConversation();notice('Uploading attachment…');
  const request=createRequestAbort({timeoutMs:180000});
  try{const response=await fetch(`/api/admin/uploads?title=${encodeURIComponent(file.name||'Voice message')}&category=general`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type||'application/octet-stream'},body:file,signal:request.signal});const result=await response.json();if(!response.ok)throw Error(result.error);if(selected===id){attachment={itemIds:[result.id],label:result.title||file.name};sendAttempt=null;dirty=true;}notice('Attachment ready. Press Send to share it.');}catch(error){notice(error.message);}finally{request.dispose();actionBusy=false;fingerprint='';drawConversation();}
}
async function startRecording(){
  if(actionBusy||startRecording.pending||recorder?.state==='recording')return;if(!window.MediaRecorder||!navigator.mediaDevices?.getUserMedia)return notice('Voice recording is unavailable in this browser. You can attach an audio file.');
  const chatId=selected,controller=new AbortController();recordingRequest=controller;
  startRecording.pending=true;
  app.querySelector('#voice-record').disabled=true;
  try{
    const stream=await getFeatureMedia('microphone',{audio:true},{signal:controller.signal});
    if(controller.signal.aborted||selected!==chatId||app.dataset.view!=='chat'||document.hidden){stream.getTracks().forEach(track=>track.stop());return;}
    recordingStream=stream;
    const currentRecorder=createVoiceRecorder(stream),session={recorder:currentRecorder,stream,chunks:[],cancelled:false,started:Date.now(),timer:null,finished:false};
    recorder=currentRecorder;recordingSession=session;
    const cleanup=()=>{
      stream.getTracks().forEach(track=>track.stop());clearInterval(session.timer);
      if(recordingSession===session){recordingSession=null;recorder=null;recordingStream=null;recordingTimer=null;const row=app.querySelector('.recording-row');if(row)row.hidden=true;const button=app.querySelector('#voice-record');if(button)button.disabled=actionBusy||startRecording.pending;}
    };
    currentRecorder.ondataavailable=event=>{if(event.data?.size)session.chunks.push(event.data);};
    currentRecorder.onstop=async()=>{
      if(session.finished)return;session.finished=true;cleanup();
      if(session.cancelled||selected!==chatId||app.dataset.view!=='chat')return;
      try{const file=voiceRecordingFile(session.chunks,currentRecorder.mimeType);await uploadAttachment(file);}catch(error){notice(error.message||'Could not save this voice recording.');}
    };
    currentRecorder.onerror=event=>{if(session.finished)return;session.finished=true;session.cancelled=true;cleanup();if(currentRecorder.state!=='inactive'){try{currentRecorder.stop();}catch{}}if(selected===chatId)notice(event.error?.message||'Voice recording stopped. Please try again.');};
    currentRecorder.start(1000);app.querySelector('.recording-row').hidden=false;app.querySelector('#recording-time').textContent='0:00';
    recordingTimer=session.timer=setInterval(()=>{if(recordingSession!==session)return;const seconds=Math.floor((Date.now()-session.started)/1000),label=app.querySelector('#recording-time');if(label)label.textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;if(seconds>=180)closeRecorder(false);},1000);
  }catch(error){closeRecorder();if(error.name!=='AbortError')notice(error.message||'Could not start voice recording.');}
  finally{if(recordingRequest===controller)recordingRequest=null;startRecording.pending=false;const button=app.querySelector('#voice-record');if(button)button.disabled=actionBusy||recorder?.state==='recording';}
}
function emojiPicker(){const d=dialog('Add emoji',`<div class="emoji-grid">${['😊','🙏','❤️','👍','✨','🌸','☀️','🌙','🎉','💫','🌟','🤗','✅','🙂','💐','🕉️'].map(x=>`<button data-emoji="${x}" aria-label="${x}">${x}</button>`).join('')}</div>`);d.querySelectorAll('[data-emoji]').forEach(b=>b.onclick=()=>{const reply=app.querySelector('#reply'),start=reply.selectionStart,end=reply.selectionEnd;reply.value=reply.value.slice(0,start)+b.dataset.emoji+reply.value.slice(end);dirty=true;sendAttempt=null;replyFailure='';saveOwnerDraft();app.querySelector('#reply-error').textContent='';app.querySelector('#retry-reply').hidden=true;d.close();reply.focus();growReply();});}
function jumpMessage(id){const el=app.querySelector(`[data-message="${id}"]`);if(!el)return notice('Clear the message search to see this reply.');el.scrollIntoView({block:'center',behavior:'smooth'});el.classList.add('highlight');setTimeout(()=>el.classList.remove('highlight'),1800);}
async function refreshSelected(){const id=selected;if(!id)return;const kind=history.state().revision===null?'initial':'delta',data=await api(history.route(`/api/admin/conversations/${id}`));if(selected===id){acceptConversation(data,{kind});fingerprint='';drawConversation();if(data.hasMoreChanges)threadPoll.poke({immediate:true});}}
async function react(id,emoji){try{await api(`/api/admin/conversations/${current.id}/messages/${id}/reaction`,'PUT',{emoji});await refreshSelected();}catch(error){notice(error.message);}}
function messageMenu(id){
  const m=current.messages.find(x=>x.id===id);if(!m)return;const own=m.role!=='user'&&m.kind!=='welcome',text=!m.deleted&&m.kind!=='media',age=Date.now()-new Date(m.created).getTime();
  const d=dialog('Message',`<p class="message-menu-preview">${esc(readable(m).slice(0,200))}</p>${m.deleted?'':`<div class="reaction-choices">${['👍','❤️','😂','😮','😢','🙏'].map(x=>`<button data-reaction="${x}" aria-label="React ${x}">${x}</button>`).join('')}</div>`}<div class="message-menu-list">${!m.deleted?'<button id="quote-message">Reply to this message</button><button id="copy-message">Copy text</button>':''}<button id="star-message">${m.starred?'Unstar':'Star'} message</button>${own&&text&&age<=15*60*1000?'<button id="edit-message">Edit message</button>':''}${own&&!m.deleted&&age<=24*60*60*1000?'<button id="delete-message" class="danger">Delete for everyone</button>':''}</div>`);
  if(own){const receipt=document.createElement('p');receipt.className='receipt-detail';receipt.textContent=m.readByOther?'Read by customer':"Received by customer's chat";d.querySelector('.message-menu-preview').after(receipt);}
  d.querySelectorAll('[data-reaction]').forEach(b=>b.onclick=()=>{d.close();react(id,(m.reactions||[]).some(r=>r.by==='owner'&&r.emoji===b.dataset.reaction)?'':b.dataset.reaction);});
  d.querySelector('#quote-message')?.addEventListener('click',()=>{quoted=m;dirty=true;sendAttempt=null;fingerprint='';drawConversation();d.close();app.querySelector('#reply').focus();});
  d.querySelector('#copy-message')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(readable(m));d.close();notice('Copied.');}catch{notice('Copy is unavailable in this browser.');}});
  d.querySelector('#star-message').onclick=async()=>{try{await api(`/api/admin/conversations/${current.id}/messages/${id}/star`,'PUT',{starred:!m.starred});d.close();await refreshSelected();}catch(error){notice(error.message);}};
  d.querySelector('#edit-message')?.addEventListener('click',()=>{d.close();editMessage(m);});
  d.querySelector('#delete-message')?.addEventListener('click',async()=>{if(!confirm('Delete this message for you and the customer?'))return;try{await api(`/api/admin/conversations/${current.id}/messages/${id}`,'DELETE');d.close();await refreshSelected();}catch(error){notice(error.message);}});
}
function editMessage(m){const d=dialog('Edit message',`<form id="edit-message-form"><textarea maxlength="4000" rows="5" aria-label="Edit message" required>${esc(m.body)}</textarea><button class="primary">Save changes</button><p class="error" role="alert"></p></form>`);d.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await api(`/api/admin/conversations/${current.id}/messages/${m.id}`,'PATCH',{body:d.querySelector('textarea').value});d.close();await refreshSelected();}catch(error){d.querySelector('.error').textContent=error.message;}};}
async function quickReplies(insert){
  try{let items=await api('/api/admin/quick-replies');const d=dialog(insert?'Quick replies':'Manage quick replies','');let editing=null;
    function draw(){d.innerHTML=`<header><h2>${insert?'Quick replies':'Manage quick replies'}</h2><button type="button" data-close aria-label="Close">✕</button></header><div class="quick-reply-list">${items.map(x=>`<article><strong>${esc(x.title)}</strong><p>${esc(x.body)}</p><div>${insert?`<button data-use="${esc(x.id)}">Use reply</button>`:''}<button data-edit="${esc(x.id)}">Edit</button><button data-delete="${esc(x.id)}">Delete</button></div></article>`).join('')||'<p class="muted">Save messages you use often. Insert them into a chat, review, then send.</p>'}</div><form id="quick-reply-form"><h3>${editing?'Edit saved reply':'Save a quick reply'}</h3><label>Short title<input name="title" maxlength="80" required value="${esc(editing?.title||'')}" placeholder="Greeting or booking details"></label><label>Message<textarea name="body" maxlength="4000" rows="4" required>${esc(editing?.body||'')}</textarea></label><button class="primary">${editing?'Save changes':'Save quick reply'}</button>${editing?'<button type="button" id="cancel-quick-edit">Cancel edit</button>':''}<p class="error" role="alert"></p></form>`;
      d.querySelector('[data-close]').onclick=()=>d.close();d.querySelectorAll('[data-use]').forEach(b=>b.onclick=()=>{const x=items.find(x=>String(x.id)===b.dataset.use),reply=app.querySelector('#reply');reply.value=reply.value?`${reply.value}\n${x.body}`:x.body;dirty=true;sendAttempt=null;replyFailure='';saveOwnerDraft();app.querySelector('#reply-error').textContent='';app.querySelector('#retry-reply').hidden=true;d.close();growReply();reply.focus();});
      d.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{editing=items.find(x=>String(x.id)===b.dataset.edit);draw();d.querySelector('#quick-reply-form').scrollIntoView({block:'nearest'});});
      d.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this saved quick reply?'))return;try{await api(`/api/admin/quick-replies/${b.dataset.delete}`,'DELETE');items=await api('/api/admin/quick-replies');editing=null;draw();}catch(error){notice(error.message);}});
      d.querySelector('#cancel-quick-edit')?.addEventListener('click',()=>{editing=null;draw();});
      d.querySelector('#quick-reply-form').onsubmit=async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));try{await api(editing?`/api/admin/quick-replies/${editing.id}`:'/api/admin/quick-replies',editing?'PATCH':'POST',values);items=await api('/api/admin/quick-replies');editing=null;draw();notice('Quick reply saved.');}catch(error){d.querySelector('.error').textContent=error.message;}};
    }draw();
  }catch(error){notice(error.message);}
}
async function poll({signal}={}){
  if(loading||document.hidden||navigator.onLine===false||actionBusy||!current||app.dataset.view!=='chat')return;loading=true;
  try{const id=selected,previous=JSON.stringify([current.version,current.updated,current.typing,history.state().revision]),kind=history.state().revision===null?'initial':'delta',data=await api(history.route(`/api/admin/conversations/${id}`),'GET',undefined,{signal});if(actionBusy||signal?.aborted||id!==selected)return;acceptConversation(data,{kind});poll.paused=false;drawConversation();await markRead();return{changed:previous!==JSON.stringify([current.version,current.updated,current.typing,history.state().revision]),again:!!data.hasMoreChanges};}
  catch(error){if(signal?.aborted)return;if(error.status===401)login();else if(error.status===404){removeDeletedChat(selected);notice('This conversation was deleted.');}else if(!poll.paused){poll.paused=true;notice('Connection paused. Trying again…');}throw error;}
  finally{loading=false;}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){saveOwnerDraft();closeRecorder();if(selected&&navigator.onLine!==false)api(`/api/admin/conversations/${selected}/typing`,'POST',{active:false}).catch(()=>{});}});
document.addEventListener('click',event=>{const menu=app.querySelector('.owner-tools-menu');if(menu?.open&&!menu.contains(event.target))closeOwnerTools();});
document.addEventListener('keydown',event=>{if(event.key!=='Escape'||document.querySelector('dialog[open]'))return;const menu=app.querySelector('.owner-tools-menu'),controls=app.querySelector('#controls');if(menu?.open){closeOwnerTools();menu.querySelector('summary')?.focus();event.preventDefault();}else if(controls?.classList.contains('mobile-open')){controls.querySelector('#close-settings')?.click();event.preventDefault();}});
window.addEventListener('offline',()=>{inboxFingerprint='';drawList();});
window.addEventListener('online',()=>{drawInboxStatus();inboxPoll.poke({immediate:true});threadPoll.poke({immediate:true});});
workspace().catch(error=>{if(error.status===401)login();else{login({clearDrafts:false});notice(error.message);}});
