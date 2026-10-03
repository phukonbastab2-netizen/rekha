import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {handleAudioRelay} from '../backend/audio-relay.mjs';

const origin = 'https://audio-relay.test';
const frame = sample => new Int16Array(640).fill(sample).buffer;

function watchSocket(ws) {
  const messages = [], closes = [], waiters = [];
  function notify() {for (const fn of [...waiters]) fn();}
  ws.addEventListener('message', event => {
    messages.push(event.data);
    // Mirror the app's end-control handling, including a client close reply.
    // Separate assertions below verify the server removed its own sockets.
    if (typeof event.data === 'string' && event.data.startsWith('{') && JSON.parse(event.data).type === 'ended') ws.close(1000, 'Call ended.');
    notify();
  });
  ws.addEventListener('close', event => {closes.push({code: event.code, reason: event.reason});notify();});
  // The local workerd HTTP bridge can defer TCP FIN after both Close frames.
  // Observe the real received frame as well as close events; room inspection
  // separately proves server sockets are gone. Production browser cleanup is
  // a separate integration check and is not claimed by this fixture.
  ws.once?.('open', () => ws._receiver?.on('conclude', () => setImmediate(notify)));
  ws.accept?.();
  async function until(predicate, description, timeout = 2500) {
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      const changed = () => {if (predicate()) {clearTimeout(timer);waiters.splice(waiters.indexOf(changed), 1);resolve();}};
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(changed), 1);
        if (predicate()) {resolve();return;}
        reject(new Error(description + ' ' + JSON.stringify({controls: messages.filter(value => typeof value === 'string'), binaryMessages: messages.filter(value => typeof value !== 'string').length, closes, readyState: ws.readyState,closeReceived:ws._closeFrameReceived,closeSent:ws._closeFrameSent})));
      }, timeout);
      waiters.push(changed);changed();
    });
  }
  const controls = () => messages.filter(value => typeof value === 'string' && value !== 'pong').map(value => JSON.parse(value));
  const audio = () => messages.filter(value => typeof value !== 'string');
  const closed = () => closes.length === 1 || ws._closeFrameReceived === true && ws._closeFrameSent === true;
  return {ws, messages, closes, controls, audio, until, closed};
}

async function fixture(run) {
  const moduleUrl = process.env.MINIFLARE_MODULE || import.meta.resolve('miniflare');
  const {Miniflare, convertV4MiniflareOptions} = await import(moduleUrl);
  const Socket = createRequire(moduleUrl)('ws');
  const customerA = randomUUID(), customerB = randomUUID(), customerC = randomUUID();
  // Only surrounding session authentication is a fixture. Production helper,
  // hibernatable WebSocket callbacks and scoped-call SQL run in real workerd.
  const source = fs.readFileSync('backend/audio-relay.mjs', 'utf8').replace('export class CallAudioRelay', 'class BaseCallAudioRelay');
  const script = source + `
    export class CallAudioRelay extends BaseCallAudioRelay {
      async fetch(request) {
        if (new URL(request.url).pathname === '/fixture-inspect') {
          await this.ready;
          return Response.json({stored: [...await this.ctx.storage.list()], attachments: this.sockets().map(ws => this.metadata(ws)), socketStates:this.ctx.getWebSockets().map(ws=>ws.readyState),session:this.session,validation:this.validation,validationAt:this.validationAt,validating:!!this.validationPromise});
        }
        return super.fetch(request);
      }
    }
    export default {async fetch(request,env){
      const url=new URL(request.url),cookie=request.headers.get('Cookie')||'';
      const actor=cookie==='fixtureRole=owner'?'admin':cookie==='fixtureCustomer=a'||cookie==='fixtureCustomer=b'||cookie==='fixtureCustomer=c'?'customer':null;
      const customerId=cookie==='fixtureCustomer=a'?${JSON.stringify(customerA)}:cookie==='fixtureCustomer=b'?${JSON.stringify(customerB)}:${JSON.stringify(customerC)};
      if(!actor)return Response.json({error:'Session required.'},{status:401});
      const id=url.pathname.split('/').at(-2);
      const call=await env.DB.prepare('SELECT * FROM calls WHERE id=?').bind(id).first();
      if(!call||actor==='customer'&&call.conversation_id!==customerId)return Response.json({error:'Call not found.'},{status:404});
      if(url.pathname.endsWith('/fixture-end')&&actor==='admin'){
        await env.DB.prepare("UPDATE calls SET status='ended' WHERE id=?").bind(id).run();
        await endAudioRelay(env,call,'completed');return new Response(null,{status:204});
      }
      if(url.pathname.endsWith('/fixture-inspect')&&actor==='admin')return env.CALL_AUDIO_RELAY.get(env.CALL_AUDIO_RELAY.idFromName(id)).fetch('https://call-audio.internal/fixture-inspect');
      return handleAudioRelay(request,env,{actor,call});
    }};
  `;
  const mf = new Miniflare(convertV4MiniflareOptions({name: 'audio-relay-fixture', modules: true, script, compatibilityDate: '2026-09-24', durableObjects: {CALL_AUDIO_RELAY: {className: 'CallAudioRelay', useSQLite: true}}, d1Databases: {DB: 'audio-relay-fixture'}}));
  const sockets = [];
  try {
    const db = await mf.getD1Database('DB');
    for (const sql of fs.readFileSync('backend/schema.sql', 'utf8').split(';').filter(s => s.trim())) await db.prepare(sql).run();
    for (const id of [customerA, customerB, customerC]) await db.prepare("INSERT INTO conversations(id,token_hash,name,dob,language,preferences,created,updated) VALUES(?,?,'Disposable voice fixture','1990-01-01','en','{}',?,?)").bind(id, randomUUID(), Date.now(), Date.now()).run();
    const cookies = {a: 'fixtureCustomer=a', b: 'fixtureCustomer=b', c: 'fixtureCustomer=c', owner: 'fixtureRole=owner'};
    async function active({customerId = customerA, expires = Date.now() + 3600000, status = 'active', type = 'voice', markers = true, updated = Date.now()} = {}) {
      const id = randomUUID();
      await db.prepare("UPDATE calls SET status='ended' WHERE expires<? AND status!='ended'").bind(Date.now()).run();
      await db.prepare('INSERT INTO calls(id,conversation_id,caller,type,status,created,updated,expires) VALUES(?,?,?,?,?,?,?,?)').bind(id, customerId, 'customer', type, status, Date.now(), updated, expires).run();
      if (markers) for (const actor of ['admin', 'customer']) await db.prepare("INSERT INTO call_signals(call_id,actor,kind,payload,created) VALUES(?,?,'heartbeat','{}',?)").bind(id, actor, Date.now()).run();
      return {id, customerId, expires};
    }
    async function request(call, {role = 'a', upgrade = true, originHeader = origin, method = 'GET', extraHeaders = {}, suffix = 'audio'} = {}) {
      const admin = role === 'owner', headers = {Cookie: cookies[role] || '', ...extraHeaders};
      if (upgrade) headers.Upgrade = 'websocket';
      if (originHeader !== null) headers.Origin = originHeader;
      return mf.dispatchFetch(origin + (admin ? '/api/admin/calls/' : '/api/calls/') + call.id + '/' + suffix, {method, headers});
    }
    async function connect(call, role = 'a', extraHeaders = {}) {
      // Use the actual local network listener for successful upgrades. This
      // tests real close handshakes through idle/hibernation, without the extra
      // in-memory response.webSocket bridge used by dispatchFetch().
      const listener = await mf.ready, socketUrl = new URL((role === 'owner' ? '/api/admin/calls/' : '/api/calls/') + call.id + '/audio', listener);
      socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new Socket(socketUrl, {headers: {Cookie: cookies[role], Origin: listener.origin, ...extraHeaders}});
      ws.binaryType = 'arraybuffer';
      const watched = watchSocket(ws);sockets.push(watched);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);ws.once('error', reject);
        ws.once('unexpected-response', (_, response) => reject(new Error('Voice upgrade failed with HTTP ' + response.statusCode)));
      });
      return watched;
    }
    async function pair(call, customer = 'a') {return {customer: await connect(call, customer), owner: await connect(call, 'owner')};}
    const namespace = await mf.getDurableObjectNamespace('CALL_AUDIO_RELAY');
    const inspect = async call => (await namespace.get(namespace.idFromName(call.id)).fetch('https://call-audio.internal/fixture-inspect')).json();
    await run({db, mf, active, request, connect, pair, inspect, customerA, customerB, customerC});
  } finally {
    for (const socket of sockets) try {socket.ws.close(1000, 'Fixture complete.');} catch {}
    await mf.dispose();
  }
}

test('audio handler validates request and replaces all untrusted internal metadata', async () => {
  const call = {id: randomUUID(), type: 'voice', status: 'active', expires: Date.now() + 60000};
  let forwarded;
  const env = {CALL_AUDIO_RELAY: {idFromName: id => id, get: () => ({fetch: async request => {forwarded = request;return new Response('fixture');}})}};
  const request = new Request(origin + '/api/calls/' + call.id + '/audio', {headers: {Origin: origin, Upgrade: 'websocket', Cookie: 'private-session', 'X-Rekha-Call-Role': 'admin', 'X-Rekha-Call-Expires': String(Date.now() + 99999999), Authorization: 'Bearer private-secret'}});
  assert.equal((await handleAudioRelay(request, env, {actor: 'customer', call})).status, 200);
  assert.equal(forwarded.url, 'https://call-audio.internal/connect');
  assert.equal(forwarded.headers.get('X-Rekha-Call-Role'), 'customer');
  assert.equal(forwarded.headers.get('X-Rekha-Call-Expires'), String(call.expires));
  assert.equal(forwarded.headers.get('Cookie'), null);assert.equal(forwarded.headers.get('Authorization'), null);
  assert.equal((await handleAudioRelay(request, env, {call})).status, 401);
  assert.equal((await handleAudioRelay(request, {}, {actor: 'customer', call})).status, 503);
});

test('private voice relay uses real SQLite Durable Objects and D1 call permissions', async t => {
  await fixture(async ({db, mf, active, request, connect, pair, inspect, customerA, customerB, customerC}) => {
    await t.test('rejects absent/foreign sessions, cross-origin or missing origin, non-upgrade, ringing, video and expired calls', async () => {
      const call = await active();
      for (const [options, status] of [[{role: ''}, 401], [{role: 'b'}, 404], [{originHeader: 'https://unrelated.test'}, 403], [{originHeader: null}, 403], [{upgrade: false}, 426], [{method: 'POST', upgrade: false}, 405]]) assert.equal((await request(call, options)).status, status);
      await db.prepare("UPDATE calls SET status='ringing' WHERE id=?").bind(call.id).run();
      assert.equal((await request(call)).status, 409);
      await db.prepare("UPDATE calls SET status='active',type='video' WHERE id=?").bind(call.id).run();
      assert.equal((await request(call)).status, 409);
      await db.prepare("UPDATE calls SET type='voice',expires=? WHERE id=?").bind(Date.now() - 1, call.id).run();
      assert.equal((await request(call)).status, 409);
      await db.prepare("UPDATE calls SET status='ended' WHERE id=?").bind(call.id).run();
    });

    await t.test('both roles receive peer state, audio reaches only the other role, and duplicate role cannot join', async () => {
      const call = await active(), customer = await connect(call, 'a', {'X-Rekha-Call-Role': 'admin'});
      await customer.until(() => customer.controls().some(c => c.type === 'peer' && c.connected === false), 'Initial disconnected peer state missing.');
      const owner = await connect(call, 'owner');
      await Promise.all([customer, owner].map(socket => socket.until(() => socket.controls().some(c => c.type === 'peer' && c.connected), 'Joined peer state missing.')));
      assert.equal((await request(call)).status, 409);
      assert.equal((await request(call, {role: 'owner'})).status, 409);
      customer.ws.send(frame(1234));owner.ws.send(frame(-2345));
      await Promise.all([customer, owner].map(socket => socket.until(() => socket.audio().length === 1, 'Relayed audio missing.')));
      assert.deepEqual([...new Int16Array(customer.audio()[0])], [...new Int16Array(640).fill(-2345)]);
      assert.deepEqual([...new Int16Array(owner.audio()[0])], [...new Int16Array(640).fill(1234)]);
      customer.ws.send('ping');await customer.until(() => customer.messages.includes('pong'), 'Bounded keepalive was not answered.');
      const state = await inspect(call);
      assert.deepEqual(state.stored.map(([key]) => key), ['session']);
      assert.deepEqual(Object.keys(state.stored[0][1]).sort(), ['callId', 'ended', 'expiresAt']);
      assert.ok(state.attachments.every(meta => Object.keys(meta).sort().join(',') === 'callId,expiresAt,role'));
      await request(call, {role: 'owner', upgrade: false, suffix: 'fixture-end'});
      await Promise.all([customer, owner].map(socket => socket.until(socket.closed, 'Explicit hangup did not close both roles.')));
      assert.ok(customer.controls().some(control => control.type === 'ended' && control.reason === 'completed'));
      assert.equal((await request(call)).status, 409);
    });

    await t.test('disconnect notifies the other role and authenticated reconnect restores audio without creating a third participant', async () => {
      const call = await active(), {customer, owner} = await pair(call);
      await owner.until(() => owner.controls().some(c => c.connected), 'Peer join missing.');
      customer.ws.close(1000, 'Fixture disconnect.');
      await owner.until(() => owner.controls().some(c => c.type === 'peer' && !c.connected), 'Peer disconnect notification missing.');
      const reconnected = await connect(call);
      await reconnected.until(() => reconnected.controls().some(c => c.connected), 'Reconnect peer state missing.');
      reconnected.ws.send(frame(333));await owner.until(() => owner.audio().length === 1, 'Reconnected audio missing.');
      assert.equal((await request(call)).status, 409);
      await request(call, {role: 'owner', upgrade: false, suffix: 'fixture-end'});
    });

    await t.test('simultaneous joins cannot reserve the same authenticated role twice', async () => {
      const call = await active(), responses = await Promise.all([request(call), request(call)]);
      assert.deepEqual(responses.map(response => response.status).sort(), [101, 409]);
      watchSocket(responses.find(response => response.status === 101).webSocket);
      const state = await inspect(call);assert.equal(state.attachments.length, 1);assert.equal(state.attachments[0].role, 'customer');
      await request(call, {role: 'owner', upgrade: false, suffix: 'fixture-end'});
    });

    await t.test('hibernation restores private participant attachments and continues isolated audio forwarding', async () => {
      const call = await active(), {customer, owner} = await pair(call);
      await mf.unsafeEvictDurableObject('audio-relay-fixture', 'CallAudioRelay', {name: call.id, webSockets: 'hibernate'});
      customer.ws.send(frame(456));
      await owner.until(() => owner.audio().length === 1, 'Audio did not resume after hibernation.');
      assert.equal(new Int16Array(owner.audio()[0])[0], 456);
      assert.equal(customer.audio().length, 0);
      const state = await inspect(call);assert.deepEqual(state.attachments.map(meta => meta.role).sort(), ['admin', 'customer']);
      await request(call, {role: 'owner', upgrade: false, suffix: 'fixture-end'});
    });

    await t.test('separate calls cannot hear each other or join a different customer room', async () => {
      const a = await active(), b = await active({customerId: customerB});
      const roomA = await pair(a), roomB = await pair(b, 'b');
      assert.equal((await request(b, {role: 'a'})).status, 404);
      roomA.customer.ws.send(frame(111));roomB.owner.ws.send(frame(222));
      await Promise.all([roomA.owner.until(() => roomA.owner.audio().length === 1, 'Room A audio missing.'), roomB.customer.until(() => roomB.customer.audio().length === 1, 'Room B audio missing.')]);
      await delay(80);
      assert.equal(roomA.customer.audio().length, 0);assert.equal(roomB.owner.audio().length, 0);
      assert.equal(new Int16Array(roomA.owner.audio()[0])[0], 111);assert.equal(new Int16Array(roomB.customer.audio()[0])[0], 222);
      for (const call of [a, b]) await request(call, {role: 'owner', upgrade: false, suffix: 'fixture-end'});
    });

    await t.test('invalid binary size, arbitrary text and excessive frame rate close offending sockets', async () => {
      const cases = [socket => socket.ws.send(new ArrayBuffer(1278)), socket => socket.ws.send(new ArrayBuffer(1282)), socket => socket.ws.send('{"type":"admin"}'), socket => {for (let i = 0; i < 41; i++) socket.ws.send(frame(i));}];
      for (const send of cases) {
        const call = await active(), {customer, owner} = await pair(call);send(customer);
        await customer.until(() => customer.closes.length === 1, 'Invalid audio protocol did not close sender.');
        assert.ok([1008, 1009].includes(customer.closes[0].code));
        await owner.until(() => owner.controls().some(c => c.type === 'peer' && !c.connected), 'Protocol closure was not reported to peer.');
        assert.ok(owner.audio().length <= 40);
        await request(call, {role: 'owner', upgrade: false, suffix: 'fixture-end'});
      }
    });

    await t.test('a hard expiry alarm closes silent sockets and prevents reconnect', async () => {
      // Leave enough time for two real network upgrades under parallel builds;
      // the assertion still requires an automatic expiry with silent peers.
      const call = await active({expires: Date.now() + 2500}), {customer, owner} = await pair(call);
      try {await Promise.all([customer, owner].map(socket => socket.until(socket.closed, 'Hard expiry did not close silent sockets.', 3500)));} catch(error) {error.message+=' '+JSON.stringify(await inspect(call));throw error;}
      assert.ok(customer.controls().some(c => c.type === 'ended' && c.reason === 'expired'));
      assert.deepEqual((await inspect(call)).socketStates, []);
      assert.equal((await request(call)).status, 409);
    });

    await t.test('connect verifies blocked state and both leases while legacy calls get only the existing bounded grace', async () => {
      const fresh = await active({updated: Date.now() - 300000});
      const valid = await pair(fresh);assert.equal(valid.customer.closes.length, 0);
      await request(fresh, {role: 'owner', upgrade: false, suffix: 'fixture-end'});
      const stale = await active();
      await db.prepare("UPDATE call_signals SET created=? WHERE call_id=? AND actor='admin'").bind(Date.now() - 121000, stale.id).run();
      assert.equal((await request(stale)).status, 409);
      await db.prepare("UPDATE calls SET status='ended' WHERE id=?").bind(stale.id).run();
      const blocked = await active({customerId: customerB});
      await db.prepare('INSERT INTO chat_messaging(conversation_id,blocked) VALUES(?,1)').bind(customerB).run();
      assert.equal((await request(blocked, {role: 'b'})).status, 409);
      await db.prepare('DELETE FROM chat_messaging WHERE conversation_id=?').bind(customerB).run();
      await db.prepare("UPDATE calls SET status='ended' WHERE id=?").bind(blocked.id).run();
      const legacy = await active({markers: false});await connect(legacy);
      await request(legacy, {role: 'owner', upgrade: false, suffix: 'fixture-end'});
      const oldLegacy = await active({markers: false, updated: Date.now() - 121000});
      assert.equal((await request(oldLegacy)).status, 409);
      await db.prepare("UPDATE calls SET status='ended' WHERE id=?").bind(oldLegacy.id).run();
    });

    await t.test('cached call access is rechecked within five seconds and revocation closes existing sockets before forwarding', async () => {
      const ended = await active(), blocked = await active({customerId: customerB}), deleted = await active({customerId: customerC});
      const rooms = await Promise.all([pair(ended), pair(blocked, 'b'), pair(deleted, 'c')]);
      for (const room of rooms) {room.customer.ws.send(frame(555));await room.owner.until(() => room.owner.audio().length === 1, 'Initial authorized audio missing.');}
      await db.prepare("UPDATE calls SET status='ended' WHERE id=?").bind(ended.id).run();
      await db.prepare('INSERT INTO chat_messaging(conversation_id,blocked) VALUES(?,1)').bind(customerB).run();
      await db.prepare('DELETE FROM conversations WHERE id=?').bind(customerC).run();
      await delay(5100);
      for (const room of rooms) room.customer.ws.send(frame(999));
      try {await Promise.all(rooms.flatMap(room => [room.customer, room.owner].map(socket => socket.until(socket.closed, 'Revoked call remained connected.'))));} catch(error) {error.message+=' '+JSON.stringify(await inspect(ended));throw error;}
      for (const room of rooms) assert.equal(room.owner.audio().length, 1, 'Audio was forwarded after revocation validation.');
      for (const call of [ended, blocked, deleted]) assert.deepEqual((await inspect(call)).socketStates, []);
      await db.prepare('DELETE FROM chat_messaging WHERE conversation_id=?').bind(customerB).run();
      await db.prepare("UPDATE calls SET status='ended' WHERE id=?").bind(blocked.id).run();
    });

    await t.test('a fresh participant cannot keep an abandoned peer alive through cached WebSocket audio', async () => {
      const call = await active(), {customer, owner} = await pair(call);
      await db.prepare("UPDATE call_signals SET created=? WHERE call_id=? AND actor='admin'").bind(Date.now() - 121000, call.id).run();
      await db.prepare("UPDATE call_signals SET created=? WHERE call_id=? AND actor='customer'").bind(Date.now(), call.id).run();
      await delay(5100);customer.ws.send(frame(100));
      await Promise.all([customer, owner].map(socket => socket.until(socket.closed, 'Abandoned participant lease did not stop audio.')));
      assert.equal(owner.audio().length, 0);
      assert.deepEqual((await inspect(call)).socketStates, []);
      await db.prepare("UPDATE calls SET status='ended' WHERE id=?").bind(call.id).run();
    });

    await t.test('database failure fails closed instead of continuing to forward audio', async () => {
      const call = await active(), {customer, owner} = await pair(call);
      await db.prepare('ALTER TABLE call_signals RENAME TO unavailable_call_signals').run();
      await delay(5100);customer.ws.send(frame(444));
      await Promise.all([customer, owner].map(socket => socket.until(socket.closed, 'Database failure did not stop voice transport.')));
      assert.equal(owner.audio().length, 0);
      assert.deepEqual((await inspect(call)).socketStates, []);
    });
  });
});
