// Worker-compatible transport. This module never logs payloads or credentials,
// and never retries a request itself. The durable caller owns retry decisions.
const GRAPH_ORIGIN = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 131_072;
const THROTTLE_CODES = new Set([4, 80007, 130429, 131056]);
const RESTRICTION_CODES = new Set([368, 131031, 131048]);

export class CloudApiError extends Error {
  constructor(code, { status = 0, retryable = false, uncertain = false, isRestriction = false, retryAfterSeconds = 0 } = {}) {
    // Deliberately omit the server's message/details and the original exception:
    // either may contain recipient data, payload text or credentials.
    super(typeof code === 'number' ? `WhatsApp Cloud API rejected the request (${code}).` : 'WhatsApp Cloud API request did not complete.');
    this.name = 'CloudApiError';
    this.code = code;
    this.status = status;
    this.uncertain = Boolean(uncertain);
    this.retryable = !this.uncertain && Boolean(retryable);
    this.isRestriction = Boolean(isRestriction);
    this.retryAfterSeconds = this.retryable ? retryAfterSeconds : 0;
  }
}

function fail(code) { throw new CloudApiError(code); }

function bytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** Verify the exact, unparsed request body against Meta's X-Hub-Signature-256. */
export async function verifyWebhookSignature(rawBody, signature, appSecret) {
  if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  if (typeof appSecret !== 'string' || !appSecret.length) return false;
  const body = bytes(rawBody);
  if (!body) return false;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
    const supplied = new Uint8Array(signature.slice(7).match(/../g).map(hex => Number.parseInt(hex, 16)));
    let difference = 0;
    // Both buffers are exactly 32 bytes. Never exit on the first differing byte.
    for (let i = 0; i < 32; i += 1) difference |= expected[i] ^ supplied[i];
    return difference === 0;
  } catch {
    return false;
  }
}

function recipient(value) {
  if (typeof value !== 'string') fail('INVALID_RECIPIENT');
  const normalized = value.startsWith('+') ? value.slice(1) : value;
  if (!/^[1-9]\d{7,14}$/.test(normalized)) fail('INVALID_RECIPIENT');
  return normalized;
}

function textField(value, max, code, required = false) {
  if (value === undefined || value === null) {
    if (required) fail(code);
    return '';
  }
  if (typeof value !== 'string' || [...value].length > max || (required && !value.trim())) fail(code);
  return value;
}

function mediaUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) fail('INVALID_MEDIA_URL');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_MEDIA_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('INVALID_MEDIA_URL');
  return url.href;
}

/** Build only the supported free-form message types; no arbitrary Graph body. */
export function makeCloudPayload(to, step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) fail('INVALID_STEP');
  const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient(to), type: step.type };
  if (step.type === 'text') {
    payload.text = { body: textField(step.body, 4096, 'INVALID_TEXT', true), preview_url: false };
    return payload;
  }
  if (!['image', 'video', 'audio'].includes(step.type)) fail('UNSUPPORTED_MESSAGE_TYPE');
  const caption = textField(step.body ?? step.caption, 1024, 'INVALID_CAPTION');
  if (step.body !== undefined && step.caption !== undefined && step.body !== step.caption) fail('CONFLICTING_CAPTION');
  if (step.type === 'audio' && caption) fail('AUDIO_CAPTION_UNSUPPORTED');
  payload[step.type] = { link: mediaUrl(step.url) };
  if (caption) payload[step.type].caption = caption;
  return payload;
}

function credentials({ token, phoneNumberId, graphVersion }) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token)) fail('INVALID_TOKEN');
  if (typeof phoneNumberId !== 'string' || !/^[1-9]\d{4,31}$/.test(phoneNumberId)) fail('INVALID_PHONE_NUMBER_ID');
  if (typeof graphVersion !== 'string' || !/^v[1-9]\d?\.\d{1,2}$/.test(graphVersion)) fail('INVALID_GRAPH_VERSION');
  return `${GRAPH_ORIGIN}/${graphVersion}/${phoneNumberId}/messages`;
}

function validMessageId(value) {
  return typeof value === 'string' && /^wamid\.[A-Za-z0-9+/=_-]{1,1024}$/.test(value);
}

function retryDelay(headers) {
  const value = headers?.get?.('retry-after');
  if (typeof value === 'string') {
    const seconds = /^\d+(\.\d+)?$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400, Math.ceil(seconds));
  }
  return 30;
}

function graphError(data, status, headers) {
  const code = Number.isSafeInteger(data?.error?.code) && data.error.code >= 0 ? data.error.code : null;
  const isRestriction = RESTRICTION_CODES.has(code);
  // A 5xx can follow a committed send. Even a transient flag is not proof that
  // nothing was sent. Likewise, unrecognised response envelopes are ambiguous.
  if (status >= 500 || code === null || status < 400 || status > 499) {
    return new CloudApiError(code ?? 'UNCONFIRMED_RESPONSE', { status, uncertain: true, isRestriction });
  }
  const retryable = !isRestriction && code !== 190 && (status === 429 || THROTTLE_CODES.has(code));
  return new CloudApiError(code, { status, retryable, isRestriction, retryAfterSeconds: retryable ? retryDelay(headers) : 0 });
}

async function postGraph(options, payload, kind) {
  const url = credentials(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== 'function') fail('INVALID_FETCH');
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CloudApiError('REQUEST_TIMEOUT', { uncertain: true }));
      }, REQUEST_TIMEOUT_MS);
    });
    const request = (async () => {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal, redirect: 'manual'
      });
      const raw = await response.text();
      let data;
      if (raw.length <= MAX_RESPONSE_BYTES) {
        try { data = JSON.parse(raw); } catch { /* Unparseable outcome remains uncertain. */ }
      }
      if (!response.ok || data?.error) throw graphError(data, response.status, response.headers);
      if (kind === 'read' && data?.success === true) return { success: true };
      if (kind === 'send' && data?.messages?.length === 1 && validMessageId(data.messages[0]?.id)) {
        return { messageId: data.messages[0].id };
      }
      throw new CloudApiError('UNCONFIRMED_RESPONSE', { status: response.status, uncertain: true });
    })();
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (error instanceof CloudApiError) throw error;
    throw new CloudApiError(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', { uncertain: true });
  } finally {
    clearTimeout(timer);
  }
}

export async function sendCloudMessage(options) {
  return postGraph(options, makeCloudPayload(options.to, options.step), 'send');
}

export async function markCloudMessageRead(options) {
  if (!validMessageId(options.messageId)) fail('INVALID_MESSAGE_ID');
  return postGraph(options, { messaging_product: 'whatsapp', status: 'read', message_id: options.messageId }, 'read');
}
