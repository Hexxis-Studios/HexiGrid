import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decryptBackup, encryptBackup } from '../lib/backup.mjs';
import {
  advanceScheduleAfterRun,
  computeNextRunAt,
  normalizeBackupSchedule,
  writeEncryptedSnapshot
} from '../lib/whole-app-backup.mjs';

test('interrupted scheduled backups preserve good snapshots and resume from due schedule', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-backup-resume-'));
  const filename = 'hexigrid-backup-resume.json';
  const target = path.join(directory, filename);
  const passphrase = 'synthetic scheduled backup passphrase';
  const payload = { agents: [{ id: 'synthetic-resume-agent' }], rooms: [], settings: {}, backup: { format: 'hexigrid-local-data', version: 3 } };
  const encrypted = () => encryptBackup(payload, passphrase);
  // Exercise the native host path; on Windows this includes the real owner-only
  // ACL on the staged file before the injected publication interruption.
  const publish = writeEncryptedSnapshot;
  const original = encrypted();
  const dueAt = Date.parse('2026-10-04T12:00:00.000Z');
  const persistedDueSchedule = normalizeBackupSchedule({ enabled: true, intervalHours: 6, lastRunAt: '2026-10-04T06:00:00.000Z', nextRunAt: new Date(dueAt).toISOString() });

  try {
    await writeFile(target, JSON.stringify(original));
    const priorBytes = await readFile(target);

    // Inject failure at the publication boundary, after the complete staging write.
    const realRename = fs.rename;
    fs.rename = async () => { throw new Error('synthetic interruption before rename'); };
    try {
      await assert.rejects(publish({ directory, envelope: encrypted(), filename }), /synthetic interruption/);
    } finally {
      fs.rename = realRename;
    }
    assert.deepEqual(await readFile(target), priorBytes, 'a failed publish preserves the prior target byte for byte');
    assert.deepEqual((await readdir(directory)).sort(), [filename], 'failed staging is removed and no partial target is published');

    // Failed writing leaves the persisted due schedule untouched; the next run succeeds.
    let scheduleState = normalizeBackupSchedule(JSON.parse(JSON.stringify(persistedDueSchedule)));
    assert.equal(Date.parse(scheduleState.nextRunAt) <= dueAt, true);
    const retryTime = dueAt + 1_000;
    const retryPath = await publish({ directory, envelope: encrypted(), filename });
    const retryEnvelope = JSON.parse(await readFile(retryPath, 'utf8'));
    assert.deepEqual(decryptBackup(retryEnvelope, passphrase), payload, 'retry publishes a complete decryptable snapshot');
    scheduleState = advanceScheduleAfterRun(scheduleState, { ok: true }, retryTime);
    assert.equal(scheduleState.lastRunAt, new Date(retryTime).toISOString());
    assert.equal(scheduleState.nextRunAt, computeNextRunAt(persistedDueSchedule, retryTime));
    assert.equal(scheduleState.lastError, '');

    // A crash after rename but before state save leaves the prior due schedule on disk.
    const stillPersistedDue = normalizeBackupSchedule(JSON.parse(JSON.stringify(persistedDueSchedule)));
    const firstPublishedPath = await publish({ directory, envelope: encrypted(), filename });
    assert.deepEqual(decryptBackup(JSON.parse(await readFile(firstPublishedPath, 'utf8')), passphrase), payload);
    // Model restart/retry: state was never advanced, so another complete snapshot is allowed.
    assert.equal(stillPersistedDue.nextRunAt, persistedDueSchedule.nextRunAt);
    const secondPublishedPath = await publish({ directory, envelope: encrypted(), filename });
    assert.deepEqual(decryptBackup(JSON.parse(await readFile(secondPublishedPath, 'utf8')), passphrase), payload);
    assert.deepEqual((await readdir(directory)).sort(), [filename], 'retries leave only the complete target and no staging files');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
