import test from 'node:test';
import assert from 'node:assert/strict';
import { createHexiKeysPluginBindings, hexikeysPluginRecipe } from '../lib/hexikeys-plugin-bindings.mjs';

const grantId = 'a'.repeat(32);
function fixture(overrides = {}) {
  const values = new Map();
  const capability = { id: 'send-key', permissions: { network: [{ origin: 'https://service.example', pathPrefix: '/v1', methods: ['POST'], secretHeaders: [{ secret: 'api-key', header: 'authorization', prefix: 'Bearer ' }] }] } };
  const plugin = { id: 'test-plugin', secrets: [{ id: 'api-key' }], capabilities: [capability] };
  const vault = { get: async id => values.get(id), set: async (id, value) => values.set(id, value), remove: async id => values.delete(id) };
  const consumed = [];
  const service = createHexiKeysPluginBindings({ vault, consume: async (request, context) => { consumed.push({ request, context }); return { value: 'synthetic-private-key', responseMode: 'metadata-only' }; }, authorize: async () => {}, ...overrides });
  const args = { plugin, capability, secretId: 'api-key', actor: 'owner', context: {} };
  const request = { url: 'https://service.example/v1/send', method: 'POST', header: 'authorization', prefix: 'Bearer ', capabilityId: capability.id };
  return { values, plugin, capability, service, consumed, args, request };
}
test('scope and reference bind exact plugin capability secret and recipient; no raw value is stored', async () => {
  const f = fixture();
  const own = hexikeysPluginRecipe(f.plugin, f.capability, 'api-key', 'owner');
  const agent = hexikeysPluginRecipe(f.plugin, f.capability, 'api-key', 'link:one:agent');
  assert.notEqual(own.taskId, agent.taskId);
  assert.deepEqual(own.methods, ['POST']);
  await f.service.set({ ...f.args, grantId });
  assert.equal((await f.service.get(f.plugin, f.capability, 'api-key', 'owner')).grantId, grantId);
  assert.equal(await f.service.get(f.plugin, f.capability, 'api-key', 'link:one:agent'), null);
  const result = await f.service.resolve({ ...f.args, request: { ...f.request, taskId: 'forged', grantId: 'forged', requestId: 'forged' } });
  assert.deepEqual(result, { value: 'synthetic-private-key', responseMode: 'metadata-only' });
  assert.equal(f.consumed[0].request.taskId, own.taskId);
  assert.match(f.consumed[0].request.requestId, /^[0-9a-f]{32}$/);
  assert.equal(f.consumed[0].request.grantId, grantId);
  assert.equal(JSON.stringify([...f.values]).includes('synthetic-private-key'), false);
});
test('missing binding supports static compatibility; corrupt protected binding fails closed', async () => {
  const f = fixture();
  assert.equal(await f.service.resolve({ ...f.args, request: f.request }), null);
  f.values.set('hexikeys-plugin-test-plugin', '{bad');
  await assert.rejects(f.service.resolve({ ...f.args, request: f.request }), /references are unavailable/);
  assert.equal(f.consumed.length, 0);
});

test('removing a static-only plugin does not introduce vault-addon authority requirements', async () => {
  const f = fixture({ authorize: async () => { throw new Error('addon authority absent'); } });
  await f.service.removePlugin(f.plugin, {});
  assert.equal(f.values.size, 0);
});
test('denied post-save authority restores the prior protected value', async () => {
  let checks = 0;
  const f = fixture({ authorize: async () => { checks += 1; if (checks === 3) throw new Error('revoked'); } });
  await assert.rejects(f.service.set({ ...f.args, grantId }), /revoked/);
  assert.equal(f.values.size, 0);
});
test('reference resolution refuses mismatched capability, non-HTTPS and query-bearing broker context', async () => {
  const f = fixture();
  await f.service.set({ ...f.args, grantId });
  for (const request of [{ ...f.request, capabilityId: 'wrong' }, { ...f.request, url: 'http://service.example/v1' }, { ...f.request, url: 'https://service.example/v1?key=private' }]) {
    await assert.rejects(f.service.resolve({ ...f.args, request }));
  }
  assert.equal(f.consumed.length, 0);
});
test('remove affects only the selected recipient and validates declared reference shape', async () => {
  const f = fixture();
  await f.service.set({ ...f.args, grantId });
  await f.service.set({ ...f.args, actor: 'link:one:agent', grantId });
  await f.service.set({ ...f.args, grantId: null });
  assert.equal(await f.service.get(f.plugin, f.capability, 'api-key', 'owner'), null);
  assert.equal((await f.service.get(f.plugin, f.capability, 'api-key', 'link:one:agent')).grantId, grantId);
  await assert.rejects(f.service.set({ ...f.args, grantId: 'raw-password' }), /opaque/);
  await assert.rejects(f.service.set({ ...f.args, secretId: 'undeclared', grantId }), /declared/);
  await f.service.removePlugin(f.plugin, {});
  assert.equal(f.values.size, 0);
});
