const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const privateAudio=value=>typeof value==='string'&&/^\/api\/(?:media|attachments)\/[a-f0-9-]{36}$/.test(value);
const bindings=new WeakMap();
const playIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" fill="currentColor"/></svg>';
const pauseIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z" fill="currentColor"/></svg>';
export const voiceTime=seconds=>{const value=Number.isFinite(seconds)&&seconds>=0?Math.floor(seconds):0;return `${Math.floor(value/60)}:${String(value%60).padStart(2,'0')}`;};
export function voiceProgress(current,duration){return Number.isFinite(current)&&Number.isFinite(duration)&&duration>0?Math.min(1,Math.max(0,current/duration)):0;}
// These bars come from the supplied audio samples. Until decoding finishes,
// the player draws a plain progress line rather than inventing a waveform.
export function voiceWaveformPeaks(channels,bins=54){
  const usable=(channels||[]).filter(channel=>channel&&Number.isSafeInteger(channel.length)&&channel.length>0),length=Math.max(0,...usable.map(channel=>channel.length)),count=Math.max(1,Math.min(128,Math.floor(bins)||54));
  if(!length)return [];
  return Array.from({length:count},(_,index)=>{const start=Math.floor(index*length/count),end=Math.max(start+1,Math.floor((index+1)*length/count)),stride=Math.max(1,Math.floor((end-start)/1000));let peak=0;for(const channel of usable)for(let sample=start;sample<Math.min(end,channel.length);sample+=stride){const value=Math.abs(channel[sample]);if(Number.isFinite(value))peak=Math.max(peak,value);}return Math.min(1,peak);});
}
export function voiceNoteBody({url,title='Voice message'}={}){
  if(!privateAudio(url))return '<p class="media-unavailable-note">Voice message unavailable.</p>';
  return `<div class="media-preview recorded-voice-note" data-recorded-voice data-voice-title="${escape(title)}"><audio preload="metadata" src="${url}" aria-label="${escape(title)}"></audio><button type="button" class="voice-play" data-voice-toggle aria-label="Play voice message" aria-pressed="false">${playIcon}</button><div class="voice-detail"><div class="voice-track"><canvas data-voice-waveform width="216" height="34" aria-hidden="true"></canvas><input type="range" class="voice-seek" data-voice-seek min="0" max="1000" step="1" value="0" aria-label="Seek voice message" disabled></div><div class="voice-meta"><time data-voice-time>0:00</time><span class="voice-kind">Voice message</span><span data-voice-duration aria-label="Audio duration">…</span></div><span class="voice-status" data-voice-status role="status"></span></div></div>`;
}
export function createVoiceNotePlayer(root,{fetcher=globalThis.fetch,createDecoder=()=>{const Context=globalThis.AudioContext||globalThis.webkitAudioContext;return Context?new Context():null;},setFrame=callback=>globalThis.requestAnimationFrame?.(callback)??setTimeout(callback,250),clearFrame=id=>{if(globalThis.cancelAnimationFrame)globalThis.cancelAnimationFrame(id);else clearTimeout(id);}}={}){
  const audio=root.querySelector('audio'),button=root.querySelector('[data-voice-toggle]'),seek=root.querySelector('[data-voice-seek]'),clock=root.querySelector('[data-voice-time]'),total=root.querySelector('[data-voice-duration]'),status=root.querySelector('[data-voice-status]'),canvas=root.querySelector('[data-voice-waveform]');
  if(!audio||!button||!seek)return null;
  let destroyed=false,starting=false,playToken=0,frame=null,peaks=[],waveformStarted=false,abort=null,decoder=null,scrubbing=false;
  const events=[];
  function listen(target,event,handler){target.addEventListener(event,handler);events.push([target,event,handler]);}
  function draw(){
    const context=canvas?.getContext?.('2d');if(!context)return;const width=canvas.width,height=canvas.height,progress=voiceProgress(audio.currentTime,audio.duration);context.clearRect(0,0,width,height);
    const accent=globalThis.getComputedStyle?.(root)?.getPropertyValue('--chat-accent')?.trim()||globalThis.getComputedStyle?.(root)?.getPropertyValue('--brand-accent')?.trim()||'#008069';
    if(!peaks.length){context.fillStyle='#b5c2c8';context.fillRect(0,Math.floor(height/2)-1,width,3);context.fillStyle=accent;context.fillRect(0,Math.floor(height/2)-1,width*progress,3);return;}
    const spacing=width/peaks.length;for(let index=0;index<peaks.length;index++){const bar=Math.max(2,peaks[index]*(height-4));context.fillStyle=index/peaks.length<progress?accent:'#aab8bf';context.fillRect(index*spacing,Math.floor((height-bar)/2),Math.max(1,spacing-2),bar);}
  }
  function refresh(){
    if(destroyed)return;const playing=!audio.paused&&!audio.ended,valid=Number.isFinite(audio.duration)&&audio.duration>0;
    button.innerHTML=playing||starting?pauseIcon:playIcon;button.setAttribute('aria-label',playing||starting?'Pause voice message':'Play voice message');button.setAttribute('aria-pressed',String(playing));button.setAttribute('aria-busy',String(starting));
    root.classList.toggle('is-playing',playing);clock.textContent=voiceTime(audio.currentTime);total.textContent=valid?voiceTime(audio.duration):'…';seek.disabled=!valid;
    if(!scrubbing)seek.value=String(Math.round(voiceProgress(audio.currentTime,audio.duration)*1000));seek.setAttribute('aria-valuetext',`${voiceTime(audio.currentTime)} of ${valid?voiceTime(audio.duration):'unknown duration'}`);draw();
  }
  function stopFrame(){if(frame!==null)clearFrame(frame);frame=null;}
  function animate(){stopFrame();if(destroyed||audio.paused||audio.ended)return;frame=setFrame(()=>{frame=null;if(root.isConnected===false){player.destroy();return;}refresh();animate();});}
  async function waveform(){
    if(waveformStarted||destroyed||!fetcher)return;waveformStarted=true;const source=audio.getAttribute('src');if(!privateAudio(source))return;
    abort=new AbortController();
    try{decoder=createDecoder();if(!decoder)return;const response=await fetcher(source,{credentials:'same-origin',signal:abort.signal});if(!response.ok||Number(response.headers?.get?.('Content-Length'))>20*1048576)return;const bytes=await response.arrayBuffer();if(destroyed||bytes.byteLength>20*1048576)return;const decoded=await decoder.decodeAudioData(bytes);if(destroyed)return;peaks=voiceWaveformPeaks(Array.from({length:decoded.numberOfChannels},(_,index)=>decoded.getChannelData(index)));refresh();}catch{/* Playback remains usable if waveform decoding is unsupported. */}finally{try{await decoder?.close?.();}catch{}decoder=null;abort=null;}
  }
  async function toggle(){
    if(destroyed)return;
    if(!audio.paused||starting){playToken++;starting=false;audio.pause();refresh();return;}
    const token=++playToken;starting=true;status.textContent='';refresh();
    try{if(audio.ended)audio.currentTime=0;await audio.play();if(destroyed||token!==playToken){audio.pause();return;}void waveform();}catch(error){if(destroyed||token!==playToken)return;status.textContent=error.name==='NotAllowedError'?'Tap play again to listen.':'Could not play this voice message. Try again.';}finally{if(token===playToken){starting=false;refresh();}}
  }
  function changeSeek(){if(destroyed||!Number.isFinite(audio.duration)||audio.duration<=0)return;const value=Math.min(1000,Math.max(0,Number(seek.value)||0));audio.currentTime=value/1000*audio.duration;refresh();}
  listen(button,'click',toggle);listen(seek,'input',changeSeek);listen(seek,'change',changeSeek);listen(seek,'pointerdown',()=>scrubbing=true);listen(seek,'pointerup',()=>{scrubbing=false;refresh();});listen(seek,'pointercancel',()=>{scrubbing=false;refresh();});listen(seek,'blur',()=>{scrubbing=false;refresh();});
  for(const event of ['durationchange','timeupdate','seeked','loadstart'])listen(audio,event,refresh);
  listen(audio,'loadedmetadata',()=>{status.textContent='';refresh();});
  listen(audio,'play',()=>{status.textContent='';refresh();animate();});listen(audio,'pause',()=>{stopFrame();refresh();});listen(audio,'ended',()=>{stopFrame();refresh();});listen(audio,'error',()=>{stopFrame();starting=false;status.textContent='Could not load this voice message. Use Retry below.';refresh();});
  const player={refresh,destroy(){if(destroyed)return;destroyed=true;playToken++;starting=false;stopFrame();abort?.abort();try{Promise.resolve(decoder?.close?.()).catch(()=>{});}catch{}for(const [target,event,handler]of events)target.removeEventListener(event,handler);audio.pause();}};
  refresh();return player;
}
export function bindVoiceNotes(container){
  let binding=bindings.get(container);if(!binding){binding=new Map();bindings.set(container,binding);}
  for(const [root,player]of binding)if(!container.contains(root)){player.destroy();binding.delete(root);}
  for(const root of container.querySelectorAll('[data-recorded-voice]')){let player=binding.get(root);if(!player){player=createVoiceNotePlayer(root);if(player)binding.set(root,player);}player?.refresh();}
}
