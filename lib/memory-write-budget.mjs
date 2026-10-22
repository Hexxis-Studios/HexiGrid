import crypto from 'node:crypto';

export const memoryWriteBudgetLimits = Object.freeze({ minuteCount: 30, minuteBytes: 128 * 1024,
  hourCount: 500, hourBytes: 2 * 1024 * 1024 });

// Kept in the existing encrypted state. Only counters/opaque scope digests;
// no candidate text, model invocation, timer, or separate storage service.
export function normalizeMemoryWriteBudget(value, at = Date.now()) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !Number.isFinite(at)) throw new Error('Memory write counters are invalid.');
  const keys = new Set();
  return value.flatMap(row => {
    if (!row || !/^[a-f0-9]{64}$/.test(row.key || '') || keys.has(row.key) ||
      !Array.isArray(row.events) || row.events.length > memoryWriteBudgetLimits.hourCount ||
      row.events.some(event => !Array.isArray(event) || event.length !== 2 ||
        !Number.isSafeInteger(event[0]) || !Number.isSafeInteger(event[1]) || event[1] < 1 || event[1] > 128 * 1024)) {
      throw new Error('Memory write counters are invalid.');
    }
    keys.add(row.key);
    // Retain future events if the system clock moves backwards; a clock reset
    // must not grant a fresh write allowance.
    const events = row.events.filter(([time]) => time > at - 60 * 60 * 1000).map(event => [...event]);
    return events.length ? [{ key: row.key, events }] : [];
  });
}

export function consumeMemoryWriteBudget(state, { source, bytes, at }) {
  if (source.kind === 'owner-local') return true;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(at)) throw new Error('Memory write counters are invalid.');
  const rows = normalizeMemoryWriteBudget(state.memoryWriteBudget, at);
  const key = crypto.createHash('sha256').update(`${source.lineageId}\0${source.agentId}`).digest('hex');
  let row = rows.find(item => item.key === key);
  const events = row?.events || [];
  const recent = events.filter(([time]) => time > at - 60000);
  const limits = memoryWriteBudgetLimits;
  const allowed = recent.length < limits.minuteCount && events.length < limits.hourCount &&
    recent.reduce((sum, [, count]) => sum + count, bytes) <= limits.minuteBytes &&
    events.reduce((sum, [, count]) => sum + count, bytes) <= limits.hourBytes;
  if (allowed) {
    if (!row) { row = { key, events: [] }; rows.push(row); }
    row.events.push([at, bytes]);
  }
  state.memoryWriteBudget = rows;
  return allowed;
}
