import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from './public/api.js';
const reply = (status, data={}) => new Response(JSON.stringify(data),{status});
test('an old session renews after restart and retries the rejected request once',async()=>{
  const calls=[];
  const api=createApi(async (url,options)=>{calls.push({url,options});return reply(calls.length===1?401:200,{ok:true});});
  assert.equal((await api('pairing',{mode:'qr'})).ok,true);
  assert.deepEqual(calls.map(x=>x.url),['/api/pairing','/','/api/pairing']);
  assert.deepEqual(calls[0].options,calls[2].options);
});
test('network failures and forbidden requests never retry a possible message send',async()=>{
  for(const status of ['network',403,500]) {
    let calls=0;
    const api=createApi(async()=>{calls++;if(status==='network')throw Error('Connection lost');return reply(status,{error:'Blocked'});});
    await assert.rejects(api('send',{requestId:'same-draft',body:'hello'}));
    assert.equal(calls,1);
  }
});
test('repeated 401 stops instead of entering an infinite session-renewal loop',async()=>{
  let calls=0;const api=createApi(async url=>{calls++;return reply(url==='/'?200:401,{error:'Session unavailable'});});
  await assert.rejects(api('status'),/Session unavailable/);assert.equal(calls,3);
});
