// Audio travels only through the current app's authenticated private call socket.
export function createVoiceRelay({stream,url,onState=()=>{},onError=()=>{},onEnded=()=>{},timeoutMs=5000}) {
  const deadline=Number.isFinite(timeoutMs)?Math.max(40,timeoutMs):5000;
  let context=null,socket=null,processor=null,source=null,output=null,closed=false,ending=false,closePromise=null,readySettled=false,peerConnected=false;
  let desiredStream=stream,desiredVolume=1,sourceGeneration=0,heartbeat=null,startupTimer=null,connectionState=null,targetHref=null;
  let socketGeneration=0,socketRetryClosing=false,retryTimer=null,retryWindowTimer=null,socketTimer=null,retryUntil=0,retryAttempts=0;
  let lastCaptureAt=-Infinity;
  const retryDelays=[250,750,1500,3000],joinTimes=[],transientCodes=new Set([1001,1005,1006,1011,1012,1013]);
  const endReasons=new Set(['completed','cancelled','declined','expired','blocked','connection-failed']);
  const subscribers=new Set(),pending=new Set(),received=[];
  let resolveReady,rejectReady;
  const readyPromise=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  readyPromise.catch(()=>{});
  const error=(code,message)=>Object.assign(new Error(message),{code});
  const audioState=()=>closed?'closed':context?.state||'suspended';
  const notifyState=value=>{if(connectionState===value)return;connectionState=value;try{onState(value);}catch{}};
  const updateProcessor=()=>{if(processor&&!closed){processor.port.postMessage({type:'state',active:peerConnected,paused:context.state!=='running'});if(peerConnected&&context.state==='running')for(const pcm of received.splice(0))processor.port.postMessage({type:'playback',pcm},[pcm]);}};
  const audioChanged=()=>{if(closed)return;updateProcessor();for(const listener of [...subscribers]){try{listener(audioState());}catch{}}};
  function bounded(operation,code,message) {
    return new Promise((resolve,reject)=>{
      let settled=false,timer=null;
      const finish=(failure,value)=>{if(settled)return;settled=true;clearTimeout(timer);pending.delete(cancel);if(failure)reject(failure);else resolve(value);};
      const cancel=()=>finish(error('VOICE_RELAY_CLOSED','The call audio relay has closed.'));
      pending.add(cancel);timer=setTimeout(()=>finish(error(code,message)),deadline);
      let result;try{result=operation();}catch{finish(error(code,message));return;}
      Promise.resolve(result).then(value=>finish(null,value),()=>finish(error(code,message)));
    });
  }
  function resume() {
    if(closed||!context)return Promise.reject(error('VOICE_RELAY_CLOSED','The call audio relay has closed.'));
    return bounded(()=>context.resume(),'VOICE_RELAY_AUDIO','Call audio could not start. Tap Resume call audio and try again.').then(()=>{
      if(closed)throw error('VOICE_RELAY_CLOSED','The call audio relay has closed.');
      if(context.state!=='running')throw error('VOICE_RELAY_AUDIO','Call audio is paused. Tap Resume call audio and try again.');
      updateProcessor();
    });
  }
  function subscribeState(listener) {
    if(typeof listener!=='function')throw new TypeError('An audio state listener must be a function.');
    if(closed)return ()=>{};subscribers.add(listener);let subscribed=true;
    return ()=>{if(subscribed){subscribed=false;subscribers.delete(listener);}};
  }
  function attachStream(value) {
    if(!value?.getAudioTracks?.().length)throw error('VOICE_RELAY_INPUT','The call microphone has no audio track.');
    const next=context.createMediaStreamSource(value);
    try{next.connect(processor);}catch{try{next.disconnect();}catch{}throw error('VOICE_RELAY_INPUT','The call microphone could not connect.');}
    const old=source;source=next;try{old?.disconnect();}catch{}
  }
  async function setStream(value) {
    if(closed)throw error('VOICE_RELAY_CLOSED','The call audio relay has closed.');
    if(!value?.getAudioTracks?.().length)throw error('VOICE_RELAY_INPUT','The call microphone has no audio track.');
    desiredStream=value;const generation=++sourceGeneration;await readyPromise;
    if(closed)throw error('VOICE_RELAY_CLOSED','The call audio relay has closed.');
    if(generation!==sourceGeneration)return;
    attachStream(value);
  }
  function setVolume(value) {
    if(closed)return desiredVolume;
    if(typeof value!=='number'||!Number.isFinite(value))throw new TypeError('Call volume must be a finite number.');
    desiredVolume=Math.max(0,Math.min(1,value));
    if(output)output.gain.value=desiredVolume;
    return desiredVolume;
  }
  function clearRecovery() {
    clearTimeout(retryTimer);clearTimeout(retryWindowTimer);clearTimeout(socketTimer);
    retryTimer=retryWindowTimer=socketTimer=null;retryUntil=0;retryAttempts=0;
  }
  function detachSocket(value,shouldClose=false) {
    if(!value)return;
    value.onopen=value.onmessage=value.onerror=value.onclose=null;
    if(shouldClose)try{value.close(1000,'Call closed');}catch{}
  }
  function close() {
    if(closed)return closePromise||Promise.resolve();
    closed=true;sourceGeneration++;socketGeneration++;clearTimeout(startupTimer);clearInterval(heartbeat);clearRecovery();subscribers.clear();received.length=0;
    if(context){try{context.removeEventListener('statechange',audioChanged);}catch{}}
    for(const cancel of [...pending])cancel();
    openedReject(error('VOICE_RELAY_CLOSED','The call audio relay has closed.'));
    if(!readySettled){readySettled=true;rejectReady(error('VOICE_RELAY_CLOSED','The call audio relay has closed.'));}
    if(processor){processor.port.onmessage=null;try{processor.port.postMessage({type:'close'});}catch{}try{processor.disconnect();}catch{}try{processor.port.close();}catch{}}
    try{output?.disconnect();}catch{}
    try{source?.disconnect();}catch{}
    detachSocket(socket,true);socket=null;
    notifyState('disconnected');
    closePromise=new Promise(resolve=>{let settled=false;const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);resolve();};const timer=setTimeout(finish,deadline);let result;try{result=context?.close();}catch{finish();return;}Promise.resolve(result).then(finish,finish);});
    return closePromise;
  }
  function fail(failure) {
    if(closed)return;
    if(!readySettled){readySettled=true;rejectReady(failure);}
    try{onError(failure.message);}catch{}
    close();
  }
  function receiveFrame(pcm) {
    if(pcm.byteLength!==1280){fail(error('VOICE_RELAY_FRAME','The call relay received an invalid audio frame.'));return;}
    if(!peerConnected)return;
    if(processor&&context.state==='running')processor.port.postMessage({type:'playback',pcm},[pcm]);
    else{received.push(pcm);if(received.length>6)received.shift();}
  }
  function pauseTransport() {
    peerConnected=false;received.length=0;lastCaptureAt=-Infinity;clearInterval(heartbeat);heartbeat=null;
    // active:false clears both partial capture and queued remote playback in
    // the existing worklet; no old audio is replayed after a new socket joins.
    updateProcessor();notifyState('waiting');
  }
  function startHeartbeat() {
    if(closed||heartbeat!==null)return;
    heartbeat=setInterval(()=>{
      if(!closed&&socket?.readyState===1&&socket.bufferedAmount<65536)try{socket.send('ping');}catch{transportError(socket);}
    },15000);
  }
  function beginRecovery() {
    if(closed)return false;
    if(!retryUntil){
      retryUntil=Date.now()+15000;retryAttempts=0;
      retryWindowTimer=setTimeout(()=>fail(error('VOICE_RELAY_RECONNECT','The call could not reconnect. Check the network and call again.')),15000);
    }
    pauseTransport();return !closed;
  }
  function retrySocket() {
    if(!beginRecovery()||retryTimer!==null)return;
    if(retryAttempts>=retryDelays.length||Date.now()>=retryUntil){fail(error('VOICE_RELAY_RECONNECT','The call could not reconnect. Check the network and call again.'));return;}
    const delay=retryDelays[retryAttempts++];
    if(Date.now()+delay>=retryUntil)return; // the fixed window timer finishes it
    retryTimer=setTimeout(()=>{retryTimer=null;if(!closed)openSocket(false);},delay);
  }
  function transportError(value) {
    if(closed||value!==socket)return;
    if(!readySettled){fail(error('VOICE_RELAY_SOCKET','The private call audio connection failed.'));return;}
    if(!beginRecovery())return;
    // Browser errors hide upgrade HTTP status. Wait for CLOSED before another
    // socket: that prevents two sockets claiming the same private call role.
    socketRetryClosing=true;
    clearTimeout(socketTimer);
    socketTimer=setTimeout(()=>{if(!closed&&socket===value)fail(error('VOICE_RELAY_RECONNECT','The call audio connection stopped responding. Please call again.'));},Math.max(1,Math.min(3000,retryUntil-Date.now())));
    if(value.readyState<2)try{value.close(1000,'Reconnect call audio');}catch{}
  }
  let openedResolve,openedReject;
  const opened=new Promise((resolve,reject)=>{openedResolve=resolve;openedReject=reject;});
  opened.catch(()=>{});
  function openSocket(initial) {
    if(closed)return;
    if(socket&&socket.readyState!==3){fail(error('VOICE_RELAY_RECONNECT','The previous call audio connection has not closed.'));return;}
    const now=Date.now();while(joinTimes.length&&now-joinTimes[0]>=60000)joinTimes.shift();
    // Match the server's six joins per minute, including the initial join.
    if(joinTimes.length>=6){fail(error('VOICE_RELAY_RECONNECT','The call connection changed too often. Wait a moment and call again.'));return;}
    joinTimes.push(now);
    let value;
    try{value=new WebSocket(targetHref);}catch{
      if(initial)fail(error('VOICE_RELAY_SOCKET','The private call audio connection failed.'));else retrySocket();
      return;
    }
    socket=value;socketRetryClosing=false;const generation=++socketGeneration;
    const current=()=>!closed&&socket===value&&socketGeneration===generation;
    value.binaryType='arraybuffer';
    value.onopen=()=>{
      if(!current())return;clearTimeout(socketTimer);socketTimer=null;
      if(initial)openedResolve();else startHeartbeat();
    };
    value.onerror=()=>{if(current())transportError(value);};
    value.onclose=event=>{
      if(!current())return;
      clearTimeout(socketTimer);socketTimer=null;
      const code=Number.isInteger(event?.code)?event.code:1006;
      const retryable=transientCodes.has(code)||socketRetryClosing&&code===1000;
      detachSocket(value);socket=null;socketGeneration++;
      if(initial&&!readySettled){openedReject(error('VOICE_RELAY_SOCKET','The private call audio connection closed.'));fail(error('VOICE_RELAY_SOCKET','The private call audio connection closed.'));}
      else if(!retryable)close();
      else retrySocket();
    };
    value.onmessage=event=>{
      if(!current()||value.readyState!==1)return;
      if(event.data instanceof ArrayBuffer){receiveFrame(event.data);return;}
      if(event.data==='pong')return;
      if(typeof event.data!=='string'){fail(error('VOICE_RELAY_FRAME','The call relay received an invalid audio frame.'));return;}
      let message;try{message=JSON.parse(event.data);}catch{fail(error('VOICE_RELAY_CONTROL','The private call audio connection returned an invalid response.'));return;}
      if(message.type==='peer'&&typeof message.connected==='boolean'){
        peerConnected=message.connected;
        if(peerConnected)clearRecovery();else{received.length=0;lastCaptureAt=-Infinity;}
        updateProcessor();notifyState(peerConnected?'connected':'waiting');
      } else if(message.type==='ended'&&!ending){
        ending=true;const reason=typeof message.reason==='string'&&endReasons.has(message.reason)?message.reason:'completed';
        // Let the call UI finish normally before disconnected triggers cleanup.
        // Its callback may close this helper reentrantly or throw; either way
        // socket and audio teardown must still happen exactly once.
        try{onEnded(reason);}catch{}finally{close();}
      }
    };
    if(!initial)socketTimer=setTimeout(()=>{
      if(!current())return;
      socketRetryClosing=true;
      try{value.close(1000,'Reconnect call audio');}catch{}
      // Wait for its close event; the overall window remains the hard bound.
    },Math.max(1,Math.min(deadline,3000,retryUntil-Date.now())));
  }
  try {
    const current=new URL(location.href),target=new URL(url,current);
    const local=['localhost','127.0.0.1','[::1]'].includes(current.hostname);
    const protocol=current.protocol==='https:'?'wss:':current.protocol==='http:'&&local?'ws:':null;
    if(!protocol||target.protocol!==protocol||target.host!==current.host||target.username||target.password||target.hash||target.search||!/^\/api\/(?:admin\/)?calls\/[A-Za-z0-9_-]+\/audio$/.test(target.pathname))throw error('VOICE_RELAY_ORIGIN','Private call audio must use this app’s secure server.');
    if(!desiredStream?.getAudioTracks?.().length)throw error('VOICE_RELAY_INPUT','The call microphone has no audio track.');
    context=new AudioContext();context.addEventListener('statechange',audioChanged);
    const running=resume();
    running.catch(()=>{});
    const module=bounded(()=>context.audioWorklet.addModule(new URL('./voice-relay-worklet.js',import.meta.url)),'VOICE_RELAY_MODULE','Call audio support could not load. Check the connection and try again.');
    module.catch(()=>{});
    targetHref=target.href;openSocket(true);
    if(!closed){
      startupTimer=setTimeout(()=>fail(error('VOICE_RELAY_TIMEOUT','The private call audio connection did not start. Try the call again.')),deadline);
      notifyState('waiting');
    }
    Promise.all([running,module,opened]).then(()=>{
      if(closed)return;
      processor=new AudioWorkletNode(context,'rekha-voice-relay',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:'explicit'});
      processor.port.onmessage=event=>{
        const pcm=event.data?.type==='capture'?event.data.pcm:null;
        if(closed||!peerConnected||context.state!=='running'||socket?.readyState!==1||!(pcm instanceof ArrayBuffer)||pcm.byteLength!==1280||socket.bufferedAmount+1280>65536)return;
        // Worklet messages can bunch up after a busy main thread. Drop those
        // captures instead of sending a stale burst or keeping a replay queue.
        // Healthy capture produces one frame every 40 ms; this generous 30 ms
        // floor remains below the private server's 40-frame-per-second limit.
        const now=performance.now();if(now-lastCaptureAt<30)return;lastCaptureAt=now;
        try{socket.send(pcm);}catch{transportError(socket);}
      };
      output=context.createGain();output.gain.value=desiredVolume;processor.connect(output);output.connect(context.destination);attachStream(desiredStream);updateProcessor();
      for(const pcm of received.splice(0))processor.port.postMessage({type:'playback',pcm},[pcm]);
      startHeartbeat();
      clearTimeout(startupTimer);readySettled=true;resolveReady();
    }).catch(failure=>fail(failure?.code?failure:error('VOICE_RELAY_START','Call audio could not start. Check microphone access and try again.')));
  } catch(failure) {fail(failure?.code?failure:error('VOICE_RELAY_START','Call audio could not start. Check microphone access and try again.'));}
  return {readyPromise,setStream,setVolume,resume,get state(){return audioState();},subscribeState,close};
}
