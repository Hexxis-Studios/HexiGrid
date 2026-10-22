import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createMemoryLearningWorker } from '../lib/memory-learning-worker.mjs';
import { recoverInterruptedTasks } from '../lib/task-routes.mjs';

const source = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const execution = source.slice(source.indexOf('async function runTaskOnce('), source.indexOf('\nfunction startTaskWorker()'));
const learningEnqueue = source.slice(source.indexOf('async function enqueueTaskMemoryLearning('), source.indexOf('\nfunction sameMemoryLearningReference('));
const learningSchedule = source.slice(source.indexOf('function trackMemoryLearningEnqueue('), source.indexOf('\nfunction startMemoryLearningWorker()'));
function fixture(status = 'paused', response) {
  const task = { id: 'qa-task', agentId: 'qa-agent', name: 'Synthetic', prompt: 'Harmless', status, intervalSeconds: 2, maxRuns: 2, maxRetries: 2, runCount: 0 };
  const context = { AbortController, Date, taskPolicy: () => ({ decision: 'allow' }), findAgent: () => ({ id: 'qa-agent' }),
    taskConnectionReadiness: () => null, activeTaskRuns: new Map(), state: { taskRuns: [], tasks: [task], rooms: [] }, saveState: async () => {}, now: () => new Date().toISOString(), id: () => 'qa-run',
    captureTaskLearningSourceVersion: () => null, taskLearningSourceVersionEligible: () => false,
    respondForAgent: response || (async () => ({ ok: true, content: 'Synthetic response' })), addActivity() {}, addReceipt() {} };
  vm.runInNewContext(execution, context);
  return { task, context, run: () => context.runTaskOnce(task) };
}

test('Run now on a paused recurring task completes exactly one step without scheduling', async () => {
  const qa = fixture();
  assert.equal((await qa.run()).ok, true);
  assert.equal(qa.task.runCount, 1); assert.equal(qa.task.status, 'paused'); assert.equal(qa.task.nextRunAt, null);
  assert.equal((await qa.run()).ok, true);
  assert.equal(qa.task.status, 'completed'); assert.equal(qa.task.nextRunAt, null);
  assert.equal((await qa.run()).ok, false); assert.equal(qa.context.state.taskRuns.length, 2);
});

test('a new invocation clears stale connection failure without changing prior run history', async () => {
  const qa = fixture('failed', async () => {
    assert.equal(qa.task.lastError, '');
    assert.equal(qa.context.state.taskRuns[1].error, 'Provider unavailable.');
    return { ok: true, content: 'Recovered' };
  });
  qa.task.lastError = 'Provider unavailable.';
  qa.context.state.taskRuns.push({ id: 'old-run', taskId: qa.task.id, status: 'failed', error: 'Provider unavailable.' });
  assert.equal((await qa.run()).ok, true);
  assert.equal(qa.context.state.taskRuns[1].error, 'Provider unavailable.');
});

test('started schedule repeats only until its bounded run limit', async () => {
  const qa = fixture('running');
  await qa.run(); assert.equal(qa.task.status, 'running'); assert.ok(Date.parse(qa.task.nextRunAt) > Date.now());
  await qa.run(); assert.equal(qa.task.status, 'completed'); assert.equal(qa.task.nextRunAt, null);
});

test('Pause during a successful run cannot be undone by completion', async () => {
  const qa = fixture('running', async () => { qa.task.status = 'paused'; return { ok: true, content: 'Synthetic response' }; });
  await qa.run(); assert.equal(qa.task.status, 'paused'); assert.equal(qa.task.nextRunAt, null); assert.equal(qa.task.runCount, 1);
});

test('manual failures and Pause during failure cannot activate automatic retries', async () => {
  for (const status of ['paused', 'running']) {
    const qa = fixture(status, async () => { if (status === 'running') qa.task.status = 'paused'; throw new Error('Synthetic failure'); });
    const result = await qa.run();
    assert.equal(result.retryScheduled, false); assert.equal(qa.task.nextRunAt, null); assert.equal(qa.task.runCount, 0);
    assert.equal(qa.task.status, status === 'running' ? 'paused' : 'failed');
  }
});

test('enabled schedule retains bounded retries; Stop and emergency stop never retry', async () => {
  const retry = fixture('running', async () => { throw new Error('Synthetic failure'); });
  assert.equal((await retry.run()).retryScheduled, true); assert.equal(retry.task.retryCount, 1); assert.equal(retry.task.status, 'running');
  for (const reason of [undefined, 'emergency-stop']) {
    const qa = fixture('running', async () => { qa.context.activeTaskRuns.get(qa.task.id).abort(reason); throw new Error('Synthetic stop'); });
    assert.equal((await qa.run()).retryScheduled, false);
    assert.equal(qa.task.status, reason ? 'paused' : 'cancelled'); assert.equal(qa.task.nextRunAt, null);
    assert.equal(qa.context.activeTaskRuns.size, 0);
  }
});

test('task start is durable before dispatch, and cancellation during that save prevents dispatch', async () => {
  for (const cancel of [false, true]) {
    let dispatched = 0;
    const snapshots = [];
    const qa = fixture('running', async () => {
      dispatched++;
      assert.equal(snapshots[0].taskRuns[0].status, 'running');
      assert.equal(snapshots[0].taskRuns[0].scheduleEnabled, true);
      return { ok: true, content: 'Done' };
    });
    qa.context.saveState = async () => {
      snapshots.push(structuredClone(qa.context.state));
      if (cancel && snapshots.length === 1) {
        qa.task.status = 'cancelled';
        qa.context.activeTaskRuns.get(qa.task.id).abort();
      }
    };
    const result = await qa.run();
    assert.equal(dispatched, cancel ? 0 : 1);
    assert.equal(result.ok, !cancel);
    assert.equal(qa.context.activeTaskRuns.size, 0);
    assert.equal(snapshots.at(-1).taskRuns[0].status, cancel ? 'cancelled' : 'completed');
    assert.equal(qa.task.runCount, cancel ? 0 : 1);
  }
});

test('failed start persistence and a newly denied policy pause tasks without dispatch or retry', async () => {
  for (const cause of ['storage', 'policy', 'pause']) {
    let dispatched = 0, saves = 0;
    const qa = fixture('running', async () => { dispatched++; return { ok: true, content: 'Must not run' }; });
    qa.context.saveState = async () => {
      if (++saves !== 1) return;
      if (cause === 'storage') throw new Error('Private storage diagnostic');
      if (cause === 'policy') qa.context.taskPolicy = () => ({ decision: 'deny', reason: 'Planning mode active' });
      if (cause === 'pause') qa.task.status = 'paused';
    };
    const result = await qa.run();
    assert.equal(dispatched, 0);
    assert.equal(result.ok, false);
    assert.equal(result.retryScheduled, false);
    assert.equal(qa.task.status, 'paused');
    assert.equal(qa.task.nextRunAt, null);
    assert.equal(qa.task.runCount, 0);
    if (cause === 'storage') {
      assert.match(result.error, /start could not be saved.*No provider was called/);
      assert.doesNotMatch(result.error, /Private storage diagnostic/);
    }
  }
});

test('restart preserves enabled schedule timing and pauses interrupted manual or legacy runs', () => {
  const timestamp = '2026-10-03T12:00:00Z', next = '2026-10-03T13:00:00Z';
  const state = {
    tasks: ['manual', 'legacy', 'scheduled', 'waiting', 'cancelled'].map(id => ({ id, status: id === 'cancelled' ? 'cancelled' : 'running', nextRunAt: id === 'waiting' ? next : null, lastOutput: 'Preserved prior output', runCount: 2 })),
    taskRuns: [
      { id: 'manual-run', taskId: 'manual', status: 'running', scheduleEnabled: false },
      { id: 'legacy-run', taskId: 'legacy', status: 'running' },
      { id: 'scheduled-run', taskId: 'scheduled', status: 'running', scheduleEnabled: true },
      { id: 'old-run', taskId: 'manual', status: 'completed', output: 'Saved result' }
    ]
  };
  assert.equal(recoverInterruptedTasks(state, timestamp), true);
  assert.equal(state.tasks[0].status, 'paused');
  assert.equal(state.tasks[1].status, 'paused');
  assert.equal(state.tasks[2].status, 'running');
  assert.equal(state.tasks[2].nextRunAt, timestamp);
  assert.equal(state.tasks[3].nextRunAt, next, 'restart does not advance an enabled schedule');
  assert.equal(state.tasks[4].status, 'cancelled');
  assert.ok(state.tasks.every(task => task.lastOutput === 'Preserved prior output' && task.runCount === 2));
  assert.ok(state.taskRuns.slice(0, 3).every(run => run.status === 'interrupted' && run.finishedAt === timestamp));
  assert.equal(state.taskRuns[3].output, 'Saved result');
  const recovered = structuredClone(state);
  assert.equal(recoverInterruptedTasks(state, timestamp), false);
  assert.deepEqual(state, recovered, 'recovery is idempotent');
});

test('signed task authority is rechecked after saving the run start', async () => {
  let dispatched = 0, saves = 0;
  const qa = fixture('running', async () => { dispatched++; return { ok: true, content: 'Must not run' }; });
  const target = { id: qa.task.agentId };
  const link = { id: 'synthetic-link', agentId: target.id, tokenHash: 'synthetic-test-verifier', status: 'connected', capabilities: ['tasks'] };
  qa.task.source = 'agent-link'; qa.task.sourceLinkId = link.id;
  qa.context.state.agentLinks = [link];
  qa.context.state.settings = { workMode: 'build' };
  qa.context.findAgent = () => target;
  qa.context.assertAgentActivity = () => {};
  qa.context.connectorPolicy = () => null;
  qa.context.saveState = async () => { if (++saves === 1) link.capabilities = []; };
  const result = await qa.run();
  assert.equal(dispatched, 0);
  assert.equal(result.ok, false);
  assert.equal(result.retryScheduled, false);
  assert.equal(result.run.status, 'cancelled');
  assert.equal(qa.context.activeTaskRuns.size, 0);
});

test('completed task learning persists before restart scanning enrolls the source once', async () => {
  const qa = fixture();
  const state = qa.context.state;
  const lineageId = 'lineage-11111111-1111-4111-8111-111111111111';
  const sourceVersion = Object.freeze({ version: 1, taskId: qa.task.id, agentId: qa.task.agentId,
    lineageId, name: qa.task.name, prompt: qa.task.prompt });
  const savedSnapshots = [];
  qa.context.saveState = async () => { savedSnapshots.push(structuredClone(state)); };
  qa.context.captureTaskLearningSourceVersion = () => sourceVersion;
  qa.context.taskLearningSourceVersionEligible = () => true;
  qa.context.taskLearningText = () => 'Synthetic completed task text';
  qa.context.memoryLearningDigest = () => 'synthetic-digest';
  qa.context.Buffer = Buffer;
  qa.context.MAX_MEMORY_LEARNING_SOURCE_BYTES = 10_000;
  let eagerEnqueueCalls = 0;
  let releaseEagerEnqueue;
  const heldEagerEnqueue = new Promise((resolve) => { releaseEagerEnqueue = resolve; });
  qa.context.enqueueTaskMemoryLearning = async () => {
    eagerEnqueueCalls += 1;
    return heldEagerEnqueue;
  };
  qa.context.trackMemoryLearningEnqueue = operation => operation;

  let timeout;
  const runResult = await Promise.race([
    qa.run().then(value => ({ completed: true, value })),
    new Promise(resolve => { timeout = setTimeout(() => resolve({ completed: false }), 100); })
  ]);
  clearTimeout(timeout);
  if (!runResult.completed) {
    releaseEagerEnqueue(false);
    assert.fail('Task completion waited for the memory-learning queue.');
  }
  assert.equal(runResult.value.ok, true);
  assert.equal(runResult.value.run.status, 'completed');
  assert.equal(runResult.value.run.memoryLearningEnqueuePending, true);
  assert.equal(eagerEnqueueCalls, 0);
  assert.equal(savedSnapshots[0].taskRuns[0].status, 'running');
  assert.equal(savedSnapshots[0].taskRuns[0].scheduleEnabled, false);
  assert.equal(savedSnapshots.at(-1).taskRuns[0].status, 'completed');
  assert.equal(savedSnapshots.at(-1).taskRuns[0].memoryLearningEnqueuePending, true);
  assert.equal(Object.hasOwn(savedSnapshots.at(-1), 'memoryLearningQueue'), false);

  // Reopen the exact durable post-completion state. The regular startup scanner
  // must enroll the pending task through the real queue adapter before ticking.
  const reopenedState = structuredClone(state);
  reopenedState.memoryLearningPaused = false;
  const reopenedSnapshots = [];
  const saveReopenedState = async () => { reopenedSnapshots.push(structuredClone(reopenedState)); };
  const makeQueueWorker = () => createMemoryLearningWorker({
    state: reopenedState, saveState: saveReopenedState, now: () => 90_000, quietMs: 0,
    maxAttempts: 2, baseRetryMs: 100, maxRetryMs: 500, idleRetryMs: 50,
    resolveSource: async ({ reference }) => ({ ...reference, completed: true, successful: true, text: 'Synthetic completed task text' }),
    isEnabled: async () => true, authorize: async () => true, isInteractiveBusy: async () => false,
    extractLocally: async () => [], listCurrentFacts: async () => [], assessRelation: async () => 'none',
    submitCandidate: async () => ({ status: 'committed' })
  });
  const queueWorker = makeQueueWorker();
  queueWorker.start();
  let enqueueCalls = 0;
  const countedWorker = {
    status: () => queueWorker.status(), tick: () => queueWorker.tick(),
    enqueueCompletedSource: reference => { enqueueCalls += 1; return queueWorker.enqueueCompletedSource(reference); }
  };
  Object.assign(qa.context, {
    state: reopenedState, memoryLearningWorker: countedWorker, startupReadOnly: false,
    memoryLearningPaused: false, memoryLearningScheduleBusy: false, memoryLearningSchedulePromise: Promise.resolve(),
    memoryLearningEnqueueOperations: new Set(), activeMemoryLearningSources: new Set(),
    findAgent: () => ({ id: 'qa-agent' }), taskLearningSourceVersionEligible: () => true,
    taskLearningSource: reference => ({ ...reference, completed: true, successful: true, text: 'Synthetic completed task text' }),
    memoryLearningEnqueueOutcome: result => result,
    cleanString: value => String(value || ''), saveState: saveReopenedState,
    cleanupRoomMemoryLearningReferences: () => false
  });
  vm.runInNewContext(`${learningEnqueue}\n${learningSchedule}`, qa.context);
  await qa.context.scheduleMemoryLearningPass();

  assert.equal(enqueueCalls, 1);
  assert.equal(reopenedState.taskRuns[0].memoryLearningEnqueuePending, undefined);
  assert.equal(reopenedState.taskRuns[0].memoryLearningEnqueueStatus, 'queued');
  assert.equal(reopenedState.memoryLearningQueue.jobs.length, 0, 'the worker tick consumed the synthetic reference');
  assert.equal(reopenedState.memoryLearningQueue.receipts.length, 1);
  assert.equal(reopenedState.memoryLearningQueue.receipts[0].sourceKind, 'task-run');
  assert.equal(reopenedState.memoryLearningQueue.receipts[0].sourceId, 'qa-run');
  assert.ok(reopenedSnapshots.some(snapshot => snapshot.taskRuns[0].memoryLearningEnqueuePending === true &&
    snapshot.memoryLearningQueue?.jobs.some(job => job.kind === 'task-run' && job.id === 'qa-run')),
  'the queue reference is durably saved while the run remains pending');

  // A second process sees the saved receipt and cleared pending marker, so it
  // does not enroll the task a second time.
  const restartedState = structuredClone(reopenedState);
  restartedState.memoryLearningPaused = false;
  const restartWorker = createMemoryLearningWorker({
    state: restartedState, saveState: async () => {}, now: () => 90_000, quietMs: 0,
    resolveSource: async () => null, isEnabled: async () => true, authorize: async () => true,
    isInteractiveBusy: async () => false, extractLocally: async () => [], listCurrentFacts: async () => [],
    assessRelation: async () => 'none', submitCandidate: async () => ({ status: 'committed' })
  });
  restartWorker.start();
  let restartEnqueues = 0;
  Object.assign(qa.context, {
    state: restartedState, memoryLearningWorker: {
      status: () => restartWorker.status(), tick: () => restartWorker.tick(),
      enqueueCompletedSource: reference => { restartEnqueues += 1; return restartWorker.enqueueCompletedSource(reference); }
    }, memoryLearningScheduleBusy: false, memoryLearningSchedulePromise: Promise.resolve(),
    memoryLearningEnqueueOperations: new Set(), activeMemoryLearningSources: new Set(),
    saveState: async () => {}, cleanupRoomMemoryLearningReferences: () => false
  });
  vm.runInNewContext(`${learningEnqueue}\n${learningSchedule}`, qa.context);
  await qa.context.scheduleMemoryLearningPass();
  assert.equal(restartEnqueues, 0);
  assert.equal(restartedState.memoryLearningQueue.receipts.length, 1);
});


test('browser-only task route blocks without inference, run intent or automatic retry', async () => {
  let called = 0;
  const qa = fixture('running', async () => { called++; return { ok: true, content: 'Must not infer' }; });
  qa.context.taskConnectionReadiness = () => 'Choose a background model connection.';
  const result = await qa.run();
  assert.equal(result.connectionRequired, true); assert.equal(result.ok, false);
  assert.equal(called, 0); assert.equal(qa.context.state.taskRuns.length, 0);
  assert.equal(qa.task.status, 'blocked'); assert.equal(qa.task.nextRunAt, null);
  assert.equal(qa.task.retryCount, undefined); assert.equal(qa.context.activeTaskRuns.size, 0);
});
