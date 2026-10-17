const waEsc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const waDate=value=>new Date(value).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
let activeWhatsApp=null;
export function waCsvCell(value){let text=String(value??'');if(/^[=+@\-\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
export function closeWhatsAppInbox(){activeWhatsApp?.close();}
export function openWhatsAppInbox({api,notice,onClose=()=>{}}){
 closeWhatsAppInbox();
 const dialog=document.createElement('dialog');dialog.className='wa-inbox';dialog.setAttribute('aria-label','WhatsApp customer inbox');
 dialog.innerHTML=`<header class="wa-top"><div><strong>WhatsApp inbox</strong><small>Private Cloudflare dataset · 90-day message history · No AI calls</small></div><button type="button" id="wa-close" aria-label="Close WhatsApp inbox">✕</button></header><div class="wa-layout"><aside class="wa-sidebar"><div class="wa-search"><input id="wa-search" aria-label="Search WhatsApp customers" placeholder="Search name or phone prefix"><button type="button" id="wa-refresh">Refresh</button></div><div class="wa-list-status" id="wa-list-status" role="status">Loading customers…</div><div class="wa-contacts" id="wa-contacts"></div><button id="wa-more" type="button" hidden>Load more customers</button></aside><section class="wa-thread"><div class="wa-empty" id="wa-empty"><h2>Your WhatsApp conversations</h2><p>Select a customer to read their messages and reply personally.</p><p>New messages are saved here. Earlier available records are imported; deleted history cannot be recovered.</p></div><section id="wa-open-chat" hidden><header class="wa-contact-head"><button type="button" id="wa-back">← Customers</button><div><strong id="wa-customer"></strong><small id="wa-phone"></small></div><button type="button" id="wa-export">Export chat CSV</button><button type="button" id="wa-delete">Delete history</button></header><p class="wa-window" id="wa-window" role="status"></p><button type="button" id="wa-older" hidden>Load earlier messages</button><div class="wa-messages" id="wa-messages" aria-label="WhatsApp message history"></div><form id="wa-compose" class="wa-compose"><label for="wa-text">Your personal WhatsApp reply</label><textarea id="wa-text" rows="3" maxlength="4096" placeholder="Type any message in Hindi or English…" required></textarea><div><small id="wa-send-status" role="status"></small><button type="submit" id="wa-send">Send to WhatsApp ↑</button></div></form></section></section></div>`;
 document.body.append(dialog);dialog.showModal();
 const el=id=>dialog.querySelector('#'+id);
 let phone=null,contacts=[],contactCursor=null,historyCursor=null,messages=[],busy=false,canReply=false,sendAttempt=null,closed=false,listBusy=false,threadBusyPhone=null,searchTimer;
 const drafts=new Map();
 const state={close(){if(closed)return;closed=true;clearInterval(timer);clearTimeout(searchTimer);dialog.close();dialog.remove();if(activeWhatsApp===state)activeWhatsApp=null;onClose();}};
 activeWhatsApp=state;const timer=setInterval(()=>{if(!closed&&!document.hidden){void loadContacts();if(phone)void loadThread();}},10000);
 function saveDraft(){if(phone)drafts.set(phone,el('wa-text').value);}
 function status(text,error=false){el('wa-send-status').textContent=text;el('wa-send-status').classList.toggle('wa-error',error);}
 function contactsView(){
  el('wa-contacts').innerHTML=contacts.map(c=>`<button type="button" class="wa-contact${c.phone===phone?' selected':''}" data-phone="${waEsc(c.phone)}"><span class="wa-avatar">${waEsc((c.name||'W').slice(0,1).toUpperCase())}</span><span><strong>${waEsc(c.name||'+'+c.phone)}</strong><small>+${waEsc(c.phone)} · ${waEsc(c.preview||'Message received')}</small></span>${c.unread?`<b>${Number(c.unread)}</b>`:''}</button>`).join('');
  el('wa-more').hidden=!contactCursor;
 }
 async function loadContacts(more=false){
  if(listBusy||closed)return;const search=el('wa-search').value.trim();listBusy=true;el('wa-refresh').disabled=true;
  try{const data=await api('/api/admin/whatsapp/contacts?search='+encodeURIComponent(search)+(more&&contactCursor?'&cursor='+encodeURIComponent(contactCursor):''));if(closed||search!==el('wa-search').value.trim())return;
   const rows=more?[...contacts,...data.contacts]:data.contacts;contacts=[...new Map(rows.map(c=>[c.phone,c])).values()];contactCursor=data.nextCursor;contactsView();el('wa-list-status').textContent=contacts.length?contacts.length+' customers loaded · Updates every 10 seconds':'No WhatsApp messages received yet.';
  }catch(error){if(!closed)el('wa-list-status').textContent=error.message;}finally{listBusy=false;if(!closed){el('wa-refresh').disabled=false;if(search!==el('wa-search').value.trim())void loadContacts();}}
 }
 function attachment(m){
  if(m.media_id&&/^\d{5,40}$/.test(m.media_id)){
   const url='/api/admin/whatsapp/media/'+m.media_id;
   if(m.type==='image'||m.type==='sticker')return `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" loading="lazy" alt="Customer attachment"></a>`;
   if(m.type==='audio')return `<audio src="${url}" controls preload="none"></audio>`;
   if(m.type==='video')return `<video src="${url}" controls preload="none"></video>`;
   return `<a href="${url}" target="_blank" rel="noopener">Download ${waEsc(m.filename||'attachment')}</a>`;
  }
  if(m.source==='automatic'&&m.type==='video')return '<a href="/intro/download-guide.mp4" target="_blank" rel="noopener">App download guide · Video</a>';
  if(!['text','video'].includes(m.type))return `<span class="wa-type">${waEsc(m.type)} message</span>`;
  return '';
 }
 let rendered='';
 function messagesView(){
  const key=JSON.stringify(messages);if(key===rendered)return;rendered=key;
  const list=el('wa-messages'),nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<100;
  const existing=new Map([...list.querySelectorAll('[data-wa-id]')].map(node=>[node.dataset.waId,node]));
  const wanted=new Set(messages.map(m=>m.id));for(const [id,node]of existing)if(!wanted.has(id))node.remove();
  if(!existing.size)list.textContent='';
  messages.forEach((m,index)=>{
   let node=existing.get(m.id);if(!node){node=document.createElement('article');node.dataset.waId=m.id;node.className='wa-bubble '+(m.direction==='out'?'out':'in');node.innerHTML=`<strong>${m.direction==='in'?'Customer':m.source==='automatic'?'Automatic guide':'You'}</strong>${attachment(m)}${m.body?`<p>${waEsc(m.body)}</p>`:''}${m.type!=='text'&&m.source==='customer'?`<details><summary>Message details</summary><pre>${waEsc(m.details_json)}</pre></details>`:''}<small></small>`;}
   node.lastElementChild.textContent=waDate(m.created_at)+(m.direction==='out'?' · '+(m.delivery_status||m.state):'')+(m.error_code?' · '+m.error_code:'');
   if(list.children[index]!==node)list.insertBefore(node,list.children[index]||null);
  });
  if(nearBottom)list.scrollTop=list.scrollHeight;
 }
 function windowView(data){
  const remaining=data.replyWindowEndsAt-Date.now(),allowed=remaining>0&&!data.contact.opted_out;canReply=allowed;
  el('wa-window').textContent=data.contact.opted_out?'Customer opted out. Wait for them to send START.':remaining>0?'Personal replies available until '+waDate(data.replyWindowEndsAt)+'. Automatic guide is sent only once.':'24-hour reply window closed. Wait for a new customer message or use an approved WhatsApp template.';
  el('wa-window').classList.toggle('wa-closed',!allowed);el('wa-text').disabled=!allowed||busy;el('wa-send').disabled=!allowed||busy;
 }
 async function loadThread(older=false){
  if(!phone||threadBusyPhone===phone||closed)return;const selected=phone;threadBusyPhone=selected;
  try{const data=await api('/api/admin/whatsapp/contacts/'+phone+'/messages'+(older&&historyCursor?'?cursor='+encodeURIComponent(historyCursor):''));if(closed||phone!==selected)return;
   if(older)historyCursor=data.nextCursor;else if(!messages.length)historyCursor=data.nextCursor;
   const all=[...messages,...data.messages];messages=[...new Map(all.map(m=>[m.id,m])).values()].sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id));
   el('wa-customer').textContent=data.contact.name||'WhatsApp customer';el('wa-phone').textContent='+'+phone;
   el('wa-older').hidden=!historyCursor;messagesView();windowView(data);
   const ids=data.messages.filter(m=>m.direction==='in').map(m=>m.id);
   if(data.contact.unread&&ids.length){await api('/api/admin/whatsapp/contacts/'+selected+'/read','POST',{ids});if(closed)return;const c=contacts.find(c=>c.phone===selected);if(c)c.unread=Math.max(0,c.unread-ids.length);contactsView();}
  }catch(error){if(!closed&&phone===selected)status(error.message,true);}finally{if(threadBusyPhone===selected)threadBusyPhone=null;}
 }
 async function select(number){
  if(busy)return;saveDraft();phone=number;canReply=false;el('wa-text').disabled=true;el('wa-send').disabled=true;el('wa-window').textContent='Checking customer reply window…';el('wa-customer').textContent=contacts.find(c=>c.phone===number)?.name||'WhatsApp customer';el('wa-phone').textContent='+'+number;sendAttempt=null;messages=[];historyCursor=null;rendered='';el('wa-messages').innerHTML='Loading messages…';
  el('wa-empty').hidden=true;el('wa-open-chat').hidden=false;dialog.classList.add('wa-chat-open');el('wa-text').value=drafts.get(phone)||'';status('');contactsView();await loadThread();
 }
 el('wa-close').onclick=()=>state.close();dialog.addEventListener('cancel',event=>{event.preventDefault();state.close();});
 el('wa-refresh').onclick=()=>{void loadContacts();if(phone)void loadThread();};el('wa-more').onclick=()=>loadContacts(true);
 el('wa-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{contactCursor=null;void loadContacts();},300);};
 el('wa-contacts').onclick=event=>{const button=event.target.closest('[data-phone]');if(button)void select(button.dataset.phone);};
 el('wa-back').onclick=()=>{if(busy)return;saveDraft();dialog.classList.remove('wa-chat-open');};el('wa-older').onclick=()=>loadThread(true);
 el('wa-text').oninput=()=>{saveDraft();if(sendAttempt&&sendAttempt.text!==el('wa-text').value.trim())sendAttempt=null;};
 el('wa-compose').onsubmit=async event=>{
  event.preventDefault();if(busy||!phone||!canReply)return;const text=el('wa-text').value.trim();if(!text)return;
  busy=true;el('wa-send').disabled=true;el('wa-text').disabled=true;status('Sending your personal reply…');
  const selected=phone;sendAttempt??={text,clientId:crypto.randomUUID()};
  try{const data=await api('/api/admin/whatsapp/contacts/'+phone+'/send','POST',sendAttempt);if(closed)return;
   messages=[...new Map([...messages,data.message].map(m=>[m.id,m])).values()];messagesView();
   if(data.message.state==='accepted'){el('wa-text').value='';drafts.delete(selected);sendAttempt=null;status('Accepted by WhatsApp. Delivery status updates here.');}
   else status(data.message.state==='unknown'?'Send outcome is uncertain. This attempt will not be sent twice.':'Message status: '+data.message.state+(data.message.error_code?' · '+data.message.error_code:''),true);
  }catch(error){if(!closed)status(error.message+' Your text is kept here; retry uses the same send identifier.',true);}
  finally{busy=false;if(!closed){el('wa-text').disabled=!canReply;el('wa-send').disabled=!canReply;await loadThread();}}
 };
 el('wa-export').onclick=async()=>{
  if(!phone)return;const selected=phone;el('wa-export').disabled=true;
  try{let page=null,rows=[];do{const data=await api('/api/admin/whatsapp/contacts/'+selected+'/messages'+(page?'?cursor='+encodeURIComponent(page):''));rows.push(...data.messages);page=data.nextCursor;}while(page&&!closed);
   if(closed)return;rows.sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id));
   const csv='\uFEFF'+['time,phone,direction,type,message,status,media_id,details',...rows.map(m=>[new Date(m.created_at).toISOString(),selected,m.direction,m.type,m.body,m.delivery_status||m.state,m.media_id,m.details_json].map(waCsvCell).join(','))].join('\r\n');
   const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='WhatsApp-'+selected+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);status('Private chat export downloaded.');
  }catch(error){if(!closed)status(error.message,true);}finally{if(!closed)el('wa-export').disabled=false;}
 };
 el('wa-delete').onclick=async()=>{if(!phone||busy||!confirm('Permanently delete saved message history for this customer? The once-only automation record and opt-out choice will be kept.'))return;try{await api('/api/admin/whatsapp/contacts/'+phone+'/delete','POST',{});messages=[];historyCursor=null;rendered='';await loadThread();}catch(error){status(error.message,true);}};
 void loadContacts();return state;
}
