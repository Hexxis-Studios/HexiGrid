import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProtectedCredential } from '../lib/vault-storage.mjs';
import { CredentialVault } from '../lib/vault.mjs';

async function isolated(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-vault-storage-'));
  try { await run(directory); }
  finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hexigrid-vault-storage-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('partial protected-file write and sync/rename failures preserve the published credential', async () => isolated(async directory => {
  const target = path.join(directory, 'qa.protected');
  await fs.writeFile(target, 'previous-protected-ciphertext');
  for (const failure of ['write', 'sync', 'rename']) {
    const io = { ...fs,
      async open(...args) {
        const handle = await fs.open(...args);
        return {
          async writeFile(value, encoding) { if (failure === 'write') { await handle.writeFile(value.slice(0, 4), encoding); throw Error('Synthetic partial write'); } await handle.writeFile(value, encoding); },
          async sync() { if (failure === 'sync') throw Error('Synthetic disk sync failure'); await handle.sync(); },
          close: () => handle.close()
        };
      },
      async rename(...args) { if (failure === 'rename') throw Error('Synthetic publication failure'); await fs.rename(...args); }
    };
    await assert.rejects(writeProtectedCredential(target, 'replacement-protected-ciphertext', io), /Synthetic/);
    assert.equal(await fs.readFile(target, 'utf8'), 'previous-protected-ciphertext');
    assert.deepEqual(await fs.readdir(directory), ['qa.protected']);
  }
  await writeProtectedCredential(target, 'complete-protected-ciphertext');
  assert.equal(await fs.readFile(target, 'utf8'), 'complete-protected-ciphertext');
}));

test('actual publication collision preserves destination and ignores older interrupted staging files', async () => isolated(async directory => {
  const target = path.join(directory, 'qa.protected');
  await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep'), 'preserved');
  const interrupted = path.join(directory, 'qa.protected.pending-interrupted');
  await fs.writeFile(interrupted, 'partial-protected-ciphertext');
  await assert.rejects(writeProtectedCredential(target, 'complete-protected-ciphertext'));
  assert.equal(await fs.readFile(path.join(target, 'keep'), 'utf8'), 'preserved');
  assert.equal(await fs.readFile(interrupted, 'utf8'), 'partial-protected-ciphertext');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['qa.protected', 'qa.protected.pending-interrupted']);
}));

test('Windows OS-protected credential replacement survives reopening and ignores interrupted staging', { skip: process.platform !== 'win32' }, async () => isolated(async directory => {
  const vault = new CredentialVault(directory);
  await vault.set('synthetic-roundtrip', 'public-disposable-first');
  const firstBytes = await fs.readFile(vault.file('synthetic-roundtrip'), 'utf8');
  assert.ok(!firstBytes.includes('public-disposable-first'));
  await fs.writeFile(vault.file('synthetic-roundtrip') + '.pending-interrupted', 'partial-ciphertext');
  assert.equal(await new CredentialVault(directory).get('synthetic-roundtrip'), 'public-disposable-first');
  await vault.set('synthetic-roundtrip', 'public-disposable-replacement');
  assert.equal(await new CredentialVault(directory).get('synthetic-roundtrip'), 'public-disposable-replacement');
  assert.equal((await fs.readdir(directory)).filter(name => name.includes('.pending-')).length, 1);
}));
