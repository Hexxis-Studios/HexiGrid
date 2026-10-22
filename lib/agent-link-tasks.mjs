import { handleTaskRequest, publicTaskRun } from './task-routes.mjs';

export function linkedTaskAccess(state, task) {
  if (task.source !== 'agent-link') return null;
  const link = state.agentLinks?.find((item) => item.id === task.sourceLinkId);
  if (!link || link.status !== 'connected' || link.agentId !== task.agentId || !link.capabilities?.includes('tasks')) {
    return { decision: 'deny', reason: 'The task’s exact Link is disconnected, revoked or no longer granted tasks.' };
  }
  return null;
}

/** Signed Links reuse owner task execution but cannot select another identity or approve themselves. */
export async function handleLinkedTasks(req, res, ctx, connection, body) {
  const { state, json, connectorPolicy } = ctx;
  const operation = body?.operation;
  const fields = {
    list: ['operation', 'after', 'limit'], get: ['operation', 'taskId'], create: ['operation', 'name', 'prompt', 'intervalSeconds', 'maxRuns', 'maxRetries'],
    update: ['operation', 'taskId', 'name', 'prompt', 'intervalSeconds', 'maxRuns', 'maxRetries', 'status'],
    run: ['operation', 'taskId'], cancel: ['operation', 'taskId']
  };
  if (!fields[operation] || Object.keys(body).some((key) => !fields[operation].includes(key))) {
    json(res, 400, { error: 'Unsupported task operation or fields. A Link cannot choose another agent or approve its own request.' }); return;
  }
  const reading = ['list', 'get'].includes(operation);
  const capability = reading ? 'read_local' : state.settings.workMode === 'watch' ? 'schedule' : 'spawn_subagents';
  const policy = connectorPolicy(capability, reading ? 'low' : 'medium', false, { external: true });
  if (policy) { json(res, policy.denied ? 403 : 409, policy); return; }
  const agent = ctx.findAgent(connection.agentId);
  if (!agent) { json(res, 409, { error: 'The linked agent is unavailable.' }); return; }
  await ctx.assertAgentActivity(agent);
  const owned = state.tasks.filter((task) => task.source === 'agent-link' && task.sourceLinkId === connection.id && task.agentId === connection.agentId);
  if (operation === 'list') {
    const limit = body.limit ?? 20;
    const start = body.after === undefined ? 0 : owned.findIndex((task) => task.id === body.after) + 1;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || (body.after !== undefined && start === 0)) {
      json(res, 400, { error: 'Use a page limit of 1 to 20 and a cursor returned for this Link.' }); return;
    }
    const page = owned.slice(start, start + limit);
    const tasks = page.map(({ id, name, agentId, status, intervalSeconds, maxRuns, maxRetries, runCount, retryCount, nextRunAt, createdAt, updatedAt }) => ({ id, name, agentId, status, intervalSeconds, maxRuns, maxRetries, runCount, retryCount, nextRunAt, createdAt, updatedAt }));
    json(res, 200, { tasks, nextCursor: start + limit < owned.length ? page.at(-1).id : null }); return;
  }
  if (!['list', 'create'].includes(operation) && !owned.some((task) => task.id === body.taskId)) {
    json(res, 404, { error: 'Task not found for this Link.' }); return;
  }
  if (operation === 'get') {
    const task = owned.find((item) => item.id === body.taskId);
    json(res, 200, { task, runs: state.taskRuns.filter((run) => run.taskId === task.id).slice(0, 10).map(publicTaskRun).filter(Boolean) }); return;
  }
  const scopedState = { ...state, tasks: owned, taskRuns: state.taskRuns.filter((run) => owned.some((task) => task.id === run.taskId)) };
  const requestBody = { ...body }; delete requestBody.operation; delete requestBody.taskId;
  if (operation === 'create') requestBody.agentId = connection.agentId;
  const method = operation === 'list' ? 'GET' : operation === 'update' ? 'PATCH' : 'POST';
  const pathname = ['list', 'create'].includes(operation) ? '/api/tasks' : `/api/tasks/${body.taskId}${operation === 'update' ? '' : `/${operation}`}`;
  await handleTaskRequest(req, res, {
    ...ctx, state: scopedState, method, pathname, readBody: async () => requestBody,
    addReceipt: (receipt) => ctx.addReceipt({ ...receipt, agentId: connection.agentId, source: 'agent-link-task' }),
    taskPolicy: () => ctx.taskPolicy(owned.find((task) => task.id === body.taskId)),
    saveState: async () => {
      for (const task of scopedState.tasks) {
        if (!state.tasks.some((item) => item.id === task.id)) {
          task.source = 'agent-link'; task.sourceLinkId = connection.id;
          state.tasks.unshift(task);
        }
      }
      await ctx.saveState();
    }
  });
}
