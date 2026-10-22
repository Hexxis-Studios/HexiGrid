import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CredentialVault } from '../lib/vault.mjs';
import {
  HEXIKEYS_PAIRING_CREDENTIAL_ID,
  MAX_HEXIKEYS_PAIRING_DESCRIPTOR_BYTES,
  importHexiKeysPairing,
  readHexiKeysPairingMetadata,
  removeHexiKeysPairing,
  withHexiKeysPairing,
} from '../lib/hexikeys-pairing.mjs';

const PIPE_ID = 'hexikeys-0123456789abcdef0123456789abcdef';
const HMAC_KEY = 'a1'.repeat(32);
const DESCRIPTOR = { version: 1, pipeId: PIPE_ID, hmacKey: HMAC_KEY };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function isolated(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-pairing-test-'));
  try { await run(directory); }
  finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('hexigrid-pairing-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function descriptorBytes(value = DESCRIPTOR) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function fakeVault({ available = true, existing = '' } = {}) {
  const values = new Map(existing ? [[HEXIKEYS_PAIRING_CREDENTIAL_ID, existing]] : []);
  const calls = [];
  return {
    calls,
    values,
    isAvailable: () => available,
    async get(id) { calls.push(['get', id]); return values.get(id) ?? ''; },
    async set(id, value) { calls.push(['set', id]); values.set(id, value); },
    async remove(id) { calls.push(['remove', id]); values.delete(id); },
  };
}

async function writeCiphertext(directory, bytes = Buffer.from('synthetic protected descriptor')) {
  const descriptorPath = path.join(directory, 'hexikeys-pairing.dpapi');
  await fs.writeFile(descriptorPath, bytes);
  return descriptorPath;
}

test('imports strict descriptor through the OS vault, returns only pipe metadata, and clears key buffers', async () => isolated(async directory => {
  const descriptorPath = await writeCiphertext(directory);
  const vault = fakeVault();
  const result = await importHexiKeysPairing({
    descriptorPath,
    vault,
    authorize: async () => true,
    decrypt: async ciphertext => {
      assert.equal(ciphertext.toString(), 'synthetic protected descriptor');
      return descriptorBytes();
    },
  });
  assert.deepEqual(result, { pipeId: PIPE_ID });
  assert.deepEqual(Object.keys(result), ['pipeId']);
  assert.deepEqual(vault.calls.filter(([operation]) => operation === 'set'), [['set', HEXIKEYS_PAIRING_CREDENTIAL_ID]]);
  assert.equal(vault.values.get(HEXIKEYS_PAIRING_CREDENTIAL_ID), JSON.stringify(DESCRIPTOR));
  assert.deepEqual(await readHexiKeysPairingMetadata(vault), { pipeId: PIPE_ID });

  let supplied;
  const helperResult = await withHexiKeysPairing(vault, async value => {
    supplied = value.hmacKey;
    assert.equal(value.pipeId, PIPE_ID);
    assert.equal(Buffer.isBuffer(value.hmacKey), true);
    assert.equal(value.hmacKey.length, 32);
    assert.equal(value.hmacKey.toString('hex'), HMAC_KEY);
    return 'host-helper-result';
  });
  assert.equal(helperResult, 'host-helper-result');
  assert.deepEqual([...supplied], Array(32).fill(0));
}));

test('exact re-import is idempotent while a different pairing is rejected without replacement', async () => isolated(async directory => {
  const descriptorPath = await writeCiphertext(directory);
  const vault = fakeVault();
  const options = { descriptorPath, vault, authorize: async () => true, decrypt: async () => descriptorBytes() };
  await importHexiKeysPairing(options);
  const stored = vault.values.get(HEXIKEYS_PAIRING_CREDENTIAL_ID);
  await importHexiKeysPairing(options);
  assert.equal(vault.values.get(HEXIKEYS_PAIRING_CREDENTIAL_ID), stored);
  assert.equal(vault.calls.filter(([operation]) => operation === 'set').length, 1);

  const different = { ...DESCRIPTOR, pipeId: 'hexikeys-fedcba9876543210fedcba9876543210' };
  await assert.rejects(importHexiKeysPairing({ ...options, decrypt: async () => descriptorBytes(different) }), error => error.code === 'HEXKEYS_PAIRING_EXISTS');
  assert.equal(vault.values.get(HEXIKEYS_PAIRING_CREDENTIAL_ID), stored);
}));

test('wrong shape and invalid pipe or key fail before vault writes; field order remains interoperable', async () => isolated(async directory => {
  const descriptorPath = await writeCiphertext(directory);
  const invalidPayloads = [
    { version: 2, pipeId: PIPE_ID, hmacKey: HMAC_KEY },
    { ...DESCRIPTOR, extra: true },
    { ...DESCRIPTOR, pipeId: 'bad' },
    { ...DESCRIPTOR, hmacKey: 'not-hex' },
  ];
  const vault = fakeVault();
  for (const payload of invalidPayloads) {
    await assert.rejects(
      importHexiKeysPairing({ descriptorPath, vault, authorize: async () => true, decrypt: async () => descriptorBytes(payload) }),
      error => error.code === 'HEXKEYS_PAIRING_INVALID',
    );
  }
  assert.equal(vault.calls.some(([operation]) => operation === 'set'), false);

  const reordered = Buffer.from(JSON.stringify({ hmacKey: HMAC_KEY, pipeId: PIPE_ID, version: 1 }));
  const compatibleVault = fakeVault();
  await importHexiKeysPairing({ descriptorPath, vault: compatibleVault, authorize: async () => true, decrypt: async () => reordered });
  assert.equal(compatibleVault.values.has(HEXIKEYS_PAIRING_CREDENTIAL_ID), true);
}));

test('unavailable decrypt or vault and malformed protected files fail closed', async () => isolated(async directory => {
  const descriptorPath = await writeCiphertext(directory);
  const vault = fakeVault();
  await assert.rejects(
    importHexiKeysPairing({ descriptorPath, vault, authorize: async () => true, decrypt: async () => { throw Error('synthetic DPAPI unavailable'); } }),
    error => error.code === 'HEXKEYS_PAIRING_UNAVAILABLE',
  );
  await assert.rejects(
    importHexiKeysPairing({ descriptorPath, vault: fakeVault({ available: false }), authorize: async () => true, decrypt: async () => descriptorBytes() }),
    error => error.code === 'HEXKEYS_PAIRING_UNAVAILABLE',
  );
  assert.equal(vault.calls.some(([operation]) => operation === 'set'), false);

  const oversizedPath = await writeCiphertext(directory, Buffer.alloc(MAX_HEXIKEYS_PAIRING_DESCRIPTOR_BYTES + 1, 1));
  await assert.rejects(
    importHexiKeysPairing({ descriptorPath: oversizedPath, vault, authorize: async () => true, decrypt: async () => descriptorBytes() }),
    error => error.code === 'HEXKEYS_PAIRING_INVALID',
  );
  const directoryPath = path.join(directory, 'not-a-file');
  await fs.mkdir(directoryPath);
  await assert.rejects(
    importHexiKeysPairing({ descriptorPath: directoryPath, vault, authorize: async () => true, decrypt: async () => descriptorBytes() }),
    error => error.code === 'HEXKEYS_PAIRING_INVALID',
  );
}));

test('rejects a descriptor path that is a symbolic link', async t => isolated(async directory => {
  const target = await writeCiphertext(directory);
  const link = path.join(directory, 'descriptor-link.dpapi');
  try { await fs.symlink(target, link, 'file'); }
  catch { t.skip('The current Windows account cannot create a symlink.'); return; }
  await assert.rejects(
    importHexiKeysPairing({ descriptorPath: link, vault: fakeVault(), authorize: async () => true, decrypt: async () => descriptorBytes() }),
    error => error.code === 'HEXKEYS_PAIRING_INVALID',
  );
}));

test('authorization is rechecked after deferred decrypt and revocation after write rolls back the exact prior state', async () => isolated(async directory => {
  const descriptorPath = await writeCiphertext(directory);
  const vault = fakeVault();
  let authorize = true;
  let startedDecrypt;
  let releaseDecrypt;
  const decryptStarted = new Promise(resolve => { startedDecrypt = resolve; });
  const decryptGate = new Promise(resolve => { releaseDecrypt = resolve; });
  const pendingImport = importHexiKeysPairing({
    descriptorPath,
    vault,
    authorize: async () => authorize,
    decrypt: async () => { startedDecrypt(); await decryptGate; return descriptorBytes(); },
  });
  await decryptStarted;
  authorize = false;
  releaseDecrypt();
  await assert.rejects(pendingImport, error => error.code === 'HEXKEYS_PAIRING_UNAUTHORIZED');
  assert.equal(vault.values.has(HEXIKEYS_PAIRING_CREDENTIAL_ID), false);

  authorize = true;
  let setCompleted;
  let releaseSet;
  const setGate = new Promise(resolve => { releaseSet = resolve; });
  const setStarted = new Promise(resolve => { setCompleted = resolve; });
  const originalSet = vault.set.bind(vault);
  vault.set = async (id, value) => {
    await originalSet(id, value);
    setCompleted();
    await setGate;
  };
  const lateRevocation = importHexiKeysPairing({ descriptorPath, vault, authorize: async () => authorize, decrypt: async () => descriptorBytes() });
  await setStarted;
  authorize = false;
  releaseSet();
  await assert.rejects(lateRevocation, error => error.code === 'HEXKEYS_PAIRING_UNAUTHORIZED');
  assert.equal(vault.values.has(HEXIKEYS_PAIRING_CREDENTIAL_ID), false);
  assert.equal(vault.calls.filter(([operation]) => operation === 'remove').length, 1);
}));

test('remove is serialized with import and restores the exact pairing if authorization expires after removal', async () => isolated(async directory => {
  const descriptorPath = await writeCiphertext(directory);
  const vault = fakeVault();
  await importHexiKeysPairing({ descriptorPath, vault, authorize: async () => true, decrypt: async () => descriptorBytes() });
  const previous = vault.values.get(HEXIKEYS_PAIRING_CREDENTIAL_ID);
  await assert.rejects(
    removeHexiKeysPairing({ vault, authorize: async ({ phase }) => phase !== 'after-write' }),
    error => error.code === 'HEXKEYS_PAIRING_UNAUTHORIZED',
  );
  assert.equal(vault.values.get(HEXIKEYS_PAIRING_CREDENTIAL_ID), previous);
  const setCallsBeforeRetry = vault.calls.filter(([operation]) => operation === 'set').length;

  const responses = await Promise.all([
    importHexiKeysPairing({ descriptorPath, vault, authorize: async () => true, decrypt: async () => descriptorBytes() }),
    importHexiKeysPairing({ descriptorPath, vault, authorize: async () => true, decrypt: async () => descriptorBytes() }),
  ]);
  assert.deepEqual(responses, [{ pipeId: PIPE_ID }, { pipeId: PIPE_ID }]);
  assert.equal(vault.calls.filter(([operation]) => operation === 'set').length, setCallsBeforeRetry);

  const removed = await removeHexiKeysPairing({ vault, authorize: async () => true });
  assert.deepEqual(removed, { removed: true });
  assert.equal(vault.values.has(HEXIKEYS_PAIRING_CREDENTIAL_ID), false);
  assert.deepEqual(await readHexiKeysPairingMetadata(vault), null);
}));

test('Windows import sends protected input on stdin and keeps descriptor key out of argv', { skip: process.platform !== 'win32' }, async () => isolated(async directory => {
  const protectedBytes = Buffer.from('ciphertext bytes');
  const plaintext = descriptorBytes();
  const descriptorPath = await writeCiphertext(directory, protectedBytes);
  const vault = fakeVault();
  let childInput = '';
  let argumentsSeen;
  const spawnImpl = (command, args) => {
    argumentsSeen = [command, ...args];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      on() {},
      end(value) {
        childInput = value;
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(plaintext.toString('base64')));
          child.emit('close', 0);
        });
      },
    };
    child.kill = () => {};
    return child;
  };
  const result = await importHexiKeysPairing({ descriptorPath, vault, authorize: async () => true, spawnImpl });
  assert.deepEqual(result, { pipeId: PIPE_ID });
  assert.equal(childInput, protectedBytes.toString('base64'));
  assert.equal(argumentsSeen.includes(HMAC_KEY), false);
  assert.equal(argumentsSeen[0], 'powershell.exe');
}));

test('real Python-to-Node Windows DPAPI CurrentUser descriptor round trip', { skip: process.platform !== 'win32' }, async () => isolated(async directory => {
  const pythonRoot = path.join(ROOT, 'integrations', 'hexikeys');
  const pythonExe = 'python';
  const pythonScript = 'import sys; from vault_pairing import create_pairing_descriptor; print(create_pairing_descriptor(sys.argv[1]))';
  const created = spawnSync(pythonExe, ['-c', pythonScript, directory], {
    cwd: pythonRoot,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(created.error, undefined, 'Python descriptor creation failed');
  assert.equal(created.status, 0, 'Python descriptor creation failed');
  const pipeId = created.stdout.trim();
  assert.match(pipeId, /^hexikeys-[0-9a-f]{32}$/);
  const descriptorPath = path.join(directory, 'hexikeys-pairing.dpapi');
  const protectedBytes = await fs.readFile(descriptorPath);
  assert.equal(protectedBytes.includes(Buffer.from(pipeId)), false, 'descriptor contains plaintext metadata');
  const vault = new CredentialVault(path.join(directory, 'grid-credential-vault'));
  assert.equal(vault.isAvailable(), true, 'Windows credential vault is unavailable');
  const imported = await importHexiKeysPairing({ descriptorPath, vault, authorize: async () => true });
  assert.deepEqual(imported, { pipeId });
  let keyHex = '';
  let keyBuffer;
  await withHexiKeysPairing(vault, async ({ hmacKey }) => { keyBuffer = hmacKey; keyHex = hmacKey.toString('hex'); });
  assert.equal(keyBuffer.length, 32);
  assert.deepEqual([...keyBuffer], Array(32).fill(0));
  const protectedCredential = await fs.readFile(vault.file(HEXIKEYS_PAIRING_CREDENTIAL_ID), 'utf8');
  assert.equal(protectedCredential.includes(keyHex), false, 'credential file contains the plaintext key');

  const reopenedVault = new CredentialVault(vault.directory);
  assert.deepEqual(await readHexiKeysPairingMetadata(reopenedVault), { pipeId });
  await importHexiKeysPairing({ descriptorPath, vault: reopenedVault, authorize: async () => true });
  let reopenedKey = '';
  await withHexiKeysPairing(reopenedVault, async ({ hmacKey }) => { reopenedKey = hmacKey.toString('hex'); });
  assert.equal(reopenedKey, keyHex);
}));
