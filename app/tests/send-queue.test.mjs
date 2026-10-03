import test from 'node:test';
import assert from 'node:assert/strict';
import {createSendQueue,mergeServerChat} from '../public/send-queue.js';
import {compactAcknowledgement,createChatHistory} from '../public/chat-history.js';
const id='private-conversation-fixture',snapshot=(clientId,body='A private question')=>({clientId,body,attachments:[]});
const view=(records,version=1)=>({id,version,messages:records.map((r,index)=>({id:index+1,role:'user',clientId:r.clientId,body:r.snapshot.body}))});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('compact send ACK confirms one saved row without skipping concurrent history changes',async()=>{
  const old={id,version:4,updated:100,inboxRevision:1,blocked:false,changeRevision:10,page:{oldestId:1,hasOlder:true},messages:[{id:1,role:'assistant',body:'Earlier reply',changeRevision:10}]};
  const history=createChatHistory();history.reset(old);let chat=old;
  const saved={id:2,role:'user',clientId:'compact-first',body:'First',changeRevision:12,readByOther:false};
  const ack={ack:'saved-v1',id,version:5,updated:101,inboxRevision:1,blocked:false,acknowledgedMessage:saved};
  const queue=createSendQueue({send:async()=>compactAcknowledgement(chat,ack,'compact-first'),onAck:next=>{chat=history.accept(chat,next);}});
  queue.enqueue({snapshot:snapshot('compact-first','First'),conversationId:id});await tick();
  assert.equal(queue.isPending(),false);assert.deepEqual(chat.messages.map(message=>message.id),[1,2]);assert.equal(chat.version,5);
  assert.equal(history.state().revision,10);assert.equal(history.state().hasOlder,true);assert.match(history.route('/api/chat'),/afterRevision=10/);
  chat=history.accept(chat,{...chat,version:5,changeRevision:13,messages:[{...old.messages[0],body:'Concurrent edited reply',changeRevision:11},{id:3,role:'assistant',body:'Another reply',changeRevision:13}]},{kind:'delta'});
  assert.equal(chat.messages[0].body,'Concurrent edited reply');assert.equal(history.state().revision,13);assert.deepEqual(chat.messages.map(message=>message.id),[1,2,3]);
});

test('compact retry cannot rewind newer access controls or confirm another message/chat',()=>{
  const current={id,version:8,updated:200,inboxRevision:3,blocked:true,messages:[{id:1,role:'assistant',body:'New reply',changeRevision:20}]};
  const message={id:2,role:'user',clientId:'same-id',body:'Captured text',changeRevision:19};
  const ack={ack:'saved-v1',id,version:8,updated:200,inboxRevision:2,blocked:false,acknowledgedMessage:message};
  const merged=mergeServerChat(current,compactAcknowledgement(current,ack,'same-id'));
  assert.equal(merged.blocked,true);assert.equal(merged.inboxRevision,3);assert.equal(merged.version,8);assert.equal(merged.messages[1].body,'Captured text');
  assert.throws(()=>compactAcknowledgement(current,ack,'wrong-id'),/could not be confirmed/);
  assert.throws(()=>compactAcknowledgement({...current,id:'another-chat'},ack,'same-id'),/could not be confirmed/);
  assert.equal(compactAcknowledgement(current,current,'ignored'),current,'Legacy full response remains supported');
});
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
