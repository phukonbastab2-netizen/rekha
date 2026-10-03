import { messageBody, syncThread } from './media.js';
import { openLibrary } from './library.js';
import { installCalls } from './calls.js';
import { openWorkflowSettings,openChatWorkflow } from './workflow-admin.js';

const app = document.querySelector('#admin-app');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let selected=null, chats=[], current=null, timer, dirty=false, fingerprint='', lastDraft='', loading=false, actionBusy=false;
let attachment=null, sendAttempt=null, quoted=null, filter='all', config={}, threadSearch='', onlyStarred=false, typingAt=0;
let recorder=null, recordingStream=null, recordingTimer=null, recordingChunks=[], recordingStarted=0, recordingCancelled=false;
let calls;
const readThrough=new Map();
async function api(route, method='GET', body) {
  const response=await fetch(route,{method,credentials:'same-origin',cache:'no-store',headers:method!=='GET'?{'Content-Type':'application/json'}:{},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(40000)});
  const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'Please try again.'),{status:response.status});return data;
}
function notice(text) { const n=document.querySelector('#notice');n.textContent=text;n.hidden=false;clearTimeout(notice.timer);notice.timer=setTimeout(()=>n.hidden=true,5000); }
function mobileView(view){app.dataset.view=view;}
function sender(m){return m.role==='user'?current?.name||'Customer':'Rekha';}
function readable(m){if(m.deleted)return 'This message was deleted';if(m.kind==='media'){try{const d=JSON.parse(m.body);return [d.text,d.title,...(d.items||[]).map(i=>i.title)].filter(Boolean).join(' · ')||'Attachment';}catch{return 'Attachment';}}return m.body||'';}
function time(value){return new Date(value).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});}
function latestPreview(c){return c.preview||c.lastMessage||c.last_message||`${c.language} · ${c.mode==='ai'?'Automatic':c.mode==='assist'?'Drafts':'Personal'}`;}
function closeRecorder(cancel=true){recordingCancelled=cancel;if(recorder&&recorder.state!=='inactive')recorder.stop();recordingStream?.getTracks().forEach(t=>t.stop());recordingStream=null;clearInterval(recordingTimer);recordingTimer=null;}
function login() {
  calls?.destroy();calls=null;
  clearInterval(timer);closeRecorder();readThrough.clear();selected=null;current=null;mobileView('login');
  app.innerHTML=`<main class="login"><section class="login-card"><div class="brand"><img src="/icon-192.png" alt="">Rekha Astrology</div><h1>Your customer inbox.</h1><p class="muted">Read conversations, send messages and manage replies from your private admin app.</p><form id="login-form"><label>Owner password<input id="password" type="password" autocomplete="current-password" required minlength="16"></label><p id="login-error" class="error" role="alert"></p><button class="primary">Sign in securely →</button></form><a class="install-owner" href="/astrorani/RekhaAdmin.apk" download>Download private admin app ↓</a><p class="muted">Only the owner can access this panel.</p></section></main>`;
  app.querySelector('#login-form').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{await api('/api/admin/login','POST',{password:app.querySelector('#password').value});await workspace();}catch(error){app.querySelector('#login-error').textContent=error.message;}finally{button.disabled=false;}};
}
async function workspace() {
  chats=await api('/api/admin/conversations');
  if(!calls)calls=installCalls({role:'admin',getConversationId:()=>selected,notify:notice});
  calls.poll();
  app.innerHTML=`<header class="topbar"><div class="brand"><img src="/icon-192.png" alt="">Rekha <span class="private">PRIVATE ADMIN</span></div><div class="links"><a class="install-owner" href="/astrorani/RekhaAdmin.apk" download>Admin app ↓</a><button id="open-library">Media library</button><button id="open-quick-replies">Quick replies</button><button id="logout">Sign out</button></div></header><main class="workspace"><aside class="inbox"><div class="inbox-head"><h2>Chats <span id="count" class="badge"></span></h2><input class="search" id="search" placeholder="Search customers or labels" aria-label="Search conversations"><nav class="inbox-filters" aria-label="Filter customers">${[['all','All'],['waiting','Waiting'],['unread','Unread'],['pinned','Pinned'],['archived','Archived'],['blocked','Blocked']].map(([key,label])=>`<button data-filter="${key}" aria-pressed="${filter===key}">${label}</button>`).join('')}</nav></div><div id="inbox-list"></div></aside><section class="conversation" id="conversation"><div class="empty"><div class="empty-icon">✧</div><h2>Your conversations.</h2><p>Choose a customer to read messages and reply. You can send messages anytime.</p></div></section><aside class="controls" id="controls"><h3>Customer & reply settings</h3><p class="muted">Open a chat to manage reply mode, notes and customer details.</p></aside></main>`;
  mobileView(selected?'chat':'inbox');
  app.querySelector('#open-library').onclick=()=>openLibrary({api,notice});
  app.querySelector('#open-quick-replies').onclick=()=>quickReplies(false);
  const flowSettings=document.createElement('button');flowSettings.textContent='Replies & video flow';flowSettings.id='open-workflow';flowSettings.onclick=()=>openWorkflowSettings({api,notice});app.querySelector('.topbar .links').insertBefore(flowSettings,app.querySelector('#logout'));
  app.querySelector('#logout').onclick=async()=>{try{await api('/api/admin/logout','POST',{});login();}catch(error){notice(error.message);}};
  if(typeof window.RekhaDevice?.showAlertSettings==='function'){
    app.classList.add('native-owner');
    const alerts=document.createElement('button');alerts.id='message-alerts';alerts.textContent='Message alerts';alerts.onclick=()=>{try{window.RekhaDevice.showAlertSettings();}catch{notice('Could not open message alert settings.');}};
    app.querySelector('.topbar .links').insertBefore(alerts,app.querySelector('#logout'));
  }
  app.querySelector('#search').oninput=drawList;
  app.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;app.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',x===b));drawList();});
  drawList();clearInterval(timer);timer=setInterval(poll,2200);
  config=await api('/api/config');
  app.querySelector('.topbar .brand').title=`AI: ${config.aiMode} · Payment: ${config.paymentMode}`;
}
function drawList(){
  const search=app.querySelector('#search');if(!search)return;
  const query=search.value.trim().toLowerCase();app.querySelector('#count').textContent=chats.length;
  const list=chats.filter(c=>{const matches=[c.name,...(c.labels||[])].join(' ').toLowerCase().includes(query);if(!matches)return false;if(filter==='archived')return c.archived;if(filter==='blocked')return c.blocked;if(c.archived)return false;if(filter==='waiting')return c.waiting;if(filter==='unread')return c.unread>0;if(filter==='pinned')return c.pinned;return true;}).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||new Date(b.updated)-new Date(a.updated));
  app.querySelector('#inbox-list').innerHTML=list.map(c=>`<button class="chat-item ${selected===c.id?'selected':''} ${c.unread?'has-unread':''}" data-id="${esc(c.id)}"><span class="customer-avatar" aria-hidden="true">${esc(c.name.slice(0,1).toUpperCase())}</span><span class="chat-summary"><span class="row"><strong>${esc(c.name)}</strong><span class="inbox-date">${new Date(c.updated).toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</span></span><span class="row"><small>${esc(latestPreview(c))}</small><span class="inbox-markers">${c.pinned?'<span title="Pinned">⌖</span>':''}${c.blocked?'<span title="Blocked">⊘</span>':''}${c.unread?`<span class="unread-count">${Number(c.unread)}</span>`:c.waiting?'<span class="waiting-dot" title="Waiting for your reply"></span>':''}</span></span>${c.labels?.length?`<span class="inbox-labels">${c.labels.map(x=>`<span>${esc(x)}</span>`).join('')}</span>`:''}</span></button>`).join('')||'<div class="empty inbox-empty"><p>No chats match this filter.</p></div>';
  app.querySelectorAll('[data-id]').forEach(button=>button.onclick=()=>select(button.dataset.id));
}
async function select(id){
  if(selected===id&&current?.id===id){mobileView('chat');await markRead();return;}
  if(actionBusy)return;if(dirty&&!confirm('Discard your unsent reply and open another conversation?'))return;
  closeRecorder();selected=id;attachment=null;sendAttempt=null;quoted=null;dirty=false;fingerprint='';lastDraft='';threadSearch='';onlyStarred=false;drawList();mobileView('chat');
  try{const data=await api(`/api/admin/conversations/${id}`);if(selected!==id)return;current=data;drawConversation(true);await markRead();}catch(error){notice(error.message);}
}
function toInbox(){if(actionBusy)return;closeRecorder();mobileView('inbox');app.querySelector('#controls')?.classList.remove('mobile-open');}
async function markRead(){
  const lastId=current?.messages?.findLast(m=>m.role==='user')?.id;if(!lastId||lastId<=(readThrough.get(current.id)||0)||document.hidden||app.dataset.view!=='chat')return;
  const id=current.id;try{await api(`/api/admin/conversations/${id}/read`,'POST',{lastId});readThrough.set(id,lastId);const row=chats.find(c=>c.id===id);if(row)row.unread=0;drawList();}catch(error){if(error.status===401)login();}
}
function renderMessage(m){
  if(m.role==='system')return `<div data-message="${m.id}" class="entry system">${esc(m.body)}</div>`;
  const own=m.role!=='user',reply=current.messages.find(x=>x.id===m.replyTo);
  const reactions=(m.reactions||[]).map(r=>`<button type="button" class="reaction-pill ${r.by==='owner'?'mine':''}" data-react-existing="${m.id}" data-emoji="${esc(r.emoji)}" aria-label="${esc(r.emoji)} reaction">${esc(r.emoji)}</button>`).join('');
  return `<article data-message="${m.id}" class="entry ${own?'owner':'user'} ${m.deleted?'deleted':''}"><div class="body">${reply?`<button class="quoted-message" data-jump="${reply.id}"><strong>${esc(sender(reply))}</strong><span>${esc(readable(reply).slice(0,140))}</span></button>`:''}${m.deleted?'<span class="deleted-text">This message was deleted</span>':messageBody(m)}<span class="bubble-meta">${m.starred?'<span title="Starred">★</span>':''}${m.edited?'<span>edited</span>':''}<time>${time(m.created)}</time>${own?`<span class="message-ticks ${m.readByOther?'read':''}" aria-label="${m.readByOther?'Read by customer':'Sent'}">${m.readByOther?'✓✓':'✓'}</span>`:''}</span></div>${reactions?`<div class="message-reactions">${reactions}</div>`:''}<button type="button" class="message-options" data-message-menu="${m.id}" aria-label="Message actions">⌄</button></article>`;
}
function drawConversation(initial=false){
  queueMicrotask(()=>calls?.mount(app.querySelector('.owner-call-actions')));
  if(!current||selected!==current.id)return;
  const print=JSON.stringify([current,threadSearch,onlyStarred]);if(print===fingerprint&&!initial)return;fingerprint=print;
  const pane=app.querySelector('#conversation');
  if(initial)pane.innerHTML=`<header class="conversation-head"><button type="button" class="back-inbox" aria-label="Back to customer inbox">←</button><span class="customer-avatar" id="header-avatar"></span><div class="conversation-heading"><h2 id="customer-name"></h2><p id="customer-state"></p></div><div class="owner-call-actions"></div><button type="button" id="thread-find" aria-label="Search messages">⌕</button><button type="button" id="customer-settings" aria-label="Customer settings">⋮</button></header><div class="thread-search" hidden><input id="message-search" type="search" placeholder="Find in this conversation" aria-label="Find messages"><button id="starred-messages" aria-pressed="false">★ Starred</button><button id="close-find" aria-label="Close search">✕</button></div><div class="thread" id="thread"></div><div class="customer-typing" id="customer-typing" hidden>Customer is typing…</div><form class="reply-box" id="reply-form"><div class="quote-composer" id="quote-composer" hidden></div><div class="attachment-row" id="attachment-row" hidden><span id="attached-label"></span><button type="button" id="remove-attachment">✕</button></div><div class="recording-row" hidden><span class="recording-dot"></span><span id="recording-time">0:00</span><span>Recording voice message</span><button type="button" id="cancel-recording">Cancel</button><button type="button" id="finish-recording">Use recording</button></div><div class="composer-main"><button type="button" id="emoji-picker" aria-label="Add emoji">☺</button><button type="button" id="attach-menu" aria-label="Attach file or collection">＋</button><textarea id="reply" maxlength="4000" rows="1" placeholder="Message as Rekha" aria-label="Message as Rekha"></textarea><button type="button" id="voice-record" aria-label="Record voice message">🎙</button><button class="primary" id="send-reply" aria-label="Send message">➤</button></div><div class="composer-tools"><button type="button" id="insert-quick-reply">⚡ Quick replies</button><span id="draft-label"></span><label class="answer-toggle"><input type="checkbox" id="answer-pending" checked> Answer waiting messages</label></div><p id="reply-hint" class="reply-hint"></p><p class="error" id="reply-error" role="alert"></p><input id="owner-file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,audio/*,application/pdf" hidden></form>`;
  app.querySelector('#customer-name').textContent=current.name;app.querySelector('#header-avatar').textContent=current.name.slice(0,1).toUpperCase();
  app.querySelector('#customer-state').textContent=current.typing?.customer?'typing…':`${current.mode==='ai'?'Auto reply':current.mode==='assist'?'Draft approval':'Personal reply'}${current.blocked?' · Customer blocked':''}`;
  const thread=app.querySelector('#thread'),bottom=thread.scrollHeight-thread.scrollTop-thread.clientHeight<110;
  const messages=current.messages.filter(m=>(!onlyStarred||m.starred)&&(!threadSearch||readable(m).toLowerCase().includes(threadSearch.toLowerCase())));
  let previousDate='';const threadHtml=messages.map(m=>{const date=new Date(m.created).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});const separator=date!==previousDate?`<div data-message="date-${m.id}" class="day-divider">${esc(date)}</div>`:'';previousDate=date;return separator+renderMessage(m);}).join('');
  syncThread(thread,threadHtml||'<div data-message="empty-search" class="empty"><p>No messages found.</p></div>');
  if(initial||bottom)thread.scrollTop=thread.scrollHeight;
  const pending=current.messages.findLast(m=>m.role==='user'&&['pending','failed'].includes(m.status));const reply=app.querySelector('#reply');
  if(!dirty&&current.draft&&lastDraft!==current.draft.body){reply.value=current.draft.body;lastDraft=current.draft.body;}
  if(!pending&&!dirty){reply.value='';lastDraft='';}if(current.mode==='ai'&&!dirty){reply.value='';lastDraft='';}
  reply.disabled=actionBusy;app.querySelector('#send-reply').disabled=actionBusy;app.querySelector('#voice-record').disabled=actionBusy;
  app.querySelector('#draft-label').textContent=current.draft?'AI draft · review before sending':'';
  app.querySelector('#reply-hint').textContent=current.mode==='ai'?'Sending changes this chat to personal reply.':'You can send follow-ups anytime.';
  app.querySelector('.answer-toggle').hidden=!pending;
  app.querySelector('#customer-typing').hidden=!current.typing?.customer;
  app.querySelector('#attachment-row').hidden=!attachment;app.querySelector('#attached-label').textContent=attachment?.label||'';
  const quote=app.querySelector('#quote-composer');quote.hidden=!quoted;quote.innerHTML=quoted?`<div><strong>Reply to ${esc(sender(quoted))}</strong><span>${esc(readable(quoted).slice(0,160))}</span></div><button type="button" id="clear-quote" aria-label="Cancel reply">✕</button>`:'';
  app.querySelector('#clear-quote')?.addEventListener('click',()=>{quoted=null;sendAttempt=null;fingerprint='';drawConversation();});
  app.querySelector('#remove-attachment').onclick=()=>{attachment=null;sendAttempt=null;dirty=true;fingerprint='';drawConversation();};
  app.querySelector('.back-inbox').onclick=toInbox;
  app.querySelector('#customer-settings').onclick=()=>app.querySelector('#controls').classList.toggle('mobile-open');
  app.querySelector('#thread-find').onclick=()=>{app.querySelector('.thread-search').hidden=false;app.querySelector('#message-search').focus();};
  app.querySelector('#close-find').onclick=()=>{threadSearch='';onlyStarred=false;app.querySelector('#message-search').value='';app.querySelector('.thread-search').hidden=true;fingerprint='';drawConversation();};
  app.querySelector('#message-search').oninput=e=>{threadSearch=e.target.value;fingerprint='';drawConversation();};
  app.querySelector('#starred-messages').setAttribute('aria-pressed',onlyStarred);app.querySelector('#starred-messages').onclick=()=>{onlyStarred=!onlyStarred;fingerprint='';drawConversation();};
  app.querySelector('#insert-quick-reply').onclick=()=>quickReplies(true);
  app.querySelector('#attach-menu').onclick=attachmentMenu;
  app.querySelector('#owner-file').onchange=async e=>{const file=e.target.files?.[0];e.target.value='';if(file)await uploadAttachment(file);};
  app.querySelector('#emoji-picker').onclick=emojiPicker;
  app.querySelector('#voice-record').onclick=startRecording;app.querySelector('#cancel-recording').onclick=()=>closeRecorder(true);app.querySelector('#finish-recording').onclick=()=>closeRecorder(false);
  reply.oninput=()=>{dirty=true;sendAttempt=null;growReply();const now=Date.now();if(now-typingAt>3500){typingAt=now;api(`/api/admin/conversations/${current.id}/typing`,'POST',{active:true}).catch(()=>{});}};
  reply.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();app.querySelector('#reply-form').requestSubmit();}};
  growReply();
  app.querySelectorAll('[data-message-menu]').forEach(b=>b.onclick=()=>messageMenu(Number(b.dataset.messageMenu)));
  app.querySelectorAll('[data-jump]').forEach(b=>b.onclick=()=>jumpMessage(Number(b.dataset.jump)));
  app.querySelectorAll('[data-react-existing]').forEach(b=>b.onclick=()=>react(Number(b.dataset.reactExisting),b.classList.contains('mine')?'':b.dataset.emoji));
  app.querySelector('#reply-form').onsubmit=async event=>{
    event.preventDefault();if(actionBusy||(!reply.value.trim()&&!attachment))return;actionBusy=true;
    const id=current.id,body=reply.value;app.querySelector('#send-reply').disabled=true;app.querySelector('#reply-error').textContent='';
    try{const payload={body,version:current.version,replyTo:quoted?.id||null,answersPending:!!pending&&app.querySelector('#answer-pending').checked,...(attachment?.collectionId?{collectionId:attachment.collectionId}:attachment?{itemIds:attachment.itemIds}:{})};const signature=JSON.stringify({...payload,version:undefined});if(!sendAttempt||sendAttempt.signature!==signature)sendAttempt={signature,clientId:crypto.randomUUID()};const data=await api(`/api/admin/conversations/${id}/send`,'POST',{...payload,clientId:sendAttempt.clientId});attachment=null;sendAttempt=null;quoted=null;if(selected===id){current=data;dirty=false;reply.value='';lastDraft='';}api(`/api/admin/conversations/${id}/typing`,'POST',{active:false}).catch(()=>{});}
    catch(error){app.querySelector('#reply-error').textContent=error.message;if(error.status===409){current=await api(`/api/admin/conversations/${id}`);sendAttempt=null;}}
    finally{actionBusy=false;fingerprint='';drawConversation();}
  };
  if(initial)app.querySelector('#controls').dataset.formEditing='false';
  drawControls(pending);
}
function growReply(){const el=app.querySelector('#reply');if(!el)return;el.style.height='auto';el.style.height=`${Math.min(el.scrollHeight,140)}px`;}
function drawControls(pending){
  const controls=app.querySelector('#controls');
  if(controls.dataset.formEditing==='true')return;
  const previousScroll=controls.scrollTop;
  controls.innerHTML=`<div class="controls-head"><h3>Customer settings</h3><button id="close-settings" aria-label="Close customer settings">✕</button></div><section class="customer-actions"><button data-setting="pinned" aria-pressed="${!!current.pinned}">${current.pinned?'Unpin':'Pin'} chat</button><button data-setting="archived">${current.archived?'Unarchive':'Archive'}</button><button data-setting="blocked" class="${current.blocked?'danger-active':''}">${current.blocked?'Unblock customer':'Block customer'}</button></section><section class="customer-notes"><h3>Private notes & labels</h3><form id="customer-details-form"><label>Labels<input id="customer-labels" maxlength="300" value="${esc((current.labels||[]).join(', '))}" placeholder="Paid, Follow up, New"></label><label>Notes<textarea id="customer-notes" maxlength="4000" rows="3" placeholder="Visible only to you">${esc(current.notes||'')}</textarea></label><button class="primary">Save details</button><span id="details-status" role="status"></span></form></section><h3>Reply mode</h3>${[['ai','AI auto-reply','Automatic replies for this customer.'],['assist','AI assisted','Review or edit a draft, then send.'],['manual','Personal reply','Reply yourself whenever you like.']].map(([key,name,description])=>`<button class="mode ${current.mode===key?'active':''}" data-mode="${key}" aria-pressed="${current.mode===key}" ${actionBusy?'disabled':''}><strong>${name}</strong><span>${description}</span></button>`).join('')}<p class="control-note">These settings are private. Your customer sees Rekha.</p>${pending?.status==='failed'?'<button id="retry-ai">Retry failed draft / reply</button>':''}<section class="profile"><h3>Customer details</h3><dl><dt>Date of birth</dt><dd>${esc(current.dob)}</dd><dt>Language</dt><dd>${esc(current.language)}</dd><dt>Conversation</dt><dd>${current.entitlement==='demo'?'Preview unlock · not paid':current.entitlement==='paid'?'₹49 paid':'Free'}</dd><dt>Free replies used</dt><dd>${current.freeUsed}</dd><dt>Location</dt><dd>${current.preferences?.location?esc(`${current.preferences.location.latitude}, ${current.preferences.location.longitude}`):'Not shared'}</dd><dt>Kundli</dt><dd>Not calculated in this preview.</dd></dl></section>`;
  controls.querySelector('#close-settings').onclick=()=>controls.classList.remove('mobile-open');
  const flowButton=document.createElement('button');flowButton.className='flow-tools-button';flowButton.textContent='Customer video & reply flow →';flowButton.type='button';flowButton.onclick=()=>openChatWorkflow({api,notice,conversationId:current.id,customerName:current.name});controls.querySelector('.customer-actions').after(flowButton);
  controls.querySelectorAll('[data-setting]').forEach(b=>b.onclick=async()=>{const key=b.dataset.setting;if(key==='blocked'&&!current.blocked&&!confirm('Block this customer from sending new messages? You can unblock them later.'))return;try{const result=await api(`/api/admin/conversations/${current.id}/settings`,'PATCH',{[key]:!current[key]});current={...current,...result};const row=chats.find(c=>c.id===current.id);if(row)Object.assign(row,result);fingerprint='';drawConversation();drawList();notice('Customer settings saved.');}catch(error){notice(error.message);}});
  controls.querySelector('#customer-details-form').onsubmit=async e=>{e.preventDefault();const labels=controls.querySelector('#customer-labels').value.split(',').map(x=>x.trim()).filter(Boolean);if(labels.some(x=>x.length>30)||labels.length>8)return notice('Use up to 8 labels, with 30 characters each.');try{const result=await api(`/api/admin/conversations/${current.id}/settings`,'PATCH',{labels,notes:controls.querySelector('#customer-notes').value});current={...current,...result};const row=chats.find(c=>c.id===current.id);if(row)Object.assign(row,result);controls.dataset.formEditing='false';controls.querySelector('#details-status').textContent=' Saved';drawList();}catch(error){notice(error.message);}};
  controls.dataset.formEditing='false';controls.querySelector('#customer-details-form').addEventListener('input',()=>controls.dataset.formEditing='true');
  controls.querySelectorAll('[data-mode]').forEach(button=>button.onclick=async()=>{
    if(actionBusy||button.dataset.mode===current.mode)return;if(dirty&&!confirm('Discard your unsent reply and change reply mode?'))return;actionBusy=true;
    try{current=await api(`/api/admin/conversations/${current.id}/mode`,'PATCH',{mode:button.dataset.mode});dirty=false;app.querySelector('#reply').value='';lastDraft='';notice('Reply mode updated.');}catch(error){notice(error.message);}finally{actionBusy=false;fingerprint='';drawConversation();}
  });
  controls.querySelector('#retry-ai')?.addEventListener('click',async()=>{try{current=await api(`/api/admin/conversations/${current.id}/retry`,'POST',{});fingerprint='';drawConversation();}catch(error){notice(error.message);}});
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
  try{const response=await fetch(`/api/admin/uploads?title=${encodeURIComponent(file.name||'Voice message')}&category=general`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type||'application/octet-stream'},body:file,signal:AbortSignal.timeout(180000)});const result=await response.json();if(!response.ok)throw Error(result.error);if(selected===id){attachment={itemIds:[result.id],label:result.title||file.name};sendAttempt=null;dirty=true;}notice('Attachment ready. Press Send to share it.');}catch(error){notice(error.message);}finally{actionBusy=false;fingerprint='';drawConversation();}
}
async function startRecording(){
  if(recorder?.state==='recording')return;if(!window.MediaRecorder||!navigator.mediaDevices?.getUserMedia)return notice('Voice recording is unavailable in this browser. You can attach an audio file.');
  const chatId=selected;
  try{recordingStream=await navigator.mediaDevices.getUserMedia({audio:true});if(selected!==chatId){closeRecorder();return;}const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));recorder=new MediaRecorder(recordingStream,mime?{mimeType:mime}:undefined);recordingChunks=[];recordingCancelled=false;recordingStarted=Date.now();recorder.ondataavailable=e=>{if(e.data.size)recordingChunks.push(e.data);};recorder.onstop=async()=>{recordingStream?.getTracks().forEach(t=>t.stop());recordingStream=null;clearInterval(recordingTimer);recordingTimer=null;const row=app.querySelector('.recording-row');if(row)row.hidden=true;if(recordingCancelled||selected!==chatId)return;const type=recorder.mimeType.split(';')[0],extension=type.includes('ogg')?'ogg':type.includes('mp4')?'m4a':'webm';const file=new File(recordingChunks,`Voice message.${extension}`,{type});await uploadAttachment(file);};recorder.start(1000);app.querySelector('.recording-row').hidden=false;app.querySelector('#recording-time').textContent='0:00';recordingTimer=setInterval(()=>{const seconds=Math.floor((Date.now()-recordingStarted)/1000);app.querySelector('#recording-time').textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;if(seconds>=180)closeRecorder(false);},1000);}catch(error){closeRecorder();notice(error.name==='NotAllowedError'?'Microphone permission was declined.':'Could not start voice recording.');}
}
function emojiPicker(){const d=dialog('Add emoji',`<div class="emoji-grid">${['😊','🙏','❤️','👍','✨','🌸','☀️','🌙','🎉','💫','🌟','🤗','✅','🙂','💐','🕉️'].map(x=>`<button data-emoji="${x}" aria-label="${x}">${x}</button>`).join('')}</div>`);d.querySelectorAll('[data-emoji]').forEach(b=>b.onclick=()=>{const reply=app.querySelector('#reply'),start=reply.selectionStart,end=reply.selectionEnd;reply.value=reply.value.slice(0,start)+b.dataset.emoji+reply.value.slice(end);dirty=true;sendAttempt=null;d.close();reply.focus();growReply();});}
function jumpMessage(id){const el=app.querySelector(`[data-message="${id}"]`);if(!el)return notice('Clear the message search to see this reply.');el.scrollIntoView({block:'center',behavior:'smooth'});el.classList.add('highlight');setTimeout(()=>el.classList.remove('highlight'),1800);}
async function refreshSelected(){const id=selected;if(!id)return;const data=await api(`/api/admin/conversations/${id}`);if(selected===id){current=data;fingerprint='';drawConversation();}}
async function react(id,emoji){try{await api(`/api/admin/conversations/${current.id}/messages/${id}/reaction`,'PUT',{emoji});await refreshSelected();}catch(error){notice(error.message);}}
function messageMenu(id){
  const m=current.messages.find(x=>x.id===id);if(!m)return;const own=m.role!=='user'&&m.kind!=='welcome',text=!m.deleted&&m.kind!=='media',age=Date.now()-new Date(m.created).getTime();
  const d=dialog('Message',`<p class="message-menu-preview">${esc(readable(m).slice(0,200))}</p>${m.deleted?'':`<div class="reaction-choices">${['👍','❤️','😂','😮','😢','🙏'].map(x=>`<button data-reaction="${x}" aria-label="React ${x}">${x}</button>`).join('')}</div>`}<div class="message-menu-list">${!m.deleted?'<button id="quote-message">Reply to this message</button><button id="copy-message">Copy text</button>':''}<button id="star-message">${m.starred?'Unstar':'Star'} message</button>${own&&text&&age<=15*60*1000?'<button id="edit-message">Edit message</button>':''}${own&&!m.deleted&&age<=24*60*60*1000?'<button id="delete-message" class="danger">Delete for everyone</button>':''}</div>`);
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
      d.querySelector('[data-close]').onclick=()=>d.close();d.querySelectorAll('[data-use]').forEach(b=>b.onclick=()=>{const x=items.find(x=>String(x.id)===b.dataset.use),reply=app.querySelector('#reply');reply.value=reply.value?`${reply.value}\n${x.body}`:x.body;dirty=true;sendAttempt=null;d.close();growReply();reply.focus();});
      d.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{editing=items.find(x=>String(x.id)===b.dataset.edit);draw();d.querySelector('#quick-reply-form').scrollIntoView({block:'nearest'});});
      d.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this saved quick reply?'))return;try{await api(`/api/admin/quick-replies/${b.dataset.delete}`,'DELETE');items=await api('/api/admin/quick-replies');editing=null;draw();}catch(error){notice(error.message);}});
      d.querySelector('#cancel-quick-edit')?.addEventListener('click',()=>{editing=null;draw();});
      d.querySelector('#quick-reply-form').onsubmit=async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));try{await api(editing?`/api/admin/quick-replies/${editing.id}`:'/api/admin/quick-replies',editing?'PATCH':'POST',values);items=await api('/api/admin/quick-replies');editing=null;draw();notice('Quick reply saved.');}catch(error){d.querySelector('.error').textContent=error.message;}};
    }draw();
  }catch(error){notice(error.message);}
}
async function poll(){
  calls?.poll();
  if(loading||document.hidden||actionBusy)return;loading=true;
  try{chats=await api('/api/admin/conversations');drawList();if(selected&&app.dataset.view==='chat'){const id=selected;const data=await api(`/api/admin/conversations/${id}`);if(id===selected){current=data;drawConversation();await markRead();}}}
  catch(error){if(error.status===401)login();else if(error.status===404){selected=null;current=null;dirty=false;await workspace();notice('This conversation was deleted.');}else notice('Connection paused. Trying again…');}
  finally{loading=false;}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){closeRecorder();if(selected)api(`/api/admin/conversations/${selected}/typing`,'POST',{active:false}).catch(()=>{});}else poll();});
workspace().catch(error=>{if(error.status===401)login();else{login();notice(error.message);}});
