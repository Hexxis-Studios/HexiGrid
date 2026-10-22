import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decryptBackup, encryptBackup } from '../lib/backup.mjs';

const backupSource = readFileSync(fileURLToPath(new URL('../lib/backup.mjs', import.meta.url)), 'utf8');
const wholeAppSource = readFileSync(fileURLToPath(new URL('../lib/whole-app-backup.mjs', import.meta.url)), 'utf8');
const serverSource = readFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8');

function payload(marker = 'sample') {
  return {
    agents: [], rooms: [], marker,
    backup: { version: 3, manifest: { format: 'hexigrid-whole-app-manifest', marker } },
    privateFiles: { version: 1, areas: [], files: [] }
  };
}

function mutateBase64Url(value) {
  const bytes = Buffer.from(value, 'base64url');
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  return bytes.toString('base64url');
}

test('every encryption operation receives a unique 96-bit IV and 128-bit salt', () => {
  const envelopes = Array.from({ length: 128 }, (_, index) => encryptBackup(payload(String(index)), 'synthetic backup review passphrase'));
  assert.equal(new Set(envelopes.map((item) => item.iv)).size, envelopes.length);
  assert.equal(new Set(envelopes.map((item) => item.salt)).size, envelopes.length);
  for (const envelope of envelopes) {
    assert.equal(Buffer.from(envelope.iv, 'base64url').length, 12);
    assert.equal(Buffer.from(envelope.salt, 'base64url').length, 16);
  }
  assert.match(backupSource, /const salt = crypto\.randomBytes\(16\)/);
  assert.match(backupSource, /const iv = crypto\.randomBytes\(12\)/);
});

test('GCM rejects data, tag, IV, and salt tampering before a payload is returned', () => {
  const passphrase = 'synthetic backup review passphrase';
  const envelope = encryptBackup(payload(), passphrase);
  for (const field of ['data', 'tag', 'iv', 'salt']) {
    assert.throws(() => decryptBackup({ ...envelope, [field]: mutateBase64Url(envelope[field]) }, passphrase), /incorrect or.*damaged/i);
  }
  assert.deepEqual(decryptBackup(envelope, passphrase), payload());
});

test('backup KDF parameters and derived-key cleanup are explicit and stable', () => {
  assert.match(backupSource, /scryptSync\(passphrase, salt, 32, \{ N: 1 << 15, r: 8, p: 1, maxmem: 128 \* 1024 \* 1024 \}\)/g);
  assert.match(backupSource, /key\?\.fill\(0\)/);
  assert.match(backupSource, /plaintext\?\.fill\(0\)/);
  assert.match(backupSource, /for \(const chunk of decryptedChunks\) chunk\.fill\(0\)/);
});

test('the whole-app manifest is created before encryption and cannot be supplied outside the envelope', () => {
  assert.match(serverSource, /snapshot\.backup\.manifest = createWholeAppManifest\(snapshot\);/);
  assert.match(serverSource, /const envelope = encryptBackup\(payload, passphrase\);/);
  assert.doesNotMatch(wholeAppSource, /writeEncryptedSnapshot\([^)]*passphrase/);
  assert.match(wholeAppSource, /JSON\.stringify\(envelope\)/);
});

test('scheduled snapshots retrieve the passphrase only from the OS vault and pass only an envelope to the writer', () => {
  const scheduledBlock = serverSource.slice(serverSource.indexOf('async function runScheduledBackup'), serverSource.indexOf('async function restoreState'));
  assert.match(scheduledBlock, /credentialVault\.get\('whole-app-backup-passphrase'\)/);
  assert.match(scheduledBlock, /encryptBackup\(payload, passphrase\)/);
  assert.match(scheduledBlock, /writeEncryptedSnapshot\(\{ directory: schedule\.directory \|\| DEFAULT_BACKUP_DIR, envelope, filename:/);
  assert.doesNotMatch(scheduledBlock, /console\.|detail:\s*[^\n]*passphrase|JSON\.stringify\([^)]*passphrase/);
});
