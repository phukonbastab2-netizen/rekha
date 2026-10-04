export const voicePresets=Object.freeze([
  {id:'natural',name:'Natural',description:'Your usual voice'},
  {id:'deep',name:'Lower pitch',description:'A deeper version of your voice'},
  {id:'bright',name:'Higher pitch',description:'A brighter version of your voice'},
  {id:'warm',name:'Warm',description:'Soft, warm tone'},
  {id:'robot',name:'Robot',description:'An electronic voice effect'}
]);
const settings={natural:{pitch:1,robot:0,lowpass:16000,bass:0},deep:{pitch:2**(-4/12),robot:0,lowpass:12000,bass:0},bright:{pitch:2**(4/12),robot:0,lowpass:16000,bass:0},warm:{pitch:1,robot:0,lowpass:4200,bass:3},robot:{pitch:1,robot:1,lowpass:8000,bass:0}};

// Create this on the Start/Answer tap. Resuming before an asynchronous native
// permission prompt preserves the browser's audio activation on mobile.
export function createVoiceEffectsSession({preset='natural'}={}){
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextClass)throw Error('Voice effects are unavailable on this device.');
  const context=new AudioContextClass({latencyHint:'interactive'});
  if(!context.audioWorklet){context.close().catch(()=>{});throw Error('Voice effects need an updated app or browser.');}
  const resumed=context.resume();
  let processor=null,source=null,destination=null,highpass=null,bass=null,lowpass=null,outbound=null,closed=false,muted=false,current=settings[preset]?preset:'natural';
  const ready=Promise.all([resumed,context.audioWorklet.addModule(new URL('./voice-effects-worklet.js',import.meta.url))]);
  // A denied microphone request may finish before module loading. Keep this
  // promise observed even when attach() is never called.
  ready.catch(()=>{});
  function setPreset(value){
    if(!settings[value])throw Error('Choose an available voice effect.');
    current=value;if(!processor||closed)return;
    const valueSettings=settings[value],at=context.currentTime;
    processor.parameters.get('pitch').setTargetAtTime(valueSettings.pitch,at,.018);
    processor.parameters.get('robot').setTargetAtTime(valueSettings.robot,at,.018);
    bass.gain.setTargetAtTime(valueSettings.bass,at,.018);
    lowpass.frequency.setTargetAtTime(Math.min(valueSettings.lowpass,context.sampleRate*.45),at,.018);
  }
  async function attach(stream){
    await ready;if(closed)throw Error('The call has ended.');
    // Capture can interrupt the audio context on mobile after the initial tap.
    if(context.state!=='running')await context.resume();
    if(closed)throw Error('The call has ended.');
    if(context.state!=='running')throw Error('Voice effects could not resume.');
    const audio=stream.getAudioTracks();if(!audio.length)throw Error('The microphone did not provide audio.');
    source=context.createMediaStreamSource(new MediaStream(audio));
    highpass=context.createBiquadFilter();highpass.type='highpass';highpass.frequency.value=70;highpass.Q.value=.7;
    bass=context.createBiquadFilter();bass.type='lowshelf';bass.frequency.value=260;
    lowpass=context.createBiquadFilter();lowpass.type='lowpass';lowpass.Q.value=.7;
    processor=new AudioWorkletNode(context,'rekha-call-voice',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:'explicit'});
    destination=context.createMediaStreamDestination();
    source.connect(highpass);highpass.connect(bass);bass.connect(processor);processor.connect(lowpass);lowpass.connect(destination);
    setPreset(current);
    outbound=new MediaStream([...destination.stream.getAudioTracks(),...stream.getVideoTracks()]);
    setMuted(muted);return outbound;
  }
  function setMuted(value){muted=!!value;for(const track of outbound?.getAudioTracks()||[])track.enabled=!muted;}
  function destroy(){
    if(closed)return;closed=true;
    for(const track of destination?.stream.getTracks()||[])track.stop();
    for(const node of [source,highpass,bass,processor,lowpass]){try{node?.disconnect();}catch{}}
    processor?.port.close();source=null;processor=null;destination=null;outbound=null;
    context.close().catch(()=>{});
  }
  return {attach,setPreset,setMuted,destroy,get preset(){return current;}};
}
