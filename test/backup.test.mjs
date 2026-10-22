import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackup, decryptBackup } from '../lib/backup.mjs';

test('backup encryption round trip does not expose plaintext', () => {
  const payload = { agents: [{ id: 'agent-a', name: 'A' }], rooms: [{ id: 'room-a', messages: [] }], secretNote: 'local-only' };
  const envelope = encryptBackup(payload, 'correct horse battery staple');
  assert.equal(envelope.format, 'hexigrid-backup');
  assert.equal(JSON.stringify(envelope).includes('secretNote'), false);
  assert.deepEqual(decryptBackup(envelope, 'correct horse battery staple'), payload);
  assert.throws(() => decryptBackup(envelope, 'wrong passphrase'), /incorrect|damaged/);
});

test('backup refuses weak passphrases', () => {
  assert.throws(() => encryptBackup({ agents: [], rooms: [] }, 'short'), /12 characters/);
});

test('pre-rename encrypted backups remain restorable', () => {
  const payload = { agents: [], rooms: [], migrated: true };
  const envelope = encryptBackup(payload, 'legacy backup passphrase');
  envelope.format = 'aveniq-backup';
  assert.deepEqual(decryptBackup(envelope, 'legacy backup passphrase'), payload);
});
