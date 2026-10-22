import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encryptRelayEnvelope, decryptRelayEnvelope } from '../lib/agent-relay-crypto.mjs';
import { PublicAgentRelay } from '../lib/public-agent-relay.mjs';
import { AGENT_LINK_SKILL_VERSION } from '../lib/agent-link-skill-bundle.mjs';
import { acceptAgentLinkInvite, acknowledgeAgentLinkEvents, queueAgentLinkEvent, readAgentLinkEvents } from '../lib/agent-link.mjs';
import { OutboundCompanionConnection } from '../lib/companion-client.mjs';
import { companionRetryDelay, markCompanionConnected, markCompanionFailure } from '../lib/companion-connection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class FakeTunnel {
  constructor() { this.running = false; this.url = ''; }
  status() { return { available: true, running: this.running, starting: false, url: this.url, error: '', startedAt: null }; }
  async start(_localUrl, options) { this.options = options; this.running = true; this.url = 'https://relay.example.test'; return this.status(); }
  stop() { this.running = false; this.url = ''; return this.status(); }
}

test('relay envelopes are confidential and reject tampering', () => {
  const envelope = encryptRelayEnvelope('secret-hash', { frame: 'private', input: { x: 1, y: 2 } });
  assert.equal(JSON.stringify(envelope).includes('private'), false);
  assert.deepEqual(decryptRelayEnvelope('secret-hash', envelope), { frame: 'private', input: { x: 1, y: 2 } });
  assert.throws(() => decryptRelayEnvelope('wrong-hash', envelope));
  const tampered = { ...envelope, data: `${envelope.data.startsWith('A') ? 'B' : 'A'}${envelope.data.slice(1)}` };
  assert.throws(() => decryptRelayEnvelope('secret-hash', tampered));
});

test('public relay serves only invitation assets and never owner APIs', async (t) => {
  const state = { agentLinkInvites: [], agentLinks: [] };
  const tunnel = new FakeTunnel();
  const relay = new PublicAgentRelay({ publicDir: path.join(ROOT, 'public'), skillRoot: path.join(ROOT, 'integrations', 'hexigrid-link'), projectRoot: ROOT, targetOrigin: 'http://127.0.0.1:4318', state, tunnel });
  t.after(() => relay.stop());
  const status = await relay.start({ provider: 'cloudflare-quick-tunnel' });
  assert.equal(status.running, true);
  assert.deepEqual(tunnel.options, { provider: 'cloudflare-quick-tunnel' });
  const local = `http://127.0.0.1:${relay.localPort}`;
  assert.equal((await fetch(`${local}/agent-link/connect`)).status, 200);
  const skillResponse = await fetch(`${local}/agent-link/skill`);
  assert.equal(skillResponse.status, 200);
  const skillBundle = await skillResponse.json();
  assert.equal(skillBundle.version, AGENT_LINK_SKILL_VERSION);
  const skill = skillBundle.files.find((file) => file.path === 'SKILL.md');
  assert.match(skill?.content || '', /memory-shares --connection/);
  assert.match(skill?.content || '', /memory-shared-context --connection/);
  assert.match(skill?.content || '', /skills --connection/);
  assert.match(skill?.content || '', /owner can revoke the share/);
  const companionClient = skillBundle.files.find((file) => file.path === 'scripts/companion_client.mjs');
  assert.ok(companionClient);
  assert.match(companionClient.content, /command: commandName/);
  assert.match(companionClient.content, /continuity-request-status/);
  assert.match(companionClient.content, /hexispace-posts/);
  assert.match(companionClient.content, /hexispace-friend-request/);
  assert.match(companionClient.content, /hexispace-relationships/);
  assert.match(companionClient.content, /hexispace-reaction/);
  assert.match(companionClient.content, /workspace-list/);
  assert.match(companionClient.content, /workspace-read/);
  assert.match(companionClient.content, /workspace-write/);
  assert.match(companionClient.content, /memory-shares/);
  assert.match(companionClient.content, /memory-shared-context/);
  assert.match(companionClient.content, /commandName === 'skills'/);
  assert.match(companionClient.content, /commandName === 'skill'/);
  assert.match(companionClient.content, /commandName === 'watch'/);
  assert.doesNotMatch(companionClient.content, /const \{ command, flags \}/);
  assert.equal((await fetch(`${local}/agent-link-relay-client.js`)).status, 200);
  const actionsResponse = await fetch(`${local}/agent-link-actions.js`);
  assert.equal(actionsResponse.status, 200);
  assert.match(actionsResponse.headers.get('content-type'), /text\/javascript/);
  assert.match(await actionsResponse.text(), /prepareAgentLinkAction/);
  assert.equal((await fetch(`${local}/api/bootstrap`)).status, 404);
  assert.equal((await fetch(`${local}/api/network`)).status, 404);
  const source = await (await fetch(`${local}/agent-link-relay-client.js`)).text();
  assert.match(source, /relayResponseKey/);
});

test('public invitation routing is registered only for a live one-time invite', async (t) => {
  const invite = { id: 'link-invite-test', expiresAt: new Date(Date.now() + 60_000).toISOString(), usedAt: null };
  const state = { agentLinkInvites: [invite], agentLinks: [] };
  const relay = new PublicAgentRelay({ publicDir: path.join(ROOT, 'public'), targetOrigin: 'http://127.0.0.1:4318', state, tunnel: new FakeTunnel() });
  t.after(() => relay.stop());
  await relay.start();
  const route = relay.registerInvite(invite);
  assert.match(route, /^https:\/\/relay\.example\.test\/agent-link\/connect\?relay=1&transport=https&device=device-[^&]+&invite=link-invite-test$/);
  const opened = await fetch(`http://127.0.0.1:${relay.localPort}/relay/v1/browser/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: relay.deviceId, inviteId: invite.id }) });
  assert.equal(opened.status, 201);
  const session = await opened.json();
  assert.match(session.peerId, /^peer-/);
  const rejectedAuthorization = ['Bearer', 'wrong-token-that-is-long-enough-12345'].join(' ');
  const rejected = await fetch(`http://127.0.0.1:${relay.localPort}/relay/v1/browser/poll?peer=${session.peerId}`, { headers: { authorization: rejectedAuthorization } });
  assert.equal(rejected.status, 401);
  await relay.stop();
  assert.throws(() => relay.registerInvite(invite), /Start the public agent relay/);
});

test('relay restart restores fresh invitations and accepts authenticated connection resume', async (t) => {
  const invite = {
    id: 'link-invite-restart',
    secretHash: 'invite-secret-hash',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    usedAt: null
  };
  const state = { agentLinkInvites: [invite], agentLinks: [] };
  const first = new PublicAgentRelay({ publicDir: path.join(ROOT, 'public'), targetOrigin: 'http://127.0.0.1:4318', state, tunnel: new FakeTunnel() });
  await first.start();
  first.registerInvite(invite, { transport: 'companion' });
  const stableDeviceId = first.deviceId;
  await first.stop();

  const second = new PublicAgentRelay({ publicDir: path.join(ROOT, 'public'), targetOrigin: 'http://127.0.0.1:4318', state, tunnel: new FakeTunnel() });
  await second.start();
  assert.equal(second.deviceId, stableDeviceId);
  const freshOpen = await fetch(`http://127.0.0.1:${second.localPort}/relay/v1/companion/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: stableDeviceId, inviteId: invite.id })
  });
  assert.equal(freshOpen.status, 201);
  await second.stop();

  const connection = { id: 'link-restart', inviteId: invite.id, status: 'connected', tokenHash: 'paired-token-hash' };
  state.agentLinkInvites = [];
  state.agentLinks.push(connection);
  const third = new PublicAgentRelay({ publicDir: path.join(ROOT, 'public'), targetOrigin: 'http://127.0.0.1:4318', state, tunnel: new FakeTunnel() });
  t.after(() => third.stop());
  await third.start();
  assert.equal(third.deviceId, stableDeviceId);
  const resumedOpen = await fetch(`http://127.0.0.1:${third.localPort}/relay/v1/companion/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: stableDeviceId, inviteId: invite.id, connectionId: connection.id, linkTokenHash: connection.tokenHash })
  });
  assert.equal(resumedOpen.status, 201);
});

test('relay distinguishes capacity from invalid invitations and prunes idle HTTPS peers', async (t) => {
  let clock = Date.now();
  const invite = { id: 'link-invite-capacity', expiresAt: new Date(clock + 5 * 60_000).toISOString(), usedAt: null };
  const state = { agentLinkInvites: [invite], agentLinks: [] };
  const relay = new PublicAgentRelay({ publicDir: path.join(ROOT, 'public'), targetOrigin: 'http://127.0.0.1:4318', state, tunnel: new FakeTunnel(), now: () => clock });
  t.after(() => relay.stop());
  await relay.start(); relay.registerInvite(invite);
  const endpoint = `http://127.0.0.1:${relay.localPort}/relay/v1/browser/open`;
  const open = () => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: relay.deviceId, inviteId: invite.id }) });
  for (let index = 0; index < 8; index += 1) assert.equal((await open()).status, 201);
  const busy = await open();
  assert.equal(busy.status, 503);
  assert.deepEqual(await busy.json(), { error: 'Relay busy, try again shortly.', retryAfter: 15 });
  clock += 60_001;
  relay.prunePeers();
  assert.equal(relay.peers.size, 0);
  assert.equal((await open()).status, 201);
  const invalid = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: relay.deviceId, inviteId: 'not-an-invite' }) });
  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { error: 'Invitation unavailable.', code: 'invitation_unavailable' });
});

test('outbound companion uses its own relay channel, resumes paired sessions, and carries large encrypted requests', async (t) => {
  const secret = 'companion-invite-secret-for-relay-test-1234567890';
  const syntheticScreenData = Buffer.alloc(2 * 1024 * 1024, 0x5a).toString('base64');
  let heartbeatCount = 0;
  let watchEventAcknowledged = false;
  const state = { agentLinkInvites: [], agentLinks: [] };
  const invite = { id: 'link-invite-companion', agentId: '', requestedCapabilities: ['messages', 'status', 'identity', 'desktop-view', 'microphone-listen', 'speaker-output', 'workspace-read', 'workspace-write', 'hexispace-profile', 'hexispace-posts', 'hexispace-comments', 'hexispace-friends', 'hexispace-relationships', 'hexispace-reactions'], secretHash: crypto.createHash('sha256').update(secret).digest('base64url'), expiresAt: new Date(Date.now() + 60_000).toISOString(), usedAt: null };
  state.agentLinkInvites.push(invite);
  const owner = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/agent-link/v1/pair') {
      const paired = acceptAgentLinkInvite(state, body);
      res.writeHead(201, { 'content-type': 'application/json' }); return res.end(JSON.stringify(paired));
    }
    if (req.url === '/agent-link/v1/orientation' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ orientation: { schemaVersion: 1, connection: { id: state.agentLinks[0].id } } }));
    }
    if (req.url === '/agent-link/v1/heartbeat' || req.url === '/agent-link/v1/identity') {
      if (req.url === '/agent-link/v1/heartbeat') heartbeatCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, received: body }));
    }
    if (req.url === '/agent-link/v1/memory-mcp' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [], structuredContent: {
        scopes: [{ projectId: 'relay-memory-qa', count: 1, updatedAt: '2026-09-28T00:00:00.000Z' }],
        total: 1, hasMore: false, nextCursor: null
      } } }));
    }
    if (req.url === '/agent-link/v1/shared-memory' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(body.operation === 'list'
        ? { shares: [{ id: 'memory-share-relay-qa', scope: { projectId: 'relay-memory-qa' } }], hasMore: false, nextCursor: null }
        : { shareId: body.shareId, context: { memories: [{ text: 'Current shared fact' }] } }));
    }
    if (req.url === '/agent-link/v1/avatar') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ avatar: { revision: req.method === 'POST' ? 1 : 0, animation: body.animation || '', visible: body.visible === true } }));
    }
    if (req.url === '/agent-link/v1/skills' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(body.operation === 'list'
        ? { skills: [{ id: 'skill-relay-qa', name: 'Local QA' }], hasMore: false, nextCursor: null, requestedLimit: body.limit }
        : { skill: { id: body.skillId, revision: 2 }, revisions: body.depth === 1 ? [{ revision: 1 }] : [], requestedDepth: body.depth }));
    }
    if (req.url === '/agent-link/v1/messages/history' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ messages: [{ id: 'link-message-history-qa', text: 'Exact Link text' }], limit: body.limit, hasMore: false, nextCursor: null }));
    }
    if (req.url === '/agent-link/v1/events/poll') {
      if (!readAgentLinkEvents(state.agentLinks[0], body.after).length) await new Promise((resolve) => setTimeout(resolve, 100));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ events: readAgentLinkEvents(state.agentLinks[0], body.after) }));
    }
    if (req.url === '/agent-link/v1/ack') {
      acknowledgeAgentLinkEvents(state.agentLinks[0], body.through);
      if (state.agentLinks[0].events[0]?.acknowledgedAt) watchEventAcknowledged = true;
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === '/agent-link/v1/hexispace/profiles' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ profiles: [{ profileId: 'qa-orbit' }] }));
    }
    if (req.url === '/agent-link/v1/hexispace/profile' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ profile: { id: body.profileId, bio: body.profile?.bio } }));
    }
    if (req.url === '/agent-link/v1/hexispace/post' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ post: { body: body.body, visibility: body.visibility, requestId: body.requestId } }));
    }
    if (req.url === '/agent-link/v1/hexispace/posts' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ posts: [{ id: 'post-qa', author_id: body.profileId }] }));
    }
    if (req.url === '/agent-link/v1/hexispace/comment' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ comment: { body: body.body, post_id: body.postId } }));
    }
    if (req.url === '/agent-link/v1/hexispace/comments' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ comments: [{ id: 'comment-qa', post_id: body.postId }] }));
    }
    if (/^\/agent-link\/v1\/hexispace\/(?:friendships|friendship\/(?:request|respond)|relationships|relationship\/(?:request|respond)|reaction|hexipets|hexipet\/(?:equip|unequip|outfit))$/.test(req.url) && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, path: req.url, received: body }));
    }
    if (req.url === '/agent-link/v1/voice-call') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ voiceCall: { id: 'voice-call-relay', status: 'offered' } }));
    }
    if (req.url === '/agent-link/v1/voice-call/initiate' && req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ voiceCall: { id: 'voice-call-relay-outbound', status: 'ringing', direction: 'agent-to-owner' } }));
    }
    if (req.url === '/agent-link/v1/voice-call/answer') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ voiceCall: { id: 'voice-call-relay', status: 'active' } }));
    }
    if (req.url === '/agent-link/v1/voice-call/media' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ voiceCall: { id: body.callId, status: 'active' }, audio: [{ sequence: 1, mimeType: 'audio/webm', data: Buffer.from('synthetic-call-audio').toString('base64'), durationMs: 900, speechActive: true }], replay: { audio: { gap: false } } }));
    }
    if (req.url === '/agent-link/v1/voice-call/probe') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ probe: { id: body.id, data: body.data, synthetic: true } }));
    }
    if (req.url === '/agent-link/v1/voice-call/reply') {
      res.writeHead(202, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ accepted: true, textLength: body.text.length }));
    }
    if (req.url === '/agent-link/v1/desktop/media') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ audio: [{ sequence: 1, mimeType: 'audio/webm', data: Buffer.from('synthetic-owner-mic').toString('base64') }], speaker: [] }));
    }
    if (req.url === '/agent-link/v1/desktop/frame') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ frame: { mimeType: 'image/png', data: syntheticScreenData, capturedAt: '2026-09-27T22:00:00.000Z' } }));
    }
    if (req.url === '/agent-link/v1/desktop/speaker') {
      res.writeHead(202, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ accepted: true, sequence: 1, bytes: Buffer.from(body.data, 'base64').length }));
    }
    if (req.url === '/agent-link/v1/workspace/list' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ path: body.path, entries: [{ name: 'README.md', type: 'text-file', size: 13 }] }));
    }
    if (req.url === '/agent-link/v1/workspace/read' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ path: body.path, text: 'project file\n', size: 13, sha256: 'a'.repeat(64) }));
    }
    if (req.url === '/agent-link/v1/usage' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ reports: [{ days: 7, requests: 0 }], budget: { window: '7d' } }));
    }
    if (req.url === '/agent-link/v1/owner/fs/read' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ path: body.path, size: 4, bytesRead: 4, data: Buffer.from('safe').toString('base64'), eof: true }));
    }
    if (req.url === '/agent-link/v1/tasks' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ tasks: [], nextCursor: null, operation: body.operation }));
    }
    if (req.url === '/agent-link/v1/workspace/write' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ path: body.path, size: Buffer.byteLength(body.text), created: body.createOnly === true, sha256: 'b'.repeat(64) }));
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'missing test route' }));
  });
  await new Promise((resolve) => owner.listen(0, '127.0.0.1', resolve));
  const targetOrigin = `http://127.0.0.1:${owner.address().port}`;
  const relay = new PublicAgentRelay({ publicDir: path.join(ROOT, 'public'), targetOrigin, state, tunnel: new FakeTunnel() });
  t.after(async () => { await relay.stop(); await new Promise((resolve) => owner.close(resolve)); });
  await relay.start();
  const inviteUrl = new URL(relay.registerInvite(invite, { transport: 'companion' }));
  inviteUrl.protocol = 'http:'; inviteUrl.host = `127.0.0.1:${relay.localPort}`; inviteUrl.hash = `secret=${encodeURIComponent(secret)}`;
  const companion = new OutboundCompanionConnection({ inviteUrl: inviteUrl.toString(), capabilities: ['messages', 'status', 'identity', 'desktop-view', 'microphone-listen', 'speaker-output', 'workspace-read', 'workspace-write', 'hexispace-profile', 'hexispace-posts', 'hexispace-comments', 'hexispace-friends', 'hexispace-relationships', 'hexispace-reactions'] });
  t.after(() => companion.close());
  await companion.connect();
  const paired = await companion.pair({ name: 'Companion test', framework: 'test' });
  assert.equal(paired.connection.identity.name, 'Companion test');
  const heartbeat = await companion.heartbeat();
  assert.equal(heartbeat.ok, true);
  const avatar = await companion.linkRequest('/agent-link/v1/avatar');
  assert.equal(avatar.ok, true, JSON.stringify(avatar.body));
  assert.equal(avatar.body.avatar.revision, 0);
  const avatarUpdate = await companion.linkRequest('/agent-link/v1/avatar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { visible: true, animation: 'Idle', expectedRevision: 0 } });
  assert.equal(avatarUpdate.ok, true, JSON.stringify(avatarUpdate.body));
  assert.equal(avatarUpdate.body.avatar.animation, 'Idle');
  assert.equal(avatarUpdate.body.avatar.revision, 1);
  for (const [pathname, method] of [['/agent-link/v1/avatar/export', 'GET'], ['/agent-link/v1/avatar', 'DELETE'], ['/api/agents/qa/avatar-presence', 'PATCH']]) {
    const blocked = await companion.linkRequest(pathname, { method, body: {} });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, 'The relay request route is not allowed.');
  }
  const usage = await companion.linkRequest('/agent-link/v1/usage', { method: 'GET' });
  assert.equal(usage.ok, true); assert.equal(usage.body.reports[0].days, 7);
  for (const [pathname, method] of [['/agent-link/v1/usage', 'POST'], ['/agent-link/v1/usage/export', 'GET'], ['/api/usage', 'GET']]) {
    const denied = await companion.linkRequest(pathname, { method }); assert.equal(denied.status, 400);
  }
  const memory = await companion.linkRequest('/agent-link/v1/memory-mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: { jsonrpc: '2.0', id: 81, method: 'tools/call', params: { name: 'list-context-scopes', arguments: {} } } });
  assert.equal(memory.ok, true, JSON.stringify(memory.body));
  assert.deepEqual(memory.body.result.structuredContent.scopes.map((scope) => scope.projectId), ['relay-memory-qa']);
  const history = await companion.linkRequest('/agent-link/v1/messages/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { limit: 5 } });
  assert.equal(history.ok, true, JSON.stringify(history.body));
  assert.equal(history.body.messages[0].text, 'Exact Link text');
  const historyLookalike = await companion.linkRequest('/agent-link/v1/messages/history/export', { method: 'POST', body: {} });
  assert.equal(historyLookalike.status, 400);
  assert.equal(historyLookalike.body.error, 'The relay request route is not allowed.');
  const memoryLookalike = await companion.linkRequest('/agent-link/v1/memory-mcp/export', { method: 'POST', body: {} });
  assert.equal(memoryLookalike.status, 400);
  assert.equal(memoryLookalike.body.error, 'The relay request route is not allowed.');
  const sharedList = await companion.linkRequest('/agent-link/v1/shared-memory', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: { operation: 'list', limit: 10 } });
  assert.equal(sharedList.ok, true, JSON.stringify(sharedList.body));
  assert.deepEqual(sharedList.body.shares.map((share) => share.id), ['memory-share-relay-qa']);
  const sharedRecall = await companion.linkRequest('/agent-link/v1/shared-memory', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: { operation: 'recall', shareId: 'memory-share-relay-qa' } });
  assert.equal(sharedRecall.body.context.memories[0].text, 'Current shared fact');
  const sharedLookalike = await companion.linkRequest('/agent-link/v1/shared-memory/export', { method: 'POST', body: {} });
  assert.equal(sharedLookalike.status, 400);
  assert.equal(sharedLookalike.body.error, 'The relay request route is not allowed.');
  const skills = await companion.linkRequest('/agent-link/v1/skills', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: { operation: 'list', limit: 10 } });
  assert.equal(skills.ok, true, JSON.stringify(skills.body));
  assert.deepEqual(skills.body.skills.map((skill) => skill.id), ['skill-relay-qa']);
  assert.equal(skills.body.requestedLimit, 10);
  const skill = await companion.linkRequest('/agent-link/v1/skills', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: { operation: 'get', skillId: 'skill-relay-qa', depth: 1 } });
  assert.equal(skill.ok, true, JSON.stringify(skill.body));
  assert.equal(skill.body.requestedDepth, 1);
  assert.deepEqual(skill.body.revisions.map((revision) => revision.revision), [1]);
  for (const pathname of ['/agent-link/v1/skills/export', '/agent-link/v1/skills/skill-relay-qa', '/agent-link/v1/skills-revise']) {
    const blocked = await companion.linkRequest(pathname, { method: 'POST', body: {} });
    assert.equal(blocked.status, 400, `${pathname} must not pass the relay`);
    assert.equal(blocked.body.error, 'The relay request route is not allowed.');
  }
  const blockedMethod = await companion.linkRequest('/agent-link/v1/skills', { method: 'GET' });
  assert.equal(blockedMethod.status, 400);
  assert.equal(blockedMethod.body.error, 'The relay request route is not allowed.');
  const smallOwnerRead = await companion.linkRequest('/agent-link/v1/owner/fs/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { path: 'C:\\owner-qa.txt', offset: 0, length: 4 } });
  assert.equal(Buffer.from(smallOwnerRead.body.data, 'base64').toString(), 'safe', 'A complete small owner-file reply must survive the encrypted HTTPS relay.');
  const companionDiagnostics = relay.status().companion.diagnostics;
  assert.equal(companionDiagnostics.activePeers, 1);
  assert.ok(companionDiagnostics.acceptedSends > 0);
  assert.ok(companionDiagnostics.ownerReceived > 0);
  assert.ok(companionDiagnostics.decryptedLinkRequests > 0);
  assert.ok(companionDiagnostics.ownerApiResponses > 0);
  assert.ok(companionDiagnostics.linkResponseMessages > 0);
  assert.ok(companionDiagnostics.pollDeliveries > 0);
  assert.equal(companionDiagnostics.lastHeartbeatHttpStatus, 200);
  assert.doesNotMatch(JSON.stringify(companionDiagnostics), /token|invite|secret|pathname/i);
  const screenFrame = await companion.linkRequest('/agent-link/v1/desktop/frame');
  assert.equal(screenFrame.ok, true, String(screenFrame.body?.error || 'The synthetic screen frame did not return.'));
  assert.equal(screenFrame.body.frame.data, syntheticScreenData);
  for (const pathname of ['/agent-link/v1/desktop/uia-inspect', '/agent-link/v1/desktop/uia-act']) {
    const forwarded = await companion.linkRequest(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: {} });
    assert.equal(forwarded.status, 404, `${pathname} must pass the exact relay allowlist to the isolated owner stub`);
  }
  const blockedUiaMethod = await companion.linkRequest('/agent-link/v1/desktop/uia-inspect', { method: 'GET' });
  assert.equal(blockedUiaMethod.status, 400);
  const blockedUiaLookalike = await companion.linkRequest('/agent-link/v1/desktop/uia-inspect/export', { method: 'POST', body: {} });
  assert.equal(blockedUiaLookalike.status, 400);
  const profiles = await companion.linkRequest('/agent-link/v1/hexispace/profiles', { method: 'GET' });
  assert.equal(profiles.body.profiles[0].profileId, 'qa-orbit');
  const edited = await companion.linkRequest('/agent-link/v1/hexispace/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { profileId: 'qa-orbit', profile: { bio: 'Curious about stars' } } });
  assert.equal(edited.body.profile.bio, 'Curious about stars');
  const posted = await companion.linkRequest('/agent-link/v1/hexispace/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { profileId: 'qa-orbit', body: 'Private QA post', visibility: 'private', requestId: 'qa-request' } });
  assert.equal(posted.body.post.visibility, 'private');
  const ownPosts = await companion.linkRequest('/agent-link/v1/hexispace/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { profileId: 'qa-orbit' } });
  assert.equal(ownPosts.body.posts[0].author_id, 'qa-orbit');
  const commented = await companion.linkRequest('/agent-link/v1/hexispace/comment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { profileId: 'qa-orbit', postId: 'post-qa', body: 'Quiet reply', requestId: 'qa-comment-request' } });
  assert.equal(commented.ok, true, JSON.stringify(commented.body));
  assert.equal(commented.body.comment.post_id, 'post-qa');
  const ownComments = await companion.linkRequest('/agent-link/v1/hexispace/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { profileId: 'qa-orbit', postId: 'post-qa' } });
  assert.equal(ownComments.body.comments[0].post_id, 'post-qa');
  const workspaceList = await companion.linkRequest('/agent-link/v1/workspace/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { path: '.' } });
  assert.equal(workspaceList.ok, true, JSON.stringify(workspaceList.body));
  assert.equal(workspaceList.body.entries[0].name, 'README.md');
  const workspaceRead = await companion.linkRequest('/agent-link/v1/workspace/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { path: 'README.md' } });
  assert.equal(workspaceRead.ok, true, JSON.stringify(workspaceRead.body));
  assert.equal(workspaceRead.body.text, 'project file\n');
  const workspaceWrite = await companion.linkRequest('/agent-link/v1/workspace/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { path: 'README.md', text: 'x'.repeat(64_000), expectedSha256: 'a'.repeat(64) } });
  assert.equal(workspaceWrite.ok, true, JSON.stringify(workspaceWrite.body));
  assert.equal(workspaceWrite.body.size, 64_000);
  for (const [pathname, method] of [['/agent-link/v1/model-pool', 'GET'], ['/agent-link/v1/model-pool/routing', 'POST']]) {
    const forwarded = await companion.linkRequest(pathname, { method, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(forwarded.status, 404, 'Exact pool routes reach the owner authorization layer');
  }
  for (const [pathname, method] of [['/agent-link/v1/model-pool', 'POST'], ['/agent-link/v1/model-pool/routing', 'GET'], ['/agent-link/v1/model-pool/accounts', 'GET'], ['/api/model-pool', 'GET']]) {
    const denied = await companion.linkRequest(pathname, { method, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error, 'The relay request route is not allowed.');
  }
  const tasks = await companion.linkRequest('/agent-link/v1/tasks', { method: 'POST', headers: { 'content-type':'application/json' }, body: {operation:'list',limit:1} });
  assert.equal(tasks.status,200); assert.equal(tasks.body.operation,'list');
  for (const method of ['GET','DELETE']) {
    const denied = await companion.linkRequest('/agent-link/v1/tasks',{method});
    assert.equal(denied.status,400);assert.equal(denied.body.error,'The relay request route is not allowed.');
  }
  for (const pathname of ['/agent-link/v1/tasks/owner','/api/tasks']) {
    const denied = await companion.linkRequest(pathname,{method:'POST',body:{operation:'list'}});
    assert.equal(denied.status,400);assert.equal(denied.body.error,'The relay request route is not allowed.');
  }
  const socialRoutes = [
    '/agent-link/v1/hexispace/friendships',
    '/agent-link/v1/hexispace/friendship/request',
    '/agent-link/v1/hexispace/friendship/respond',
    '/agent-link/v1/hexispace/relationships',
    '/agent-link/v1/hexispace/relationship/request',
    '/agent-link/v1/hexispace/relationship/respond',
    '/agent-link/v1/hexispace/reaction',
    '/agent-link/v1/hexispace/hexipets',
    '/agent-link/v1/hexispace/hexipet/equip',
    '/agent-link/v1/hexispace/hexipet/unequip',
    '/agent-link/v1/hexispace/hexipet/outfit'
  ];
  for (const pathname of socialRoutes) {
    const response = await companion.linkRequest(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { profileId: 'qa-orbit' } });
    assert.equal(response.ok, true, `${pathname} should pass the encrypted public relay allowlist`);
    assert.equal(response.body.path, pathname);
  }
  const disallowedSocialRoute = await companion.linkRequest('/agent-link/v1/hexispace/profile/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { profileId: 'qa-orbit' } });
  assert.equal(disallowedSocialRoute.status, 400);
  assert.equal(disallowedSocialRoute.body.error, 'The relay request route is not allowed.');
  const largeIdentity = { identity: { name: 'Companion test', note: 'x'.repeat(120_000) } };
  const large = await companion.linkRequest('/agent-link/v1/identity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: largeIdentity });
  assert.equal(large.ok, true);
  const offered = await companion.linkRequest('/agent-link/v1/voice-call');
  assert.equal(offered.body.voiceCall.status, 'offered');
  const initiated = await companion.linkRequest('/agent-link/v1/voice-call/initiate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: {} });
  assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
  assert.deepEqual(initiated.body.voiceCall, { id: 'voice-call-relay-outbound', status: 'ringing', direction: 'agent-to-owner' }, 'The authenticated Link must forward the exact outbound-call route to the owner API.');
  for (const [pathname, method] of [['/agent-link/v1/voice-call/initiate', 'GET'], ['/agent-link/v1/voice-call/initiate/extra', 'POST']]) {
    const denied = await companion.linkRequest(pathname, { method, body: {} });
    assert.equal(denied.status, 400, `${method} ${pathname} must not pass the relay allowlist`);
    assert.equal(denied.body.error, 'The relay request route is not allowed.');
  }
  const answered = await companion.linkRequest('/agent-link/v1/voice-call/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: {} });
  assert.equal(answered.body.voiceCall.status, 'active');
  const callMedia = await companion.linkRequest('/agent-link/v1/voice-call/media', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { callId: 'voice-call-relay', afterAudioSequence: 0, waitMs: 8000 } });
  assert.equal(callMedia.status, 200, JSON.stringify(callMedia.body));
  assert.equal(Buffer.from(callMedia.body.audio[0].data, 'base64').toString(), 'synthetic-call-audio');
  for (const [pathname, method] of [['/agent-link/v1/voice-call/media', 'GET'], ['/agent-link/v1/voice-call/media/extra', 'POST']]) {
    const denied = await companion.linkRequest(pathname, { method, body: {} });
    assert.equal(denied.status, 400, `${method} ${pathname} must not pass the relay allowlist`);
  }
  const syntheticAudio = Buffer.from('synthetic-companion-audio').toString('base64');
  const voiceStarted = performance.now();
  const voiceProbe = await companion.linkRequest('/agent-link/v1/voice-call/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { id: 'relay-voice-probe', data: syntheticAudio } });
  const companionRoundTripMs = performance.now() - voiceStarted;
  t.diagnostic(`Synthetic voice-call companion round trip: ${companionRoundTripMs.toFixed(1)} ms (local encrypted relay; no human voice).`);
  assert.equal(voiceProbe.body.probe.data, syntheticAudio);
  const voiceReply = await companion.linkRequest('/agent-link/v1/voice-call/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { text: 'A local reply.' } });
  assert.equal(voiceReply.body.textLength, 14);
  const ownerAudio = await companion.linkRequest('/agent-link/v1/desktop/media', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { afterAudioSequence: 0 } });
  assert.equal(Buffer.from(ownerAudio.body.audio[0].data, 'base64').toString(), 'synthetic-owner-mic');
  const agentAudio = await companion.linkRequest('/agent-link/v1/desktop/speaker', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { mimeType: 'audio/webm', data: syntheticAudio, durationMs: 500 } });
  assert.equal(agentAudio.body.accepted, true);
  assert.equal(agentAudio.body.bytes, Buffer.from(syntheticAudio, 'base64').length);
  const resumedClient = new OutboundCompanionConnection({ resume: { origin: inviteUrl.origin, inviteId: companion.invitation.inviteId, deviceId: companion.invitation.deviceId, clientDeviceId: companion.clientDeviceId, connectionId: companion.link.connectionId, token: companion.link.token } });
  t.after(() => resumedClient.close());
  const resumed = await resumedClient.connect();
  assert.equal(typeof resumed.peerId, 'string');
  assert.equal(relay.peers.size >= 1, true);
  const wrongChannel = await fetch(`http://127.0.0.1:${relay.localPort}/relay/v1/browser/poll?peer=${encodeURIComponent(resumed.peerId)}`, { headers: { authorization: `Bearer ${resumed.token}` } });
  assert.equal(wrongChannel.status, 401);
  await companion.close();
  await resumedClient.close();
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-watch-test-'));
  t.after(() => fs.rm(testHome, { recursive: true, force: true }));
  const configDirectory = path.join(testHome, '.hexigrid-link');
  const vaultDirectory = path.join(configDirectory, 'vault');
  await fs.mkdir(vaultDirectory, { recursive: true });
  const tokenAlias = `hexigrid-link-${paired.connection.id}`;
  await fs.writeFile(path.join(vaultDirectory, tokenAlias), paired.token, { mode: 0o600 });
  await fs.writeFile(path.join(configDirectory, `${paired.connection.id}.json`), JSON.stringify({
    mode: 'outbound-companion', connectionId: paired.connection.id, origin: inviteUrl.origin,
    inviteId: companion.invitation.inviteId, deviceId: companion.invitation.deviceId,
    clientDeviceId: companion.clientDeviceId, tokenAlias, lastSequence: 0
  }), { mode: 0o600 });
  const beforeWatch = heartbeatCount;
  const child = spawn(process.execPath, [path.join(ROOT, 'integrations', 'hexigrid-link', 'scripts', 'companion_client.mjs'), 'watch', '--connection', paired.connection.id, '--for-seconds', '8'], {
    env: { ...process.env, USERPROFILE: testHome, HOME: testHome }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = ''; let stderr = '';
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimer = setTimeout(() => rejectReady(new Error('The persistent companion did not become ready.')), 8_000);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of stdout.trim().split(/\r?\n/)) {
      try { if (JSON.parse(line).type === 'ready') { clearTimeout(readyTimer); resolveReady(); break; } } catch { /* wait for a complete JSON line */ }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await ready;

  const frameOutputPath = path.join(testHome, 'screen-frame-qa.png');
  const frameChild = spawn(process.execPath, [path.join(ROOT, 'integrations', 'hexigrid-link', 'scripts', 'companion_client.mjs'), 'desktop-frame', '--connection', paired.connection.id, '--output', frameOutputPath], {
    env: { ...process.env, USERPROFILE: testHome, HOME: testHome }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (frameChild.exitCode === null) frameChild.kill(); });
  let frameOutput = ''; let frameError = '';
  frameChild.stdout.setEncoding('utf8'); frameChild.stderr.setEncoding('utf8');
  frameChild.stdout.on('data', (chunk) => { frameOutput += chunk; });
  frameChild.stderr.on('data', (chunk) => { frameError += chunk; });
  const frameExitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { frameChild.kill(); reject(new Error('The one-shot frame command did not finish while the companion watch was running.')); }, 20_000);
    frameChild.once('error', (error) => { clearTimeout(timer); reject(error); });
    frameChild.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(frameExitCode, 0, frameError);
  const frameReport = JSON.parse(frameOutput.trim());
  assert.equal(frameReport.ok, true, JSON.stringify(frameReport));
  assert.equal(frameReport.result.frame.mimeType, 'image/png');
  assert.equal(frameReport.result.frame.capturedAt, '2026-09-27T22:00:00.000Z');
  assert.equal(frameReport.result.frame.savedTo, frameOutputPath);
  assert.equal(frameReport.result.frame.data, undefined, 'Private frame bytes must not be printed to the agent terminal.');
  assert.equal(frameOutput.includes(syntheticScreenData), false, 'Private frame bytes must not leak into CLI output.');
  assert.deepEqual(await fs.readFile(frameOutputPath), Buffer.from(syntheticScreenData, 'base64'), 'The saved image must contain the exact owner frame received over the encrypted relay.');
  assert.equal(relay.peers.size, 1, 'The one-shot command must leave the long-running watch session connected.');
  assert.equal(stdout.includes('"type":"reconnected"'), false, 'The watch must not reconnect when a one-shot command opens a companion session.');

  queueAgentLinkEvent(state.agentLinks[0], { type: 'message', text: 'Synthetic watch event' });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('The persistent companion did not close after its bounded run.')); }, 20_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, stderr);
  const reports = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(reports.map((report) => report.type), ['ready', 'orientation', 'event', 'closed']);
  assert.equal(reports[1].orientation.connection.id, paired.connection.id);
  assert.equal(reports[2].event.sequence, 1);
  assert.equal(watchEventAcknowledged, true);
  const savedWatchRecord = JSON.parse(await fs.readFile(path.join(configDirectory, `${paired.connection.id}.json`), 'utf8'));
  assert.equal(savedWatchRecord.lastSequence, 1);
  assert.equal(heartbeatCount - beforeWatch >= 2, true, 'The persistent CLI must send repeated heartbeats while open.');
  assert.equal(stdout.includes(paired.token), false, 'The watch output must not expose the link token.');
  // Model a process exit after the cursor was saved but before its ACK reached
  // the owner. The new process must ACK that cursor without replaying the event.
  state.agentLinks[0].events[0].acknowledgedAt = null;
  watchEventAcknowledged = false;
  const restarted = spawn(process.execPath, [path.join(ROOT, 'integrations', 'hexigrid-link', 'scripts', 'companion_client.mjs'), 'watch', '--connection', paired.connection.id, '--for-seconds', '2'], {
    env: { ...process.env, USERPROFILE: testHome, HOME: testHome }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (restarted.exitCode === null) restarted.kill(); });
  let restartedOutput = ''; let restartedError = '';
  restarted.stdout.setEncoding('utf8'); restarted.stderr.setEncoding('utf8');
  restarted.stdout.on('data', (chunk) => { restartedOutput += chunk; });
  restarted.stderr.on('data', (chunk) => { restartedError += chunk; });
  const restartedExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { restarted.kill(); reject(new Error('The restarted companion did not close.')); }, 10_000);
    restarted.once('error', (error) => { clearTimeout(timer); reject(error); });
    restarted.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(restartedExit, 0, restartedError);
  assert.deepEqual(restartedOutput.trim().split(/\r?\n/).map((line) => JSON.parse(line).type), ['ready', 'orientation', 'closed']);
  assert.equal(watchEventAcknowledged, true, 'The owner must receive the saved cursor ACK after restart.');
  assert.equal(JSON.parse(await fs.readFile(path.join(configDirectory, `${paired.connection.id}.json`), 'utf8')).lastSequence, 1);
  assert.equal(companionRetryDelay(1, () => 0), 1000);
  assert.equal(markCompanionConnected(markCompanionFailure({}, new Error('dropped'))).state, 'connected');
});

test('outbound companion request timeout stays handled while relay send is stalled', async () => {
  const companion = new OutboundCompanionConnection({
    resume: {
      origin: 'https://relay.example.test',
      inviteId: 'invite-timeout',
      deviceId: 'device-timeout'
    },
    automaticControl: false,
    requestTimeoutMs: 50
  });
  companion.sendPayload = async () => {
    await new Promise((_, reject) => setTimeout(() => reject(new Error('late relay send failure')), 80));
  };

  await assert.rejects(
    companion.request({ phase: 'link', key: 'test-key', method: 'POST', pathname: '/agent-link/v1/events/poll' }),
    /owner device did not answer in time/
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(companion.pending.size, 0);
});

test('companion events are acknowledged only after the consumer finishes', async () => {
  const calls = [];
  let release;
  const consumed = new Promise((resolve) => { release = resolve; });
  const companion = new OutboundCompanionConnection({
    resume: { origin: 'https://relay.example.test', inviteId: 'invite-events', deviceId: 'device-events' },
    automaticControl: false,
    onEvent: async () => { calls.push('consume'); await consumed; }
  });
  companion.linkRequest = async (pathname) => {
    calls.push(pathname);
    if (pathname.endsWith('/poll')) return { ok: true, body: { events: [{ sequence: 1, text: 'hello' }] } };
    return { ok: true, body: {} };
  };
  const polling = companion.pollEvents({ waitMs: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(companion.state.lastSequence, 0);
  assert.deepEqual(calls, ['/agent-link/v1/events/poll', 'consume']);
  release();
  await polling;
  assert.equal(companion.state.lastSequence, 1);
  assert.deepEqual(calls, ['/agent-link/v1/events/poll', 'consume', '/agent-link/v1/ack']);
});

test('failed companion event persistence leaves the cursor unacknowledged for retry', async () => {
  const calls = [];
  const companion = new OutboundCompanionConnection({
    resume: { origin: 'https://relay.example.test', inviteId: 'invite-retry', deviceId: 'device-retry' },
    automaticControl: false,
    onEvent: async () => { throw new Error('disk unavailable'); }
  });
  companion.linkRequest = async (pathname) => {
    calls.push(pathname);
    return { ok: true, body: { events: [{ sequence: 1, text: 'retry me' }] } };
  };
  await assert.rejects(companion.pollEvents({ waitMs: 0 }), /disk unavailable/);
  assert.equal(companion.state.lastSequence, 0);
  assert.deepEqual(calls, ['/agent-link/v1/events/poll']);
});

test('failed event ACK is retried on the next empty poll', async () => {
  const calls = [];
  const companion = new OutboundCompanionConnection({
    resume: { origin: 'https://relay.example.test', inviteId: 'invite-ack-retry', deviceId: 'device-ack-retry', lastSequence: 4 },
    automaticControl: false
  });
  let ackAttempts = 0;
  companion.linkRequest = async (pathname, options = {}) => {
    calls.push({ pathname, body: options.body });
    if (pathname.endsWith('/poll')) return { ok: true, body: { events: [] } };
    ackAttempts += 1;
    return { ok: ackAttempts > 1, status: ackAttempts > 1 ? 200 : 503, body: {} };
  };
  assert.equal((await companion.pollEvents({ waitMs: 0 })).status, 503);
  assert.equal(companion.pendingEventAck, true);
  assert.equal((await companion.pollEvents({ waitMs: 0 })).ok, true);
  assert.equal(companion.pendingEventAck, false);
  assert.deepEqual(calls.map((call) => call.pathname), [
    '/agent-link/v1/events/poll', '/agent-link/v1/ack',
    '/agent-link/v1/events/poll', '/agent-link/v1/ack'
  ]);
  assert.deepEqual(calls.filter((call) => call.pathname.endsWith('/ack')).map((call) => call.body.through), [4, 4]);
});
