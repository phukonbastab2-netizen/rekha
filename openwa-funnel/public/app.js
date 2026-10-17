import { createApi } from './api.js';
const api = createApi();
const $ = id => document.getElementById(id);
const element = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
let selected = '', enabled = false, currentContact, contacts = [], contactCursor = '', messageCursor = '', polling = false, posting = false, listSignature = '', renderSignature = '', toastTimer, forceBottom = false;
const currentMessages = new Map(), draftByPeer = new Map(), messageNodes = new Map(), dayNodes = new Map();
const mediaLabels = {image:'Image',video:'Video',audio:'Audio',ptt:'Voice message',document:'Document',sticker:'Sticker',payment:'WhatsApp payment',location:'Location',vcard:'Contact',multi_vcard:'Contacts'};
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function initials(name) { const words=String(name||'').trim().split(/\s+/); if (/^\+?[\d\s]+$/.test(name)) return '#'; return words.slice(0,2).map(w=>[...w][0]||'').join('').toUpperCase()||'?'; }
function contactName(c) { return c.name || c.peer.split('@')[0]; }
function validDate(at) { const d=new Date(at); return Number.isFinite(d.getTime())?d:null; }
function contactTime(at) { const date=validDate(at);if(!date||!at)return '';return date.toDateString()===new Date().toDateString()?date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):date.toLocaleDateString([],{day:'numeric',month:'short'}); }
function contactList() {
  const query=$('contactSearch').value.trim().toLocaleLowerCase(), sorted=[...contacts].sort((a,b)=>(b.lastAt||b.lastInboundAt||0)-(a.lastAt||a.lastInboundAt||0)), rows=sorted.filter(c=>!query||[c.name,c.peer].some(v=>String(v||'').toLocaleLowerCase().includes(query)));
  $('contactCount').textContent = contacts.length ? String(contacts.length) : ''; $('empty').hidden=contacts.length>0; $('noSearchResults').hidden=!query||rows.length>0;
  const signature=JSON.stringify([selected,query,rows.map(c=>[c.peer,c.name,c.preview,c.unread,c.lastAt,c.lastInboundAt])]); if(signature===listSignature)return;listSignature=signature;
  const fragment=document.createDocumentFragment();
  for (const c of rows) {
    const button=element('button',undefined,'contact'+(c.peer===selected?' active':'')+(c.unread?' has-unread':''));button.type='button';button.setAttribute('aria-pressed',String(c.peer===selected));
    const avatar=element('span',initials(contactName(c)),'avatar');avatar.setAttribute('aria-hidden','true');
    const content=element('span',undefined,'contact-content'),top=element('span',undefined,'contact-top'),bottom=element('span',undefined,'contact-bottom');
    top.append(element('strong',contactName(c)),element('span',contactTime(c.lastAt||c.lastInboundAt),'contact-time'));bottom.append(element('small',c.preview||'No stored message content'));
    if(c.unread){const badge=element('span',c.unread>99?'99+':String(c.unread),'count');badge.setAttribute('aria-label',c.unread+' unread messages');bottom.append(badge);}
    content.append(top,bottom);button.append(avatar,content);button.onclick=()=>void choose(c.peer).catch(e=>toast(e.message));fragment.append(button);
  }
  $('contacts').replaceChildren(fragment);
}
function resizeComposer(){const input=$('reply');input.style.height='auto';input.style.height=Math.min(130,input.scrollHeight)+'px';}
function updateComposer(){const blocked=!currentContact||!!currentContact.optedOut;$('reply').disabled=blocked;$('send').disabled=blocked||posting||!$('reply').value.trim();$('reply').placeholder=currentContact?.optedOut?'Customer opted out':'Type a message';}
function saveDraft(){if(selected)draftByPeer.set(selected,{...(draftByPeer.get(selected)||{}),value:$('reply').value});}
async function choose(peer) {
  if(selected===peer){$('workspace').classList.add('chat-selected');return;}
  saveDraft();selected=peer;currentContact=null;currentMessages.clear();messageNodes.clear();dayNodes.clear();messageCursor='';renderSignature='';forceBottom=true;
  $('workspace').classList.add('chat-selected');$('chatActions').open=false;$('chatActions').hidden=true;$('composer').hidden=true;$('uncertain').hidden=true;
  const contact=contacts.find(c=>c.peer===peer);$('name').textContent=contact?contactName(contact):peer.split('@')[0];$('chatAvatar').textContent=initials($('name').textContent);$('details').textContent='Loading conversation…';
  $('messages').replaceChildren(element('p','Loading messages…','empty'));$('reply').value=draftByPeer.get(peer)?.value||'';updateComposer();contactList();
  try{await api('seen',{peer});if(contact){contact.unread=0;contactList();}}catch{toast('Chat opened. WhatsApp read receipt is not confirmed.');}
  if(selected!==peer)return;await loadMessages();resizeComposer();
}
async function loadContacts(older=false) {
  const rows=await api('contacts'+(older&&contactCursor?'?before='+encodeURIComponent(contactCursor):''));
  if(older)contacts=[...contacts,...rows.filter(r=>!contacts.some(c=>c.key===r.key))];
  else{const ids=new Set(rows.map(c=>c.key));contacts=[...rows,...contacts.filter(c=>!ids.has(c.key))];}
  if(older||!contactCursor)contactCursor=rows.at(-1)?._cursor||'';
  if(older||contacts.length<=50)$('moreContacts').hidden=rows.length<50;contactList();
}
function attachmentCard(label,detail,url,download=false){const card=element(url?'a':'div',undefined,'attachment');if(url){card.href=url;if(download)card.download='whatsapp-attachment';else{card.target='_blank';card.rel='noreferrer noopener';}}const icon=element('span',label==='Video'?'▶':label==='Audio'||label==='Voice message'?'♪':'▤','attachment-icon');icon.setAttribute('aria-hidden','true');const copy=element('span',undefined,'attachment-label');copy.append(element('strong',label),element('small',detail));card.append(icon,copy);return card;}
function safeUrl(value){try{const u=new URL(value,location.href);return ['http:','https:'].includes(u.protocol)?u.href:null;}catch{return null;}}
function assetName(url){try{return decodeURIComponent(new URL(url,location.href).pathname.split('/').at(-1))||'Open attachment';}catch{return 'Open attachment';}}
function messageContent(bubble,m){
  if(m.body)bubble.append(element('div',m.body,'text'));
  const type=mediaLabels[m.type]||'Attachment',mime=m.media?.mime||'',mediaId=String(m.media?.id||''),hasMedia=/^[a-f0-9]{64}$/i.test(mediaId);
  if(hasMedia){
    const download='/media/'+encodeURIComponent(mediaId),inline=download+'?inline=1';let preview;
    if(/^image\//.test(mime)&&['image','sticker'].includes(m.type)){preview=element('img');preview.alt=m.type==='sticker'?'WhatsApp sticker':'Chat image';preview.loading='lazy';}
    else if(/^video\//.test(mime)){preview=element('video');preview.controls=true;preview.preload='metadata';preview.playsInline=true;}
    else if(/^audio\//.test(mime)){preview=element('audio');preview.controls=true;preview.preload='metadata';preview.setAttribute('aria-label',type);}
    if(preview){preview.src=inline;preview.className='media-preview';bubble.append(preview);const a=element('a','Download '+type.toLocaleLowerCase(),'media-download');a.href=download;a.download='whatsapp-attachment';bubble.append(a);}
    else bubble.append(attachmentCard(type,'Download attachment',download,true));
  }else if(m.url&&safeUrl(m.url)){bubble.append(attachmentCard(type,assetName(m.url),safeUrl(m.url)));}
  else if(!m.sensitive&&m.type&&!['text','chat'].includes(m.type)){bubble.append(attachmentCard(type,m.attachmentError?'Attachment unavailable':'Media content is not saved in this inbox yet'));}
  if(m.attachmentError)bubble.append(element('p',m.attachmentError,'attachment-error'));
  if(!m.body&&!hasMedia&&!m.url&&['text','chat',undefined].includes(m.type))bubble.append(element('div','[Message content unavailable]','text'));
  bubble.append(element('div',undefined,'meta'));
}
const statusLabels={queued:'Waiting for WhatsApp confirmation',accepted:'Accepted; delivery not yet confirmed',sent:'Sent',owner_confirmed_sent:'Owner confirmed sent',delivered:'Delivered',read:'Read',failed:'Failed',unknown:'Send outcome uncertain',retry_queued:'Retry queued',skipped:'Skipped'};
function updateMeta(bubble,m){
  const meta=bubble.querySelector('.meta');meta.replaceChildren();const date=validDate(m.at),time=element('time',date?date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'');if(date)time.dateTime=date.toISOString();time.title=date?date.toLocaleString():'Timestamp unavailable';meta.append(time);
  if(m.direction==='out'){const mark=element('span',['read','delivered'].includes(m.status)?'✓✓':['sent','owner_confirmed_sent'].includes(m.status)?'✓':['unknown','failed'].includes(m.status)?'!':m.status==='skipped'?'−':'◷','delivery-mark '+(Object.hasOwn(statusLabels,m.status)?m.status:'queued'));mark.title=statusLabels[m.status]||'Not yet confirmed';mark.setAttribute('aria-label',mark.title);meta.append(mark);}
  bubble.title=m.source==='owner_whatsapp'?'Sent from your business WhatsApp':m.source==='owner'?'Sent from this admin inbox':m.source==='funnel'?'Funnel message':'';
}
function dayLabel(at){const d=validDate(at);if(!d)return 'Date unavailable';const now=new Date(),yesterday=new Date();yesterday.setDate(now.getDate()-1);return d.toDateString()===now.toDateString()?'Today':d.toDateString()===yesterday.toDateString()?'Yesterday':d.toLocaleDateString([],{day:'numeric',month:'long',year:'numeric'});}
function renderMessages(older=false){
  const messages=[...currentMessages.values()].sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key)),signature=JSON.stringify([selected,messageCursor,messages]);if(signature===renderSignature)return;renderSignature=signature;
  const list=$('messages'),nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<100,oldHeight=list.scrollHeight,oldTop=list.scrollTop,nodes=[];
  if(messageCursor&&currentMessages.size>=50){let b=dayNodes.get('older');if(!b){b=element('button','Load older messages','older');b.onclick=()=>loadMessages(true).catch(e=>toast(e.message));dayNodes.set('older',b);}nodes.push(b);}
  let previousDay='';for(const m of messages){const day=dayLabel(m.at);if(day!==previousDay){let divider=dayNodes.get(day);if(!divider){divider=element('div',day,'day-divider');dayNodes.set(day,divider);}nodes.push(divider);previousDay=day;}
    const contentSignature=JSON.stringify([m.body,m.url,m.media,m.attachmentError,m.sensitive,m.type,m.direction]);let entry=messageNodes.get(m.key);
    if(!entry||entry.signature!==contentSignature){const bubble=element('div',undefined,'message '+(m.direction==='out'?'out':'in')+(m.sensitive?' sensitive':''));messageContent(bubble,m);entry={node:bubble,signature:contentSignature};messageNodes.set(m.key,entry);}updateMeta(entry.node,m);nodes.push(entry.node);
  }
  if(!messages.length)nodes.push(element('p','No stored messages in this chat.','empty'));
  let cursor=list.firstChild;for(const node of nodes){if(node===cursor)cursor=cursor.nextSibling;else list.insertBefore(node,cursor);}while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
  if(older)list.scrollTop=oldTop+list.scrollHeight-oldHeight;else if(nearBottom||forceBottom)list.scrollTop=list.scrollHeight;forceBottom=false;
}
async function loadMessages(older=false) {
  if(!selected)return;const peer=selected,result=await api('messages?peer='+encodeURIComponent(peer)+(older&&messageCursor?'&before='+encodeURIComponent(messageCursor):''));if(selected!==peer)return;
  currentContact=result.contact;if(!currentContact)return;
  $('name').textContent=contactName(currentContact);$('chatAvatar').textContent=initials(contactName(currentContact));
  $('details').textContent=`${currentContact.peer.split('@')[0]} · ${currentContact.optedOut?'Opted out':currentContact.paused?'Automation paused':'Automation ready'} · Payment: ${String(currentContact.payment||'pending').replaceAll('_',' ')}`;
  $('chatActions').hidden=false;$('composer').hidden=false;
  if(!$('deleteChat')){const b=element('button','Delete chat content');b.id='deleteChat';b.onclick=deleteChat;$('chatActions').querySelector('.chat-options-menu').append(b);}
  $('pause').textContent=currentContact.paused?'Resume automation':'Pause automation';$('payment').textContent=currentContact.payment==='verified_by_owner'?'Mark payment pending':'Verify payment';updateComposer();
  for(const m of result.messages)currentMessages.set(m.key,m);if(older||!messageCursor)messageCursor=result.messages.at(-1)?._cursor||'';renderMessages(older);
  const jobs=result.jobs||[],jobSignature=JSON.stringify(jobs);$('uncertain').hidden=!jobs.length;
  if($('uncertain').dataset.signature!==jobSignature){$('uncertain').dataset.signature=jobSignature;$('uncertain').replaceChildren();for(const job of jobs){$('uncertain').append(element('p','A send has an uncertain outcome. Check this chat in WhatsApp before deciding.'));for(const[action,label]of[['sent','I checked: it was sent'],['skip','Skip this message'],['retry','I checked: retry once']]){const button=element('button',label);button.onclick=async()=>{try{await api('resolve',{peer,key:job.key,action});await loadMessages();}catch(e){toast(e.message);}};$('uncertain').append(button);}}}
}
function settings(open){$('settingsPanel').hidden=!open;$('settingsBackdrop').hidden=!open;$('settingsButton').setAttribute('aria-expanded',String(open));$('workspace').inert=open;document.querySelector('.app-header').inert=open;if(open)$('closeSettings').focus();else $('settingsButton').focus();}
$('settingsButton').onclick=()=>settings(true);$('closeSettings').onclick=$('settingsBackdrop').onclick=()=>settings(false);
document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(!$('settingsPanel').hidden)settings(false);$('chatActions').open=false;}if(event.key==='Tab'&&!$('settingsPanel').hidden){const controls=[...$('settingsPanel').querySelectorAll('button,a,input,summary')].filter(e=>!e.disabled&&e.getClientRects().length),first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){last?.focus();event.preventDefault();}else if(!event.shiftKey&&document.activeElement===last){first?.focus();event.preventDefault();}}});
$('chatBack').onclick=()=>{$('workspace').classList.remove('chat-selected');$('reply').blur();};$('contactSearch').oninput=contactList;
document.addEventListener('click',event=>{if(!$('chatActions').contains(event.target))$('chatActions').open=false;});
async function refresh() {
  if(polling)return;polling=true;
  try{
    const status=await api('status');enabled=status.enabled;$('connection').textContent=status.connection.replaceAll('_',' ');$('connection').className='badge '+status.connection;
    $('connect').hidden=status.connection==='connected';$('connect').disabled=['connected','starting','scan_qr','enter_code','restarting'].includes(status.connection);
    $('linkOptions').hidden=!status.canPairWithPhone||!(['scan_qr','enter_code'].includes(status.connection)||(!status.linkedBefore&&['disconnected','error'].includes(status.connection)));
    $('generateCode').disabled=$('useQr').disabled=['starting','restarting','connected'].includes(status.connection);$('toggle').textContent=enabled?'Pause funnel':'Enable funnel';
    $('summary').textContent=`${status.contacts} saved chats · ${status.queued} queued · ${status.uncertain} need checking${status.inboxSync?.checkedAt?' · WhatsApp session: '+status.inboxSync.providerChats+' chats':''}${status.receiver?.healthy===false?' · '+status.receiver.error:''}${status.inboxSync?.error?' · '+status.inboxSync.error:''}`;
    $('backup').textContent=`Cloud backup: ${status.cloud.replaceAll('_',' ')}${status.backupPending?' · '+status.backupPending+' changes pending':''}`;
    $('pairing').hidden=!status.qr&&!status.pairingCode;$('codePanel').hidden=!status.pairingCode;$('pairCode').textContent=status.pairingCode||'';$('qr').hidden=!status.qr;
    if(status.qr&&$('qr').getAttribute('src')!==status.qr)$('qr').src=status.qr;if(!status.qr)$('qr').removeAttribute('src');if(status.error)$('summary').textContent=status.error;
    await loadContacts();await loadMessages();
  }catch(e){$('connection').textContent='Gateway reconnecting…';$('connection').className='badge disconnected';}finally{polling=false;}
}
$('connect').onclick=async()=>{try{await api('connect',{});await refresh();}catch(e){toast(e.message);}};
async function requestPairing(mode){$('generateCode').disabled=$('useQr').disabled=true;try{await api('pairing',{mode,...(mode==='phone'?{phone:$('pairPhone').value}:{})});toast('Preparing your link. The private service will restart; keep this page open.');}catch(e){toast(e.message);}await refresh();}
$('phonePairing').onsubmit=event=>{event.preventDefault();void requestPairing('phone');};$('useQr').onclick=()=>void requestPairing('qr');
$('toggle').onclick=async()=>{try{await api('enabled',{enabled:!enabled});await refresh();}catch(e){toast(e.message);}};$('refresh').onclick=refresh;$('moreContacts').onclick=()=>loadContacts(true).catch(e=>toast(e.message));
$('pause').onclick=async()=>{try{await api('pause',{peer:selected,paused:!currentContact.paused});$('chatActions').open=false;await loadMessages();}catch(e){toast(e.message);}};
$('payment').onclick=async()=>{const verified=currentContact.payment!=='verified_by_owner';if(verified&&!confirm('Have you independently checked that the ₹29 payment reached your account? A screenshot alone is not confirmation.'))return;try{await api('payment',{peer:selected,verified});$('chatActions').open=false;await loadMessages();}catch(e){toast(e.message);}};
$('composer').onsubmit=async event=>{
  event.preventDefault();const text=$('reply').value.trim(),peer=selected;if(!text||posting||!currentContact||currentContact.optedOut)return;
  saveDraft();const draft=draftByPeer.get(peer);draft.requestId||=crypto.randomUUID();const requestId=draft.requestId;posting=true;updateComposer();
  try{await api('send',{peer,body:text,requestId});if(draftByPeer.get(peer)?.requestId===requestId){draftByPeer.delete(peer);if(selected===peer){$('reply').value='';resizeComposer();}}toast('Reply queued. Delivery status will update after WhatsApp accepts it.');if(selected===peer){forceBottom=true;await loadMessages();}}
  catch(e){toast(e.message+'. Retrying this same draft will not duplicate it.');}finally{posting=false;updateComposer();}
};
$('reply').oninput=()=>{draftByPeer.set(selected,{value:$('reply').value,requestId:''});resizeComposer();updateComposer();};
$('reply').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('send').disabled)$('composer').requestSubmit();}};
void refresh();setInterval(refresh,3000);

const bytes=n=>Number.isFinite(n)?(n/1024**3>=1?(n/1024**3).toFixed(2)+' GB':(n/1024**2).toFixed(1)+' MB'):'Not measured';
async function checkBackend(){
  try{
    const m=await api('monitor'),cards=$('monitorCards');cards.replaceChildren();
    const rows=[['Server disk',bytes(m.disk.free)+' free / '+bytes(m.disk.total)],['Chat database',bytes(m.database.bytes)+' · '+bytes(m.database.reusableBytes)+' reusable'],['Customer attachments',bytes(m.folders.media.bytes)+(m.folders.media.partial?' (partial count)':'')],['WhatsApp profile',bytes(m.folders.profile.bytes)],['Server memory',bytes(m.memory.serverUsed)+' / '+bytes(m.memory.serverTotal)],['Gateway memory',bytes(m.memory.gatewayRss)],['Queue',m.counts.queued+' waiting · '+m.counts.uncertain+' uncertain'],['Cloud backup',m.cloud.state+' · '+m.counts.backupPending+' pending changes'],['D1 storage',bytes(m.cloud.databaseBytes)+' / '+bytes(m.cloud.d1MaxBytes)+' (shared database)'],['Retention','90 days · duplicate markers retained'],['Stored customer target','1,000,000 · delivery capacity is separate'],['Checked',new Date(m.checkedAt).toLocaleTimeString()+' · file sizes '+(m.folders.checkedAt?new Date(m.folders.checkedAt).toLocaleTimeString():'scanning')]];
    for(const[label,value]of rows){const card=element('div',undefined,'monitor-card');card.append(element('small',label),element('strong',String(value)));cards.append(card);}
    $('monitorWarnings').textContent=[...m.warnings,m.capacityStatus,m.cloud.providerUsage].join('\n');
  }catch(e){$('monitorWarnings').textContent=e.message;}
}
async function deleteChat(){
  const peer=selected;if(!peer||!confirm('Delete this customer’s stored chat content and attachments? Automation will pause. Cloud deletion finishes after backup sync. WhatsApp messages on the phones are unchanged.'))return;
  const b=$('deleteChat');b.disabled=true;
  try{let r;do{r=await api('delete-content',{peer,confirm:'DELETE CHAT CONTENT'});}while(r.more);currentMessages.clear();messageCursor='';await loadContacts();if(selected===peer)await loadMessages();toast('Content deleted locally. Cloud deletion is pending until backup sync completes.');}
  catch(e){toast(e.message);}finally{b.disabled=false;}
}
$('backend').ontoggle=()=>{if($('backend').open)void checkBackend();};
$('checkBackend').onclick=checkBackend;
$('cleanExpired').onclick=async()=>{if(!confirm('Delete one batch of chat content older than 90 days? Active and uncertain sends will remain.'))return;try{await api('cleanup',{confirm:'DELETE EXPIRED CONTENT'});await checkBackend();toast('Expired-content cleanup finished for this batch.');}catch(e){toast(e.message);}};
setInterval(()=>{if($('backend').open&&!document.hidden)void checkBackend();},30000);
$('mobileCodeButton').onclick=async()=>{const b=$('mobileCodeButton');b.disabled=true;try{const r=await api('mobile-link',{});$('mobileCode').textContent=r.code+' · expires '+new Date(r.expires).toLocaleTimeString();setTimeout(()=>$('mobileCode').textContent='',Math.max(0,r.expires-Date.now()));}catch(e){toast(e.message);}finally{b.disabled=false;}};
$('revokeMobile').onclick=async()=>{if(!confirm('Sign out every phone/browser admin session? Generate a new code to sign in again.'))return;try{await api('mobile-revoke',{});$('mobileCode').textContent='';toast('All remote admin sessions signed out.');}catch(e){toast(e.message);}};
