import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from './engine.mjs';
import {firstSequence,GAP} from './funnel.mjs';

const peer='919876543210@c.us';
const outgoing=(extra={})=>({peer,id:'true_phone-message',at:1000000,since:900000,type:'text',body:'Hello from the business phone',ack:1,fromMe:true,...extra});
const setup=t=>{let time=1100000;const engine=new Engine(':memory:',()=>time);t.after(()=>engine.close());return{engine,setTime:value=>time=value};};

test('a new handset-initiated customer chat is visible without starting automation',t=>{
  const {engine:e}=setup(t);
  const result=e.captureOutgoing(outgoing({name:'Customer'}));
  assert.equal(result.accepted,true);assert.equal(result.key,'out:provider:true_phone-message');
  const c=e.contact(peer),m=e.get(result.key);
  assert.equal(c.name,'Customer');assert.equal(c.stage,'history_only');assert.equal(c.unread,0);assert.equal(c.firstStarted,false);
  assert.equal(c.reminderScheduled,false);assert.equal(c.mediaScheduled,false);assert.equal(c.lastOutboundAt,1000000);
  assert.equal(m.direction,'out');assert.equal(m.providerId,'true_phone-message');assert.equal(m.source,'owner_whatsapp');assert.equal(m.status,'sent');
  assert.equal(e.stats().queued,0);assert.equal(e.stats().sending,0);
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM receipts').get().n,0);
});

test('capture preserves owner controls and unread counts without altering existing funnel jobs',t=>{
  const {engine:e}=setup(t);
  e.inbound({peer,id:'customer-first',at:900000,type:'text',body:'Hi'});
  e.put({...e.contact(peer),paused:true,optedOut:true,payment:'verified_by_owner',unread:7});
  const before=e.contact(peer),jobs=e.db.prepare('SELECT json FROM records WHERE kind=\'job\' ORDER BY key').all();
  e.captureOutgoing(outgoing({at:1100001,ack:2}));
  const after=e.contact(peer);
  for(const key of ['paused','optedOut','payment','unread','firstStarted','reminderScheduled','mediaScheduled','stage','lastSentAt','lastInboundAt'])assert.equal(after[key],before[key],key);
  assert.deepEqual(e.db.prepare('SELECT json FROM records WHERE kind=\'job\' ORDER BY key').all(),jobs);
  assert.equal(after.preview,'Hello from the business phone');
});

test('ACK zero stays queued and repeated snapshots only advance changed acknowledgements',t=>{
  const {engine:e}=setup(t),input=outgoing({ack:0});
  const {key}=e.captureOutgoing(input);assert.equal(e.get(key).status,'queued');
  let changes=e.stats().backupPending;
  assert.equal(e.captureOutgoing(input).duplicate,true);assert.equal(e.stats().backupPending,changes);
  e.captureOutgoing({...input,ack:2});assert.equal(e.get(key).status,'delivered');
  changes=e.stats().backupPending;const sequence=e.db.prepare('SELECT max(seq) AS seq FROM changes').get().seq;
  e.captureOutgoing({...input,ack:2});e.captureOutgoing({...input,ack:1});
  assert.equal(e.get(key).status,'delivered');assert.equal(e.stats().backupPending,changes);assert.equal(e.db.prepare('SELECT max(seq) AS seq FROM changes').get().seq,sequence);
  e.captureOutgoing({...input,ack:3});assert.equal(e.get(key).status,'read');assert.equal(e.stats().messages,1);
});

test('repeated provider ACK callbacks do not rewrite messages or refill an acknowledged backup queue',t=>{
 const {engine:e}=setup(t),input=outgoing({ack:1}),{key}=e.captureOutgoing(input);
 e.synced(e.changes().at(-1).seq);
 const revision=()=>e.db.prepare('SELECT stamp FROM records WHERE key=?').get(key).stamp;
 const initial=revision();
 for(let i=0;i<1000;i++)assert.equal(e.ack(input.id,1),true);
 assert.equal(revision(),initial);assert.equal(e.stats().backupPending,0);
 assert.equal(e.ack(input.id,2),true);assert.equal(e.get(key).status,'delivered');assert.equal(e.stats().backupPending,1);
 const delivered=revision(),pending=e.changes();
 for(const ack of[2,2,1,0])e.ack(input.id,ack);
 assert.equal(revision(),delivered);assert.deepEqual(e.changes(),pending);
 e.synced(pending.at(-1).seq);e.ack(input.id,3);
 assert.equal(e.get(key).status,'read');assert.equal(e.stats().backupPending,1);
 const read=revision();e.ack(input.id,3);e.ack(input.id,2);assert.equal(revision(),read);
 e.ack(input.id,-1);const failed=revision();e.ack(input.id,-1);assert.equal(revision(),failed);
 assert.equal(e.ack('missing-provider-message',3),false);
});

test('existing gateway sends are deduplicated by provider ID while ACKs can advance',t=>{
  const {engine:e}=setup(t);e.enable(true);e.inbound({peer,id:'customer-first',at:900000,type:'text',body:'Hi'});
  const job=e.reserve();e.finish(job.key,'gateway-provider');
  const before=e.stats().messages;
  assert.equal(e.captureOutgoing(outgoing({id:'gateway-provider',ack:3})).duplicate,true);
  assert.equal(e.stats().messages,before);assert.equal(e.get('out:'+job.key).status,'read');
  assert.equal(e.get('out:provider:gateway-provider'),null);
});

test('duplicate native echoes repair stale gateway previews once using the saved outgoing record',t=>{
  const {engine:e,setTime}=setup(t);e.enable(true);e.inbound({peer,id:'customer-first',at:900000,type:'text',body:'Namaste'});const old=e.contact(peer),job=e.reserve();setTime(1120000);e.finish(job.key,'preview-repair-provider');
  e.put({...e.contact(peer),lastAt:old.lastAt,lastMessageKey:old.lastMessageKey,preview:'Namaste',unread:7,payment:'verified_by_owner'});const before=e.contact(peer),stored=e.get('out:'+job.key);
  const echo=outgoing({id:'preview-repair-provider',at:1120000,ack:0,body:'Untrusted stale snapshot text'});assert.equal(e.captureOutgoing(echo).duplicate,true);
  const repaired=e.contact(peer);assert.equal(repaired.preview,stored.body.slice(0,150));assert.equal(repaired.lastAt,stored.at);assert.equal(repaired.lastMessageKey,stored.key);
  for(const key of ['lastInboundAt','lastSentAt','unread','paused','optedOut','payment','firstStarted','reminderScheduled','mediaScheduled','stage'])assert.equal(repaired[key],before[key],key);
  const seq=e.db.prepare('SELECT max(seq) AS n FROM changes').get().n;e.captureOutgoing(echo);assert.equal(e.db.prepare('SELECT max(seq) AS n FROM changes').get().n,seq);
  setTime(1130000);e.inbound({peer,id:'newer-customer-text',at:1130000,type:'text',body:'Newer customer reply'});e.captureOutgoing(echo);assert.equal(e.contact(peer).preview,'Newer customer reply');assert.equal(e.contact(peer).lastMessageKey,'in:newer-customer-text');
});

test('preview repair keeps deleted and sensitive text hidden and labels captionless media',t=>{
  const {engine:e,setTime}=setup(t);e.enable(true);e.inbound({peer,id:'customer-first',at:900000,type:'text',body:'Namaste'});const job=e.reserve();setTime(1120000);e.finish(job.key,'guarded-preview-provider');const original=e.get('out:'+job.key);
  for(const [changes,expected]of [[{type:'image',body:''},'[image]'],[{body:'Your verification code is 123456',sensitive:true},'[Sensitive message omitted]'],[{body:'Previously private text',revoked:true},'[Message deleted on WhatsApp]']]){
    const stored={...original,...changes};e.put(stored);e.put({...e.contact(peer),lastAt:1100000,lastMessageKey:'in:customer-first',preview:'Namaste'});
    e.captureOutgoing(outgoing({id:'guarded-preview-provider',at:1120000,type:'image',body:'',ack:0}));assert.equal(e.contact(peer).preview,expected);assert.equal(e.contact(peer).lastMessageKey,stored.key);
  }
});

test('every completed funnel step advances the chat preview to its actual message without changing unread or inbound time',t=>{
  const {engine:e,setTime}=setup(t);e.enable(true);e.inbound({peer,id:'customer-first',at:900000,type:'text',body:'Namaste'});
  e.put({...e.contact(peer),unread:4,payment:'verified_by_owner'});const inboundAt=e.contact(peer).lastInboundAt;
  for(let index=0;index<firstSequence.length;index++){
    const at=1100000+(index+1)*GAP;setTime(at);const job=e.reserve();assert.equal(job.step,index);e.finish(job.key,'funnel-'+index);
    const c=e.contact(peer),m=e.get('out:'+job.key);assert.equal(c.lastAt,at);assert.equal(c.lastSentAt,at);assert.equal(c.lastMessageKey,m.key);assert.equal(c.preview,(m.body||'['+m.type+']').slice(0,150));assert.equal(c.lastInboundAt,inboundAt);assert.equal(c.unread,4);assert.equal(c.payment,'verified_by_owner');assert.equal(c.paused,false);assert.equal(c.optedOut,false);
  }
  assert.equal(e.contact(peer).stage,'waiting_for_details');
});

test('manual send completion updates preview and uncertain sends retain honest status and pause handling',t=>{
  const {engine:e,setTime}=setup(t);e.inbound({peer,id:'customer-first',at:900000,type:'text',body:'Namaste'});e.put({...e.contact(peer),paused:true,unread:3,payment:'verified_by_owner'});const before=e.contact(peer);
  e.manual(peer,'My latest admin reply','preview-request-12345');const job=e.reserve();setTime(1110000);e.finish(job.key,'manual-preview-provider');
  let c=e.contact(peer);assert.equal(c.preview,'My latest admin reply');assert.equal(c.lastAt,1110000);assert.equal(c.lastMessageKey,'out:'+job.key);assert.equal(c.lastSentAt,1110000);assert.equal(e.get(c.lastMessageKey).status,'accepted');
  for(const key of ['paused','unread','lastInboundAt','payment','firstStarted','reminderScheduled','mediaScheduled','optedOut','stage'])assert.equal(c[key],before[key],key);
  setTime(1120000);e.manual(peer,'An uncertain reply','preview-request-12346');const uncertain=e.reserve();setTime(1130000);e.finish(uncertain.key,null);
  c=e.contact(peer);assert.equal(c.preview,'An uncertain reply');assert.equal(c.lastAt,1130000);assert.equal(c.lastMessageKey,'out:'+uncertain.key);assert.equal(e.get(c.lastMessageKey).status,'unknown');assert.equal(c.paused,true);assert.equal(c.unread,3);assert.equal(c.lastInboundAt,before.lastInboundAt);
});

test('early gateway echoes defer until finish and cannot create duplicate outgoing rows',t=>{
  const {engine:e}=setup(t);e.enable(true);e.inbound({peer,id:'customer-first',at:900000,type:'text',body:'Hi'});
  const job=e.reserve(),echo=outgoing({id:'early-provider'});
  assert.equal(e.captureOutgoing(echo).deferred,true);assert.equal(e.get('out:provider:early-provider'),null);
  e.finish(job.key,'early-provider');assert.equal(e.captureOutgoing(echo).duplicate,true);
  assert.equal(e.stats().messages,2);
});

test('a genuine handset send deferred during a gateway send is recovered on a later scan',t=>{
  const {engine:e}=setup(t);e.enable(true);e.inbound({peer,id:'customer-first',at:900000,type:'text',body:'Hi'});
  const job=e.reserve(),phone=outgoing({id:'separate-phone-send'});
  assert.equal(e.captureOutgoing(phone).deferred,true);e.finish(job.key,'gateway-provider');
  assert.equal(e.captureOutgoing(phone).accepted,true);assert.equal(e.stats().messages,3);
});

test('capturing a real phone send does not resolve an uncertain gateway send',t=>{
  const {engine:e}=setup(t);e.enable(true);e.inbound({peer,id:'customer-first',at:900000,type:'text',body:'Hi'});
  const job=e.reserve();e.finish(job.key,null);
  assert.equal(e.captureOutgoing(outgoing()).accepted,true);
  assert.equal(e.get(job.key).state,'unknown');assert.equal(e.contact(peer).paused,true);assert.equal(e.stats().uncertain,1);
});

test('sensitive text and captions are redacted and media is omitted',t=>{
  const {engine:e}=setup(t);
  const {key}=e.captureOutgoing(outgoing({type:'image',body:'Your verification code is 123456',media:{id:'private-media'}}));
  const m=e.get(key);assert.equal(m.sensitive,true);assert.equal(m.body,'[Sensitive message omitted]');assert.equal(m.media,null);
  assert.equal(e.contact(peer).preview,'[Sensitive message omitted]');
  assert.equal(JSON.stringify(e.changes()).includes('123456'),false);
});

test('normal media captures its caption and stored attachment without scheduling a media funnel',t=>{
  const {engine:e}=setup(t),media={id:'abc',mime:'image/jpeg',size:100};
  const {key}=e.captureOutgoing(outgoing({type:'image',body:'Here is your photo',media,ack:2}));
  assert.deepEqual(e.get(key).media,media);assert.equal(e.get(key).body,'Here is your photo');assert.equal(e.get(key).status,'delivered');
  assert.equal(e.stats().queued,0);assert.equal(e.contact(peer).mediaScheduled,false);
});

test('owner deletion blocks old messages and persistent mirror tombstones are never restored',t=>{
  const {engine:e,setTime}=setup(t);
  const old=outgoing(),{key}=e.captureOutgoing(old);e.deleteContent(peer);
  assert.equal(e.captureOutgoing({...old,id:'other-old-message',at:1100000}).ignored,true);
  setTime(1200000);assert.equal(e.captureOutgoing({...old,at:1200000}).ignored,true);
  assert.equal(e.get(key).kind,'deleted');assert.equal(e.stats().messages,0);
  assert.equal(e.captureOutgoing({...old,id:'new-after-deletion',at:1200000}).accepted,true);
  assert.equal(e.contact(peer).paused,true);assert.equal(e.contact(peer).unread,0);assert.equal(e.stats().queued,0);
});

test('invalid, system, group and pre-boundary messages create no rows',t=>{
  const {engine:e}=setup(t);
  const invalid=[
    {peer:'group@g.us'},{peer:'invalid'},{id:''},{id:'x'.repeat(301)},{at:0},{at:NaN},{since:undefined},{since:-1},{at:899999},{at:1400001},
    {fromMe:false},{isGroupMsg:true},{isGroup:true},{isPSA:true},{isNotification:true},{name:'WhatsApp'},{type:'protocol'}
  ];
  for(const extra of invalid)assert.equal(e.captureOutgoing(outgoing(extra)).ignored,true,JSON.stringify(extra));
  assert.equal(e.stats().contacts,0);assert.equal(e.stats().messages,0);assert.equal(e.stats().queued,0);
  assert.equal(e.captureOutgoing(outgoing({type:'chat',at:900000})).accepted,true);
});

test('outgoing self notes mirror read-only without starting or accepting any send jobs',t=>{
  const {engine:e}=setup(t),self=outgoing({id:'self-note',isSelf:true,name:'+91 98765 43210'});
  const result=e.captureOutgoing(self);assert.equal(result.accepted,true);
  assert.equal(e.contact(peer).isSelf,true);assert.equal(e.contact(peer).name,'You');assert.equal(e.contact(peer).unread,0);assert.equal(e.stats().queued,0);
  assert.equal(e.inbound({peer,id:'self-echo',at:1000000,type:'text',body:'Echo'}).ignored,true);
  assert.throws(()=>e.manual(peer,'Do not send from the mirror','request-id-self-001'),/own WhatsApp chat/);
  assert.equal(e.captureOutgoing({...self,mutation:'edit',editedAt:1050000,body:'Edited self note'}).mutated,true);
  assert.equal(e.get(result.key).body,'Edited self note');
  assert.equal(e.captureOutgoing({...self,mutation:'revoke',observedAt:1100000}).mutated,true);
  assert.equal(e.get(result.key).revoked,true);assert.equal(e.stats().queued,0);
});
