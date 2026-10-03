import {createVoiceEffect,voiceChoices} from './voice-effects.js';
import {createVoiceRelay} from './voice-relay.js';
const svg=(video)=>video?'<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3 5h12v14H3zM16 9l6-4v14l-6-4z"/></svg>':'<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="m6 2 4 5-3 3c2 4 3 5 7 7l3-3 5 4-2 4C9 22 2 15 2 4z"/></svg>';
export function installCalls({role,getConversationId,notify,createRelay=createVoiceRelay}){
  const prefix=role==='admin'?'/api/admin/calls':'/api/calls';let effect=null,effectUnsubscribe=null,refreshMicrophone=null,relaySession=null,rawFallback=false,voiceChoice='natural',active=null,pc=null,local=null,remote=new MediaStream(),cursor=0,queue=[],panel=null,polling=null,handling=null,timeout=null,reconnectTimeout=null,pollTimer=null,nextPollAt=0,generation=0,destroyed=false,outgoing=[],flushing=null,pendingAnswer=null;
  const api=async(route,method='GET',data)=>{const r=await fetch(prefix+route,{method,credentials:'same-origin',cache:'no-store',headers:method!=='GET'?{'Content-Type':'application/json'}:{},...(data!==undefined?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(20000)});const value=await r.json();if(!r.ok)throw Error(value.error||'Call unavailable.');return value;};
  const label=role==='admin'?'Customer':'Xing Light';
  const valid=token=>!destroyed&&generation===token;
  function mount(container){if(role==='admin'&&container&&!container.querySelector('.voice-choice')){const select=document.createElement('select');select.className='voice-choice';select.setAttribute('aria-label','Voice effect');for(const [value,label] of voiceChoices)select.add(new Option(label,value));select.value=voiceChoice;select.onchange=()=>{if(active&&rawFallback&&select.value!=='natural'){select.value='natural';microphoneNotice('Using Natural microphone audio. To use a voice effect, end this call and choose it before calling again.');return;}voiceChoice=select.value;effect?.set(voiceChoice);};container.append(select);}if(destroyed||!container||container.querySelector('.call-launch'))return;for(const [type,title]of [['voice','Voice call'],['video','Video call']]){const button=document.createElement('button');button.type='button';button.className='call-launch';button.title=title;button.setAttribute('aria-label',title);button.innerHTML=svg(type==='video');button.onclick=()=>start(type);container.append(button);}}
  function show(incoming=false){
    panel?.remove();panel=document.createElement('section');panel.className='call-panel';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label',active.type+' call');
    panel.innerHTML=`<h2>${active.type==='video'?'Video':'Voice'} call · ${label}</h2><p class="call-status" role="status">${incoming?'Incoming call':'Calling…'}</p><div class="call-videos"><video class="call-remote" autoplay playsinline></video><video class="call-local" autoplay playsinline muted></video></div><p class="call-note">${active.type==='voice'?'Voice audio may pass through this app’s server and is not recorded. ':''}Admin calls may use altered voice effects. Both apps must stay open. Camera and microphone access are requested only when you start or answer.</p><div class="call-buttons">${incoming?'<button class="call-answer">Answer</button>':'<button class="call-mute" disabled>Mute</button>'}<button class="call-end">${incoming?'Decline':'End call'}</button></div><p class="call-audio-status" role="status" hidden></p><div class="call-buttons call-audio-actions" hidden><button type="button" class="call-play">Play call audio</button></div><p class="call-microphone-status" role="status" hidden></p><div class="call-buttons call-microphone-actions" hidden><button type="button" class="call-resume-mic">Resume microphone</button><button type="button" class="call-use-natural">Use Natural</button></div><p class="call-relay-status" role="status" hidden></p><div class="call-buttons call-relay-actions" hidden><button type="button" class="call-resume-audio">Resume call audio</button></div>`;
    document.body.append(panel);panel.querySelector('.call-end').onclick=()=>end(incoming?'declined':'completed');
    panel.querySelector('h2').textContent=`${active.type==='video'?'Video':'Voice'} call · ${role==='admin'?(active.customerName||label):label}`;
    if(incoming)panel.querySelector('.call-answer').onclick=answer;else bindMute();
  }
  function status(text){if(panel)panel.querySelector('.call-status').textContent=text;}
  function microphoneNotice(text){const hint=panel?.querySelector('.call-microphone-status');if(hint){hint.textContent=text;hint.hidden=!text;}}
  function chooseNatural(){voiceChoice='natural';for(const select of document.querySelectorAll('.voice-choice'))select.value='natural';}
  function bindMute(){const button=panel?.querySelector('.call-mute');if(!button)return;button.disabled=!local;button.onclick=()=>{const track=local?.getAudioTracks()[0];if(track){track.enabled=!track.enabled;button.textContent=track.enabled?'Mute':'Unmute';}};}
  async function media(token,prepared){
    if(!navigator.mediaDevices?.getUserMedia)throw Error('Calls require the updated app or a supported browser.');
    const stream=prepared||await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:active.type==='video'?{facingMode:'user',width:{ideal:640},height:{ideal:480}}:false});
    if(!valid(token)||!active||!panel){for(const track of stream.getTracks())track.stop();return false;}
    let processed=null;const chosen=voiceChoice;if(role==='admin'){try{processed=await createVoiceEffect(stream,chosen);}catch(error){if(!valid(token)){stream.getTracks().forEach(t=>t.stop());return false;}if(chosen!=='natural'){stream.getTracks().forEach(t=>t.stop());throw Error('Voice effect unavailable. Choose Natural and call again.');}rawFallback=true;chooseNatural();microphoneNotice('Using Natural microphone audio. Voice effects are unavailable for this call.');}}
    if(!valid(token)||!active||!panel){processed?.close();stream.getTracks().forEach(t=>t.stop());return false;}
    local=stream;effect=processed;
    panel.querySelector('.call-local').srcObject=local;
    return true;
  }
  function bindMicrophoneRecovery(token,callPanel,connectionCurrent,replaceAudio){
    if(!effect)return;const callEffect=effect,rawAudio=local.getAudioTracks()[0],micActions=callPanel.querySelector('.call-microphone-actions'),resumeButton=callPanel.querySelector('.call-resume-mic'),naturalButton=callPanel.querySelector('.call-use-natural');let recovering=false;
    const current=()=>valid(token)&&panel===callPanel&&effect===callEffect&&connectionCurrent();
    const drawMicrophone=state=>{if(!current())return;const paused=state!=='running';micActions.hidden=!paused;microphoneNotice(paused?'Microphone paused. Tap Resume microphone or Use Natural.':'');};
    const setRecovering=value=>{recovering=value;resumeButton.disabled=value;naturalButton.disabled=value;};
    effectUnsubscribe=callEffect.subscribeState(drawMicrophone);refreshMicrophone=()=>drawMicrophone(callEffect.state);refreshMicrophone();
    resumeButton.onclick=async()=>{if(recovering||!current())return;setRecovering(true);try{await callEffect.resume();if(current())drawMicrophone(callEffect.state);}catch{if(current()){micActions.hidden=false;microphoneNotice('Microphone paused. Try Resume microphone again or choose Use Natural.');}}finally{if(current())setRecovering(false);}};
    naturalButton.onclick=async()=>{if(recovering||!current())return;if(!rawAudio||rawAudio.readyState==='ended'){microphoneNotice('Microphone unavailable. End this call and call again.');return;}setRecovering(true);try{await replaceAudio(rawAudio);if(!current())return;effectUnsubscribe?.();effectUnsubscribe=null;refreshMicrophone=null;effect=null;rawFallback=true;chooseNatural();callEffect.close();micActions.hidden=true;microphoneNotice('Using Natural microphone audio for this call.');}catch{if(current())microphoneNotice('Could not change the microphone. Try again or end this call.');}finally{if(current())setRecovering(false);}};
  }
  const currentRelay=session=>valid(session.token)&&relaySession===session&&active?.id===session.callId&&panel===session.panel;
  async function openRelay(session){
    if(!currentRelay(session)||active.status!=='active'||session.helper||session.starting)return;session.starting=true;
    const audioActions=session.panel.querySelector('.call-relay-actions'),audioStatus=session.panel.querySelector('.call-relay-status'),resumeButton=session.panel.querySelector('.call-resume-audio');let resuming=false;
    const fail=message=>{if(!currentRelay(session)||session.failed)return;session.failed=true;end('connection-failed',message||'Voice call disconnected. Check your network and call again.');};
    try{
      const url=new URL(prefix+'/'+encodeURIComponent(session.callId)+'/audio',location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      const helper=createRelay({stream:new MediaStream([session.audioTrack]),url:url.href,onState:state=>{if(!currentRelay(session)||session.failed)return;if(state==='connected'){session.connected=true;session.everConnected=true;clearTimeout(timeout);clearTimeout(reconnectTimeout);reconnectTimeout=null;status('Connected');}else if(state==='waiting'){session.connected=false;status(session.everConnected?'Reconnecting…':'Waiting for the other person…');if(session.everConnected&&reconnectTimeout===null)reconnectTimeout=setTimeout(()=>{if(currentRelay(session)&&!session.connected)fail('The call lost its connection. Check your network and call again.');},15000);}else if(state==='disconnected')fail();},onError:message=>fail(message)});
      if(!currentRelay(session)){helper.close();return;}session.helper=helper;
      const drawAudio=state=>{if(!currentRelay(session)||session.helper!==helper)return;const paused=state!=='running';audioActions.hidden=!paused;audioStatus.hidden=!paused;audioStatus.textContent=paused?'Call audio paused. Tap Resume call audio.':'';};
      session.audioUnsubscribe=helper.subscribeState(drawAudio);session.refreshAudio=()=>drawAudio(helper.state);session.refreshAudio();
      resumeButton.onclick=async()=>{if(resuming||!currentRelay(session)||session.helper!==helper)return;resuming=true;resumeButton.disabled=true;try{await helper.resume();if(currentRelay(session)&&session.helper===helper)drawAudio(helper.state);}catch{if(currentRelay(session)&&session.helper===helper){audioActions.hidden=false;audioStatus.hidden=false;audioStatus.textContent='Call audio paused. Try Resume call audio again.';}}finally{if(currentRelay(session)&&session.helper===helper){resuming=false;resumeButton.disabled=false;}}};
      await helper.readyPromise;if(!currentRelay(session)){helper.close();return;}session.refreshAudio();
    }catch(error){fail(error.message||'Voice audio could not start. Please try again.');}finally{session.starting=false;}
  }
  async function setup(token){
    const callId=active?.id;if(!valid(token)||!callId)return false;const config=await api('/config?callId='+encodeURIComponent(callId));if(!valid(token)||active?.id!==callId||!local||!panel)return false;
    if(active.type==='voice'&&config.voiceRelayConfigured){
      const session={token,callId,panel,audioTrack:effect?.track||local.getAudioTracks()[0],helper:null,starting:false,failed:false,connected:false,everConnected:false};relaySession=session;session.panel.querySelector('.call-videos').hidden=true;
      bindMicrophoneRecovery(token,session.panel,()=>relaySession===session,async raw=>{if(session.helper)await session.helper.setStream(new MediaStream([raw]));if(currentRelay(session))session.audioTrack=raw;});
      timeout=setTimeout(()=>{if(currentRelay(session)&&!session.connected)end('connection-failed','The other person could not join the voice call. Please try again.');},45000);bindMute();if(active.status==='active')await openRelay(session);return currentRelay(session);
    }
    const peer=new RTCPeerConnection({iceServers:config.iceServers});pc=peer;remote=new MediaStream();const callPanel=panel,remoteElement=callPanel.querySelector('.call-remote'),audioActions=callPanel.querySelector('.call-audio-actions'),audioStatus=callPanel.querySelector('.call-audio-status');remoteElement.srcObject=remote;let playbackAttempt=0,audioBlocked=false;
    async function playRemote(){const attempt=++playbackAttempt;try{await remoteElement.play();if(!valid(token)||pc!==peer||panel!==callPanel||attempt!==playbackAttempt)return;audioBlocked=false;audioActions.hidden=true;audioStatus.hidden=true;if(peer.connectionState==='connected')status('Connected');}catch{if(!valid(token)||pc!==peer||panel!==callPanel||attempt!==playbackAttempt)return;audioBlocked=true;audioActions.hidden=false;audioStatus.hidden=false;audioStatus.textContent='Tap Play call audio to hear the other person.';if(peer.connectionState==='connected')status('Connected · Tap to hear call audio');}}
    callPanel.querySelector('.call-play').onclick=playRemote;
    let audioSender=null;for(const track of local.getTracks()){const sender=pc.addTrack(track.kind==='audio'&&effect?effect.track:track,local);if(track.kind==='audio')audioSender=sender;}
    bindMicrophoneRecovery(token,callPanel,()=>pc===peer,raw=>audioSender?audioSender.replaceTrack(raw):Promise.reject(Error('Microphone unavailable.')));
    peer.ontrack=event=>{if(!valid(token)||pc!==peer){event.track.stop();return;}if(!remote.getTracks().includes(event.track))remote.addTrack(event.track);playRemote();};
    peer.onicecandidate=event=>{if(event.candidate&&valid(token)&&pc===peer&&outgoing.length<200){outgoing.push({kind:'ice',payload:event.candidate.toJSON()});flushSignals(token);}};
    peer.onconnectionstatechange=()=>{if(!valid(token)||pc!==peer)return;const state=peer.connectionState;if(state==='connected'){status(audioBlocked?'Connected · Tap to hear call audio':'Connected');clearTimeout(timeout);clearTimeout(reconnectTimeout);reconnectTimeout=null;}else if(state==='failed')end('connection-failed','Could not connect. Some mobile networks require a configured call relay.');else if(state==='disconnected'){status('Reconnecting…');if(reconnectTimeout===null)reconnectTimeout=setTimeout(()=>{if(valid(token)&&pc===peer&&peer.connectionState!=='connected')end('connection-failed','The call lost its connection. Check your network and call again.');},15000);}};
    timeout=setTimeout(()=>{if(valid(token)&&peer.connectionState!=='connected')end('connection-failed','The other device could not connect. A call relay may be needed on this network.');},45000);
    bindMute();return true;
  }
  const signal=(kind,payload,callId=active?.id)=>callId?api('/'+callId+'/signals','POST',{kind,payload}):Promise.reject(Error('The call has ended.'));
  async function flushSignals(token){if(flushing!==null||!valid(token)||!active)return;flushing=token;const callId=active.id;try{while(outgoing.length&&valid(token)&&active?.id===callId){const next=outgoing[0];await signal(next.kind,next.payload,callId);if(!valid(token))return;outgoing.shift();}}catch{if(valid(token))status('Connection paused. Retrying…');}finally{if(flushing===token)flushing=null;}}
  async function start(type){
    if(destroyed||active||handling!==null)return;const conversationId=getConversationId();if(!conversationId)return notify('Open a conversation first.');const token=++generation;handling=token;
    try{const requested=navigator.mediaDevices?.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:type==='video'?{facingMode:'user',width:{ideal:640},height:{ideal:480}}:false});if(!requested)throw Error('Microphone unavailable in this browser.');const prepared=await requested;if(!valid(token)){prepared.getTracks().forEach(t=>t.stop());return;}let call;try{call=await api('','POST',{type,conversationId});}catch(error){prepared.getTracks().forEach(t=>t.stop());throw error;}if(!valid(token)){prepared.getTracks().forEach(t=>t.stop());await api('/'+call.id+'/end','POST',{reason:'cancelled'}).catch(()=>{});return;}active=call;show();if(!await media(token,prepared)||!await setup(token))return;if(relaySession){status(relaySession.connected?'Connected':relaySession.everConnected?'Reconnecting…':active.status==='active'?'Waiting for the other person…':'Calling…');beginPoll();await poll();return;}const peer=pc,offer=await peer.createOffer();if(!valid(token))return;await peer.setLocalDescription(offer);if(!valid(token))return;await signal('offer',{type:offer.type,sdp:offer.sdp},call.id);if(valid(token))beginPoll();}
    catch(error){if(valid(token))await end('connection-failed',error.name==='NotAllowedError'?'Microphone or camera access was declined. Enable it in device app settings, then tap the call button again.':error.message);}finally{if(handling===token)handling=null;}
  }
  async function answer(){
    if(destroyed||handling!==null||!active||!panel)return;const token=generation,callId=active.id;handling=token;panel.querySelector('.call-answer').disabled=true;
    try{if(!await media(token))return;const accepted=await api('/'+callId+'/accept','POST',{});if(!valid(token))return;active=accepted;if(!await setup(token))return;panel.querySelector('.call-buttons').innerHTML='<button class="call-mute">Mute</button><button class="call-end">End call</button>';panel.querySelector('.call-end').onclick=()=>end('completed');bindMute();status(relaySession?relaySession.connected?'Connected':relaySession.everConnected?'Reconnecting…':'Waiting for the other person…':'Connecting…');cursor=0;beginPoll();await poll();}
    catch(error){if(valid(token))await end('connection-failed',error.name==='NotAllowedError'?'Microphone or camera access was declined.':error.message);}finally{if(handling===token)handling=null;}
  }
  function clean(){generation++;const session=relaySession;relaySession=null;session?.audioUnsubscribe?.();session?.helper?.close();effectUnsubscribe?.();effectUnsubscribe=null;refreshMicrophone=null;effect?.close();effect=null;rawFallback=false;handling=null;polling=null;flushing=null;clearTimeout(timeout);clearTimeout(reconnectTimeout);reconnectTimeout=null;clearTimeout(pollTimer);pollTimer=null;if(pc){pc.ontrack=null;pc.onicecandidate=null;pc.onconnectionstatechange=null;pc.close();}pc=null;for(const track of local?.getTracks()||[])track.stop();local=null;for(const track of remote.getTracks())track.stop();remote=new MediaStream();panel?.remove();panel=null;active=null;cursor=0;queue=[];outgoing=[];pendingAnswer=null;nextPollAt=Date.now()+5000;schedulePoll();}
  async function end(reason='completed',message){const call=active;clean();if(call)await api('/'+call.id+'/end','POST',{reason}).catch(()=>{});if(message)notify(message);}
  function schedulePoll(){clearTimeout(pollTimer);pollTimer=null;if(!destroyed&&!document.hidden)pollTimer=setTimeout(()=>{pollTimer=null;poll();},Math.max(0,nextPollAt-Date.now()));}
  function beginPoll(){nextPollAt=0;schedulePoll();}
  async function poll(){
    if(destroyed||polling!==null||document.hidden)return;if(Date.now()<nextPollAt){schedulePoll();return;}if(!active&&handling!==null){nextPollAt=Date.now()+5000;schedulePoll();return;}clearTimeout(pollTimer);pollTimer=null;const token=generation,callId=active?.id;polling=token;
    try{
      if(!active){const list=await api('');if(!valid(token)||active)return;const incoming=list.calls.find(c=>c.caller!==(role==='admin'?'admin':'customer')&&c.status==='ringing');if(incoming){generation++;active=incoming;show(true);beginPoll();notify('Incoming '+incoming.type+' call.');}return;}
      const data=await api('/'+callId+'/signals?after='+cursor);if(!valid(token)||active?.id!==callId)return;active=data.call;
      if(active.status==='ended'){const reason=active.reason;clean();notify(reason==='declined'?'Call declined.':reason==='expired'?'Call was not answered.':'Call ended.');return;}
      if(active.caller!==(role==='admin'?'admin':'customer')&&active.status==='ringing')return;
      if(relaySession){const session=relaySession;if(active.status==='active'){await openRelay(session);if(currentRelay(session))status(session.connected?'Connected':session.everConnected?'Reconnecting…':'Waiting for the other person…');}return;}
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
    }catch(error){if(valid(token)&&active)status('Connection paused. Retrying…');}finally{if(polling===token){polling=null;nextPollAt=Date.now()+(active?1500:5000);schedulePoll();}}
  }
  const onVisibility=()=>{refreshMicrophone?.();relaySession?.refreshAudio?.();if(document.hidden){clearTimeout(pollTimer);pollTimer=null;}else{nextPollAt=0;poll();}};document.addEventListener('visibilitychange',onVisibility);beginPoll();
  return {mount,poll,destroy:()=>{if(destroyed)return;destroyed=true;document.removeEventListener('visibilitychange',onVisibility);return end('cancelled');}};
}
