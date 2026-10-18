import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from './engine.mjs';
import {firstSequence,GAP} from './funnel.mjs';

const peer='919876543210@lid';
function setup(t,step=0){
 let now=10000000;const e=new Engine(':memory:',()=>now);t.after(()=>e.close());
 e.enable(true);e.inbound({peer,id:'customer-fixture',type:'text',body:'Hi',at:now});
 for(let n=0;n<step;n++){const prior=e.reserve();assert.equal(prior.step,n);e.finish(prior.key,'prior-'+n);now+=GAP;}
 const j=e.reserve();now+=100;e.finish(j.key,null,'Uncertain network response');now+=100;
 const native=(overrides={})=>({peer,id:'native-'+step,type:j.payload.type,body:j.payload.body||'',at:j.startedAt+50,since:0,fromMe:true,ack:2,...overrides});
 const add=(overrides={})=>{const input=native(overrides);e.captureOutgoing(input);return input;};
 const refusal=(expected=e.unknownSnapshot(j.key),overrides={})=>({source:'provider_failed_row',observedAt:now,providerRowId:'failed-row-fixture',state:'failed',waMessageId:null,peer,type:j.payload.type,payloadHash:expected.payloadHash,attemptStartedAt:expected.startedAt,attemptCompletedAt:expected.completedAt,recordedAt:j.startedAt+20,failure:{code:'ENGINE_NOT_READY',status:409,preSend:true},...overrides});
 const review=(expected=e.unknownSnapshot(j.key),overrides={})=>({source:'owner_reviewed_history',observedAt:now,reviewedAt:now,explicitRetryAuthorization:true,expectedSnapshot:expected,evidenceId:'a'.repeat(64),historySha256:'b'.repeat(64),providerRowsSha256:'c'.repeat(64),...overrides});
 const adoption=(input=native(),overrides={})=>({source:'native_history',observedAt:now,providerId:input.id,messageKey:'out:provider:'+input.id,match:'exact_text',...overrides});
 return{e,j,add,native,refusal,review,adoption,advance:ms=>{now+=ms;},now:()=>now};
}

test('native adoption preserves one actual message and ACK, retires only placeholder, and never replays completed steps',t=>{
 const {e,j,add,adoption,native}=setup(t);const incoming=e.stats().messages;add();
 const expected=e.unknownSnapshot(j.key),beforeJobs=e.db.prepare('SELECT count(*) AS n FROM due_jobs').get().n;
 const result=e.reconcileUnknown({expected,action:'adopt',evidence:adoption(),resume:true});
 assert.equal(result.resumed,true);assert.equal(e.get(j.key).state,'accepted');assert.equal(e.get(j.key).providerId,native().id);
 assert.equal(e.get('out:'+j.key).kind,'deleted');assert.equal(e.get('out:provider:'+native().id).status,'delivered');
 assert.equal(e.stats().messages,incoming);assert.equal(e.db.prepare("SELECT count(*) AS n FROM records WHERE kind='message' AND json_extract(json,'$.providerId')=?").get(native().id).n,1);
 e.ack(native().id,3);assert.equal(e.get('out:provider:'+native().id).status,'read');
 assert.equal(e.captureOutgoing(native()).duplicate,true);assert.equal(e.stats().messages,incoming);
 assert.equal(e.db.prepare('SELECT count(*) AS n FROM due_jobs').get().n,beforeJobs);
 assert.throws(()=>e.reconcileUnknown({expected,action:'adopt',evidence:adoption(),resume:true}),/changed/);
});

test('adopting the last original first step advances waiting-for-details without creating another funnel',t=>{
 const {e,j,add,adoption}=setup(t,firstSequence.length-1);add();
 const result=e.reconcileUnknown({expected:e.unknownSnapshot(j.key),action:'adopt',evidence:adoption(),resume:true});
 assert.equal(result.resumed,true);assert.equal(e.contact(peer).stage,'waiting_for_details');assert.equal(e.stats().queued,0);assert.equal(e.stats().uncertain,0);
});

test('verified pre-send repair requeues the exact original job once and leaves all earlier receipts and jobs intact',t=>{
 const {e,j,refusal,advance}=setup(t,1),expected=e.unknownSnapshot(j.key);
 const earlier=e.get('job:'+peer+':first:0'),receipts=e.db.prepare('SELECT * FROM receipts').all();
 const result=e.reconcileUnknown({expected,action:'retry',evidence:refusal(expected),resume:true});
 assert.equal(result.resumed,true);assert.equal(result.queued,true);assert.equal(e.get(j.key).reconciliation.outcome,'not_sent');
 assert.deepEqual(e.get(earlier.key),earlier);assert.deepEqual(e.db.prepare('SELECT * FROM receipts').all(),receipts);
 assert.equal(e.get(j.key).payload.url,j.payload.url);advance(GAP);const retry=e.reserve();assert.equal(retry.key,j.key);
 e.finish(retry.key,null);const next=e.unknownSnapshot(j.key);
 assert.throws(()=>e.reconcileUnknown({expected:next,action:'retry',evidence:refusal(next),resume:true}),/already used/);
});

test('explicit owner-reviewed retry records uncertainty honestly and is bound to the exact original review',t=>{
 const {e,j,review}=setup(t,1),expected=e.unknownSnapshot(j.key);
 const evidence=review(expected),result=e.reconcileUnknown({expected,action:'retry',evidence,resume:true});
 assert.equal(result.resumed,true);assert.equal(e.get(j.key).ownerResolution,'owner_reviewed_retry');
 const audit=e.get(j.key).reconciliation;assert.equal(audit.outcome,'owner_reviewed_retry');assert.equal(audit.preSend,undefined);assert.equal(audit.evidenceId,evidence.evidenceId);
 assert.match(e.get(j.key).error,/original send outcome remains uncertain/);
 assert.throws(()=>e.reconcileUnknown({expected,action:'retry',evidence,resume:true}),/changed/);
});

test('generic failed rows, missing history, unapproved or stale owner audits do not authorize retries',t=>{
 const cases=[
  f=>f.refusal(undefined,{failure:{code:'ENGINE_NOT_READY',status:500,preSend:true}}),
  f=>f.refusal(undefined,{failure:{code:'ENGINE_NOT_READY',status:409,preSend:false}}),
  f=>f.refusal(undefined,{waMessageId:'possibly-sent'}),
  f=>f.refusal(undefined,{attemptStartedAt:f.j.startedAt+1}),
  f=>({source:'history_missing',observedAt:f.now()}),
  f=>f.review(undefined,{explicitRetryAuthorization:false}),
  f=>f.review(undefined,{historySha256:''}),
  f=>f.review(undefined,{reviewedAt:f.now()-600001}),
  f=>f.review(undefined,{expectedSnapshot:{...f.e.unknownSnapshot(f.j.key),revision:1}})
 ];
 for(const make of cases){const f=setup(t,1),expected=f.e.unknownSnapshot(f.j.key);assert.throws(()=>f.e.reconcileUnknown({expected,action:'retry',evidence:make(f),resume:true}),/required|evidence/);assert.equal(f.e.get(f.j.key).state,'unknown');assert.equal(f.e.contact(peer).paused,true);}
});

test('job revision, attempt times and payload fingerprint are each required compare-and-set guards',t=>{
 for(const field of ['revision','startedAt','completedAt','payloadHash']){
  const f=setup(t),original=f.e.unknownSnapshot(f.j.key),expected={...original,[field]:field==='payloadHash'?'d'.repeat(64):original[field]+1};
  assert.throws(()=>f.e.reconcileUnknown({expected,action:'retry',evidence:f.refusal(original),resume:true}),/job changed/);assert.equal(f.e.get(f.j.key).state,'unknown');
 }
});

test('current STOP wins, changed controls abort resume, and explicit owner pause is preserved',t=>{
 const f=setup(t),stale=f.e.unknownSnapshot(f.j.key);f.e.inbound({peer,id:'stop-after-audit',type:'text',body:'STOP',at:f.now()});
 assert.throws(()=>f.e.reconcileUnknown({expected:stale,action:'retry',evidence:f.review(stale),resume:true}),/controls changed/);
 const current=f.e.unknownSnapshot(f.j.key);assert.throws(()=>f.e.reconcileUnknown({expected:current,action:'retry',evidence:f.review(current),resume:true}),/opted out/);
 const g=setup(t);g.e.pauseContact(peer,true);const expected=g.e.unknownSnapshot(g.j.key);
 const result=g.e.reconcileUnknown({expected,action:'retry',evidence:g.refusal(expected),resume:true});
 assert.equal(result.resumed,false);assert.equal(result.resumeHeld,'owner_or_existing_pause');assert.equal(g.e.contact(peer).pauseReason,'owner');assert.equal(g.e.reserve(),null);
});

test('legacy failure pause requires explicit resume, and another unknown prevents resuming the customer',t=>{
 const f=setup(t),expected=f.e.unknownSnapshot(f.j.key);
 f.e.reconcileUnknown({expected,action:'retry',evidence:f.refusal(expected)});assert.equal(f.e.contact(peer).paused,true);assert.equal(f.e.reserve(),null);
 const g=setup(t);g.e.put({...g.j,key:'job:'+peer+':manual-other:0',phase:'manual-other',state:'unknown'});
 const result=g.e.reconcileUnknown({expected:g.e.unknownSnapshot(g.j.key),action:'retry',evidence:g.refusal(),resume:true});
 assert.equal(result.resumeHeld,'other_unresolved_jobs');assert.equal(g.e.contact(peer).paused,true);
});

test('media adoption requires original/native content evidence and rejects ambiguous native candidates',t=>{
 const f=setup(t,1);f.add();let expected=f.e.unknownSnapshot(f.j.key);
 assert.throws(()=>f.e.reconcileUnknown({expected,action:'adopt',evidence:f.adoption({ ...f.native() },{match:'caption_only'}),resume:true}),/not sufficient/);
 const evidence=f.adoption(f.native(),{match:'media_sha256',payloadHash:expected.payloadHash,mediaSha256:'e'.repeat(64),expectedMediaSha256:'e'.repeat(64)});
 assert.equal(f.e.reconcileUnknown({expected,action:'adopt',evidence,resume:true}).reconciled,true);
 const g=setup(t);g.add();g.add({id:'another-native-same-text'});expected=g.e.unknownSnapshot(g.j.key);
 assert.throws(()=>g.e.reconcileUnknown({expected,action:'adopt',evidence:g.adoption(),resume:true}),/More than one/);
});

test('new native evidence prevents even an owner-reviewed retry and cross-peer provider adoption is rejected',t=>{
 const f=setup(t,1);f.add();const expected=f.e.unknownSnapshot(f.j.key);
 assert.throws(()=>f.e.reconcileUnknown({expected,action:'retry',evidence:f.review(expected),resume:true}),/possible native send/);
 const g=setup(t);g.add({peer:'919000000001@lid'});
 assert.throws(()=>g.e.reconcileUnknown({expected:g.e.unknownSnapshot(g.j.key),action:'adopt',evidence:g.adoption(),resume:true}),/does not match/);
});
