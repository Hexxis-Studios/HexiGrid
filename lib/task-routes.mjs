/**
 * Owner task and approval routes.
 *
 * Task execution remains in server.mjs because it owns the worker and model
 * orchestration. This module keeps the HTTP boundary, redaction, approval
 * lifecycle, and cancellation wiring auditable as one domain.
 */
function taskNumbers(body, defaults) {
  const values = {};
  for (const [key, max] of [['intervalSeconds', 86400], ['maxRuns', 10000], ['maxRetries', 10]]) {
    const value = body[key] === undefined ? defaults[key] : body[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
      return { error: `${key} must be an integer between 0 and ${max}.` };
    }
    values[key] = value;
  }
  return { values };
}

export const BACKGROUND_TASK_CONNECTION_MESSAGE = 'This agent uses a browser-only model. Background tasks need a model service or CLI connection on this computer. Choose AI connection, connect a no-cost local model app, then assign its model to this agent. Browser models remain available for chat.';

export function backgroundTaskConnectionRequirement(route) {
  return route?.browser === true ? BACKGROUND_TASK_CONNECTION_MESSAGE : null;
}

const PUBLIC_TASK_RUN_FIELDS = Object.freeze(['id', 'taskId', 'status', 'startedAt', 'output', 'error', 'finishedAt']);

/** Recover saved run intent without turning Run now into an enabled schedule. */
export function recoverInterruptedTasks(state, timestamp) {
  const interrupted = new Map();
  let changed = false;
  for (const run of state.taskRuns || []) {
    if (run.status !== 'running') continue;
    if (!interrupted.has(run.taskId)) interrupted.set(run.taskId, run);
    run.status = 'interrupted';
    run.error = 'HexiGrid stopped before this run finished.';
    run.finishedAt = timestamp;
    changed = true;
  }
  for (const task of state.tasks || []) {
    if (task.status !== 'running') continue;
    const run = interrupted.get(task.id);
    if (run && run.scheduleEnabled !== true) {
      task.status = 'paused';
      task.nextRunAt = null;
      task.lastError = 'The previous manual run was interrupted. Run it again when ready.';
      changed = true;
    } else {
      if (!Number.isFinite(Date.parse(task.nextRunAt))) { task.nextRunAt = timestamp; changed = true; }
      if (run) { task.lastError = 'The previous run was interrupted. The enabled schedule will continue.'; changed = true; }
    }
  }
  return changed;
}

/** Keep task-run responses limited to fields used by the owner and signed task APIs. */
export function publicTaskRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null;
  return Object.fromEntries(PUBLIC_TASK_RUN_FIELDS
    .filter((key) => Object.hasOwn(run, key))
    .map((key) => [key, run[key]]));
}

function publicTaskResult(result) {
  return result && typeof result === 'object' && result.run
    ? { ...result, run: publicTaskRun(result.run) }
    : result;
}

export async function handleTaskRequest(req, res, ctx) {
  const { state, pathname, method, readBody, json, findAgent, cleanString, id, now, taskApprovalSummary, taskPolicy, runTaskOnce, saveState, addReceipt, addActivity, activeTaskRuns, taskApprovalTtlMs } = ctx;

  if (pathname === '/api/approvals' && method === 'GET') {
    const generic = (state.approvalRequests || []).filter((item) => item.status === 'pending' && Date.parse(item.expiresAt || '') > Date.now()).map((item) => ({
      id: item.id, requester: findAgent(item.agentId)?.name || 'Connected agent', action: item.kind === 'continuity-export' ? 'Export encrypted continuity backup' : item.kind,
      scopes: ['continuity-export', 'owner review'], target: item.context || 'Continuity draft', targetId: item.agentId, context: item.context || '', requestedAt: item.createdAt, expiresAt: item.expiresAt, kind: item.kind, linkId: item.linkId
    }));
    const requests = [...state.tasks.map(taskApprovalSummary).filter(Boolean), ...generic];
    json(res, 200, { requests });
    return true;
  }
  if (pathname === '/api/tasks' && method === 'GET') {
    json(res, 200, { tasks: state.tasks, runs: state.taskRuns.slice(0, 200).map(publicTaskRun).filter(Boolean), approvals: state.tasks.map(taskApprovalSummary).filter(Boolean) });
    return true;
  }
  if (pathname === '/api/tasks' && method === 'POST') {
    const body = await readBody(req);
    const target = findAgent(cleanString(body.agentId));
    if (!target) { json(res, 400, { error: 'Choose an agent for this task.' }); return true; }
    const prompt = cleanString(body.prompt).slice(0, 12000);
    if (!prompt) { json(res, 400, { error: 'Describe what the autonomous task should do.' }); return true; }
    const numbers = taskNumbers(body, { intervalSeconds: 0, maxRuns: 1, maxRetries: 0 });
    if (numbers.error) { json(res, 400, { error: numbers.error }); return true; }
    const task = {
      id: id('task'), name: cleanString(body.name, `Task ${state.tasks.length + 1}`).slice(0, 120), agentId: target.id,
      prompt, ...numbers.values,
      runCount: 0, retryCount: 0, status: 'paused', nextRunAt: null, lastOutput: '', lastError: '', approvalRequestedAt: null, approvalExpiresAt: null, createdAt: now(), updatedAt: now()
    };
    state.tasks.unshift(task);
    addReceipt({ action: `task:${task.id}:create`, capability: 'schedule', risk: 'medium', status: 'completed', detail: `${task.name} was created paused.`, source: 'task' });
    addActivity('task', `${task.name} was created in paused state.`);
    await saveState();
    json(res, 201, { task });
    return true;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([a-z0-9-]+)(?:\/(run|cancel))?$/);
  if (!taskMatch) return false;
  const task = state.tasks.find((item) => item.id === taskMatch[1]);
  if (!task) { json(res, 404, { error: 'Task not found.' }); return true; }
  if (task.status === 'cancelled' && ((method === 'PATCH' && !taskMatch[2]) || (method === 'POST' && taskMatch[2] === 'run'))) {
    json(res, 409, { error: 'This task was cancelled and cannot be changed or run again. Create a new task to reuse its instructions.', terminal: true });
    return true;
  }

  if (method === 'PATCH' && !taskMatch[2]) {
    const body = await readBody(req);
    if (body.status !== undefined && !['paused', 'running', 'completed'].includes(body.status)) {
      json(res, 400, { error: 'Task status must be paused, running or completed.' }); return true;
    }
    const numbers = taskNumbers(body, { intervalSeconds: task.intervalSeconds ?? 0, maxRuns: task.maxRuns ?? 1, maxRetries: task.maxRetries ?? 0 });
    if (numbers.error) { json(res, 400, { error: numbers.error }); return true; }
    const candidate = { ...task, ...numbers.values };
    let runApprovedOnce = false;
    if (body.name !== undefined) candidate.name = cleanString(body.name, task.name).slice(0, 120);
    if (body.prompt !== undefined) candidate.prompt = cleanString(body.prompt).slice(0, 12000);
    if (!candidate.prompt) { json(res, 400, { error: 'Task instructions cannot be empty.' }); return true; }
    if (activeTaskRuns.has(task.id) && ['name', 'prompt', 'intervalSeconds', 'maxRuns', 'maxRetries'].some((key) => body[key] !== undefined)) {
      json(res, 409, { error: 'Wait for the current run to finish before editing this task.' }); return true;
    }
    if (['paused', 'running', 'completed'].includes(body.status)) {
      if (body.status === 'running') {
        if (candidate.maxRuns > 0 && task.runCount >= candidate.maxRuns) {
          json(res, 409, { error: 'This task reached its run limit. Increase the limit or create another task.' }); return true;
        }
        const policy = taskPolicy(candidate);
        const connectionError = ctx.taskConnectionReadiness?.(candidate);
        if (policy.decision !== 'deny' && connectionError) { json(res, 409, { error: connectionError, connectionRequired: true }); return true; }
        if (policy.decision === 'deny') { json(res, 403, { error: policy.reason, denied: true, policy }); return true; }
        if (policy.decision === 'ask' && body.approved === true && task.approvalExpiresAt && Date.parse(task.approvalExpiresAt) <= Date.now()) {
          task.status = 'paused'; task.approvalRequestedAt = null; task.approvalExpiresAt = null; task.lastError = 'This approval expired. Request a fresh approval before starting the task.'; task.updatedAt = now(); await saveState();
          json(res, 409, { error: task.lastError, approvalExpired: true });
          return true;
        }
        if (policy.decision === 'ask' && body.approved !== true) {
          task.status = 'waiting_approval'; task.approvalRequestedAt ||= now(); task.approvalExpiresAt ||= new Date(Date.now() + taskApprovalTtlMs).toISOString(); task.updatedAt = now(); await saveState();
          json(res, 409, { error: policy.reason, approvalRequired: true, policy, request: taskApprovalSummary(task) });
          return true;
        }
        runApprovedOnce = policy.decision === 'ask' && body.approved === true;
        candidate.nextRunAt = null;
        candidate.approvalRequestedAt = null; candidate.approvalExpiresAt = null;
      }
      candidate.status = body.status;
      if (body.status !== 'running') {
        candidate.nextRunAt = null; candidate.approvalRequestedAt = null; candidate.approvalExpiresAt = null;
      }
    }
    Object.assign(task, candidate);
    if (runApprovedOnce) {
      const result = await runTaskOnce(task, true);
      await saveState();
      json(res, result.ok ? 200 : result.policy ? 409 : 502, { ...publicTaskResult(result), task });
      return true;
    }
    if (['paused', 'running', 'completed'].includes(body.status)) addReceipt({ action: `task:${task.id}:${task.status}`, capability: 'schedule', risk: 'medium', status: 'completed', detail: `${task.name} was set to ${task.status}.`, source: 'task' });
    task.updatedAt = now(); await saveState(); json(res, 200, { task });
    return true;
  }
  if (method === 'POST' && taskMatch[2] === 'run') {
    const body = await readBody(req);
    if (activeTaskRuns.has(task.id)) { json(res, 409, { error: 'This task is already running.' }); return true; }
    if (task.maxRuns > 0 && task.runCount >= task.maxRuns) { json(res, 409, { error: 'This task reached its run limit. Create another task to run it again.' }); return true; }
    const result = await runTaskOnce(task, body.approved === true);
    await saveState();
    json(res, result.ok ? 200 : result.policy ? result.policy.decision === 'deny' ? 403 : 409 : result.connectionRequired ? 409 : 502, publicTaskResult(result));
    return true;
  }
  if (method === 'POST' && taskMatch[2] === 'cancel') {
    task.status = 'cancelled'; task.nextRunAt = null; task.lastError = 'Stopped by the owner.'; task.updatedAt = now(); activeTaskRuns.get(task.id)?.abort();
    addReceipt({ action: `task:${task.id}:cancel`, capability: 'schedule', risk: 'medium', status: 'cancelled', detail: `${task.name} was cancelled by the owner.`, source: 'task' });
    if (!activeTaskRuns.has(task.id)) addActivity('task', `${task.name} was cancelled.`);
    await saveState(); json(res, 200, { task });
    return true;
  }
  return false;
}
