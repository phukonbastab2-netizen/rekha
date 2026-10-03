import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {apps} from '../apps/catalog.mjs';
import {bundleWorker} from '../scripts/build.mjs';

// Exercise the real country build output: branding once changed internal
// X-Rekha-Call-* headers into X-Luna Harbor-Call-* and broke live upgrades.
test('country Worker builds preserve valid, stable private voice protocol headers', async t => {
  for (const app of apps) await t.test(app.id, async () => {
    const bundled = bundleWorker(app, {}) + '\nexport {handleAudioRelay,endAudioRelay};\n';
    const worker = await import('data:text/javascript;base64,' + Buffer.from(bundled).toString('base64'));
    const call = {id: randomUUID(), status: 'active', type: 'voice', expires: Date.now() + 60000};
    const origin = 'https://' + app.id + '.test', requests = [], roomIds = [];
    const env = {CALL_AUDIO_RELAY: {
      idFromName: id => {roomIds.push(id);return id;},
      get: () => ({fetch: async request => {requests.push(request);return new Response(null, {status: request.method === 'POST' ? 204 : 200});}}),
    }};
    for (const actor of ['customer', 'admin']) {
      const prefix = actor === 'admin' ? '/api/admin/calls/' : '/api/calls/';
      const request = new Request(origin + prefix + call.id + '/audio', {headers: {Origin: origin, Upgrade: 'websocket', 'x-rekha-call-role': 'forged'}});
      assert.equal((await worker.handleAudioRelay(request, env, {actor, call})).status, 200);
      const forwarded = requests.at(-1);
      assert.equal(forwarded.url, 'https://call-audio.internal/connect');
      assert.equal(forwarded.headers.get('x-rekha-call-id'), call.id);
      assert.equal(forwarded.headers.get('x-rekha-call-role'), actor);
      assert.equal(forwarded.headers.get('x-rekha-call-expires'), String(call.expires));
      assert.deepEqual([...forwarded.headers.keys()].sort(), ['upgrade', 'x-rekha-call-expires', 'x-rekha-call-id', 'x-rekha-call-role']);
    }
    assert.equal(await worker.endAudioRelay(env, call, 'completed'), true);
    const ended = requests.at(-1);
    assert.equal(ended.method, 'POST');assert.equal(ended.url, 'https://call-audio.internal/end');
    assert.equal(ended.headers.get('x-rekha-call-id'), call.id);assert.equal(ended.headers.get('x-rekha-call-end'), 'completed');
    assert.deepEqual([...ended.headers.keys()].sort(), ['x-rekha-call-end', 'x-rekha-call-id']);
    assert.deepEqual(roomIds, [call.id, call.id, call.id]);
  });
});
