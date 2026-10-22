import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceScheduleAfterRun, computeNextRunAt, normalizeBackupSchedule } from '../lib/whole-app-backup.mjs';

test('scheduled backup recurrences advance deterministically and survive reload', () => {
  const intervalHours = 6;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const firstRunAt = Date.parse('2026-01-01T00:00:00.000Z');
  const initial = normalizeBackupSchedule({ enabled: true, intervalHours, lastError: 'previous failure' });

  const afterSuccess = advanceScheduleAfterRun(initial, { ok: true }, firstRunAt);
  assert.equal(afterSuccess.lastRunAt, new Date(firstRunAt).toISOString());
  assert.equal(afterSuccess.nextRunAt, new Date(firstRunAt + intervalMs).toISOString());
  assert.equal(afterSuccess.lastError, '');
  assert.equal(afterSuccess.nextRunAt, computeNextRunAt(initial, firstRunAt));

  const persistedJSON = JSON.stringify(afterSuccess);
  const reloaded = normalizeBackupSchedule(JSON.parse(persistedJSON));
  assert.equal(reloaded.nextRunAt, afterSuccess.nextRunAt, 'the due timestamp survives persistence and reload');

  const secondRunAt = Date.parse(reloaded.nextRunAt);
  const failure = new Error('snapshot write failed');
  const afterFailure = advanceScheduleAfterRun(reloaded, { ok: false, error: failure }, secondRunAt);
  assert.equal(afterFailure.lastRunAt, new Date(secondRunAt).toISOString());
  assert.equal(afterFailure.nextRunAt, new Date(secondRunAt + intervalMs).toISOString());
  assert.equal(afterFailure.lastError, failure.message);

  const thirdRunAt = Date.parse(afterFailure.nextRunAt);
  const afterRecovery = advanceScheduleAfterRun(afterFailure, { ok: true }, thirdRunAt);
  assert.equal(afterRecovery.nextRunAt, new Date(thirdRunAt + intervalMs).toISOString());
  assert.equal(afterRecovery.lastError, '', 'a successful recurrence clears the recorded failure');
});
