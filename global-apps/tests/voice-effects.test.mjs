import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceEffect,voiceChoices} from '../shared/voice-effects.js';
test('live effects route microphone to outgoing track, change presets and release audio',async()=>{
  const nodes=[];let resumed=false,closed=false,stopped=false;
  const track={stop(){stopped=true;}};
  const node=()=>{const n={gain:{value:0},frequency:{value:0},Q:{value:0},connections:[],connect(to){this.connections.push(to);},disconnect(){this.disconnected=true;},start(){this.started=true;},stop(){this.stopped=true;}};nodes.push(n);return n;};
  globalThis.AudioContext=class {async resume(){resumed=true;}createMediaStreamSource(stream){assert.equal(stream,'microphone');return node();}createBiquadFilter(){return node();}createGain(){return node();}createMediaStreamDestination(){const n=node();n.stream={getAudioTracks:()=>[track],getTracks:()=>[track]};return n;}createOscillator(){return node();}async close(){closed=true;}};
  try{const effect=await createVoiceEffect('microphone','warm');assert.equal(effect.track,track);assert.equal(resumed,true);assert.equal(nodes[1].type,'lowpass');assert.equal(nodes[0].connections[0],nodes[1]);assert.equal(nodes[2].connections[0],nodes[3]);for(const [value]of voiceChoices)effect.set(value);assert.equal(nodes[5].gain.value,0.4);await effect.close();assert.equal(stopped,true);assert.equal(closed,true);assert.equal(nodes[4].stopped,true);assert.equal(nodes[0].disconnected,true);}finally{delete globalThis.AudioContext;}
});
