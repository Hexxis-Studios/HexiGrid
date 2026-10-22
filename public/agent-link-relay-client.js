const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONTEXT = 'hexigrid-agent-relay-v1';

function b64url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromB64url(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hash(value) { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
async function keyFor(secretHash) { return crypto.subtle.importKey('raw', await hash(`${CONTEXT}\n${secretHash}`), 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function secretDigest(secret) { return b64url(await hash(String(secret))); }
async function proofId(label, value) { return (await secretDigest(`${label}\n${value}`)).slice(0, 16); }
async function envelopeProof(envelope) { return proofId('envelope', JSON.stringify(envelope)); }

async function encrypt(secretHash, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, await keyFor(secretHash), encoder.encode(JSON.stringify(value))));
  return { v: 1, iv: b64url(iv), data: b64url(sealed.slice(0, -16)), tag: b64url(sealed.slice(-16)) };
}

async function decrypt(secretHash, envelope) {
  const ciphertext = fromB64url(envelope.data); const tag = fromB64url(envelope.tag);
  const sealed = new Uint8Array(ciphertext.length + tag.length); sealed.set(ciphertext); sealed.set(tag, ciphertext.length);
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(envelope.iv), tagLength: 128 }, await keyFor(secretHash), sealed);
  return JSON.parse(decoder.decode(clear));
}

export class AgentRelayClient extends EventTarget {
  constructor({ deviceId, inviteId, inviteSecret }) {
    super();
    this.deviceId = deviceId; this.inviteId = inviteId; this.inviteSecret = inviteSecret;
    const requestedChannel = new URLSearchParams(location.search).get('transport');
    this.relayChannel = requestedChannel === 'companion' ? 'companion' : 'browser';
    this.peer = null; this.channel = null; this.transport = this.relayChannel === 'companion' ? 'outbound-https' : 'https'; this.relaySession = null; this.closed = false;
    this.requestedTransport = requestedChannel === 'webrtc' && this.relayChannel === 'browser' ? 'webrtc' : 'https';
    this.pending = new Map(); this.chunks = new Map(); this.secretHash = null; this.link = null;
    this.proofLog = [];
  }

  recordProof(event, detail = {}) {
    const entry = { at: new Date().toISOString(), event, transport: this.transport, ...detail };
    this.proofLog.push(entry); this.proofLog = this.proofLog.slice(-40);
    console.info('[HexiGrid relay proof]', entry);
    this.dispatchEvent(new CustomEvent('proof', { detail: entry }));
  }

  async connect() {
    this.secretHash = await secretDigest(this.inviteSecret);
    this.relaySession = await this.openSession();
    this.recordProof('relay-session-open', { peer: this.relaySession.peerId.slice(0, 13) });
    void this.pollLoop();
    // A request and its encrypted response must stay on one ordered transport.
    // HTTPS is the public default because it works through restrictive agent
    // networks; WebRTC remains an explicit development/optimization path.
    if (this.requestedTransport === 'webrtc') void this.startWebRtc();
  }

  async openSession() {
    // The browser channel remains available at /relay/v1/browser/open, while
    // outbound companions use the same contract under /relay/v1/companion.
    // Browser polling continues through /relay/v1/browser/poll.
    // The legacy browser transport = 'https' remains the default for old links.
    // Compatibility expression: requestedTransport === 'webrtc' ? 'webrtc' : 'https'.
    const body = { deviceId: this.deviceId, inviteId: this.inviteId };
    if (this.link?.connectionId && this.link?.tokenHash) { body.connectionId = this.link.connectionId; body.linkTokenHash = this.link.tokenHash; }
    const response = await fetch(`/relay/v1/${this.relayChannel}/open`, { method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    const session = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(session.error || 'The public relay could not connect to the owner device.'), { status: response.status });
    return session;
  }

  async pollLoop() {
    let failures = 0;
    while (!this.closed && this.relaySession) {
      try {
        const response = await fetch(`/relay/v1/${this.relayChannel}/poll?peer=${encodeURIComponent(this.relaySession.peerId)}`, { cache: 'no-store', credentials: 'omit', headers: { accept: 'application/json', authorization: `Bearer ${this.relaySession.token}` } });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'The secure HTTPS relay session ended.');
        failures = 0;
        for (const message of body.messages || []) await this.receive(message);
      } catch (error) {
        failures += 1;
        this.recordProof('relay-retry', { failures, reason: error.message });
        if (this.channel?.readyState !== 'open') {
          try {
            const previousPeer = this.relaySession?.peerId;
            this.relaySession = await this.openSession();
            this.recordProof('relay-session-reopened', { previousPeer: previousPeer?.slice(0, 13), peer: this.relaySession.peerId.slice(0, 13) });
            failures = 0;
          } catch (reopenError) {
            this.recordProof('relay-reopen-wait', { reason: reopenError.message });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(15000, 500 * (2 ** Math.min(5, failures))) + Math.round(Math.random() * 250)));
      }
    }
  }

  async sendRelayMessage(message) {
    if (!this.relaySession) throw new Error('The secure HTTPS relay is disconnected.');
    const response = await fetch(`/relay/v1/${this.relayChannel}/send`, { method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.relaySession.token}` }, body: JSON.stringify({ peerId: this.relaySession.peerId, message }) });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw Object.assign(new Error(body.error || 'The secure HTTPS relay is disconnected.'), { status: response.status }); }
  }

  async startWebRtc() {
    if (!globalThis.RTCPeerConnection) return;
    try {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      const channel = peer.createDataChannel('hexigrid-agent-link', { ordered: true });
      channel.addEventListener('open', () => { this.peer = peer; this.channel = channel; this.transport = 'webrtc'; this.dispatchEvent(new CustomEvent('transport', { detail: 'webrtc' })); });
      channel.addEventListener('message', (event) => this.receive(JSON.parse(event.data)));
      channel.addEventListener('close', () => { this.channel = null; this.transport = 'relay'; });
      await peer.setLocalDescription(await peer.createOffer());
      await this.waitForIce(peer);
      await this.sendRelayMessage({ type: 'signal', description: peer.localDescription });
      this.peer = peer;
    } catch { this.transport = 'relay'; }
  }

  waitForIce(peer) {
    if (peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
    });
  }

  async receive(message) {
    if (message.type === 'signal' && message.description?.type === 'answer') { try { await this.peer?.setRemoteDescription(message.description); } catch {} return; }
    if (message.type === 'transport') { if (message.transport === 'relay' && !this.channel) this.transport = 'relay'; return; }
    if (message.type === 'revoked' && message.connectionId === this.link?.connectionId) { this.failAll('The owner revoked this agent connection.'); return; }
    if (message.type === 'chunk') return this.receiveChunk(message);
    if (message.type !== 'relay') return;
    await this.finishResponse(message.payload);
  }

  receiveChunk(message) {
    const current = this.chunks.get(message.id) || { parts: new Array(message.total), received: 0 };
    if (!current.parts[message.index]) { current.parts[message.index] = message.data; current.received += 1; }
    this.chunks.set(message.id, current);
    if (current.received === message.total) { this.chunks.delete(message.id); this.finishResponse(JSON.parse(current.parts.join(''))); }
  }

  async finishResponse(payload) {
    const pending = this.pending.get(payload.requestId); if (!pending) return;
    const request = payload.requestId.slice(0, 8);
    try {
      const expectedKeyId = await proofId('key', pending.key);
      const receivedEnvelope = await envelopeProof(payload.envelope);
      if (payload.proof?.keyId !== expectedKeyId) throw new Error(`response key mismatch (${expectedKeyId}/${payload.proof?.keyId || 'missing'})`);
      if (payload.proof?.envelope !== receivedEnvelope) throw new Error(`response payload mismatch (${receivedEnvelope}/${payload.proof?.envelope || 'missing'})`);
      const value = await decrypt(pending.key, payload.envelope);
      this.recordProof('response-authenticated', { phase: pending.phase, request, keyId: expectedKeyId, envelope: receivedEnvelope, status: value.status });
      pending.resolve(value);
    } catch (error) {
      this.recordProof('response-authentication-failed', { phase: pending.phase, request, reason: error.message });
      pending.reject(new Error('The encrypted relay response could not be authenticated.'));
    }
    finally { this.pending.delete(payload.requestId); }
  }

  async sendPayload(payload) {
    const serialized = JSON.stringify(payload);
    const send = async (message) => {
      if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(message));
      else await this.sendRelayMessage(message);
    };
    if (serialized.length <= 48000) return await send({ type: 'relay', payload });
    const id = `chunk-${crypto.randomUUID()}`; const parts = serialized.match(/[\s\S]{1,48000}/g) || [];
    for (const [index, data] of parts.entries()) await send({ type: 'chunk', id, index, total: parts.length, data });
  }

  async request({ phase, key, connectionId = null, method, pathname, headers = {}, body = null }) {
    const requestId = crypto.randomUUID();
    const payload = { requestId, phase, inviteId: this.inviteId, connectionId, envelope: await encrypt(key, { method, pathname, headers, body }) };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('The owner device did not answer in time.')); }, 20000);
      this.pending.set(requestId, { key, phase, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
    try { await this.sendPayload(payload); this.recordProof('request-sent', { phase, request: requestId.slice(0, 8) }); }
    catch (error) { this.pending.delete(requestId); throw error; }
    return promise;
  }

  async pair(body) {
    const response = await this.request({ phase: 'pair', key: this.secretHash, method: 'POST', pathname: '/agent-link/v1/pair', headers: { 'content-type': 'application/json', accept: 'application/json' }, body });
    if (response.status >= 400) throw Object.assign(new Error(response.body?.error || 'Pairing failed.'), { status: response.status });
    if (!/^[A-Za-z0-9_-]{43}$/.test(response.body.relayResponseKey || '')) throw new Error('The relay response key is missing from the encrypted pairing response.');
    this.link = { connectionId: response.body.connection.id, tokenHash: response.body.relayResponseKey };
    delete response.body.relayResponseKey;
    return response.body;
  }

  async fetch(pathname, init = {}) {
    if (!this.link) throw new Error('This browser is not paired.');
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const body = init.body ? JSON.parse(init.body) : null;
    const response = await this.request({ phase: 'link', key: this.link.tokenHash, connectionId: this.link.connectionId, method: init.method || 'GET', pathname, headers, body });
    return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.body };
  }

  close() {
    const session = this.relaySession;
    if (session) void fetch(`/relay/v1/${this.relayChannel}/close`, { method: 'POST', keepalive: true, credentials: 'omit', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` }, body: JSON.stringify({ peerId: session.peerId }) }).catch(() => {});
    this.failAll('The browser tab closed.');
  }

  failAll(message) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear(); this.relaySession = null; this.channel?.close(); this.peer?.close();
    this.dispatchEvent(new CustomEvent('closed', { detail: message }));
  }
}
