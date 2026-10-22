import net from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_HEXKEYS_BRIDGE_FRAME_BYTES = 64 * 1024;
const NONCE_RE = /^[0-9a-f]{64}$/;
const MAC_RE = /^[0-9a-f]{64}$/;
const CONSUME_FIELDS = Object.freeze([
  'grantId', 'requestId', 'connectorId', 'capabilityId', 'taskId',
  'origin', 'path', 'method', 'header', 'prefix',
]);
const FIELD_LIMITS = Object.freeze({
  grantId: 32,
  requestId: 32,
  connectorId: 63,
  capabilityId: 63,
  taskId: 128,
  origin: 300,
  path: 2048,
  method: 12,
  header: 88,
  prefix: 64,
});

export const HEXIKEYS_CAPTURE_CATEGORIES = Object.freeze(['Password', 'API key', 'Token', 'Recovery phrase', 'Backup codes', 'License key', 'Secure note', 'Screenshot OCR', 'Other']);
export function validateHexiKeysCaptureRequest(request) {
  if (!isPlainObject(request) || Object.keys(request).sort().join(',') !== 'category,expiresAt,fieldLabel,requestId,requestedBy,title' ||
      typeof request.requestId !== 'string' || !/^[0-9a-f]{32}$/.test(request.requestId) || !HEXIKEYS_CAPTURE_CATEGORIES.includes(request.category) ||
      !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= Math.floor(Date.now() / 1000) || request.expiresAt > Math.floor(Date.now() / 1000) + 60) {
    throw genericError('invalid_request', 'The protected capture request is invalid.');
  }
  for (const [name, limit] of [['title', 120], ['fieldLabel', 80], ['requestedBy', 120]]) {
    if (typeof request[name] !== 'string' || !request[name].trim() || request[name].length > limit || /[\x00-\x1f\x7f]/.test(request[name])) throw genericError('invalid_request', 'The protected capture request is invalid.');
  }
  return Object.freeze({ ...request });
}

const macInput = (direction, nonce, payload) =>
  `${direction}\0v1\0${nonce}\0${payload}`;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function genericError(code, message = 'The local credential bridge is unavailable.') {
  const error = new Error(message);
  error.name = 'HexiKeysBridgeError';
  error.code = code;
  return error;
}

function validatePipeId(pipeId) {
  if (typeof pipeId !== 'string' || !/^hexikeys-[0-9a-f]{32}$/.test(pipeId)) {
    throw new TypeError('Use a local HexiKeys pipe name.');
  }
  return `\\\\.\\pipe\\${pipeId}`;
}

function validateKey(key) {
  if (!(Buffer.isBuffer(key) || key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new TypeError('The local bridge key must contain exactly 32 bytes.');
  }
  return Buffer.from(key);
}

function validateConsumeRequest(request) {
  if (!isPlainObject(request)) throw genericError('invalid_request', 'The credential request is invalid.');
  const keys = Object.keys(request).sort();
  const expected = [...CONSUME_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw genericError('invalid_request', 'The credential request is invalid.');
  }
  for (const field of CONSUME_FIELDS) {
    if (typeof request[field] !== 'string' || (field !== 'prefix' && request[field].length < 1) || request[field].length > FIELD_LIMITS[field]) {
      throw genericError('invalid_request', 'The credential request is invalid.');
    }
  }
  return Object.fromEntries(CONSUME_FIELDS.map((field) => [field, request[field]]));
}

function canonicalHttpsOrigin(value) {
  if (typeof value !== 'string' || value.length > 300 || !/^https:\/\/[^/?#]+\/?$/i.test(value)) {
    throw genericError('invalid_request', 'The credential request is invalid.');
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error();
    }
    return `https://${parsed.host.toLowerCase()}`;
  } catch {
    throw genericError('invalid_request', 'The credential request is invalid.');
  }
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length > (MAX_HEXKEYS_BRIDGE_FRAME_BYTES * 4 / 3 + 8)) {
    throw genericError('authentication', 'The local credential bridge response failed authentication.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw genericError('authentication', 'The local credential bridge response failed authentication.');
  }
  return decoded;
}

function parseAuthenticatedResponse(raw, key, expectedNonce) {
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw genericError('authentication', 'The local credential bridge response failed authentication.');
  }
  if (!isPlainObject(envelope)) {
    throw genericError('authentication', 'The local credential bridge response failed authentication.');
  }
  const keys = Object.keys(envelope).sort();
  if (keys.join(',') !== 'mac,nonce,payload,v' || envelope.v !== 1 || envelope.nonce !== expectedNonce ||
      typeof envelope.mac !== 'string' || !MAC_RE.test(envelope.mac)) {
    throw genericError('authentication', 'The local credential bridge response failed authentication.');
  }
  const payloadBytes = decodeCanonicalBase64(envelope.payload);
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
  } catch {
    throw genericError('authentication', 'The local credential bridge response failed authentication.');
  }
  const expectedMac = createHmac('sha256', key)
    .update(macInput('res', expectedNonce, envelope.payload), 'utf8')
    .digest();
  const suppliedMac = Buffer.from(envelope.mac, 'hex');
  if (suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) {
    throw genericError('authentication', 'The local credential bridge response failed authentication.');
  }
  if (!isPlainObject(payload) || typeof payload.ok !== 'boolean') {
    throw genericError('authentication', 'The local credential bridge response failed authentication.');
  }
  if (!payload.ok) {
    if (Object.keys(payload).sort().join(',') !== 'error,ok') {
      throw genericError('authentication', 'The local credential bridge response failed authentication.');
    }
    const allowed = new Set(['denied', 'locked', 'storage', 'unavailable']);
    const code = allowed.has(payload.error) ? payload.error : 'unavailable';
    throw genericError(code);
  }
  return payload;
}

/**
 * Trusted-host-only HexiKeys IPC client. It is intentionally a direct local
 * named-pipe client: do not expose it to plugins, models, or agent tool code.
 * Pairing and OS-vault persistence are owned by the embedding host.
 */
export class HexiKeysBridgeClient {
  #pipePath;
  #key;
  #timeoutMs;
  #nonceFactory;
  #closed = false;
  #sockets = new Set();
  #pending = new Set();

  constructor({ pipeId, key, timeoutMs = 5000, nonceFactory = () => randomBytes(32).toString('hex') } = {}) {
    this.#pipePath = validatePipeId(pipeId);
    this.#key = validateKey(key);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
      this.#key.fill(0);
      throw new TypeError('The local bridge deadline must be between 100 and 30000 milliseconds.');
    }
    if (typeof nonceFactory !== 'function') {
      this.#key.fill(0);
      throw new TypeError('The local bridge nonce provider is invalid.');
    }
    this.#timeoutMs = timeoutMs;
    this.#nonceFactory = nonceFactory;
  }

  async status({ offset = 0, limit = 16, signal } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 24) {
      throw genericError('invalid_request', 'The status request is invalid.');
    }
    const payload = await this.#request({ op: 'status', offset, limit }, { signal });
    if (Object.keys(payload).sort().join(',') !== 'grants,nextOffset,ok,total,unlocked' ||
        typeof payload.unlocked !== 'boolean' || !Array.isArray(payload.grants) ||
        payload.grants.length > limit || !Number.isSafeInteger(payload.total) || payload.total < 0 || payload.total > 1000 ||
        (payload.nextOffset !== null && (!Number.isSafeInteger(payload.nextOffset) || payload.nextOffset < 0 || payload.nextOffset > 1000))) {
      throw genericError('authentication', 'The local credential bridge response failed authentication.');
    }
    const grantKeys = 'capabilityId,connectorId,expiresAt,fieldLabel,header,id,itemName,maxUses,methods,origin,pathPrefix,prefix,revoked,taskId,uses';
    for (const grant of payload.grants) {
      if (!isPlainObject(grant) || Object.keys(grant).sort().join(',') !== grantKeys ||
          typeof grant.id !== 'string' || !/^[0-9a-f]{32}$/.test(grant.id) ||
          typeof grant.itemName !== 'string' || grant.itemName.length > 128 ||
          typeof grant.fieldLabel !== 'string' || grant.fieldLabel.length > 128 ||
          typeof grant.connectorId !== 'string' || grant.connectorId.length > 63 ||
          typeof grant.capabilityId !== 'string' || grant.capabilityId.length > 63 ||
          typeof grant.taskId !== 'string' || grant.taskId.length > 128 ||
          typeof grant.origin !== 'string' || grant.origin.length > 300 ||
          typeof grant.pathPrefix !== 'string' || grant.pathPrefix.length > 500 || !Array.isArray(grant.methods) ||
          grant.methods.length > 5 || grant.methods.some((method) => typeof method !== 'string' || method.length > 12) ||
          typeof grant.header !== 'string' || grant.header.length > 88 ||
          typeof grant.prefix !== 'string' || grant.prefix.length > 64 || /[\x00-\x1f\x7f]/.test(grant.prefix) ||
          typeof grant.revoked !== 'boolean') {
        throw genericError('authentication', 'The local credential bridge response failed authentication.');
      }
      for (const key of ['expiresAt', 'maxUses', 'uses']) {
        if (grant[key] !== null && (!Number.isSafeInteger(grant[key]) || grant[key] < 0)) {
          throw genericError('authentication', 'The local credential bridge response failed authentication.');
        }
      }
    }
    if (!payload.unlocked && (payload.grants.length !== 0 || payload.total !== 0 || payload.nextOffset !== null)) {
      throw genericError('authentication', 'The local credential bridge response failed authentication.');
    }
    if (payload.unlocked) {
      const pageEnd = offset + payload.grants.length;
      if ((payload.nextOffset === null && pageEnd < payload.total) ||
          (payload.nextOffset !== null && (payload.nextOffset !== pageEnd || payload.nextOffset >= payload.total)) ||
          (payload.grants.length === 0 && payload.nextOffset !== null) || offset > payload.total || pageEnd > payload.total) {
        throw genericError('authentication', 'The local credential bridge response failed authentication.');
      }
    }
    return {
      unlocked: payload.unlocked,
      grants: payload.grants,
      total: payload.total,
      nextOffset: payload.nextOffset,
    };
  }

  async consume(request, options = {}) {
    const submitted = validateConsumeRequest(request);
    const expectedOrigin = canonicalHttpsOrigin(submitted.origin);
    const payload = await this.#request({ op: 'consume', ...submitted }, options);
    const receiptKeys = 'capabilityId,connectorId,grantId,method,origin,requestId,status,taskId,usedAt';
    if (Object.keys(payload).sort().join(',') !== 'ok,receipt,value' ||
        typeof payload.value !== 'string' || payload.value.length < 1 ||
        Buffer.byteLength(payload.value, 'utf8') > 48 * 1024 || !isPlainObject(payload.receipt) ||
        Object.keys(payload.receipt).sort().join(',') !== receiptKeys ||
        payload.receipt.status !== 'authorized' || !Number.isSafeInteger(payload.receipt.usedAt) || payload.receipt.usedAt < 0) {
      throw genericError('authentication', 'The local credential bridge response failed authentication.');
    }
    for (const field of ['capabilityId', 'connectorId', 'grantId', 'method', 'origin', 'requestId', 'taskId']) {
      if (typeof payload.receipt[field] !== 'string') {
        throw genericError('authentication', 'The local credential bridge response failed authentication.');
      }
    }
    if (payload.receipt.grantId !== submitted.grantId ||
        payload.receipt.requestId !== submitted.requestId ||
        payload.receipt.connectorId !== submitted.connectorId ||
        payload.receipt.capabilityId !== submitted.capabilityId ||
        payload.receipt.taskId !== submitted.taskId ||
        payload.receipt.method !== submitted.method.toUpperCase() ||
        payload.receipt.origin !== expectedOrigin) {
      throw genericError('authentication', 'The local credential bridge response failed authentication.');
    }
    return { value: payload.value, receipt: payload.receipt };
  }

  async requestCapture(request, options = {}) {
    const submitted = validateHexiKeysCaptureRequest(request);
    const payload = await this.#request({ op: 'request-new-item', ...submitted }, options);
    if (Object.keys(payload).sort().join(',') !== 'ok,opened' || payload.opened !== true) throw genericError('authentication', 'The protected capture response failed authentication.');
    return { opened: true };
  }

  async close() {
    if (!this.#closed) {
      this.#closed = true;
      this.#key.fill(0);
      for (const socket of this.#sockets) socket.destroy();
    }
    await Promise.allSettled([...this.#pending]);
    this.#key.fill(0);
  }

  // A timeout may follow durable use recording. The host must surface the
  // ambiguous result and must not transparently retry with a new requestId.
  async #request(payload, { signal } = {}) {
    if (this.#closed) throw genericError('closed');
    if (signal?.aborted) throw genericError('aborted', 'The local credential request was cancelled.');
    let nonce;
    try {
      nonce = this.#nonceFactory();
    } catch {
      throw genericError('unavailable');
    }
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
      throw genericError('invalid_nonce', 'The local credential request is invalid.');
    }
    let payloadBytes;
    try {
      payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    } catch {
      throw genericError('invalid_request', 'The credential request is invalid.');
    }
    const payloadB64 = payloadBytes.toString('base64');
    const mac = createHmac('sha256', this.#key)
      .update(macInput('req', nonce, payloadB64), 'utf8')
      .digest('hex');
    const body = Buffer.from(JSON.stringify({ v: 1, nonce, payload: payloadB64, mac }), 'utf8');
    if (body.length > MAX_HEXKEYS_BRIDGE_FRAME_BYTES) {
      throw genericError('oversize', 'The local credential request is too large.');
    }
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);

    let requestPromise;
    requestPromise = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.#pipePath);
      this.#sockets.add(socket);
      let settled = false;
      let responseLength = null;
      let responseBuffer = Buffer.alloc(0);
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#sockets.delete(socket);
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          socket.end();
          resolve(value);
        }
      };
      const onAbort = () => finish(genericError('aborted', 'The local credential request was cancelled.'));
      timer = setTimeout(() => finish(genericError('timeout')), this.#timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.once('connect', () => {
        if (this.#closed || signal?.aborted) return onAbort();
        socket.write(frame);
      });
      socket.on('data', (chunk) => {
        if (settled) return;
        if (responseBuffer.length + chunk.length > MAX_HEXKEYS_BRIDGE_FRAME_BYTES + 4) {
          return finish(genericError('oversize', 'The local credential bridge response is too large.'));
        }
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
        if (responseLength === null && responseBuffer.length >= 4) {
          responseLength = responseBuffer.readUInt32BE(0);
          if (responseLength < 1 || responseLength > MAX_HEXKEYS_BRIDGE_FRAME_BYTES) {
            return finish(genericError('oversize', 'The local credential bridge response is too large.'));
          }
        }
        if (responseLength !== null && responseBuffer.length >= responseLength + 4) {
          if (responseBuffer.length !== responseLength + 4) {
            return finish(genericError('authentication', 'The local credential bridge response failed authentication.'));
          }
          try {
            finish(null, parseAuthenticatedResponse(responseBuffer.subarray(4), this.#key, nonce));
          } catch (error) {
            finish(error?.name === 'HexiKeysBridgeError' ? error : genericError('authentication', 'The local credential bridge response failed authentication.'));
          }
        }
      });
      socket.once('error', () => finish(genericError('transport')));
      socket.once('close', () => {
        if (!settled) finish(genericError('transport'));
      });
    });
    this.#pending.add(requestPromise);
    try {
      return await requestPromise;
    } finally {
      this.#pending.delete(requestPromise);
    }
  }
}

export function createHexiKeysBridgeClient(options) {
  return new HexiKeysBridgeClient(options);
}
