import { messageBody, mediaItems, attachmentUrl } from './media.js';
import { getFeatureMedia, openFeatureAccess } from './permissions.js';
import { chatIcon } from './chat-icons.js';
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
  const receiptLabel=message.readByOther?`Read by ${astrologerName}`:`Received by ${astrologerName}'s chat`;
  return {reply,reactionHtml,actions:`<button type="button" class="message-actions" data-message-actions="${Number(message.id)}" aria-label="Message options" title="Message options">${chatIcon('more',16)}</button>`,metadata:`${message.starred?'<span class="star-marker" title="Starred message" aria-label="Starred">★</span>':''}${message.edited&&!message.deleted?'<span class="edited-label">edited</span>':''}`,receipt:message.role==='user'?`<span class="sent-check delivered ${message.readByOther?'read':''}" title="${esc(receiptLabel)}" aria-label="${esc(receiptLabel)}">${chatIcon('checks',16)}</span>`:''};
}
export function createMessagingUI({app,api,getChat,setChat,toast,getLang,privacy,introduction,isBusy=()=>false,getAppSettings=()=>null,sounds=null}){
  let replyTo=null,editing=null,editBackup=null,attachments=[],uploading=false,capturePending=false,voiceCaptureController=null,recorder=null,stream=null,recordTimer=null,recordStarted=0,recordChunks=[],discardRecording=false,lastTyping=0,typingTimer=null,readId=0,destroyed=false,legacySnapshot=null;
  const snapshots=new Set();
  const cameraReleases=new Map();
  const localDialogs=new Set();
  let pressTimer=null,press=null,lastLongPress=0,lastLongPressId=null;
  const input=()=>app.querySelector('#message-input');
  const composer=()=>app.querySelector('#composer');
  const find=id=>getChat()?.messages.find(item=>Number(item.id)===Number(id));
  const own=message=>message?.role==='user';
  const textMessage=message=>message?.kind!=='media'&&!message?.deleted;
  const features=()=>getAppSettings()?.chat||{};
  const paused=()=>features().customerMessagingEnabled===false;
  const astrologer=()=>getAppSettings()?.brand?.astrologerName||'Rekha Astrology';
  function showDialog(title,html,style=''){
    const modal=document.createElement('dialog');modal.className='messaging-dialog'+(style?' '+style:'');modal.setAttribute('aria-label',title);modal.innerHTML=`<div class="messaging-dialog-head"><h2>${esc(title)}</h2><button type="button" data-close aria-label="Close">${chatIcon('close',22)}</button></div>${html}`;
    document.body.append(modal);localDialogs.add(modal);modal.querySelector('[data-close]').onclick=()=>modal.close();modal.addEventListener('close',()=>{localDialogs.delete(modal);modal.remove();});modal.addEventListener('click',event=>{if(event.target===modal)modal.close();});modal.showModal();return modal;
  }
  function jump(id){const node=app.querySelector(`[data-message="${Number(id)}"]`);if(!node)return toast('That message is no longer available.');node.scrollIntoView({behavior:'smooth',block:'center'});node.classList.add('message-highlight');setTimeout(()=>node.classList.remove('message-highlight'),2200);}
  async function mutation(route,method,body){try{const response=await api(route,method,body);if(destroyed)return;if(Array.isArray(response.messages))setChat(response);else setChat(await api('/api/chat'));}catch(error){toast(error.message);}}
  function renderDraft(){
    const draft=app.querySelector('#compose-draft');if(!draft)return;
    const referenced=find(editing||replyTo);
    draft.innerHTML=`${referenced?`<div class="draft-quote"><div><strong>${editing?'Edit message':own(referenced)?'Reply to yourself':`Reply to ${esc(astrologer())}`}</strong><span>${esc(messageSummary(referenced).slice(0,120))}</span></div><button type="button" id="cancel-context" aria-label="Cancel ${editing?'edit':'reply'}">×</button></div>`:''}${attachments.length?`<div class="attachment-drafts">${attachments.map((attachment,index)=>`<div class="attachment-draft">${attachment.file.type.startsWith('image/')?`<img src="${attachment.preview}" alt="">`:attachment.file.type.startsWith('audio/')?`<audio controls preload="metadata" src="${attachment.preview}"></audio>`:attachment.file.type.startsWith('video/')?`<video controls playsinline preload="metadata" src="${attachment.preview}"></video>`:'<span class="draft-file-icon" aria-hidden="true">▤</span>'}<span>${esc(attachment.file.name)}<small>${(attachment.file.size/1048576).toFixed(1)} MB</small></span><button type="button" data-remove-draft="${index}" aria-label="Remove ${esc(attachment.file.name)}">×</button></div>`).join('')}</div>`:''}${recorder?`<div class="recording-bar"><span class="record-dot"></span><strong>Recording voice note</strong><span id="record-time">0:00</span><button type="button" id="cancel-record">Cancel</button><button type="button" id="stop-record">Stop</button></div>`:capturePending?'<div class="recording-bar"><strong role="status">Opening microphone…</strong><button type="button" id="cancel-capture">Cancel</button></div>':''}`;
    const cancel=draft.querySelector('#cancel-context');if(cancel)cancel.onclick=()=>{if(uploading)return;replyTo=null;if(editing){editing=null;input().value=editBackup?.body||'';replyTo=editBackup?.replyTo||null;editBackup=null;input().dispatchEvent(new Event('input',{bubbles:true}));}renderDraft();updateSend();};
    for(const button of draft.querySelectorAll('[data-remove-draft]'))button.onclick=()=>{if(uploading)return;const [removed]=attachments.splice(Number(button.dataset.removeDraft),1);URL.revokeObjectURL(removed.preview);renderDraft();updateSend();};
    const cancelRecord=draft.querySelector('#cancel-record');if(cancelRecord)cancelRecord.onclick=()=>stopRecording(true);
    const stopRecord=draft.querySelector('#stop-record');if(stopRecord)stopRecord.onclick=()=>stopRecording(false);
    const cancelCapture=draft.querySelector('#cancel-capture');if(cancelCapture)cancelCapture.onclick=()=>stopRecording(true);
    updateSend();
  }
  function hasContent(){return Boolean(input()?.value.trim()||attachments.length||editing);}
  function unavailable(){return Boolean(destroyed||(getChat()?.locked&&!editing)||getChat()?.blocked||paused());}
  function canSend(){return !unavailable()&&!uploading&&!recorder&&!capturePending&&Boolean(editing?input()?.value.trim():hasContent());}
  function canRecord(){return !destroyed&&!getChat()?.locked&&!getChat()?.blocked&&!paused()&&features().voiceNotesEnabled!==false&&features().attachmentsEnabled!==false&&!uploading&&!editing&&!recorder&&!capturePending&&attachments.length<10&&recordingSupported();}
  function updateSend(){
    const send=app.querySelector('.send'),field=input();if(!send||!field)return;
    const blocked=unavailable(),content=hasContent(),recordable=canRecord();
    send.classList.toggle('has-draft',content);send.title=editing?'Save edited message':content?'Send message':'Record voice note';field.disabled=blocked;
    send.disabled=content?!canSend():!recordable;
    for(const button of app.querySelectorAll('.compose-tool')){button.disabled=Boolean(blocked||uploading||recorder||capturePending||(editing&&['attach-file','camera-photo'].includes(button.id)));if(['attach-file','camera-photo'].includes(button.id))button.hidden=features().attachmentsEnabled===false;}
    for(const button of app.querySelectorAll('[data-remove-draft],#cancel-context'))button.disabled=uploading;
    composer()?.dispatchEvent(new CustomEvent('rekha:compose-state',{detail:{hasContent:content,canRecord:recordable,canSend:canSend(),recording:Boolean(recorder),capturePending,editing:Boolean(editing)}}));
  }
  function addFiles(files){
    if(destroyed||getChat()?.locked||getChat()?.blocked||paused()||features().attachmentsEnabled===false)return toast('Attachments are currently unavailable. Your existing draft is kept.');
    if(features().voiceNotesEnabled===false&&[...files].some(file=>file.type.startsWith('audio/')))return toast('Audio uploads are currently paused.');
    if(editing)return toast('Finish editing your message before attaching a file.');
    for(const file of files){if(attachments.length>=10){toast('You can attach up to 10 files per message.');break;}if(!ACCEPT.split(',').includes(file.type)){toast('Choose a JPEG, PNG, WebP, MP4, WebM, audio file or PDF.');continue;}if(file.size>MAX_SIZE){toast(`${file.name} is larger than the 20 MB limit.`);continue;}if(!file.size){toast('The selected file is empty.');continue;}attachments.push({file,preview:URL.createObjectURL(file),uploaded:null});}
    renderDraft();input()?.focus();
  }
  function attachmentMenu(picker){
    if(getChat()?.locked||getChat()?.blocked||paused()||features().attachmentsEnabled===false||uploading||recorder||capturePending)return;
    if(editing)return toast('Finish editing your message before attaching a file.');
    const modal=showDialog('Attach',`<div class="attachment-actions"><button type="button" class="attachment-action" data-attach="gallery"><span class="attachment-action-icon">${chatIcon('image',26)}</span><strong>Gallery</strong><small>Photos &amp; videos</small></button><button type="button" class="attachment-action" data-attach="document"><span class="attachment-action-icon">${chatIcon('file',26)}</span><strong>Document</strong><small>Files &amp; audio</small></button><button type="button" class="attachment-action" data-attach="camera"><span class="attachment-action-icon">${chatIcon('camera',26)}</span><strong>Camera</strong><small>Take a photo</small></button></div>`,'attachment-sheet');
    for(const kind of ['gallery','document'])modal.querySelector(`[data-attach="${kind}"]`).onclick=()=>{modal.close();picker.accept=kind==='gallery'?ACCEPT.split(',').filter(type=>type.startsWith('image/')||type.startsWith('video/')).join(','):acceptedFiles();picker.click();};
    modal.querySelector('[data-attach="camera"]').onclick=()=>{modal.close();capturePhoto();};
  }
  function acceptedFiles(){return features().voiceNotesEnabled===false?ACCEPT.split(',').filter(type=>!type.startsWith('audio/')).join(','):ACCEPT;}
  async function capturePhoto(){
    if(destroyed||getChat()?.locked||getChat()?.blocked||paused()||features().attachmentsEnabled===false||uploading||recorder||capturePending)return;
    if(editing)return toast('Finish editing your message before taking a photo.');
    if(attachments.length>=10)return toast('You can attach up to 10 files per message.');
    if(!navigator.mediaDevices?.getUserMedia)return toast('Camera capture is unavailable here. You can attach a photo from your files.');
    const modal=showDialog('Camera photo','<div class="camera-capture"><video class="camera-preview" autoplay playsinline muted></video><p class="camera-status" role="status">Opening your camera…</p><div class="camera-buttons"><button type="button" class="camera-cancel">Cancel</button><button type="button" class="camera-take" disabled>Take photo</button></div></div>');
    const video=modal.querySelector('video'),button=modal.querySelector('.camera-take'),note=modal.querySelector('.camera-status');
    let camera=null,closed=false,capturing=false;const controller=new AbortController();
    const release=()=>{closed=true;controller.abort();cameraReleases.delete(modal);video.onloadeddata=null;video.pause();video.srcObject=null;for(const track of camera?.getTracks()||[])track.stop();camera=null;};cameraReleases.set(modal,release);
    modal.addEventListener('close',release,{once:true});modal.addEventListener('cancel',release,{once:true});modal.querySelector('.camera-cancel').onclick=()=>{release();modal.close();};modal.querySelector('[data-close]').onclick=()=>{release();modal.close();};
    const ready=()=>{if(closed||destroyed)return;if(video.videoWidth&&video.videoHeight&&video.readyState>=2){button.disabled=false;note.textContent='Take a photo, then review it before sending.';}};
    button.onclick=()=>{
      if(closed||destroyed||!modal.open||capturing||!video.videoWidth||!video.videoHeight)return;
      capturing=true;button.disabled=true;
      const canvas=document.createElement('canvas'),scale=Math.min(1,1600/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
      try{canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);canvas.toBlob(blob=>{if(closed||destroyed||!modal.open)return;if(!blob){capturing=false;button.disabled=false;note.textContent='The photo could not be captured. Please try again.';return;}const file=new File([blob],`Camera photo ${new Date().toISOString().replace(/[:.]/g,'-')}.jpg`,{type:'image/jpeg'});release();modal.close();addFiles([file]);},'image/jpeg',.9);}catch{capturing=false;button.disabled=false;note.textContent='The photo could not be captured. Please try again.';}
    };
    try{
      const acquired=await getFeatureMedia('camera',{audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:960}}},{signal:controller.signal});
      if(closed||destroyed||getChat()?.locked||getChat()?.blocked||paused()||features().attachmentsEnabled===false||!modal.isConnected||!modal.open){for(const track of acquired.getTracks())track.stop();modal.close();return;}
      camera=acquired;video.srcObject=camera;video.onloadeddata=ready;await video.play().catch(()=>{});ready();
    }catch(error){release();if(!modal.isConnected||error.name==='AbortError')return;if(error.name==='PermissionAccessError'){modal.close();toast(error.message);return;}note.textContent=error.name==='NotAllowedError'?'Camera permission was declined. You can attach a photo from your files.':error.name==='NotFoundError'?'No camera was found. You can attach a photo from your files.':'The camera could not be opened. Please try again or attach a photo from your files.';button.disabled=true;}
  }
  function emojiPicker(){const modal=showDialog('Emoji',`<div class="emoji-grid">${emojis.map(emoji=>`<button type="button" data-insert-emoji="${esc(emoji)}" aria-label="${esc(emoji)}">${emoji}</button>`).join('')}</div>`);for(const button of modal.querySelectorAll('[data-insert-emoji]'))button.onclick=()=>{const field=input();if(!field||field.disabled)return;const start=field.selectionStart,end=field.selectionEnd,text=button.dataset.insertEmoji;if(field.value.length-end+start+text.length>2000)return;field.setRangeText(text,start,end,'end');field.dispatchEvent(new Event('input',{bubbles:true}));modal.close();field.focus();};}
  function recordingSupported(){return Boolean(navigator.mediaDevices?.getUserMedia&&window.MediaRecorder);}
  async function recordVoice(){
      if(capturePending||paused()||features().voiceNotesEnabled===false||features().attachmentsEnabled===false)return;
    if(recorder)return stopRecording(false);
    if(!recordingSupported())return toast('Voice recording is unavailable here. You can attach an audio file instead.');
    if(destroyed||getChat()?.locked||getChat()?.blocked||editing||uploading)return;
    if(attachments.length>=10)return toast('Send or remove an attachment before recording a voice note.');
    const controller=new AbortController();voiceCaptureController=controller;capturePending=true;renderDraft();
    try{
      const acquired=await getFeatureMedia('microphone',{audio:true},{signal:controller.signal});
      if(controller.signal.aborted||voiceCaptureController!==controller||destroyed||getChat()?.locked||getChat()?.blocked||editing||paused()||features().voiceNotesEnabled===false||features().attachmentsEnabled===false){acquired.getTracks().forEach(track=>track.stop());return;}
      stream=acquired;
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
    }catch(error){if(error.name==='AbortError')return;stream?.getTracks().forEach(track=>track.stop());stream=null;recorder=null;recordChunks=[];clearInterval(recordTimer);if(!destroyed){renderDraft();toast(error.name==='PermissionAccessError'?error.message:error.name==='NotAllowedError'?'Microphone permission was declined. You can attach an audio file instead.':'The microphone could not be opened. Please try again.');}}
    finally{if(voiceCaptureController===controller){voiceCaptureController=null;capturePending=false;if(!destroyed&&composer()?.isConnected)renderDraft();}}
  }
  function stopRecording(discard){if(capturePending&&!recorder){voiceCaptureController?.abort();voiceCaptureController=null;capturePending=false;if(!destroyed)renderDraft();return;}if(!recorder)return;discardRecording=discard;clearInterval(recordTimer);if(recorder.state!=='inactive')recorder.stop();stream?.getTracks().forEach(track=>track.stop());}
  function messageOptions(id){
    const message=find(id);if(!message||message.role==='system')return;
    const age=Date.now()-new Date(message.created).getTime(),canEdit=own(message)&&textMessage(message)&&age>=0&&age<=15*60*1000,canDelete=own(message)&&!message.deleted&&age>=0&&age<=24*60*60*1000;
    const modal=showDialog('Message options',`<p class="options-excerpt">${esc(messageSummary(message).slice(0,180))}</p>${!message.deleted?`<div class="reaction-picker">${reactions.map(emoji=>`<button type="button" data-react="${esc(emoji)}" class="${(message.reactions||[]).some(item=>item.by==='customer'&&item.emoji===emoji)?'selected':''}" aria-label="React ${esc(emoji)}">${emoji}</button>`).join('')}</div>`:''}<div class="message-option-list">${!message.deleted?'<button type="button" data-action="reply">↩ Reply</button>':''}<button type="button" data-action="star">${message.starred?'★ Unstar':'☆ Star'} message</button>${!message.deleted?'<button type="button" data-action="copy">▣ Copy text</button>':''}${canEdit?'<button type="button" data-action="edit">✎ Edit message</button>':''}${canDelete?'<button type="button" class="danger" data-action="delete">Delete for everyone</button>':''}</div>`);
    if(own(message)){const receipt=document.createElement('p');receipt.className='receipt-detail';receipt.textContent=message.readByOther?`Read by ${astrologer()}`:`Received by ${astrologer()}'s chat`;modal.querySelector('.options-excerpt').after(receipt);}
    for(const button of modal.querySelectorAll('[data-react]'))button.onclick=()=>{const current=(message.reactions||[]).some(item=>item.by==='customer'&&item.emoji===button.dataset.react);modal.close();mutation(`/api/messages/${id}/reaction`,'PUT',{emoji:current?'':button.dataset.react});};
    for(const button of modal.querySelectorAll('[data-action]'))button.onclick=async()=>{
      const action=button.dataset.action;modal.close();if(action==='delete'&&isBusy())return toast('Please wait for your message to finish sending.');
      if(action==='reply'){if(paused()||getChat()?.blocked)return toast('Customer messages are currently paused.');if(getChat()?.locked)return toast('Unlock your conversation to reply.');if(editing){editing=null;input().value=editBackup?.body||'';editBackup=null;}replyTo=id;renderDraft();input().focus();}
      if(action==='edit'){if(paused()||getChat()?.blocked)return toast('Messages are currently paused.');if(recorder||capturePending)return toast('Finish your voice recording before editing a message.');if(attachments.length)return toast('Send or remove your attachment draft before editing a message.');if(!editing)editBackup={body:input().value,replyTo};replyTo=null;editing=id;input().value=message.body;input().dispatchEvent(new Event('input',{bubbles:true}));renderDraft();input().focus();}
      if(action==='star')mutation(`/api/messages/${id}/star`,'PUT',{starred:!message.starred});
      if(action==='copy'){try{await navigator.clipboard.writeText(messageSummary(message));toast('Message copied.');}catch{const copyModal=showDialog('Copy message',`<textarea class="copy-text" readonly>${esc(messageSummary(message))}</textarea><p>Select the text to copy it.</p>`);copyModal.querySelector('textarea').select();}}
      if(action==='delete'){const confirm=showDialog('Delete message?',`<p>This message will be replaced with a deleted-message notice for both sides.</p><button type="button" class="confirm-delete-message danger">Delete for everyone</button>`);confirm.querySelector('.confirm-delete-message').onclick=()=>{confirm.close();mutation(`/api/messages/${id}`,'DELETE',{});};}
    };
  }
  function listMessages(mode){
    const title=mode==='starred'?'Loaded starred messages':mode==='media'?'Loaded shared media':'Search loaded messages';
    const modal=showDialog(title,`<p>Use Load earlier messages in the chat to include older replies.</p>${mode==='search'?'<label class="search-chat-label">Find a loaded message<input id="search-chat" type="search" placeholder="Search loaded messages…" autocomplete="off"></label>':''}<div class="message-results"></div>`),results=modal.querySelector('.message-results');
    const render=(query='')=>{
      const messages=(getChat()?.messages||[]).filter(message=>message.role!=='system'&&(mode==='starred'?message.starred:mode==='media'?message.kind==='media'&&!message.deleted:!message.deleted&&messageSummary(message).toLocaleLowerCase().includes(query.toLocaleLowerCase())));
      results.innerHTML=messages.length?messages.map(message=>`<button type="button" class="message-result" data-result-id="${Number(message.id)}"><strong>${own(message)?'You':esc(astrologer())}<time>${esc(new Date(message.created).toLocaleDateString())}</time></strong><span>${esc(messageSummary(message).slice(0,180))}</span></button>`).join(''):`<p class="empty-results">${mode==='starred'?'Star a message from its options to find it here.':mode==='media'?'Shared photos, videos, voice notes and documents will appear here.':'No matching messages.'}</p>`;
      for(const button of results.querySelectorAll('[data-result-id]'))button.onclick=()=>{modal.close();jump(button.dataset.resultId);};
    };
    render();const field=modal.querySelector('#search-chat');if(field){field.oninput=()=>render(field.value);field.focus();}
  }
  function exportChat(){
    const lines=[`${getAppSettings()?.brand?.name||'Rekha Astrology'} — private conversation`,`Loaded messages exported ${new Date().toLocaleString()}`,'Load earlier messages before exporting to include older replies.',''];
    for(const message of getChat()?.messages||[]){lines.push(`[${new Date(message.created).toLocaleString()}] ${message.role==='user'?'You':message.role==='system'?'Note':astrologer()}: ${messageSummary(message)}${message.edited?' (edited)':''}`);if(message.kind==='media'&&!message.deleted)for(const item of mediaItems(message))lines.push(`  Attachment: ${item.title||item.type}`);}
    const text=lines.join('\n');
    if(typeof window.RekhaDevice?.saveChatExport==='function'){try{window.RekhaDevice.saveChatExport(text);toast('Choose where to save your chat export.');return;}catch(error){toast('The export could not be opened. Please try again.');return;}}
    const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=`Rekha-Astrology-Chat-${new Date().toISOString().slice(0,10)}.txt`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);toast('Your chat export is ready. Attachments remain in the chat.');
  }
  function openMenu(){
    const modal=showDialog('Conversation',`<div class="message-option-list"><button type="button" data-menu="search">⌕ Search loaded messages</button><button type="button" data-menu="starred">☆ Starred messages</button><button type="button" data-menu="media">▧ Shared media</button><button type="button" data-menu="export">↓ Export loaded messages</button><button type="button" data-menu="access">Feature access</button>${typeof window.RekhaDevice?.showAlertSettings==='function'?'<button type="button" data-menu="alerts">Message alerts</button>':''}<button type="button" data-menu="intro">▷ Watch introduction</button><button type="button" data-menu="privacy">Privacy and conversation settings</button></div>`);
    if(sounds){const toggle=document.createElement('button');toggle.type='button';toggle.dataset.menu='sounds';const refresh=()=>{toggle.textContent=getLang()==='hi'?'बातचीत की ध्वनि':'Chat sounds';toggle.setAttribute('aria-pressed',String(sounds.enabled()));toggle.textContent+=' · '+(sounds.enabled()?'On':'Off');};refresh();toggle.onclick=()=>{sounds.setEnabled(!sounds.enabled());refresh();};modal.querySelector('.message-option-list').prepend(toggle);}
    for(const button of modal.querySelectorAll('[data-menu]:not([data-menu="sounds"])'))button.onclick=()=>{const choice=button.dataset.menu;modal.close();if(['intro','privacy'].includes(choice)&&(recorder||capturePending))return toast('Finish or cancel your voice recording before leaving the conversation.');if(['intro','privacy'].includes(choice)&&isBusy())return toast('Please wait for the current action to finish.');if(['search','starred','media'].includes(choice))listMessages(choice);if(choice==='export')exportChat();if(choice==='access')openFeatureAccess();if(choice==='alerts'){try{window.RekhaDevice.showAlertSettings();}catch{toast('Alert settings could not be opened.');}}if(choice==='intro')introduction();if(choice==='privacy')privacy(true);};
  }
  function typing(active){if(destroyed)return;api('/api/chat/typing','POST',{active}).catch(()=>{});}
  function inputChanged(){updateSend();clearTimeout(typingTimer);const active=Boolean(input()?.value.trim())&&!editing;if(active&&Date.now()-lastTyping>3500){lastTyping=Date.now();typing(true);}typingTimer=setTimeout(()=>typing(false),2500);}
  function markRead(){
    if(destroyed||document.hidden)return;const scroller=app.querySelector('#chat-scroll');if(!scroller)return;const visible=scroller.getBoundingClientRect();if(visible.height<=0)return;
    const latest=[...(getChat()?.messages||[])].reverse().find(message=>{if(message.role!=='assistant'||message.readByOther||Number(message.id)<=readId)return false;const node=app.querySelector(`[data-message="${Number(message.id)}"]`);if(!node)return false;const rect=node.getBoundingClientRect();return rect.height>0&&rect.bottom>=visible.top&&rect.top<=visible.bottom;});if(!latest)return;
    readId=Number(latest.id);api('/api/chat/read','POST',{lastId:readId}).catch(()=>{readId=0;});
  }
  function pressTarget(target){
    if(!(target instanceof Element)||target.closest('button,a,input,textarea,select,audio,video,[data-media-url],[data-jump-message],.image-open,.media-preview'))return null;
    const node=target.closest('[data-message]'),id=Number(node?.dataset.message),message=find(id);
    return node&&Number.isSafeInteger(id)&&id>0&&message&&message.role!=='system'?{node,id}:null;
  }
  function cancelPress(){clearTimeout(pressTimer);pressTimer=null;press=null;}
  function mountMessagePress(messages){
    messages.addEventListener('pointerdown',event=>{
      cancelPress();if(event.button!==0||event.pointerType==='mouse')return;
      const target=pressTarget(event.target);if(!target)return;
      press={...target,pointer:event.pointerId,x:event.clientX,y:event.clientY};
      pressTimer=setTimeout(()=>{const active=press;cancelPress();if(destroyed||!active?.node.isConnected||!find(active.id))return;lastLongPress=Date.now();lastLongPressId=active.id;messageOptions(active.id);},500);
    },{passive:true});
    messages.addEventListener('pointermove',event=>{if(press&&(event.pointerId!==press.pointer||Math.hypot(event.clientX-press.x,event.clientY-press.y)>10))cancelPress();},{passive:true});
    for(const type of ['pointerup','pointercancel','pointerleave'])messages.addEventListener(type,cancelPress,{passive:true});
    messages.addEventListener('contextmenu',event=>{const target=pressTarget(event.target);if(!target)return;event.preventDefault();cancelPress();if(lastLongPressId===target.id&&Date.now()-lastLongPress<1000)return;messageOptions(target.id);});
  }
  function mount(){
    const row=app.querySelector('.compose-row'),draft=document.createElement('div');draft.id='compose-draft';composer().prepend(draft);
    const field=input();let pill=row.querySelector('.compose-input');if(!pill){pill=document.createElement('div');pill.className='compose-input';row.insertBefore(pill,field);pill.append(field);}
    const tool=(id,action,label,icon)=>{const button=document.createElement('button');button.type='button';button.className='compose-tool';button.id=id;button.dataset.composeAction=action;button.setAttribute('aria-label',label);button.title=label;button.innerHTML=chatIcon(icon,24);return button;};
    const emoji=tool('emoji-picker','emoji','Add emoji','smile'),attach=tool('attach-file','attach','Attach photos, videos or documents','attach'),camera=tool('camera-photo','camera','Take a camera photo','camera');pill.insertBefore(emoji,field);pill.append(attach,camera);
    const picker=document.createElement('input');picker.type='file';picker.accept=acceptedFiles();picker.multiple=true;picker.hidden=true;picker.id='attachment-picker';composer().append(picker);
    picker.onchange=()=>{addFiles([...picker.files]);picker.value='';picker.accept=acceptedFiles();};attach.onclick=()=>attachmentMenu(picker);emoji.onclick=emojiPicker;camera.onclick=capturePhoto;
    input().addEventListener('input',inputChanged);input().addEventListener('paste',event=>{const files=[...event.clipboardData?.files||[]];if(files.length){event.preventDefault();addFiles(files);}});
    const headerButton=app.querySelector('#chat-privacy');headerButton.setAttribute('aria-label','Conversation menu');headerButton.title='Conversation menu';headerButton.onclick=openMenu;
    const messages=app.querySelector('#messages');mountMessagePress(messages);messages.addEventListener('click',event=>{
      const pressed=pressTarget(event.target);if(pressed?.id===lastLongPressId&&Date.now()-lastLongPress<1000){event.preventDefault();return;}
      const options=event.target.closest('[data-message-actions]');if(options)return messageOptions(Number(options.dataset.messageActions));
      const quote=event.target.closest('[data-jump-message]');if(quote)return jump(quote.dataset.jumpMessage);
      const reaction=event.target.closest('[data-reaction-message]');if(reaction)return messageOptions(Number(reaction.dataset.reactionMessage));
      const image=event.target.closest('[data-media-url]');if(image&&attachmentUrl(image.dataset.mediaUrl)){const modal=showDialog(image.dataset.mediaTitle||'Shared image',`<img class="full-image" src="${image.dataset.mediaUrl}" alt="${esc(image.dataset.mediaTitle)}"><a class="save-image" href="${image.dataset.mediaUrl}" download>Download image</a>`);}
    });
    app.querySelector('#chat-scroll').addEventListener('scroll',()=>{cancelPress();markRead();},{passive:true});renderDraft();
  }
  function validateDraft(draft){
    const rejected=(message,status)=>Object.assign(new Error(message),{status});
    if(paused())throw rejected('Customer messages are currently paused. Your draft is kept.',403);
    if(getChat()?.blocked)throw rejected('This conversation is unavailable. Your draft is kept.',403);
    if(getChat()?.locked&&!draft.editId)throw rejected('Unlock your conversation before sending. Your draft is kept.',402);
    if(draft.attachments.length&&features().attachmentsEnabled===false)throw rejected('Attachments are currently paused. Remove them to send only text.',403);
    if(features().voiceNotesEnabled===false&&draft.attachments.some(item=>item.file.type.startsWith('audio/')))throw rejected('Audio uploads are currently paused. Remove them to send other content.',403);
    if(draft.body.length>2000)throw rejected('Use up to 2,000 characters per message.',400);
    if(draft.editId&&!draft.body.trim())throw rejected('An edited message cannot be empty.',400);
  }
  function snapshot(body,clientId){return {body:String(body??''),clientId,editId:editing,replyTo,attachments:[...attachments],previewRevoked:false,finished:false};}
  function takeDraft(body,clientId){
    if(destroyed)throw new Error('Open your conversation before sending.');
    if(recorder||capturePending)throw new Error('Finish your voice recording or permission prompt before sending.');
    const draft=snapshot(body,clientId);validateDraft(draft);if(!draft.body.trim()&&!draft.attachments.length&&!draft.editId)return null;
    const restored=editing?editBackup:null;attachments=[];replyTo=restored?.replyTo||null;editing=null;editBackup=null;
    const field=input();if(field){field.value=restored?.body||'';field.style.height='46px';field.dispatchEvent(new Event('input',{bubbles:true}));}
    snapshots.add(draft);typing(false);renderDraft();return draft;
  }
  function revivePreviews(draft){if(!draft.previewRevoked)return;for(const item of draft.attachments)item.preview=URL.createObjectURL(item.file);draft.previewRevoked=false;}
  async function prepareDraft(draft,{signal}={}){
    if(!draft||draft.finished)throw new Error('This draft has already been completed.');
    validateDraft(draft);revivePreviews(draft);snapshots.add(draft);
    if(draft.editId)return {editId:draft.editId,body:draft.body};
    if(draft.uploadPromise)return draft.uploadPromise;
    draft.uploadPromise=(async()=>{
      for(const attachment of draft.attachments)if(!attachment.uploaded){
        validateDraft(draft);if(draft.finished)throw new Error('This draft was cancelled.');
        const timeout=AbortSignal.timeout(120000),uploadSignal=signal?AbortSignal.any([signal,timeout]):timeout;
        const response=await fetch('/api/uploads?name='+encodeURIComponent(attachment.file.name),{method:'POST',credentials:'same-origin',headers:{'Content-Type':attachment.file.type},body:attachment.file,signal:uploadSignal});
        let data;try{data=await response.json();}catch{throw new Error('The attachment upload could not be completed.');}if(!response.ok)throw Object.assign(new Error(data.error||'Attachment upload failed.'),{status:response.status});if(!data?.id)throw new Error('The attachment upload did not return a file reference.');attachment.uploaded=data;
      }
      validateDraft(draft);if(draft.finished)throw new Error('This draft was cancelled.');
      return {body:draft.body,clientId:draft.clientId,...(draft.replyTo?{replyTo:draft.replyTo}:{}),...(draft.attachments.length?{mediaIds:draft.attachments.map(item=>item.uploaded.id)}:{})};
    })();
    try{return await draft.uploadPromise;}finally{draft.uploadPromise=null;}
  }
  function releasePreviews(draft){for(const item of draft.attachments)URL.revokeObjectURL(item.preview);draft.previewRevoked=true;}
  function finishDraft(draft){if(!draft||draft.finished)return;draft.finished=true;releasePreviews(draft);snapshots.delete(draft);}
  async function preparePayload(body,clientId){
    if(recorder||capturePending)throw new Error('Finish your voice recording or permission prompt before sending.');
    legacySnapshot=snapshot(body,clientId);validateDraft(legacySnapshot);if(!legacySnapshot.body.trim()&&!legacySnapshot.attachments.length&&!legacySnapshot.editId)return null;
    uploading=true;updateSend();try{return await prepareDraft(legacySnapshot);}finally{uploading=false;updateSend();}
  }
  function sent(draft=legacySnapshot){
    if(!draft)return;
    // Compatibility callers may keep the composer attached during upload.
    // Only remove the exact captured context; never clear a newer draft.
    if(draft===legacySnapshot){if(replyTo===draft.replyTo)replyTo=null;if(editing===draft.editId){editing=null;editBackup=null;}attachments=attachments.filter(item=>!draft.attachments.includes(item));legacySnapshot=null;typing(false);renderDraft();}
    finishDraft(draft);
  }
  function preserveDraft(){return {body:input()?.value||'',replyTo,editId:editing,editBackup,attachments:[...attachments],previewRevoked:true};}
  function restoreDraft(draft){if(!draft||destroyed)return;for(const item of attachments)URL.revokeObjectURL(item.preview);attachments=[...(draft.attachments||[])];revivePreviews(draft);replyTo=draft.replyTo||null;editing=draft.editId||null;editBackup=draft.editBackup||null;input().value=draft.body||'';input().dispatchEvent(new Event('input',{bubbles:true}));renderDraft();}
  function refresh(){if(destroyed)return;if((recorder||capturePending)&&(getChat()?.locked||getChat()?.blocked||paused()||features().voiceNotesEnabled===false||features().attachmentsEnabled===false))stopRecording(true);if(getChat()?.locked||getChat()?.blocked||paused()||features().attachmentsEnabled===false)for(const [modal,release]of [...cameraReleases]){release();modal.close();}updateSend();const caption=app.querySelector('.chat-caption');if(caption)caption.textContent=getChat()?.typing?.owner?'typing…':getAppSettings()?.copy?.[getLang()]?.tagline||getAppSettings()?.brand?.tagline||(getLang()==='hi'?'आपकी निजी बातचीत':'Your personal conversation');const picker=app.querySelector('#attachment-picker');if(picker)picker.accept=acceptedFiles();markRead();}
  function destroy(){if(destroyed)return;typing(false);destroyed=true;cancelPress();discardRecording=true;stopRecording(true);clearTimeout(typingTimer);clearInterval(recordTimer);for(const item of attachments)URL.revokeObjectURL(item.preview);for(const draft of snapshots)releasePreviews(draft);for(const modal of [...localDialogs]){cameraReleases.get(modal)?.();modal.close();}stream?.getTracks().forEach(track=>track.stop());}
  mount();return {takeDraft,prepareDraft,finishDraft,preserveDraft,restoreDraft,preparePayload,sent,refresh,destroy,openMenu,startRecord:recordVoice,canRecord,canSend,hasLiveCapture:()=>Boolean(recorder||capturePending),isEditing:()=>Boolean(editing),hasContent,draftSignature:()=>JSON.stringify({replyTo,editing,files:attachments.map(item=>[item.file.name,item.file.size,item.file.lastModified])})};
}
