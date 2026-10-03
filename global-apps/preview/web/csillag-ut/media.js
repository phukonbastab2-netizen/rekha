const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bindings=new WeakMap();let viewerNumber=0;
export function mediaItems(message){try{const data=JSON.parse(message.body);return message.kind==='media'&&Array.isArray(data.items)?data.items:[];}catch{return [];}}
export function attachmentUrl(value){return /^\/api\/(?:media|attachments)\/[a-f0-9-]{36}$/.test(value||'')?value:null;}
export function safeMediaLink(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}}
export function mediaSize(value){const size=Number(value);if(!Number.isFinite(size)||size<=0)return '';if(size<1024)return `${size} B`;if(size<1048576)return `${Math.round(size/1024)} KB`;return `${(size/1048576).toFixed(1)} MB`;}
function duration(seconds){return Number.isFinite(seconds)&&seconds>0?`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`:'';}
const labels={image:'Photo',video:'Video',audio:'Audio',document:'PDF document',pdf:'PDF document',link:'Link'};
const kindLabel=type=>labels[type]||'Attachment';
const titleOf=item=>String(item?.title||item?.name||({image:'Photo',video:'Video clip',audio:'Voice message',document:'Document.pdf',pdf:'Document.pdf',link:'Shared link'})[item?.type]||'Attachment');
const statusMarkup=()=>'<div class="media-status" hidden><span role="status"></span><button type="button" data-retry-media>Retry</button></div>';
function mediaCard(item,index,total){
  const data=item&&typeof item==='object'?item:{},type=data.type||'',title=titleOf(data),source=type==='link'?safeMediaLink(data.url):attachmentUrl(data.url),label=kindLabel(type),size=mediaSize(data.size);
  const attrs=`data-media-type="${escape(type)}" data-media-title="${escape(title)}" data-media-src="${escape(source||'')}" data-media-index="${index}" data-media-size="${escape(size)}"`;
  const ordinal=total>1?`<span class="media-order" aria-label="Attachment ${index+1} of ${total}">${String(index+1).padStart(2,'0')}</span>`:'';
  const info=`<figcaption class="media-info">${ordinal}<span class="media-file-name">${escape(title)}<small>${label}${size?' · '+size:''}<span class="media-duration"></span></small></span>${source&&type!=='link'?`<button type="button" class="media-expand" data-open-media="${index}" aria-label="Open ${escape(title)}" title="Open attachment">⤢</button>`:''}</figcaption>`;
  if(!source||!labels[type])return `<figure class="media-card media-unavailable" ${attrs}>${info}<p class="media-unavailable-note">This attachment is unavailable.</p></figure>`;
  let preview='';
  if(type==='image')preview=`<button type="button" class="image-open media-preview" data-open-media="${index}" data-media-url="${source}" data-media-title="${escape(title)}" aria-label="Open ${escape(title)}"><img src="${source}" alt="${escape(title)}" loading="lazy"></button>`;
  if(type==='video')preview=`<div class="media-preview"><video controls playsinline preload="none" src="${source}" aria-label="${escape(title)}"></video></div>`;
  if(type==='audio')preview=`<div class="media-preview voice-note"><audio controls preload="none" src="${source}" aria-label="${escape(title)}"></audio></div>`;
  if(type==='document'||type==='pdf')preview=`<a class="document-message media-document" href="${source}" target="_blank" rel="noopener noreferrer" download="${escape(title)}"><span aria-hidden="true">▤</span><span>Open PDF<small>Private attachment</small></span><span aria-hidden="true">↓</span></a>`;
  if(type==='link')preview=`<a class="media-link" href="${escape(source)}" target="_blank" rel="noopener noreferrer"><span aria-hidden="true">↗</span> Open link<small>${escape(new URL(source).hostname)}</small></a>`;
  return `<figure class="media-card" ${attrs}>${preview}${info}${statusMarkup()}</figure>`;
}
export function messageBody(message){
  if(message.deleted)return '<span class="deleted-message">This message was deleted</span>';
  if(message.kind!=='media')return escape(message.body);
  try{const data=JSON.parse(message.body);if(!Array.isArray(data.items))throw Error();
    const title=data.title?`<h3>${escape(data.title)}</h3>`:'',collection=data.items.length>1?`<div class="media-collection-head"><span>${data.items.length} attachments · in order</span><button type="button" data-open-collection>View collection</button></div>`:'';
    return `<div class="media-message" data-media-message>${data.text?`<p>${escape(data.text)}</p>`:''}${title}${collection}<div class="media-collection" role="list" aria-label="${escape(data.title||'Shared attachments')}">${data.items.map((item,index)=>`<div class="media-list-item" role="listitem">${mediaCard(item,index,data.items.length)}</div>`).join('')}</div>${data.items.length?'':'<p class="media-unavailable-note">No attachments are available.</p>'}</div>`;
  }catch{return '<span class="media-unavailable-note">Media unavailable.</span>';}
}
function stopPlayers(container){for(const player of container.querySelectorAll('audio,video')){player.pause();player.removeAttribute('src');player.load();}}
function statusOf(card,failed){if(!card)return;const status=card.querySelector('.media-status');card.classList.toggle('media-failed',failed);if(status){status.hidden=!failed;status.querySelector('[role="status"]').textContent=failed?'Could not load this attachment. Try again.':'';}}
function retryCard(card){const source=attachmentUrl(card?.dataset.mediaSrc);if(!source)return;statusOf(card,false);for(const media of card.querySelectorAll('img,audio,video')){if(media.tagName==='IMG'){media.removeAttribute('src');media.src=source;}else{media.pause();media.src=source;media.load();}}}
function bindMedia(container){
  if(bindings.has(container))return bindings.get(container);const binding={viewer:null,container};bindings.set(container,binding);
  container.addEventListener('click',event=>{const retry=event.target.closest('[data-retry-media]');if(retry){event.preventDefault();event.stopImmediatePropagation();retryCard(retry.closest('.media-card'));return;}const opener=event.target.closest('[data-open-media],[data-open-collection]');if(!opener)return;const collection=opener.closest('[data-media-message]');if(!collection)return;event.preventDefault();event.stopImmediatePropagation();openViewer(collection,Number(opener.dataset.openMedia||0),binding);},true);
  container.addEventListener('error',event=>{if(['IMG','VIDEO','AUDIO'].includes(event.target.tagName))statusOf(event.target.closest('.media-card'),true);},true);
  container.addEventListener('load',event=>{if(event.target.tagName==='IMG')statusOf(event.target.closest('.media-card'),false);},true);
  container.addEventListener('loadedmetadata',event=>{if(!['VIDEO','AUDIO'].includes(event.target.tagName))return;const card=event.target.closest('.media-card');statusOf(card,false);const target=card?.querySelector('.media-duration'),formatted=duration(event.target.duration);if(target)target.textContent=formatted?' · '+formatted:'';},true);
  return binding;
}
function openViewer(collection,start,binding){
  binding.viewer?.close();const items=[...collection.querySelectorAll('.media-card')].map(card=>({...card.dataset}));if(!items.length)return;const sourceMessage=collection.closest('[data-message]');let index=Math.max(0,Math.min(start,items.length-1)),closed=false;
  for(const player of collection.querySelectorAll('audio,video'))player.pause();
  const modal=document.createElement('dialog'),titleId='media-viewer-title-'+(++viewerNumber);modal.className='media-viewer';modal.setAttribute('aria-labelledby',titleId);
  modal.innerHTML=`<header class="media-viewer-head"><div><span class="media-viewer-count"></span><h2 id="${titleId}"></h2></div><button type="button" class="viewer-fullscreen" aria-label="Enter fullscreen" title="Fullscreen">⤢</button><button type="button" class="viewer-close" data-close aria-label="Close attachment viewer">×</button></header><div class="media-viewer-stage"></div><footer class="media-viewer-footer"><button type="button" class="viewer-prev" aria-label="Previous attachment">‹ Previous</button><span class="media-viewer-details"></span><button type="button" class="viewer-next" aria-label="Next attachment">Next ›</button></footer>`;
  document.body.append(modal);binding.viewer=modal;const stage=modal.querySelector('.media-viewer-stage'),previous=modal.querySelector('.viewer-prev'),next=modal.querySelector('.viewer-next'),full=modal.querySelector('.viewer-fullscreen');
  function render(){
    stopPlayers(stage);const item=items[index],type=item.mediaType,source=type==='link'?safeMediaLink(item.mediaSrc):attachmentUrl(item.mediaSrc),title=item.mediaTitle||'Attachment';
    modal.querySelector('h2').textContent=title;modal.querySelector('.media-viewer-count').textContent=`${index+1} of ${items.length}`;modal.querySelector('.media-viewer-details').textContent=[kindLabel(type),item.mediaSize].filter(Boolean).join(' · ');previous.disabled=index===0;next.disabled=index===items.length-1;previous.hidden=next.hidden=items.length===1;
    let preview='<p class="media-unavailable-note">This attachment is unavailable.</p>';
    if(source&&type==='image')preview=`<img class="full-image" src="${source}" alt="${escape(title)}">`;
    if(source&&type==='video')preview=`<video class="viewer-player" controls playsinline preload="metadata" src="${source}" aria-label="${escape(title)}"></video>`;
    if(source&&type==='audio')preview=`<div class="viewer-audio"><span aria-hidden="true">♫</span><audio class="viewer-player" controls preload="metadata" src="${source}" aria-label="${escape(title)}"></audio></div>`;
    if(source&&(type==='document'||type==='pdf'))preview=`<div class="viewer-document"><span aria-hidden="true">▤</span><p>PDF document</p><a class="viewer-download" href="${source}" target="_blank" rel="noopener noreferrer" download="${escape(title)}">Open or download PDF</a></div>`;
    if(source&&type==='link')preview=`<div class="viewer-document"><span aria-hidden="true">↗</span><p>${escape(new URL(source).hostname)}</p><a class="viewer-download" href="${escape(source)}" target="_blank" rel="noopener noreferrer">Open link</a></div>`;
    stage.innerHTML=`<figure class="media-card viewer-media-card" data-media-src="${escape(source||'')}">${preview}${statusMarkup()}</figure>${source&&['image','video','audio'].includes(type)?`<a class="save-image viewer-download" href="${source}" download="${escape(title)}">Download ${kindLabel(type).toLowerCase()}</a>`:''}`;
  }
  previous.onclick=()=>{if(index>0){index--;render();}};next.onclick=()=>{if(index<items.length-1){index++;render();}};modal.querySelector('[data-close]').onclick=()=>modal.close();
  full.hidden=typeof modal.requestFullscreen!=='function';full.onclick=async()=>{try{if(document.fullscreenElement===modal)await document.exitFullscreen();else await modal.requestFullscreen();}catch{modal.querySelector('.media-viewer-details').textContent='Fullscreen is unavailable on this device.';}};
  modal.addEventListener('click',event=>{if(event.target===modal)modal.close();const retry=event.target.closest('[data-retry-media]');if(retry)retryCard(retry.closest('.media-card'));});
  modal.addEventListener('error',event=>{if(['IMG','VIDEO','AUDIO'].includes(event.target.tagName))statusOf(event.target.closest('.media-card'),true);},true);
  modal.addEventListener('load',event=>{if(event.target.tagName==='IMG')statusOf(event.target.closest('.media-card'),false);},true);
  modal.addEventListener('loadedmetadata',event=>{if(['VIDEO','AUDIO'].includes(event.target.tagName))statusOf(event.target.closest('.media-card'),false);},true);
  modal.addEventListener('keydown',event=>{if(['VIDEO','AUDIO','INPUT','TEXTAREA'].includes(event.target.tagName))return;if(event.key==='ArrowLeft'&&index>0){event.preventDefault();index--;render();}if(event.key==='ArrowRight'&&index<items.length-1){event.preventDefault();index++;render();}});
  const sourceId=sourceMessage?.dataset.message;
  const observer=new MutationObserver(()=>{const current=sourceId?[...binding.container.children].find(node=>node.dataset.message===sourceId):null;if(!binding.container.isConnected||(sourceId?!current?.querySelector('[data-media-message]'):!collection.isConnected))modal.close();});observer.observe(document.body,{childList:true,subtree:true});
  modal.addEventListener('close',()=>{if(closed)return;closed=true;observer.disconnect();stopPlayers(stage);if(document.fullscreenElement===modal)document.exitFullscreen().catch(()=>{});modal.remove();if(binding.viewer===modal)binding.viewer=null;},{once:true});
  render();modal.showModal();modal.querySelector('[data-close]').focus();
}
// Preserve player nodes during receipt/reaction updates; restore ordered search results.
export function syncThread(container,html){
  const binding=bindMedia(container),template=document.createElement('template');template.innerHTML=html;const old=new Map([...container.children].map(el=>[el.dataset.message,el]));let index=0;
  for(const fresh of template.content.children){const previous=old.get(fresh.dataset.message);old.delete(fresh.dataset.message);let activeNode=previous;if(!previous)activeNode=fresh.cloneNode(true);else if(previous.outerHTML!==fresh.outerHTML){
    const replacement=fresh.cloneNode(true),players=[...previous.querySelectorAll('audio,video')],retained=new Set();for(const player of replacement.querySelectorAll('audio,video')){const match=players.find(oldPlayer=>!retained.has(oldPlayer)&&oldPlayer.tagName===player.tagName&&oldPlayer.getAttribute('src')===player.getAttribute('src'));if(match){retained.add(match);player.replaceWith(match);}}
    for(const player of players)if(!retained.has(player)){player.pause();player.removeAttribute('src');player.load();}previous.replaceWith(replacement);activeNode=replacement;
  }if(container.children[index]!==activeNode)container.insertBefore(activeNode,container.children[index]||null);index++;}
  for(const el of old.values()){stopPlayers(el);el.remove();}
  for(const card of container.querySelectorAll('.media-card')){const player=card.querySelector('audio,video'),image=card.querySelector('img');if(player?.error||image?.complete&&!image.naturalWidth)statusOf(card,true);else if(player?.readyState>=1){const formatted=duration(player.duration),target=card.querySelector('.media-duration');if(target)target.textContent=formatted?' · '+formatted:'';}}
  return binding;
}
