import crypto from 'node:crypto';
import { companionRetryDelay, defaultCompanionState, markCompanionClosed, markCompanionConnected, markCompanionConnecting, markCompanionFailure, markCompanionHeartbeat } from './companion-connection.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONTEXT = 'hexigrid-agent-relay-v1';
const MAX_ENVELOPE = 12 * 1024 * 1024;
const CHUNK_SIZE = 48_000;
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TERMINAL_CODES = new Set(['connection_revoked', 'device_mismatch', 'relay_device_mismatch']);
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_EVENT_WAIT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

function b64url(bytes) { return Buffer.from(bytes).toString('base64url'); }
function fromB64url(value) { return new Uint8Array(Buffer.from(String(value), 'base64url')); }
async function sha256(value) { return new Uint8Array(await crypto.webcrypto.subtle.digest('SHA-256', encoder.encode(String(value)))); }
async function digest(value) { return b64url(await sha256(value)); }
async function proofId(label, value) { return (await digest(`${label}\n${value}`)).slice(0, 16); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function keyFor(secretHash) {
  return crypto.webcrypto.subtle.importKey('raw', await sha256(`${CONTEXT}\n${secretHash}`), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(secretHash, value) {
  const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, await keyFor(secretHash), encoder.encode(JSON.stringify(value))));
  return { v: 1, iv: b64url(iv), data: b64url(sealed.slice(0, -16)), tag: b64url(sealed.slice(-16)) };
}

async function decrypt(secretHash, envelope) {
  if (envelope?.v !== 1 || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string' || typeof envelope.tag !== 'string') throw new Error('The encrypted relay response is invalid.');
  const ciphertext = fromB64url(envelope.data); const tag = fromB64url(envelope.tag);
  if (ciphertext.length > MAX_ENVELOPE || tag.length !== 16) throw new Error('The encrypted relay response is invalid.');
  const sealed = new Uint8Array(ciphertext.length + tag.length); sealed.set(ciphertext); sealed.set(tag, ciphertext.length);
  const clear = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(envelope.iv), tagLength: 128 }, await keyFor(secretHash), sealed);
  return JSON.parse(decoder.decode(clear));
}

export function parseCompanionInvitation(value) {
  const parsed = new URL(String(value));
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('The companion invitation must use HTTPS except on this computer.');
  const inviteId = parsed.searchParams.get('invite') || '';
  const deviceId = parsed.searchParams.get('device') || '';
  const inviteSecret = new URLSearchParams(parsed.hash.slice(1)).get('secret') || '';
  if (!inviteId || !inviteSecret || !deviceId) throw new Error('The companion invitation is incomplete.');
  return { origin: `${parsed.protocol}//${parsed.host}`, inviteId, deviceId, inviteSecret };
}

export function normalizeCompanionRelayOrigin(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch { throw new Error('Use the relay origin or its companion endpoint.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || !['/', '/relay/v1/companion', '/relay/v1/companion/'].includes(parsed.pathname)) {
    throw new Error('Use the HTTPS relay origin or its companion endpoint, without credentials or query parameters.');
  }
  return parsed.origin;
}

export function signatureFor({ token, method, pathname, timestamp, nonce, body = null }) {
  const bodyDigest = crypto.createHash('sha256').update(stable(body)).digest('base64url');
  return crypto.createHmac('sha256', String(token)).update(`${String(method).toUpperCase()}\n${pathname}\n${timestamp}\n${nonce}\n${bodyDigest}`).digest('base64url');
}

export class OutboundCompanionConnection extends EventTarget {
  constructor({ inviteUrl, resume = null, identity = {}, capabilities = [], fetchFn = globalThis.fetch, now = () => new Date(), random = Math.random, sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), heartbeatMs = DEFAULT_HEARTBEAT_MS, eventWaitMs = DEFAULT_EVENT_WAIT_MS, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, automaticControl = true, onEvent = null } = {}) {
    super();
    this.invitation = inviteUrl ? parseCompanionInvitation(inviteUrl) : {
      origin: normalizeCompanionRelayOrigin(resume?.origin), inviteId: String(resume?.inviteId || ''), deviceId: String(resume?.deviceId || ''), inviteSecret: ''
    };
    if (!this.invitation.origin || !this.invitation.inviteId || !this.invitation.deviceId) throw new Error('The outbound companion needs its relay origin, invitation ID, and device ID.');
    this.resume = resume && typeof resume === 'object' ? { ...resume } : null;
    this.identity = identity;
    this.capabilities = capabilities;
    this.fetchFn = fetchFn;
    this.now = now;
    this.random = random;
    this.sleepFn = sleepFn;
    this.heartbeatMs = Math.max(1_000, Math.min(30_000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS));
    this.eventWaitMs = Math.max(1_000, Math.min(20_000, Number(eventWaitMs) || DEFAULT_EVENT_WAIT_MS));
    this.requestTimeoutMs = Math.max(50, Math.min(120_000, Number(requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS));
    this.automaticControl = automaticControl !== false;
    this.onEvent = onEvent;
    this.clientDeviceId = String(resume?.clientDeviceId || `companion-device-${crypto.randomUUID()}`).slice(0, 160);
    this.state = defaultCompanionState();
    this.state.lastSequence = Math.max(0, Number(resume?.lastSequence) || 0);
    // A previous process may have saved its cursor but exited before its ACK
    // reached the owner. Reconfirm the durable cursor after reconnecting.
    this.pendingEventAck = this.state.lastSequence > 0;
    this.state.lastAudioSequence = Math.max(0, Number(resume?.lastAudioSequence) || 0);
    this.state.lastSpeakerSequence = Math.max(0, Number(resume?.lastSpeakerSequence) || 0);
    this.session = null;
    this.secretHash = null;
    this.link = null;
    this.closed = false;
    this.pending = new Map();
    this.chunks = new Map();
    this.pollPromise = null;
    this.pollController = null;
    this.heartbeatPromise = null;
    this.eventPromise = null;
  }

  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  async connect() {
    if (this.closed) throw new Error('The companion connection is closed.');
    this.state = markCompanionConnecting(this.state);
    if (this.resume?.connectionId && this.resume?.tokenHash) {
      this.link = { connectionId: this.resume.connectionId, token: this.resume.token || '', tokenHash: this.resume.tokenHash };
    } else if (this.resume?.connectionId && this.resume?.token) {
      this.link = { connectionId: this.resume.connectionId, token: this.resume.token, tokenHash: await digest(this.resume.token) };
    } else {
      this.secretHash = await digest(this.invitation.inviteSecret);
    }
    this.session = await this.openSession();
    this.state = markCompanionConnected(this.state, this.now().toISOString());
    this.emit('state', { ...this.state });
    this.pollPromise = this.pollLoop();
    this.startControlLoops();
    return { ...this.session };
  }

  async openSession() {
    const response = await this.fetchFn(`${this.invitation.origin}/relay/v1/companion/open`, {
      method: 'POST', signal: AbortSignal.timeout(this.requestTimeoutMs), headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ deviceId: this.invitation.deviceId, inviteId: this.invitation.inviteId, clientDeviceId: this.clientDeviceId, ...(this.link?.connectionId && this.link?.tokenHash ? { connectionId: this.link.connectionId, linkTokenHash: this.link.tokenHash } : {}) })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || 'The outbound companion relay could not connect.'), { status: response.status, code: body.code || '' });
    return body;
  }

  async pollLoop() {
    let failures = 0;
    while (!this.closed && this.session) {
      const controller = new AbortController(); this.pollController = controller;
      try {
        const response = await this.fetchFn(`${this.invitation.origin}/relay/v1/companion/poll?peer=${encodeURIComponent(this.session.peerId)}`, { signal: controller.signal, headers: { accept: 'application/json', authorization: `Bearer ${this.session.token}` } });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(body.error || 'The outbound companion session ended.'), { status: response.status, code: body.code || '' });
        failures = 0;
        for (const message of body.messages || []) await this.receive(message);
      } catch (error) {
        if (this.pollController === controller) this.pollController = null;
        if (this.closed) break;
        if (TERMINAL_CODES.has(error.code)) { this.close(error.message); break; }
        failures += 1;
        this.state = markCompanionFailure(this.state, error, this.now().toISOString());
        this.emit('state', { ...this.state });
        const delayMs = companionRetryDelay(failures, this.random);
        this.emit('retry', { attempt: failures, delayMs, reason: error.message });
        await this.sleepFn(delayMs);
        if (this.closed) break;
        try {
          const previousPeer = this.session?.peerId;
          this.state = markCompanionConnecting(this.state, { reconnect: true });
          this.session = await this.openSession();
          this.state = markCompanionConnected(this.state, this.now().toISOString());
          this.emit('reconnected', { previousPeer, peerId: this.session.peerId, state: { ...this.state } });
          failures = 0;
        } catch (reopenError) {
          if (TERMINAL_CODES.has(reopenError.code)) { await this.close(reopenError.message); break; }
          this.state = markCompanionFailure(this.state, reopenError, this.now().toISOString());
          this.emit('state', { ...this.state });
        }
      } finally {
        if (this.pollController === controller) this.pollController = null;
      }
    }
  }

  async sendHttp(message, attempt = 0) {
    if (!this.session) throw new Error('The outbound companion is disconnected.');
    const response = await this.fetchFn(`${this.invitation.origin}/relay/v1/companion/send`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.session.token}` },
      body: JSON.stringify({ peerId: this.session.peerId, message })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if ([401, 403, 410].includes(response.status) && this.link && attempt < 1) {
        this.session = await this.openSession();
        return this.sendHttp(message, attempt + 1);
      }
      if (TRANSIENT_STATUS.has(response.status) && attempt < 3) {
        await this.sleepFn(companionRetryDelay(attempt + 1, this.random));
        return this.sendHttp(message, attempt + 1);
      }
      throw Object.assign(new Error(body.error || 'The outbound companion relay rejected a message.'), { status: response.status, code: body.code || '' });
    }
    return body;
  }

  async sendPayload(payload, queueClass = 'control') {
    const serialized = JSON.stringify(payload);
    if (serialized.length <= CHUNK_SIZE) return this.sendHttp({ type: 'relay', payload, queueClass });
    const id = `chunk-${crypto.randomUUID()}`;
    const parts = serialized.match(new RegExp(`[\\s\\S]{1,${CHUNK_SIZE}}`, 'g')) || [];
    for (const [index, data] of parts.entries()) await this.sendHttp({ type: 'chunk', id, index, total: parts.length, data, queueClass });
  }

  async receive(message) {
    if (message.type === 'revoked' && message.connectionId === this.link?.connectionId) return this.close('The owner revoked this agent connection.');
    if (message.type === 'chunk') return this.receiveChunk(message);
    if (message.type === 'relay') return this.finishResponse(message.payload);
  }

  receiveChunk(message) {
    if (!Number.isInteger(message.index) || !Number.isInteger(message.total) || message.total < 1 || message.total > 512 || message.index < 0 || message.index >= message.total || typeof message.data !== 'string') return;
    const current = this.chunks.get(message.id) || { parts: new Array(message.total), received: 0 };
    if (!current.parts[message.index]) { current.parts[message.index] = message.data; current.received += 1; }
    this.chunks.set(message.id, current);
    if (current.received === message.total) {
      this.chunks.delete(message.id);
      try { void this.finishResponse(JSON.parse(current.parts.join(''))); } catch { /* fail closed */ }
    }
  }

  async finishResponse(payload) {
    const pending = this.pending.get(payload?.requestId); if (!pending) return;
    try {
      const expectedKeyId = await proofId('key', pending.key);
      const receivedEnvelope = await proofId('envelope', JSON.stringify(payload.envelope));
      if (payload.proof?.keyId !== expectedKeyId || payload.proof?.envelope !== receivedEnvelope) throw new Error('The companion response proof did not match.');
      pending.resolve(await decrypt(pending.key, payload.envelope));
    } catch (error) { pending.reject(new Error(`The encrypted companion response could not be authenticated: ${error.message}`)); }
    finally { this.pending.delete(payload.requestId); }
  }

  async request({ phase, key, connectionId = null, method, pathname, headers = {}, body = null }) {
    if (this.closed) throw new Error('The outbound companion is closed.');
    const requestId = crypto.randomUUID();
    const payload = { requestId, phase, inviteId: this.invitation.inviteId, connectionId, envelope: await encrypt(key, { method, pathname, headers, body }) };
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('The owner device did not answer in time.')); }, this.requestTimeoutMs);
      this.pending.set(requestId, { key, cancel: () => clearTimeout(timer), resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
    // A relay send can itself stall while the response timer expires. Attach a
    // handler immediately so that timeout can never become an unhandled
    // rejection before the send path settles and returns control to the caller.
    void responsePromise.catch(() => {});
    const queueClass = /^\/agent-link\/v1\/desktop\/(?:media|speaker)$/.test(pathname) ? 'media' : 'control';
    void this.sendPayload(payload, queueClass).catch((error) => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      pending.reject(error);
    });
    return responsePromise;
  }

  async pair({ name = this.identity?.name || 'Outbound companion', framework = 'external-agent', externalId = '', version = 'companion-1' } = {}) {
    const result = await this.request({ phase: 'pair', key: this.secretHash, method: 'POST', pathname: '/agent-link/v1/pair', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: { inviteId: this.invitation.inviteId, secret: this.invitation.inviteSecret, clientDeviceId: this.clientDeviceId, identity: { name, framework, externalId, version }, capabilities: this.capabilities } });
    if (result.status >= 400) throw Object.assign(new Error(result.body?.error || 'Agent pairing failed.'), { status: result.status });
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.body?.relayResponseKey || '')) throw new Error('The encrypted pairing response did not include a link key.');
    this.link = { connectionId: result.body.connection.id, token: result.body.token, tokenHash: result.body.relayResponseKey };
    delete result.body.relayResponseKey;
    this.startControlLoops();
    return result.body;
  }

  async linkRequest(pathname, { method = 'GET', body = null, headers = {} } = {}) {
    if (!this.link) throw new Error('The outbound companion is not paired.');
    const stamp = this.now().toISOString(); const nonce = crypto.randomUUID();
    const signedHeaders = { accept: 'application/json', ...headers, authorization: `Bearer ${this.link.token}`, 'x-hexigrid-timestamp': stamp, 'x-hexigrid-nonce': nonce, 'x-hexigrid-signature': signatureFor({ token: this.link.token, method, pathname, timestamp: stamp, nonce, body }) };
    const response = await this.request({ phase: 'link', key: this.link.tokenHash, connectionId: this.link.connectionId, method, pathname, headers: signedHeaders, body });
    return { ok: response.status >= 200 && response.status < 300, status: response.status, body: response.body };
  }

  async heartbeat({ afterAudioSequence = this.state.lastAudioSequence, afterSpeakerSequence = this.state.lastSpeakerSequence } = {}) {
    const result = await this.linkRequest('/agent-link/v1/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { transport: 'outbound-https', clientDeviceId: this.clientDeviceId, afterAudioSequence, afterSpeakerSequence } });
    if (result.ok) {
      this.state = markCompanionHeartbeat(this.state, { lastAudioSequence: afterAudioSequence, lastSpeakerSequence: afterSpeakerSequence, at: this.now().toISOString() });
      this.emit('state', { ...this.state });
    }
    return result;
  }

  startControlLoops() {
    if (!this.automaticControl || !this.link || this.closed) return;
    if (!this.heartbeatPromise) this.heartbeatPromise = this.heartbeatLoop()
      .catch((error) => { if (!this.closed) this.emit('control-loop-error', { loop: 'heartbeat', reason: error.message }); })
      .finally(() => { this.heartbeatPromise = null; });
    if (!this.eventPromise) this.eventPromise = this.eventLoop()
      .catch((error) => { if (!this.closed) this.emit('control-loop-error', { loop: 'events', reason: error.message }); })
      .finally(() => { this.eventPromise = null; });
  }

  async heartbeatLoop() {
    while (!this.closed && this.link) {
      try {
        const result = await this.heartbeat();
        if (!result.ok && TERMINAL_CODES.has(result.body?.code)) return this.close(result.body.error || 'The connection is no longer authorized.');
      } catch (error) {
        if (TERMINAL_CODES.has(error.code)) return this.close(error.message);
        this.emit('heartbeat-missed', { reason: error.message, at: this.now().toISOString() });
      }
      await this.sleepFn(this.heartbeatMs);
    }
  }

  async pollEvents({ waitMs = this.eventWaitMs, limit = 50 } = {}) {
    const result = await this.linkRequest('/agent-link/v1/events/poll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: { after: this.state.lastSequence, waitMs: Math.max(0, Math.min(20_000, Number(waitMs) || 0)) }
    });
    if (!result.ok) return result;
    const events = [...(result.body?.events || [])].filter((event) => Number(event.sequence) > this.state.lastSequence).sort((left, right) => left.sequence - right.sequence).slice(0, Math.max(1, Math.min(50, Math.floor(Number(limit) || 50))));
    for (const event of events) {
      if (event.sequence !== this.state.lastSequence + 1) this.emit('sequence-gap', { expected: this.state.lastSequence + 1, received: event.sequence });
      // A durable consumer must finish before the cursor advances or the owner
      // acknowledges this event. A failed write is retried on the next poll.
      if (this.onEvent) await this.onEvent({ ...event });
      this.state = markCompanionHeartbeat(this.state, { lastSequence: event.sequence });
      this.pendingEventAck = true;
      this.emit('event', { ...event });
    }
    if (this.pendingEventAck) {
      const acknowledged = await this.linkRequest('/agent-link/v1/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { through: this.state.lastSequence } });
      if (!acknowledged.ok) return acknowledged;
      this.pendingEventAck = false;
    }
    return { ...result, events };
  }

  async eventLoop() {
    let failures = 0;
    while (!this.closed && this.link) {
      try {
        const result = await this.pollEvents();
        if (!result.ok && TERMINAL_CODES.has(result.body?.code)) return this.close(result.body.error || 'The connection is no longer authorized.');
        failures = 0;
      } catch (error) {
        if (this.closed) break;
        if (TERMINAL_CODES.has(error.code)) return this.close(error.message);
        failures += 1;
        const delayMs = companionRetryDelay(failures, this.random);
        this.emit('event-retry', { attempt: failures, delayMs, reason: error.message });
        await this.sleepFn(delayMs);
      }
    }
  }

  resumeRecord() {
    if (!this.link) return null;
    return {
      origin: this.invitation.origin, inviteId: this.invitation.inviteId, deviceId: this.invitation.deviceId,
      clientDeviceId: this.clientDeviceId, connectionId: this.link.connectionId, token: this.link.token,
      tokenHash: this.link.tokenHash, lastSequence: this.state.lastSequence,
      lastAudioSequence: this.state.lastAudioSequence, lastSpeakerSequence: this.state.lastSpeakerSequence
    };
  }

  async close(reason = 'The outbound companion closed.') {
    if (this.closed) return;
    this.closed = true;
    this.pollController?.abort(); this.pollController = null;
    const session = this.session;
    this.state = markCompanionClosed(this.state, reason === 'The outbound companion closed.' ? null : reason, this.now().toISOString());
    this.session = null;
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear(); this.chunks.clear();
    if (session) await this.fetchFn(`${this.invitation.origin}/relay/v1/companion/close`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` }, body: JSON.stringify({ peerId: session.peerId }) }).catch(() => {});
    this.emit('closed', { reason, state: { ...this.state } });
  }
}
