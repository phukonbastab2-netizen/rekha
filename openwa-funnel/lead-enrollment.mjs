import {firstSequence,GAP} from './funnel.mjs';
import {validPeer,isSensitive} from './engine.mjs';

export const isNamaste = value => typeof value==='string' && /(?:^|[^\p{L}])namaste(?:$|[^\p{L}])|नमस्ते/iu.test(value.normalize('NFKC'));

// The owner explicitly treats an actual Namaste in either direction as a lead.
// Enrollment schedules the existing sequence; it never invents an incoming text.
export function enrollNamaste(engine,recordKey){
 if(!engine.settings().namasteLeads)return{started:false,reason:'disabled'};
 return engine.transaction(()=>{
  const m=engine.get(recordKey),c=m&&engine.contact(m.peer);
  if(m?.kind!=='message'||!c||!validPeer(m.peer)||m.sensitive||m.revoked||isSensitive(m.body)||!isNamaste(m.body)||m.source==='funnel'||m.direction==='out'&&!['owner_whatsapp','owner'].includes(m.source))return{started:false,reason:'not_a_lead'};
  if(c.isSelf||c.deleted||c.optedOut||c.paused||c.contentDeletedAt&&m.at<=c.contentDeletedAt)return{started:false,reason:'owner_controls'};
  if(c.firstStarted||engine.db.prepare("SELECT 1 FROM due_jobs WHERE peer=? AND phase='first' LIMIT 1").get(c.peer))return{started:false,reason:'already_started'};
  const at=engine.now();
  engine.put({...c,firstStarted:true,stage:'first_sequence',leadTrigger:'namaste',leadMessageKey:m.key,leadStartedAt:at});
  firstSequence.forEach((payload,step)=>engine.job(c.peer,'first',step,at+step*GAP,payload));
  return{started:true};
 });
}

export async function enrollStoredNamaste(engine){
 let cursor='',scanned=0,started=0;
 while(true){
  const rows=engine.db.prepare("SELECT key FROM records WHERE kind='message' AND key>? ORDER BY key LIMIT 200").all(cursor);
  for(const row of rows){scanned++;if(enrollNamaste(engine,row.key).started)started++;}
  if(rows.length<200)break;
  cursor=rows.at(-1).key;await new Promise(resolve=>setImmediate(resolve));
 }
 return{scanned,started};
}
