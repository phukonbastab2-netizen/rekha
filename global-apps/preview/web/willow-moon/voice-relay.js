// Audio travels only through the current app's authenticated private call socket.
export function createVoiceRelay({stream,url,onState=()=>{},onError=()=>{},timeoutMs=5000}) {
  const deadline=Number.isFinite(timeoutMs)?Math.max(40,timeoutMs):5000;
  let context=null,socket=null,processor=null,source=null,closed=false,closePromise=null,readySettled=false,peerConnected=false;
  let desiredStream=stream,sourceGeneration=0,heartbeat=null,startupTimer=null,connectionState='waiting';
  const subscribers=new Set(),pending=new Set(),received=[];
  let resolveReady,rejectReady;
  const readyPromise=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  readyPromise.catch(()=>{});
  const error=(code,message)=>Object.assign(new Error(message),{code});
  const audioState=()=>closed?'closed':context?.state||'suspended';
  const notifyState=value=>{connectionState=value;try{onState(value);}catch{}};
  const updateProcessor=()=>{if(processor&&!closed){processor.port.postMessage({type:'state',active:peerConnected,paused:context.state!=='running'});if(context.state==='running')for(const pcm of received.splice(0))processor.port.postMessage({type:'playback',pcm},[pcm]);}};
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
  function close() {
    if(closed)return closePromise||Promise.resolve();
    closed=true;sourceGeneration++;clearTimeout(startupTimer);clearInterval(heartbeat);subscribers.clear();received.length=0;
    if(context){try{context.removeEventListener('statechange',audioChanged);}catch{}}
    for(const cancel of [...pending])cancel();
    if(!readySettled){readySettled=true;rejectReady(error('VOICE_RELAY_CLOSED','The call audio relay has closed.'));}
    if(processor){processor.port.onmessage=null;try{processor.port.postMessage({type:'close'});}catch{}try{processor.disconnect();}catch{}try{processor.port.close();}catch{}}
    try{source?.disconnect();}catch{}
    if(socket){socket.onopen=socket.onmessage=socket.onerror=socket.onclose=null;try{socket.close(1000,'Call closed');}catch{}}
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
    let openedResolve,openedReject;const opened=new Promise((resolve,reject)=>{openedResolve=resolve;openedReject=reject;});
    opened.catch(()=>{});
    socket=new WebSocket(target.href);socket.binaryType='arraybuffer';
    socket.onopen=()=>{if(!closed)openedResolve();};
    socket.onerror=()=>{if(closed)return;openedReject(error('VOICE_RELAY_SOCKET','The private call audio connection failed.'));fail(error('VOICE_RELAY_SOCKET','The private call audio connection failed.'));};
    socket.onclose=()=>{if(closed)return;openedReject(error('VOICE_RELAY_SOCKET','The private call audio connection closed.'));if(!readySettled)fail(error('VOICE_RELAY_SOCKET','The private call audio connection closed.'));else close();};
    socket.onmessage=event=>{
      if(closed)return;
      if(event.data instanceof ArrayBuffer){receiveFrame(event.data);return;}
      if(event.data==='pong')return;
      if(typeof event.data!=='string'){fail(error('VOICE_RELAY_FRAME','The call relay received an invalid audio frame.'));return;}
      let message;try{message=JSON.parse(event.data);}catch{fail(error('VOICE_RELAY_CONTROL','The private call audio connection returned an invalid response.'));return;}
      if(message.type==='peer'&&typeof message.connected==='boolean'){peerConnected=message.connected;if(!peerConnected)received.length=0;updateProcessor();notifyState(peerConnected?'connected':'waiting');}
      else if(message.type==='ended')close();
    };
    startupTimer=setTimeout(()=>fail(error('VOICE_RELAY_TIMEOUT','The private call audio connection did not start. Try the call again.')),deadline);
    notifyState('waiting');
    Promise.all([running,module,opened]).then(()=>{
      if(closed)return;
      processor=new AudioWorkletNode(context,'rekha-voice-relay',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:'explicit'});
      processor.port.onmessage=event=>{const pcm=event.data?.type==='capture'?event.data.pcm:null;if(!closed&&peerConnected&&context.state==='running'&&socket.readyState===1&&pcm instanceof ArrayBuffer&&pcm.byteLength===1280&&socket.bufferedAmount+1280<=65536){try{socket.send(pcm);}catch{fail(error('VOICE_RELAY_SOCKET','The private call audio connection failed.'));}}};
      processor.connect(context.destination);attachStream(desiredStream);updateProcessor();
      for(const pcm of received.splice(0))processor.port.postMessage({type:'playback',pcm},[pcm]);
      heartbeat=setInterval(()=>{if(!closed&&socket.readyState===1&&socket.bufferedAmount<65536)socket.send('ping');},15000);
      clearTimeout(startupTimer);readySettled=true;resolveReady();
    }).catch(failure=>fail(failure?.code?failure:error('VOICE_RELAY_START','Call audio could not start. Check microphone access and try again.')));
  } catch(failure) {fail(failure?.code?failure:error('VOICE_RELAY_START','Call audio could not start. Check microphone access and try again.'));}
  return {readyPromise,setStream,resume,get state(){return audioState();},subscribeState,close};
}
