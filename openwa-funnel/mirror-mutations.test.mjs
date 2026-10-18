import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Engine} from './engine.mjs';
import {normalizeIncoming,normalizeOutgoing} from './inbox-sync.mjs';
import {MEDIA_DELAY} from './funnel.mjs';

const peer='919876543210@c.us',other='919876543211@c.us';
const input=(extra={})=>({peer,id:'original',at:1000000,type:'text',body:'Original customer words',...extra});
const setup=t=>{let now=1200000;const engine=new Engine(':memory:',()=>now);t.after(()=>engine.close());return{engine,setNow:n=>now=n};};
const jobs=e=>e.db.prepare("SELECT key,json FROM records WHERE kind='job' ORDER BY key").all();
const maxSeq=e=>e.db.prepare('SELECT max(seq) AS seq FROM changes').get().seq;

test('provider edit updates one received message without replaying commands, unread counts or funnel jobs',t=>{
  const {engine:e}=setup(t);e.inbound(input());
  const beforeJobs=jobs(e),before=e.contact(peer),receipts=e.db.prepare('SELECT count(*) AS n FROM receipts').get().n;
  const result=e.inbound(input({body:'STOP',mutation:'edit',editedAt:1100000,editKey:'edit-key'}));
  assert.equal(result.mutated,true);assert.equal(result.key,'in:original');assert.deepEqual(result.removedMedia,[]);
  const m=e.get(result.key);assert.equal(m.body,'STOP');assert.equal(m.at,1000000);assert.equal(m.editedAt,1100000);
  assert.equal(e.contact(peer).optedOut,before.optedOut);assert.equal(e.contact(peer).unread,before.unread);
  assert.equal(e.contact(peer).preview,'STOP');assert.deepEqual(jobs(e),beforeJobs);
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM receipts').get().n,receipts);
  const sequence=maxSeq(e);assert.equal(e.inbound(input({body:'STOP',editedAt:1100000,editKey:'edit-key'})).duplicate,true);assert.equal(maxSeq(e),sequence);
});

test('edited provider snapshots advance stored content, while older edit versions cannot overwrite it',t=>{
  const {engine:e}=setup(t);e.inbound(input());
  assert.equal(e.inbound(input({body:'Newer actual text',editedAt:1150000})).mutated,true);
  assert.equal(e.inbound(input({body:'Old edit',editedAt:1100000})).duplicate,true);
  assert.equal(e.get('in:original').body,'Newer actual text');
  assert.equal(e.inbound(input({body:'Future edit',editedAt:1500001})).duplicate,true);
  assert.equal(e.get('in:original').body,'Newer actual text');
});

test('unknown, cross-customer, wrong-direction and timestamp-mismatched mutations create no content',t=>{
  const {engine:e}=setup(t);
  assert.equal(e.inbound(input({mutation:'edit',editedAt:1100000})).ignored,true);assert.equal(e.stats().contacts,0);assert.equal(e.stats().queued,0);
  e.inbound(input());const before=e.stats();
  for(const extra of [{peer:other},{direction:'out'},{at:600000},{isGroupMsg:true},{isSelf:true}])assert.equal(e.captureMutation(input({mutation:'edit',editedAt:1100000,direction:'in',...extra})).ignored,true);
  assert.equal(e.get('in:original').body,'Original customer words');assert.equal(e.stats().messages,before.messages);assert.equal(e.stats().queued,before.queued);
});

test('outgoing gateway edits preserve delivery evidence and never resolve uncertain sends',t=>{
  const {engine:e}=setup(t);e.enable(true);e.inbound(input());const job=e.reserve();e.finish(job.key,'gateway-id');e.ack('gateway-id',3);
  const before=jobs(e),result=e.captureOutgoing(input({id:'gateway-id',at:1200000,since:0,fromMe:true,body:'Actual edited owner words',mutation:'edit',editedAt:1250000}));
  assert.equal(result.mutated,true);const m=e.get('out:'+job.key);assert.equal(m.body,'Actual edited owner words');assert.equal(m.status,'read');assert.equal(m.providerId,'gateway-id');assert.equal(m.source,'funnel');assert.deepEqual(jobs(e),before);
  assert.equal(e.stats().messages,2);
});

test('WhatsApp revocation redacts an existing attachment and durably deletes its private backup asset',t=>{
  const {engine:e}=setup(t),mediaId='a'.repeat(64);
  e.inbound(input({type:'image',body:'Original caption',media:{id:mediaId,mime:'image/jpeg'}}));const beforeJobs=jobs(e),unread=e.contact(peer).unread;
  const result=e.inbound(input({type:'revoked',mutation:'revoke',observedAt:1200000}));
  assert.equal(result.mutated,true);assert.deepEqual(result.removedMedia,[mediaId]);
  const m=e.get('in:original');assert.equal(m.kind,'message');assert.equal(m.revoked,true);assert.equal(m.type,'revoked');assert.equal(m.body,'');assert.equal(m.media,null);assert.equal(m.url,null);assert.equal(m.revokedAtSource,'observed');
  assert.equal(e.get('media-deleted:'+mediaId).kind,'deleted');assert.equal(e.get('media-deleted:'+mediaId).mediaId,mediaId);
  assert.deepEqual(jobs(e),beforeJobs);assert.equal(e.contact(peer).unread,unread);
  const sequence=maxSeq(e);assert.equal(e.inbound(input({mutation:'revoke',observedAt:1200000})).ignored,true);assert.equal(maxSeq(e),sequence);
  assert.equal(e.inbound(input({mutation:'edit',editedAt:1250000,body:'Late edit must not restore this'})).ignored,true);assert.equal(e.get('in:original').body,'');
});

test('edits and revocations never revive owner-deleted content',t=>{
  const {engine:e}=setup(t);e.inbound(input());e.deleteContent(peer);
  for(const mutation of ['edit','revoke'])assert.equal(e.inbound(input({mutation,editedAt:1250000,observedAt:1250000})).ignored,true);
  assert.equal(e.get('in:original').kind,'deleted');assert.equal(e.stats().messages,0);
});

test('a protocol-targeted revocation can redact an older message without inventing its original timestamp',t=>{
  const {engine:e,setNow}=setup(t);e.inbound(input());setNow(2000000);
  const raw={id:'revoke-command',protocolMessageKey:{_serialized:'original'},from:peer,type:'revoked',timestamp:1800};
  const normalized=normalizeIncoming(raw,1900000,2000000).input;assert.equal(normalized.id,'original');assert.equal(normalized.targetKey,'original');
  assert.equal(e.inbound(normalized).mutated,true);assert.equal(e.get('in:original').at,1000000);assert.equal(e.get('in:original').revokedAt,2000000);
});

test('sensitive edits omit text and remove previously stored attachments from backup',t=>{
  const {engine:e}=setup(t),mediaId='b'.repeat(64);
  const outgoing={peer,id:'phone-image',at:1000000,since:0,type:'image',body:'Photo',ack:2,fromMe:true,media:{id:mediaId,mime:'image/jpeg'}};
  const {key}=e.captureOutgoing(outgoing);
  const result=e.captureOutgoing({...outgoing,body:'Your confirmation code is 123456',mutation:'edit',editedAt:1100000});
  assert.equal(result.mutated,true);assert.deepEqual(result.removedMedia,[mediaId]);assert.equal(e.get(key).sensitive,true);assert.equal(e.get(key).body,'[Sensitive message omitted]');assert.equal(e.get(key).media,null);
  assert.equal(JSON.stringify(e.changes()).includes('123456'),false);assert.equal(e.get('media-deleted:'+mediaId).kind,'deleted');
});

test('late initial captions hydrate an empty record without being treated as another paid-media trigger',t=>{
  const {engine:e}=setup(t);e.inbound(input({type:'image',body:''}));const before=jobs(e);
  assert.equal(e.inbound(input({type:'image',body:'Actual initial caption'})).mutated,true);
  assert.equal(e.get('in:original').body,'Actual initial caption');assert.equal(e.get('in:original').editedAt,undefined);assert.deepEqual(jobs(e),before);
  assert.equal(e.inbound(input({type:'image',body:'Unproven replacement without edit metadata'})).duplicate,true);assert.equal(e.get('in:original').body,'Actual initial caption');
});

test('contact, multiple contacts and location mirror real payloads without scheduling the one-hour media stage',t=>{
  const {engine:e}=setup(t),payloads=[
    {type:'vcard',body:'BEGIN:VCARD\nFN:Example Client\nTEL:+919876543210\nEND:VCARD'},
    {type:'multi_vcard',vcardList:[{displayName:'Example Client',vcard:'BEGIN:VCARD\nFN:Example Client\nEND:VCARD'}]},
    {type:'location',lat:27.58,lng:77.7,loc:'Shared meeting point'}
  ];
  for(let i=0;i<payloads.length;i++){
    const raw={id:'shared-'+i,from:peer,timestamp:1000,...payloads[i]},normalized=normalizeIncoming(raw,900000,1200000);
    assert.ok(normalized.input);assert.equal(e.inbound(normalized.input).accepted,true);
  }
  assert.equal(e.db.prepare("SELECT count(*) AS n FROM due_jobs WHERE phase='media'").get().n,0);assert.equal(e.stats().queued,5);assert.equal(e.contact(peer).payment,'not_received');
  const location=e.get('in:shared-2');assert.equal(location.body,'Shared meeting point\n27.58, 77.7');assert.equal(location.sharedLocation.latitude,27.58);
  const noCoordinates=normalizeIncoming({id:'no-coordinates',from:peer,timestamp:1000,type:'location',lat:null,lng:null},0,1200000).input;
  assert.equal(noCoordinates.sharedLocation,undefined);assert.equal(noCoordinates.body,'');
});

test('unknown user message types remain visible but passive; album containers do not duplicate children',t=>{
  const {engine:e}=setup(t);
  const future=normalizeIncoming({id:'future',from:peer,type:'new_native_card',timestamp:1000,body:'Actual provider text'},900000,1200000).input;
  assert.equal(future.type,'unsupported');assert.equal(future.providerType,'new_native_card');assert.equal(future.passive,true);e.inbound(future);assert.equal(e.stats().queued,0);
  assert.equal(e.contact(peer).firstStarted,false);assert.equal(e.contact(peer).unread,1);
  assert.equal(normalizeIncoming({id:'container',from:peer,type:'album',timestamp:1000},900000,1200000).reason,'album_container');
  for(const id of ['child-a','child-b'])e.inbound(normalizeIncoming({id,from:peer,type:'image',timestamp:1000},900000,1200000).input);
  assert.equal(e.stats().queued,9);assert.equal(e.stats().messages,3);assert.equal(e.get('job:'+peer+':media:0').dueAt,1200000+MEDIA_DELAY);
});

test('explicit edits do not invent a first message, while an actual already-edited first snapshot is captured once',t=>{
  const {engine:e}=setup(t),raw={id:'new',from:peer,type:'chat',timestamp:1000,body:'Edited current text',latestEditSenderTimestampMs:1100000,latestEditMsgKey:'edit-new'};
  const explicit=normalizeIncoming({...raw,mutation:'edit'},900000,1200000).input;
  assert.equal(e.inbound(explicit).ignored,true);assert.equal(e.stats().contacts,0);
  const snapshot=normalizeIncoming(raw,900000,1200000).input;
  assert.equal(e.inbound(snapshot).accepted,true);assert.equal(e.get('in:new').editedAt,1100000);assert.equal(e.stats().queued,5);
  assert.equal(e.inbound(snapshot).duplicate,true);assert.equal(e.stats().queued,5);
});

test('decrypted first messages and attachment type transitions do not get mistaken for edits',t=>{
  const {engine:e}=setup(t);
  assert.equal(normalizeIncoming({id:'text',from:peer,type:'chat',timestamp:1000,body:''},900000,1200000).reason,'empty_message');
  assert.equal(normalizeIncoming({id:'photo',from:peer,type:'ciphertext',timestamp:1000},900000,1200000).reason,'type');
  const photo=normalizeIncoming({id:'photo',from:peer,type:'image',timestamp:1000,body:'',caption:'Actual photo'},900000,1200000).input;
  e.inbound(photo);assert.equal(e.stats().queued,9);assert.equal(e.get('in:photo').body,'Actual photo');
  assert.equal(normalizeOutgoing({id:'out',to:peer,fromMe:true,type:'location',timestamp:1000,lat:0,lng:0},900000,1200000).input.sharedLocation.latitude,0);
});

test('record revisions stay strictly increasing across same-millisecond writes and restarts with a backward clock',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-mirror-stamp-')),file=path.join(folder,'funnel.sqlite');
  try{
    let e=new Engine(file,()=>1000000);
    e.inbound(input());const original=e.get('in:original'),job=e.get('job:'+peer+':first:0');
    assert.equal(original.at,1000000);assert.equal(original.receivedAt,1000000);assert.equal(job.dueAt,1000000);
    const one=e.db.prepare("SELECT stamp FROM records WHERE key='in:original'").get().stamp;
    e.put({...original,body:'same-clock update'});const two=e.db.prepare("SELECT stamp FROM records WHERE key='in:original'").get().stamp;assert.ok(two>one);
    const previousMax=e.db.prepare('SELECT max(stamp) AS stamp FROM records').get().stamp;e.close();
    e=new Engine(file,()=>900000);e.put({...e.get('in:original'),body:'after restart'});
    const three=e.db.prepare("SELECT stamp FROM records WHERE key='in:original'").get().stamp;assert.ok(three>previousMax);
    assert.equal(e.get('in:original').at,1000000);assert.equal(e.get('job:'+peer+':first:0').dueAt,1000000);e.close();
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('timeline initial windows follow physical message time even when old ACK updates dominate revision heads',t=>{
  const {engine:e}=setup(t);
  for(let i=0;i<130;i++)e.captureOutgoing({peer,id:'timeline-'+String(i).padStart(3,'0'),at:1000000+i,since:0,type:'text',body:'Actual message '+i,ack:1,fromMe:true});
  for(let i=0;i<70;i++)e.ack('timeline-'+String(i).padStart(3,'0'),3);
  const revisionHead=e.list('message',peer,'',50);assert.ok(revisionHead.every(m=>Number(m.id.split('-').at(-1))<70));
  const initial=e.listMessagesTimeline(peer,'',50);assert.equal(initial.messages.length,50);assert.equal(initial.messages[0].id,'timeline-129');assert.equal(initial.messages.at(-1).id,'timeline-080');
  const revision=JSON.parse(Buffer.from(initial.revisionCursor,'base64url').toString()),latest=e.db.prepare("SELECT stamp,key FROM records WHERE peer=? AND kind='message' ORDER BY stamp DESC,key DESC LIMIT 1").get(peer);
  assert.deepEqual(revision,{stamp:latest.stamp,key:latest.key});
  const all=[...initial.messages];let page=initial;
  while(page.messages.length===50){page=e.listMessagesTimeline(peer,page.messages.at(-1)._historyCursor,50);all.push(...page.messages);}
  assert.equal(all.length,130);assert.equal(new Set(all.map(m=>m.key)).size,130);assert.equal(all.at(-1).id,'timeline-000');
  const row=initial.messages[0],record=e.db.prepare('SELECT stamp FROM records WHERE key=?').get(row.key);
  assert.equal(JSON.parse(Buffer.from(row._cursor,'base64url').toString()).stamp,record.stamp);
  assert.equal(JSON.parse(Buffer.from(row._historyCursor,'base64url').toString()).at,row.at);
  const plan=e.db.prepare("EXPLAIN QUERY PLAN SELECT key FROM records WHERE peer=? AND kind='message' AND (coalesce(json_extract(json,'$.at'),stamp),key)<(?,?) ORDER BY coalesce(json_extract(json,'$.at'),stamp) DESC,key DESC LIMIT 50").all(peer,Number.MAX_SAFE_INTEGER,'\uffff').map(r=>r.detail).join(' ');
  assert.match(plan,/records_peer_timeline/);assert.doesNotMatch(plan,/TEMP B-TREE/);
});

test('timeline paging remains complete when message timestamps tie and another customer changes',t=>{
  const {engine:e}=setup(t);
  assert.deepEqual(e.listMessagesTimeline(peer),{messages:[],revisionCursor:''});
  for(let i=0;i<75;i++)e.captureOutgoing({peer,id:'same-time-'+String(i).padStart(3,'0'),at:1000000,since:0,type:'text',body:'Actual text',ack:0,fromMe:true});
  const first=e.listMessagesTimeline(peer,'',50),second=e.listMessagesTimeline(peer,first.messages.at(-1)._historyCursor,50);
  assert.equal(first.messages.length,50);assert.equal(second.messages.length,25);assert.equal(new Set([...first.messages,...second.messages].map(m=>m.key)).size,75);
  e.captureOutgoing({peer:other,id:'other',at:1100000,since:0,type:'text',body:'Other customer',ack:0,fromMe:true});
  assert.equal(e.listMessagesTimeline(peer).revisionCursor,first.revisionCursor);
  assert.throws(()=>e.listMessagesTimeline('group@g.us'),/Invalid chat/);
});
