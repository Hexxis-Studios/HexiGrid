import { normalizeContextScope } from './dated-memory.mjs';

export const MAX_CODEX_THREAD_MEMORY_SCOPE_BINDINGS = 256;

const CODEX_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,119}$/;
const LINEAGE_ID = /^lineage-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function onlyKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} is invalid.`);
}

function normalizeThreadId(value) {
  if (typeof value !== 'string' || !CODEX_THREAD_ID.test(value)) throw new Error('Codex thread ID is invalid.');
  return value;
}

function normalizeMemoryScope(value, { allowNull = false } = {}) {
  if (value === null && allowNull || value === undefined && allowNull) return null;
  record(value, 'Memory scope');
  onlyKeys(value, ['lineageId', 'projectId', 'topicId'], 'Memory scope');
  if (!Object.hasOwn(value, 'lineageId') || typeof value.lineageId !== 'string' || !LINEAGE_ID.test(value.lineageId) ||
      typeof value.projectId !== 'string' || !CONTEXT_ID.test(value.projectId) ||
      Object.hasOwn(value, 'topicId') && (typeof value.topicId !== 'string' || !CONTEXT_ID.test(value.topicId))) {
    throw new Error('Memory scope is invalid.');
  }
  return { lineageId: value.lineageId, ...normalizeContextScope({ projectId: value.projectId,
    ...(Object.hasOwn(value, 'topicId') ? { topicId: value.topicId } : {}) }) };
}

export function normalizeCodexThreadMemoryScopeBindings(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CODEX_THREAD_MEMORY_SCOPE_BINDINGS) {
    throw new Error(`Codex thread memory scope bindings must be an array of at most ${MAX_CODEX_THREAD_MEMORY_SCOPE_BINDINGS}.`);
  }
  const seen = new Set();
  return value.map((item) => {
    record(item, 'Codex thread memory scope binding');
    onlyKeys(item, ['codexThreadId', 'memoryScope'], 'Codex thread memory scope binding');
    const codexThreadId = normalizeThreadId(item.codexThreadId);
    if (seen.has(codexThreadId)) throw new Error('Codex thread memory scope bindings must have unique thread IDs.');
    seen.add(codexThreadId);
    return { codexThreadId, memoryScope: normalizeMemoryScope(item.memoryScope) };
  });
}

export function setCodexThreadMemoryScopeBinding(bindings, codexThreadId, memoryScope) {
  const current = normalizeCodexThreadMemoryScopeBindings(bindings);
  const threadId = normalizeThreadId(codexThreadId);
  const index = current.findIndex((item) => item.codexThreadId === threadId);
  const selected = normalizeMemoryScope(memoryScope, { allowNull: true });
  if (selected === null) return index < 0 ? current : current.filter((item) => item.codexThreadId !== threadId);
  if (index >= 0) {
    current[index] = { codexThreadId: threadId, memoryScope: selected };
    return current;
  }
  if (current.length >= MAX_CODEX_THREAD_MEMORY_SCOPE_BINDINGS) {
    throw new Error(`Codex thread memory scope binding limit is ${MAX_CODEX_THREAD_MEMORY_SCOPE_BINDINGS}.`);
  }
  current.push({ codexThreadId: threadId, memoryScope: selected });
  return current;
}

export function selectMemoryScopeForTurn(input = {}) {
  record(input, 'Memory scope selection');
  onlyKeys(input, ['codexThreadId', 'globalMemoryScope', 'codexThreadMemoryScopeBindings'], 'Memory scope selection');
  const bindings = normalizeCodexThreadMemoryScopeBindings(input.codexThreadMemoryScopeBindings);
  if (Object.hasOwn(input, 'codexThreadId')) {
    const threadId = normalizeThreadId(input.codexThreadId);
    return bindings.find((item) => item.codexThreadId === threadId)?.memoryScope ?? null;
  }
  return normalizeMemoryScope(input.globalMemoryScope, { allowNull: true });
}
