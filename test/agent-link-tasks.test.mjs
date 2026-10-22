import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLinkedTasks, linkedTaskAccess } from '../lib/agent-link-tasks.mjs';

test('each later task run must retain its exact connected Link, agent identity and tasks grant', () => {
  const task = { source: 'agent-link', sourceLinkId: 'link-a', agentId: 'agent-a' };
  const state = { agentLinks: [{ id: 'link-a', agentId: 'agent-a', status: 'connected', capabilities: ['tasks'] }] };
  assert.equal(linkedTaskAccess(state, task), null);
  for (const change of [{ status: 'revoked' }, { capabilities: [] }, { agentId: 'agent-b' }, { id: 'link-b' }]) {
    assert.equal(linkedTaskAccess({ agentLinks: [{ ...state.agentLinks[0], ...change }] }, task).decision, 'deny');
  }
  assert.equal(linkedTaskAccess({ agentLinks: [] }, task).decision, 'deny');
  assert.equal(linkedTaskAccess(state, { source: 'owner' }), null);
});

test('signed task operations keep a cancelled task terminal and allow a fresh copy', async () => {
  const cancelled = {
    id: 'task-old', source: 'agent-link', sourceLinkId: 'link-a', agentId: 'agent-a',
    name: 'Old task', prompt: 'Review approved local notes', status: 'cancelled',
    intervalSeconds: 60, maxRuns: 3, maxRetries: 0, runCount: 0, retryCount: 0, nextRunAt: null
  };
  const state = {
    settings: { workMode: 'build' },
    agentLinks: [{ id: 'link-a', agentId: 'agent-a', status: 'connected', capabilities: ['tasks'] }],
    tasks: [cancelled], taskRuns: []
  };
  const effects = { inferences: [], saves: 0 };
  let response;
  const ctx = {
    state,
    json: (_res, status, body) => { response = { status, body }; },
    connectorPolicy: () => null,
    findAgent: (id) => id === 'agent-a' ? { id, name: 'Agent' } : null,
    assertAgentActivity: async () => {},
    cleanString: (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    id: () => 'task-new', now: () => new Date().toISOString(), taskApprovalTtlMs: 60000,
    taskApprovalSummary: () => null, taskPolicy: () => ({ decision: 'allow' }),
    runTaskOnce: async (task) => { effects.inferences.push(task.id); return { ok: true }; },
    saveState: async () => { effects.saves++; }, addReceipt: () => {}, addActivity: () => {},
    activeTaskRuns: new Map()
  };
  const connection = { id: 'link-a', agentId: 'agent-a' };
  const request = async (body) => {
    response = undefined;
    await handleLinkedTasks({}, {}, ctx, connection, body);
    return response;
  };

  const run = await request({ operation: 'run', taskId: cancelled.id });
  const resume = await request({ operation: 'update', taskId: cancelled.id, status: 'paused' });
  const edit = await request({ operation: 'update', taskId: cancelled.id, name: 'Changed' });
  assert.equal(run.status, 409); assert.match(run.body.error, /create a new task/i);
  assert.equal(resume.status, 409); assert.equal(edit.status, 409);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.name, 'Old task');
  assert.deepEqual(effects.inferences, []); assert.equal(effects.saves, 0);

  const created = await request({ operation: 'create', name: 'Fresh copy', prompt: cancelled.prompt, intervalSeconds: 60, maxRuns: 3, maxRetries: 0 });
  assert.equal(created.status, 201); assert.equal(created.body.task.status, 'paused');
  assert.equal(created.body.task.source, 'agent-link'); assert.equal(created.body.task.sourceLinkId, connection.id);
  const freshRun = await request({ operation: 'run', taskId: created.body.task.id });
  assert.equal(freshRun.status, 200); assert.deepEqual(effects.inferences, [created.body.task.id]);
});

test('signed task run reads and results omit internal memory-learning source metadata', async () => {
  const task = { id: 'task-a', source: 'agent-link', sourceLinkId: 'link-a', agentId: 'agent-a',
    name: 'Exact task', prompt: 'Use only the selected project.', status: 'paused', intervalSeconds: 0,
    maxRuns: 2, maxRetries: 0, runCount: 0, retryCount: 0 };
  const internalRun = { id: 'run-private', taskId: task.id, status: 'completed', startedAt: '2026-01-02T00:00:00.000Z',
    output: 'Synthetic signed result.', error: '', finishedAt: '2026-01-02T00:00:01.000Z',
    memoryLearningSourceVersion: { linkId: 'link-a', linkTokenHash: 'credential-hash-private', scope: { projectId: 'project-a' } },
    memoryLearningSourceDigest: 'source-digest-private', memoryLearningEnqueueStatus: 'queued' };
  const state = { settings: { workMode: 'build' }, agentLinks: [{ id: 'link-a', agentId: 'agent-a', status: 'connected', capabilities: ['tasks'] }],
    tasks: [task], taskRuns: [internalRun] };
  let response;
  const ctx = { state, json: (_res, status, body) => { response = { status, body }; }, connectorPolicy: () => null,
    findAgent: (id) => id === 'agent-a' ? { id, name: 'Agent' } : null, assertAgentActivity: async () => {},
    cleanString: (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    id: () => 'task-new', now: () => new Date().toISOString(), taskApprovalTtlMs: 60000,
    taskApprovalSummary: () => null, taskPolicy: () => ({ decision: 'allow' }),
    runTaskOnce: async () => ({ ok: true, run: internalRun }), saveState: async () => {}, addReceipt: () => {}, addActivity: () => {},
    activeTaskRuns: new Map() };
  const connection = { id: 'link-a', agentId: 'agent-a' };
  const request = async (body) => { response = undefined; await handleLinkedTasks({}, {}, ctx, connection, body); return response; };

  const fetched = await request({ operation: 'get', taskId: task.id });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.runs[0].output, 'Synthetic signed result.');
  assert.equal(JSON.stringify(fetched.body).includes('credential-hash-private'), false);
  assert.equal(JSON.stringify(fetched.body).includes('source-digest-private'), false);
  const run = await request({ operation: 'run', taskId: task.id });
  assert.equal(run.status, 200);
  assert.equal(run.body.run.output, 'Synthetic signed result.');
  assert.equal(JSON.stringify(run.body).includes('credential-hash-private'), false);
});
