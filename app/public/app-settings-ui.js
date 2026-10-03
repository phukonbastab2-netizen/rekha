import {languages} from './locales.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=value=>structuredClone(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const plain=value=>String(value??'').replace(/<br\s*\/?>/gi,'\n');
const invalidText=value=>/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f<>]/.test(value);
const languageNames={hi:'हिन्दी',en:'English',hinglish:'Hinglish'};
const sections=[['brand','Branding'],['welcome','Welcome videos'],['chat','Chat controls'],['copy','Text & offers']];
const videos={welcome:'Welcome',introduction:'Introduction',testimonials:'Testimonials'};
const copyFields=[['tagline','Chat subtitle',120],['languageTitle','Language screen title',160],['languageSubtitle','Language screen introduction',1000],['detailsTitle','Birth details title',160],['detailsSubtitle','Birth details introduction',1000],['kundli','Kundli notice',2000],['kundliNote','Kundli explanation',2000],['permissionsTitle','Optional choices title',160],['permissionsSubtitle','Optional choices introduction',1000],['messagePlaceholder','Message box hint',200],['reflection','Guidance note',1000],['offerTitle','Unlock offer title',160],['offerText','Unlock offer explanation',2000]];
const chatFields=[['customerMessagingEnabled','Customer messages','Customers can send more messages without waiting for a reply.'],['attachmentsEnabled','Photos, videos and documents','Customers can choose and send attachments in their private chat.'],['voiceNotesEnabled','Voice notes','Customers can record and send voice messages after allowing microphone access.'],['voiceCallsEnabled','Voice calls','Show the voice call button in customer chat.'],['videoCallsEnabled','Video calls','Show the video call button in customer chat.']];
const serviceFields=[['freeReplies','Demo AI free replies',0,20],['unlockPriceRupees','Preview unlock price (₹)',1,9999],['retentionDays','Delete inactive conversations after (days)',7,90]];
let dialogNumber=0;

function createDialog(title,onRequestClose){
  const dialog=document.createElement('dialog'),titleId='app-editor-title-'+(++dialogNumber);
  dialog.className='app-editor-dialog';dialog.setAttribute('aria-labelledby',titleId);
  dialog.innerHTML=`<header class="app-editor-header"><div><h2 id="${titleId}">${esc(title)}</h2><p>Edit a draft, preview it, then publish when ready.</p></div><button type="button" data-editor-close aria-label="Close app editor">✕</button></header><div class="app-editor-content"><p role="status">Loading app settings…</p></div>`;
  document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());
  dialog.querySelector('[data-editor-close]').onclick=()=>onRequestClose?onRequestClose():dialog.close();
  dialog.addEventListener('cancel',event=>{if(onRequestClose){event.preventDefault();onRequestClose();}});
  dialog.showModal();return dialog;
}

function confirmation(title,text,buttonLabel){
  return new Promise(resolve=>{
    const dialog=createDialog(title),content=dialog.querySelector('.app-editor-content');let approved=false;
    dialog.classList.add('app-editor-confirm');
    content.innerHTML=`<p>${esc(text)}</p><div class="app-editor-confirm-actions"><button type="button" data-confirm class="primary">${esc(buttonLabel)}</button><button type="button" data-cancel>Keep editing</button></div>`;
    content.querySelector('[data-confirm]').onclick=()=>{approved=true;dialog.close();};content.querySelector('[data-cancel]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>resolve(approved),{once:true});
  });
}

function defaults(){
  return {brand:{name:'Rekha Astrology',astrologerName:'Rekha',tagline:'Your personal conversation',primaryColor:'#075e54',accentColor:'#008069',logoMediaId:null},onboarding:{introEnabled:true,introOrder:['welcome','introduction','testimonials']},chat:{attachmentsEnabled:true,voiceNotesEnabled:true,voiceCallsEnabled:true,videoCallsEnabled:true,customerMessagingEnabled:true},service:{freeReplies:3,unlockPriceRupees:49,retentionDays:30},copy:{hi:{},en:{},hinglish:{}}};
}
function normalized(settings){
  const fallback=defaults();
  return Object.fromEntries(Object.keys(fallback).map(key=>[key,key==='copy'?Object.fromEntries(Object.keys(languageNames).map(language=>[language,{...settings?.copy?.[language]}])):{...fallback[key],...settings?.[key]}]));
}
function fingerprint(settings){return JSON.stringify(settings);}
function defaultLocalized(settings,language,key){return key==='tagline'?settings.brand.tagline:plain(languages[language]?.[key]??languages.en[key]).replaceAll('₹49',`₹${settings.service.unlockPriceRupees}`).replaceAll('Rekha',settings.brand.astrologerName).replaceAll('रेखा',settings.brand.astrologerName==='Rekha'?'रेखा':settings.brand.astrologerName);}
function localized(settings,language,key){return settings.copy[language]?.[key]??defaultLocalized(settings,language,key);}
function settingLabel(path){
  const [section,key,copyKey]=path.split('.');
  if(section==='copy')return `${languageNames[key]} · ${copyKey==='topics'?'Suggested topics':copyFields.find(field=>field[0]===copyKey)?.[1]||copyKey}`;
  if(section==='chat')return chatFields.find(field=>field[0]===key)?.[1]||key;
  if(section==='service')return serviceFields.find(field=>field[0]===key)?.[1]||key;
  return {'brand.name':'App name','brand.astrologerName':'Name on replies','brand.tagline':'Default chat subtitle','brand.primaryColor':'Header colour','brand.accentColor':'Button colour','brand.logoMediaId':'App image','onboarding.introEnabled':'Welcome videos','onboarding.introOrder':'Video order'}[path]||path;
}
function changedFields(before,after){
  const paths=[...Object.keys(after.brand).map(k=>'brand.'+k),...Object.keys(after.onboarding).map(k=>'onboarding.'+k),...Object.keys(after.chat).map(k=>'chat.'+k),...Object.keys(after.service).map(k=>'service.'+k),...Object.keys(languageNames).flatMap(language=>[...copyFields.map(field=>field[0]),'topics'].map(key=>`copy.${language}.${key}`))];
  return paths.flatMap(path=>{const parts=path.split('.'),get=object=>parts.reduce((value,key)=>value?.[key],object),a=get(before),b=get(after);return JSON.stringify(a)===JSON.stringify(b)?[]:[{path,before:a,after:b}];});
}

export async function openAppSettings({api,notice=()=>{}}){
  let state=null,model=null,saved=null,library=[],busy=false,confirming=false,tab='brand',copyLanguage='hi',previewLanguage='en',previewScreen='chat',error='',conflict=false,mockMessages=[],mockInput='',libraryError='';
  const dialog=createDialog('Edit your app',requestClose);
  function dirty(){return model&&saved&&fingerprint(model)!==fingerprint(saved);}
  function pendingVideos(){return [...dialog.querySelectorAll('[data-video-file]')].some(input=>input.files?.length);}
  async function requestClose(){
    if(busy||confirming)return;
    if(dirty()||pendingVideos()){confirming=true;const close=await confirmation('Close without saving?','Unsaved edits and selected video files on this screen will be lost. Your previously saved draft stays available.','Close without saving');confirming=false;if(!close)return;}
    dialog.close();
  }
  function apply(response){
    if(!response||!response.published||!response.draft||!Number.isSafeInteger(response.revision))throw Error('The app settings response was incomplete. Please reload.');
    state=response;model=normalized(response.draft);saved=clone(model);error='';conflict=false;
  }
  function setError(failure){error=failure.message||'Could not complete this step. Your edits are still here.';conflict=failure.status===409;updateStatus();}
  async function load(){
    if(busy)return;busy=true;
    try{
      const [settings,media]=await Promise.allSettled([api('/api/admin/app-settings'),api('/api/admin/library')]);
      if(!dialog.isConnected)return;
      if(settings.status!=='fulfilled')throw settings.reason;
      apply(settings.value);library=media.status==='fulfilled'?(Array.isArray(media.value)?media.value:media.value.items||[]):[];
      libraryError=media.status==='rejected'?'Your image library could not load. Use Refresh images to try again.':'';render();
    }catch(failure){
      if(!dialog.isConnected)return;error=failure.message||'Could not load app settings.';
      dialog.querySelector('.app-editor-content').innerHTML=`<p class="app-editor-error" role="alert">${esc(error)}</p><button type="button" data-load-retry>Try again</button>`;
      dialog.querySelector('[data-load-retry]').onclick=load;
    }finally{busy=false;if(model&&dialog.isConnected)updateStatus();}
  }
  function logoOptions(){
    const available=library.filter(item=>item.type==='image'&&!item.archived&&!item.url),current=model.brand.logoMediaId;
    return `<option value="">Use the original Rekha image</option>${current&&!available.some(item=>item.id===current)?`<option value="${esc(current)}" selected>Saved image — unavailable</option>`:''}${available.map(item=>`<option value="${esc(item.id)}" ${item.id===current?'selected':''}>${esc(item.title)}</option>`).join('')}`;
  }
  function input(path,label,{max,type='text',min,value,help}={}){
    const current=value??path.split('.').reduce((value,key)=>value[key],model);
    return `<label>${esc(label)}<input data-setting="${path}" type="${type}" value="${esc(current)}" ${max!=null?`max${type==='number'?'':'length'}="${max}"`:''} ${min!=null?`min="${min}"`:''} ${type==='number'?'step="1"':''}>${help?`<small>${esc(help)}</small>`:''}</label>`;
  }
  function render(){
    const content=dialog.querySelector('.app-editor-content');
    const retainedFiles=[...content.querySelectorAll('[data-video-file]')].filter(input=>input.files?.length);
    content.innerHTML=`<div class="app-editor-notice"><strong>Draft editing</strong><span>Settings stay in your draft until Publish. Video replacements are separate.</span></div><nav class="app-editor-tabs" aria-label="App editor sections">${sections.map(([key,label])=>`<button type="button" data-editor-tab="${key}" aria-pressed="${tab===key}">${label}</button>`).join('')}</nav><div class="app-editor-grid"><main class="app-editor-form"><section data-editor-section="brand" ${tab==='brand'?'':'hidden'}><h3>Make the app yours</h3>${input('brand.name','App name',{max:60})}${input('brand.astrologerName','Name on replies',{max:60})}${input('brand.tagline','Default chat subtitle',{max:120,help:'Language-specific subtitles in Text & offers can override this.'})}<div class="app-editor-two">${input('brand.primaryColor','Header colour',{max:7,help:'Use a six-digit colour, such as #075e54.'})}${input('brand.accentColor','Button colour',{max:7,help:'Use a six-digit colour, such as #008069.'})}</div><div class="app-editor-colours"><label>Pick header colour<input type="color" data-colour="primaryColor" value="${esc(model.brand.primaryColor)}"></label><label>Pick button colour<input type="color" data-colour="accentColor" value="${esc(model.brand.accentColor)}"></label></div><label>App image<select data-setting="brand.logoMediaId">${logoOptions()}</select><small>Choose an uploaded image from your private media library. The selected image becomes public when you publish it as the app image.</small></label><button type="button" data-refresh-images>Refresh images</button><p class="app-editor-error" data-library-error role="status">${esc(libraryError)}</p><p class="app-editor-help">Name and image changes update what customers see inside the app. Changing the Android launcher name or icon requires an app update.</p></section><section data-editor-section="welcome" ${tab==='welcome'?'':'hidden'}><h3>Your welcome videos</h3><label class="app-editor-switch"><input type="checkbox" data-setting="onboarding.introEnabled" ${model.onboarding.introEnabled?'checked':''}><span>Show welcome videos before language selection<small>Customers can still skip the introduction and continue.</small></span></label><p class="app-editor-help">Move videos into the order you want, then save and publish your draft.</p><ol class="app-editor-video-order"></ol><p class="app-editor-warning">Replacing a video updates that video file immediately. Video order and the welcome switch stay in your draft until Publish.</p></section><section data-editor-section="chat" ${tab==='chat'?'':'hidden'}><h3>What customers can do in chat</h3>${chatFields.map(([key,label,help])=>`<label class="app-editor-switch"><input type="checkbox" data-setting="chat.${key}" ${model.chat[key]?'checked':''}><span>${esc(label)}<small>${esc(help)}</small></span></label>`).join('')}<p class="app-editor-help">Owner replies and the private inbox remain available. Device permissions are requested only when customers use a feature.</p></section><section data-editor-section="copy" ${tab==='copy'?'':'hidden'}><h3>Replies, offers and privacy</h3><div class="app-editor-two">${serviceFields.map(([key,label,min,max])=>input('service.'+key,label,{type:'number',min,max})).join('')}</div><p class="app-editor-warning">Payments stay in preview. Editing the price does not collect money. Advertising stays off. Changing text or price cannot change words spoken in a video; upload a new video for that.</p><p class="app-editor-help">Guided reply flows stay uncapped. The free-reply setting controls only demo AI replies in chats outside those flows. Inactive conversations can be removed after the chosen number of days.</p><nav class="app-editor-languages" aria-label="Customer wording language">${Object.entries(languageNames).map(([key,label])=>`<button type="button" data-copy-language="${key}" aria-pressed="${copyLanguage===key}">${label}</button>`).join('')}</nav><p class="app-editor-help">Plain text only. Leave a field blank to keep the original wording shown as its hint.</p><div class="app-editor-copy-fields"></div></section></main><aside class="app-editor-preview"><h3>Phone preview</h3><p>Preview only. Messages here are never sent.</p><div class="app-editor-preview-selects"><label>Language<select data-preview-language>${Object.entries(languageNames).map(([key,label])=>`<option value="${key}" ${previewLanguage===key?'selected':''}>${label}</option>`).join('')}</select></label><label>Screen<select data-preview-screen>${[['chat','Chat'],['welcome','Welcome'],['language','Language selection'],['details','Birth details'],['permissions','Optional choices'],['offer','Unlock offer']].map(([key,label])=>`<option value="${key}" ${previewScreen===key?'selected':''}>${label}</option>`).join('')}</select></label></div><div class="app-editor-phone"></div></aside></div><div class="app-editor-feedback"><p class="app-editor-error" data-editor-error role="alert"></p><button type="button" data-reload-latest hidden>Reload latest settings</button><p data-editor-status role="status"></p></div><footer class="app-editor-footer"><button type="button" data-save-draft class="primary">Save draft</button><button type="button" data-review>Review & publish</button><button type="button" data-discard>Discard saved draft</button></footer>`;
    for(const button of dialog.querySelectorAll('[data-editor-tab]'))button.onclick=()=>{tab=button.dataset.editorTab;for(const b of dialog.querySelectorAll('[data-editor-tab]'))b.setAttribute('aria-pressed',String(b===button));for(const section of dialog.querySelectorAll('[data-editor-section]'))section.hidden=section.dataset.editorSection!==tab;};
    for(const control of dialog.querySelectorAll('[data-setting]'))control.oninput=()=>change(control);
    for(const picker of dialog.querySelectorAll('[data-colour]'))picker.oninput=()=>{model.brand[picker.dataset.colour]=picker.value;dialog.querySelector(`[data-setting="brand.${picker.dataset.colour}"]`).value=picker.value;updatePreview();updateStatus();};
    dialog.querySelector('[data-refresh-images]').onclick=refreshImages;
    for(const button of dialog.querySelectorAll('[data-copy-language]'))button.onclick=()=>{copyLanguage=button.dataset.copyLanguage;for(const b of dialog.querySelectorAll('[data-copy-language]'))b.setAttribute('aria-pressed',String(b===button));renderCopy();};
    dialog.querySelector('[data-preview-language]').onchange=event=>{previewLanguage=event.target.value;updatePreview();};
    dialog.querySelector('[data-preview-screen]').onchange=event=>{previewScreen=event.target.value;updatePreview();};
    dialog.querySelector('[data-save-draft]').onclick=save;
    dialog.querySelector('[data-review]').onclick=review;
    dialog.querySelector('[data-discard]').onclick=discard;
    dialog.querySelector('[data-reload-latest]').onclick=async()=>{if(busy||confirming)return;confirming=true;const yes=await confirmation('Reload the latest settings?','Your edits on this screen will be replaced with the latest saved draft.','Reload latest');confirming=false;if(yes)await load();};
    const newError=content.querySelector('[data-editor-error]'),headerError=dialog.querySelector('.app-editor-header [data-editor-error]');
    if(headerError)newError.remove();else dialog.querySelector('.app-editor-header>div').append(newError);
    renderCopy();renderVideos();for(const input of retainedFiles)dialog.querySelector(`[data-video-file="${input.dataset.videoFile}"]`)?.replaceWith(input);updatePreview();updateStatus();syncBusy();
  }
  function change(control){
    const [section,key]=control.dataset.setting.split('.');
    model[section][key]=control.type==='checkbox'?control.checked:control.type==='number'?(control.value===''?null:Number(control.value)):key==='logoMediaId'?control.value||null:control.value;
    if(section==='brand'&&['primaryColor','accentColor'].includes(key)&&/^#[\da-f]{6}$/i.test(control.value))dialog.querySelector(`[data-colour="${key}"]`).value=control.value;
    control.removeAttribute('aria-invalid');updatePreview();updateStatus();
  }
  function renderCopy(){
    const container=dialog.querySelector('.app-editor-copy-fields');
    container.innerHTML=copyFields.map(([key,label,max])=>`<label>${esc(label)}<textarea data-copy="${key}" maxlength="${max}" rows="${max>200?3:2}" placeholder="${esc(defaultLocalized(model,copyLanguage,key))}">${esc(model.copy[copyLanguage][key]||'')}</textarea></label>`).join('')+`<label>Suggested topics<textarea data-copy="topics" rows="4" placeholder="${esc(languages[copyLanguage].topics.join('\n'))}">${esc((model.copy[copyLanguage].topics||[]).join('\n'))}</textarea><small>One per line. Use 3–6 topics, up to 120 characters each, or leave blank for the original topics.</small></label>`;
    for(const control of container.querySelectorAll('[data-copy]'))control.oninput=()=>{const key=control.dataset.copy,value=control.value;if(!value.trim())delete model.copy[copyLanguage][key];else model.copy[copyLanguage][key]=key==='topics'?value.split('\n').map(line=>line.trim()).filter(Boolean):value;control.removeAttribute('aria-invalid');updatePreview();updateStatus();};
    syncBusy();
  }
  function renderVideos(){
    const container=dialog.querySelector('.app-editor-video-order');
    container.innerHTML=model.onboarding.introOrder.map((slug,index)=>`<li data-video="${slug}"><div class="app-editor-video-title"><strong>${index+1}. ${videos[slug]}</strong><div><button type="button" data-move-video="${slug}" data-direction="-1" aria-label="Move ${videos[slug]} earlier" ${index===0?'disabled':''}>↑</button><button type="button" data-move-video="${slug}" data-direction="1" aria-label="Move ${videos[slug]} later" ${index===2?'disabled':''}>↓</button></div></div><video controls playsinline preload="none" src="/intro/${slug}.mp4" aria-label="Preview ${videos[slug]} video"></video><label>Replace ${videos[slug].toLowerCase()} video<input type="file" data-video-file="${slug}" accept="video/mp4,.mp4"><small>MP4 file, up to 25 MB</small></label><button type="button" data-upload-video="${slug}">Review replacement</button><p data-video-status="${slug}" role="status"></p></li>`).join('');
    for(const button of container.querySelectorAll('[data-move-video]'))button.onclick=()=>{if(busy)return;const index=model.onboarding.introOrder.indexOf(button.dataset.moveVideo),other=index+Number(button.dataset.direction);if(other<0||other>2)return;[model.onboarding.introOrder[index],model.onboarding.introOrder[other]]=[model.onboarding.introOrder[other],model.onboarding.introOrder[index]];const rows=Object.fromEntries([...container.querySelectorAll('[data-video]')].map(row=>[row.dataset.video,row]));for(const [i,slug]of model.onboarding.introOrder.entries()){const row=rows[slug];container.append(row);row.querySelector('strong').textContent=`${i+1}. ${videos[slug]}`;row.querySelector('[data-direction="-1"]').disabled=i===0;row.querySelector('[data-direction="1"]').disabled=i===2;}updatePreview();updateStatus();};
    for(const button of container.querySelectorAll('[data-upload-video]'))button.onclick=()=>uploadVideo(button.dataset.uploadVideo);
    for(const input of container.querySelectorAll('[data-video-file]'))input.onchange=()=>updateStatus();
    syncBusy();
  }
  function updatePreview(){
    if(!model||!dialog.isConnected)return;
    const phone=dialog.querySelector('.app-editor-phone');if(!phone)return;
    const colour=(value,fallback)=>/^#[\da-f]{6}$/i.test(value)?value:fallback;
    phone.style.setProperty('--editor-header',colour(model.brand.primaryColor,'#075e54'));phone.style.setProperty('--editor-accent',colour(model.brand.accentColor,'#008069'));
    const logo=uuid(model.brand.logoMediaId)?'/api/media/'+model.brand.logoMediaId:'/rekha-portrait.png',text=key=>esc(localized(model,previewLanguage,key)).replace(/\n/g,'<br>');
    const head=`<header class="app-preview-header"><img src="${logo}" alt=""><div><strong>${esc(model.brand.name)}</strong><small>${text('tagline')}</small></div><span aria-hidden="true">${model.chat.voiceCallsEnabled?'☎':''}${model.chat.videoCallsEnabled?' ▣':''}</span></header>`;
    let screen='';
    if(previewScreen==='chat'){
      const topics=model.copy[previewLanguage].topics||languages[previewLanguage].topics;
      screen=`${head}<div class="app-preview-chat"><p class="app-preview-day">Today</p><div class="app-preview-bubble">${esc(model.brand.astrologerName)}<small>${text('reflection')}</small></div>${mockMessages.map(message=>`<div class="app-preview-bubble ${message.role==='user'?'is-customer':''}">${esc(message.body)}</div>`).join('')}<div class="app-preview-topics">${topics.map(topic=>`<button type="button" data-mock-topic="${esc(topic)}" ${model.chat.customerMessagingEnabled?'':'disabled'}>${esc(topic)}</button>`).join('')}</div></div><form class="app-preview-compose"><span aria-hidden="true">${model.chat.attachmentsEnabled?'⌁':''}${model.chat.voiceNotesEnabled?' ♩':''}</span><input name="mock-message" aria-label="Preview message" maxlength="300" placeholder="${esc(localized(model,previewLanguage,'messagePlaceholder'))}" value="${esc(mockInput)}" ${model.chat.customerMessagingEnabled?'':'disabled'}><button type="submit" aria-label="Send preview message" ${model.chat.customerMessagingEnabled?'':'disabled'}>↑</button></form>${!model.chat.customerMessagingEnabled?'<p class="app-preview-footnote">Customer messages are turned off.</p>':''}`;
    }else if(previewScreen==='welcome')screen=`<div class="app-preview-page"><img class="app-preview-brand-image" src="${logo}" alt=""><h4>${esc(model.brand.name)}</h4><p>${model.onboarding.introEnabled?'Your welcome video order:':'Welcome videos are turned off.'}</p>${model.onboarding.introEnabled?`<ol>${model.onboarding.introOrder.map(slug=>`<li>${videos[slug]}</li>`).join('')}</ol>`:''}<span class="app-preview-button">Continue</span></div>`;
    else if(previewScreen==='language')screen=`<div class="app-preview-page"><h4>${text('languageTitle')}</h4><p>${text('languageSubtitle')}</p>${Object.values(languageNames).map(label=>`<div class="app-preview-fake-input">${esc(label)}</div>`).join('')}<span class="app-preview-button">Continue</span></div>`;
    else if(previewScreen==='details')screen=`<div class="app-preview-page"><h4>${text('detailsTitle')}</h4><p>${text('detailsSubtitle')}</p><div class="app-preview-fake-input">Your name</div><div class="app-preview-fake-input">Date of birth</div><p class="app-preview-important">${text('kundli')}</p><p>${text('kundliNote')}</p><span class="app-preview-button">Continue</span></div>`;
    else if(previewScreen==='permissions')screen=`<div class="app-preview-page"><h4>${text('permissionsTitle')}</h4><p>${text('permissionsSubtitle')}</p><div class="app-preview-fake-input">Optional location</div><div class="app-preview-fake-input">Remember this chat</div><span class="app-preview-button">Continue without optional access</span></div>`;
    else screen=`${head}<div class="app-preview-page"><h4>${text('offerTitle')}</h4><p>${text('offerText')}</p><strong class="app-preview-price">₹${esc(model.service.unlockPriceRupees)}</strong><span class="app-preview-button">Preview unlock · no charge</span><p class="app-preview-important">No real payment is collected.</p><small>${esc(model.service.freeReplies)} free replies · ${esc(model.service.retentionDays)} inactive days</small></div>`;
    phone.innerHTML=screen;
    phone.querySelector('.app-preview-compose')?.addEventListener('submit',event=>{event.preventDefault();mockSend(phone.querySelector('[name="mock-message"]').value);});
    phone.querySelector('[name="mock-message"]')?.addEventListener('input',event=>mockInput=event.target.value);
    for(const button of phone.querySelectorAll('[data-mock-topic]'))button.onclick=()=>mockSend(button.dataset.mockTopic);
  }
  function mockSend(body){
    if(!model.chat.customerMessagingEnabled||!body.trim())return;
    mockMessages.push({role:'user',body:body.trim()},{role:'owner',body:previewLanguage==='hi'?'यह केवल प्रीव्यू उत्तर है।':previewLanguage==='hinglish'?'Yeh sirf preview reply hai.':'This is a preview reply.'});
    mockMessages=mockMessages.slice(-6);mockInput='';updatePreview();
  }
  function updateStatus(){
    if(!model||!dialog.isConnected)return;
    const target=dialog.querySelector('[data-editor-status]');if(!target)return;
    dialog.querySelector('[data-editor-error]').textContent=error;
    dialog.querySelector('[data-reload-latest]').hidden=!conflict;
    const hasChanges=changedFields(normalized(state.published),model).length>0;
    target.textContent=busy?'Working…':dirty()?'Unsaved edits. Save your draft before publishing.':hasChanges?'Draft saved. Customers still see the published version.':'Your draft matches the published app.';
    if(!busy&&pendingVideos())target.textContent+=' A selected video is waiting for replacement review.';
    syncBusy();
  }
  function syncBusy(){
    dialog.setAttribute('aria-busy',String(busy));
    dialog.querySelector('[data-editor-close]').disabled=busy;
    for(const control of dialog.querySelectorAll('.app-editor-form input,.app-editor-form select,.app-editor-form textarea,.app-editor-form button,.app-editor-footer button,[data-reload-latest]'))control.disabled=busy;
    for(const button of dialog.querySelectorAll('[data-move-video]')){const index=model?.onboarding.introOrder.indexOf(button.dataset.moveVideo);button.disabled=busy||(Number(button.dataset.direction)<0?index===0:index===2);}
    const review=dialog.querySelector('[data-review]');if(review)review.disabled=busy||dirty()||!changedFields(normalized(state.published),model).length;
    const discard=dialog.querySelector('[data-discard]');if(discard)discard.disabled=busy||(!dirty()&&!changedFields(normalized(state.published),saved).length);
  }
  function build(){
    const draft=clone(model);
    for(const key of ['name','astrologerName','tagline'])draft.brand[key]=draft.brand[key].trim();
    for(const language of Object.keys(languageNames))for(const [key,value]of Object.entries(draft.copy[language]))draft.copy[language][key]=Array.isArray(value)?value.map(item=>item.trim()):value.trim();
    return draft;
  }
  function validate(){
    const invalid=(section,path,message,language)=>{tab=section;for(const button of dialog.querySelectorAll('[data-editor-tab]'))button.setAttribute('aria-pressed',String(button.dataset.editorTab===section));for(const node of dialog.querySelectorAll('[data-editor-section]'))node.hidden=node.dataset.editorSection!==section;if(language&&language!==copyLanguage){copyLanguage=language;renderCopy();for(const button of dialog.querySelectorAll('[data-copy-language]'))button.setAttribute('aria-pressed',String(button.dataset.copyLanguage===language));}const control=dialog.querySelector(path);control?.setAttribute('aria-invalid','true');control?.focus();error=message;updateStatus();return false;};
    for(const [key,max]of [['name',60],['astrologerName',60],['tagline',120]])if(typeof model.brand[key]!=='string'||!model.brand[key].trim()||model.brand[key].length>max)return invalid('brand',`[data-setting="brand.${key}"]`,`${settingLabel('brand.'+key)} needs 1–${max} characters.`);
    for(const key of ['name','astrologerName','tagline'])if(invalidText(model.brand[key]))return invalid('brand',`[data-setting="brand.${key}"]`,'Use plain text without HTML or angle brackets.');
    for(const key of ['primaryColor','accentColor'])if(!/^#[\da-f]{6}$/i.test(model.brand[key]))return invalid('brand',`[data-setting="brand.${key}"]`,'Use a six-digit colour, such as #075e54.');
    if(model.brand.logoMediaId&&!library.some(item=>item.id===model.brand.logoMediaId&&item.type==='image'&&!item.archived&&!item.url))return invalid('brand','[data-setting="brand.logoMediaId"]','Choose an available uploaded image or use the original Rekha image.');
    for(const [key,label,min,max]of serviceFields)if(!Number.isSafeInteger(model.service[key])||model.service[key]<min||model.service[key]>max)return invalid('copy',`[data-setting="service.${key}"]`,`${label} must be a whole number from ${min} to ${max}.`);
    for(const language of Object.keys(languageNames)){
      for(const [key,label,max]of copyFields){const value=model.copy[language][key];if(value!==undefined&&(typeof value!=='string'||!value.trim()||value.length>max))return invalid('copy',`[data-copy="${key}"]`,`${languageNames[language]}: ${label} needs 1–${max} characters, or leave it blank for the default.`,language);}
      for(const [key]of copyFields)if(model.copy[language][key]!==undefined&&invalidText(model.copy[language][key]))return invalid('copy',`[data-copy="${key}"]`,'Use plain text without HTML or angle brackets.',language);
      const topics=model.copy[language].topics;if(topics!==undefined&&(!Array.isArray(topics)||topics.length<3||topics.length>6||topics.some(topic=>typeof topic!=='string'||!topic.trim()||topic.length>120)))return invalid('copy','[data-copy="topics"]',`${languageNames[language]}: use 3–6 topics, up to 120 characters each, or leave them blank.`,language);
      if(topics?.some(invalidText))return invalid('copy','[data-copy="topics"]','Use plain-text topics without HTML or angle brackets.',language);
    }
    return true;
  }
  async function save(){
    if(busy||!validate())return;busy=true;error='';updateStatus();
    try{const response=await api('/api/admin/app-settings','PATCH',{draft:build(),revision:state.revision});apply(response);render();notice('App draft saved. It has not been published.');}
    catch(failure){setError(failure);}
    finally{busy=false;updateStatus();}
  }
  async function refreshImages(){
    if(busy)return;busy=true;syncBusy();
    try{const response=await api('/api/admin/library');library=Array.isArray(response)?response:response.items||[];libraryError='';dialog.querySelector('[data-setting="brand.logoMediaId"]').innerHTML=logoOptions();dialog.querySelector('[data-library-error]').textContent='';}
    catch(failure){libraryError=failure.message||'Could not refresh images.';dialog.querySelector('[data-library-error]').textContent=libraryError;}
    finally{busy=false;updateStatus();}
  }
  function displayValue(value,path,settings){
    if(path==='brand.logoMediaId')return value?(library.find(item=>item.id===value)?.title||'Saved image'):'Original Rekha image';
    if(typeof value==='boolean')return value?'On':'Off';
    if(Array.isArray(value))return path==='onboarding.introOrder'?value.map(key=>videos[key]).join(' → '):value.join(' · ');
    if(value===undefined){const [,language,key]=path.split('.'),fallback=localized(settings,language,key);return 'Original default: '+(Array.isArray(fallback)?fallback.join(' · '):fallback);}
    return String(value);
  }
  async function review(){
    if(busy||dirty()||confirming)return;
    const changes=changedFields(normalized(state.published),model);if(!changes.length)return;
    confirming=true;let publishing=false;
    const reviewDialog=createDialog('Review before publishing',()=>{if(!publishing)reviewDialog.close();});reviewDialog.classList.add('app-editor-review');
    const content=reviewDialog.querySelector('.app-editor-content');
    content.innerHTML=`<p>${changes.length} ${changes.length===1?'change':'changes'} will update your customer app. Your private conversations stay in the inbox.</p><p class="app-editor-warning">Payments remain in preview with no real charges. Advertising stays off.</p>${changes.some(change=>change.path==='brand.logoMediaId'&&change.after)?'<p class="app-editor-warning">The selected image becomes public when you publish it as the app image.</p>':''}<div class="app-editor-change-list">${changes.map(change=>`<article><h3>${esc(settingLabel(change.path))}</h3><div><p><small>Published now</small>${esc(displayValue(change.before,change.path,normalized(state.published)))}</p><p><small>After publishing</small>${esc(displayValue(change.after,change.path,model))}</p></div></article>`).join('')}</div><p class="app-editor-error" data-publish-error role="alert"></p><footer class="app-editor-confirm-actions"><button type="button" data-publish class="primary">Publish these changes</button><button type="button" data-publish-cancel>Keep as draft</button></footer>`;
    content.querySelector('[data-publish-cancel]').onclick=()=>{if(!publishing)reviewDialog.close();};
    content.querySelector('[data-publish]').onclick=async()=>{
      if(publishing)return;publishing=true;busy=true;syncBusy();for(const button of reviewDialog.querySelectorAll('button'))button.disabled=true;
      try{const response=await api('/api/admin/app-settings/publish','POST',{revision:state.revision});apply(response);render();reviewDialog.close();notice('Your app changes are published.');}
      catch(failure){content.querySelector('[data-publish-error]').textContent=failure.message||'Could not publish. Your saved draft is still available.';setError(failure);}
      finally{publishing=false;busy=false;for(const button of reviewDialog.querySelectorAll('button'))button.disabled=false;updateStatus();}
    };
    reviewDialog.addEventListener('close',()=>{confirming=false;},{once:true});
  }
  async function discard(){
    if(busy||confirming)return;confirming=true;
    const yes=await confirmation('Discard this draft?','Your saved draft and edits on this screen will be replaced by the currently published app settings.','Discard draft');confirming=false;if(!yes)return;
    busy=true;updateStatus();
    try{apply(await api('/api/admin/app-settings/discard','POST',{revision:state.revision}));render();notice('Draft reset to your published app.');}
    catch(failure){setError(failure);}
    finally{busy=false;updateStatus();}
  }
  async function uploadVideo(slug){
    if(busy||confirming)return;
    const input=dialog.querySelector(`[data-video-file="${slug}"]`),file=input.files?.[0],status=dialog.querySelector(`[data-video-status="${slug}"]`);
    if(!file){status.textContent='Choose an MP4 file first.';return;}
    if((file.type&&file.type!=='video/mp4')||!file.name.toLowerCase().endsWith('.mp4')||file.size<1||file.size>25*1048576){status.textContent='Use an MP4 video no larger than 25 MB.';return;}
    confirming=true;const yes=await confirmation('Replace '+videos[slug]+' video?',`${file.name} (${(file.size/1048576).toFixed(1)} MB) will replace this video immediately for customers. This file change does not wait for Publish. Other unsaved edits remain here.`,'Replace video now');confirming=false;if(!yes)return;
    busy=true;syncBusy();status.textContent='Uploading video…';
    try{
      const response=await fetch(`/api/admin/intro/${slug}`,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'video/mp4'},body:file,signal:AbortSignal.timeout(120000)});
      const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'The video could not be uploaded.'),{status:response.status});
      status.textContent='Video replaced. Your other edits are still in this draft.';input.value='';dialog.querySelector(`[data-video="${slug}"] video`).src=`/intro/${slug}.mp4?updated=${Date.now()}`;notice(videos[slug]+' video replaced.');
    }catch(failure){status.textContent=(failure.message||'Upload failed.')+' Your selected file and draft are preserved.';}
    finally{busy=false;updateStatus();}
  }
  await load();
}
