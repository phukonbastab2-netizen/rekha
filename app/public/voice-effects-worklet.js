// Small overlapping delay windows transpose the microphone without recording,
// uploading to a voice service, or replacing the customer's video track.
class RekhaCallVoice extends AudioWorkletProcessor{
  static get parameterDescriptors(){return [{name:'pitch',defaultValue:1,minValue:.65,maxValue:1.5,automationRate:'a-rate'},{name:'robot',defaultValue:0,minValue:0,maxValue:1,automationRate:'a-rate'}];}
  constructor(){super();this.buffer=new Float32Array(Math.ceil(sampleRate*.14));this.index=0;this.phase=.25;this.robotPhase=0;this.mix=0;this.window=sampleRate*.04;this.minimum=sampleRate*.008;}
  read(delay){let location=this.index-delay;while(location<0)location+=this.buffer.length;const first=Math.floor(location),fraction=location-first;return this.buffer[first]*(1-fraction)+this.buffer[(first+1)%this.buffer.length]*fraction;}
  process(inputs,outputs,parameters){
    const input=inputs[0]?.[0],output=outputs[0]?.[0];if(!output)return true;
    const pitch=parameters.pitch,robot=parameters.robot;
    for(let i=0;i<output.length;i++){
      const sample=input?.[i]||0,ratio=pitch[pitch.length===1?0:i];this.buffer[this.index]=sample;
      this.phase=(this.phase+(1-ratio)/this.window+1)%1;
      const other=(this.phase+.5)%1,weight=Math.sin(Math.PI*this.phase)**2;
      const shifted=this.read(this.minimum+this.phase*this.window)*weight+this.read(this.minimum+other*this.window)*(1-weight);
      this.mix+=((Math.abs(ratio-1)>.002?1:0)-this.mix)*.004;
      let value=sample*(1-this.mix)+shifted*this.mix;
      const robotMix=robot[robot.length===1?0:i];
      value=value*(1-robotMix)+value*Math.sin(this.robotPhase)*robotMix;
      this.robotPhase=(this.robotPhase+2*Math.PI*35/sampleRate)%(2*Math.PI);
      output[i]=value;this.index=(this.index+1)%this.buffer.length;
    }
    return true;
  }
}
registerProcessor('rekha-call-voice',RekhaCallVoice);
