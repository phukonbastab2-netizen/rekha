import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateTurnConfig, TurnConfigurationError} from '../backend/turn.mjs';

const env = {TURN_KEY_ID: 'fixture-turn-key', TURN_API_TOKEN: 'fixture-server-token-123456789'};
const fixture = () => ({
  iceServers: [
    {urls: ['stun:stun.cloudflare.com:3478'], ignored: env.TURN_API_TOKEN},
    {urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'temporary-user', credential: 'temporary-password', ignored: env.TURN_API_TOKEN}
  ],
  apiToken: env.TURN_API_TOKEN
});
const jsonResponse = (body, status = 201) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const hasCode = code => error => error instanceof TurnConfigurationError && error.code === code &&
  !JSON.stringify({message: error.message, ...error}).includes(env.TURN_API_TOKEN);

test('TURN stays disabled without configuration and makes no provider request', async () => {
  let calls = 0;
  const fetchImpl = () => {calls++; throw new Error('unexpected provider request');};
  assert.equal(await generateTurnConfig({}, {fetchImpl}), null);
  assert.equal(await generateTurnConfig(undefined, {fetchImpl}), null);
  assert.equal(await generateTurnConfig({TURN_KEY_ID: '', TURN_API_TOKEN: ''}, {fetchImpl}), null);
  assert.equal(calls, 0);
});

test('TURN rejects partial, unsafe or unbounded configuration before contacting the provider', async () => {
  let calls = 0;
  const fetchImpl = () => {calls++;};
  for (const invalid of [
    {TURN_KEY_ID: env.TURN_KEY_ID},
    {TURN_API_TOKEN: env.TURN_API_TOKEN},
    {...env, TURN_KEY_ID: '../another-key'},
    {...env, TURN_API_TOKEN: env.TURN_API_TOKEN + '\r\nX-Injected: yes'}
  ]) await assert.rejects(generateTurnConfig(invalid, {fetchImpl}), hasCode('TURN_CONFIGURATION_INVALID'));
  for (const options of [{ttl: 59}, {ttl: 3601}, {ttl: 600.5}, {timeoutMs: 9}, {timeoutMs: 10001}]) {
    await assert.rejects(generateTurnConfig(env, {...options, fetchImpl}), hasCode('TURN_CONFIGURATION_INVALID'));
  }
  assert.equal(calls, 0);
});

test('TURN generates bounded short-lived credentials server-side and returns only safe RTC fields', async () => {
  const before = Date.now();
  let request;
  const config = await generateTurnConfig(env, {fetchImpl: async (url, options) => {
    request = {url, options};
    return jsonResponse(fixture());
  }});
  assert.equal(request.url, 'https://rtc.live.cloudflare.com/v1/turn/keys/fixture-turn-key/credentials/generate-ice-servers');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, 'Bearer ' + env.TURN_API_TOKEN);
  assert.deepEqual(JSON.parse(request.options.body), {ttl: 600});
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(config.iceServers, [
    {urls: ['stun:stun.cloudflare.com:3478']},
    {urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'temporary-user', credential: 'temporary-password'}
  ]);
  assert.equal(config.relayConfigured, true);
  assert.equal(config.ttl, 600);
  assert.ok(config.expiresAt >= before + 600000 && config.expiresAt <= Date.now() + 600000);
  assert.equal(JSON.stringify(config).includes(env.TURN_API_TOKEN), false);
});

test('TURN can issue a one-hour TTL when the server selects that call limit', async () => {
  const config = await generateTurnConfig(env, {ttl: 3600, fetchImpl: async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), {ttl: 3600});
    return jsonResponse(fixture());
  }});
  assert.equal(config.ttl, 3600);
});

test('TURN rejects provider failures without exposing their response or the server token', async () => {
  for (const status of [302, 401, 429, 500]) await assert.rejects(generateTurnConfig(env, {
    fetchImpl: async () => new Response(env.TURN_API_TOKEN, {status})
  }), hasCode('TURN_PROVIDER_REJECTED'));
});

test('TURN rejects missing credentials, invalid destinations and reflected server secrets', async () => {
  const invalid = [
    {},
    {iceServers: []},
    {iceServers: [{urls: 'stun:stun.cloudflare.com:3478'}]},
    {iceServers: [{urls: 'turn:turn.cloudflare.com:3478', username: 'user'}]},
    {iceServers: [{urls: 'https://attacker.invalid', username: 'user', credential: 'password'}]},
    {iceServers: [{urls: 'turn:attacker.invalid:3478', username: 'user', credential: 'password'}]},
    {iceServers: [{urls: 'turn:turn.cloudflare.com:99999', username: 'user', credential: 'password'}]},
    {iceServers: [{urls: 'turn:turn.cloudflare.com:3478', username: 'user', credential: env.TURN_API_TOKEN}]},
    {iceServers: [{urls: 'turn:turn.cloudflare.com:3478', username: 'user\ninvalid', credential: 'password'}]}
  ];
  for (const data of invalid) await assert.rejects(generateTurnConfig(env, {
    fetchImpl: async () => jsonResponse(data)
  }), hasCode('TURN_PROVIDER_INVALID'));
});

test('TURN rejects malformed JSON and response types', async () => {
  for (const response of [
    new Response('{invalid', {status: 201, headers: {'Content-Type': 'application/json'}}),
    new Response(JSON.stringify(fixture()), {status: 201, headers: {'Content-Type': 'text/html'}}),
    new Response(null, {status: 201, headers: {'Content-Type': 'application/json'}})
  ]) await assert.rejects(generateTurnConfig(env, {fetchImpl: async () => response}), hasCode('TURN_PROVIDER_INVALID'));
});

test('TURN limits provider response bytes even when Content-Length is absent', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {controller.enqueue(new Uint8Array(16385));},
    cancel() {cancelled = true;}
  });
  await assert.rejects(generateTurnConfig(env, {
    fetchImpl: async () => new Response(body, {status: 201, headers: {'Content-Type': 'application/json'}})
  }), hasCode('TURN_PROVIDER_INVALID'));
  assert.equal(cancelled, true);
});

test('TURN bounds time spent waiting for provider headers and aborts the request', async () => {
  let signal;
  const before = Date.now();
  await assert.rejects(generateTurnConfig(env, {timeoutMs: 20, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }}), hasCode('TURN_TIMEOUT'));
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - before < 1000);
});

test('TURN applies its timeout while reading a stalled provider body', async () => {
  let cancelled = false;
  const body = new ReadableStream({start() {}, cancel() {cancelled = true;}});
  await assert.rejects(generateTurnConfig(env, {timeoutMs: 20, fetchImpl: async () =>
    new Response(body, {status: 201, headers: {'Content-Type': 'application/json'}})
  }), hasCode('TURN_TIMEOUT'));
  assert.equal(cancelled, true);
});

test('TURN keeps network exception details private', async () => {
  await assert.rejects(generateTurnConfig(env, {fetchImpl: async () => {
    throw new Error('Request leaked Authorization: Bearer ' + env.TURN_API_TOKEN);
  }}), hasCode('TURN_UNAVAILABLE'));
});
