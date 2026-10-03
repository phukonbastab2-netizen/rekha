import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

// Exercise current route source against real D1 without waiting for a rebuilt
// generated Worker. Fixture sessions replace only the surrounding auth context.
const moduleBody = file => fs.readFileSync(file, 'utf8').replace(/^import [^\n]*\n/gm, '').replace(/\bexport (async function|function|class)/g, '$1');

async function withFixture(run) {
  const {Miniflare, convertV4MiniflareOptions} = await import(process.env.MINIFLARE_MODULE || 'miniflare');
  const customerA = randomUUID(), customerB = randomUUID();
  const script = moduleBody('backend/turn.mjs') + '\n' + moduleBody('backend/audio-relay.mjs') + '\n' + moduleBody('backend/calls.mjs') + `
    export default {async fetch(request,env){
      const url=new URL(request.url),cookie=request.headers.get('Cookie')||'';
      const stmt=(sql,...values)=>env.DB.prepare(sql).bind(...values);
      const one=(sql,...values)=>stmt(sql,...values).first();
      const all=async(sql,...values)=>(await stmt(sql,...values).all()).results;
      const fail=(status,message)=>Object.assign(new Error(message),{status});
      const result=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
      const get=id=>one('SELECT * FROM conversations WHERE id=?',id);
      const customer=async()=>{
        const id=cookie==='fixtureCustomer=a'?${JSON.stringify(customerA)}:cookie==='fixtureCustomer=b'?${JSON.stringify(customerB)}:null;
        if(!id)throw fail(401,'Customer session required.');return get(id);
      };
      const owner=async()=>{if(cookie!=='fixtureRole=owner')throw fail(401,'Owner session required.');};
      try{return await callsRoutes({request,env,route:url.pathname,method:request.method,stmt,one,all,result,body:()=>request.json(),get,customer,owner,fail,rate:async()=>{}})||result({error:'Not found.'},404);}
      catch(error){return result({error:error.message},error.status||503);}
    }};
  `;
  const mf = new Miniflare(convertV4MiniflareOptions({modules: true, script, compatibilityDate: '2026-09-24', d1Databases: {DB: 'call-liveness-fixture'}}));
  try {
    const db = await mf.getD1Database('DB');
    for (const sql of fs.readFileSync('backend/schema.sql', 'utf8').split(';').filter(s => s.trim())) await db.prepare(sql).run();
    for (const id of [customerA, customerB]) await db.prepare("INSERT INTO conversations(id,token_hash,name,dob,language,preferences,created,updated) VALUES(?,?,'Disposable call fixture','1990-01-01','en','{}',?,?)").bind(id, randomUUID(), Date.now(), Date.now()).run();
    const a = 'fixtureCustomer=a', b = 'fixtureCustomer=b', owner = 'fixtureRole=owner';
    async function call(route, method = 'GET', data, cookie = a) {
      const response = await mf.dispatchFetch('https://call-liveness.test' + route, {method, headers: {Cookie: cookie, 'Content-Type': 'application/json'}, ...(data === undefined ? {} : {body: JSON.stringify(data)})});
      return {status: response.status, data: await response.json()};
    }
    async function reset() {await db.prepare('DELETE FROM calls').run();}
    async function active() {
      await reset();
      const ringing = await call('/api/calls', 'POST', {type: 'voice'});
      assert.equal(ringing.status, 201, JSON.stringify(ringing.data));
      const accepted = await call('/api/admin/calls/' + ringing.data.id + '/accept', 'POST', {}, owner);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
      assert.equal(accepted.data.status, 'active');
      const stored = await db.prepare('SELECT expires FROM calls WHERE id=?').bind(accepted.data.id).first();
      return {...accepted.data, expires: stored.expires};
    }
    const markers = async id => (await db.prepare("SELECT actor,created FROM call_signals WHERE call_id=? AND kind='heartbeat' ORDER BY actor").bind(id).all()).results;
    await run({db, call, reset, active, markers, a, b, owner, customerA});
  } finally {await mf.dispose();}
}

test('active call leases require both authenticated participants without a schema migration', async t => {
  await withFixture(async ({db, call, reset, active, markers, a, b, owner}) => {
    await t.test('accept seeds exactly two private markers and neither marker is sent to clients', async () => {
      const current = await active(), list = await markers(current.id);
      assert.deepEqual(list.map(m => m.actor), ['admin', 'customer']);
      assert.ok(list.every(m => m.created > Date.now() - 5000));
      const customerSignals = await call('/api/calls/' + current.id + '/signals');
      const ownerSignals = await call('/api/admin/calls/' + current.id + '/signals', 'GET', undefined, owner);
      assert.equal(customerSignals.status, 200);assert.equal(ownerSignals.status, 200);
      assert.deepEqual(customerSignals.data.signals, []);assert.deepEqual(ownerSignals.data.signals, []);
      assert.equal((await markers(current.id)).length, 2);
    });

    await t.test('peer cleanup and repeated hangups preserve the first completed, blocked or expired reason', async () => {
      const completed=await active();
      assert.equal((await call('/api/admin/calls/'+completed.id+'/end','POST',{reason:'completed'},owner)).status,200);
      const first=await db.prepare('SELECT reason,updated,expires FROM calls WHERE id=?').bind(completed.id).first();
      assert.equal((await call('/api/calls/'+completed.id+'/end','POST',{reason:'connection-failed'})).status,200);
      assert.deepEqual(await db.prepare('SELECT reason,updated,expires FROM calls WHERE id=?').bind(completed.id).first(),first);
      for(const reason of ['blocked','expired']){
        const current=await active();
        await db.prepare("UPDATE calls SET status='ended',reason=? WHERE id=?").bind(reason,current.id).run();
        assert.equal((await call('/api/calls/'+current.id+'/end','POST',{reason:'connection-failed'})).status,200);
        assert.equal((await db.prepare('SELECT reason FROM calls WHERE id=?').bind(current.id).first()).reason,reason);
        assert.deepEqual(await markers(current.id),[]);
      }
    });

    await t.test('fresh markers keep an old accepted call active, renew only the caller and preserve its hard expiry', async () => {
      const current = await active(), old = Date.now() - 30000;
      await db.prepare("UPDATE calls SET updated=? WHERE id=?").bind(Date.now() - 300000, current.id).run();
      await db.prepare("UPDATE call_signals SET created=? WHERE call_id=? AND kind='heartbeat'").bind(old, current.id).run();
      const before = Date.now(), response = await call('/api/calls/' + current.id + '/signals');
      assert.equal(response.status, 200);assert.equal(response.data.call.status, 'active');
      const renewed = await markers(current.id);
      assert.equal(renewed.find(m => m.actor === 'admin').created, old);
      assert.ok(renewed.find(m => m.actor === 'customer').created >= before);
      assert.equal((await db.prepare('SELECT expires FROM calls WHERE id=?').bind(current.id).first()).expires, current.expires);
    });

    await t.test('a present customer cannot keep an absent owner alive and a new call can start', async () => {
      const current = await active();
      await db.prepare("UPDATE call_signals SET created=? WHERE call_id=? AND actor='admin' AND kind='heartbeat'").bind(Date.now() - 121000, current.id).run();
      const response = await call('/api/calls/' + current.id + '/signals');
      assert.equal(response.data.call.status, 'ended');assert.equal(response.data.call.reason, 'connection-failed');
      assert.deepEqual(response.data.signals, []);assert.deepEqual(await markers(current.id), []);
      const newCall = await call('/api/calls', 'POST', {type: 'voice'});
      assert.equal(newCall.status, 201, JSON.stringify(newCall.data));
    });

    await t.test('a stale participant cannot revive its expired lease by polling or signaling', async () => {
      const current = await active();
      await db.prepare("UPDATE call_signals SET created=? WHERE call_id=? AND actor='customer' AND kind='heartbeat'").bind(Date.now() - 121000, current.id).run();
      const expired = await call('/api/calls/' + current.id + '/signals');
      assert.equal(expired.data.call.status, 'ended');
      const repeated = await call('/api/calls/' + current.id + '/signals');
      assert.equal(repeated.data.call.status, 'ended');assert.deepEqual(await markers(current.id), []);
      assert.equal((await call('/api/calls/' + current.id + '/signals', 'POST', {kind: 'ice', payload: {candidate: 'fixture'}})).status, 409);
    });

    await t.test('unrelated or unauthenticated customers and invalid cursors cannot renew a marker', async () => {
      const current = await active(), old = Date.now() - 30000;
      await db.prepare("UPDATE call_signals SET created=? WHERE call_id=? AND kind='heartbeat'").bind(old, current.id).run();
      assert.equal((await call('/api/calls/' + current.id + '/signals', 'GET', undefined, b)).status, 404);
      assert.equal((await call('/api/calls/' + current.id + '/signals', 'GET', undefined, '')).status, 401);
      assert.equal((await call('/api/calls/' + current.id + '/signals?after=-1')).status, 400);
      assert.ok((await markers(current.id)).every(m => m.created === old));
      assert.equal((await call('/api/calls/' + current.id + '/signals', 'POST', {kind: 'heartbeat', payload: {}})).status, 400);
      assert.equal((await markers(current.id)).length, 2);
    });

    await t.test('private markers do not consume the 250 signaling limit or appear in paged signaling', async () => {
      const current = await active();
      const rows = Array.from({length: 249}, (_, i) => db.prepare("INSERT INTO call_signals(call_id,actor,kind,payload,created) VALUES(?,'customer','ice',?,?)").bind(current.id, JSON.stringify({candidate: 'fixture-' + i}), Date.now()));
      for (let start = 0; start < rows.length; start += 80) await db.batch(rows.slice(start, start + 80));
      const route = '/api/calls/' + current.id + '/signals';
      assert.equal((await call(route, 'POST', {kind: 'ice', payload: {candidate: 'last-permitted'}})).status, 201);
      assert.equal((await call(route, 'POST', {kind: 'ice', payload: {candidate: 'over-limit'}})).status, 409);
      const counts = await db.prepare("SELECT COUNT(*) AS total,SUM(kind!='heartbeat') AS signals FROM call_signals WHERE call_id=?").bind(current.id).first();
      assert.equal(counts.total, 252);assert.equal(counts.signals, 250);
      const firstPage = await call('/api/admin/calls/' + current.id + '/signals', 'GET', undefined, owner);
      assert.equal(firstPage.data.signals.length, 150);assert.ok(firstPage.data.signals.every(s => s.kind === 'ice'));
      const lastId = firstPage.data.signals.at(-1).id;
      const secondPage = await call('/api/admin/calls/' + current.id + '/signals?after=' + lastId, 'GET', undefined, owner);
      assert.equal(secondPage.data.signals.length, 100);assert.ok(secondPage.data.signals.every(s => s.kind === 'ice'));
    });

    await t.test('legacy active calls get a bounded grace period and a missing peer cannot be kept alive', async () => {
      let current = await active();
      await db.prepare("DELETE FROM call_signals WHERE call_id=? AND kind='heartbeat'").bind(current.id).run();
      const customerPoll = await call('/api/calls/' + current.id + '/signals');
      assert.equal(customerPoll.data.call.status, 'active');assert.deepEqual((await markers(current.id)).map(m => m.actor), ['customer']);
      await call('/api/admin/calls/' + current.id + '/signals', 'GET', undefined, owner);
      assert.equal((await markers(current.id)).length, 2);
      current = await active();
      await db.prepare("DELETE FROM call_signals WHERE call_id=? AND actor='admin' AND kind='heartbeat'").bind(current.id).run();
      await db.prepare('UPDATE calls SET updated=? WHERE id=?').bind(Date.now() - 121000, current.id).run();
      const missingPeer = await call('/api/calls/' + current.id + '/signals');
      assert.equal(missingPeer.data.call.status, 'ended');assert.deepEqual(await markers(current.id), []);
      current = await active();
      await db.prepare('DELETE FROM call_signals WHERE call_id=?').bind(current.id).run();
      await db.prepare('UPDATE calls SET updated=? WHERE id=?').bind(Date.now() - 121000, current.id).run();
      assert.deepEqual((await call('/api/admin/calls', 'GET', undefined, owner)).data.calls, []);
      assert.equal((await db.prepare('SELECT status FROM calls WHERE id=?').bind(current.id).first()).status, 'ended');
    });

    await t.test('fresh heartbeats do not extend the one-hour hard expiry and ringing keeps its original timeout', async () => {
      const current = await active();
      await db.prepare('UPDATE calls SET expires=? WHERE id=?').bind(Date.now() - 1, current.id).run();
      const hardExpired = await call('/api/calls/' + current.id + '/signals');
      assert.equal(hardExpired.data.call.status, 'ended');assert.equal(hardExpired.data.call.reason, 'expired');
      assert.deepEqual(await markers(current.id), []);
      await reset();
      const ringing = await call('/api/calls', 'POST', {type: 'voice'});
      await db.prepare('UPDATE calls SET updated=? WHERE id=?').bind(Date.now() - 121000, ringing.data.id).run();
      assert.equal((await call('/api/calls')).data.calls[0].status, 'ringing');
      assert.deepEqual(await markers(ringing.data.id), []);
      await db.prepare('UPDATE calls SET expires=? WHERE id=?').bind(Date.now() - 1, ringing.data.id).run();
      assert.deepEqual((await call('/api/calls')).data.calls, []);
      assert.equal((await db.prepare('SELECT reason FROM calls WHERE id=?').bind(ringing.data.id).first()).reason, 'expired');
    });
  });
});
