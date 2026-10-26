import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import { RTCPeerConnection } from 'werift';
import { QuickTunnel } from './quick-tunnel.mjs';
import { decryptRelayEnvelope, encryptRelayEnvelope } from './agent-relay-crypto.mjs';
import { agentLinkSkillBundle } from './agent-link-skill-bundle.mjs';

const MAX_SOCKET_MESSAGE = 96 * 1024;
const MAX_CONTROL_MESSAGES = 128;
const MAX_MEDIA_MESSAGES = 24;
const MAX_FRAME_QUEUE_MESSAGES = 512;
const MAX_FRAME_QUEUE_BYTES = 24 * 1024 * 1024;
const MAX_DEVICE_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_BROWSER_PEERS = 8;
const HTTPS_PEER_IDLE_MS = 60_000;
const PEER_SWEEP_MS = 15_000;
const ALLOWED_ASSETS = new Map([
  ['/agent-link/connect', ['agent-link-connect.html', 'text/html; charset=utf-8']],
  ['/agent-link-connect.js', ['agent-link-connect.js', 'text/javascript; charset=utf-8']],
  ['/agent-link-actions.js', ['agent-link-actions.js', 'text/javascript; charset=utf-8']],
  ['/agent-link-browser-client.js', ['agent-link-browser-client.js', 'text/javascript; charset=utf-8']],
  ['/agent-link-relay-client.js', ['agent-link-relay-client.js', 'text/javascript; charset=utf-8']],
  ['/agent-link-connect.css', ['agent-link-connect.css', 'text/css; charset=utf-8']],
  ['/agent-link-media.css', ['agent-link-media.css', 'text/css; charset=utf-8']],
  ['/brand-icosahedron.svg', ['brand-icosahedron.svg', 'image/svg+xml']]
]);

const json = (socket, value) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
};

function securityHeaders(contentType = '') {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src data:; style-src 'self'; script-src 'self'; connect-src 'self' wss:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  };
}

function randomId(prefix) { return `${prefix}-${crypto.randomUUID()}`; }

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function relayRoute(pathname) {
  const match = /^\/relay\/v1\/(browser|companion)\/(open|send|close|poll)$/.exec(pathname);
  return match ? { channel: match[1], action: match[2] } : null;
}

export class PublicAgentRelay {
  constructor({ publicDir, skillRoot, projectRoot, targetOrigin, state, tunnel = new QuickTunnel(), listenPort = 0, now = () => Date.now(), onDeviceDisconnect = () => {} } = {}) {
    this.publicDir = publicDir;
    this.skillRoot = skillRoot;
    this.projectRoot = projectRoot;
    this.targetOrigin = targetOrigin;
    this.state = state;
    this.tunnel = tunnel;
    this.listenPort = Math.max(0, Math.min(65535, Number(listenPort) || 0));
    this.now = now;
    this.onDeviceDisconnect = onDeviceDisconnect;
    this.server = null;
    this.wss = null;
    this.deviceSocket = null;
    this.connectorSocket = null;
    this.deviceId = '';
    this.deviceKey = '';
    this.localPort = 0;
    this.invites = new Map();
    this.peers = new Map();
    this.companionMetrics = {
      acceptedOpens: 0, acceptedSends: 0, acceptedPolls: 0, ownerReceived: 0,
      decryptedLinkRequests: 0, ownerApiResponses: 0, linkResponseMessages: 0,
      pollDeliveries: 0, ownerRequestFailures: 0, lastHeartbeatHttpStatus: null,
      lastFailureCategory: null
    };
    this.peerConnections = new Map();
    this.peerChannels = new Map();
    this.peerSweepTimer = null;
    this.error = '';
    this.startedAt = null;
  }

  status() {
    const tunnel = this.tunnel.status();
    return {
      available: tunnel.available,
      running: Boolean(this.server && tunnel.running && this.deviceSocket?.readyState === WebSocket.OPEN),
      starting: Boolean(this.server && (!tunnel.running || this.deviceSocket?.readyState !== WebSocket.OPEN)),
      url: tunnel.url,
      deviceId: this.deviceId || null,
      transport: 'outbound-companion-over-encrypted-https-relay',
      stableAddress: tunnel.stable === true,
      relayProvider: tunnel.provider || 'cloudflare-quick-tunnel',
      companion: {
        available: Boolean(this.server && tunnel.running),
        endpoint: tunnel.url ? `${tunnel.url}/relay/v1/companion` : null,
        reconnect: 'bounded-exponential-backoff',
        resume: 'sequence-numbered-events-and-media',
        diagnostics: {
          activePeers: [...this.peers.values()].filter((peer) => peer.kind === 'https' && peer.channel === 'companion').length,
          ...this.companionMetrics
        }
      },
      encryption: 'aes-256-gcm',
      error: this.error || tunnel.error || '',
      startedAt: this.startedAt
    };
  }

  async start({ provider = 'stable' } = {}) {
    if (this.server) return this.status();
    this.error = '';
    this.startedAt = new Date().toISOString();
    const savedRegistry = this.state.agentRelayRegistry && typeof this.state.agentRelayRegistry === 'object'
      ? this.state.agentRelayRegistry
      : {};
    this.deviceId = /^device-[a-f0-9-]{36}$/i.test(String(savedRegistry.deviceId || ''))
      ? savedRegistry.deviceId
      : randomId('device');
    this.state.agentRelayRegistry = { version: 1, deviceId: this.deviceId, inviteIds: [] };
    this.rebuildInviteRegistry();
    this.deviceKey = crypto.randomBytes(32).toString('base64url');
    try {
      await this.startLocalRelay();
      this.peerSweepTimer = setInterval(() => this.prunePeers(), PEER_SWEEP_MS);
      this.peerSweepTimer.unref?.();
      await this.connectDevice();
      await this.tunnel.start(`http://127.0.0.1:${this.localPort}`, { provider });
      return this.status();
    } catch (error) {
      this.error = error.message;
      await this.stop();
      throw error;
    }
  }

  registerInvite(invite, { transport = 'https' } = {}) {
    if (!this.status().running) throw new Error('Start the public agent relay before creating a public invitation.');
    this.pruneInvites();
    const registrationDeviceId = this.deviceId;
    this.invites.set(invite.id, { expiresAt: Date.parse(invite.expiresAt), deviceId: registrationDeviceId });
    this.persistInviteRegistry();
    console.info('[HexiGrid relay invite] registration device selected', { inviteId: invite.id, deviceId: registrationDeviceId });
    const urlDeviceId = this.deviceId;
    const selectedTransport = transport === 'companion' ? 'companion' : 'https';
    const invitationUrl = `${this.tunnel.status().url}/agent-link/connect?relay=1&transport=${selectedTransport}&device=${encodeURIComponent(urlDeviceId)}&invite=${encodeURIComponent(invite.id)}`;
    console.info('[HexiGrid relay invite] URL device generated', { inviteId: invite.id, deviceId: urlDeviceId });
    return invitationUrl;
  }

  async stop({ preserveStableRoute = false } = {}) {
    await this.tunnel.stop({ preserveStableRoute });
    if (this.peerSweepTimer) clearInterval(this.peerSweepTimer);
    this.peerSweepTimer = null;
    for (const peer of this.peerConnections.values()) await peer.close().catch(() => {});
    this.peerConnections.clear();
    this.peerChannels.clear();
    for (const [peerId, peer] of this.peers) { if (peer.kind === 'websocket') peer.socket.close(1001, 'Relay stopped'); else this.removePeer(peerId); }
    this.peers.clear();
    if (this.deviceSocket) this.deviceSocket.close();
    this.deviceSocket = null;
    if (this.connectorSocket) this.connectorSocket.close();
    this.connectorSocket = null;
    if (this.wss) this.wss.close();
    this.wss = null;
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.invites.clear();
    this.deviceId = '';
    this.deviceKey = '';
    this.localPort = 0;
    this.startedAt = null;
    return this.status();
  }

  pruneInvites() {
    let changed = false;
    for (const [id, invite] of this.invites) if (invite.expiresAt <= this.now()) { this.invites.delete(id); changed = true; }
    if (changed) this.persistInviteRegistry();
  }

  rebuildInviteRegistry() {
    this.invites.clear();
    for (const invite of this.state.agentLinkInvites || []) {
      const expiresAt = Date.parse(invite?.expiresAt || '');
      if (!invite?.id || invite.usedAt || !Number.isFinite(expiresAt) || expiresAt <= this.now()) continue;
      this.invites.set(invite.id, { expiresAt, deviceId: this.deviceId });
    }
    this.persistInviteRegistry();
  }

  persistInviteRegistry() {
    this.state.agentRelayRegistry = {
      version: 1,
      deviceId: this.deviceId,
      inviteIds: [...this.invites.keys()]
    };
  }

  prunePeers() {
    const cutoff = this.now() - HTTPS_PEER_IDLE_MS;
    for (const [peerId, peer] of this.peers) {
      if (peer.kind === 'https' && (peer.lastSeenAt || peer.createdAt) < cutoff) this.removePeer(peerId);
      else if (peer.kind === 'websocket' && peer.socket.readyState !== WebSocket.OPEN) this.removePeer(peerId);
    }
  }

  async startLocalRelay() {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://relay.invalid');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, securityHeaders('application/json; charset=utf-8'));
        return res.end(JSON.stringify({ ok: true, service: 'hexigrid-agent-relay', deviceOnline: this.deviceSocket?.readyState === WebSocket.OPEN }));
      }
      if (req.method === 'GET' && url.pathname === '/agent-link/skill') return this.serveSkillBundle(res);
      const route = relayRoute(url.pathname);
      if (route?.action === 'open' && req.method === 'POST') return this.openHttpPeer(req, res, route.channel);
      if (route?.action === 'send' && req.method === 'POST') return this.sendHttpPeer(req, res, route.channel);
      if (route?.action === 'close' && req.method === 'POST') return this.closeHttpPeer(req, res, route.channel);
      if (route?.action === 'poll' && req.method === 'GET') return this.pollHttpPeer(req, res, url, route.channel);
      const asset = req.method === 'GET' ? ALLOWED_ASSETS.get(url.pathname) : null;
      if (!asset) { res.writeHead(404, securityHeaders('application/json; charset=utf-8')); return res.end('{"error":"Not found."}'); }
      try {
        const body = await fs.readFile(path.join(this.publicDir, asset[0]));
        res.writeHead(200, { ...securityHeaders(asset[1]), 'content-length': body.length });
        res.end(body);
      } catch {
        res.writeHead(500, securityHeaders('application/json; charset=utf-8'));
        res.end('{"error":"Relay asset unavailable."}');
      }
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SOCKET_MESSAGE, perMessageDeflate: false, clientTracking: false });
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://relay.invalid');
      if (url.pathname !== '/relay/v1/socket') return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this.acceptSocket(ws, url));
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.listenPort, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    this.localPort = this.server.address().port;
  }

  async serveSkillBundle(res) {
    try {
      return this.relayJson(res, 200, await agentLinkSkillBundle(this.skillRoot, this.projectRoot));
    } catch (error) {
      return this.relayJson(res, 503, { error: `The HexiGrid Link skill bundle is unavailable: ${error.message}` });
    }
  }

  acceptSocket(socket, url) {
    const role = url.searchParams.get('role');
    if (role === 'device') {
      if (url.searchParams.get('device') !== this.deviceId || url.searchParams.get('key') !== this.deviceKey || this.deviceSocket) return socket.close(1008, 'Unauthorized device');
      this.deviceSocket = socket;
      socket.on('message', (raw) => this.forwardFromDevice(raw));
      socket.on('close', () => { if (this.deviceSocket === socket) this.deviceSocket = null; for (const [peerId, peer] of this.peers) { if (peer.kind === 'websocket') peer.socket.close(1012, 'Owner device offline'); else this.removePeer(peerId); } this.peers.clear(); });
      return json(socket, { type: 'device-ready' });
    }
    if (!['browser', 'companion'].includes(role)) return socket.close(1008, 'Unknown role');
    this.pruneInvites();
    this.prunePeers();
    const inviteId = url.searchParams.get('invite') || '';
    const deviceId = url.searchParams.get('device') || '';
    const access = this.validateInvite(inviteId, deviceId);
    if (!access.ok) return socket.close(1008, access.error);
    if (this.peers.size >= MAX_BROWSER_PEERS) return socket.close(1013, 'Relay busy, try again shortly');
    const peerId = randomId('peer');
    this.peers.set(peerId, { peerId, kind: 'websocket', channel: role, socket, inviteId, deviceId, createdAt: this.now() });
    socket.on('message', (raw) => {
      if (raw.length > MAX_SOCKET_MESSAGE) return socket.close(1009, 'Message too large');
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return socket.close(1003, 'Invalid message'); }
      if (!['signal', 'relay', 'chunk'].includes(message.type)) return socket.close(1008, 'Unsupported message');
      json(this.deviceSocket, { ...message, peerId, inviteId });
    });
    socket.on('close', () => this.removePeer(peerId));
    json(socket, { type: `${role}-ready`, peerId });
    json(this.deviceSocket, { type: `${role}-joined`, peerId, inviteId });
  }

  forwardFromDevice(raw) {
    if (raw.length > MAX_SOCKET_MESSAGE) return;
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const peer = this.peers.get(message.peerId);
    if (!peer || !['signal', 'relay', 'chunk', 'transport', 'revoked'].includes(message.type)) return;
    const { peerId, ...outbound } = message;
    this.deliverToPeer(peer, outbound);
  }

  async readRelayBody(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_SOCKET_MESSAGE) throw new Error('Relay message too large.'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  relayJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { ...securityHeaders('application/json; charset=utf-8'), 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  validateInvite(inviteId, deviceId, { connectionId = '', linkTokenHash = '', clientDeviceId = '' } = {}) {
    this.pruneInvites();
    const registered = this.invites.get(inviteId);
    const persisted = this.state.agentLinkInvites.find((item) => item.id === inviteId);
    const currentTime = this.now();
    const socketReadyState = this.deviceSocket?.readyState ?? null;
    if (deviceId !== this.deviceId) {
      console.warn('[HexiGrid relay invite] relay device mismatch', { inviteId, activeDeviceId: this.deviceId, presentedDeviceId: deviceId });
      return { ok: false, status: 403, code: 'relay_device_mismatch', error: 'Relay device mismatch.' };
    }
    if (socketReadyState !== WebSocket.OPEN) {
      console.warn('[HexiGrid relay invite] device socket unavailable', { inviteId, readyState: socketReadyState, expectedReadyState: WebSocket.OPEN });
      return { ok: false, status: 503, code: 'owner_offline', error: 'The owner device is temporarily offline.' };
    }
    if (connectionId) {
      const connection = this.state.agentLinks.find((item) => item.id === connectionId && item.inviteId === inviteId);
      if (!connection || !safeEqual(connection.tokenHash, linkTokenHash)) return { ok: false, status: 401, code: 'connection_unauthorized', error: 'Connection authentication failed.' };
      if (['revoked', 'stale'].includes(connection.status)) return { ok: false, status: 410, code: 'connection_revoked', error: 'Connection revoked.' };
      if (connection.clientDeviceId && clientDeviceId && connection.clientDeviceId !== clientDeviceId) return { ok: false, status: 403, code: 'device_mismatch', error: 'Connection device mismatch.' };
      if (!connection.clientDeviceId && clientDeviceId) connection.clientDeviceId = String(clientDeviceId).slice(0, 160);
      console.info('[HexiGrid relay invite] resume validation passed', { inviteId, connectionId, deviceId, readyState: socketReadyState });
      return { ok: true, connection };
    }
    const expiresAt = Date.parse(persisted?.expiresAt || '');
    if (!persisted) return { ok: false, status: 401, code: 'invitation_unavailable', error: 'Invitation unavailable.' };
    if (persisted.usedAt) return { ok: false, status: 409, code: 'invitation_consumed', error: 'Invitation already used.' };
    if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) return { ok: false, status: 410, code: 'invitation_expired', error: 'Invitation expired.' };
    if (!registered || registered.deviceId !== this.deviceId) {
      console.warn('[HexiGrid relay invite] invitation unavailable for first-time pairing', { inviteId, registered: Boolean(registered), persisted: true });
      return { ok: false, status: 401, code: 'invitation_unavailable', error: 'Invitation unavailable.' };
    }
    console.info('[HexiGrid relay invite] validation passed', { inviteId, deviceId, readyState: socketReadyState, expiresAt: persisted.expiresAt });
    return { ok: true, invite: persisted };
  }

  async openHttpPeer(req, res, channel = 'browser') {
    try {
      const body = await this.readRelayBody(req); const inviteId = String(body.inviteId || ''); const deviceId = String(body.deviceId || '');
      this.prunePeers();
      const access = this.validateInvite(inviteId, deviceId, { connectionId: String(body.connectionId || ''), linkTokenHash: String(body.linkTokenHash || ''), clientDeviceId: String(body.clientDeviceId || '') });
      if (!access.ok) return this.relayJson(res, access.status, { error: access.error, code: access.code });
      const clientDeviceId = String(body.clientDeviceId || '').slice(0, 160);
      const connectionId = String(body.connectionId || '').slice(0, 160);
      // A companion watch can stay open while one-shot CLI commands use the
      // same Link and client device. Keep those authenticated sessions
      // independent; browser HTTPS sessions still replace their prior peer.
      if (connectionId && channel !== 'companion') {
        for (const [existingPeerId, existingPeer] of this.peers) {
          if (existingPeer.kind === 'https' && existingPeer.channel === channel && existingPeer.connectionId === connectionId && (!clientDeviceId || existingPeer.clientDeviceId === clientDeviceId)) this.removePeer(existingPeerId);
        }
      }
      if (this.peers.size >= MAX_BROWSER_PEERS) return this.relayJson(res, 503, { error: 'Relay busy, try again shortly.', retryAfter: 15 });
      const peerId = randomId('peer'); const token = crypto.randomBytes(32).toString('base64url');
      const createdAt = this.now();
      this.peers.set(peerId, { peerId, kind: 'https', channel, inviteId, deviceId, clientDeviceId, connectionId, tokenHash: crypto.createHash('sha256').update(token).digest('base64url'), controlQueue: [], mediaQueue: [], frameQueue: [], frameQueueBytes: 0, frameQueueId: '', droppedFrameId: '', droppedMedia: 0, waiter: null, createdAt, lastSeenAt: createdAt });
      if (channel === 'companion') this.companionMetrics.acceptedOpens += 1;
      json(this.deviceSocket, { type: `${channel}-joined`, peerId, inviteId });
      return this.relayJson(res, 201, { peerId, token, transport: channel === 'companion' ? 'outbound-https' : 'https', channel });
    } catch (error) { return this.relayJson(res, 400, { error: error.message }); }
  }

  authenticateHttpPeer(req, peerId, channel = 'browser') {
    const peer = this.peers.get(peerId); const match = /^Bearer\s+([A-Za-z0-9_-]{32,100})$/.exec(String(req.headers.authorization || ''));
    const presented = match ? crypto.createHash('sha256').update(match[1]).digest('base64url') : '';
    if (!peer || peer.kind !== 'https' || peer.channel !== channel || !presented || peer.tokenHash.length !== presented.length || !crypto.timingSafeEqual(Buffer.from(peer.tokenHash), Buffer.from(presented)) || this.now() - peer.createdAt > 12 * 60 * 60 * 1000) return null;
    peer.lastSeenAt = this.now();
    return peer;
  }

  async sendHttpPeer(req, res, channel = 'browser') {
    try {
      const body = await this.readRelayBody(req); const peerId = String(body.peerId || ''); const peer = this.authenticateHttpPeer(req, peerId, channel);
      if (!peer || !['signal', 'relay', 'chunk'].includes(body.message?.type)) return this.relayJson(res, 401, { error: 'Relay session unavailable.' });
      if (this.deviceSocket?.readyState !== WebSocket.OPEN) return this.relayJson(res, 503, { error: 'The owner device is temporarily offline. The relay will retry.' });
      if (this.deviceSocket.bufferedAmount > MAX_DEVICE_BUFFER_BYTES) {
        if (body.message.queueClass === 'media') return this.relayJson(res, 202, { ok: true, dropped: true, reason: 'media_backpressure' });
        return this.relayJson(res, 503, { error: 'The relay is applying backpressure. Retry after the connection drains.', code: 'relay_backpressure', retryAfter: 2 });
      }
      json(this.deviceSocket, { ...body.message, peerId, inviteId: peer.inviteId });
      if (channel === 'companion') this.companionMetrics.acceptedSends += 1;
      return this.relayJson(res, 202, { ok: true });
    } catch (error) { return this.relayJson(res, 400, { error: error.message }); }
  }

  async closeHttpPeer(req, res, channel = 'browser') {
    try {
      const body = await this.readRelayBody(req); const peerId = String(body.peerId || '');
      if (!this.authenticateHttpPeer(req, peerId, channel)) return this.relayJson(res, 401, { error: 'Relay session unavailable.' });
      this.removePeer(peerId);
      return this.relayJson(res, 200, { ok: true });
    } catch (error) { return this.relayJson(res, 400, { error: error.message }); }
  }

  async pollHttpPeer(req, res, url, channel = 'browser') {
    const peerId = url.searchParams.get('peer') || ''; const peer = this.authenticateHttpPeer(req, peerId, channel);
    if (!peer) return this.relayJson(res, 401, { error: 'Relay session unavailable.' });
    if (peer.controlQueue.length || peer.frameQueue.length || peer.mediaQueue.length) {
      const droppedMedia = peer.droppedMedia; peer.droppedMedia = 0;
      const messages = this.drainPeer(peer);
      if (channel === 'companion') { this.companionMetrics.acceptedPolls += 1; this.companionMetrics.pollDeliveries += messages.length; }
      return this.relayJson(res, 200, { messages, droppedMedia });
    }
    if (channel === 'companion') this.companionMetrics.acceptedPolls += 1;
    if (peer.waiter) { clearTimeout(peer.waiter.timer); this.relayJson(peer.waiter.res, 200, { messages: [] }); }
    const timer = setTimeout(() => { if (peer.waiter?.res === res) peer.waiter = null; this.relayJson(res, 200, { messages: [] }); }, 20_000);
    peer.waiter = { res, timer };
    res.once('close', () => { if (!res.writableEnded && peer.waiter?.res === res) { clearTimeout(timer); peer.waiter = null; } });
  }

  deliverToPeer(peer, message) {
    if (peer.kind === 'websocket') return json(peer.socket, message);
    if (message.queueClass === 'frame') {
      const frameId = String(message.id || '');
      const validFrameChunk = frameId && Number.isInteger(message.index) && Number.isInteger(message.total)
        && message.total > 0 && message.total <= MAX_FRAME_QUEUE_MESSAGES
        && message.index >= 0 && message.index < message.total && typeof message.data === 'string';
      if (!validFrameChunk) { this.clearFrameQueue(peer); return; }
      if (peer.frameQueueId !== frameId) {
        this.clearFrameQueue(peer);
        peer.frameQueueId = frameId;
      }
      if (peer.droppedFrameId === frameId) return;
      if (peer.waiter) {
        const { res, timer } = peer.waiter; peer.waiter = null; clearTimeout(timer);
        if (peer.channel === 'companion' && message.type === 'relay') this.companionMetrics.pollDeliveries += 1;
        return this.relayJson(res, 200, { messages: [message] });
      }
      const size = Buffer.byteLength(JSON.stringify(message));
      if (peer.frameQueue.length >= MAX_FRAME_QUEUE_MESSAGES || peer.frameQueueBytes + size > MAX_FRAME_QUEUE_BYTES) {
        this.clearFrameQueue(peer);
        peer.frameQueueId = frameId;
        peer.droppedFrameId = frameId;
        return;
      }
      peer.frameQueue.push(message);
      peer.frameQueueBytes += size;
      return;
    }
    if (peer.waiter) { const { res, timer } = peer.waiter; peer.waiter = null; clearTimeout(timer); if (peer.channel === 'companion' && message.type === 'relay') this.companionMetrics.pollDeliveries += 1; return this.relayJson(res, 200, { messages: [message] }); }
    const media = message.queueClass === 'media';
    if (media) {
      if (peer.mediaQueue.length >= MAX_MEDIA_MESSAGES) { peer.mediaQueue.shift(); peer.droppedMedia += 1; }
      peer.mediaQueue.push(message);
      return;
    }
    if (peer.controlQueue.length >= MAX_CONTROL_MESSAGES) { this.removePeer(peer.peerId); return; }
    peer.controlQueue.push(message);
  }

  drainPeer(peer) {
    const control = peer.controlQueue.splice(0, 20);
    const remaining = Math.max(0, 20 - control.length);
    const frames = peer.frameQueue.splice(0, remaining);
    peer.frameQueueBytes = Math.max(0, peer.frameQueueBytes - frames.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0));
    if (!peer.frameQueue.length) peer.frameQueueId = '';
    const media = peer.mediaQueue.splice(0, Math.max(0, remaining - frames.length));
    return control.concat(frames, media);
  }

  clearFrameQueue(peer) {
    peer.frameQueue = [];
    peer.frameQueueBytes = 0;
    peer.frameQueueId = '';
    peer.droppedFrameId = '';
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId); if (!peer) return;
    if (peer.waiter) { clearTimeout(peer.waiter.timer); this.relayJson(peer.waiter.res, 410, { error: 'Relay session closed.' }); }
    this.peers.delete(peerId); json(this.deviceSocket, { type: 'peer-left', peerId });
  }

  async connectDevice() {
    const url = `ws://127.0.0.1:${this.localPort}/relay/v1/socket?role=device&device=${encodeURIComponent(this.deviceId)}&key=${encodeURIComponent(this.deviceKey)}`;
    const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: MAX_SOCKET_MESSAGE });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    this.connectorSocket = socket;
    socket.on('message', (raw) => this.handleDeviceMessage(raw));
    socket.on('close', () => { if (this.connectorSocket === socket) { this.connectorSocket = null; Promise.resolve(this.onDeviceDisconnect()).catch(() => {}); } for (const peer of this.peerConnections.values()) peer.close().catch(() => {}); this.peerConnections.clear(); });
  }

  async handleDeviceMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'browser-joined') return this.createPeerConnection(message.peerId);
    if (message.type === 'companion-joined') return;
    if (message.type === 'peer-left') { const pc = this.peerConnections.get(message.peerId); this.peerConnections.delete(message.peerId); this.peerChannels.delete(message.peerId); return pc?.close().catch(() => {}); }
    if (message.type === 'signal' && message.description?.type === 'offer') return this.answerOffer(message.peerId, message.description);
    if (message.type === 'relay' || message.type === 'chunk') return this.receiveTransportMessage(message.peerId, message);
  }

  createPeerConnection(peerId) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], maxMessageSize: 65536 });
    pc.ondatachannel = ({ channel }) => {
      this.peerChannels.set(peerId, channel);
      channel.onmessage = ({ data }) => this.receiveTransportMessage(peerId, JSON.parse(Buffer.isBuffer(data) ? data.toString() : data));
      channel.onopen = () => json(this.connectorSocket, { type: 'transport', peerId, transport: 'webrtc' });
      channel.onclose = () => this.peerChannels.delete(peerId);
    };
    pc.connectionStateChange.subscribe((state) => { if (['failed', 'closed'].includes(state)) pc.close().catch(() => {}); });
    this.peerConnections.set(peerId, pc);
    return pc;
  }

  async answerOffer(peerId, description) {
    const pc = this.peerConnections.get(peerId) || this.createPeerConnection(peerId);
    try {
      await pc.setRemoteDescription(description);
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== 'complete') await pc.iceGatheringStateChange.watch((state) => state === 'complete', 5000).catch(() => {});
      json(this.connectorSocket, { type: 'signal', peerId, description: pc.localDescription });
    } catch { json(this.connectorSocket, { type: 'transport', peerId, transport: 'relay' }); }
  }

  async receiveTransportMessage(peerId, message) {
    if (message.type === 'chunk') return this.receiveChunk(peerId, message);
    if (message.type !== 'relay' || !message.payload) return;
    if (this.peers.get(peerId)?.channel === 'companion') this.companionMetrics.ownerReceived += 1;
    await this.processRequest(peerId, message.payload);
  }

  receiveChunk(peerId, message) {
    const key = `${peerId}:${message.id}`;
    const current = this._chunks?.get(key) || { parts: new Array(message.total), received: 0 };
    this._chunks ||= new Map();
    if (!current.parts[message.index]) { current.parts[message.index] = message.data; current.received += 1; }
    this._chunks.set(key, current);
    if (current.received === message.total) {
      this._chunks.delete(key);
      try { this.processRequest(peerId, JSON.parse(current.parts.join(''))); } catch { /* fail closed */ }
    }
  }

  async processRequest(peerId, payload) {
    let keyMaterial;
    if (payload.phase === 'pair') {
      const invite = this.state.agentLinkInvites.find((item) => item.id === payload.inviteId && !item.usedAt && Date.parse(item.expiresAt) > this.now());
      if (!invite) return this.sendEncrypted(peerId, payload.requestId, payload.phase, payload.inviteId, null, { status: 401, body: { error: 'This invitation is invalid, expired, or already used.' } });
      keyMaterial = invite.secretHash;
    } else if (payload.phase === 'link') {
      const link = this.state.agentLinks.find((item) => item.id === payload.connectionId && item.status === 'connected');
      if (!link) { json(this.connectorSocket, { type: 'revoked', peerId, connectionId: payload.connectionId }); return; }
      keyMaterial = link.tokenHash;
    } else return;
    try {
      const request = decryptRelayEnvelope(keyMaterial, payload.envelope);
      const allowedPair = payload.phase === 'pair' && request.method === 'POST' && request.pathname === '/agent-link/v1/pair' && request.body?.inviteId === payload.inviteId;
      const allowedLink = payload.phase === 'link' && /^\/agent-link\/v1\/(?:orientation|capabilities|usage(?:\/budget)?|model-pool(?:\/routing)?|addons\/hexikeys(?:\/(?:open|request-capture|connect|disconnect))?|plugin-publishers(?:\/[a-z0-9-]+\/revoke)?|plugins(?:\/install|\/[a-z0-9-]+\/(?:run|enable|secrets|remove|hexikeys-scope|hexikeys-reference))?|mcp(?:\/[a-z0-9-]+\/(?:call|enable|test|remove|secrets))?|avatar(?:\/portrait)?|heartbeat|desktop\/(?:frame|input|start|stop|uia-inspect|uia-act|media|speaker)|workspace\/(?:list|read|write)|owner\/(?:fs\/(?:list|read|write)|exec)|voice-call(?:\/(?:initiate|answer|end|probe|reply|media))?|events(?:\/poll)?|ack|messages(?:\/history)?|codex\/(?:chats|projects)|identity|tokens|continuity|cognition|memory-(?:mcp|scope)|memory\/memory-[a-fA-F0-9-]{36}|shared-memory|skills|tasks|rooms\/reply|hexispace\/(?:profiles|profile|posts|post|comments|comment|friendships|friendship\/(?:request|respond)|relationships|relationship\/(?:request|respond)|reaction|hexipets|hexipet\/(?:equip|unequip|outfit))|harness-jobs(?:\/[a-z0-9-]+(?:\/cancel)?)?)$/.test(request.pathname)
        && (!request.pathname.startsWith('/agent-link/v1/mcp') || (request.pathname === '/agent-link/v1/mcp' ? ['GET', 'POST'].includes(request.method) : request.method === 'POST'))
        && (!request.pathname.startsWith('/agent-link/v1/addons/hexikeys') || (request.pathname === '/agent-link/v1/addons/hexikeys' ? request.method === 'GET' : request.method === 'POST'))
        && (!request.pathname.startsWith('/agent-link/v1/plugins') || (request.pathname === '/agent-link/v1/plugins' ? request.method === 'GET' : request.method === 'POST'))
        && (!request.pathname.startsWith('/agent-link/v1/model-pool') || request.method === (request.pathname.endsWith('/routing') ? 'POST' : 'GET'))
        && (!request.pathname.startsWith('/agent-link/v1/memory/') || request.method === 'DELETE')
        && (!request.pathname.startsWith('/agent-link/v1/usage') || request.method === (request.pathname.endsWith('/budget') ? 'PUT' : 'GET'))
        && (request.pathname !== '/agent-link/v1/desktop/start' || request.method === 'POST')
        && (request.pathname !== '/agent-link/v1/voice-call/initiate' || request.method === 'POST')
        && (!['/agent-link/v1/voice-call/initiate', '/agent-link/v1/voice-call/media'].includes(request.pathname) || request.method === 'POST')
        && (request.pathname !== '/agent-link/v1/skills' || request.method === 'POST')
        && (request.pathname !== '/agent-link/v1/tasks' || request.method === 'POST')
        && (!/^\/agent-link\/v1\/desktop\/uia-(?:inspect|act)$/.test(request.pathname) || request.method === 'POST')
        && (request.pathname !== '/agent-link/v1/rooms/reply' || request.method === 'POST')
        && (!['/agent-link/v1/avatar', '/agent-link/v1/avatar/portrait'].includes(request.pathname) || ['GET', 'POST'].includes(request.method));
      if (!allowedPair && !allowedLink) throw new Error('The relay request route is not allowed.');
      const companionLink = payload.phase === 'link' && this.peers.get(peerId)?.channel === 'companion';
      if (companionLink) this.companionMetrics.decryptedLinkRequests += 1;
      const response = await fetch(`${this.targetOrigin}${request.pathname}`, {
        method: request.method,
        headers: request.headers,
        ...(request.body === null ? {} : { body: JSON.stringify(request.body) })
      });
      if (companionLink) {
        this.companionMetrics.ownerApiResponses += 1;
        if (request.pathname === '/agent-link/v1/heartbeat') this.companionMetrics.lastHeartbeatHttpStatus = response.status;
      }
      const body = await response.json().catch(() => ({ error: 'HexiGrid returned an unreadable response.' }));
      // Bind the browser to the exact response-encryption key selected by the
      // owner device. It travels only inside the invitation-encrypted pairing
      // response and remains tab-local; signed API requests still require the
      // separate raw Link token.
      if (payload.phase === 'pair' && response.ok && body.connection?.id) {
        const paired = this.state.agentLinks.find((item) => item.id === body.connection.id && item.status === 'connected');
        if (!paired) throw new Error('The paired Link response key is unavailable.');
        body.relayResponseKey = paired.tokenHash;
      }
      const queueClass = ['/agent-link/v1/desktop/frame', '/agent-link/v1/owner/fs/read'].includes(request.pathname)
        ? 'frame'
        : (/^\/agent-link\/v1\/desktop\/(?:media|speaker)$/.test(request.pathname) ? 'media' : 'control');
      await this.sendEncrypted(peerId, payload.requestId, payload.phase, payload.inviteId, payload.connectionId, { status: response.status, body }, keyMaterial, queueClass);
      if (companionLink) this.companionMetrics.linkResponseMessages += 1;
    } catch (error) {
      if (this.peers.get(peerId)?.channel === 'companion') {
        this.companionMetrics.ownerRequestFailures += 1;
        this.companionMetrics.lastFailureCategory = error?.name === 'TypeError' ? 'owner_fetch_failed' : 'request_rejected';
      }
      await this.sendEncrypted(peerId, payload.requestId, payload.phase, payload.inviteId, payload.connectionId, { status: 400, body: { error: error.message } }, keyMaterial);
    }
  }

  async sendEncrypted(peerId, requestId, phase, inviteId, connectionId, response, suppliedKey, queueClass = 'control') {
    let keyMaterial = suppliedKey;
    if (!keyMaterial && phase === 'pair') keyMaterial = this.state.agentLinkInvites.find((item) => item.id === inviteId)?.secretHash;
    if (!keyMaterial && phase === 'link') keyMaterial = this.state.agentLinks.find((item) => item.id === connectionId)?.tokenHash;
    if (!keyMaterial) return;
    const envelope = encryptRelayEnvelope(keyMaterial, response);
    const proof = {
      keyId: crypto.createHash('sha256').update(`key\n${keyMaterial}`).digest('base64url').slice(0, 16),
      envelope: crypto.createHash('sha256').update(`envelope\n${JSON.stringify(envelope)}`).digest('base64url').slice(0, 16)
    };
    const payload = { requestId, phase, inviteId, connectionId, envelope, proof };
    this.sendToPeer(peerId, payload, queueClass);
  }

  sendToPeer(peerId, payload, queueClass = 'control') {
    const serialized = JSON.stringify(payload);
    const channel = this.peerChannels.get(peerId);
    const send = (message) => {
      if (channel?.readyState === 'open') channel.send(JSON.stringify(message));
      else json(this.connectorSocket, { ...message, peerId });
    };
    // A small file read fits in one relay message. The frame queue accepts
    // numbered chunks only, so send this complete response on the control
    // queue instead of silently discarding it as an invalid frame chunk.
    if (serialized.length <= 48000) return send({ type: 'relay', payload, queueClass: queueClass === 'frame' ? 'control' : queueClass });
    const id = randomId('chunk'); const parts = serialized.match(/[\s\S]{1,48000}/g) || [];
    parts.forEach((data, index) => send({ type: 'chunk', id, index, total: parts.length, data, queueClass }));
  }
}
