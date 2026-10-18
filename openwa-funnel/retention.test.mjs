import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Engine} from './engine.mjs';
import {createRetentionScheduler} from './retention.mjs';

const DAY=86400000,peer='919876543210@c.us';
function setup(t){
  let now=1000000;
  const engine=new Engine(':memory:',()=>now);
  t.after(()=>engine.close());
  return{engine,advance:days=>{now+=days*DAY;}};
}
function seedMessage(engine,index,extra={}){
  engine.put({key:'in:retention-'+index,kind:'message',peer,id:'retention-'+index,direction:'in',type:'text',body:'Synthetic saved content',at:engine.now(),...extra});
}
function drain(engine,options={}){
  let passes=0,expired=0,result;
  do{result=engine.prune({clock:()=>0,...options});assert.ok(result.scanned<=(options.limit||200));expired+=result.expired;passes++;assert.ok(passes<100,'Retention did not finish a bounded sweep');}while(result.more);
  return{passes,expired};
}

test('paced keyset passes expire more than the old hourly cap while preserving recent messages and receipts',t=>{
  const{engine,advance}=setup(t);
  engine.transaction(()=>{for(let i=0;i<1201;i++){seedMessage(engine,i);engine.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run('retention-'+i,peer,engine.now());}});
  advance(91);seedMessage(engine,'recent');
  const result=drain(engine);
  assert.ok(result.passes>1);assert.equal(result.expired,1201);
  assert.equal(engine.get('in:retention-recent').kind,'message');
  assert.equal(engine.db.prepare('SELECT count(*) n FROM receipts').get().n,1201);
  assert.deepEqual(engine.inbound({peer,id:'retention-0',type:'text',body:'Repeated old message'}),{duplicate:true});
});

test('time budget stops a pass and the next pass resumes without skipping content',t=>{
  const{engine,advance}=setup(t);
  engine.transaction(()=>{for(let i=0;i<60;i++)seedMessage(engine,i);});advance(91);
  let ticks=0;const first=engine.prune({budgetMs:10,clock:()=>ticks++});
  assert.ok(first.scanned>0&&first.scanned<60);assert.equal(first.more,true);
  assert.equal(first.expired+drain(engine).expired,60);
});

test('unresolved jobs cannot strand later expired records and retain their outgoing review evidence',t=>{
  const{engine,advance}=setup(t);
  engine.transaction(()=>{
    for(let i=0;i<230;i++)engine.put({key:'job:'+peer+':held:'+i,kind:'job',peer,phase:'held',step:i,state:'queued',dueAt:engine.now(),payload:{type:'text',body:'Synthetic pending step'}});
    for(const state of['sending','unknown','blocked']){
      const key='job:'+peer+':'+state+':0';
      engine.put({key,kind:'job',peer,phase:state,step:0,state,dueAt:engine.now(),payload:{type:'text',body:'Held send'}});
      engine.put({key:'out:'+key,kind:'message',peer,direction:'out',body:'Actual saved review evidence',at:engine.now()});
    }
    engine.put({key:'job:'+peer+':finished:0',kind:'job',peer,phase:'finished',step:0,state:'accepted',dueAt:engine.now(),payload:{type:'text',body:'Finished'}});
  });advance(91);
  const result=drain(engine,{limit:40});assert.ok(result.passes>5);assert.equal(result.expired,1);
  assert.equal(engine.get('job:'+peer+':finished:0').kind,'deleted');
  assert.equal(engine.db.prepare('SELECT count(*) n FROM due_jobs').get().n,233);
  for(const state of['sending','unknown','blocked'])assert.equal(engine.get('out:job:'+peer+':'+state+':0').body,'Actual saved review evidence');
});

test('contact deletion, consent and first-stage markers survive preview expiry',t=>{
  const{engine,advance}=setup(t);
  engine.put({key:'contact:'+peer,kind:'contact',peer,firstStarted:true,optedOut:true,consentAt:engine.now(),deleted:true,contentDeletedAt:engine.now(),paused:true,preview:'Old preview',unread:4});advance(91);
  drain(engine);
  assert.deepEqual(engine.contact(peer),{key:'contact:'+peer,kind:'contact',peer,firstStarted:true,optedOut:true,consentAt:1000000,deleted:true,contentDeletedAt:1000000,paused:true,preview:'[Older message content expired]',unread:0});
});

test('only actually expired media enters the bounded durable deletion queue',t=>{
  const{engine,advance}=setup(t),expired='a'.repeat(64),held='b'.repeat(64),recent='c'.repeat(64);
  seedMessage(engine,'old-media',{media:{id:expired}});
  const key='job:'+peer+':review:0';
  engine.put({key,kind:'job',peer,phase:'review',step:0,state:'unknown',dueAt:engine.now(),payload:{type:'image'}});
  engine.put({key:'out:'+key,kind:'message',peer,direction:'out',body:'Review evidence',media:{id:held},at:engine.now()});
  advance(91);seedMessage(engine,'new-media',{media:{id:recent}});
  const first=engine.prune({clock:()=>0});assert.deepEqual(first.mediaIds,[expired]);
  // A failed filesystem cleanup does not acknowledge the durable item.
  assert.deepEqual(engine.prune({clock:()=>0}).mediaIds,[expired]);
  assert.equal(engine.get('out:'+key).media.id,held);assert.equal(engine.get('in:retention-new-media').media.id,recent);
  const pendingBefore=engine.stats().backupPending;
  engine.retentionMediaRemoved(expired);
  assert.deepEqual(engine.prune({clock:()=>0}).mediaIds,[]);
  assert.equal(engine.stats().backupPending,pendingBefore);
});

test('maintenance cursor and media deletion survive restart without cursor backup revisions',t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-retention-test-')),file=path.join(folder,'synthetic.sqlite');
  t.after(()=>{for(const suffix of['','-wal','-shm']){const item=file+suffix;if(fs.existsSync(item))fs.unlinkSync(item);}fs.rmdirSync(folder);});
  let now=1000000,engine=new Engine(file,()=>now);
  try{
    engine.transaction(()=>{for(let i=0;i<100;i++)engine.put({key:'job:'+peer+':held:'+i,kind:'job',peer,phase:'held',step:i,state:'queued',dueAt:now,payload:{type:'text',body:'Held'}});});
    seedMessage(engine,'restart-media',{media:{id:'d'.repeat(64)}});
    engine.synced(Number.MAX_SAFE_INTEGER);now+=91*DAY;
    const first=engine.prune({limit:20,clock:()=>0});assert.equal(first.scanned,20);
    const cursor=engine.db.prepare("SELECT * FROM maintenance_cursors WHERE name='content-retention'").get();
    assert.deepEqual(first.mediaIds,['d'.repeat(64)]);
    assert.equal(engine.stats().backupPending,1);engine.close();engine=null;
    engine=new Engine(file,()=>now);
    const second=engine.prune({limit:20,clock:()=>0});assert.equal(second.scanned,20);
    const next=engine.db.prepare("SELECT * FROM maintenance_cursors WHERE name='content-retention'").get();
    assert.ok(next.stamp>cursor.stamp);assert.equal(engine.stats().backupPending,1);
    assert.deepEqual(second.mediaIds,['d'.repeat(64)]);
  }finally{engine?.close();}
});

test('retention scan uses the bounded composite index',t=>{
  const{engine}=setup(t);
  const plan=engine.db.prepare('EXPLAIN QUERY PLAN SELECT key,stamp,json FROM records WHERE kind=? AND (stamp,key)>(?,?) AND stamp<? ORDER BY stamp,key LIMIT ?').all('message',0,'',1000000,50).map(row=>row.detail).join(' ');
  assert.match(plan,/SEARCH.*records_page/);assert.doesNotMatch(plan,/TEMP B-TREE/);
  assert.throws(()=>engine.prune({limit:10000}),/Invalid retention/);
});

test('maintenance yields between backlog passes, idles when caught up and cancels on shutdown',()=>{
  const timers=[],cancelled=[];let calls=0;
  const scheduler=createRetentionScheduler({prune:options=>{assert.deepEqual(options,{limit:200,budgetMs:75});return{scanned:200,expired:200,more:++calls<3};},schedule:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},cancel:timer=>cancelled.push(timer),now:()=>123});
  assert.equal(calls,0);assert.equal(timers[0].ms,1000);
  timers[0].fn();assert.equal(calls,1);assert.equal(timers[1].ms,1000);
  timers[1].fn();assert.equal(calls,2);assert.equal(timers[2].ms,1000);
  timers[2].fn();assert.equal(calls,3);assert.equal(timers[3].ms,60000);
  assert.equal(scheduler.status.more,false);scheduler.close();assert.equal(cancelled[0],timers[3]);timers[3].fn();assert.equal(calls,3);
});

test('maintenance failures back off and do not form a tight retry loop',()=>{
  const timers=[];
  const scheduler=createRetentionScheduler({prune:()=>{throw Error('Private DB failure');},schedule:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},cancel:()=>{}});
  timers[0].fn();assert.equal(timers[1].ms,60000);assert.equal(scheduler.status.error,'Saved-content maintenance will retry.');scheduler.close();
});
