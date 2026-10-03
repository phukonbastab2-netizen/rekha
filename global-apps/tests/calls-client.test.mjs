import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installCalls} from '../shared/calls.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function settle(){for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));}

function fixture(role='customer'){
  const saved=new Map(),replace=(key,value)=>{saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
  let now=1000,serial=0;const tasks=new Map(),listeners=new Map(),requests=[],notices=[],peers=[],relays=[],streams=[],mediaRequests=[],audioNodes=[],contexts=[],calls=new Map();
  const originalNow=Date.now;Date.now=()=>now;
  replace('setTimeout',(fn,delay=0)=>{const id=++serial;tasks.set(id,{at:now+delay,fn});return id;});replace('clearTimeout',id=>tasks.delete(id));
  class Track{constructor(kind='audio'){this.kind=kind;this.enabled=true;this.stopped=false;this.readyState='live';}stop(){this.stopped=true;this.readyState='ended';}}
  class Stream{constructor(tracks=[]){this.tracks=tracks;}getTracks(){return this.tracks;}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}addTrack(t){this.tracks.push(t);}}
  replace('MediaStream',Stream);
  class Element{
    constructor(tag='div',root=null){this.tagName=tag;this.root=root||this;this.children=[];this.nodes=new Map();this.className='';this.textContent='';this.hidden=false;}
    set innerHTML(html){this.html=html;const root=this.root;if(html.includes('<h2>')){for(const selector of ['h2','.call-status','.call-videos','.call-remote','.call-local','.call-buttons','.call-audio-status','.call-audio-actions','.call-microphone-status','.call-microphone-actions','.call-relay-status','.call-relay-actions'])root.nodes.set(selector,new Element(selector,root));for(const selector of ['.call-audio-status','.call-audio-actions','.call-microphone-status','.call-microphone-actions','.call-relay-status','.call-relay-actions'])root.nodes.get(selector).hidden=true;}for(const selector of ['.call-end','.call-answer','.call-mute','.call-play','.call-resume-mic','.call-use-natural','.call-resume-audio']){const cls=selector.slice(1);if(html.includes('class="'+cls+'"'))root.nodes.set(selector,new Element(cls,root));else if(this!==root||html.includes('<h2>')){if(!['.call-play','.call-resume-mic','.call-use-natural','.call-resume-audio'].includes(selector))root.nodes.delete(selector);}}}
    get innerHTML(){return this.html;}
    querySelector(selector){return this.nodes.get(selector)||this.children.find(e=>e.className===selector.slice(1))||null;}
    append(child){child.parent=this;this.children.push(child);}setAttribute(){}add(option){this.children.push(option);}play(){return Promise.resolve();}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
  }
  const body=new Element('body'),document={hidden:false,body,createElement:tag=>new Element(tag),querySelectorAll:selector=>selector==='.voice-choice'?[controls.querySelector(selector)].filter(Boolean):[],addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);}};replace('document',document);replace('Option',class {constructor(label,value){this.label=label;this.value=value;}});
  replace('location',{origin:'https://fixture.test',href:'https://fixture.test/'});
  let permission=null;replace('navigator',{mediaDevices:{getUserMedia:async constraints=>{mediaRequests.push(constraints);if(permission)return permission.promise;const stream=new Stream([new Track(),...(constraints.video?[new Track('video')]:[])]);streams.push(stream);return stream;}}});
  class Peer{
    constructor(config){this.config=config;this.connectionState='new';this.tracks=[];this.senders=[];peers.push(this);}addTrack(track,stream){const entry={track,stream};this.tracks.push(entry);const sender={track,replaceCalls:[],replaceTrack:async next=>{sender.replaceCalls.push(next);if(sender.replacePending)await sender.replacePending.promise;sender.track=next;entry.track=next;}};this.senders.push(sender);return sender;}
    async createOffer(){return {type:'offer',sdp:'v=0 mock-offer'};}async createAnswer(){return {type:'answer',sdp:'v=0 mock-answer'};}
    async setLocalDescription(value){this.localDescription=value;}async setRemoteDescription(value){this.remoteDescription=value;}async addIceCandidate(){}close(){this.closed=true;}
    change(state){this.connectionState=state;this.onconnectionstatechange?.();}
  }replace('RTCPeerConnection',Peer);
  const node=()=>{const n={gain:{value:0},frequency:{value:0},Q:{value:0},connect(){},disconnect(){},start(){},stop(){this.stopped=true;}};audioNodes.push(n);return n;};
  let resumeMode='running';
  replace('AudioContext',class {constructor(){this.state='suspended';this.listeners=new Set();this.resumeCount=0;contexts.push(this);}addEventListener(type,fn){if(type==='statechange')this.listeners.add(fn);}removeEventListener(type,fn){if(type==='statechange')this.listeners.delete(fn);}change(state){this.state=state;this.onstatechange?.();for(const fn of this.listeners)fn();}async resume(){this.resumeCount++;if(resumeMode==='reject')throw Error('Audio unavailable');if(resumeMode==='pending')return new Promise(()=>{});this.change('running');}createMediaStreamSource(){return node();}createBiquadFilter(){return node();}createGain(){return node();}createOscillator(){return node();}createMediaStreamDestination(){const n=node();n.stream=new Stream([new Track()]);return n;}async close(){this.closed=true;this.change('closed');}});
  let configCalls=0,postCallDeferred=null,relayConfigured=false,nextRelayReady=null,failedSignals=0;
  const createRelay=options=>{const stateListeners=new Set();const helper={stream:options.stream,url:options.url,state:'running',readyPromise:nextRelayReady?.promise||Promise.resolve(),resumeCount:0,setCalls:[],subscribeState(fn){stateListeners.add(fn);fn(helper.state);return()=>stateListeners.delete(fn);},async setStream(stream){helper.setCalls.push(stream);if(helper.setPending)await helper.setPending.promise;if(helper.closed)throw Error('Relay closed');helper.stream=stream;},async resume(){helper.resumeCount++;if(helper.resumePending)await helper.resumePending.promise;if(helper.closed)throw Error('Relay closed');helper.audio('running');},audio(state){helper.state=state;for(const fn of stateListeners)fn(state);},peer(state){options.onState(state);},error(message){options.onError(message);},close(){helper.closed=true;stateListeners.clear();options.onState('disconnected');},get listeners(){return stateListeners;}};nextRelayReady=null;relays.push(helper);options.onState('waiting');return helper;};
  replace('fetch',async(url,options={})=>{
    const path=url.replace(/^\/api\/(admin\/)?calls/,''),method=options.method||'GET',data=options.body?JSON.parse(options.body):null;requests.push({path,method,data});if(method==='GET'&&path.includes('/signals')&&failedSignals>0){failedSignals--;throw Error('Offline');}let result;
    if(path.split('?')[0]==='/config'){configCalls++;result={iceServers:[{urls:'turn:fixture.invalid',username:'user-'+configCalls,credential:'fixture-only'}],expiresAt:now+10000,voiceRelayConfigured:relayConfigured};}
    else if(path===''&&method==='GET')result={calls:[...calls.values()].filter(c=>c.status!=='ended')};
    else if(path===''&&method==='POST'){if(postCallDeferred)result=await postCallDeferred.promise;else{result={id:'outgoing-'+(calls.size+1),conversationId:'conversation',caller:role,type:data.type,status:'ringing'};calls.set(result.id,result);}}
    else{const [,id,action]=path.match(/^\/([^/]+)\/(accept|end|signals)/)||[];const call=calls.get(id);assert.ok(call,'Unknown mock call '+path);if(action==='accept'){call.status='active';result={...call};}else if(action==='end'){call.status='ended';call.reason=data.reason;result={ok:true};}else if(method==='GET')result={call:{...call},signals:call.caller===role?[]:[{id:1,kind:'offer',payload:{type:'offer',sdp:'v=0 mock-incoming'}}]};else result={ok:true};}
    return {ok:true,json:async()=>structuredClone(result)};
  });
  const controls=new Element('controls'),client=installCalls({role,getConversationId:()=> 'conversation',notify:text=>notices.push(text),createRelay});client.mount(controls);
  return {client,controls,requests,notices,peers,relays,streams,mediaRequests,audioNodes,contexts,calls,tasks,listeners,
    relayConfigured(value=true){relayConfigured=value;},
    failSignals(count=1){failedSignals=count;},
    deferRelayReady(){nextRelayReady=deferred();return nextRelayReady;},
    resumeMode(value){resumeMode=value;},
    panel:()=>body.children.find(x=>x.className==='call-panel'),
    incoming(id='incoming-1'){const c={id,conversationId:'conversation',caller:role==='admin'?'customer':'admin',type:'voice',status:'ringing',customerName:'Fixture'};calls.set(id,c);return c;},
    deferPermission(){permission=deferred();return permission;},
    stream(){const s=new Stream([new Track()]);streams.push(s);return s;},
    deferPost(){postCallDeferred=deferred();return postCallDeferred;},
    async advance(ms){const until=now+ms;for(;;){const next=[...tasks.entries()].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;tasks.delete(next[0]);next[1].fn();await settle();}now=until;await settle();},
    async visible(value){document.hidden=!value;listeners.get('visibilitychange')?.();await settle();},
    async dispose(){await client.destroy();await settle();Date.now=originalNow;for(const [key,descriptor]of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
  };
}

test('customer discovers incoming calls while idle, pauses hidden polling and keeps listening after decline',async()=>{
  const f=fixture();try{
    await f.advance(0);assert.equal(f.requests.filter(r=>r.path===''&&r.method==='GET').length,1);
    f.incoming();await f.advance(4999);assert.equal(f.panel(),undefined);await f.advance(1);assert.ok(f.panel());assert.ok(f.notices.includes('Incoming voice call.'));
    await f.panel().querySelector('.call-end').onclick();assert.equal(f.calls.get('incoming-1').reason,'declined');
    f.incoming('incoming-2');await f.advance(5000);assert.ok(f.panel(),'call cleanup must keep the incoming listener');
    await f.visible(false);const before=f.requests.length;await f.advance(10000);assert.equal(f.requests.length,before);await f.visible(true);assert.ok(f.requests.length>before);
    await f.client.destroy();assert.equal(f.tasks.size,0);assert.equal(f.listeners.size,0);
  }finally{await f.dispose();}
});

test('late microphone permission after destroy stops the stream without creating an outgoing call',async()=>{
  const f=fixture();try{
    const pending=f.deferPermission(),start=f.controls.children.find(e=>e.className==='call-launch').onclick();await settle();await f.client.destroy();const stream=f.stream();pending.resolve(stream);await start;
    assert.ok(stream.getTracks().every(t=>t.stopped));assert.equal(f.requests.filter(r=>r.path===''&&r.method==='POST').length,0);assert.equal(f.peers.length,0);
  }finally{await f.dispose();}
});

test('answering an incoming call exchanges descriptions, polls at the active interval and cleans a remote end',async()=>{
  const f=fixture();try{
    const call=f.incoming();await f.advance(0);await f.panel().querySelector('.call-answer').onclick();assert.equal(call.status,'active');assert.equal(f.peers[0].remoteDescription.type,'offer');assert.equal(f.requests.filter(r=>r.data?.kind==='answer').length,1);
    const before=f.requests.length;await f.advance(1499);assert.equal(f.requests.length,before);await f.advance(1);assert.ok(f.requests.length>before);
    call.status='ended';await f.advance(1500);assert.equal(f.panel(),undefined);assert.equal(f.peers[0].closed,true);assert.ok(f.streams[0].getTracks().every(t=>t.stopped));
    f.incoming('next-call');await f.advance(5000);assert.ok(f.panel());
  }finally{await f.dispose();}
});

test('late answer permission after decline does not accept or leak audio and listening resumes',async()=>{
  const f=fixture();try{
    f.incoming();await f.advance(0);const pending=f.deferPermission(),answer=f.panel().querySelector('.call-answer').onclick();await settle();await f.panel().querySelector('.call-end').onclick();const stream=f.stream();pending.resolve(stream);await answer;
    assert.ok(stream.getTracks().every(t=>t.stopped));assert.equal(f.requests.filter(r=>r.path.endsWith('/accept')).length,0);
    f.incoming('incoming-2');await f.advance(5000);assert.ok(f.panel());
  }finally{await f.dispose();}
});

test('destroy after call creation was requested ends that returned call and releases its prepared stream',async()=>{
  const f=fixture();try{
    const pending=f.deferPost(),start=f.controls.children.find(e=>e.className==='call-launch').onclick();await settle();assert.equal(f.requests.filter(r=>r.path===''&&r.method==='POST').length,1);await f.client.destroy();const call={id:'late-call',conversationId:'conversation',caller:'customer',type:'voice',status:'ringing'};f.calls.set(call.id,call);pending.resolve(call);await start;
    assert.equal(call.reason,'cancelled');assert.ok(f.streams[0].getTracks().every(t=>t.stopped));assert.equal(f.peers.length,0);
  }finally{await f.dispose();}
});

test('a disconnected call ends after 15 seconds, while a recovered connection cancels that deadline',async()=>{
  const f=fixture();try{
    await f.controls.children.find(e=>e.className==='call-launch').onclick();const peer=f.peers[0];peer.change('connected');peer.change('disconnected');await f.advance(5000);peer.change('connected');await f.advance(15000);assert.equal(peer.closed,undefined);
    peer.change('disconnected');await f.advance(14999);assert.equal(peer.closed,undefined);await f.advance(1);assert.equal(peer.closed,true);assert.ok(f.streams[0].getTracks().every(t=>t.stopped));assert.equal(f.calls.get('outgoing-1').reason,'connection-failed');assert.ok(f.notices.some(n=>n.includes('lost its connection')));
  }finally{await f.dispose();}
});

test('each admin call fetches fresh relay credentials and sends the selected processed voice track',async()=>{
  const f=fixture('admin');try{
    const voice=f.controls.querySelector('.voice-choice');voice.value='warm';voice.onchange();const launch=f.controls.children.find(e=>e.className==='call-launch');await launch.onclick();
    assert.equal(f.peers[0].config.iceServers[0].username,'user-1');assert.notEqual(f.peers[0].tracks[0].track,f.streams[0].getAudioTracks()[0]);assert.equal(f.audioNodes[1].type,'lowpass');
    const processed=f.peers[0].tracks[0].track;await f.panel().querySelector('.call-end').onclick();assert.equal(processed.stopped,true);await launch.onclick();assert.equal(f.peers[1].config.iceServers[0].username,'user-2');assert.deepEqual(f.requests.filter(r=>r.path.startsWith('/config')).map(r=>r.path),['/config?callId=outgoing-1','/config?callId=outgoing-2']);
  }finally{await f.dispose();}
});

test('blocked remote playback offers a gesture retry and explains connected audio until playback succeeds',async()=>{
  const f=fixture();try{
    await f.controls.children.find(e=>e.className==='call-launch').onclick();const panel=f.panel(),peer=f.peers[0],remote=panel.querySelector('.call-remote'),local=panel.querySelector('.call-local');let attempts=0,localPlays=0;remote.play=async()=>{attempts++;if(attempts===1)throw Object.assign(Error('Autoplay blocked'),{name:'NotAllowedError'});};local.play=async()=>{localPlays++;};
    peer.ontrack({track:f.stream().getAudioTracks()[0]});await settle();assert.equal(panel.querySelector('.call-audio-actions').hidden,false);assert.equal(panel.querySelector('.call-audio-status').textContent,'Tap Play call audio to hear the other person.');peer.change('connected');assert.equal(panel.querySelector('.call-status').textContent,'Connected · Tap to hear call audio');
    await panel.querySelector('.call-play').onclick();assert.equal(attempts,2);assert.equal(panel.querySelector('.call-audio-actions').hidden,true);assert.equal(panel.querySelector('.call-audio-status').hidden,true);assert.equal(panel.querySelector('.call-status').textContent,'Connected');assert.equal(localPlays,0);
  }finally{await f.dispose();}
});

test('old call playback completion cannot alter a new call panel',async()=>{
  const f=fixture();try{
    const launch=f.controls.children.find(e=>e.className==='call-launch');await launch.onclick();const old=f.panel(),pending=deferred();old.querySelector('.call-remote').play=()=>pending.promise;f.peers[0].change('connected');f.peers[0].ontrack({track:f.stream().getAudioTracks()[0]});await old.querySelector('.call-end').onclick();await launch.onclick();const next=f.panel();next.querySelector('.call-remote').play=async()=>{throw Error('Playback blocked');};f.peers[1].ontrack({track:f.stream().getAudioTracks()[0]});await settle();f.peers[1].change('connected');pending.resolve();await settle();assert.equal(next.querySelector('.call-status').textContent,'Connected · Tap to hear call audio');assert.equal(next.querySelector('.call-audio-actions').hidden,false);
  }finally{await f.dispose();}
});

test('an older playback rejection cannot overwrite a newer successful playback attempt',async()=>{
  const f=fixture();try{
    await f.controls.children.find(e=>e.className==='call-launch').onclick();const panel=f.panel(),peer=f.peers[0],pending=deferred();let attempts=0;panel.querySelector('.call-remote').play=()=>++attempts===1?pending.promise:Promise.resolve();peer.ontrack({track:f.stream().getAudioTracks()[0]});peer.ontrack({track:f.stream().getAudioTracks()[0]});await settle();peer.change('connected');pending.resolve(Promise.reject(Object.assign(Error('Old autoplay rejection'),{name:'NotAllowedError'})));await settle();assert.equal(panel.querySelector('.call-audio-actions').hidden,true);assert.equal(panel.querySelector('.call-status').textContent,'Connected');
  }finally{await f.dispose();}
});

test('Natural uses raw microphone with a visible notice when voice processing startup times out',async()=>{
  const f=fixture('admin');try{
    f.resumeMode('pending');const start=f.controls.children.find(e=>e.className==='call-launch').onclick();await settle();await f.advance(2000);await start;
    assert.equal(f.peers.length,1);assert.equal(f.peers[0].senders[0].track,f.streams[0].getAudioTracks()[0]);assert.equal(f.streams[0].getAudioTracks()[0].stopped,false);assert.equal(f.contexts[0].closed,true);assert.equal(f.panel().querySelector('.call-microphone-status').hidden,false);assert.match(f.panel().querySelector('.call-microphone-status').textContent,/Using Natural microphone audio/);
    const select=f.controls.querySelector('.voice-choice');select.value='robot';select.onchange();assert.equal(select.value,'natural');assert.match(f.panel().querySelector('.call-microphone-status').textContent,/end this call/);
  }finally{await f.dispose();}
});

test('an unavailable altered preset ends clearly rather than transmitting raw microphone audio',async()=>{
  const f=fixture('admin');try{
    const select=f.controls.querySelector('.voice-choice');select.value='warm';select.onchange();f.resumeMode('reject');await f.controls.children.find(e=>e.className==='call-launch').onclick();
    assert.equal(f.peers.length,0);assert.ok(f.streams[0].getTracks().every(t=>t.stopped));assert.equal(f.contexts[0].closed,true);assert.ok(f.notices.includes('Voice effect unavailable. Choose Natural and call again.'));assert.equal(f.calls.get('outgoing-1').reason,'connection-failed');
  }finally{await f.dispose();}
});

test('interrupted microphone processing can resume without clearing the remote playback warning',async()=>{
  const f=fixture('admin');try{
    await f.controls.children.find(e=>e.className==='call-launch').onclick();const panel=f.panel(),peer=f.peers[0],context=f.contexts[0],processed=peer.senders[0].track;panel.querySelector('.call-remote').play=async()=>{throw Error('Playback blocked');};peer.ontrack({track:f.stream().getAudioTracks()[0]});await settle();context.change('interrupted');
    assert.equal(panel.querySelector('.call-microphone-actions').hidden,false);assert.match(panel.querySelector('.call-microphone-status').textContent,/Microphone paused/);assert.equal(panel.querySelector('.call-audio-actions').hidden,false);await panel.querySelector('.call-resume-mic').onclick();
    assert.equal(context.state,'running');assert.equal(panel.querySelector('.call-microphone-actions').hidden,true);assert.equal(panel.querySelector('.call-microphone-status').hidden,true);assert.equal(panel.querySelector('.call-audio-actions').hidden,false);assert.equal(peer.senders[0].track,processed);await panel.querySelector('.call-end').onclick();assert.equal(context.listeners.size,0);assert.equal(processed.stopped,true);
  }finally{await f.dispose();}
});

test('Use Natural replaces only outgoing audio, keeps mute and prevents silently selecting an unavailable effect',async()=>{
  const f=fixture('admin');try{
    const select=f.controls.querySelector('.voice-choice');select.value='warm';select.onchange();await f.controls.children.find(e=>e.className==='call-launch').onclick();const panel=f.panel(),peer=f.peers[0],raw=f.streams[0].getAudioTracks()[0],processed=peer.senders[0].track;panel.querySelector('.call-mute').onclick();assert.equal(raw.enabled,false);f.contexts[0].change('suspended');await panel.querySelector('.call-use-natural').onclick();
    assert.equal(peer.senders[0].track,raw);assert.equal(raw.enabled,false);assert.equal(processed.stopped,true);assert.equal(f.contexts[0].closed,true);assert.equal(f.contexts[0].listeners.size,0);assert.equal(select.value,'natural');assert.equal(panel.querySelector('.call-microphone-actions').hidden,true);assert.match(panel.querySelector('.call-microphone-status').textContent,/Using Natural microphone audio/);select.value='bright';select.onchange();assert.equal(select.value,'natural');assert.equal(peer.senders[0].track,raw);
  }finally{await f.dispose();}
});

test('a late Natural replacement after hangup cannot change a new call or transmit its stopped microphone',async()=>{
  const f=fixture('admin');try{
    const select=f.controls.querySelector('.voice-choice'),launch=f.controls.children.find(e=>e.className==='call-launch');select.value='warm';select.onchange();await launch.onclick();const old=f.panel(),oldPeer=f.peers[0],raw=f.streams[0].getAudioTracks()[0],pending=deferred();f.contexts[0].change('interrupted');oldPeer.senders[0].replacePending=pending;const change=old.querySelector('.call-use-natural').onclick();await old.querySelector('.call-resume-mic').onclick();assert.equal(f.contexts[0].resumeCount,1);await old.querySelector('.call-end').onclick();select.value='bright';select.onchange();await launch.onclick();const next=f.panel();pending.resolve();await change;
    assert.equal(raw.stopped,true);assert.equal(raw.readyState,'ended');assert.equal(oldPeer.closed,true);assert.equal(select.value,'bright');assert.equal(f.contexts[1].closed,undefined);assert.equal(next.querySelector('.call-microphone-status').hidden,true);
  }finally{await f.dispose();}
});

test('visibility rechecks microphone state and cleanup cancels a pending resume without changing another call',async()=>{
  const f=fixture('admin');try{
    const launch=f.controls.children.find(e=>e.className==='call-launch');await launch.onclick();const old=f.panel(),context=f.contexts[0];context.state='interrupted';await f.visible(false);assert.equal(old.querySelector('.call-microphone-actions').hidden,false);await f.visible(true);assert.equal(context.resumeCount,1);f.resumeMode('pending');const resume=old.querySelector('.call-resume-mic').onclick();await settle();assert.equal(old.querySelector('.call-use-natural').disabled,true);await old.querySelector('.call-end').onclick();f.resumeMode('running');await launch.onclick();await resume;assert.equal(context.listeners.size,0);assert.equal(f.contexts[1].closed,undefined);assert.equal(f.panel().querySelector('.call-microphone-status').hidden,true);
  }finally{await f.dispose();}
});

for(const role of ['customer','admin'])test(`${role} voice caller waits for acceptance, uses owned relay and keeps heartbeats without RTC negotiation`,async()=>{
  const f=fixture(role);try{
    f.relayConfigured();await f.controls.children.find(e=>e.className==='call-launch').onclick();assert.equal(f.peers.length,0);assert.equal(f.relays.length,0);assert.equal(f.calls.get('outgoing-1').status,'ringing');assert.equal(f.panel().querySelector('.call-status').textContent,'Calling…');f.calls.get('outgoing-1').status='active';await f.advance(1500);
    const helper=f.relays[0];assert.ok(helper);assert.equal(helper.url,`wss://fixture.test/api/${role==='admin'?'admin/':''}calls/outgoing-1/audio`);assert.equal(f.panel().querySelector('.call-status').textContent,'Waiting for the other person…');assert.equal(helper.stream.getAudioTracks().length,1);assert.equal(f.panel().querySelector('.call-videos').hidden,true);assert.equal(f.requests.filter(r=>['offer','answer','ice'].includes(r.data?.kind)).length,0);helper.peer('connected');assert.equal(f.panel().querySelector('.call-status').textContent,'Connected');const reads=f.requests.filter(r=>r.method==='GET'&&r.path.includes('/signals')).length;await f.advance(1500);assert.ok(f.requests.filter(r=>r.method==='GET'&&r.path.includes('/signals')).length>reads);
    await f.panel().querySelector('.call-end').onclick();assert.equal(helper.closed,true);assert.equal(helper.listeners.size,0);assert.equal(f.calls.get('outgoing-1').reason,'completed');assert.ok(f.streams[0].getTracks().every(t=>t.stopped));assert.equal(f.notices.some(n=>n.includes('disconnected')),false);assert.deepEqual(f.mediaRequests[0].audio,{echoCancellation:true,noiseSuppression:true});
  }finally{await f.dispose();}
});

for(const role of ['customer','admin'])test(`${role} voice recipient opens relay after accepting and handles a server end without RTC answer`,async()=>{
  const f=fixture(role);try{
    f.relayConfigured();const call=f.incoming();await f.advance(0);await f.panel().querySelector('.call-answer').onclick();assert.equal(call.status,'active');assert.equal(f.peers.length,0);assert.equal(f.relays.length,1);assert.equal(f.requests.filter(r=>r.data?.kind==='answer').length,0);f.relays[0].peer('connected');assert.equal(f.panel().querySelector('.call-status').textContent,'Connected');call.status='ended';await f.advance(1500);assert.equal(f.panel(),undefined);assert.equal(f.relays[0].closed,true);assert.equal(f.requests.filter(r=>r.path.endsWith('/end')).length,0);assert.ok(f.notices.includes('Call ended.'));
  }finally{await f.dispose();}
});

test('video keeps RTC offer negotiation even when the voice relay is configured',async()=>{
  const f=fixture();try{
    f.relayConfigured();await f.controls.children.filter(e=>e.className==='call-launch')[1].onclick();assert.equal(f.peers.length,1);assert.equal(f.relays.length,0);assert.equal(f.requests.filter(r=>r.data?.kind==='offer').length,1);assert.equal(f.streams[0].getTracks().length,2);
  }finally{await f.dispose();}
});

test('admin relay receives processed audio and switches to Natural only after replacing its source, preserving mute',async()=>{
  const f=fixture('admin');try{
    f.relayConfigured();const select=f.controls.querySelector('.voice-choice');select.value='robot';select.onchange();await f.controls.children.find(e=>e.className==='call-launch').onclick();f.calls.get('outgoing-1').status='active';await f.advance(1500);const panel=f.panel(),helper=f.relays[0],raw=f.streams[0].getAudioTracks()[0],processed=helper.stream.getAudioTracks()[0];assert.notEqual(processed,raw);panel.querySelector('.call-mute').onclick();f.contexts[0].change('interrupted');const pending=deferred();helper.setPending=pending;const change=panel.querySelector('.call-use-natural').onclick();await settle();assert.equal(f.contexts[0].closed,undefined);assert.equal(helper.stream.getAudioTracks()[0],processed);pending.resolve();await change;
    assert.equal(helper.stream.getAudioTracks()[0],raw);assert.equal(raw.enabled,false);assert.equal(processed.stopped,true);assert.equal(f.contexts[0].closed,true);assert.equal(select.value,'natural');assert.equal(f.peers.length,0);
  }finally{await f.dispose();}
});

test('Natural recovery before relay acceptance supplies the updated raw audio when the relay opens',async()=>{
  const f=fixture('admin');try{
    f.relayConfigured();await f.controls.children.find(e=>e.className==='call-launch').onclick();const raw=f.streams[0].getAudioTracks()[0];f.panel().querySelector('.call-mute').onclick();f.contexts[0].change('suspended');await f.panel().querySelector('.call-use-natural').onclick();assert.equal(f.relays.length,0);f.calls.get('outgoing-1').status='active';await f.advance(1500);assert.equal(f.relays[0].stream.getAudioTracks()[0],raw);assert.equal(raw.enabled,false);
  }finally{await f.dispose();}
});

test('relay audio recovery and microphone recovery use separate controls and preserve peer connection status',async()=>{
  const f=fixture('admin');try{
    f.relayConfigured();await f.controls.children.find(e=>e.className==='call-launch').onclick();f.calls.get('outgoing-1').status='active';await f.advance(1500);const panel=f.panel(),helper=f.relays[0];helper.peer('connected');helper.audio('suspended');f.contexts[0].change('interrupted');assert.equal(panel.querySelector('.call-relay-actions').hidden,false);assert.equal(panel.querySelector('.call-microphone-actions').hidden,false);await panel.querySelector('.call-resume-audio').onclick();assert.equal(helper.resumeCount,1);assert.equal(panel.querySelector('.call-relay-actions').hidden,true);assert.equal(panel.querySelector('.call-microphone-actions').hidden,false);assert.equal(panel.querySelector('.call-status').textContent,'Connected');await panel.querySelector('.call-resume-mic').onclick();assert.equal(panel.querySelector('.call-microphone-actions').hidden,true);assert.equal(panel.querySelector('.call-status').textContent,'Connected');assert.equal(panel.querySelector('.call-audio-actions').hidden,true);
  }finally{await f.dispose();}
});

test('relay disconnection ends a voice call and a late callback cannot alter its replacement',async()=>{
  const f=fixture();try{
    f.relayConfigured();const launch=f.controls.children.find(e=>e.className==='call-launch');await launch.onclick();f.calls.get('outgoing-1').status='active';await f.advance(1500);const old=f.relays[0];old.peer('connected');old.peer('disconnected');await settle();assert.equal(f.panel(),undefined);assert.equal(f.calls.get('outgoing-1').reason,'connection-failed');assert.equal(old.closed,true);await launch.onclick();const next=f.panel();old.peer('connected');old.error('Old call error');assert.equal(next.querySelector('.call-status').textContent,'Calling…');assert.equal(f.calls.get('outgoing-2').status,'ringing');
  }finally{await f.dispose();}
});

test('relay peer loss stays Reconnecting through heartbeats, recovers without changing mute or audio guidance, and ends after 15 seconds',async()=>{
  const f=fixture();try{
    f.relayConfigured();await f.controls.children.find(e=>e.className==='call-launch').onclick();f.calls.get('outgoing-1').status='active';await f.advance(1500);const panel=f.panel(),helper=f.relays[0],raw=f.streams[0].getAudioTracks()[0];helper.peer('connected');panel.querySelector('.call-mute').onclick();helper.audio('suspended');helper.peer('waiting');assert.equal(panel.querySelector('.call-status').textContent,'Reconnecting…');await f.advance(5000);assert.equal(panel.querySelector('.call-status').textContent,'Reconnecting…');assert.equal(raw.enabled,false);assert.equal(panel.querySelector('.call-relay-actions').hidden,false);helper.peer('connected');assert.equal(panel.querySelector('.call-status').textContent,'Connected');await f.advance(15000);assert.equal(helper.closed,undefined);assert.equal(raw.enabled,false);assert.equal(panel.querySelector('.call-relay-actions').hidden,false);
    helper.peer('waiting');await f.advance(5000);helper.peer('waiting');await f.advance(9999);assert.equal(helper.closed,undefined);assert.equal(panel.querySelector('.call-status').textContent,'Reconnecting…');await f.advance(1);assert.equal(helper.closed,true);assert.equal(f.panel(),undefined);assert.equal(f.calls.get('outgoing-1').reason,'connection-failed');assert.equal(f.requests.filter(r=>r.path==='/outgoing-1/end').length,1);assert.ok(raw.stopped);assert.ok(f.notices.some(n=>n.includes('lost its connection')));
  }finally{await f.dispose();}
});

test('a healthy relay heartbeat restores Connected after a temporary signaling failure without clearing paused audio guidance',async()=>{
  const f=fixture();try{
    f.relayConfigured();await f.controls.children.find(e=>e.className==='call-launch').onclick();f.calls.get('outgoing-1').status='active';await f.advance(1500);const panel=f.panel(),helper=f.relays[0];helper.peer('connected');helper.audio('interrupted');f.failSignals();await f.advance(1500);assert.equal(panel.querySelector('.call-status').textContent,'Connection paused. Retrying…');await f.advance(1500);assert.equal(panel.querySelector('.call-status').textContent,'Connected');assert.equal(panel.querySelector('.call-relay-actions').hidden,false);assert.match(panel.querySelector('.call-relay-status').textContent,/Call audio paused/);
  }finally{await f.dispose();}
});

test('late relay readiness and Natural stream replacement after hangup cannot affect a new call',async()=>{
  const f=fixture('admin');try{
    f.relayConfigured();const launch=f.controls.children.find(e=>e.className==='call-launch');await launch.onclick();const ready=f.deferRelayReady();f.calls.get('outgoing-1').status='active';await f.advance(1500);const old=f.relays[0],panel=f.panel(),pending=deferred();old.setPending=pending;f.contexts[0].change('interrupted');const replace=panel.querySelector('.call-use-natural').onclick();await panel.querySelector('.call-end').onclick();await launch.onclick();const next=f.panel();ready.resolve();pending.resolve();await replace;await settle();assert.equal(old.closed,true);assert.ok(f.streams[0].getTracks().every(t=>t.stopped));assert.equal(f.contexts[1].closed,undefined);assert.equal(next.querySelector('.call-status').textContent,'Calling…');assert.equal(next.querySelector('.call-microphone-status').hidden,true);
  }finally{await f.dispose();}
});
