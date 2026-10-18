import test from 'node:test';
import assert from 'node:assert/strict';
import {withDeadline} from './async-deadline.mjs';
test('provider timeouts release stalled callers and cannot accept late results',async()=>{
  let resolve,continued=false;
  const operation=withDeadline(()=>new Promise(r=>resolve=r),15).then(()=>{continued=true;});
  await assert.rejects(operation,/timed out/);
  resolve('late');await new Promise(r=>setImmediate(r));assert.equal(continued,false);
  assert.equal(await withDeadline(()=>Promise.resolve('next'),100),'next');
});
test('provider failures and synchronous throws retain their cause',async()=>{
  await assert.rejects(withDeadline(()=>{throw Error('provider failure');},100),/provider failure/);
  await assert.rejects(withDeadline(()=>Promise.reject(Error('download failed')),100),/download failed/);
});
