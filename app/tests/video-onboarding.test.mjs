import test from 'node:test';
import assert from 'node:assert/strict';
import {createWatchProgress,validSignupDraft,waitForPreparation} from '../public/video-onboarding.js';

test('complete visible continuous playback unlocks, while seeking and an ended event do not',()=>{
  const gate=createWatchProgress();
  const tick=(time,wall,extra={})=>gate.observe({time,duration:4,playing:true,visible:true,...extra},wall);
  tick(0,0);tick(1,1000);assert.equal(tick(4,1100,{ended:true,playing:false}).complete,false);
  assert.equal(gate.seekLimit(4),1);
  tick(1,1200);tick(2,2200);tick(3,3200);tick(4,4200,{playing:false,ended:true});
  assert.equal(gate.state(4).complete,true);assert.equal(gate.state(4).percent,100);
});

test('hidden, paused and skipped portions do not count toward watched coverage',()=>{
  const gate=createWatchProgress(),tick=(time,wall,extra={})=>gate.observe({time,duration:6,playing:true,visible:true,...extra},wall);
  tick(0,0);tick(1,1000);tick(5,5000,{visible:false});tick(6,6000,{ended:true,playing:false});
  assert.equal(gate.state(6).complete,false);assert.equal(gate.state(6).until,1);
  tick(1,7000);tick(2,8000,{playing:false});tick(4,10000,{playing:false});
  assert.equal(gate.state(6).until,1);
  assert.equal(gate.seekLimit(0.5),0.5);
});

test('signup retains adult-date and name validation',()=>{
  const now=new Date('2026-10-03T12:00:00Z');
  assert.equal(validSignupDraft({name:' Asha ',dob:'1995-02-03'},now),true);
  for(const draft of [{name:' ',dob:'1995-02-03'},{name:'Asha',dob:'2020-01-01'},{name:'Asha',dob:'1995-02-30'},{name:'Asha',dob:'1899-01-01'},{name:'Asha',dob:'not-a-date'}])assert.equal(validSignupDraft(draft,now),false);
});

test('successful preparation waits until five seconds and never shortens a slow response',async()=>{
  const waits=[];
  await waitForPreparation(100,{now:()=>1100,wait:async ms=>waits.push(ms)});
  await waitForPreparation(100,{now:()=>6500,wait:async ms=>waits.push(ms)});
  assert.deepEqual(waits,[4000]);
});
