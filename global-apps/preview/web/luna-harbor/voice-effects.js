// Live microphone effects. No identity model or voice recording is stored.
export const voiceChoices = [['natural','Natural'],['warm','Warm'],['bright','Bright'],['radio','Radio'],['robot','Robot']];
export async function createVoiceEffect(stream, choice='natural') {
  const context = new AudioContext();
  await context.resume();
  const source=context.createMediaStreamSource(stream), filter=context.createBiquadFilter(), gain=context.createGain(), destination=context.createMediaStreamDestination();
  const oscillator=context.createOscillator(), modulation=context.createGain();
  oscillator.frequency.value=35; modulation.gain.value=0;
  oscillator.connect(modulation); modulation.connect(gain.gain); oscillator.start();
  source.connect(filter); filter.connect(gain); gain.connect(destination);
  function set(value) {
    filter.type=value==='warm'?'lowpass':value==='bright'?'highpass':value==='radio'?'bandpass':'allpass';
    filter.frequency.value=value==='warm'?1800:value==='bright'?350:1200;filter.Q.value=value==='radio'?0.7:0.3;
    gain.gain.value=value==='robot'?0.6:1;modulation.gain.value=value==='robot'?0.4:0;
  }
  set(choice);
  return {track:destination.stream.getAudioTracks()[0],set,close(){source.disconnect();oscillator.stop();destination.stream.getTracks().forEach(t=>t.stop());return context.close();}};
}
