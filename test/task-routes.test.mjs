import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskRequest, backgroundTaskConnectionRequirement } from '../lib/task-routes.mjs';

function fixture(decision = 'allow') {
  const task = { id: 'task-a', agentId: 'agent-a', name: 'Original', prompt: 'Original instructions', status: 'paused', intervalSeconds: 60, maxRuns: 3, maxRetries: 0, runCount: 0, updatedAt: '2026-01-01' };
  const state = { tasks: [task], taskRuns: [] };
  const activeTaskRuns = new Map();
  const effects = { saves: 0, receipts: [], runs: [] };
  const ctx = {
    state, activeTaskRuns, findAgent: (id) => id === 'agent-a' ? { id, name: 'Agent' } : null,
    cleanString: (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    id: () => 'task-new', now: () => new Date().toISOString(), taskApprovalTtlMs: 60000,
    taskPolicy: () => ({ decision, reason: 'Current policy' }), taskApprovalSummary: (task) => ({ id: task.id, target: task.name }),
    saveState: async () => { effects.saves++; }, addReceipt: (receipt) => effects.receipts.push(receipt), addActivity: () => {},
    runTaskOnce: async (task, approved) => { effects.runs.push({ task: structuredClone(task), approved }); return { ok: true }; }
  };
  const request = async (body, method = 'PATCH', pathname = '/api/tasks/task-a') => {
    let response;
    assert.equal(await handleTaskRequest({}, {}, { ...ctx, method, pathname, readBody: async () => body, json: (_, status, body) => { response = { status, body }; } }), true);
    return response;
  };
  return { task, state, effects, activeTaskRuns, request, ctx };
}

test('Stop reports current cancellation while retaining the prior failed run', async () => {
  const qa = fixture();
  qa.task.status = 'failed'; qa.task.lastError = 'Provider unavailable.';
  qa.state.taskRuns.push({ id: 'failed-run', taskId: qa.task.id, status: 'failed', error: 'Provider unavailable.' });
  const previous = structuredClone(qa.state.taskRuns);
  const result = await qa.request({}, 'POST', '/api/tasks/task-a/cancel');
  assert.equal(result.status, 200);
  assert.equal(result.body.task.status, 'cancelled');
  assert.equal(result.body.task.lastError, 'Stopped by the owner.');
  assert.equal(result.body.task.nextRunAt, null);
  assert.deepEqual(qa.state.taskRuns, previous);
});

test('owner task run reads and results omit internal memory-learning source metadata', async () => {
  const qa = fixture();
  const internalRun = {
    id: 'run-private', taskId: qa.task.id, status: 'completed', startedAt: '2026-01-02T00:00:00.000Z',
    output: 'Synthetic task result.', error: '', finishedAt: '2026-01-02T00:00:01.000Z',
    memoryLearningSourceVersion: { linkId: 'link-private', linkTokenHash: 'credential-hash-private', scope: { projectId: 'project-a' } },
    memoryLearningSourceDigest: 'source-digest-private', memoryLearningEnqueueStatus: 'queued'
  };
  qa.state.taskRuns.push(internalRun);
  const fetched = await qa.request({}, 'GET', '/api/tasks');
  assert.deepEqual(fetched.body.runs, [{ id: internalRun.id, taskId: internalRun.taskId, status: internalRun.status,
    startedAt: internalRun.startedAt, output: internalRun.output, error: internalRun.error, finishedAt: internalRun.finishedAt }]);
  assert.equal(JSON.stringify(fetched.body).includes('credential-hash-private'), false);
  assert.equal(JSON.stringify(fetched.body).includes('source-digest-private'), false);

  qa.ctx.runTaskOnce = async () => ({ ok: true, run: internalRun });
  const result = await qa.request({}, 'POST', `/api/tasks/${qa.task.id}/run`);
  assert.equal(result.body.run.output, 'Synthetic task result.');
  assert.equal(JSON.stringify(result.body).includes('credential-hash-private'), false);
});

test('policy-denied combined edits/start leave the saved task and receipts untouched', async () => {
  const qa = fixture('deny'); const before = structuredClone(qa.task);
  const result = await qa.request({ name: 'Changed', prompt: 'Changed instructions', maxRuns: 5, status: 'running' });
  assert.equal(result.status, 403); assert.deepEqual(qa.task, before);
  assert.equal(qa.effects.saves, 0); assert.deepEqual(qa.effects.receipts, []);
});

test('pending and expired approvals do not silently commit accompanying edits', async () => {
  const qa = fixture('ask');
  const pending = await qa.request({ name: 'Changed', prompt: 'Changed', status: 'running' });
  assert.equal(pending.status, 409); assert.equal(pending.body.approvalRequired, true);
  assert.equal(qa.task.name, 'Original'); assert.equal(qa.task.prompt, 'Original instructions');
  qa.task.approvalExpiresAt = '2000-01-01T00:00:00.000Z';
  assert.equal((await qa.request({ prompt: 'Changed', status: 'running', approved: true })).status, 409);
  assert.equal(qa.task.prompt, 'Original instructions'); assert.equal(qa.task.status, 'paused');
  assert.deepEqual(qa.effects.runs, []);
});

test('approving a start consumes the approval on one immediate run', async () => {
  const qa = fixture('ask');
  assert.equal((await qa.request({ status: 'running', approved: true })).status, 200);
  assert.equal(qa.effects.runs.length, 1); assert.equal(qa.effects.runs[0].approved, true);
  assert.equal(qa.task.approvalExpiresAt, null);
});

test('invalid schedule and empty instructions are rejected atomically', async () => {
  for (const body of [{ intervalSeconds: -1 }, { intervalSeconds: 86401 }, { maxRuns: 1.5 }, { maxRuns: '3' }, { maxRetries: null }, { maxRetries: 11 }, { prompt: ' ' }, { status: 'not-a-status' }]) {
    const qa = fixture(); const before = structuredClone(qa.task);
    assert.equal((await qa.request({ name: 'Changed', ...body })).status, 400);
    assert.deepEqual(qa.task, before); assert.equal(qa.effects.saves, 0);
  }
});

test('zero run limit survives task creation; invalid creation adds no task', async () => {
  const qa = fixture();
  const created = await qa.request({ agentId: 'agent-a', prompt: 'Check local notes', maxRuns: 0, intervalSeconds: 3600 }, 'POST', '/api/tasks');
  assert.equal(created.status, 201); assert.equal(created.body.task.maxRuns, 0);
  assert.equal(created.body.task.status, 'paused');
  assert.equal((await qa.request({ agentId: 'agent-a', prompt: 'Check notes', intervalSeconds: 0.5 }, 'POST', '/api/tasks')).status, 400);
  assert.equal(qa.state.tasks.length, 2);
});

test('duplicate execution and edits during a run cannot change the active task', async () => {
  const qa = fixture(); qa.activeTaskRuns.set(qa.task.id, new AbortController());
  const before = structuredClone(qa.task);
  assert.equal((await qa.request({}, 'POST', '/api/tasks/task-a/run')).status, 409);
  assert.equal((await qa.request({ prompt: 'Changed' })).status, 409);
  assert.deepEqual(qa.task, before); assert.deepEqual(qa.effects.runs, []);
  assert.equal((await qa.request({ status: 'paused' })).status, 200);
  assert.equal(qa.task.status, 'paused');
});

test('completed run limits cannot be exceeded; an explicit larger limit can resume', async () => {
  const qa = fixture(); qa.task.runCount = 3;
  assert.equal((await qa.request({}, 'POST', '/api/tasks/task-a/run')).status, 409);
  assert.equal((await qa.request({ status: 'running' })).status, 409);
  assert.equal((await qa.request({ maxRuns: 4, status: 'running' })).status, 200);
  assert.equal(qa.task.maxRuns, 4); assert.equal(qa.task.status, 'running');
});

test('cancelled tasks cannot be changed or run again; a fresh copy can run', async () => {
  const qa = fixture(); qa.task.status = 'cancelled'; qa.task.lastError = 'Stopped by the owner.';
  const cancelled = structuredClone(qa.task);

  const run = await qa.request({}, 'POST', '/api/tasks/task-a/run');
  assert.equal(run.status, 409); assert.match(run.body.error, /create a new task/i);
  assert.deepEqual(qa.task, cancelled); assert.deepEqual(qa.state.taskRuns, []);
  assert.deepEqual(qa.effects.runs, []); assert.equal(qa.effects.saves, 0);

  const resume = await qa.request({ status: 'paused' });
  const edit = await qa.request({ name: 'Changed after cancellation' });
  assert.equal(resume.status, 409); assert.equal(edit.status, 409);
  assert.deepEqual(qa.task, cancelled); assert.deepEqual(qa.effects.runs, []);
  assert.equal(qa.effects.saves, 0);

  const created = await qa.request({ agentId: 'agent-a', name: 'Fresh copy', prompt: cancelled.prompt, intervalSeconds: 60, maxRuns: 3 }, 'POST', '/api/tasks');
  assert.equal(created.status, 201); assert.notEqual(created.body.task.id, cancelled.id);
  assert.equal(created.body.task.status, 'paused');
  const freshRun = await qa.request({}, 'POST', `/api/tasks/${created.body.task.id}/run`);
  assert.equal(freshRun.status, 200); assert.equal(qa.effects.runs.length, 1);
  assert.equal(qa.effects.runs[0].task.id, created.body.task.id);
});

test('pause clears pending approval and cancelling aborts only the exact task', async () => {
  const qa = fixture('ask'); await qa.request({ status: 'running' });
  await qa.request({ status: 'paused' }); assert.equal(qa.task.approvalExpiresAt, null);
  const controller = new AbortController(), other = new AbortController();
  qa.activeTaskRuns.set('task-a', controller); qa.activeTaskRuns.set('task-b', other);
  assert.equal((await qa.request({}, 'POST', '/api/tasks/task-a/cancel')).status, 200);
  assert.equal(controller.signal.aborted, true); assert.equal(other.signal.aborted, false);
  assert.equal(qa.task.status, 'cancelled'); assert.equal(qa.task.nextRunAt, null);
});


test('background model requirement preserves combined edits and current policy denial', async () => {
  assert.equal(backgroundTaskConnectionRequirement({ browser: true }).includes('no-cost local'), true);
  assert.equal(backgroundTaskConnectionRequirement({ browser: false }), null);
  const qa = fixture(); const before = structuredClone(qa.task);
  qa.ctx.taskConnectionReadiness = () => 'Choose a background model connection.';
  const response = await qa.request({ status: 'running', name: 'Must not commit' });
  assert.equal(response.status, 409); assert.equal(response.body.connectionRequired, true);
  assert.deepEqual(qa.task, before); assert.equal(qa.effects.saves, 0);
  const denied = fixture('deny'); denied.ctx.taskConnectionReadiness = qa.ctx.taskConnectionReadiness;
  assert.equal((await denied.request({ status: 'running' })).status, 403);
  qa.ctx.runTaskOnce = async () => ({ ok: false, connectionRequired: true, error: 'Choose connection.' });
  assert.equal((await qa.request({}, 'POST', '/api/tasks/task-a/run')).status, 409);
});
