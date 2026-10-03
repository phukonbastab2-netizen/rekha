import {getFeatureMedia} from './permissions.js';
import {createVoiceEffectsSession,voicePresets} from './voice-effects.js';
import {createAdaptivePoll} from './adaptive-poll.js';
const svg=(video)=>video?'<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3 5h12v14H3zM16 9l6-4v14l-6-4z"/></svg>':'<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="m6 2 4 5-3 3c2 4 3 5 7 7l3-3 5 4-2 4C9 22 2 15 2 4z"/></svg>';
export function installCalls({role,getConversationId,notify,getAppSettings=()=>null}){
  const prefix=role==='admin'?'/api/admin/calls':'/api/calls';let active=null,pc=null,local=null,outbound=null,effects=null,captureController=null,muted=false,selectedPreset='natural',remote=new MediaStream(),cursor=0,queue=[],panel=null,polling=false,handling=false,timeout=null,config=null,generation=0,destroyed=false,outgoing=[],flushing=false,pendingAnswer=null;
  const callPoll=createAdaptivePoll({task:poll,canRun:()=>!destroyed&&(role==='admin'||Boolean(getConversationId()))&&(Boolean(active)||allowed('voice')||allowed('video')),hot:()=>Boolean(active),fastMs:6000,hotMs:1200,idleMs:15000});
  if(role==='admin'){try{const saved=localStorage.getItem('rekha-admin-call-voice');if(voicePresets.some(p=>p.id===saved))selectedPreset=saved;}catch{}}
  const api=async(route,method='GET',data,{signal}={})=>{const r=await fetch(prefix+route,{method,credentials:'same-origin',cache:'no-store',headers:method!=='GET'?{'Content-Type':'application/json'}:{},...(data!==undefined?{body:JSON.stringify(data)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});let value;try{value=await r.json();}catch{throw Object.assign(Error('The call connection returned an unreadable response.'),{status:r.status});}if(!r.ok)throw Object.assign(Error(value.error||'Call unavailable.'),{status:r.status});return value;};
  const label=()=>role==='admin'?'Customer':getAppSettings()?.brand?.astrologerName||getAppSettings()?.brand?.name||'Rekha Astrology';
  const valid=token=>!destroyed&&generation===token;
  const allowed=type=>getAppSettings()?.chat?.[type==='voice'?'voiceCallsEnabled':'videoCallsEnabled']!==false;
  function mount(container){if(destroyed||!container)return;for(const [type,title]of [['voice','Voice call'],['video','Video call']]){let button=container.querySelector(`.call-launch[data-call-type="${type}"]`);if(!button){button=document.createElement('button');button.type='button';button.className='call-launch';button.dataset.callType=type;button.title=title;button.setAttribute('aria-label',title);button.innerHTML=svg(type==='video');button.onclick=()=>start(type);container.append(button);}button.hidden=!allowed(type);}}
  function show(incoming=false){
    panel?.remove();panel=document.createElement('section');panel.className='call-panel';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label',active.type+' call');
    panel.innerHTML=`<h2>${active.type==='video'?'Video':'Voice'} call</h2><p class="call-status" role="status">${incoming?'Incoming call':'Opening microphone…'}</p><div class="call-videos"><video class="call-remote" autoplay playsinline></video><video class="call-local" autoplay playsinline muted></video></div>${role==='admin'?'<label class="call-voice-choice">Your voice <select class="call-voice-preset" aria-label="Call voice effect"></select></label><p class="call-voice-description">Generic voice effects run on this device. They do not copy another person’s voice.</p>':''}<p class="call-note">Both apps must stay open. Camera and microphone access are requested only when you start or answer.</p><div class="call-buttons">${incoming?'<button class="call-answer">Answer</button>':'<button class="call-mute" disabled>Mute</button>'}<button class="call-end">${incoming?'Decline':'End call'}</button></div>`;
    document.body.append(panel);panel.querySelector('.call-end').onclick=()=>end(incoming?'declined':'completed');
    panel.querySelector('h2').textContent=`${active.type==='video'?'Video':'Voice'} call · ${role==='admin'?(active.customerName||label()):label()}`;
    const selector=panel.querySelector('.call-voice-preset');if(selector){for(const preset of voicePresets){const option=document.createElement('option');option.value=preset.id;option.textContent=preset.name;selector.append(option);}selector.value=selectedPreset;selector.onchange=()=>{selectedPreset=selector.value;effects?.setPreset(selectedPreset);try{localStorage.setItem('rekha-admin-call-voice',selectedPreset);}catch{};};}
    if(incoming)panel.querySelector('.call-answer').onclick=answer;else bindMute();
  }
  function status(text){if(panel)panel.querySelector('.call-status').textContent=text;}
  function bindMute(){const button=panel?.querySelector('.call-mute');if(!button)return;button.disabled=!local;button.textContent=muted?'Unmute':'Mute';button.onclick=()=>{if(!local)return;muted=!muted;for(const track of local.getAudioTracks())track.enabled=!muted;for(const track of outbound?.getAudioTracks()||[])track.enabled=!muted;effects?.setMuted(muted);button.textContent=muted?'Unmute':'Mute';};}
  function prepareEffects(){
    if(role!=='admin'||effects)return;
    try{effects=createVoiceEffectsSession({preset:selectedPreset});}
    catch{selectedPreset='natural';const selector=panel?.querySelector('.call-voice-preset');if(selector){selector.value='natural';selector.disabled=true;}const note=panel?.querySelector('.call-voice-description');if(note)note.textContent='Voice effects are unavailable on this device. This call uses your natural voice.';}
  }
  function effectsUnavailable(){selectedPreset='natural';const selector=panel?.querySelector('.call-voice-preset');if(selector){selector.value='natural';selector.disabled=true;}const note=panel?.querySelector('.call-voice-description');if(note)note.textContent='Voice effects could not load. This call uses your natural voice.';notify('Voice effects are unavailable. Using your natural voice.');}
  async function media(token){
    const type=active.type,controller=new AbortController();captureController=controller;
    const stream=await getFeatureMedia(type==='video'?'video-call':'microphone',{audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:type==='video'?{facingMode:'user',width:{ideal:640},height:{ideal:480}}:false},{signal:controller.signal});
    if(!valid(token)||!active||!panel){for(const track of stream.getTracks())track.stop();return false;}
    local=stream;outbound=stream;
    if(effects){const session=effects;try{const processed=await session.attach(stream);if(!valid(token)||effects!==session||!active||!panel){session.destroy();for(const track of stream.getTracks())track.stop();for(const track of processed.getTracks())track.stop();return false;}outbound=processed;session.setMuted(muted);}catch(error){if(!valid(token))return false;session.destroy();effects=null;effectsUnavailable();}}
    panel.querySelector('.call-local').srcObject=local;
    return true;
  }
  async function setup(token){
    config ||= await api('/config');if(!valid(token)||!active||!local||!panel)return false;
    const peer=new RTCPeerConnection({iceServers:config.iceServers});pc=peer;remote=new MediaStream();panel.querySelector('.call-remote').srcObject=remote;
    for(const track of outbound.getTracks())pc.addTrack(track,outbound);
    peer.ontrack=event=>{if(!valid(token)||pc!==peer){event.track.stop();return;}if(!remote.getTracks().includes(event.track))remote.addTrack(event.track);panel?.querySelector('.call-remote')?.play().catch(()=>{});};
    peer.onicecandidate=event=>{if(event.candidate&&valid(token)&&pc===peer&&outgoing.length<200){outgoing.push({kind:'ice',payload:event.candidate.toJSON()});flushSignals(token);}};
    peer.onconnectionstatechange=()=>{if(!valid(token)||pc!==peer)return;const state=peer.connectionState;if(state==='connected'){status('Connected');clearTimeout(timeout);}else if(state==='failed')end('connection-failed','Could not connect. Some mobile networks require a configured call relay.');else if(state==='disconnected')status('Reconnecting…');};
    timeout=setTimeout(()=>{if(valid(token)&&peer.connectionState!=='connected')end('connection-failed','The other device could not connect. A call relay may be needed on this network.');},45000);
    bindMute();return true;
  }
  const signal=(kind,payload,callId=active?.id)=>callId?api('/'+callId+'/signals','POST',{kind,payload}):Promise.reject(Error('The call has ended.'));
  async function flushSignals(token){if(flushing||!valid(token)||!active)return;flushing=true;const callId=active.id;try{while(outgoing.length&&valid(token)&&active?.id===callId){const next=outgoing[0];await signal(next.kind,next.payload,callId);if(!valid(token))return;outgoing.shift();}}catch{if(valid(token))status('Connection paused. Retrying…');}finally{flushing=false;}}
  async function start(type){
    if(!allowed(type))return notify('This call option is currently paused.');
    if(destroyed||active||handling)return;const conversationId=getConversationId();if(!conversationId)return notify('Open a conversation first.');handling=true;const token=++generation;
    try{active={id:null,type,conversationId,caller:role==='admin'?'admin':'customer'};show();prepareEffects();if(!await media(token))return;status('Calling…');const call=await api('','POST',{type,conversationId});if(!valid(token)){await api('/'+call.id+'/end','POST',{reason:'cancelled'}).catch(()=>{});return;}active=call;if(!await setup(token))return;const peer=pc,offer=await peer.createOffer();if(!valid(token))return;await peer.setLocalDescription(offer);if(!valid(token))return;await signal('offer',{type:offer.type,sdp:offer.sdp},call.id);if(valid(token))beginPoll();}
    catch(error){if(valid(token))await end('connection-failed',error.name==='NotAllowedError'?'Microphone or camera access was declined. Open app settings to allow access.':error.name==='AbortError'?undefined:error.message);}finally{if(generation===token||!active)handling=false;}
  }
  async function answer(){
    if(destroyed||handling||!active||!panel)return;handling=true;panel.querySelector('.call-answer').disabled=true;const token=generation,callId=active.id;
    try{prepareEffects();status('Opening microphone…');if(!await media(token))return;const accepted=await api('/'+callId+'/accept','POST',{});if(!valid(token))return;active=accepted;if(!await setup(token))return;panel.querySelector('.call-buttons').innerHTML='<button class="call-mute">Mute</button><button class="call-end">End call</button>';panel.querySelector('.call-end').onclick=()=>end('completed');bindMute();status('Connecting…');cursor=0;beginPoll();}
    catch(error){if(valid(token))await end('connection-failed',error.name==='NotAllowedError'?'Microphone or camera access was declined. Open app settings to allow access.':error.name==='AbortError'?undefined:error.message);}finally{if(generation===token||!active)handling=false;}
  }
  function clean(){generation++;captureController?.abort();captureController=null;handling=false;clearTimeout(timeout);if(pc){pc.ontrack=null;pc.onicecandidate=null;pc.onconnectionstatechange=null;pc.close();}pc=null;effects?.destroy();effects=null;for(const track of outbound?.getTracks()||[])track.stop();outbound=null;for(const track of local?.getTracks()||[])track.stop();local=null;muted=false;for(const track of remote.getTracks())track.stop();remote=new MediaStream();panel?.remove();panel=null;active=null;cursor=0;queue=[];outgoing=[];pendingAnswer=null;}
  async function end(reason='completed',message){const call=active;clean();if(call?.id)await api('/'+call.id+'/end','POST',{reason}).catch(()=>{});if(message)notify(message);}
  function beginPoll(){callPoll.poke({immediate:true});}
  async function poll({signal:pollSignal}={}){
    if(destroyed||polling||document.hidden||navigator.onLine===false||active&&!active.id)return;polling=true;const token=generation,callId=active?.id;
    try{
      if(!active){const list=await api('','GET',undefined,{signal:pollSignal});if(!valid(token)||active)return;const incoming=list.calls.find(c=>c.caller!==(role==='admin'?'admin':'customer')&&c.status==='ringing');if(incoming){generation++;active=incoming;show(true);beginPoll();notify('Incoming '+incoming.type+' call.');}return{changed:!!incoming};}
      const data=await api('/'+callId+'/signals?after='+cursor,'GET',undefined,{signal:pollSignal});if(!valid(token)||active?.id!==callId)return;active=data.call;
      if(active.status==='ended'){const reason=active.reason;clean();notify(reason==='declined'?'Call declined.':reason==='expired'?'Call was not answered.':'Call ended.');return;}
      if(active.caller!==(role==='admin'?'admin':'customer')&&active.status==='ringing')return;
      if(!pc)return;
      for(const s of data.signals){
        if(!valid(token)||!pc)return;const peer=pc;
        if(s.kind==='offer'){if(!peer.remoteDescription){await peer.setRemoteDescription(s.payload);if(!valid(token))return;const answer=await peer.createAnswer();if(!valid(token))return;await peer.setLocalDescription(answer);if(!valid(token)||pc!==peer)return;pendingAnswer={type:answer.type,sdp:answer.sdp};}if(pendingAnswer){await signal('answer',pendingAnswer,callId);if(!valid(token))return;pendingAnswer=null;}}
        else if(s.kind==='answer'){if(!peer.remoteDescription)await peer.setRemoteDescription(s.payload);if(!valid(token)||pc!==peer)return;}
        else if(s.kind==='ice')queue.push(s.payload);
        cursor=Math.max(cursor,s.id);
      }
      if(pc.remoteDescription){const candidates=queue;queue=[];for(const candidate of candidates){if(!valid(token)||!pc)return;await pc.addIceCandidate(candidate).catch(()=>{});}}
      await flushSignals(token);
      return{changed:data.signals.length>0};
    }catch(error){if(pollSignal?.aborted)return;if(valid(token)&&active)status('Connection paused. Retrying…');throw error;}finally{polling=false;}
  }
  const onSettings=()=>{for(const button of document.querySelectorAll('.call-launch[data-call-type]'))button.hidden=!allowed(button.dataset.callType);if(active&&!allowed(active.type))end('cancelled','This call option was paused.');callPoll.poke();};window.addEventListener('rekha:app-settings',onSettings);
  callPoll.start({immediate:true});
  return {mount,poll:()=>callPoll.poke({immediate:true}),destroy:()=>{if(destroyed)return;destroyed=true;callPoll.destroy();window.removeEventListener('rekha:app-settings',onSettings);return end('cancelled');}};
}
