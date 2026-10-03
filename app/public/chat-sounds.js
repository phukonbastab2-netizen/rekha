// Original, short conversation tones. No audio assets or microphone access are needed.
export function createChatSounds({scope='customer',incomingRole='assistant',canPlay=()=>true,documentTarget=globalThis.document,storage,createAudioContext,now=()=>globalThis.performance?.now?.()??Date.now()}={}){
  const key=`rekha:${String(scope)}:chat-sounds`,trackers=new Map(),maxTrackers=512,voices=new Set();
  const lastPlayed={sent:-Infinity,received:-Infinity},soundUntil={sent:0,received:0};
  let preference=true,context=null,interacted=false,destroyed=false,inboxSeeded=false,latestIncomingId=0;
  try{storage??=globalThis.localStorage;preference=storage?.getItem(key)!=='0';}catch{}
  const available=()=>{try{return !destroyed&&preference&&!documentTarget?.hidden&&documentTarget?.visibilityState!=='hidden'&&canPlay()!==false;}catch{return false;}};
  const mediaPlaying=()=>{try{return [...(documentTarget?.querySelectorAll('audio,video')||[])].some(media=>!media.paused&&!media.ended);}catch{return true;}};
  const makeContext=createAudioContext||(()=>{const AudioContext=globalThis.AudioContext||globalThis.webkitAudioContext;return AudioContext?new AudioContext():null;});
  function release(voice){voices.delete(voice);try{voice.oscillator.disconnect();}catch{}try{voice.gain.disconnect();}catch{}}
  function stop(){for(const voice of [...voices]){try{voice.oscillator.stop();}catch{}release(voice);}soundUntil.sent=0;soundUntil.received=0;}
  function ensureContext(){try{if(!context||context.state==='closed'){context=makeContext();soundUntil.sent=0;soundUntil.received=0;}if(context?.state==='suspended')Promise.resolve(context.resume()).catch(()=>{});}catch{}}
  function prime(event){
    if(destroyed||event?.isTrusted!==true)return;interacted=true;if(!available())return;
    ensureContext();
  }
  function play(kind){
    if(kind!=='sent'&&kind!=='received'||!interacted||!available()||mediaPlaying()||context?.state!=='running')return false;
    try{
      const stamp=now(),start=context.currentTime;
      if(!Number.isFinite(stamp)||!Number.isFinite(start)||stamp-lastPlayed[kind]<140||start<soundUntil[kind])return false;
      const notes=kind==='sent'?[{offset:0,duration:.12,from:620,to:940,end:460,type:'triangle',volume:.045}]:[{offset:0,duration:.065,from:690,to:760,end:655,type:'sine',volume:.04},{offset:.075,duration:.085,from:920,to:1010,end:870,type:'sine',volume:.04}];
      const started=[];
      try{
        for(const note of notes){
          const oscillator=context.createOscillator(),gain=context.createGain(),voice={oscillator,gain};started.push(voice);voices.add(voice);
          const at=start+note.offset,end=at+note.duration;oscillator.type=note.type;
          oscillator.frequency.setValueAtTime(note.from,at);oscillator.frequency.exponentialRampToValueAtTime(note.to,at+.018);oscillator.frequency.exponentialRampToValueAtTime(note.end,end);
          gain.gain.setValueAtTime(.0001,at);gain.gain.linearRampToValueAtTime(note.volume,at+.004);gain.gain.exponentialRampToValueAtTime(.0001,end);
          oscillator.connect(gain);gain.connect(context.destination);oscillator.onended=()=>release(voice);oscillator.start(at);oscillator.stop(end+.005);
        }
      }catch{for(const voice of started){try{voice.oscillator.stop();}catch{}release(voice);}return false;}
      lastPlayed[kind]=stamp;soundUntil[kind]=start+(kind==='sent'?.125:.165);return true;
    }catch{return false;}
  }
  function conversationId(value){const id=value?.id??value?.conversationId;return id===undefined||id===null||String(id)===''?null:String(id);}
  function positiveId(value){const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:0;}
  function remember(id,highwater){const previous=trackers.get(id);trackers.delete(id);const current=Math.max(previous?.highwater||0,highwater);trackers.set(id,{highwater:current});while(trackers.size>maxTrackers)trackers.delete(trackers.keys().next().value);latestIncomingId=Math.max(latestIncomingId,current);return previous;}
  // A saved customer row can be pending/failed because its astrologer reply is
  // pending/failed. That is distinct from a local outbox sendState.
  function accepted(message){const rejectedStatus=message.role==='user'?['outgoing','queued','sending','retrying']:['pending','failed','outgoing','queued','sending','retrying'];return !message.deleted&&!rejectedStatus.includes(message.status)&&!['pending','failed','queued','sending','retrying','outgoing'].includes(message.sendState);}
  function observe(thread,{kind='mutation'}={}){
    if(destroyed)return false;const id=conversationId(thread);if(id===null||!Array.isArray(thread?.messages))return false;
    const previous=trackers.get(id),baseline=previous?.highwater||0;
    let highest=baseline,received=false;
    for(const message of thread.messages){if(message?.role!==incomingRole)continue;const messageId=positiveId(message.id);highest=Math.max(highest,messageId);if(messageId>baseline&&accepted(message))received=true;}
    remember(id,highest);
    return !!previous&&kind!=='initial'&&kind!=='older'&&received?play('received'):false;
  }
  function observeInbox(rows,{kind='delta'}={}){
    if(destroyed||!Array.isArray(rows))return false;const initial=!inboxSeeded||kind==='initial'||kind==='older',priorLatest=latestIncomingId;inboxSeeded=true;let received=false;
    for(const row of rows){const id=conversationId(row);if(id===null)continue;const messageId=positiveId(row.latestUserId),previous=trackers.get(id),baseline=previous?.highwater||0;
      // Unknown old rows can reappear after filtering or LRU eviction. Only IDs newer
      // than the inbox baseline establish a genuinely new unread conversation.
      if(!initial&&Number(row.unread)>0&&messageId>baseline&&(previous||messageId>priorLatest))received=true;remember(id,messageId);
    }
    return received?play('received'):false;
  }
  const visibility=()=>{if(documentTarget?.hidden||documentTarget?.visibilityState==='hidden')stop();};
  documentTarget?.addEventListener('pointerdown',prime,{passive:true,capture:true});documentTarget?.addEventListener('keydown',prime,{passive:true,capture:true});documentTarget?.addEventListener('visibilitychange',visibility);
  return{
    enabled:()=>preference,
    setEnabled(value){preference=Boolean(value);try{storage?.setItem(key,preference?'1':'0');}catch{}if(!preference)stop();else if(interacted&&available())ensureContext();return preference;},
    play,observe,observeInbox,
    reset(){trackers.clear();inboxSeeded=false;latestIncomingId=0;lastPlayed.sent=-Infinity;lastPlayed.received=-Infinity;stop();},
    destroy(){if(destroyed)return;destroyed=true;stop();trackers.clear();documentTarget?.removeEventListener('pointerdown',prime,true);documentTarget?.removeEventListener('keydown',prime,true);documentTarget?.removeEventListener('visibilitychange',visibility);try{Promise.resolve(context?.close()).catch(()=>{});}catch{}context=null;},
  };
}
