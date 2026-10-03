import test from 'node:test';
import assert from 'node:assert/strict';
import {KUNDLI_WAIT_MS,kundliWaitDeadline,kundliWaitState,kundliWaitBody} from '../public/countdown.js';

test('kundli wait uses the persisted creation timestamp in number and ISO forms',()=>{
  const created=Date.parse('2026-10-04T01:00:00.000Z');
  for(const value of [created,String(created),new Date(created).toISOString()])assert.equal(kundliWaitDeadline({kind:'kundli-wait',created:value}),created+300000);
  assert.equal(KUNDLI_WAIT_MS,300000);
  for(const created of [null,undefined,'','invalid',Infinity,-1,8640000000000000])assert.equal(kundliWaitDeadline({kind:'kundli-wait',created}),null);
  assert.equal(kundliWaitDeadline({kind:'owner-message',created}),null);
  assert.equal(kundliWaitDeadline({kind:'kundli-wait',created,deleted:true}),null);
});

test('reopening calculates remaining time from the fixed deadline and expires at zero',()=>{
  const start=1000000,deadline=start+KUNDLI_WAIT_MS;
  assert.deepEqual(kundliWaitState(deadline,start),{remainingMs:300000,seconds:300,text:'05:00',complete:false});
  assert.equal(kundliWaitState(deadline,start+61000).text,'03:59');
  assert.equal(kundliWaitState(deadline,deadline-1).text,'00:01');
  assert.deepEqual(kundliWaitState(deadline,deadline),{remainingMs:0,seconds:0,text:'00:00',complete:true});
  assert.equal(kundliWaitState(deadline,deadline+86400000).text,'00:00');
  assert.equal(kundliWaitState(deadline,start-3600000).text,'05:00');
});

test('timer markup is escaped stable plain text and never promises a ready reply',()=>{
  const markup=kundliWaitBody({kind:'kundli-wait',created:0,body:'कुंडली देखने का समय · Kundli dekhne ka samay <img onerror="bad">'});
  assert.match(markup,/data-kundli-wait="300000"/);
  assert.match(markup,/&lt;img onerror=&quot;bad&quot;&gt;/);
  assert.match(markup,/समय बाकी · Samay baaki/);
  assert.match(markup,/>05:00<\/time>/);
  assert.match(markup,/aria-live="off"/);
  assert.doesNotMatch(markup,/<img|ready|fetch\(|onclick|disabled/);
  assert.equal(kundliWaitBody({kind:'kundli-wait',created:'invalid',body:'Plain <text>'}),'Plain &lt;text&gt;');
});
