import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from './public/api.js';
import {repairPairingAsset} from './pairing-compat.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import os from 'node:os';
import {withPersistentProfile} from './persistent-driver.mjs';
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
test('the pinned phone-pairing asset fix is narrow, idempotent and rejects unexpected versions',()=>{
  const require=createRequire(import.meta.url);
  const source=fs.readFileSync(path.join(path.dirname(require.resolve('@open-wa/core')),'transport/assets/launch.js'),'utf8');
  const fixed=repairPairingAsset(source);
  assert.equal(fixed.includes('require("WAWebAltDeviceLinkingApi").PairingType'),false);
  assert.equal(fixed.split('require("WAWebPairingType").PairingType').length-1,2);
  assert.equal(repairPairingAsset(fixed),fixed);
  assert.throws(()=>repairPairingAsset(source+'unreviewed code'),/Unrecognized/);
});
test('explicit persistent browser profile survives core option removal without changing sandbox options',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rekha-profile-'));
  try {
    let received;
    const fake={name:'puppeteer',launch:async options=>{received=options;return 'browser';}};
    const driver=withPersistentProfile(fake,path.join(temp,'profile'));
    assert.equal(await driver.launch({args:['--some-safe-flag'],headless:true,userDataDir:undefined}),'browser');
    assert.equal(received.userDataDir,path.join(temp,'profile'));
    assert.deepEqual(received.args,['--some-safe-flag']);assert.equal(received.headless,true);
    assert.equal(driver.name,'puppeteer');
    if(process.platform!=='win32')assert.equal(fs.statSync(received.userDataDir).mode&0o777,0o700);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
