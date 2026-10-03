// Private mono PCM relay: input is captured; only received audio reaches the output.
class RekhaVoiceRelayProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active=false;this.paused=false;this.alive=true;
    this.frame=new ArrayBuffer(1280);this.frameView=new DataView(this.frame);this.frameSamples=0;
    this.captureIndex=0;this.captureNext=0;this.capturePrevious=0;
    this.playback=[];this.queuedSamples=0;this.playbackPhase=0;
    this.filters=[{x1:0,x2:0,y1:0,y2:0},{x1:0,x2:0,y1:0,y2:0}];
    const omega=2*Math.PI*Math.min(7000,sampleRate*0.45)/sampleRate,cos=Math.cos(omega),sin=Math.sin(omega),alpha=sin/Math.SQRT2,den=1+alpha;
    this.coefficients={b0:(1-cos)/2/den,b1:(1-cos)/den,b2:(1-cos)/2/den,a1:-2*cos/den,a2:(1-alpha)/den};
    this.port.onmessage=event=>{
      const data=event.data;
      if(data?.type==='state') {
        const changed=this.active!==!!data.active||this.paused!==!!data.paused;
        this.active=!!data.active;this.paused=!!data.paused;
        if(changed)this.resetCapture();
        if(!this.active)this.clearPlayback();
      } else if(data?.type==='playback'&&data.pcm?.byteLength===1280&&this.alive) {
        const view=new DataView(data.pcm),samples=new Float32Array(640);
        for(let i=0;i<640;i++)samples[i]=view.getInt16(i*2,true)/32768;
        this.playback.push({samples,offset:0});this.queuedSamples+=640;
        if(this.queuedSamples>3840){this.discard(this.queuedSamples-3840);this.playbackPhase=0;}
      } else if(data?.type==='close') {this.alive=false;this.clearPlayback();this.resetCapture();}
    };
  }
  resetCapture() {
    this.frame=new ArrayBuffer(1280);this.frameView=new DataView(this.frame);this.frameSamples=0;
    this.captureIndex=0;this.captureNext=0;this.capturePrevious=0;
    for(const filter of this.filters)filter.x1=filter.x2=filter.y1=filter.y2=0;
  }
  clearPlayback(){this.playback=[];this.queuedSamples=0;this.playbackPhase=0;}
  discard(count) {
    let remaining=Math.min(count,this.queuedSamples);
    while(remaining>0&&this.playback.length){const first=this.playback[0],take=Math.min(remaining,first.samples.length-first.offset);first.offset+=take;this.queuedSamples-=take;remaining-=take;if(first.offset===first.samples.length)this.playback.shift();}
  }
  peek(offset) {
    for(const chunk of this.playback){const available=chunk.samples.length-chunk.offset;if(offset<available)return chunk.samples[chunk.offset+offset];offset-=available;}
    return 0;
  }
  lowpass(value) {
    if(sampleRate<=16000)return value;
    const c=this.coefficients;
    for(const f of this.filters){const next=c.b0*value+c.b1*f.x1+c.b2*f.x2-c.a1*f.y1-c.a2*f.y2;f.x2=f.x1;f.x1=value;f.y2=f.y1;f.y1=next;value=next;}
    return value;
  }
  capture(value) {
    value=this.lowpass(value);
    while(this.captureNext<=this.captureIndex){const fraction=this.captureIndex===0?1:this.captureNext-(this.captureIndex-1),sample=this.capturePrevious+(value-this.capturePrevious)*fraction,clamped=Math.max(-1,Math.min(1,sample));
      this.frameView.setInt16(this.frameSamples*2,Math.round(clamped*(clamped<0?32768:32767)),true);this.frameSamples++;
      if(this.frameSamples===640){const pcm=this.frame;this.port.postMessage({type:'capture',pcm},[pcm]);this.frame=new ArrayBuffer(1280);this.frameView=new DataView(this.frame);this.frameSamples=0;}
      this.captureNext+=sampleRate/16000;
    }
    this.capturePrevious=value;this.captureIndex++;
  }
  process(inputs,outputs) {
    const channels=inputs[0]||[],output=outputs[0]?.[0];
    for(const group of outputs)for(const channel of group)channel.fill(0);
    if(!this.alive)return false;
    if(!this.active||this.paused)return true;
    const length=output?.length||channels[0]?.length||128;
    for(let i=0;i<length;i++){
      if(channels.length){let value=0;for(const channel of channels)value+=channel[i]||0;this.capture(value/channels.length);}
      if(output&&this.queuedSamples){const first=this.peek(0),second=this.queuedSamples>1?this.peek(1):first;output[i]=first+(second-first)*this.playbackPhase;this.playbackPhase+=16000/sampleRate;const consumed=Math.floor(this.playbackPhase);this.playbackPhase-=consumed;this.discard(consumed);if(!this.queuedSamples)this.playbackPhase=0;}
    }
    return true;
  }
}
registerProcessor('rekha-voice-relay',RekhaVoiceRelayProcessor);
