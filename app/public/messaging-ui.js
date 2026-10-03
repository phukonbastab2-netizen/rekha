import { messageBody, mediaItems, attachmentUrl } from './media.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reactions=['👍','❤️','😂','😮','😢','🙏'];
const emojis=['😀','😊','🙏','❤️','👍','✨','🌸','😂','🥰','🤔','😢','🙌','🌞','🌙','💐','💚','🤝','🎉','😮','👌','🙂','💫','🪔','🔮'];
const ACCEPT='image/jpeg,image/png,image/webp,video/mp4,video/webm,audio/webm,audio/ogg,audio/mpeg,audio/mp4,audio/wav,application/pdf';
const MAX_SIZE=20*1024*1024;
export function messageSummary(message){
  if(!message)return 'Message unavailable';
  if(message.deleted)return 'This message was deleted';
  if(message.kind==='media'){try{const data=JSON.parse(message.body);return data.text||mediaItems(message).map(item=>item.title||item.type).join(', ')||'Attachment';}catch{return 'Attachment';}}
  return message.body||'';
}
export function messageExtras(message,chat,astrologerName='Rekha Astrology'){
  const parent=message.replyTo?chat.messages.find(item=>Number(item.id)===Number(message.replyTo)):null;
  const reply=message.replyTo&&!message.deleted?`<button type="button" class="quoted-message" data-jump-message="${Number(message.replyTo)}"><strong>${parent?.role==='user'?'You':esc(astrologerName)}</strong><span>${esc(messageSummary(parent).slice(0,160))}</span></button>`:'';
  const grouped=new Map();for(const reaction of message.deleted?[]:message.reactions||[]){if(reactions.includes(reaction.emoji))grouped.set(reaction.emoji,(grouped.get(reaction.emoji)||0)+1);}
  const reactionHtml=grouped.size?`<div class="message-reactions">${[...grouped].map(([emoji,count])=>`<button type="button" data-reaction-message="${Number(message.id)}" data-emoji="${esc(emoji)}" aria-label="React ${esc(emoji)}">${emoji}${count>1?` <small>${count}</small>`:''}</button>`).join('')}</div>`:'';
  return {reply,reactionHtml,actions:`<button type="button" class="message-actions" data-message-actions="${Number(message.id)}" aria-label="Message options" title="Message options">⌄</button>`,metadata:`${message.starred?'<span class="star-marker" title="Starred message" aria-label="Starred">★</span>':''}${message.edited&&!message.deleted?'<span class="edited-label">edited</span>':''}`,receipt:message.role==='user'?`<span class="sent-check ${message.readByOther?'read':''}" title="${message.readByOther?'Read by Rekha':'Sent to server'}" aria-label="${message.readByOther?'Read by Rekha':'Sent to server'}">${message.readByOther?'✓✓':'✓'}</span>`:''};
}
export function createMessagingUI({app,api,getChat,setChat,toast,getLang,privacy,introduction,isBusy=()=>false,getAppSettings=()=>null}){
  let replyTo=null,editing=null,attachments=[],uploading=false,recorder=null,stream=null,recordTimer=null,recordStarted=0,recordChunks=[],discardRecording=false,lastTyping=0,typingTimer=null,readId=0,destroyed=false;
  const localDialogs=new Set();
  const input=()=>app.querySelector('#message-input');
  const composer=()=>app.querySelector('#composer');
  const find=id=>getChat()?.messages.find(item=>Number(item.id)===Number(id));
  const own=message=>message?.role==='user';
  const textMessage=message=>message?.kind!=='media'&&!message?.deleted;
  const features=()=>getAppSettings()?.chat||{};
  const paused=()=>features().customerMessagingEnabled===false;
  const astrologer=()=>getAppSettings()?.brand?.astrologerName||'Rekha Astrology';
  function showDialog(title,html){
    const modal=document.createElement('dialog');modal.className='messaging-dialog';modal.setAttribute('aria-label',title);modal.innerHTML=`<div class="messaging-dialog-head"><h2>${esc(title)}</h2><button type="button" data-close aria-label="Close">×</button></div>${html}`;
    document.body.append(modal);localDialogs.add(modal);modal.querySelector('[data-close]').onclick=()=>modal.close();modal.addEventListener('close',()=>{localDialogs.delete(modal);modal.remove();});modal.addEventListener('click',event=>{if(event.target===modal)modal.close();});modal.showModal();return modal;
  }
  function jump(id){const node=app.querySelector(`[data-message="${Number(id)}"]`);if(!node)return toast('That message is no longer available.');node.scrollIntoView({behavior:'smooth',block:'center'});node.classList.add('message-highlight');setTimeout(()=>node.classList.remove('message-highlight'),2200);}
  async function mutation(route,method,body){try{const response=await api(route,method,body);if(destroyed)return;if(Array.isArray(response.messages))setChat(response);else setChat(await api('/api/chat'));}catch(error){toast(error.message);}}
  function renderDraft(){
    const draft=app.querySelector('#compose-draft');if(!draft)return;
    const referenced=find(editing||replyTo);
    draft.innerHTML=`${referenced?`<div class="draft-quote"><div><strong>${editing?'Edit message':own(referenced)?'Reply to yourself':'Reply to Rekha Astrology'}</strong><span>${esc(messageSummary(referenced).slice(0,120))}</span></div><button type="button" id="cancel-context" aria-label="Cancel ${editing?'edit':'reply'}">×</button></div>`:''}${attachments.length?`<div class="attachment-drafts">${attachments.map((attachment,index)=>`<div class="attachment-draft">${attachment.file.type.startsWith('image/')?`<img src="${attachment.preview}" alt="">`:attachment.file.type.startsWith('audio/')?`<audio controls preload="metadata" src="${attachment.preview}"></audio>`:attachment.file.type.startsWith('video/')?`<video controls playsinline preload="metadata" src="${attachment.preview}"></video>`:'<span class="draft-file-icon" aria-hidden="true">▤</span>'}<span>${esc(attachment.file.name)}<small>${(attachment.file.size/1048576).toFixed(1)} MB</small></span><button type="button" data-remove-draft="${index}" aria-label="Remove ${esc(attachment.file.name)}">×</button></div>`).join('')}</div>`:''}${recorder?`<div class="recording-bar"><span class="record-dot"></span><strong>Recording voice note</strong><span id="record-time">0:00</span><button type="button" id="cancel-record">Cancel</button><button type="button" id="stop-record">Stop</button></div>`:''}`;
    const cancel=draft.querySelector('#cancel-context');if(cancel)cancel.onclick=()=>{if(isBusy())return;replyTo=null;if(editing){editing=null;input().value='';}input().disabled=Boolean(getChat()?.locked||getChat()?.blocked);app.querySelector('.send').disabled=input().disabled;renderDraft();updateSend();};
    for(const button of draft.querySelectorAll('[data-remove-draft]'))button.onclick=()=>{if(uploading)return;const [removed]=attachments.splice(Number(button.dataset.removeDraft),1);URL.revokeObjectURL(removed.preview);renderDraft();updateSend();};
    const cancelRecord=draft.querySelector('#cancel-record');if(cancelRecord)cancelRecord.onclick=()=>stopRecording(true);
    const stopRecord=draft.querySelector('#stop-record');if(stopRecord)stopRecord.onclick=()=>stopRecording(false);
    updateSend();
  }
  function updateSend(){const send=app.querySelector('.send'),mic=app.querySelector('#record-voice'),attach=app.querySelector('#attach-file');if(!send)return;const unavailable=getChat()?.locked||getChat()?.blocked||paused();send.classList.toggle('has-draft',Boolean(input()?.value.trim()||attachments.length||editing));send.title=editing?'Save edited message':'Send message';if(mic){mic.hidden=features().voiceNotesEnabled===false||features().attachmentsEnabled===false;mic.disabled=Boolean(unavailable||uploading||editing||mic.hidden);mic.setAttribute('aria-pressed',String(Boolean(recorder)));}if(attach)attach.hidden=features().attachmentsEnabled===false;for(const button of app.querySelectorAll('.compose-tool'))if(button.id!=='record-voice')button.disabled=Boolean(unavailable||uploading||recorder);if(paused()){input().disabled=true;send.disabled=true;}for(const button of app.querySelectorAll('[data-remove-draft],#cancel-context'))button.disabled=uploading;}
  function addFiles(files){
    if(paused()||features().attachmentsEnabled===false)return toast('Attachments are currently paused. Your existing draft is kept.');
    if(features().voiceNotesEnabled===false&&[...files].some(file=>file.type.startsWith('audio/')))return toast('Audio uploads are currently paused.');
    if(editing)return toast('Finish editing your message before attaching a file.');
    for(const file of files){if(attachments.length>=10){toast('You can attach up to 10 files per message.');break;}if(!ACCEPT.split(',').includes(file.type)){toast('Choose a JPEG, PNG, WebP, MP4, WebM, audio file or PDF.');continue;}if(file.size>MAX_SIZE){toast(`${file.name} is larger than the 20 MB limit.`);continue;}if(!file.size){toast('The selected file is empty.');continue;}attachments.push({file,preview:URL.createObjectURL(file),uploaded:null});}
    renderDraft();input()?.focus();
  }
  function attachmentMenu(picker){
    if(getChat()?.locked||getChat()?.blocked||paused()||features().attachmentsEnabled===false||uploading||isBusy())return;
    const modal=showDialog('Attach',`<div class="message-option-list"><button type="button" data-attach="files">▧ Photos, videos, audio or PDF</button><button type="button" data-attach="camera">Camera photo</button></div>`);
    modal.querySelector('[data-attach="files"]').onclick=()=>{modal.close();picker.click();};
    modal.querySelector('[data-attach="camera"]').onclick=()=>{modal.close();capturePhoto();};
  }
  async function capturePhoto(){
    if(destroyed||getChat()?.locked||getChat()?.blocked||paused()||features().attachmentsEnabled===false||uploading||isBusy())return;
    if(editing)return toast('Finish editing your message before taking a photo.');
    if(attachments.length>=10)return toast('You can attach up to 10 files per message.');
    if(!navigator.mediaDevices?.getUserMedia)return toast('Camera capture is unavailable here. You can attach a photo from your files.');
    const modal=showDialog('Camera photo','<div class="camera-capture"><video class="camera-preview" autoplay playsinline muted></video><p class="camera-status" role="status">Opening your camera…</p><div class="camera-buttons"><button type="button" class="camera-cancel">Cancel</button><button type="button" class="camera-take" disabled>Take photo</button></div></div>');
    const video=modal.querySelector('video'),button=modal.querySelector('.camera-take'),note=modal.querySelector('.camera-status');
    let camera=null,closed=false,capturing=false;
    const release=()=>{closed=true;video.onloadeddata=null;video.pause();video.srcObject=null;for(const track of camera?.getTracks()||[])track.stop();camera=null;};
    modal.addEventListener('close',release,{once:true});modal.querySelector('.camera-cancel').onclick=()=>modal.close();
    const ready=()=>{if(closed||destroyed)return;if(video.videoWidth&&video.videoHeight&&video.readyState>=2){button.disabled=false;note.textContent='Take a photo, then review it before sending.';}};
    button.onclick=()=>{
      if(closed||destroyed||!modal.open||capturing||!video.videoWidth||!video.videoHeight)return;
      capturing=true;button.disabled=true;
      const canvas=document.createElement('canvas'),scale=Math.min(1,1600/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
      try{canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);canvas.toBlob(blob=>{if(closed||destroyed||!modal.open)return;if(!blob){capturing=false;button.disabled=false;note.textContent='The photo could not be captured. Please try again.';return;}const file=new File([blob],`Camera photo ${new Date().toISOString().replace(/[:.]/g,'-')}.jpg`,{type:'image/jpeg'});release();modal.close();addFiles([file]);},'image/jpeg',.9);}catch{capturing=false;button.disabled=false;note.textContent='The photo could not be captured. Please try again.';}
    };
    try{
      const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:960}}});
      if(closed||destroyed||paused()||features().attachmentsEnabled===false||!modal.isConnected||!modal.open){for(const track of acquired.getTracks())track.stop();modal.close();return;}
      camera=acquired;video.srcObject=camera;video.onloadeddata=ready;await video.play().catch(()=>{});ready();
    }catch(error){release();if(!modal.isConnected)return;note.textContent=error.name==='NotAllowedError'?'Camera permission was declined. You can attach a photo from your files.':error.name==='NotFoundError'?'No camera was found. You can attach a photo from your files.':'The camera could not be opened. Please try again or attach a photo from your files.';button.disabled=true;}
  }
  function emojiPicker(){const modal=showDialog('Emoji',`<div class="emoji-grid">${emojis.map(emoji=>`<button type="button" data-insert-emoji="${esc(emoji)}" aria-label="${esc(emoji)}">${emoji}</button>`).join('')}</div>`);for(const button of modal.querySelectorAll('[data-insert-emoji]'))button.onclick=()=>{const field=input();if(!field||field.disabled)return;const start=field.selectionStart,end=field.selectionEnd,text=button.dataset.insertEmoji;if(field.value.length-end+start+text.length>2000)return;field.setRangeText(text,start,end,'end');field.dispatchEvent(new Event('input',{bubbles:true}));modal.close();field.focus();};}
  function recordingSupported(){return Boolean(navigator.mediaDevices?.getUserMedia&&window.MediaRecorder);}
  async function recordVoice(){
    if(paused()||features().voiceNotesEnabled===false||features().attachmentsEnabled===false)return;
    if(recorder)return stopRecording(false);
    if(!recordingSupported())return toast('Voice recording is unavailable here. You can attach an audio file instead.');
    if(getChat()?.locked||editing||uploading)return;
    const button=app.querySelector('#record-voice');button.disabled=true;
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:true});
      if(destroyed||paused()||features().voiceNotesEnabled===false||features().attachmentsEnabled===false){stream.getTracks().forEach(track=>track.stop());stream=null;return;}
      const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(value=>MediaRecorder.isTypeSupported(value));
      recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);recordChunks=[];discardRecording=false;recordStarted=Date.now();
      recorder.ondataavailable=event=>{if(event.data.size)recordChunks.push(event.data);};
      recorder.onerror=()=>{discardRecording=true;toast('Recording failed. Please try again.');stopRecording(true);};
      recorder.onstop=()=>{
        const type=(recorder?.mimeType||mime||'audio/webm').split(';')[0],chunks=recordChunks;
        const shouldDiscard=discardRecording;recorder=null;recordChunks=[];clearInterval(recordTimer);stream?.getTracks().forEach(track=>track.stop());stream=null;
        if(!shouldDiscard&&!destroyed){const extension=type==='audio/ogg'?'ogg':type==='audio/mp4'?'m4a':'webm';addFiles([new File(chunks,`Voice note ${new Date().toISOString().replace(/[:.]/g,'-')}.${extension}`,{type})]);}else renderDraft();
      };
      recorder.start(1000);renderDraft();
      recordTimer=setInterval(()=>{const elapsed=Math.floor((Date.now()-recordStarted)/1000),time=app.querySelector('#record-time');if(time)time.textContent=`${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,'0')}`;if(elapsed>=180||recordChunks.reduce((total,chunk)=>total+chunk.size,0)>=MAX_SIZE-1048576)stopRecording(false);},500);
    }catch(error){stream?.getTracks().forEach(track=>track.stop());stream=null;toast(error.name==='NotAllowedError'?'Microphone permission was declined. You can attach an audio file instead.':'The microphone could not be opened. Please try again.');}
    finally{if(button.isConnected)updateSend();}
  }
  function stopRecording(discard){if(!recorder)return;discardRecording=discard;clearInterval(recordTimer);if(recorder.state!=='inactive')recorder.stop();stream?.getTracks().forEach(track=>track.stop());}
  function messageOptions(id){
    const message=find(id);if(!message||message.role==='system')return;
    const age=Date.now()-new Date(message.created).getTime(),canEdit=own(message)&&textMessage(message)&&age>=0&&age<=15*60*1000,canDelete=own(message)&&!message.deleted&&age>=0&&age<=24*60*60*1000;
    const modal=showDialog('Message options',`<p class="options-excerpt">${esc(messageSummary(message).slice(0,180))}</p>${!message.deleted?`<div class="reaction-picker">${reactions.map(emoji=>`<button type="button" data-react="${esc(emoji)}" class="${(message.reactions||[]).some(item=>item.by==='customer'&&item.emoji===emoji)?'selected':''}" aria-label="React ${esc(emoji)}">${emoji}</button>`).join('')}</div>`:''}<div class="message-option-list">${!message.deleted?'<button type="button" data-action="reply">↩ Reply</button>':''}<button type="button" data-action="star">${message.starred?'★ Unstar':'☆ Star'} message</button>${!message.deleted?'<button type="button" data-action="copy">▣ Copy text</button>':''}${canEdit?'<button type="button" data-action="edit">✎ Edit message</button>':''}${canDelete?'<button type="button" class="danger" data-action="delete">Delete for everyone</button>':''}</div>`);
    for(const button of modal.querySelectorAll('[data-react]'))button.onclick=()=>{const current=(message.reactions||[]).some(item=>item.by==='customer'&&item.emoji===button.dataset.react);modal.close();mutation(`/api/messages/${id}/reaction`,'PUT',{emoji:current?'':button.dataset.react});};
    for(const button of modal.querySelectorAll('[data-action]'))button.onclick=async()=>{
      const action=button.dataset.action;modal.close();if(['reply','edit','delete'].includes(action)&&isBusy())return toast('Please wait for your message to finish sending.');
      if(action==='reply'){if(paused())return toast('Customer messages are currently paused.');if(getChat()?.locked)return toast('Unlock your conversation to reply.');editing=null;replyTo=id;renderDraft();input().focus();}
      if(action==='edit'){if(paused()||getChat()?.blocked)return toast('Messages are currently paused.');if(attachments.length)return toast('Send or remove your attachment draft before editing a message.');replyTo=null;editing=id;input().disabled=false;app.querySelector('.send').disabled=false;input().value=message.body;input().dispatchEvent(new Event('input',{bubbles:true}));renderDraft();input().focus();}
      if(action==='star')mutation(`/api/messages/${id}/star`,'PUT',{starred:!message.starred});
      if(action==='copy'){try{await navigator.clipboard.writeText(messageSummary(message));toast('Message copied.');}catch{const copyModal=showDialog('Copy message',`<textarea class="copy-text" readonly>${esc(messageSummary(message))}</textarea><p>Select the text to copy it.</p>`);copyModal.querySelector('textarea').select();}}
      if(action==='delete'){const confirm=showDialog('Delete message?',`<p>This message will be replaced with a deleted-message notice for both sides.</p><button type="button" class="confirm-delete-message danger">Delete for everyone</button>`);confirm.querySelector('.confirm-delete-message').onclick=()=>{confirm.close();mutation(`/api/messages/${id}`,'DELETE',{});};}
    };
  }
  function listMessages(mode){
    const title=mode==='starred'?'Starred messages':mode==='media'?'Shared media':'Search conversation';
    const modal=showDialog(title,`${mode==='search'?'<label class="search-chat-label">Find a message<input id="search-chat" type="search" placeholder="Search messages…" autocomplete="off"></label>':''}<div class="message-results"></div>`),results=modal.querySelector('.message-results');
    const render=(query='')=>{
      const messages=(getChat()?.messages||[]).filter(message=>message.role!=='system'&&(mode==='starred'?message.starred:mode==='media'?message.kind==='media'&&!message.deleted:!message.deleted&&messageSummary(message).toLocaleLowerCase().includes(query.toLocaleLowerCase())));
      results.innerHTML=messages.length?messages.map(message=>`<button type="button" class="message-result" data-result-id="${Number(message.id)}"><strong>${own(message)?'You':'Rekha Astrology'}<time>${esc(new Date(message.created).toLocaleDateString())}</time></strong><span>${esc(messageSummary(message).slice(0,180))}</span></button>`).join(''):`<p class="empty-results">${mode==='starred'?'Star a message from its options to find it here.':mode==='media'?'Shared photos, videos, voice notes and documents will appear here.':'No matching messages.'}</p>`;
      for(const button of results.querySelectorAll('[data-result-id]'))button.onclick=()=>{modal.close();jump(button.dataset.resultId);};
    };
    render();const field=modal.querySelector('#search-chat');if(field){field.oninput=()=>render(field.value);field.focus();}
  }
  function exportChat(){
    const lines=[`${getAppSettings()?.brand?.name||'Rekha Astrology'} — private conversation`,`Exported ${new Date().toLocaleString()}`,''];
    for(const message of getChat()?.messages||[]){lines.push(`[${new Date(message.created).toLocaleString()}] ${message.role==='user'?'You':message.role==='system'?'Note':astrologer()}: ${messageSummary(message)}${message.edited?' (edited)':''}`);if(message.kind==='media'&&!message.deleted)for(const item of mediaItems(message))lines.push(`  Attachment: ${item.title||item.type}`);}
    const text=lines.join('\n');
    if(typeof window.RekhaDevice?.saveChatExport==='function'){try{window.RekhaDevice.saveChatExport(text);toast('Choose where to save your chat export.');return;}catch(error){toast('The export could not be opened. Please try again.');return;}}
    const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=`Rekha-Astrology-Chat-${new Date().toISOString().slice(0,10)}.txt`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);toast('Your chat export is ready. Attachments remain in the chat.');
  }
  function openMenu(){
    const modal=showDialog('Conversation',`<div class="message-option-list"><button type="button" data-menu="search">⌕ Search conversation</button><button type="button" data-menu="starred">☆ Starred messages</button><button type="button" data-menu="media">▧ Shared media</button><button type="button" data-menu="export">↓ Export chat</button>${typeof window.RekhaDevice?.showAlertSettings==='function'?'<button type="button" data-menu="alerts">Message alerts</button>':''}<button type="button" data-menu="intro">▷ Watch introduction</button><button type="button" data-menu="privacy">Privacy and conversation settings</button></div>`);
    for(const button of modal.querySelectorAll('[data-menu]'))button.onclick=()=>{const choice=button.dataset.menu;modal.close();if(['intro','privacy'].includes(choice)&&isBusy())return toast('Please wait for your message to finish sending.');if(['search','starred','media'].includes(choice))listMessages(choice);if(choice==='export')exportChat();if(choice==='alerts'){try{window.RekhaDevice.showAlertSettings();}catch{toast('Alert settings could not be opened.');}}if(choice==='intro')introduction();if(choice==='privacy')privacy(true);};
  }
  function typing(active){if(destroyed)return;api('/api/chat/typing','POST',{active}).catch(()=>{});}
  function inputChanged(){updateSend();clearTimeout(typingTimer);const active=Boolean(input()?.value.trim())&&!editing;if(active&&Date.now()-lastTyping>3500){lastTyping=Date.now();typing(true);}typingTimer=setTimeout(()=>typing(false),2500);}
  function markRead(){
    if(destroyed||document.hidden)return;const messages=getChat()?.messages||[],latest=messages.filter(message=>message.role==='assistant'&&!message.readByOther).at(-1);if(!latest||Number(latest.id)<=readId)return;
    const node=app.querySelector(`[data-message="${Number(latest.id)}"]`),scroller=app.querySelector('#chat-scroll');if(!node||!scroller)return;const rect=node.getBoundingClientRect(),visible=scroller.getBoundingClientRect();if(rect.bottom<visible.top||rect.top>visible.bottom)return;
    readId=Number(latest.id);api('/api/chat/read','POST',{lastId:readId}).catch(()=>{readId=0;});
  }
  function mount(){
    const row=app.querySelector('.compose-row'),draft=document.createElement('div');draft.id='compose-draft';composer().prepend(draft);
    const tools=document.createElement('div');tools.className='compose-tools';tools.innerHTML='<button type="button" class="compose-tool" id="emoji-picker" aria-label="Add emoji" title="Emoji">☺</button><button type="button" class="compose-tool" id="attach-file" aria-label="Attach file or take a camera photo" title="Attachments"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg></button><button type="button" class="compose-tool" id="record-voice" aria-label="Record voice note" title="Record voice note" aria-pressed="false"><svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12z"/></svg></button>';
    row.prepend(tools);const picker=document.createElement('input');picker.type='file';picker.accept=ACCEPT;picker.multiple=true;picker.hidden=true;picker.id='attachment-picker';composer().append(picker);
    picker.onchange=()=>{addFiles([...picker.files]);picker.value='';};app.querySelector('#attach-file').onclick=()=>attachmentMenu(picker);app.querySelector('#emoji-picker').onclick=emojiPicker;app.querySelector('#record-voice').onclick=recordVoice;
    input().addEventListener('input',inputChanged);input().addEventListener('paste',event=>{const files=[...event.clipboardData?.files||[]];if(files.length){event.preventDefault();addFiles(files);}});
    const headerButton=app.querySelector('#chat-privacy');headerButton.setAttribute('aria-label','Conversation menu');headerButton.title='Conversation menu';headerButton.onclick=openMenu;
    app.querySelector('#messages').addEventListener('click',event=>{
      const options=event.target.closest('[data-message-actions]');if(options)return messageOptions(Number(options.dataset.messageActions));
      const quote=event.target.closest('[data-jump-message]');if(quote)return jump(quote.dataset.jumpMessage);
      const reaction=event.target.closest('[data-reaction-message]');if(reaction)return messageOptions(Number(reaction.dataset.reactionMessage));
      const image=event.target.closest('[data-media-url]');if(image&&attachmentUrl(image.dataset.mediaUrl)){const modal=showDialog(image.dataset.mediaTitle||'Shared image',`<img class="full-image" src="${image.dataset.mediaUrl}" alt="${esc(image.dataset.mediaTitle)}"><a class="save-image" href="${image.dataset.mediaUrl}" download>Download image</a>`);}
    });
    app.querySelector('#chat-scroll').addEventListener('scroll',markRead,{passive:true});renderDraft();
  }
  async function preparePayload(body,clientId){
    if(paused())throw new Error('Customer messages are currently paused. Your draft is kept.');
    if(attachments.length&&features().attachmentsEnabled===false)throw new Error('Attachments are currently paused. Remove them to send only text.');
    if(features().voiceNotesEnabled===false&&attachments.some(item=>item.file.type.startsWith('audio/')))throw new Error('Audio uploads are currently paused. Remove them to send other content.');
    if(recorder)throw new Error('Stop your voice recording before sending.');
    if(editing){if(!body.trim())throw new Error('An edited message cannot be empty.');return {editId:editing,body};}
    if(!body.trim()&&!attachments.length)return null;
    uploading=true;updateSend();
    try{
      for(const attachment of attachments)if(!attachment.uploaded){
        const response=await fetch('/api/uploads?name='+encodeURIComponent(attachment.file.name),{method:'POST',credentials:'same-origin',headers:{'Content-Type':attachment.file.type},body:attachment.file,signal:AbortSignal.timeout(120000)});
        let data;try{data=await response.json();}catch{throw new Error('The attachment upload could not be completed.');}if(!response.ok)throw Object.assign(new Error(data.error||'Attachment upload failed.'),{status:response.status});attachment.uploaded=data;
      }
      return {body,clientId,...(replyTo?{replyTo}:{}),...(attachments.length?{mediaIds:attachments.map(item=>item.uploaded.id)}:{})};
    }finally{uploading=false;updateSend();}
  }
  function sent(){replyTo=null;editing=null;for(const item of attachments)URL.revokeObjectURL(item.preview);attachments=[];typing(false);renderDraft();}
  function refresh(){if(destroyed)return;if(recorder&&(paused()||features().voiceNotesEnabled===false||features().attachmentsEnabled===false))stopRecording(true);updateSend();const caption=app.querySelector('.chat-caption');if(caption)caption.textContent=getChat()?.typing?.owner?'typing…':getAppSettings()?.copy?.[getLang()]?.tagline||getAppSettings()?.brand?.tagline||(getLang()==='hi'?'आपकी निजी बातचीत':'Your personal conversation');const picker=app.querySelector('#attachment-picker');if(picker)picker.accept=features().voiceNotesEnabled===false?ACCEPT.split(',').filter(type=>!type.startsWith('audio/')).join(','):ACCEPT;markRead();}
  function destroy(){destroyed=true;discardRecording=true;stopRecording(true);clearTimeout(typingTimer);clearInterval(recordTimer);for(const item of attachments)URL.revokeObjectURL(item.preview);for(const modal of localDialogs)modal.close();stream?.getTracks().forEach(track=>track.stop());}
  mount();return {preparePayload,sent,refresh,destroy,openMenu,isEditing:()=>Boolean(editing),hasContent:()=>Boolean(input()?.value.trim()||attachments.length||editing),draftSignature:()=>JSON.stringify({replyTo,editing,files:attachments.map(item=>[item.file.name,item.file.size,item.file.lastModified])})};
}
