import test from 'node:test';
import assert from 'node:assert/strict';
import {customerSendHoldState,createStartupDelivery,followupChoiceClientId,followupChoiceState,isFollowupChoiceResponse} from '../public/startup-delivery.js';
import {createSendQueue,mergeServerChat} from '../public/send-queue.js';
import {messageBody} from '../public/media.js';
import {DONATION_INTEREST_TEXT,donationInterestClientId,donationInterestState,isDonationInterestResponse} from '../public/customer-followup.js';

const first=Date.parse('2026-10-04T01:00:00Z'),last=first+29*5000,id='local-hold-chat';
const lines=Array.from({length:30},(_,index)=>({id:index+5,role:'assistant',kind:'kundli-review-line',created:first+index*5000,deliveryAt:first+index*5000,body:`Fixture ${index}`}));
const choice={id:35,role:'assistant',kind:'kundli-followup-choice',created:last,deliveryAt:last,body:'क्या आप और अधिक जानना चाहते हैं या फिर कुछ काम करवाना चाहते हैं?'};
const chat={id,messages:[...lines,choice],customerSendHold:{startsAt:first,endsAt:last,active:true},kundliChoiceAnswered:false};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('donation interest accepts only the explicit assistant action and confirmation prevents repeat clicks after paging',()=>{
  const message={id:38,role:'assistant',kind:'media',body:JSON.stringify({donation:{action:'interest-v1'}})},ready={id,messages:[message]},clientId=donationInterestClientId(38);
  assert.equal(clientId,'kundli-donation-interest-v1-38');assert.match(clientId,/^[\w-]{16,80}$/);assert.equal(isDonationInterestResponse(clientId),true);assert.equal(donationInterestState(ready,message).disabled,false);
  const record={conversationId:id,clientId,state:'queued'};assert.equal(donationInterestState(ready,message,[record]).disabled,true);record.state='failed';assert.equal(donationInterestState(ready,message,[record]).state,'failed');
  assert.equal(donationInterestState({...ready,kundliDonationInterested:true},message).state,'answered');assert.equal(donationInterestState({...ready,messages:[message,{role:'user',clientId,deleted:true}]},message).disabled,true);
  for(const invalid of [{...message,role:'user'},{...message,deleted:true},{...message,body:'{}'},{...message,body:'not JSON'}])assert.equal(donationInterestState(ready,invalid).clientId,null);
  assert.equal(donationInterestState({...ready,customerSendHold:{active:true}},message).disabled,true);
});

test('donation interest queues one bare saved text and retries the same ID while an unrelated composer draft remains',async()=>{
  let connected=false,fail=true;const clientId=donationInterestClientId(38),requests=[],draft={body:'Keep my question',replyTo:12,attachments:[{file:{name:'owned-photo.jpg'}}]},before=JSON.stringify(draft);
  const queue=createSendQueue({online:()=>connected,send:async record=>{requests.push({...record.snapshot});if(fail)throw new Error('Connection interrupted');return{id,messages:[{id:39,role:'user',clientId,body:DONATION_INTEREST_TEXT}]};}}),entry={snapshot:{body:DONATION_INTEREST_TEXT,clientId},conversationId:id};
  queue.enqueue(entry);queue.enqueue(entry);await tick();assert.equal(queue.list().length,1);assert.equal(JSON.stringify(draft),before);assert.equal(requests.length,0);
  connected=true;queue.resume();await tick();assert.equal(queue.list()[0].state,'failed');fail=false;queue.retry(clientId);await tick();assert.equal(queue.list().length,0);
  assert.deepEqual(requests,[{body:DONATION_INTEREST_TEXT,clientId},{body:DONATION_INTEREST_TEXT,clientId}]);assert.equal(JSON.stringify(draft),before);
});

test('hold begins with the first line, ends exactly with the final line, and leaves the prior timer usable',()=>{
  for(const value of [first-300000,first-1])assert.equal(customerSendHoldState(chat,value).active,false);
  for(const value of [first,first+1,last-1])assert.equal(customerSendHoldState(chat,value).active,true);
  for(const value of [last,last+1])assert.equal(customerSendHoldState(chat,value).active,false);
  assert.equal(customerSendHoldState({...chat,customerSendHold:undefined},first).active,true);
  assert.equal(customerSendHoldState({messages:[{kind:'kundli-wait',role:'assistant',created:first-300000,deliveryAt:first-300000}]},first).active,false);
  assert.equal(customerSendHoldState({messages:[],customerSendHold:{startsAt:Infinity,endsAt:last}},first).active,false);
});

test('sparse offline pages use saved boundaries and aligned clock, waking once to release compose and reveal choice',t=>{
  let wall=first+120000+7000,elapsed=0,source={...chat,messages:[choice],clockOffsetMs:-120000},timer=null,changes=0;
  const scheduler=createStartupDelivery({getChat:()=>source,now:()=>wall,monotonic:()=>elapsed,setTimer:(callback,delay)=>{timer={callback,delay};return 1;},clearTimer:()=>timer=null,onReveal:()=>changes++,documentTarget:null,windowTarget:null});
  t.after(()=>scheduler.destroy());scheduler.accept(source,{cached:true});scheduler.start();
  assert.equal(scheduler.view().customerSendHold.active,true);assert.deepEqual(scheduler.view().messages,[]);assert.equal(timer.delay,last-first-7000-5000);
  wall+=last-first-7000;elapsed+=last-first-7000;const callback=timer.callback;timer=null;callback();
  assert.equal(scheduler.view().customerSendHold.active,false);assert.deepEqual(scheduler.view().messages,[choice]);assert.equal(changes,1);assert.equal(timer,null);
});

test('choice stays hidden until final line and late choice deltas do not change the original hold deadline',t=>{
  let elapsed=0,source={...chat,messages:lines},timer;
  const scheduler=createStartupDelivery({getChat:()=>source,now:()=>first+elapsed,monotonic:()=>elapsed,setTimer:callback=>(timer=callback,1),clearTimer:()=>timer=null,documentTarget:null,windowTarget:null});
  t.after(()=>scheduler.destroy());scheduler.accept({...source,serverTime:first});scheduler.start();assert.equal(scheduler.view().customerSendHold.active,true);
  elapsed=last-first;assert.equal(scheduler.view().customerSendHold.active,false);source={...source,messages:[...lines,choice]};scheduler.refresh();
  assert.equal(scheduler.view().messages.at(-1),choice);assert.equal(customerSendHoldState(source,first).endsAt,last);assert.equal(timer,null);
});

test('Yes uses a valid deterministic ID, stays pending on repeat clicks, and confirmation survives sparse views',()=>{
  const clientId=followupChoiceClientId(choice.id);assert.equal(clientId,'kundli-followup-yes-v1-35');assert.match(clientId,/^[\w-]{16,80}$/);assert.equal(isFollowupChoiceResponse(clientId),true);assert.equal(followupChoiceClientId('<img>'),null);
  const ready={...chat,customerSendHold:{startsAt:first,endsAt:last,active:false}};
  assert.equal(followupChoiceState(ready,choice).disabled,false);
  const record={clientId,conversationId:id,state:'queued'};assert.deepEqual(followupChoiceState(ready,choice,[record]),{clientId,state:'pending',disabled:true});
  record.state='failed';assert.equal(followupChoiceState(ready,choice,[record]).state,'failed');assert.equal(followupChoiceState(ready,choice,[record]).disabled,true);
  const confirmed={...ready,kundliChoiceAnswered:true,messages:[choice]};assert.equal(followupChoiceState(confirmed,choice).state,'answered');
  assert.equal(mergeServerChat(confirmed,{...ready,messages:[]}).kundliChoiceAnswered,true);
  assert.equal(followupChoiceState({...ready,messages:[choice,{role:'user',clientId,deleted:true}]},choice).disabled,true);
});

test('one durable bare Yes send preserves an unrelated draft and attachment context through offline retry',async()=>{
  let connected=false,fail=true;const requests=[],draft={body:'My unsent question',replyTo:8,editId:9,attachments:[{file:{name:'owned.jpg'}}]},original=JSON.stringify(draft),clientId=followupChoiceClientId(choice.id);
  const queue=createSendQueue({online:()=>connected,send:async record=>{requests.push({...record.snapshot});if(fail)throw new Error('Offline');return {id,messages:[{id:36,role:'user',clientId,body:'Yes'}]};}});
  const entry={snapshot:{body:'Yes',clientId},conversationId:id};queue.enqueue(entry);queue.enqueue(entry);await tick();assert.equal(queue.list().length,1);assert.deepEqual(requests,[]);assert.equal(JSON.stringify(draft),original);
  connected=true;queue.resume();await tick();assert.equal(queue.list()[0].state,'failed');assert.equal(JSON.stringify(draft),original);
  fail=false;queue.retry(clientId);await tick();assert.equal(queue.list().length,0);assert.deepEqual(requests,[{body:'Yes',clientId},{body:'Yes',clientId}]);assert.equal(JSON.stringify(draft),original);
});

test('hold race pauses a captured send without a retry loop, then resumes the same message at deadline',async()=>{
  let current=first-1,attempts=0;const clientId='local-held-message-123',snapshot={body:'Saved question',clientId,attachments:[{file:{name:'owned.jpg'}}]};
  const queue=createSendQueue({online:()=>!customerSendHoldState(chat,current).active,send:async record=>{attempts++;if(attempts===1){current=first;throw Object.assign(new Error('Wait'),{status:409,code:'CUSTOMER_SEND_HOLD',retryAt:last});}return {id,messages:[{id:36,role:'user',clientId:record.clientId}]};}});
  queue.enqueue({snapshot,conversationId:id});await tick();await tick();assert.equal(attempts,1);assert.equal(queue.list()[0].state,'queued');assert.equal(queue.list()[0].snapshot,snapshot);
  queue.resume({retryUncertain:true});await tick();assert.equal(attempts,1);current=last;queue.resume();await tick();assert.equal(attempts,2);assert.equal(queue.isPending(),false);
});

test('choice markup shows exact escaped Hindi and Yes only for the customer option, with no inert owner action',()=>{
  const ready=followupChoiceState({...chat,customerSendHold:{active:false}},choice),markup=messageBody(choice,{followupChoice:ready});
  assert.match(markup,/<p>क्या आप और अधिक जानना चाहते हैं या फिर कुछ काम करवाना चाहते हैं\?<\/p>/);assert.match(markup,/data-followup-yes="35" data-choice-state="available">Yes<\/button>/);
  assert.equal(messageBody(choice),choice.body);assert.match(messageBody(choice,{followupChoice:{...ready,state:'answered',disabled:true}}),/data-choice-state="answered" disabled>Yes<\/button>/);
  const malicious=messageBody({...choice,body:'<img onerror="bad()"> & words'},{followupChoice:ready});assert.doesNotMatch(malicious,/<img/);assert.match(malicious,/&lt;img onerror=&quot;bad\(\)&quot;&gt; &amp; words/);
});
