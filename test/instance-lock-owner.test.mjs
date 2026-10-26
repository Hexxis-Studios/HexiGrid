import test from 'node:test';
import assert from 'node:assert/strict';
import { instanceLockOwnerAlive } from '../lib/instance-lock-owner.mjs';

test('a PID reused after reboot or an exit does not hold an older workspace lock', async () => {
  const lock = { product: 'hexigrid', pid: 16432, createdAt: '2026-10-23T00:25:55.278Z' };
  const exists = () => true;
  assert.equal(await instanceLockOwnerAlive(lock, { exists, startedAt: async () => Date.parse('2026-10-23T22:23:46Z') }), false);
  assert.equal(await instanceLockOwnerAlive(lock, { exists, startedAt: async () => Date.parse('2026-10-23T00:25:54Z') }), true);
  assert.equal(await instanceLockOwnerAlive(lock, { exists: () => false, startedAt: () => { throw Error('Must not query a missing PID'); } }), false);
  assert.equal(await instanceLockOwnerAlive(lock, { exists, startedAt: async () => { throw Error('Access denied'); } }), true);
  assert.equal(await instanceLockOwnerAlive(lock, { exists, startedAt: async () => NaN }), true);
});
