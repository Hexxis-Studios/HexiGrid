import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { sanitizeVoiceProfile } from '../lib/live-communication.mjs';

test('duplicate agent route copies only safe profile config and isolates bindings and lineage', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  const duplicateMatch =');
  const end = source.indexOf('  const localContinuityDraftMatch =', start);
  assert.ok(start >= 0 && end > start, 'duplicate handler slice exists');
  const block = source.slice(start, end);

  const sourceAgent = {
    id: 'source-agent',
    name: 'Synthetic profile',
    accountLabel: 'linked-account-sentinel',
    avatar: 'S',
    avatarImage: 'data:image/png;base64,aGVsbG8=',
    avatarModelId: 'synthetic-avatar',
    color: '#123456',
    status: 'connected',
    transport: 'local-opencode',
    harness: 'claude-code',
    ilandsAgentId: 'external-identity-sentinel',
    externalEmail: 'email-identity-sentinel',
    runnerHome: 'runner-home-secret',
    workspacePath: 'workspace-secret',
    personality: 'Retain this personality.',
    instructions: 'Retain these instructions.',
    rules: 'Retain these local rules.',
    voiceProfile: { engine: 'provider', voiceName: 'Synthetic voice', providerId: 'safe-voice-provider', model: 'safe-voice-model', voiceId: 'safe-voice-id' },
    model: 'profile-model',
    memoryLearningModel: 'local-memory-model',
    useGlobalCommunication: false,
    useMemories: false,
    learnFromConversations: true,
    bindings: {
      identities: [{ framework: 'ilands', externalId: 'binding-identity-sentinel', linkId: 'link-grant-sentinel', token: 'binding-secret-sentinel' }],
      cognition: { model: 'bound-model-sentinel' },
      routes: [{ id: 'route-sentinel', destination: 'private-route-sentinel' }],
      tools: { privateTool: { scope: 'private-tool-sentinel', token: 'tool-secret-sentinel' } },
      devices: { pairedDevice: { id: 'device-secret-sentinel' } }
    },
    tags: ['profile-tag', 'local-preference'],
    continuityLineage: { id: 'source-lineage', activeAgentId: 'source-agent', secret: 'lineage-secret-sentinel' },
    continuityDraft: { snapshot: { token: 'draft-secret-sentinel', content: 'transfer-draft-sentinel' } },
    credentials: { apiKey: 'credential-secret-sentinel' },
    unknownPrivateRuntime: { value: 'unknown-runtime-secret-sentinel' }
  };
  const original = JSON.stringify(sourceAgent);
  const state = { settings: { model: 'global-model' }, agents: [sourceAgent], media: [{id:'synthetic-avatar',type:'avatar-model'}] };
  let saves = 0;
  const activities = [];
  const context = vm.createContext({
    pathname: '/api/agents/source-agent/duplicate',
    method: 'POST',
    req: {},
    res: {},
    state,
    findAgent: agentId => state.agents.find(agent => agent.id === agentId),
    now: () => '2026-10-05T12:00:00.000Z',
    id: prefix => prefix === 'agent' ? 'new-agent' : 'unexpected-id',
    allowedModel: modelId => modelId === 'profile-model' ? { id: modelId } : null,
    cleanString: (value, fallback = '') => typeof value === 'string' ? value.trim().slice(0, 12000) : fallback,
    cleanImageData: value => typeof value === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(value) ? value : '',
    sanitizeVoiceProfile,
    validateMemoryLearningModelOverride: value => value === '' || value === 'local-memory-model',
    normalizeContinuityLineage: (_value, { agentId, now }) => ({ id: 'fresh-lineage-' + agentId, activeAgentId: agentId, createdAt: now }),
    addActivity: (...args) => activities.push(args),
    saveState: async () => { saves++; },
    json: (_res, status, body) => ({ status, body })
  });
  const result = await vm.runInContext('(async () => {' + block + '})()', context);

  assert.equal(result.status, 201);
  const copy = result.body.agent;
  assert.equal(state.agents.length, 2);
  assert.strictEqual(state.agents[1], copy);
  assert.equal(saves, 1);
  assert.equal(activities.length, 1);
  assert.equal(JSON.stringify(sourceAgent), original, 'source profile remains untouched');

  assert.equal(copy.id, 'new-agent');
  assert.notEqual(copy.id, sourceAgent.id);
  assert.equal(copy.name, 'Synthetic profile copy');
  assert.equal(copy.accountLabel, 'Independent local profile');
  assert.equal(copy.status, 'local_ready');
  assert.equal(copy.transport, 'local-opencode');
  assert.equal(copy.harness, 'claude-code');
  assert.equal(copy.ilandsAgentId, '');
  assert.equal(copy.externalEmail, '');
  assert.equal(copy.runnerHome, '');
  assert.equal(copy.workspacePath, '');
  assert.equal(copy.avatar, 'S');
  assert.equal(copy.avatarImage, sourceAgent.avatarImage);
  assert.equal(copy.avatarModelId, 'synthetic-avatar');
  assert.equal(copy.color, '#123456');
  assert.equal(copy.personality, sourceAgent.personality);
  assert.equal(copy.instructions, sourceAgent.instructions);
  assert.equal(copy.rules, sourceAgent.rules);
  assert.equal(copy.model, 'profile-model');
  assert.equal(copy.memoryLearningModel, 'local-memory-model');
  assert.equal(copy.useGlobalCommunication, false);
  assert.equal(copy.useMemories, false);
  assert.equal(copy.learnFromConversations, true);
  assert.deepEqual(Array.from(copy.tags), sourceAgent.tags);
  assert.equal(copy.voiceProfile.voiceName, 'Synthetic voice');
  assert.deepEqual(JSON.parse(JSON.stringify(copy.bindings)), {
    identities: [],
    cognition: { model: 'profile-model' },
    routes: [],
    tools: {},
    devices: {}
  });
  assert.deepEqual(JSON.parse(JSON.stringify(copy.continuityLineage)), {
    id: 'fresh-lineage-new-agent',
    activeAgentId: 'new-agent',
    createdAt: '2026-10-05T12:00:00.000Z'
  });
  assert.notEqual(copy.continuityLineage.id, sourceAgent.continuityLineage.id);
  assert.equal(copy.createdAt, '2026-10-05T12:00:00.000Z');
  assert.equal(copy.updatedAt, '2026-10-05T12:00:00.000Z');

  for (const key of ['bindings', 'voiceProfile', 'tags', 'continuityLineage']) {
    assert.notStrictEqual(copy[key], sourceAgent[key], key + ' is independent');
  }
  for (const key of ['identities', 'cognition', 'routes', 'tools', 'devices']) {
    assert.notStrictEqual(copy.bindings[key], sourceAgent.bindings[key], 'bindings.' + key + ' is independent');
  }

  const copyJson = JSON.stringify(copy);
  for (const sentinel of [
    'linked-account-sentinel', 'external-identity-sentinel', 'email-identity-sentinel',
    'runner-home-secret', 'workspace-secret', 'binding-identity-sentinel',
    'link-grant-sentinel', 'binding-secret-sentinel', 'bound-model-sentinel',
    'route-sentinel', 'private-route-sentinel', 'private-tool-sentinel',
    'tool-secret-sentinel', 'device-secret-sentinel', 'lineage-secret-sentinel',
    'draft-secret-sentinel', 'transfer-draft-sentinel', 'credential-secret-sentinel',
    'unknown-runtime-secret-sentinel'
  ]) assert.equal(copyJson.includes(sentinel), false, sentinel + ' is not inherited');

  sourceAgent.transport = 'agent-link';
  sourceAgent.avatarModelId = 'unknown-media';
  const pairedCopy = (await vm.runInContext('(async () => {' + block + '})()', context)).body.agent;
  assert.equal(pairedCopy.transport, 'agent-link', 'provider-neutral profile stays provider-neutral');
  assert.equal(pairedCopy.status, 'not_connected');
  assert.equal(pairedCopy.accountLabel, 'New account');
  assert.equal(pairedCopy.bindings.identities.length, 0);
  assert.equal(pairedCopy.bindings.routes.length, 0);
  assert.equal(pairedCopy.continuityDraft, undefined);
  assert.equal(pairedCopy.avatarModelId, '');
});
