// Live microphone effects. No identity model or voice recording is stored.
export const voiceChoices = [['natural','Natural'],['warm','Warm'],['bright','Bright'],['radio','Radio'],['robot','Robot']];

export async function createVoiceEffect(stream, choice='natural', {timeoutMs=2000}={}) {
  const deadline=Number.isFinite(timeoutMs)?Math.max(40,timeoutMs):2000;
  let context=null,source=null,filter=null,gain=null,destination=null,oscillator=null,modulation=null;
  let closed=false,closePromise=null,listening=false;
  const nodes=[],subscribers=new Set(),pendingResumes=new Set();
  const failure=(code,message,cause)=>{const error=new Error(message);error.code=code;if(cause!==undefined)error.cause=cause;return error;};
  const state=()=>closed?'closed':context.state;
  const remember=node=>{nodes.push(node);return node;};
  const stateChanged=()=>{if(closed)return;for(const listener of [...subscribers]){try{listener(state());}catch{}}};

  function resume() {
    if(closed)return Promise.reject(failure('VOICE_AUDIO_CLOSED','The voice effect has been closed.'));
    return new Promise((resolve,reject)=>{
      let settled=false,timer=null;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);pendingResumes.delete(cancel);if(error)reject(error);else resolve();};
      const cancel=()=>finish(failure('VOICE_AUDIO_CLOSED','The voice effect has been closed.'));
      pendingResumes.add(cancel);
      timer=setTimeout(()=>finish(failure('VOICE_AUDIO_TIMEOUT','Voice effect audio did not start. Try again or choose Natural.')),deadline);
      let attempt;
      try{attempt=context.resume();}catch(error){finish(failure('VOICE_AUDIO_RESUME_FAILED','Voice effect audio could not resume.',error));return;}
      Promise.resolve(attempt).then(()=>{
        if(closed)finish(failure('VOICE_AUDIO_CLOSED','The voice effect has been closed.'));
        else if(context.state!=='running')finish(failure('VOICE_AUDIO_NOT_RUNNING','Voice effect audio is '+context.state+'. Try again or choose Natural.'));
        else finish();
      },error=>finish(failure('VOICE_AUDIO_RESUME_FAILED','Voice effect audio could not resume.',error)));
    });
  }

  function subscribeState(listener) {
    if(typeof listener!=='function')throw new TypeError('A voice state listener must be a function.');
    if(closed)return ()=>{};
    subscribers.add(listener);
    let subscribed=true;
    return ()=>{if(subscribed){subscribed=false;subscribers.delete(listener);}};
  }

  function close() {
    if(closePromise)return closePromise;
    closed=true;
    subscribers.clear();
    if(listening){try{context.removeEventListener('statechange',stateChanged);}catch{}listening=false;}
    for(const cancel of [...pendingResumes])cancel();
    for(const node of nodes){try{node.disconnect();}catch{}}
    if(oscillator){try{oscillator.stop();}catch{}}
    if(destination){try{for(const track of destination.stream.getTracks()){try{track.stop();}catch{}}}catch{}}
    // Input microphone tracks belong to the caller. Only this effect's output is stopped.
    closePromise=new Promise(resolve=>{
      let done=false;
      const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve();};
      const timer=setTimeout(finish,deadline);
      let attempt;
      try{attempt=context?.close();}catch{finish();return;}
      Promise.resolve(attempt).then(finish,finish);
    });
    return closePromise;
  }

  function set(value) {
    if(closed)return;
    filter.type=value==='warm'?'lowpass':value==='bright'?'highpass':value==='radio'?'bandpass':'allpass';
    filter.frequency.value=value==='warm'?1800:value==='bright'?350:1200;
    filter.Q.value=value==='radio'?0.7:0.3;
    gain.gain.value=value==='robot'?0.6:1;
    modulation.gain.value=value==='robot'?0.4:0;
  }

  try {
    context=new AudioContext();
    context.addEventListener('statechange',stateChanged);listening=true;
    await resume();
    source=remember(context.createMediaStreamSource(stream));
    filter=remember(context.createBiquadFilter());
    gain=remember(context.createGain());
    destination=remember(context.createMediaStreamDestination());
    oscillator=remember(context.createOscillator());
    modulation=remember(context.createGain());
    oscillator.frequency.value=35;modulation.gain.value=0;
    oscillator.connect(modulation);modulation.connect(gain.gain);oscillator.start();
    source.connect(filter);filter.connect(gain);gain.connect(destination);
    set(choice);
    const track=destination.stream.getAudioTracks()[0];
    if(!track)throw failure('VOICE_AUDIO_NO_TRACK','The voice effect has no outgoing audio track.');
    return {track,set,close,get state(){return state();},resume,subscribeState};
  } catch(error) {
    // Close is bounded too, but startup rejection must not wait on an unresponsive browser close.
    close();
    throw error;
  }
}
