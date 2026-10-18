import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Engine} from './engine.mjs';
import {createMissedLeadRecovery,enrollMissedLead} from './lead-enrollment.mjs';
import {firstSequence,GAP} from './funnel.mjs';

const now=1800000000000,since=now-3600000,before=now-60000,peer='919876543210@c.us';
const input=(id,body='Hello',at=before-10000,p=peer)=>({id,peer:p,body,at,type:'text',recovered:true});
function setup(t){const e=new Engine(':memory:',()=>now);t.after(()=>e.close());return e;}
const recovery=e=>createMissedLeadRecovery({engine:e,since,before});
const receiptCount=e=>e.db.prepare('SELECT count(*) AS n FROM receipts').get().n;

test('newest actual consent wins across descending active pages and later genuine START is allowed',t=>{
 const e=setup(t);
 e.inbound(input('new-stop','STOP',before));
 e.inbound(input('older-start','START',before-1000));
 e.inbound(input('older-hi','Hello',before-2000));
 assert.equal(e.contact(peer).optedOut,true);assert.equal(e.contact(peer).consentMessageKey,'in:new-stop');assert.equal(e.stats().queued,0);
 e.inbound(input('latest-start','START',before+1000));
 assert.equal(e.contact(peer).optedOut,false);assert.equal(e.stats().queued,5);
 e.inbound(input('late-old-stop','STOP',before-500));
 assert.equal(e.contact(peer).optedOut,false);assert.equal(e.stats().queued,5);
});

test('historical STOP remains effective after newer ordinary text; equal-time conflicting commands prefer STOP',t=>{
 const e=setup(t);e.importHistory(input('ordinary','Hello',before));e.importHistory(input('stop','बंद करें',before-1000));
 assert.equal(e.contact(peer).optedOut,true);
 for(const [index,bodies] of [['a',['START','STOP']],['b',['STOP','START']]]){
  const p='91987654321'+(index==='a'?'1':'2')+'@c.us';
  bodies.forEach((body,n)=>e.inbound(input(index+n,body,before,p)));
  assert.equal(e.contact(p).optedOut,true);
  assert.equal(e.db.prepare("SELECT count(*) AS n FROM due_jobs WHERE peer=? AND state='queued'").get(p).n,0);
 }
});

test('bounded recovery promotes already-receipted real inbound once without altering original copy or receipts',t=>{
 const e=setup(t),m=input('missed');e.importHistory(m);
 assert.deepEqual(e.inbound(m),{duplicate:true});assert.equal(e.stats().queued,0);
 const beforeReceipts=receiptCount(e),r=recovery(e);
 assert.deepEqual(r.scan(),{scanned:1,started:1});assert.equal(receiptCount(e),beforeReceipts);
 assert.equal(e.list('message',peer).length,1);assert.equal(e.contact(peer).leadMessageKey,'in:missed');
 firstSequence.forEach((payload,step)=>{const job=e.get(`job:${peer}:first:${step}`);assert.deepEqual(job.payload,payload);assert.equal(job.dueAt,now+step*GAP);});
 assert.equal(r.scan().started,0);assert.equal(enrollMissedLead(e,'in:missed',{since,before}).started,false);assert.equal(e.stats().queued,5);
});

test('recovery only enrolls actual inbound inside the original half-open interval',t=>{
 const e=setup(t),items=[['too-old',since-1],['at-start',since],['before-end',before-1],['at-end',before],['after-end',now]];
 items.forEach(([id,at],n)=>e.importHistory(input(id,'Hello',at,String(919876540000+n)+'@c.us')));
 const p='919876541000@c.us';e.captureOutgoing({id:'owner',peer:p,body:'Hello',type:'text',at:before-1000,since:0,fromMe:true});
 const r=recovery(e);assert.equal(r.scan().started,2);assert.equal(e.stats().queued,10);assert.equal(receiptCount(e),5);
 assert.equal(e.contact(p).firstStarted,false);
});

test('recovery respects owner controls, existing first jobs in any state, and sensitive or revoked input',t=>{
 const e=setup(t);
 const flags=[{paused:true},{optedOut:true},{isSelf:true},{deleted:true},{contentDeletedAt:before},{firstStarted:true}];
 flags.forEach((change,n)=>{const p=String(919876542000+n)+'@c.us',id='guard'+n;e.importHistory(input(id,'Hello',before-1000,p));e.put({...e.contact(p),...change});assert.equal(enrollMissedLead(e,'in:'+id,{since,before}).started,false);});
 for(const [n,state] of ['queued','accepted','cancelled','unknown'].entries()){
  const p=String(919876543000+n)+'@c.us',id='job'+n;e.importHistory(input(id,'Hello',before-1000,p));e.job(p,'first',0,now,firstSequence[0]);const job=e.get(`job:${p}:first:0`);e.put({...job,state});
  assert.equal(enrollMissedLead(e,'in:'+id,{since,before}).started,false);
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM due_jobs WHERE peer=?').get(p).n,1);
 }
 const bad=[['sensitive','verification code 123456',{}],['revoked','Hello',{revoked:true}],['stop','STOP',{}]];
 bad.forEach(([id,body,change],n)=>{const p=String(919876544000+n)+'@c.us';e.importHistory(input(id,body,before-1000,p));e.put({...e.get('in:'+id),...change});assert.equal(enrollMissedLead(e,'in:'+id,{since,before}).started,false);});
});

test('legacy contact without consent watermark is reconciled from newest stored command before enrollment',t=>{
 const e=setup(t);e.importHistory(input('old-start','START',before-3000));e.importHistory(input('lead','Hello',before-2000));e.importHistory(input('new-stop','STOP',before+1000));
 const c=e.contact(peer);delete c.consentAt;delete c.consentCommand;delete c.consentMessageKey;e.put({...c,optedOut:false});
 assert.equal(recovery(e).scan().started,0);assert.equal(e.contact(peer).optedOut,true);assert.equal(e.contact(peer).consentMessageKey,'in:new-stop');assert.equal(e.stats().queued,0);
});

test('bounded cursor survives restart and catches late old history without broadening its original window',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-recover-')),file=path.join(dir,'db.sqlite');let e=new Engine(file,()=>now);
 t.after(()=>{e.close();fs.rmSync(dir,{recursive:true,force:true});});
 for(let n=0;n<5;n++)e.importHistory(input('batch'+n,'Hello',before-1000,String(919876545000+n)+'@c.us'));
 let r=recovery(e);assert.deepEqual(r.scan({limit:2}),{scanned:2,started:2});assert.equal(r.status.caughtUpToStoredMessages,false);e.close();e=new Engine(file,()=>now+1000);
 r=createMissedLeadRecovery({engine:e,since:since-100000,before:now+1000});assert.equal(r.status.since,since);assert.equal(r.status.before,before);
 assert.deepEqual(r.scan({limit:2}),{scanned:2,started:2});assert.deepEqual(r.scan({limit:2}),{scanned:1,started:1});
 e.importHistory(input('late-old','Hello',before-2000,'919876545100@c.us'));assert.deepEqual(r.scan({limit:2}),{scanned:1,started:1});
 e.put({...e.get('in:late-old'),attachmentError:'unavailable'});assert.equal(r.scan().started,0);
 assert.equal(e.stats().queued,30);assert.equal(receiptCount(e),6);
});

test('failed batch rolls back enrollment and cursor, then safely recovers once on retry',t=>{
 const e=setup(t);e.importHistory(input('transaction'));const r=recovery(e),original=e.job.bind(e);
 e.job=(...args)=>{if(args[2]===2)throw Error('test persistence failure');return original(...args);};
 assert.throws(()=>r.scan(),/persistence failure/);assert.equal(e.stats().queued,0);assert.equal(e.contact(peer).firstStarted,false);assert.equal(e.get('openwa-missed-lead-recovery').cursorStamp,0);assert.equal(receiptCount(e),1);
 e.job=original;assert.deepEqual(r.scan(),{scanned:1,started:1});assert.equal(e.stats().queued,5);
});
