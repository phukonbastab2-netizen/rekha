import test from 'node:test';
import assert from 'node:assert/strict';
import {createSendQueue,mergeServerChat} from '../public/send-queue.js';
const id='private-conversation-fixture',snapshot=(clientId,body='A private question')=>({clientId,body,attachments:[]});
const view=(records,version=1)=>({id,version,messages:records.map((r,index)=>({id:index+1,role:'user',clientId:r.clientId,body:r.snapshot.body}))});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('queued messages appear before a slow acknowledgement; later messages retain their own content',async()=>{
  const requests=[],pending=[];const queue=createSendQueue({send:record=>new Promise(resolve=>{requests.push(record);pending.push(resolve);})});
  queue.enqueue({snapshot:snapshot('message-first','First'),conversationId:id});queue.enqueue({snapshot:snapshot('message-second','Second'),conversationId:id});
  assert.equal(queue.list().length,2);await tick();assert.equal(requests.length,1);assert.deepEqual(queue.list().map(x=>[x.snapshot.body,x.state]),[['First','sending'],['Second','queued']]);
  pending.shift()(view([requests[0]]));await tick();assert.equal(requests.length,2);assert.equal(requests[1].snapshot.body,'Second');pending.shift()(view(requests,2));await tick();assert.equal(queue.list().length,0);
});
test('uncertain timeout keeps the same ID for retry, and a matching private poll resolves it',async()=>{
  const attempts=[],confirmed=[];let fail=true;const queue=createSendQueue({send:async record=>{attempts.push(record.clientId);if(fail)throw new Error('Network timeout');return view([record]);},onConfirmed:r=>confirmed.push(r.clientId)});
  queue.enqueue({snapshot:snapshot('unchanged-client-id'),conversationId:id});await tick();assert.equal(queue.list()[0].state,'failed');assert.equal(queue.list()[0].uncertain,true);
  queue.reconcile({...view([{clientId:'unchanged-client-id',snapshot:snapshot('unchanged-client-id')}]),id:'another-private-chat'});assert.equal(queue.list().length,1);
  fail=false;queue.retry('unchanged-client-id');await tick();assert.deepEqual(attempts,['unchanged-client-id','unchanged-client-id']);assert.deepEqual(confirmed,['unchanged-client-id']);assert.equal(queue.list().length,0);
});
test('confirmation during an unanswered HTTP request aborts that request without duplicating the send',async()=>{
  let captured,aborted=false;const queue=createSendQueue({send:(record,{signal})=>{captured=record;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true}));}});
  queue.enqueue({snapshot:snapshot('saved-server-side'),conversationId:id});await tick();queue.reconcile(view([captured]));await tick();assert.equal(aborted,true);assert.equal(queue.list().length,0);
});
test('offline queue resumes with its captured attachment snapshot and does not auto-retry rejected messages',async()=>{
  let connected=false;const captured={file:{name:'owned-photo.jpg'},uploaded:{id:'private-upload-id'}},requests=[];const queue=createSendQueue({online:()=>connected,send:async record=>{requests.push(record);throw Object.assign(new Error('Messages paused'),{status:403});}});
  queue.enqueue({snapshot:{...snapshot('offline-message'),attachments:[captured]},conversationId:id});await tick();assert.equal(requests.length,0);connected=true;queue.resume();await tick();assert.equal(requests[0].snapshot.attachments[0],captured);queue.resume({retryUncertain:true});await tick();assert.equal(requests.length,1);assert.equal(queue.list()[0].state,'failed');
});
test('repeated enqueue cannot duplicate the same request; clear aborts and releases the captured draft',async()=>{
  const calls=[],finished=[];const queue=createSendQueue({online:()=>false,send:async record=>{calls.push(record);return view([record]);}});const entry={snapshot:snapshot('one-message'),conversationId:id,finish:draft=>finished.push(draft.clientId)};queue.enqueue(entry);queue.enqueue(entry);assert.equal(queue.list().length,1);queue.clear();await tick();assert.equal(calls.length,0);assert.deepEqual(finished,['one-message']);
});
test('expired authorization pauses queued sends and keeps the rejected copy visible',async()=>{
  const attempts=[];let queue;queue=createSendQueue({send:async record=>{attempts.push(record.clientId);throw Object.assign(new Error('Chat session ended'),{status:401});},onError:error=>{if(error.status===401)queue.pause({abort:true});}});
  queue.enqueue({snapshot:snapshot('expired-first'),conversationId:id});queue.enqueue({snapshot:snapshot('expired-second'),conversationId:id});await tick();assert.deepEqual(attempts,['expired-first']);assert.deepEqual(queue.list().map(r=>r.state),['failed','queued']);assert.equal(queue.list()[0].uncertain,false);assert.equal(queue.isPending(),true);
});
test('late equal-version unread receipt cannot undo a confirmed read while newer message edits still apply',()=>{
  const previous={id,version:3,updated:100,messages:[{id:1,role:'user',body:'Earlier text',readByOther:true,reactions:[]}]};
  const late={...previous,messages:[{...previous.messages[0],readByOther:false}]};assert.equal(mergeServerChat(previous,late).messages[0].readByOther,true);
  const unread={...previous,messages:[{...previous.messages[0],readByOther:false}]},olderRead={...previous,version:2,messages:[{...previous.messages[0],body:'Older body',readByOther:true}]};const readAdvance=mergeServerChat(unread,olderRead);assert.equal(readAdvance.messages[0].readByOther,true);assert.equal(readAdvance.messages[0].body,'Earlier text');
  const deleted={...previous,version:4,updated:101,messages:[{id:1,role:'user',body:'',deleted:true,readByOther:false,reactions:[{emoji:'👍',by:'owner'}]}]};const merged=mergeServerChat(previous,deleted);assert.equal(merged.version,4);assert.equal(merged.messages[0].deleted,true);assert.equal(merged.messages[0].body,'');assert.deepEqual(merged.messages[0].reactions,deleted.messages[0].reactions);assert.equal(merged.messages[0].readByOther,true);
  assert.equal(mergeServerChat(previous,{...late,id:'different-private-chat'}),previous);
});
