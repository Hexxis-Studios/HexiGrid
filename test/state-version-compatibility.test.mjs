import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSupportedLocalState, EncryptedStateStore } from '../lib/local-state.mjs';

const PRIVATE_FIXTURE = 'synthetic private payload sentinel';

class CountingMemoryVault {
  values = new Map();
  writes = 0;
  async get(id) { return this.values.get(id) || ''; }
  async set(id, value) { this.writes++; this.values.set(id, value); }
}

test('supported and legacy local-state versions return the original payload unchanged', () => {
  const payloads = [
    { version: 1, private: PRIVATE_FIXTURE },
    { version: 2, private: PRIVATE_FIXTURE },
    { private: PRIVATE_FIXTURE },
    { version: null, private: PRIVATE_FIXTURE }
  ];
  for (const payload of payloads) {
    const original = structuredClone(payload);
    assert.strictEqual(assertSupportedLocalState(payload), payload);
    assert.deepEqual(payload, original);
  }
});

test('malformed local-state payloads and versions fail with a safe stable error', () => {
  const invalid = [
    null,
    undefined,
    'state',
    2,
    [],
    { version: -1, private: PRIVATE_FIXTURE },
    { version: 1.5, private: PRIVATE_FIXTURE },
    { version: '2', private: PRIVATE_FIXTURE },
    { version: 0, private: PRIVATE_FIXTURE }
  ];
  for (const payload of invalid) {
    assert.throws(() => assertSupportedLocalState(payload), error => {
      assert.equal(error.code, 'STATE_VERSION_UNSUPPORTED');
      assert.doesNotMatch(error.message, new RegExp(PRIVATE_FIXTURE));
      return true;
    });
  }
});

test('future encrypted state is refused without changing the canonical file or vault', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-state-version-'));
  try {
    const file = path.join(directory, 'state.json');
    const vault = new CountingMemoryVault();
    await new EncryptedStateStore(file, vault).write({ version: 3, private: PRIVATE_FIXTURE });
    const canonical = await readFile(file);
    const writesBeforeRead = vault.writes;
    const reader = new EncryptedStateStore(file, vault);

    await assert.rejects(async () => assertSupportedLocalState(await reader.read()), error => {
      assert.equal(error.code, 'STATE_VERSION_UNSUPPORTED');
      assert.doesNotMatch(error.message, new RegExp(PRIVATE_FIXTURE));
      return true;
    });
    assert.deepEqual(await readFile(file), canonical);
    assert.equal(vault.writes, writesBeforeRead);
    await assert.rejects(readFile(reader.previousFile), error => error.code === 'ENOENT');
    await assert.rejects(readFile(reader.restorePointFile), error => error.code === 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('encrypted local-state corruption still rejects without exposing payload data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-state-corruption-'));
  try {
    const file = path.join(directory, 'state.json');
    const vault = new CountingMemoryVault();
    const writer = new EncryptedStateStore(file, vault);
    await writer.write({ version: 2, private: PRIVATE_FIXTURE });
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.tag = Buffer.alloc(16, 0xff).toString('base64url');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(envelope));

    await assert.rejects(new EncryptedStateStore(file, vault).read(), error => {
      assert.match(error.message, /could not be decrypted/);
      assert.doesNotMatch(error.message, new RegExp(PRIVATE_FIXTURE));
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
