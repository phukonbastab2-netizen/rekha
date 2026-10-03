import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/voice-effects-worklet.js',import.meta.url),'utf8');
function render(pitch=1,robot=0,frequency=440){
  let Processor;vm.runInNewContext(source,{AudioWorkletProcessor:class{},sampleRate:48000,Float32Array,Math,registerProcessor:(name,value)=>{assert.equal(name,'rekha-call-voice');Processor=value;}});
  const processor=new Processor(),output=new Float32Array(48000*3),parameters={pitch:new Float32Array([pitch]),robot:new Float32Array([robot])};
  for(let at=0;at<output.length;at+=128){const input=new Float32Array(128),block=new Float32Array(128);for(let i=0;i<128;i++)input[i]=Math.sin((at+i)*2*Math.PI*frequency/48000)*.4;assert.equal(processor.process([[input]],[[block]],parameters),true);output.set(block.subarray(0,Math.min(128,output.length-at)),at);}
  return output;
}
function spectrum(samples){
  const size=32768,real=new Float64Array(size),imaginary=new Float64Array(size),offset=48000;
  for(let i=0;i<size;i++)real[i]=samples[offset+i]*(.5-.5*Math.cos(2*Math.PI*i/(size-1)));
  for(let i=1,j=0;i<size;i++){let bit=size>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){const value=real[i];real[i]=real[j];real[j]=value;}}
  for(let width=2;width<=size;width*=2){const angle=-2*Math.PI/width;for(let start=0;start<size;start+=width){for(let j=0;j<width/2;j++){const cosine=Math.cos(angle*j),sine=Math.sin(angle*j),next=start+j+width/2,first=start+j,r=real[next]*cosine-imaginary[next]*sine,im=real[next]*sine+imaginary[next]*cosine;real[next]=real[first]-r;imaginary[next]=imaginary[first]-im;real[first]+=r;imaginary[first]+=im;}}}
  const peaks=[];for(let bin=Math.floor(200*size/48000);bin<Math.ceil(900*size/48000);bin++){const power=real[bin]**2+imaginary[bin]**2;peaks.push({frequency:bin*48000/size,power});}return peaks.sort((a,b)=>b.power-a.power);
}
test('local call processor transposes lower and higher pitches',()=>{
  const lower=spectrum(render(2**(-4/12)))[0].frequency,higher=spectrum(render(2**(4/12)))[0].frequency;
  assert.ok(Math.abs(lower-440*2**(-4/12))<5,`lower pitch ${lower}`);assert.ok(Math.abs(higher-440*2**(4/12))<5,`higher pitch ${higher}`);
});
test('natural processor preserves audio and robot changes its spectrum',()=>{
  assert.ok(Math.abs(spectrum(render())[0].frequency-440)<2);
  const robot=spectrum(render(1,1)),peaks=robot.slice(0,12);assert.ok(peaks.some(p=>Math.abs(p.frequency-405)<2));assert.ok(peaks.some(p=>Math.abs(p.frequency-475)<2));
});
test('processor stays finite at minimum and maximum pitch and clears silent input',()=>{
  for(const ratio of [.65,1,1.5]){const audio=render(ratio,.5);assert.ok(audio.every(value=>Number.isFinite(value)&&Math.abs(value)<.5));}
  let Processor;vm.runInNewContext(source,{AudioWorkletProcessor:class{},sampleRate:48000,Float32Array,Math,registerProcessor:(name,value)=>Processor=value});const processor=new Processor(),output=new Float32Array(128);processor.process([[]],[[output]],{pitch:new Float32Array([1.5]),robot:new Float32Array([1])});assert.ok(output.every(value=>value===0));
});
