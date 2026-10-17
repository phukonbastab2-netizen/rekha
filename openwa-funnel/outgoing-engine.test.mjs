import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from './engine.mjs';

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

test('existing gateway sends are deduplicated by provider ID while ACKs can advance',t=>{
  const {engine:e}=setup(t);e.enable(true);e.inbound({peer,id:'customer-first',at:900000,type:'text',body:'Hi'});
  const job=e.reserve();e.finish(job.key,'gateway-provider');
  const before=e.stats().messages;
  assert.equal(e.captureOutgoing(outgoing({id:'gateway-provider',ack:3})).duplicate,true);
  assert.equal(e.stats().messages,before);assert.equal(e.get('out:'+job.key).status,'read');
  assert.equal(e.get('out:provider:gateway-provider'),null);
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

test('invalid, self, system, group and pre-boundary messages create no rows',t=>{
  const {engine:e}=setup(t);
  const invalid=[
    {peer:'group@g.us'},{peer:'invalid'},{id:''},{id:'x'.repeat(301)},{at:0},{at:NaN},{since:undefined},{since:-1},{at:899999},{at:1400001},
    {fromMe:false},{isGroupMsg:true},{isGroup:true},{isSelf:true},{self:true},{selfPeer:peer},{ownerPeer:peer},{isPSA:true},{isNotification:true},{name:'WhatsApp'},{type:'protocol'}
  ];
  for(const extra of invalid)assert.equal(e.captureOutgoing(outgoing(extra)).ignored,true,JSON.stringify(extra));
  assert.equal(e.stats().contacts,0);assert.equal(e.stats().messages,0);assert.equal(e.stats().queued,0);
  assert.equal(e.captureOutgoing(outgoing({type:'chat',at:900000})).accepted,true);
});
