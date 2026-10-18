import {firstSequence,GAP} from './funnel.mjs';
import {validPeer,isSensitive,consentCommand} from './engine.mjs';

export const isNamaste = value => typeof value==='string' && /(?:^|[^\p{L}])namaste(?:$|[^\p{L}])|नमस्ते/iu.test(value.normalize('NFKC'));

// The owner explicitly treats an actual Namaste in either direction as a lead.
// Enrollment schedules the existing sequence; it never invents an incoming text.
export function enrollNamaste(engine,recordKey){
 if(!engine.settings().namasteLeads)return{started:false,reason:'disabled'};
 return engine.transaction(()=>{
  const m=engine.get(recordKey),c=m&&engine.reconcileConsent(m.peer);
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

// Migration recovery uses actual saved inbound rows. Their existing receipts
// remain intact: importing a passive row twice must never create a new message.
export function enrollMissedLead(engine,recordKey,{since,before}){
 if(!Number.isFinite(since)||!Number.isFinite(before)||since<=0||before<=since||before>engine.now()+300000)throw Error('Invalid missed-lead recovery interval');
 return engine.transaction(()=>{
  const m=engine.get(recordKey);
  if(m?.kind!=='message'||m.direction!=='in'||!m.id||m.key!=='in:'+m.id||!validPeer(m.peer)||!Number.isFinite(m.at)||m.at<since||m.at>=before||m.sensitive||m.revoked||isSensitive(m.body)||consentCommand(m.body)==='stop')return{started:false,reason:'not_a_missed_lead'};
  const c=engine.reconcileConsent(m.peer);
  if(!c||c.isSelf||c.deleted||c.optedOut||c.paused||c.contentDeletedAt&&m.at<=c.contentDeletedAt)return{started:false,reason:'owner_controls'};
  if(c.firstStarted||engine.db.prepare("SELECT 1 FROM due_jobs WHERE peer=? AND phase='first' LIMIT 1").get(c.peer))return{started:false,reason:'already_started'};
  const at=engine.now();
  engine.put({...c,firstStarted:true,stage:'first_sequence',leadTrigger:'missed_inbound',leadMessageKey:m.key,leadStartedAt:at,leadRecoverySince:since,leadRecoveryBefore:before});
  firstSequence.forEach((payload,step)=>engine.job(c.peer,'first',step,at+step*GAP,payload));
  return{started:true};
 });
}

export function createMissedLeadRecovery({engine,since,before}){
 const key='openwa-missed-lead-recovery';
 let saved=engine.get(key)||{key,kind:'settings',since,before,cursorStamp:0,cursorKey:'',scanned:0,started:0};
 if(!Number.isFinite(saved.since)||!Number.isFinite(saved.before)||saved.since<=0||saved.before<=saved.since||saved.before>engine.now()+300000)throw Error('Invalid missed-lead recovery interval');
 if(!engine.get(key))engine.put(saved);
 const status={enabled:true,since:saved.since,before:saved.before,checkedAt:null,scanned:saved.scanned||0,started:saved.started||0,caughtUpToStoredMessages:false};
 return{status,scan({limit=100}={}){
  limit=Math.max(1,Math.min(200,Number.isSafeInteger(limit)?limit:100));
  // Record revisions are monotonic even when an old phone message is imported
  // much later. A durable bounded cursor sees those late imports after restart.
  const rows=engine.db.prepare("SELECT key,stamp FROM records WHERE kind='message' AND (stamp,key)>(?,?) ORDER BY stamp,key LIMIT ?").all(saved.cursorStamp||0,saved.cursorKey||'',limit);
  let started=0,nextSaved=saved;
  engine.transaction(()=>{
   for(const row of rows)if(enrollMissedLead(engine,row.key,saved).started)started++;
   if(rows.length){const tail=rows.at(-1);nextSaved=engine.put({...saved,cursorStamp:tail.stamp,cursorKey:tail.key,scanned:(saved.scanned||0)+rows.length,started:(saved.started||0)+started,checkedAt:engine.now()});}
  });
  saved=nextSaved;
  Object.assign(status,{checkedAt:engine.now(),scanned:saved.scanned||0,started:saved.started||0,caughtUpToStoredMessages:rows.length<limit});
  return{scanned:rows.length,started};
 }};
}
