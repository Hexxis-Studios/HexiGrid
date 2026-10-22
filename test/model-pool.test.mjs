import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPool, modelPoolAddress, publicPoolAccounts } from '../lib/model-pool.mjs';

test('pool address is numeric loopback only, never remote or credential-bearing', () => {
  for (const address of ['https://example.com', 'http://localhost:2455', 'http://127.0.0.1@evil.test', 'http://127.0.0.1:2455/foo', 'http://127.0.0.1:2455?token=secret']) assert.throws(() => modelPoolAddress(address));
  assert.equal(modelPoolAddress(), 'http://127.0.0.1:2455');
});
test('status explicitly projects metadata and preserves unknown usage without credential leakage', async () => {
  const raw = { accounts: [{ accountId: 'a', email: 'private@example.test', accessToken: 'secret', auth: { token: 'secret' }, status: 'active', usage: { primaryRemainingPercent: 0, secondaryRemainingPercent: null, monthlyRemainingPercent: 101 }, requestUsage: { requestCount: 3 } }] };
  const accounts = publicPoolAccounts(raw);
  assert.deepEqual(accounts[0].remaining, { primary: 0, secondary: null, monthly: null });
  assert.equal(accounts[0].requests, 3);
  assert.equal(accounts[0].tokens, null);
  assert.deepEqual(accounts[0].credits, { available: null, unlimited: null, balance: null, unit: 'provider-credits' });
  assert.equal(publicPoolAccounts({ accounts: [{ creditsHas: false, creditsBalance: 0 }] })[0].credits.balance, 0);
  assert.equal(publicPoolAccounts({ accounts: [{ creditsHas: true, creditsBalance: 500 }] })[0].credits.balance, 500);
  assert.doesNotMatch(JSON.stringify(accounts), /secret|private@|accessToken|auth/);
  const pool = createModelPool({ fetcher: async url => Response.json(url.includes('/api/dashboard/overview') ? raw : { routingStrategy: 'capacity_weighted', stickyThreadsEnabled: true, version: 2, apiKey: 'secret' }) });
  const result = await pool.status();
  assert.equal(result.accounts.length, 1);
  assert.equal(result.settings.version, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});
test('routing changes are narrow, versioned and reauthorized after async read', async () => {
  const calls = [];
  const pool = createModelPool({ fetcher: async (url, init) => { calls.push(init); return Response.json({ routingStrategy: 'capacity_weighted', stickyThreadsEnabled: true, version: 3 }); } });
  const input = { routingStrategy: 'round_robin', stickyThreadsEnabled: true, expectedVersion: 3 };
  await assert.rejects(pool.updateRouting({ ...input, apiKey: 'secret' }), /Only routing/);
  await assert.rejects(pool.updateRouting({ ...input, expectedVersion: 2 }), /changed/);
  calls.length = 0; let checks = 0;
  await assert.rejects(pool.updateRouting(input, () => { if (++checks === 2) throw Error('revoked'); }), /revoked/);
  assert.equal(calls.length, 1);
  calls.length = 0;
  await pool.updateRouting(input);
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].body), { routingStrategy: 'round_robin', stickyThreadsEnabled: true, expectedVersion: 3 });
});
test('locked, redirected, oversized and unreachable services fail without disclosing upstream errors', async () => {
  for (const fetcher of [async () => new Response('private secret', { status: 401 }), async () => { throw Error('secret'); }, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), async () => new Response('not JSON')]) {
    await assert.rejects(createModelPool({ fetcher }).status(), error => !error.message.includes('secret'));
  }
});
