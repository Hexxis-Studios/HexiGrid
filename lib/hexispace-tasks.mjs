const TASK_STATUSES = new Set(['paused', 'running', 'waiting_approval', 'blocked', 'completed', 'cancelled', 'failed']);
const text = (value, max = 120) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const number = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
};

export function isHexiSpaceTaskOwnedByLink(task, linkId) {
  return Boolean(task && task.source === 'hexispace' && task.connectorId === linkId);
}

/** Return only fields needed for the HexiSpace task list; never expose prompts or model output. */
export function hexispaceTaskSummaries(tasks, linkId) {
  if (!Array.isArray(tasks) || typeof linkId !== 'string' || !linkId) return [];
  return tasks.filter((task) => isHexiSpaceTaskOwnedByLink(task, linkId)).slice(0, 100).map((task) => ({
    id: text(task.id, 120),
    name: text(task.name),
    agentId: text(task.agentId, 120),
    intervalSeconds: number(task.intervalSeconds, 0, 0, 86400),
    maxRuns: number(task.maxRuns, 1, 1, 10000),
    runCount: number(task.runCount, 0, 0, 10000),
    status: TASK_STATUSES.has(task.status) ? task.status : 'paused',
    nextRunAt: text(task.nextRunAt, 40) || null,
    createdAt: text(task.createdAt, 40),
    updatedAt: text(task.updatedAt, 40)
  }));
}

/** Connector-created repeating work is bounded to avoid rapid, unreviewed model calls. */
export function normalizeHexiSpaceTaskSchedule(input = {}) {
  const requestedInterval = Number(input.intervalSeconds);
  const intervalSeconds = Number.isFinite(requestedInterval) && requestedInterval > 0
    ? Math.min(86400, Math.max(900, Math.floor(requestedInterval)))
    : 0;
  return {
    intervalSeconds,
    maxRuns: intervalSeconds ? number(input.maxRuns, 10, 2, 100) : 1,
    maxRetries: number(input.maxRetries, 1, 0, 3)
  };
}
