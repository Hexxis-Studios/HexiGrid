import test from 'node:test';
import assert from 'node:assert/strict';
import { agentLinkOrientation } from '../lib/agent-link-orientation.mjs';

test('Codex messaging discovery reveals only this Link’s approved chat and does not inherit another route', () => {
  const link = { id: 'link-ilander', status: 'connected', trustLevel: 'scoped', capabilities: ['messages'] };
  const settings = { codexRelay: { enabled: true, linkId: 'link-muse', threadId: 'thread-private-muse', allowNamedThreads: true,
    routes: [{ enabled: true, linkId: link.id, threadId: 'thread-ilander-123', forwardReplies: true }] } };
  const orientation = agentLinkOrientation(link, settings);
  assert.equal(orientation.codexMessaging.enabled, true);
  assert.equal(orientation.codexMessaging.defaultThreadId, 'thread-ilander-123');
  assert.equal(orientation.codexMessaging.canChooseOtherChats, false);
  assert.match(orientation.codexMessaging.send.clientCommand, /send --connection/);
  assert.doesNotMatch(JSON.stringify(orientation), /thread-private-muse|link-muse/);
  assert.equal(agentLinkOrientation({ ...link, id: 'link-unknown' }, settings).codexMessaging.enabled, false);
});

test('orientation reflects only active grants and does not infer owner preferences', () => {
  const connection = { id: 'link-one', agentId: 'agent-one', status: 'connected', trustLevel: 'scoped', capabilities: ['messages', 'memory-read'] };
  connection.identity = { name: 'Synthetic QA agent' };
  connection.tokenHash = 'private-test-hash';
  connection.credential = 'private-test-credential';
  connection.lastHeartbeatAt = new Date().toISOString();
  const scoped = agentLinkOrientation(connection, { workMode: 'plan', approvalPolicy: 'ask' });
  assert.equal(scoped.connection.trustLevel, 'scoped');
  assert.equal(scoped.connection.name, 'Synthetic QA agent');
  assert.equal(scoped.connection.health.state, 'online');
  assert.match(scoped.connectionLifecycle.resumeCommand, /status --connection link-one/);
  assert.equal(scoped.connectionLifecycle.skill.path, '/agent-link/skill');
  assert.match(scoped.observation.camera, /camera-snapshot/);
  assert.equal(scoped.policy.workMode, 'plan');
  assert.equal(scoped.ownerRelationship.integrationDepth, 'ask-owner');
  assert.deepEqual(scoped.available.map((item) => item.capability), ['messages', 'memory-read']);
  assert.doesNotMatch(JSON.stringify(scoped), /private-test-hash|private-test-credential|"tokenHash"|"credential"/);
  connection.trustLevel = 'owner';
  connection.capabilities = ['messages', 'owner-process'];
  const changed = agentLinkOrientation(connection, { workMode: 'build', approvalPolicy: 'full' });
  assert.deepEqual(changed.available.map((item) => item.capability), ['messages', 'owner-process']);
  assert.equal(changed.policy.workMode, 'build');
  assert.equal(changed.available.some((item) => item.capability === 'memory-read'), false);
});

test('memory-read orientation teaches safe integrity diagnosis without granting repair authority', () => {
  const link = { id: 'memory-recovery', status: 'connected', trustLevel: 'owner', capabilities: ['memory-read'] };
  const orientation = agentLinkOrientation(link);
  const memory = orientation.available.find(item => item.capability === 'memory-read');
  assert.match(memory.use, /trustBoundary v1/);
  assert.match(memory.use, /follow its supplied recoveryTool/);
  assert.match(memory.use, /inspect-memory-health/);
  assert.match(memory.use, /preserve stored history/);
  assert.match(memory.use, /never edit memory files or retry a write blindly/);
  assert.deepEqual(orientation.capabilities, ['memory-read']);
});

test('UIA discovery uses existing desktop grants and does not advertise missing authority', () => {
  const link = { id: 'link-desktop', status: 'connected', capabilities: ['desktop-view', 'desktop-control', 'desktop-type'] };
  const orientation = agentLinkOrientation(link, { workMode: 'plan' });
  assert.deepEqual(orientation.capabilities, link.capabilities);
  const methods = orientation.available.flatMap(item => item.methods || []);
  assert.equal(methods.length, 3);
  assert.equal(methods[0].path, '/agent-link/v1/desktop/uia-inspect');
  assert.equal(methods[1].body.action.kind, 'toggle');
  assert.equal(methods[2].body.action.kind, 'set-value');
  assert.match(orientation.policy.rule, /checked again/);
  methods[0].body.changed = true;
  assert.deepEqual(agentLinkOrientation(link).available[0].methods[0].body, {});
  link.capabilities = ['desktop-control', 'desktop-type'];
  assert.equal(agentLinkOrientation(link).available.some(item => item.methods), false);
  link.capabilities = ['desktop-view'];
  assert.equal(agentLinkOrientation(link).available.flatMap(item => item.methods || []).length, 1);
  link.capabilities = ['messages'];
  assert.equal(agentLinkOrientation(link).available.flatMap(item => item.methods || []).some(method => method.path.includes('/desktop/')), false);
});


test('owner usage and permanent erasure discovery requires the exact advertised grants and trust', () => {
  const link = { id: 'synthetic', status: 'connected', trustLevel: 'owner', capabilities: ['owner-filesystem-read', 'memory-write', 'owner-process'] };
  const methods = () => agentLinkOrientation(link).available.flatMap(item => item.methods || []);
  assert.deepEqual(methods().map(item => item.method), ['POST', 'DELETE', 'GET', 'PUT']);
  assert.match(methods()[1].guidance, /explicitly authorized deletion/);
  assert.match(methods()[1].guidance, /503 memory_erasure_cleanup_pending/);
  assert.match(methods()[2].guidance, /not provider balances/);
  link.trustLevel = 'scoped'; assert.equal(methods().length, 1);
  assert.equal(methods()[0].body.params.name, 'propose-memory');
  link.trustLevel = 'owner'; link.capabilities = ['memory-write']; assert.equal(methods().length, 1);
  link.capabilities = ['owner-process']; assert.equal(methods().length, 1);
  assert.equal(methods()[0].path, '/agent-link/v1/usage/budget');
  assert.match(methods()[0].guidance, /Provider-key setup remains host-only/);
  link.capabilities = ['owner-filesystem-read']; assert.equal(methods().length, 1);
  assert.equal(methods()[0].path, '/agent-link/v1/usage');
});

test('signed task orientation teaches paused creation and existing bounded execution without identity or approval overrides', () => {
  const link = { id: 'synthetic', status: 'connected', capabilities: ['tasks'] };
  const method = agentLinkOrientation(link).available[0].methods[0];
  assert.equal(method.path, '/agent-link/v1/tasks');
  assert.equal(method.body.intervalSeconds, 0); assert.equal(method.body.maxRuns, 1); assert.equal(method.body.maxRetries, 0);
  assert.equal(Object.hasOwn(method.body, 'agentId'), false); assert.equal(Object.hasOwn(method.body, 'approved'), false);
  assert.match(method.guidance, /paused task/); assert.match(method.guidance, /configured HexiGrid cognition route/);
  method.body.maxRuns = 99;
  assert.equal(agentLinkOrientation(link).available[0].methods[0].body.maxRuns, 1);
  link.capabilities = ['messages']; assert.equal(agentLinkOrientation(link).available.flatMap(item => item.methods || []).some(item => item.path === '/agent-link/v1/tasks'), false);
});

test('owner-note retirement orientation requires exact owner trust and both memory grants', () => {
  const link = { id: 'synthetic-retirement', status: 'connected', trustLevel: 'owner', capabilities: ['memory-read', 'memory-write'] };
  const methods = () => agentLinkOrientation(link).available.flatMap(item => item.methods || []).filter(item => item.body?.params?.name === 'retire-owner-note');
  assert.equal(methods().length, 1);
  const method = methods()[0];
  assert.equal(method.path, '/agent-link/v1/memory-mcp');
  assert.equal(method.risk, 'medium');
  assert.equal(method.body.params.name, 'retire-owner-note');
  assert.deepEqual(Object.keys(method.body.params.arguments), ['id', 'expectedRevision', 'why']);
  assert.match(method.guidance, /no computer session/);
  assert.match(method.guidance, /Exact retry reports duplicate/);
  link.trustLevel = 'scoped'; assert.equal(methods().length, 0);
  link.trustLevel = 'owner'; link.capabilities = ['memory-write']; assert.equal(methods().length, 0);
  link.capabilities = ['memory-read']; assert.equal(methods().length, 0);
});


test('client update distinguishes public origin fetch from signed private requests', () => {
  const orientation = agentLinkOrientation({ status: 'connected', capabilities: [] });
  assert.equal(orientation.clientUpdate.path, '/agent-link/skill');
  assert.equal(orientation.clientUpdate.authentication, 'public code bundle');
  assert.match(orientation.clientUpdate.transport, /direct-origin/);
  assert.match(orientation.clientUpdate.guidance, /no Link token, signature, cookies or redirects/);
  assert.match(orientation.clientUpdate.guidance, /Do not pass this path/);
  assert.match(orientation.clientUpdate.example, /curl --fail --silent --show-error/);
  assert.equal(orientation.available.length, 0);
  assert.match(orientation.signedRequestClient.clientCommand, /exact \/agent-link\/v1\//);
});

test('voice discovery describes existing signed methods and filters missing device grants', () => {
  const link = { id: 'voice-discovery', status: 'connected', trustLevel: 'scoped', capabilities: ['microphone-listen', 'speaker-output', 'desktop-view'] };
  const methods = () => agentLinkOrientation(link).available.flatMap(item => item.methods || []).filter(item => item.path?.includes('/voice-call'));
  assert.deepEqual(methods().map(item => item.path), ['/agent-link/v1/voice-call/initiate', '/agent-link/v1/voice-call/media', '/agent-link/v1/voice-call', '/agent-link/v1/voice-call/answer', '/agent-link/v1/voice-call/probe', '/agent-link/v1/voice-call/reply', '/agent-link/v1/voice-call/end']);
  assert.match(methods()[0].guidance, /Allow\/Deny call prompt/);
  assert.match(methods()[1].guidance, /bounded long poll/);
  assert.match(methods()[1].guidance, /no camera\/speaker data/);
  assert.match(methods()[2].guidance, /not device or speech-readiness proof/);
  assert.match(methods()[3].guidance, /session-only/);
  assert.match(methods()[5].guidance, /1 to 240|runtime supplies cognition/);
  assert.match(methods()[5].guidance, /does not prove playback/);
  assert.match(methods()[5].guidance, /set transcribeAudio only/);
  assert.equal(methods().some(item => item.path.startsWith('/api/')), false);
  link.capabilities = ['microphone-listen', 'speaker-output'];
  assert.deepEqual(methods().map(item => item.path.split('/').at(-1)), ['initiate', 'media', 'voice-call', 'answer', 'probe', 'reply', 'end']);
  link.capabilities = ['microphone-listen']; assert.equal(methods().length, 0);
  link.capabilities = ['speaker-output']; assert.deepEqual(methods().map(item => item.path.split('/').at(-1)), ['end']);
  link.capabilities = []; assert.equal(methods().length, 0);
});
