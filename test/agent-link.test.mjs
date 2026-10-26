import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  acceptAgentLinkInvite, acknowledgeAgentLinkEvents, authenticateAgentLink,
  createAgentLinkInvite, normalizeAgentLinks, publicAgentLink, queueAgentLinkEvent,
  readAgentLinkConversation, readAgentLinkEvents, readAgentLinkEventPage, receiveAgentLinkMessage, recordAgentLinkHeartbeat, recordAgentLinkTokenMeasurement,
  revokeAgentLink, signatureFor, toggleOwnerAgentLinkCapabilities, updateAgentLinkCapabilities, waitForAgentLinkEvents
} from '../lib/agent-link.mjs';
import { AGENT_LINK_SKILL_VERSION, agentLinkSkillBundle } from '../lib/agent-link-skill-bundle.mjs';
import { LocalTranscriber } from '../lib/local-transcription.mjs';

const companionClientPath = fileURLToPath(new URL('../integrations/hexigrid-link/scripts/companion_client.mjs', import.meta.url));
const directClientPath = fileURLToPath(new URL('../integrations/hexigrid-link/scripts/link_client.py', import.meta.url));

function signed(token, method, pathname, body = null, nonce = `nonce-${crypto.randomUUID()}`) {
  const timestamp = new Date().toISOString();
  return { method, pathname, body, timestamp, nonce, signature: signatureFor({ token, method, pathname, body, timestamp, nonce }) };
}

test('call transcripts reach a waiting agent across concurrent signed requests', async () => {
  const state = {};
  const invite = createAgentLinkInvite(state, { baseUrl: 'http://localhost:4318', requestedCapabilities: ['messages', 'microphone-listen'] });
  const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret: decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length)), capabilities: ['messages', 'microphone-listen'] });
  const captureConnection = state.agentLinks[0];
  const transcriber = new LocalTranscriber({ finalDelayMs: 10 });
  let finishRecognition;
  const recognition = new Promise(resolve => { finishRecognition = resolve; });
  transcriber.transcribe = () => recognition;
  try {
    transcriber.enqueue(captureConnection, { sequence: 1, mimeType: 'audio/webm', data: 'eA==', speechActive: true }, event => queueAgentLinkEvent(captureConnection, event), { activeCall: true });
    await new Promise(resolve => setTimeout(resolve, 25));
    const pollingConnection = authenticateAgentLink(state, `Bearer ${paired.token}`, signed(paired.token, 'POST', '/agent-link/v1/events/poll', { after: 0, waitMs: 100 }));
    const pending = waitForAgentLinkEvents(pollingConnection, { after: 0, waitMs: 100 });
    authenticateAgentLink(state, `Bearer ${paired.token}`, signed(paired.token, 'GET', '/agent-link/v1/orientation'));
    finishRecognition('Synthetic owner speech');
    await new Promise(resolve => setTimeout(resolve, 120));
    const delivered = await pending;
    assert.equal(delivered.events.find(event => event.type === 'speech.transcript.final')?.text, 'Synthetic owner speech');
    assert.equal(readAgentLinkEvents(state.agentLinks[0], 0).at(-1)?.text, 'Synthetic owner speech');
    revokeAgentLink(state.agentLinks[0]);
    assert.throws(() => queueAgentLinkEvent(captureConnection, { text: 'Must not survive revocation' }), /disconnected/);
  } finally { transcriber.clear(captureConnection.id); }
});

test('companion routed commands call the shared request helper without command-name shadowing', () => {
  const result = spawnSync(process.execPath, [companionClientPath, 'heartbeat'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Supply --connection <value>/);
  assert.doesNotMatch(result.stderr, /command is not a function/i);
});

test('persistent companion command validates bounded lifetime before reading credentials', () => {
  const invalid = spawnSync(process.execPath, [companionClientPath, 'watch', '--for-seconds', '-1'], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--for-seconds must be an integer/);
  const missing = spawnSync(process.execPath, [companionClientPath, 'watch'], { encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Supply --connection <value>/);
});

test('both shipped clients expose owner-reviewed continuity export requests', () => {
  const companion = readFileSync(companionClientPath, 'utf8');
  const direct = readFileSync(directClientPath, 'utf8');
  for (const source of [companion, direct]) {
    assert.match(source, /continuity-request/);
    assert.match(source, /continuity\/export-request/);
  }
});

test('both shipped clients expose signed, read-only skill list and history commands', () => {
  const companion = readFileSync(companionClientPath, 'utf8');
  const direct = readFileSync(directClientPath, 'utf8');
  for (const source of [companion, direct]) {
    assert.match(source, /agent-link\/v1\/skills/);
    assert.match(source, /beforeRevision/);
    assert.match(source, /operation: 'list'|"operation": "list"/);
    assert.match(source, /operation: 'get'|"operation": "get"/);
  }
  const invalidDepth = spawnSync(process.execPath, [companionClientPath, 'skill', '--connection', 'link-test', '--id', 'skill-test', '--depth', '2'], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalidDepth.status, 1);
  assert.match(invalidDepth.stderr, /Skill depth must be 0 or 1/);
  const invalidCursor = spawnSync(process.execPath, [companionClientPath, 'skill', '--connection', 'link-test', '--id', 'skill-test', '--before-revision', '1'], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalidCursor.status, 1);
  assert.match(invalidCursor.stderr, /--before-revision requires --depth 1/);
});

test('both shipped clients and the Link skill expose exact retrieval feedback', async () => {
  const bundle = await agentLinkSkillBundle(
    fileURLToPath(new URL('../integrations/hexigrid-link', import.meta.url)),
    fileURLToPath(new URL('..', import.meta.url))
  );
  const skill = bundle.files.find((file) => file.path === 'SKILL.md')?.content || '';
  const companion = readFileSync(companionClientPath, 'utf8');
  const direct = readFileSync(directClientPath, 'utf8');
  for (const source of [companion, direct]) {
    assert.match(source, /memory-feedback/);
    assert.match(source, /record-retrieval-feedback/);
    assert.match(source, /usefulIds/);
  }
  assert.match(skill, /--retrieval <retrievalId>/);
  assert.match(skill, /Omit `--useful`/);
  assert.match(skill, /same Link/);
  const invalid = spawnSync(process.execPath, [companionClientPath, 'memory-feedback', '--connection', 'link-test', '--retrieval', 'invalid'], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Retrieval ID is invalid/);
  const invalidUseful = spawnSync(process.execPath, [companionClientPath, 'memory-feedback', '--connection', 'link-test',
    '--retrieval', '11111111-1111-4111-8111-111111111111', '--useful', 'wrong-id'], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalidUseful.status, 1);
  assert.match(invalidUseful.stderr, /Useful memory IDs/);
});

test('the shipped Link skill bundle publishes friendship, linked-profile, and reaction commands with the exact three-layer scopes', async () => {
  const bundle = await agentLinkSkillBundle(
    fileURLToPath(new URL('../integrations/hexigrid-link', import.meta.url)),
    fileURLToPath(new URL('..', import.meta.url))
  );
  const skill = bundle.files.find((file) => file.path === 'SKILL.md')?.content || '';
  const client = bundle.files.find((file) => file.path === 'scripts/companion_client.mjs')?.content || '';
  assert.equal(bundle.version, AGENT_LINK_SKILL_VERSION);
  assert.equal(bundle.entrypoint, 'CONNECT.md');
  const setup = bundle.files.find(file => file.path === bundle.entrypoint)?.content || '';
  assert.ok(setup.length > 1000 && setup.length < 8000, 'routine connection instructions stay separate from the full command catalog');
  assert.match(setup, /storage-check/);
  assert.match(setup, /--ephemeral/);
  assert.match(setup, /both the credential and routing record/);
  assert.match(setup, /established voice and personality/);
  assert.match(skill, /identity-anchor markers/);
  assert.match(skill, /--query/);
  assert.match(client, /query: requireFlag\(flags, 'query'\)/);
  assert.match(skill, /memory-entity/);
  assert.match(skill, /voice-call-media/);
  assert.match(skill, /transcribeAudio/);
  assert.match(skill, /capabilities-set --connection/);
  assert.match(client, /commandName === 'capabilities-set'/);
  assert.match(client, /commandName === 'voice-call-media'/);
  assert.match(client, /include-data/);
  assert.match(client, /name: 'recall-entity'/);
  for (const command of ['hexispace-friendships', 'hexispace-friend-request', 'hexispace-friend-respond',
    'hexispace-relationships', 'hexispace-relationship-request', 'hexispace-relationship-respond', 'hexispace-reaction',
    'hexispace-hexipets', 'hexispace-hexipet-equip', 'hexispace-hexipet-unequip', 'hexispace-hexipet-outfit']) {
    assert.match(skill, new RegExp(command));
    assert.match(client, new RegExp(command));
  }
  for (const scope of ['hexispace-friends', 'agent_friends', 'manage_friends', 'hexispace-relationships',
    'agent_relationships', 'manage_relationships', 'hexispace-reactions', 'agent_reactions', '`react`']) {
    assert.ok(skill.includes(scope), `Skill must name approval layer ${scope}`);
  }
  assert.match(skill, /`manage_profile` permission/);
  assert.match(skill, /do not grant pet purchases, coin spending, transfers, gifting/);
  assert.match(skill, /companion_client\.mjs watch --connection/);
  assert.match(skill, /skills --connection/);
  assert.match(skill, /skill --connection/);
  assert.match(skill, /Every new fact starts `unverified`/);
  assert.match(skill, /versioned instructions/);
  for (const command of ['skill-create', 'skill-revise', 'skill-retire']) {
    assert.ok(skill.includes(command));
    assert.ok(client.includes(command));
  }
  assert.match(skill, /high-risk `self_modify`/);
  assert.match(client, /client\.startControlLoops\(\)/);
});

test('direct HTTPS client rejects companion records with transport-specific guidance', () => {
  const source = readFileSync(directClientPath, 'utf8');
  assert.match(source, /record\.get\("mode"\) == "outbound-companion"/);
  assert.match(source, /public relay intentionally does not expose/);
  assert.match(source, /companion_client\.mjs set-origin/);
  assert.match(source, /"mode": "direct-https"/);
});

test('agent link pairs once, intersects capabilities, and stores no raw credentials', () => {
  const state = {}; normalizeAgentLinks(state);
  const created = createAgentLinkInvite(state, { baseUrl: 'https://link.example', requestedCapabilities: ['messages', 'cognition', 'voice'] });
  const secret = new URL(created.invitationUrl).hash.slice('#secret='.length);
  assert.equal(JSON.stringify(state).includes(secret), false);
  const paired = acceptAgentLinkInvite(state, { inviteId: created.invite.id, secret: decodeURIComponent(secret), identity: { name: 'Test iLander' }, capabilities: ['messages', 'voice'] });
  assert.deepEqual(paired.connection.capabilities, ['messages', 'voice']);
  assert.equal(JSON.stringify(state).includes(paired.token), false);
  assert.throws(() => acceptAgentLinkInvite(state, { inviteId: created.invite.id, secret: decodeURIComponent(secret) }), /already used/);
});

test('agent link without platform metadata remains provider-neutral', () => {
  const state = {};
  const invite = createAgentLinkInvite(state, { baseUrl: 'http://127.0.0.1:4318', requestedCapabilities: ['messages'] });
  const secret = decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length));
  const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret, capabilities: ['messages'] });
  assert.equal(paired.connection.identity.name, 'Connected agent');
  assert.equal(paired.connection.identity.framework, 'external');
});

test('owner capability updates are exact, deduplicated, and reject unknown grants atomically', () => {
  const state = {};
  const invite = createAgentLinkInvite(state, { baseUrl: 'https://link.example', requestedCapabilities: ['messages', 'desktop-view'] });
  const secret = decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length));
  const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret, capabilities: ['messages', 'desktop-view'] });
  const connection = state.agentLinks[0];
  assert.deepEqual(updateAgentLinkCapabilities(connection, ['messages', 'workspace-read', 'workspace-read']), {
    previous: ['messages', 'desktop-view'], capabilities: ['messages', 'workspace-read'], added: ['workspace-read'], removed: ['desktop-view'],
    grantsAdded: ['workspace-read'], grantsRemoved: ['desktop-view'], selfManagementEnabled: false
  });
  assert.throws(() => updateAgentLinkCapabilities(connection, ['messages', 'full-access']), (error) => error.code === 'invalid_capabilities' && error.status === 400);
  assert.deepEqual(connection.capabilities, ['messages', 'workspace-read']);
  assert.equal(typeof paired.token, 'string');
});

test('owner-trusted self toggles persist an owner-granted ceiling across normalization', () => {
  const state = { agentLinks: [{ id: 'link-test', tokenHash: 'hash', status: 'connected', trustLevel: 'owner',
    capabilities: ['messages', 'memory-read', 'memory-write'], ownerGrantedCapabilities: ['messages', 'memory-read', 'memory-write'],
    identity: { name: 'Self-toggle QA' }, events: [], messages: [], tokenMeasurements: [], nonces: [] }] };
  normalizeAgentLinks(state);
  const link = state.agentLinks[0];
  assert.deepEqual(toggleOwnerAgentLinkCapabilities(link, ['messages', 'memory-write']).removed, ['memory-read']);
  normalizeAgentLinks(state);
  assert.deepEqual(state.agentLinks[0].capabilities, ['messages', 'memory-write']);
  assert.deepEqual(state.agentLinks[0].ownerGrantedCapabilities, ['messages', 'memory-read', 'memory-write']);
  updateAgentLinkCapabilities(state.agentLinks[0], ['messages', 'memory-read', 'memory-write', 'desktop-view']);
  assert.deepEqual(state.agentLinks[0].capabilities, ['messages', 'memory-write', 'desktop-view'],
    'an unrelated owner grant does not silently resume a paused scope');
  assert.deepEqual(toggleOwnerAgentLinkCapabilities(state.agentLinks[0], ['messages', 'memory-read', 'memory-write']).added, ['memory-read']);
  assert.throws(() => toggleOwnerAgentLinkCapabilities(state.agentLinks[0], ['messages', 'hexispace-posts']),
    (error) => error.status === 403 && error.code === 'capability_not_granted');
});

test('signed agent link rejects replay and tampering', () => {
  const state = {}; const invite = createAgentLinkInvite(state, { baseUrl: 'http://127.0.0.1:4318' });
  const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret: decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length)), capabilities: ['messages'] });
  const request = signed(paired.token, 'POST', '/agent-link/v1/messages', { text: 'hello' });
  assert.equal(authenticateAgentLink(state, `Bearer ${paired.token}`, request).id, paired.connection.id);
  assert.throws(() => authenticateAgentLink(state, `Bearer ${paired.token}`, request), /already used/);
  const tampered = signed(paired.token, 'POST', '/agent-link/v1/messages', { text: 'safe' }); tampered.body = { text: 'changed' };
  assert.throws(() => authenticateAgentLink(state, `Bearer ${paired.token}`, tampered), /signature is invalid/);
});

test('invitation self-management is opt-in, bounded and persists without owner machine trust', () => {
  const state = {};
  const invitation = createAgentLinkInvite(state, { baseUrl: 'https://example.test', requestedCapabilities: ['messages', 'camera-view'], selfManagementEnabled: true });
  const secret = new URLSearchParams(new URL(invitation.invitationUrl).hash.slice(1)).get('secret');
  const paired = acceptAgentLinkInvite(state, { inviteId: invitation.invite.id, secret, capabilities: ['messages', 'camera-view', 'owner-process'] });
  assert.equal(invitation.invite.selfManagementEnabled, true);
  assert.equal(paired.connection.trustLevel, 'scoped');
  assert.deepEqual(paired.connection.selfManageableCapabilities, ['messages', 'camera-view']);
  let link = state.agentLinks[0];
  toggleOwnerAgentLinkCapabilities(link, ['messages']);
  normalizeAgentLinks(state); link = state.agentLinks[0];
  assert.deepEqual(publicAgentLink(link).grantedCapabilities, ['messages', 'camera-view']);
  assert.deepEqual(toggleOwnerAgentLinkCapabilities(link, ['messages', 'camera-view']).added, ['camera-view']);
  assert.throws(() => toggleOwnerAgentLinkCapabilities(link, ['messages', 'camera-view', 'owner-process']), /owner-process/);
  updateAgentLinkCapabilities(link, ['messages', 'camera-view'], { selfManagementEnabled: false });
  normalizeAgentLinks(state); link = state.agentLinks[0];
  assert.deepEqual(publicAgentLink(link).selfManageableCapabilities, []);
  assert.throws(() => toggleOwnerAgentLinkCapabilities(link, ['messages']), /not enabled/);
  const before = structuredClone(link);
  assert.throws(() => updateAgentLinkCapabilities(link, ['messages'], { selfManagementEnabled: 'yes' }));
  assert.deepEqual(link, before, 'invalid policy cannot partially mutate grants');
  updateAgentLinkCapabilities(link, [], { selfManagementEnabled: true });
  normalizeAgentLinks(state);
  assert.deepEqual(publicAgentLink(state.agentLinks[0]).grantedCapabilities, []);
  assert.throws(() => toggleOwnerAgentLinkCapabilities(state.agentLinks[0], ['camera-view']), /camera-view/);
});

test('agent-link invitations expire before pairing and cannot be replayed', () => {
  const state = {};
  const expired = createAgentLinkInvite(state, { baseUrl: 'http://127.0.0.1:4318' });
  state.agentLinkInvites[0].expiresAt = new Date(Date.now() - 1).toISOString();
  const expiredSecret = decodeURIComponent(new URL(expired.invitationUrl).hash.slice('#secret='.length));
  assert.throws(() => acceptAgentLinkInvite(state, { inviteId: expired.invite.id, secret: expiredSecret }), (error) => error.code === 'invitation_expired' && error.status === 410);
});

test('agent link queues, acknowledges, deduplicates, meters, and revokes', () => {
  const state = {}; const invite = createAgentLinkInvite(state, { baseUrl: 'http://localhost:4318', requestedCapabilities: ['messages', 'token-metering'] });
  const secret = decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length));
  const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret, capabilities: ['messages', 'token-metering'] });
  const connection = state.agentLinks[0]; const event = queueAgentLinkEvent(connection, { text: 'hello' });
  assert.equal(readAgentLinkEvents(connection, 0)[0].text, 'hello'); assert.equal(acknowledgeAgentLinkEvents(connection, event.sequence), 1);
  assert.equal(receiveAgentLinkMessage(connection, { clientMessageId: 'message-0001', text: 'hi' }).duplicate, false);
  assert.equal(receiveAgentLinkMessage(connection, { clientMessageId: 'message-0001', text: 'duplicate' }).duplicate, true);
  assert.equal(publicAgentLink(connection).tokenUsage.label, 'not measured yet');
  recordAgentLinkTokenMeasurement(connection, { origin: 'hexigrid', before: 100, after: 100 });
  assert.equal(publicAgentLink(connection).tokenUsage.label, 'zero iLands cognition cost verified');
  recordAgentLinkTokenMeasurement(connection, { origin: 'hexigrid', before: 100, after: 99 });
  assert.match(publicAgentLink(connection).tokenUsage.label, /token-minimizing/);
  revokeAgentLink(connection); assert.throws(() => authenticateAgentLink(state, `Bearer ${paired.token}`, signed(paired.token, 'GET', '/agent-link/v1/events')), (error) => error.code === 'connection_revoked' && error.status === 410);
});

test('link history includes only text exchanged on that exact connection', () => {
  const state = {}; normalizeAgentLinks(state);
  const makeLink = (name) => {
    const invite = createAgentLinkInvite(state, { baseUrl: 'http://127.0.0.1:4318', requestedCapabilities: ['messages'] });
    const paired = acceptAgentLinkInvite(state, {
      inviteId: invite.invite.id,
      secret: decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length)),
      identity: { name }, capabilities: ['messages']
    });
    return state.agentLinks.find((item) => item.id === paired.connection.id);
  };
  const first = makeLink('ExampleAgent');
  const other = makeLink('Other agent');
  const ownerEvent = queueAgentLinkEvent(first, { type: 'message', text: 'Owner hello', metadata: { sender: 'owner' } });
  acknowledgeAgentLinkEvents(first, ownerEvent.sequence);
  queueAgentLinkEvent(first, { type: 'capabilities.changed', text: 'Private control details', metadata: { sender: 'owner' } });
  queueAgentLinkEvent(first, { type: 'message', text: 'Untrusted event', metadata: { sender: 'other' } });
  receiveAgentLinkMessage(first, { clientMessageId: 'history-agent-1', text: 'Agent hello' });
  receiveAgentLinkMessage(first, { clientMessageId: 'history-status-1', type: 'status', text: 'Private status' });
  receiveAgentLinkMessage(other, { clientMessageId: 'history-other-1', text: 'Other connection' });
  const history = readAgentLinkConversation(first);
  assert.equal(history.length, 2);
  assert.deepEqual(history.find((item) => item.direction === 'from-owner'), {
    id: ownerEvent.id, direction: 'from-owner', text: 'Owner hello', createdAt: ownerEvent.createdAt
  });
  assert.equal(history.find((item) => item.direction === 'from-agent')?.text, 'Agent hello');
  assert.equal(readAgentLinkConversation(other).length, 1);
  assert.equal(readAgentLinkConversation(other)[0].text, 'Other connection');
});

test('event long-poll wakes promptly and times out cleanly', async () => {
  const state = {}; const invite = createAgentLinkInvite(state, { baseUrl: 'http://127.0.0.1:4318' });
  const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret: decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length)), capabilities: ['messages', 'status'] });
  const connection = state.agentLinks[0];
  const waiting = waitForAgentLinkEvents(connection, { after: 0, waitMs: 1_000 });
  setTimeout(() => queueAgentLinkEvent(connection, { type: 'capabilities.changed', text: 'Owner changed a capability.' }), 20);
  const delivered = await waiting;
  assert.equal(delivered.timedOut, false); assert.equal(delivered.events.length, 1); assert.equal(delivered.events[0].sequence, 1);
  const empty = await waitForAgentLinkEvents(connection, { after: 1, waitMs: 20 });
  assert.equal(empty.timedOut, true); assert.deepEqual(empty.events, []);
  recordAgentLinkHeartbeat(connection, { clientDeviceId: 'device-a' });
  assert.throws(() => recordAgentLinkHeartbeat(connection, { clientDeviceId: 'device-b' }), (error) => error.code === 'device_mismatch');
  assert.equal(paired.connection.id, connection.id);
});

test('event pages expose remaining events and a retained-history gap without advancing past delivered events', async () => {
  const connection = { id: 'page-qa', status: 'connected', events: [], nextSequence: 1 };
  for (let index = 0; index < 51; index++) queueAgentLinkEvent(connection, { text: 'Synthetic event' });
  const first = await waitForAgentLinkEvents(connection, { after: 0, waitMs: 0 });
  assert.equal(first.events.length, 50); assert.equal(first.nextAfter, 50); assert.equal(first.hasMore, true); assert.equal(first.historyTruncated, false);
  const last = readAgentLinkEventPage(connection, first.nextAfter);
  assert.equal(last.events.length, 1); assert.equal(last.events[0].sequence, 51); assert.equal(last.nextAfter, 51); assert.equal(last.hasMore, false);
  assert.equal(readAgentLinkEventPage(connection, 51).nextAfter, 51);
  for (let index = 51; index < 501; index++) queueAgentLinkEvent(connection, { text: 'Synthetic retained event' });
  const gap = readAgentLinkEventPage(connection, 0);
  assert.equal(gap.oldestAvailableSequence, 2); assert.equal(gap.historyTruncated, true);
  assert.equal(readAgentLinkEventPage(connection, 1).historyTruncated, false);
});

test('non-loopback invitations require HTTPS', () => {
  assert.throws(() => createAgentLinkInvite({}, { baseUrl: 'http://example.com' }), /requires HTTPS/);
});

test('agent links reject generic files scope and expose only the explicit workspace capabilities', () => {
  const state = {};
  const invite = createAgentLinkInvite(state, { baseUrl: 'https://link.example', requestedCapabilities: ['messages', 'files', 'workspace-read'] });
  assert.deepEqual(invite.invite.requestedCapabilities, ['messages', 'workspace-read']);
  const secret = decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length));
  const paired = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret, capabilities: ['messages', 'files', 'workspace-read'] });
  assert.deepEqual(paired.connection.capabilities, ['messages', 'workspace-read']);
});

test('harness jobs are opt-in and survive capability intersection only when granted', () => {
  const state = {};
  const invite = createAgentLinkInvite(state, { baseUrl: 'https://link.example', requestedCapabilities: ['messages', 'harness-jobs'] });
  const secret = decodeURIComponent(new URL(invite.invitationUrl).hash.slice('#secret='.length));
  const without = acceptAgentLinkInvite(state, { inviteId: invite.invite.id, secret, capabilities: ['messages'] });
  assert.deepEqual(without.connection.capabilities, ['messages']);
  const second = createAgentLinkInvite(state, { baseUrl: 'https://link.example', requestedCapabilities: ['messages', 'harness-jobs'] });
  const secondSecret = decodeURIComponent(new URL(second.invitationUrl).hash.slice('#secret='.length));
  const withGrant = acceptAgentLinkInvite(state, { inviteId: second.invite.id, secret: secondSecret, capabilities: ['messages', 'harness-jobs'] });
  assert.equal(withGrant.connection.capabilities.includes('harness-jobs'), true);
});
