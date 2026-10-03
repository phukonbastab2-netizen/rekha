import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {verifyReward,rewardCallback,REWARDED_UNIT} from '../cloudflare/rewards.mjs';
const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const fetchKeys=async()=>Response.json({keys:[{keyId:42,base64:keys.publicKey.export({type:'spki',format:'der'}).toString('base64')}]});
function signed(overrides={}){
  const params=new URLSearchParams({ad_unit:REWARDED_UNIT,reward_amount:'1',reward_item:'reply',timestamp:String(Date.now()),transaction_id:'test-transaction',custom_data:'a'.repeat(64),...overrides});
  const raw=params.toString(),signature=sign('sha256',Buffer.from(raw),keys.privateKey).toString('base64url');
  return new URL(`https://example.test/api/rewards/ssv?${raw}&signature=${signature}&key_id=42`);
}
test('signed reward verifies exact bytes; tampered, duplicate, wrong-unit and expired callbacks fail',async()=>{
  assert.equal((await verifyReward(signed(),fetchKeys)).attempt,'a'.repeat(64));
  const tampered=signed();tampered.search=tampered.search.replace('reward_amount=1','reward_amount=2');
  await assert.rejects(verifyReward(tampered,fetchKeys),/Invalid signature/);
  await assert.rejects(verifyReward(signed({ad_unit:'another-unit'}),fetchKeys),/Unexpected/);
  await assert.rejects(verifyReward(signed({reward_amount:'2'}),fetchKeys),/Unexpected/);
  await assert.rejects(verifyReward(signed({timestamp:String(Date.now()-90000000)}),fetchKeys),/expired/);
  const duplicate=signed();duplicate.search+='&ad_unit=other';await assert.rejects(verifyReward(duplicate,fetchKeys));
  await assert.rejects(verifyReward(new URL('https://example.test/?custom_data=x'),fetchKeys));
});
test('verified callback grants once per attempt, setup grants nothing, unknown attempts rejected',async()=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY); INSERT INTO conversations VALUES (\'chat-a\');');
  db.exec(readFileSync(new URL('../cloudflare/migration-rewards.sql',import.meta.url),'utf8'));
  db.prepare('INSERT INTO reward_attempts VALUES (?,?,?,?)').run('a'.repeat(64),'chat-a',Date.now(),Date.now()+3600000);
  const stmt=(sql,...args)=>({run:async()=>db.prepare(sql).run(...args)}),one=async(sql,...args)=>db.prepare(sql).get(...args);
  const original=globalThis.fetch;globalThis.fetch=fetchKeys;
  try{
    const call=url=>rewardCallback({url,stmt,one});
    assert.equal((await call(signed())).status,200);assert.equal((await call(signed())).status,200);
    await call(signed({transaction_id:'second-transaction'}));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_grants').get().n,1);
    await assert.rejects(call(signed({custom_data:'b'.repeat(64),transaction_id:'unknown'})),/expired/);
    await call(signed({custom_data:'0'.repeat(64),transaction_id:'setup',ad_unit:'TEST',reward_amount:'10'}));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_grants').get().n,1);
    assert.ok(db.prepare('SELECT * FROM reward_settings').get());
    db.prepare('DELETE FROM conversations').run();assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reward_grants').get().n,0);
  }finally{globalThis.fetch=original;db.close();}
});
