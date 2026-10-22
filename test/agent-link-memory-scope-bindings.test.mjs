import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CODEX_THREAD_MEMORY_SCOPE_BINDINGS, normalizeCodexThreadMemoryScopeBindings,
  selectMemoryScopeForTurn, setCodexThreadMemoryScopeBinding } from '../lib/agent-link-memory-scope-bindings.mjs';

const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scopeA = { lineageId, projectId: 'project-a', topicId: 'topic-a' };
const scopeB = { lineageId, projectId: 'project-b' };
const threadA = 'codex-thread-0001';
const threadB = 'codex-thread-0002';

test('exact thread bindings keep project scopes isolated', () => {
  let bindings = setCodexThreadMemoryScopeBinding([], threadA, scopeA);
  bindings = setCodexThreadMemoryScopeBinding(bindings, threadB, scopeB);
  assert.deepEqual(selectMemoryScopeForTurn({ codexThreadId: threadA, globalMemoryScope: scopeB,
    codexThreadMemoryScopeBindings: bindings }), scopeA);
  assert.deepEqual(selectMemoryScopeForTurn({ codexThreadId: threadB, globalMemoryScope: scopeA,
    codexThreadMemoryScopeBindings: bindings }), scopeB);
});

test('targeted turns do not fall back to a global or another thread scope', () => {
  const bindings = setCodexThreadMemoryScopeBinding([], threadA, scopeA);
  assert.equal(selectMemoryScopeForTurn({ codexThreadId: threadB, globalMemoryScope: scopeB,
    codexThreadMemoryScopeBindings: bindings }), null);
});

test('untargeted turns keep the existing global selection', () => {
  const bindings = setCodexThreadMemoryScopeBinding([], threadA, scopeA);
  assert.deepEqual(selectMemoryScopeForTurn({ globalMemoryScope: scopeB,
    codexThreadMemoryScopeBindings: bindings }), scopeB);
  assert.equal(selectMemoryScopeForTurn({ codexThreadMemoryScopeBindings: bindings }), null);
});

test('clearing a binding removes only its exact thread and does not mutate input', () => {
  const original = setCodexThreadMemoryScopeBinding(setCodexThreadMemoryScopeBinding([], threadA, scopeA), threadB, scopeB);
  const cleared = setCodexThreadMemoryScopeBinding(original, threadA, null);
  assert.equal(original.length, 2);
  assert.deepEqual(cleared, [{ codexThreadId: threadB, memoryScope: scopeB }]);
  assert.equal(selectMemoryScopeForTurn({ codexThreadId: threadA, codexThreadMemoryScopeBindings: cleared }), null);
  assert.deepEqual(selectMemoryScopeForTurn({ codexThreadId: threadB, codexThreadMemoryScopeBindings: cleared }), scopeB);
});

test('normalization rejects invalid IDs, shapes, duplicate bindings, and text or cursors', () => {
  assert.throws(() => setCodexThreadMemoryScopeBinding([], 'short', scopeA), /thread ID is invalid/);
  assert.throws(() => setCodexThreadMemoryScopeBinding([], threadA, { ...scopeA, cursor: 'reusable' }), /scope is invalid/);
  assert.throws(() => setCodexThreadMemoryScopeBinding([], threadA, { ...scopeA, factText: 'private' }), /scope is invalid/);
  assert.throws(() => setCodexThreadMemoryScopeBinding([], threadA, { ...scopeA, lineageId: 'lineage-invalid' }), /scope is invalid/);
  assert.throws(() => setCodexThreadMemoryScopeBinding([], threadA, { ...scopeA, projectId: 4 }), /scope is invalid/);
  assert.throws(() => normalizeCodexThreadMemoryScopeBindings([
    { codexThreadId: threadA, memoryScope: scopeA }, { codexThreadId: threadA, memoryScope: scopeB }
  ]), /unique thread IDs/);
  assert.throws(() => selectMemoryScopeForTurn({ codexThreadId: null }), /thread ID is invalid/);
  assert.throws(() => selectMemoryScopeForTurn({ codexThreadId: threadA, extra: true }), /selection is invalid/);
});

test('binding count is bounded and replacing an existing binding remains allowed at the limit', () => {
  const bindings = Array.from({ length: MAX_CODEX_THREAD_MEMORY_SCOPE_BINDINGS }, (_, index) => ({
    codexThreadId: `codex-thread-${String(index).padStart(4, '0')}`, memoryScope: scopeA
  }));
  assert.equal(normalizeCodexThreadMemoryScopeBindings(bindings).length, MAX_CODEX_THREAD_MEMORY_SCOPE_BINDINGS);
  assert.throws(() => setCodexThreadMemoryScopeBinding(bindings, 'codex-thread-9999', scopeB), /binding limit/);
  const replaced = setCodexThreadMemoryScopeBinding(bindings, bindings[0].codexThreadId, scopeB);
  assert.equal(replaced.length, MAX_CODEX_THREAD_MEMORY_SCOPE_BINDINGS);
  assert.deepEqual(replaced[0].memoryScope, scopeB);
  assert.throws(() => normalizeCodexThreadMemoryScopeBindings([...bindings, bindings[0]]), /at most/);
});
