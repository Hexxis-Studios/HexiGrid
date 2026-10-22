import test from 'node:test';
import assert from 'node:assert/strict';
import { createHexiKeysAddon } from '../lib/hexikeys-addon.mjs';

function fixture(overrides = {}) {
  let paired = true;
  const receipts = [];
  const addon = createHexiKeysAddon({
    withPairing: async callback => callback(paired ? { pipeId: 'protected-host-pipe', key: 'never-public-key' } : null),
    connect: async () => { paired = true; }, disconnect: async () => { paired = false; },
    createClient: () => ({ status: async () => ({ unlocked: true, value: 'never-public-value', grants: [{ itemName: 'private label' }] }), consume: async () => ({ value: 'protected-field', receipt: { status: 'authorized' } }) }),
    authorize: async () => {}, recordReceipt: receipt => receipts.push(receipt), ...overrides
  });
  return { addon, receipts };
}

test('addon public status is a fixed projection and never exposes vault or pairing payloads', async () => {
  const { addon } = fixture();
  const result = await addon.status();
  assert.equal(result.paired, true);
  assert.equal(result.available, true);
  assert.equal(result.unlocked, true);
  assert.equal(Object.hasOwn(result, 'grants'), false);
  assert.equal(/never-public|private label|protected-host-pipe/.test(JSON.stringify(result)), false);
});

test('capture result means form opened only and rechecks authorization after IPC', async () => {
  let allowed = true;
  let closed = 0;
  const { addon, receipts } = fixture({ authorize: async () => { if (!allowed) throw new Error('revoked'); }, createClient: () => ({ requestCapture: async () => ({ opened: true }), close: () => { closed++; } }) });
  assert.deepEqual(await addon.requestCapture({ title: 'Synthetic metadata' }), { opened: true });
  assert.equal(receipts.at(-1).action, 'capture-request');
  assert.equal(closed, 1);
  const revoked = fixture({ authorize: async () => { if (!allowed) throw new Error('revoked'); }, createClient: () => ({ requestCapture: async () => { allowed = false; return { opened: true }; } }) }).addon;
  await assert.rejects(revoked.requestCapture({}), /unavailable/i);
});

test('unavailable and locked vaults are represented truthfully without forwarding diagnostics', async () => {
  const { addon } = fixture({ createClient: () => ({ status: async () => { throw new Error('private-key in diagnostic'); } }) });
  const result = await addon.status();
  assert.deepEqual([result.paired, result.available, result.unlocked], [true, false, false]);
  assert.equal(JSON.stringify(result).includes('private-key'), false);
  const locked = fixture({ createClient: () => ({ status: async () => ({ unlocked: false }) }) }).addon;
  assert.equal((await locked.status()).unlocked, false);
  assert.equal((await locked.status()).available, true);
});

test('status rechecks authorization after IPC and fails closed on revocation', async () => {
  let allowed = true;
  const { addon } = fixture({ authorize: async () => { if (!allowed) throw new Error('revoked'); }, createClient: () => ({ status: async () => { allowed = false; return { unlocked: true }; } }) });
  await assert.rejects(addon.status(), /revoked/);
});

test('trusted use returns the metadata-only broker contract and fixed errors', async () => {
  const { addon } = fixture();
  assert.deepEqual(await addon.consume({ grantId: 'opaque' }), { value: 'protected-field', responseMode: 'metadata-only' });
  const failing = fixture({ createClient: () => ({ consume: async () => { throw new Error('private-key'); } }) }).addon;
  await assert.rejects(failing.consume({}), error => !error.message.includes('private-key') && error.code === 'HEXIKEYS_UNAVAILABLE');
});

test('disconnect cancels active use, invalidates its generation and records a content-free receipt', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let signal;
  const { addon, receipts } = fixture({ createClient: () => ({ consume: async (_request, options) => {
    signal = options.signal; started();
    return new Promise(resolve => options.signal.addEventListener('abort', () => resolve({ value: 'late-private-field' }), { once: true }));
  }, status: async () => ({ unlocked: true }) }) });
  const result = addon.consume({});
  await ready;
  await addon.disconnect();
  await assert.rejects(result, /unavailable/);
  assert.equal(signal.aborted, true);
  assert.deepEqual(receipts, [{ addon: 'hexikeys', action: 'disconnect', status: 'completed' }]);
  assert.equal((await addon.status()).paired, false);
});
