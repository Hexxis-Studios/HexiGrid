import { normalizeOwnerMemory, reviseOwnerMemory } from './owner-memory.mjs';
import { stableContinuityJson } from './continuity-transfer.mjs';
import { assertContinuitySafe } from './continuity-security.mjs';
import crypto from 'node:crypto';

const writes = new WeakMap();
const fail = (message, status = 409, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

export function assertOwnerMemoryRetirementIdle(state, id) {
  if (writes.get(state)?.has(id)) throw fail('This owner-note standing change is in progress; retry after it completes.');
}

export function validateOwnerNoteRetirementRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['id', 'expectedRevision', 'why'].includes(key)) ||
      typeof input.id !== 'string' || !/^memory-[0-9a-f-]{36}$/i.test(input.id) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      typeof input.why !== 'string' || !input.why.trim() || input.why.length > 500) {
    throw fail('Owner-note retirement requires only an exact id, expectedRevision, and a reason of 1 to 500 characters.', 400);
  }
  try { assertContinuitySafe({ why: input.why }); }
  catch { throw fail('Owner-note retirement reason contains a possible secret. Remove it before retrying.', 400); }
  return { id: input.id.toLowerCase(), expectedRevision: input.expectedRevision, why: input.why.trim() };
}

export function validateOwnerNoteRestorationRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['id', 'expectedRevision', 'why', 'status'].includes(key)) ||
      !['active', 'conditional'].includes(input.status)) {
    throw fail('Owner-note restoration requires exact id, expectedRevision, why and active or conditional status.', 400);
  }
  const { status, ...rest } = input;
  try { return { ...validateOwnerNoteRetirementRequest(rest), status }; }
  catch (error) { throw fail(error.message.replaceAll('retirement', 'restoration'), error.status || 400); }
}

export function prepareOwnerMemoryRestoration(current, { expectedRevision, why, by, at, status }) {
  if (!['active', 'conditional'].includes(status)) throw fail('Restoration standing must be active or conditional.', 400);
  const memory = normalizeOwnerMemory(current), last = memory.revisions.at(-1);
  if (memory.status === status && memory.revisions.length === expectedRevision + 1 &&
      last?.by === by && last?.why === why && last.changes?.status?.from === 'historical' && last.changes.status.to === status) {
    return { memory: current, duplicate: true };
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== memory.revisions.length) {
    throw fail('Owner memory revision conflict; reload the current note.');
  }
  if (memory.status !== 'historical') throw fail('Only a historical owner note can be restored.');
  try { return { memory: reviseOwnerMemory(memory, { status }, { by, why, at }), duplicate: false }; }
  catch (error) { throw fail(error.message, 400); }
}

export function commitOwnerMemoryRetirement(input) { return commitOwnerMemoryStanding({ ...input, operation: 'retire' }); }
export function commitOwnerMemoryRestoration(input) { return commitOwnerMemoryStanding({ ...input, operation: 'restore' }); }

export function prepareOwnerMemoryRetirement(current, { expectedRevision, why, by, at, currentOnly = false }) {
  const memory = normalizeOwnerMemory(current);
  const last = memory.revisions.at(-1);
  // An exact retry can recover its result without appending another revision.
  const replay = currentOnly && memory.status === 'historical' &&
    memory.revisions.length === expectedRevision + 1 && last?.by === by && last?.why === why &&
    ['active', 'conditional'].includes(last.changes?.status?.from) && last.changes.status.to === 'historical';
  if (replay) return { memory: current, duplicate: true };
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== memory.revisions.length) {
    throw fail('Owner memory revision conflict; reload the current note.');
  }
  if (!currentOnly && memory.status === 'historical') return { memory: current, duplicate: true };
  if (currentOnly && !['active', 'conditional'].includes(memory.status)) {
    throw fail('Only a current owner note can be retired.');
  }
  return { memory: reviseOwnerMemory(memory, { status: 'historical' }, { by, why, at }), duplicate: false };
}

/** Share existing append-only standing changes between owner and signed routes.
 * Keep the change private until durable publication, preserving concurrent work. */
async function commitOwnerMemoryStanding({ state, id, agentId, expectedRevision, why, by, at,
  currentOnly = false, authorize, beforeCommit, saveState, operation = 'retire', status }) {
  const label = operation === 'restore' ? 'restoration' : 'retirement';
  if (typeof authorize !== 'function' || typeof saveState !== 'function') {
    throw new TypeError(`Owner-note ${label} requires authority and persistence adapters.`);
  }
  const active = writes.get(state) || new Set();
  if (active.has(id)) throw fail('This owner-note standing change is in progress; retry after it completes.');
  writes.set(state, active); active.add(id);
  const assertAuthorized = () => {
    const result = authorize();
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw fail(`Owner-note ${label} authorization must be synchronous.`, 503);
    }
    if (result === false || result?.allowed === false) throw fail(`Owner-note ${label} is no longer authorized.`, 403);
  };
  try {
    assertAuthorized();
    const original = state.memories.find(item => item.id === id && item.agentId === agentId);
    if (!original) throw fail('Owner note not found for this agent.', 404);
    const prepared = operation === 'restore'
      ? prepareOwnerMemoryRestoration(original, { expectedRevision, why, by, at, status })
      : prepareOwnerMemoryRetirement(original, { expectedRevision, why, by, at, currentOnly });
    if (prepared.duplicate) return prepared;
    if (beforeCommit) {
      const result = beforeCommit({ operation, id, agentId, current: original, next: prepared.memory });
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw fail(`Owner-note ${label} pre-commit checks must be synchronous.`, 503, 'OWNER_NOTE_PRECOMMIT_ASYNC');
      }
      if (result === false || result?.allowed === false) throw fail(result?.message || `Owner-note ${label} pre-commit checks denied the write.`,
        result?.status || 429, result?.code);
    }
    const staged = prepared.memory;
    const originalSnapshot = stableContinuityJson(original);
    const guard = () => {
      assertAuthorized();
      if (state.memories.find(item => item.id === id && item.agentId === agentId) !== original ||
          stableContinuityJson(original) !== originalSnapshot) throw fail(`The exact owner-note revision changed before ${label} was saved.`);
    };
    const receipt = { id: `receipt-${crypto.randomUUID().slice(0, 8)}`, createdAt: at,
      agentId, action: `memory:${operation}-owner-note`, capability: 'write_workspace', risk: 'medium', status: 'completed',
      detail: operation === 'restore'
        ? 'One exact historical owner note was restored to current recall. History remains local. Note text and the reason were excluded.'
        : 'One exact owner note was retired from current recall. Its history remains local. Note text and the reason were excluded.', source: 'memory' };
    guard();
    let publicationChanged = false;
    await saveState({ assertAuthorized: guard,
      prepareSnapshot: snapshot => {
        snapshot.memories = snapshot.memories.map(item => item.id === id && item.agentId === agentId ? staged : item);
        snapshot.receipts = [receipt, ...(snapshot.receipts || [])].slice(0, 10000);
        return snapshot;
      },
      commit: () => {
        publicationChanged = state.memories.find(item => item.id === id && item.agentId === agentId) !== original;
        state.memories = state.memories.map(item => item === original ? staged : item);
        state.receipts = [receipt, ...(state.receipts || [])].slice(0, 10000);
      }
    });
    if (publicationChanged) throw fail(`The ${label} was saved, but the note changed during publication; refresh before retrying.`);
    return { memory: staged, duplicate: false, receiptId: receipt.id };
  } catch (error) {
    throw error.status ? error : fail(`Owner-note ${label} could not be saved; refresh before retrying.`, 503);
  } finally {
    active.delete(id);
    if (!active.size) writes.delete(state);
  }
}
