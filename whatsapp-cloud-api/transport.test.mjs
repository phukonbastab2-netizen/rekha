import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { CloudApiError, verifyWebhookSignature, makeCloudPayload, sendCloudMessage, markCloudMessageRead } from './transport.mjs';

const credentials = { token: 'secret-test-token', phoneNumberId: '123456789012345', graphVersion: 'v25.0' };
const outbound = { ...credentials, to: '919876543210', step: { type: 'text', body: 'नमस्ते' } };
const ok = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const rejected = (code, status = 400, extra = {}, headers = {}) => ok({ error: { code, message: 'secret-test-token; private customer body', ...extra } }, status, headers);
function checkError(expected) {
  return error => {
    assert.ok(error instanceof CloudApiError);
    for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value, key);
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /secret-test-token|private customer body/);
    return true;
  };
}

test('HMAC checks exact UTF-8 body, every byte, malformed signatures and byte-view offsets', async () => {
  const body = '{"text":"नमस्ते","value":1}';
  const secret = 'known-webhook-secret';
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(await verifyWebhookSignature(body, `sha256=${digest}`, secret), true);
  assert.equal(await verifyWebhookSignature(body, `sha256=${digest.toUpperCase()}`, secret), true);
  const surrounding = new TextEncoder().encode(`xxx${body}yyy`);
  assert.equal(await verifyWebhookSignature(surrounding.subarray(3, surrounding.length - 3), `sha256=${digest}`, secret), true);
  assert.equal(await verifyWebhookSignature(new TextEncoder().encode(body).buffer, `sha256=${digest}`, secret), true);
  assert.equal(await verifyWebhookSignature(`${body} `, `sha256=${digest}`, secret), false);
  assert.equal(await verifyWebhookSignature(body, `sha256=${digest}`, 'different-secret'), false);
  for (const index of [0, 31, 63]) {
    const altered = digest.slice(0, index) + (digest[index] === '0' ? '1' : '0') + digest.slice(index + 1);
    assert.equal(await verifyWebhookSignature(body, `sha256=${altered}`, secret), false);
  }
  for (const signature of [null, '', digest, `sha256=${digest.slice(1)}`, `sha256=${digest}0`, `sha1=${digest}`, `sha256=${'z'.repeat(64)}`]) {
    assert.equal(await verifyWebhookSignature(body, signature, secret), false);
  }
  assert.equal(await verifyWebhookSignature(body, `sha256=${digest}`, ''), false);
  assert.equal(await verifyWebhookSignature({}, `sha256=${digest}`, secret), false);
});

test('message builder preserves original text and normalizes only an optional phone +', () => {
  assert.deepEqual(makeCloudPayload('+919876543210', { type: 'text', body: '  नमस्ते\n₹29  ' }), {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'text',
    text: { body: '  नमस्ते\n₹29  ', preview_url: false }
  });
  for (const type of ['image', 'video']) {
    assert.deepEqual(makeCloudPayload(outbound.to, { type, url: 'https://media.example/test.mp4', body: 'वीडियो' })[type], {
      link: 'https://media.example/test.mp4', caption: 'वीडियो'
    });
  }
  assert.deepEqual(makeCloudPayload(outbound.to, { type: 'audio', url: 'https://media.example/test.mp3', body: '' }).audio, {
    link: 'https://media.example/test.mp3'
  });
  assert.equal(makeCloudPayload(outbound.to, { type: 'image', url: 'https://media.example/a.jpg', caption: 'caption' }).image.caption, 'caption');
});

test('invalid or excessive payloads fail before any request; captions are never silently truncated', () => {
  const cases = [
    [{ type: 'text', body: '' }, 'INVALID_TEXT'],
    [{ type: 'text', body: ' ' }, 'INVALID_TEXT'],
    [{ type: 'text', body: 'a'.repeat(4097) }, 'INVALID_TEXT'],
    [{ type: 'image', url: 'https://m.example/a.jpg', body: 'a'.repeat(1025) }, 'INVALID_CAPTION'],
    [{ type: 'audio', url: 'https://m.example/a.mp3', body: 'a' }, 'AUDIO_CAPTION_UNSUPPORTED'],
    [{ type: 'video', url: 'https://m.example/a.mp4', body: 'a', caption: 'b' }, 'CONFLICTING_CAPTION'],
    [{ type: 'document', url: 'https://m.example/a.pdf' }, 'UNSUPPORTED_MESSAGE_TYPE'],
    [null, 'INVALID_STEP'],
    [{ type: 'image', url: 'http://m.example/a.jpg' }, 'INVALID_MEDIA_URL'],
    [{ type: 'image', url: 'https://secret@m.example/a.jpg' }, 'INVALID_MEDIA_URL'],
    [{ type: 'image', url: 'javascript:alert(1)' }, 'INVALID_MEDIA_URL']
  ];
  for (const [step, code] of cases) assert.throws(() => makeCloudPayload(outbound.to, step), checkError({ code, uncertain: false, retryable: false }));
  for (const to of ['919876543210@c.us', '9198/76543210', '00123456789', '123', 919876543210]) {
    assert.throws(() => makeCloudPayload(to, outbound.step), checkError({ code: 'INVALID_RECIPIENT' }));
  }
});

test('send targets only fixed Graph origin and returns only the accepted message ID', async () => {
  let calls = 0;
  const result = await sendCloudMessage({ ...outbound, fetchImpl: async (url, init) => {
    calls += 1;
    assert.equal(url, 'https://graph.facebook.com/v25.0/123456789012345/messages');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${credentials.token}`);
    assert.equal(JSON.parse(init.body).text.body, outbound.step.body);
    assert.ok(init.signal instanceof AbortSignal);
    return ok({ messages: [{ id: 'wamid.HBgMOTE5ODY=' }], contacts: [{ wa_id: outbound.to }], token: credentials.token });
  } });
  assert.deepEqual(result, { messageId: 'wamid.HBgMOTE5ODY=' });
  assert.equal(calls, 1);
});

test('host/path/header injection and malformed IDs cannot cause a network call', async () => {
  for (const [field, value, code] of [
    ['graphVersion', 'https://evil.example', 'INVALID_GRAPH_VERSION'],
    ['graphVersion', 'v25.0/../../escape', 'INVALID_GRAPH_VERSION'],
    ['phoneNumberId', '12345/messages?access_token=bad', 'INVALID_PHONE_NUMBER_ID'],
    ['token', 'valid\r\nInjected: data', 'INVALID_TOKEN'],
    ['token', '', 'INVALID_TOKEN']
  ]) {
    await assert.rejects(sendCloudMessage({ ...outbound, [field]: value, fetchImpl: () => assert.fail('network forbidden') }), checkError({ code, uncertain: false }));
  }
});

test('only explicit typed throttles can be safely retried, never by this transport itself', async () => {
  for (const [status, code] of [[429, 1], [400, 130429], [400, 131056], [400, 4], [400, 80007]]) {
    let calls = 0;
    await assert.rejects(sendCloudMessage({ ...outbound, fetchImpl: async () => { calls += 1; return rejected(code, status, {}, { 'Retry-After': '17' }); } }),
      checkError({ code, status, retryable: true, uncertain: false, isRestriction: false, retryAfterSeconds: 17 }));
    assert.equal(calls, 1);
  }
});

test('account restrictions, spam limits, invalid tokens and permanent Graph rejections stop', async () => {
  for (const [code, isRestriction] of [[131031, true], [368, true], [131048, true], [190, false], [100, false], [131026, false], [131047, false]]) {
    await assert.rejects(sendCloudMessage({ ...outbound, fetchImpl: async () => rejected(code) }),
      checkError({ code, status: 400, retryable: false, uncertain: false, isRestriction, retryAfterSeconds: 0 }));
  }
  // A generic transient flag must not silently turn an unfamiliar rejection into a retry.
  await assert.rejects(sendCloudMessage({ ...outbound, fetchImpl: async () => rejected(99999, 400, { is_transient: true }) }), checkError({ retryable: false, uncertain: false }));
  await assert.rejects(sendCloudMessage({ ...outbound, fetchImpl: async () => rejected(190, 429) }), checkError({ retryable: false, uncertain: false }));
});

test('5xx, network failures, unparseable replies, and unconfirmed successes remain uncertain', async () => {
  for (const fetchImpl of [
    async () => rejected(130429, 500),
    async () => rejected(1, 503, { is_transient: true }),
    async () => { throw new Error('secret-test-token; private customer body'); },
    async () => new Response('<html>proxy failure</html>', { status: 502 }),
    async () => new Response('unconfirmed rate limit', { status: 429 }),
    async () => ok({ success: true }),
    async () => ok({ messages: [{ id: 'not-a-wamid' }] }),
    async () => ok({ messages: [{ id: 'wamid.one' }, { id: 'wamid.two' }] }),
    async () => ({ ok: true, status: 200, text: async () => { throw new Error('truncated stream'); } }),
    async () => new Response('x'.repeat(131073), { status: 200 })
  ]) {
    await assert.rejects(sendCloudMessage({ ...outbound, fetchImpl }), checkError({ retryable: false, uncertain: true }));
  }
});

test('read receipts use the same fixed authenticated endpoint and return no raw response', async () => {
  const result = await markCloudMessageRead({ ...credentials, messageId: 'wamid.inbound', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://graph.facebook.com/v25.0/123456789012345/messages');
    assert.deepEqual(JSON.parse(init.body), { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.inbound' });
    return ok({ success: true, private: 'ignored' });
  } });
  assert.deepEqual(result, { success: true });
  await assert.rejects(markCloudMessageRead({ ...credentials, messageId: 'bad', fetchImpl: () => assert.fail('network forbidden') }), checkError({ code: 'INVALID_MESSAGE_ID', uncertain: false }));
  await assert.rejects(markCloudMessageRead({ ...credentials, messageId: 'wamid.inbound', fetchImpl: async () => ok({ success: false }) }), checkError({ uncertain: true }));
});

test('20 second deadline aborts a hanging request without retrying it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let calls = 0;
  const sending = sendCloudMessage({ ...outbound, fetchImpl: (_url, init) => {
    calls += 1; signal = init.signal;
    return new Promise(() => {});
  } });
  const assertion = assert.rejects(sending, checkError({ code: 'REQUEST_TIMEOUT', uncertain: true, retryable: false }));
  t.mock.timers.tick(20_000);
  await assertion;
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});
