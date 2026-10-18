import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Engine} from './engine.mjs';import {enrollNamaste,enrollStoredNamaste,isNamaste} from './lead-enrollment.mjs';
const peer='919876543210@c.us';
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-leads-'));const engine=new Engine(path.join(dir,'db.sqlite'));t.after(()=>{engine.close();fs.rmSync(dir,{recursive:true,force:true});});engine.put({...engine.settings(),namasteLeads:true});return engine;}
function outgoing(e,id='actual-phone-message',body='namaste🙏'){e.captureOutgoing({id,peer,name:'Lead',at:Date.now()-1000,since:0,type:'text',body,fromMe:true,ack:1});return'out:provider:'+id;}
test('real phone Namaste starts original five steps once without a fake incoming message',async t=>{
 const e=setup(t),key=outgoing(e);assert.equal(enrollNamaste(e,key).started,true);assert.equal(enrollNamaste(e,key).started,false);
 assert.equal(e.stats().queued,5);assert.equal(e.list('message',peer).length,1);assert.equal(e.db.prepare('SELECT count(*) n FROM receipts').get().n,0);
 assert.equal((await enrollStoredNamaste(e)).started,0);assert.equal(e.contact(peer).firstStarted,true);
});
test('Hindi/English Namaste backfill works but respects opt-out, pause, deletion, self notes and existing funnels',async t=>{
 assert.equal(isNamaste('🙏 नमस्ते।'),true);assert.equal(isNamaste('Namaste!'),true);assert.equal(isNamaste('notnamaste'),false);
 for(const flags of[{optedOut:true},{paused:true},{isSelf:true},{deleted:true},{contentDeletedAt:Date.now()},{firstStarted:true}]){
  const e=setup(t),key=outgoing(e);e.put({...e.contact(peer),...flags});assert.equal(enrollNamaste(e,key).started,false);assert.equal(e.stats().queued,0);
 }
 const e=setup(t);e.importHistory({peer,id:'actual-old-text',at:Date.now()-86400000,type:'text',body:'नमस्ते'});assert.equal((await enrollStoredNamaste(e)).started,1);assert.equal(e.stats().queued,5);
});
test('revoked, sensitive, disabled and automated greetings never enroll contacts',t=>{
 const e=setup(t),key=outgoing(e);for(const change of[{revoked:true},{sensitive:true},{source:'funnel'}]){const original=e.get(key);e.put({...original,...change});assert.equal(enrollNamaste(e,key).started,false);e.put(original);}
 e.put({...e.settings(),namasteLeads:false});assert.equal(enrollNamaste(e,key).started,false);
});
