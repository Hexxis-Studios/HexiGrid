import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { retainedHarnessJobs } from '../lib/harness-job-history.mjs';
import { EncryptedStateStore } from '../lib/local-state.mjs';

const timestamp = Date.now();
const job = (status = 'completed') => ({ id: 'harness-job-test', agentId: 'agent-test', linkId: 'link-test',
  model: 'local-test', status, createdAt: new Date(timestamp).toISOString(), output: 'Synthetic result',
  prompt: 'Never retain this prompt', token: 'Never retain this token', controller: new AbortController() });

test('bounded history retains exact result identity without prompts or credentials', () => {
  const [record] = retainedHarnessJobs([job()], { timestamp });
  assert.equal(record.output, 'Synthetic result'); assert.equal(record.linkId, 'link-test');
  for (const field of ['prompt', 'token', 'controller']) assert.equal(field in record, false);
  assert.equal(retainedHarnessJobs([{ ...job(), output: 'x'.repeat(25000) }], { timestamp })[0].output.length, 20000);
  assert.equal(retainedHarnessJobs(Array.from({ length: 101 }, (_, i) => ({ ...job(), id: String(i) })), { timestamp }).length, 100);
  assert.equal(retainedHarnessJobs([{ ...job(), createdAt: new Date(timestamp - 1800001).toISOString() }], { timestamp }).length, 0);
});

test('restart interrupts pending jobs without retaining partial output or scheduling replay', () => {
  for (const status of ['queued', 'running']) {
    const [record] = retainedHarnessJobs([job(status)], { recover: true, timestamp });
    assert.equal(record.status, 'interrupted'); assert.equal(record.output, '');
    assert.match(record.error, /Review before submitting/); assert.equal('nextRunAt' in record, false);
    assert.deepEqual(retainedHarnessJobs([record], { recover: true, timestamp }), [record]);
  }
});

test('existing encrypted state preserves completed results across a fresh reader', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-harness-history-'));
  const values = new Map(); const vault = { isAvailable: () => true, get: async key => values.get(key), set: async (key, value) => values.set(key, value) };
  const file = path.join(directory, 'state.json');
  try {
    await new EncryptedStateStore(file, vault).write({ harnessJobHistory: retainedHarnessJobs([job()], { timestamp }) });
    assert.equal((await readFile(file, 'utf8')).includes('Synthetic result'), false);
    const recovered = await new EncryptedStateStore(file, vault).read();
    assert.equal(retainedHarnessJobs(recovered.harnessJobHistory, { recover: true, timestamp })[0].output, 'Synthetic result');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
