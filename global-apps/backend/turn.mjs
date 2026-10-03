// Server-only credential generation. Call this after authentication and rate limiting.
// https://developers.cloudflare.com/realtime/turn/generate-credentials/
const TURN_CREDENTIAL_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys/';
const TURN_RESPONSE_LIMIT = 16384;

export class TurnConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TurnConfigurationError';
    this.code = code;
  }
}

function turnError(code, message) {
  return new TurnConfigurationError(code, message);
}

function missing(value) {
  return value == null || value === '';
}

function safeCredential(value, limit, token) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit &&
    /^[\x21-\x7e]+$/.test(value) && !value.includes(token);
}

function sanitizeIceServers(data, token) {
  const invalid = () => turnError('TURN_PROVIDER_INVALID', 'The call relay returned invalid credentials. Please try again.');
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !Array.isArray(data.iceServers) || !data.iceServers.length || data.iceServers.length > 6) throw invalid();
  const iceServers = [];
  let hasRelay = false;
  for (const server of data.iceServers) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) throw invalid();
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 8) throw invalid();
    const cleaned = [];
    let isRelay = false;
    for (const url of urls) {
      if (typeof url !== 'string' || url.length > 512) throw invalid();
      // Only accept the standard Cloudflare relay and discovery endpoints.
      const match = url.match(/^(stun|stuns|turn|turns):(stun|turn)\.cloudflare\.com(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/);
      if (!match || (match[1].startsWith('turn') ? match[2] !== 'turn' : match[2] !== 'stun') ||
          (match[3] != null && (Number(match[3]) < 1 || Number(match[3]) > 65535))) throw invalid();
      if (Number(match[3]) === 53) continue; // Browsers block this alternate port.
      cleaned.push(url);
      if (match[1].startsWith('turn')) isRelay = true;
    }
    if (!cleaned.length) continue;
    if (isRelay) {
      if (!safeCredential(server.username, 256, token) || !safeCredential(server.credential, 1024, token)) throw invalid();
      iceServers.push({urls: cleaned, username: server.username, credential: server.credential});
      hasRelay = true;
    } else {
      // Do not copy unrelated provider fields, even if they contain secrets.
      iceServers.push({urls: cleaned});
    }
  }
  if (!hasRelay) throw invalid();
  return iceServers;
}

function cancelTurnBody(response) {
  try {response.body?.cancel().catch(() => {});} catch {}
}

async function readTurnResponse(response, signal) {
  const invalid = () => turnError('TURN_PROVIDER_INVALID', 'The call relay returned an invalid response. Please try again.');
  const type = response.headers.get('Content-Type') || '';
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(type)) {
    cancelTurnBody(response);
    throw invalid();
  }
  const length = response.headers.get('Content-Length');
  if (length != null && (!/^\d+$/.test(length) || Number(length) > TURN_RESPONSE_LIMIT)) {
    cancelTurnBody(response);
    throw invalid();
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw invalid();
  const reader = response.body.getReader();
  const abortRead = () => {reader.cancel().catch(() => {});};
  signal.addEventListener('abort', abortRead, {once: true});
  if (signal.aborted) abortRead();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > TURN_RESPONSE_LIMIT) {
        reader.cancel().catch(() => {});
        throw invalid();
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abortRead);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {
    throw invalid();
  }
}

/**
 * Return optional, browser-safe RTC configuration, or null when unconfigured.
 * TURN_KEY_ID and TURN_API_TOKEN must be Worker secrets, never browser inputs.
 * Options are server-owned. Use a TTL covering the maximum call duration, or
 * refresh credentials with RTCPeerConnection.setConfiguration before expiry.
 * No credential cache is shared between users; invoke once per call participant.
 */
export async function generateTurnConfig(env, {fetchImpl = globalThis.fetch, ttl = 600, timeoutMs = 5000} = {}) {
  const keyId = env?.TURN_KEY_ID;
  const token = env?.TURN_API_TOKEN;
  if (missing(keyId) && missing(token)) return null;
  if (typeof keyId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(keyId) ||
      typeof token !== 'string' || token.length < 16 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) {
    throw turnError('TURN_CONFIGURATION_INVALID', 'The call relay configuration is incomplete or invalid.');
  }
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000) {
    throw turnError('TURN_CONFIGURATION_INVALID', 'The call relay request settings are invalid.');
  }
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(turnError('TURN_TIMEOUT', 'The call relay took too long to respond. Please try again.'));
    }, timeoutMs);
  });
  try {
    const startedAt = Date.now();
    const request = async () => {
      const response = await fetchImpl(TURN_CREDENTIAL_ENDPOINT + keyId + '/credentials/generate-ice-servers', {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json'},
        body: JSON.stringify({ttl}),
        redirect: 'error',
        signal: controller.signal
      });
      if (response.status !== 201 || response.redirected) {
        cancelTurnBody(response);
        throw turnError('TURN_PROVIDER_REJECTED', 'The call relay could not issue credentials. Please try again.');
      }
      const iceServers = sanitizeIceServers(await readTurnResponse(response, controller.signal), token);
      return {iceServers, relayConfigured: true, ttl, expiresAt: startedAt + ttl * 1000};
    };
    return await Promise.race([request(), timeout]);
  } catch (error) {
    if (error instanceof TurnConfigurationError) throw error;
    if (controller.signal.aborted) throw turnError('TURN_TIMEOUT', 'The call relay took too long to respond. Please try again.');
    // Never forward provider response bodies, request headers, or exception text.
    throw turnError('TURN_UNAVAILABLE', 'The call relay is temporarily unavailable. Please try again.');
  } finally {
    clearTimeout(timer);
  }
}
