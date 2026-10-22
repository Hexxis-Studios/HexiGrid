import test from 'node:test';
import assert from 'node:assert/strict';
import { removePlatformCredentials } from '../lib/vault-removal.mjs';

const absent = () => Object.assign(new Error('private platform output'), { exitCode: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' });
const failed = (exitCode = 1, stderr = '') => Object.assign(new Error('private platform output'), { exitCode, stderr });
const remove = (platform, run, strict = true) => removePlatformCredentials('public-qa-reference', { platform, account: 'qa-user', strict, run });

test('Linux strict removal verifies both namespaces, including an already absent item', async () => {
  const calls = [];
  await remove('linux', async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'clear') throw failed();
    return '';
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(call => call.includes('Aveniq')), [false, false, true, true]);
  assert.equal(calls.some(call => call.includes('--unlock')), false);
});

test('Linux retained items and service failures fail safely without disclosing output', async () => {
  for (const behavior of ['retained', 'clear-error', 'search-error', 'missing-tool', 'legacy-error']) {
    await assert.rejects(remove('linux', async (command, args) => {
      if (behavior === 'missing-tool') throw new Error('public synthetic secret');
      if (behavior === 'clear-error' && args[0] === 'clear') throw failed(1, 'public synthetic secret');
      if (behavior === 'search-error' && args[0] === 'search') throw failed(1, 'public synthetic secret');
      if (behavior === 'legacy-error' && args.includes('Aveniq')) throw failed(1, 'public synthetic secret');
      return behavior === 'retained' && args[0] === 'search' ? 'public synthetic secret' : '';
    }), error => error.code === 'VAULT_CLEANUP_FAILED' && error.status === 503 && !error.message.includes('synthetic') && !error.stderr);
  }
});

test('macOS strict deletion verifies absence without requesting passwords', async () => {
  const calls = [];
  await remove('darwin', async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'find-generic-password') throw absent();
    return '';
  });
  assert.equal(calls.length, 4);
  assert.equal(calls.some(call => call.includes('-w')), false);
  await remove('darwin', async () => { throw absent(); });
});

test('macOS rejects retained credentials, ambiguous absence, and legacy deletion failure', async () => {
  for (const behavior of ['retained', 'ambiguous', 'legacy-error', 'verification-error']) {
    await assert.rejects(remove('darwin', async (command, args) => {
      if (behavior === 'ambiguous') throw Object.assign(absent(), { stderr: 'security: locked keychain\n' + absent().stderr });
      if (behavior === 'legacy-error' && args.includes('Aveniq:public-qa-reference')) throw failed(1, 'locked');
      if (args[0] === 'find-generic-password' && behavior !== 'retained') {
        if (behavior === 'verification-error') throw failed(1, 'locked');
        throw absent();
      }
      return '';
    }), { code: 'VAULT_CLEANUP_FAILED' });
  }
});

test('default best-effort removal retains compatibility and attempts both namespaces', async () => {
  for (const platform of ['linux', 'darwin']) {
    let calls = 0;
    await remove(platform, async () => { calls++; throw failed(); }, false);
    assert.equal(calls, 2);
  }
});
