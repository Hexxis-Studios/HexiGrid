import crypto from 'node:crypto';
import { normalizeContextScope } from './dated-memory.mjs';
import { findActiveMemoryShare, normalizeMemoryShares } from './memory-sharing.mjs';
import { assertContinuitySafe } from './continuity-security.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LINEAGE_ID = new RegExp(`^lineage-${UUID}$`, 'i');
const MISTAKE_ID = new RegExp(`^mistake-${UUID}$`, 'i');
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const AUTHOR_KINDS = new Set(['owner', 'agent', 'system']);
const EVIDENCE_KINDS = new Set(['dated-memory', 'link-message', 'link-event', 'owner-feedback', 'room', 'task']);
const MAX_RECURRENCES = 8;
const DEFAULT_WARNING_COUNT = 3;
const MAX_WARNING_COUNT = 5;
const DEFAULT_WARNING_BYTES = 4096;
const MAX_WARNING_BYTES = 8192;

const fail = (message, code = 'invalid_memory_mistake', status = 400) =>
  Object.assign(new Error(message), { code, status });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

function boundedText(value, label, maxBytes, { required = true } = {}) {
  if (typeof value !== 'string') throw fail(`${label} must be text.`);
  const text = value.trim();
  if ((required && !text) || Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw fail(`${label} is empty or exceeds its size limit.`);
  }
  return text;
}

function normalizeAuthority(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['agentId', 'lineageId', 'contextScope', 'author'].includes(key)) ||
    typeof value.agentId !== 'string' || !CONTEXT_ID.test(value.agentId) ||
    typeof value.lineageId !== 'string' || !LINEAGE_ID.test(value.lineageId) ||
    !value.author || typeof value.author !== 'object' || Array.isArray(value.author) ||
    Object.keys(value.author).some(key => !['kind', 'id'].includes(key)) ||
    !AUTHOR_KINDS.has(value.author.kind) || typeof value.author.id !== 'string' || !CONTEXT_ID.test(value.author.id)) {
    throw fail('Memory mistake writes require trusted agent, lineage, and author identity.', 'invalid_mistake_authority', 403);
  }
  let contextScope;
  try { contextScope = normalizeContextScope(value.contextScope === undefined ? null : value.contextScope); }
  catch { throw fail('Memory mistake scope is invalid.', 'invalid_mistake_scope'); }
  return Object.freeze({ agentId: String(value.agentId), lineageId: String(value.lineageId).toLowerCase(),
    author: Object.freeze({ kind: value.author.kind, id: String(value.author.id) }), contextScope });
}

function normalizeEvidenceReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['kind', 'id'].includes(key)) ||
    !EVIDENCE_KINDS.has(value.kind) || typeof value.id !== 'string' || !OPAQUE_ID.test(value.id)) {
    throw fail('A mistake record needs a typed, stable evidence reference.', 'mistake_evidence_required');
  }
  return { kind: value.kind, id: String(value.id) };
}

export function normalizeMemoryMistakeRecurrences(value) {
  if (!Array.isArray(value) || value.length > MAX_RECURRENCES) {
    throw fail(`A mistake record can reference at most ${MAX_RECURRENCES} prior records.`, 'invalid_mistake_recurrence');
  }
  const seen = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !MISTAKE_ID.test(String(item.id || '')) ||
      Object.keys(item).some(key => !['id', 'lineageId', 'agentId'].includes(key)) ||
      !LINEAGE_ID.test(String(item.lineageId || '')) || !CONTEXT_ID.test(String(item.agentId || ''))) {
      throw fail('Mistake recurrence references need exact record, agent, and lineage identities.', 'invalid_mistake_recurrence');
    }
    const reference = { id: String(item.id).toLowerCase(), lineageId: String(item.lineageId).toLowerCase(),
      agentId: String(item.agentId) };
    const key = `${reference.lineageId}\u0000${reference.id}`;
    if (seen.has(key)) throw fail('Mistake recurrence references must be unique.', 'invalid_mistake_recurrence');
    seen.add(key);
    return reference;
  });
}

function makeMistakeId(authority, idempotencyKey) {
  const hex = digest(`${authority.lineageId}\u0000${authority.author.kind}\u0000${authority.author.id}\u0000${idempotencyKey}`).slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `mistake-${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function authorizeSynchronously(authorize, context) {
  const result = authorize(context);
  if (result && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw fail('Mistake-ledger authorization must be synchronous.', 'invalid_mistake_authorization', 500);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
    (result.allowed !== true && result.allowed !== false)) {
    throw fail('Mistake-ledger authorization returned an invalid result.', 'invalid_mistake_authorization', 500);
  }
  if (!result.allowed) throw fail('The mistake-ledger operation is not authorized.', 'mistake_not_authorized', 403);
  return result;
}

function normalizeEvidenceResult(value, requested) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.verified !== true ||
    value.kind !== requested.kind || value.id !== requested.id) {
    throw fail('The referenced source could not verify this mistake evidence.', 'mistake_evidence_unverified', 409);
  }
  return Object.freeze({ kind: value.kind, id: value.id,
    excerpt: boundedText(value.excerpt, 'Verified evidence excerpt', 4096),
    observedAt: normalizeIso(value.observedAt, 'Evidence observation time') });
}

function normalizeIso(value, label) {
  const selected = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(selected) ||
    !Number.isFinite(Date.parse(selected)) || new Date(selected).toISOString() !== selected) {
    throw fail(`${label} must be a canonical UTC timestamp.`);
  }
  return selected;
}

function normalizeStoredRecord(record) {
  if (!record || typeof record !== 'object' || record.format !== 'hexigrid-memory-mistake' || record.version !== 1 ||
    !MISTAKE_ID.test(String(record.id || '')) || !LINEAGE_ID.test(String(record.lineageId || '')) ||
    !CONTEXT_ID.test(String(record.agentId || '')) || !record.author || !AUTHOR_KINDS.has(record.author.kind) ||
    !CONTEXT_ID.test(String(record.author.id || '')) || !Number.isFinite(Date.parse(record.createdAt)) ||
    !record.evidence || !EVIDENCE_KINDS.has(record.evidence.kind) || !OPAQUE_ID.test(String(record.evidence.id || '')) ||
    typeof record.evidence.excerpt !== 'string' || !OPAQUE_ID.test(String(record.evidence.id || '')) ||
    !Number.isFinite(Date.parse(record.evidence.observedAt)) || typeof record.whatWentWrong !== 'string' ||
    typeof record.correction !== 'string' || typeof record.resultingFix !== 'string' || !Array.isArray(record.recurrenceOf)) return null;
  let contextScope;
  try { contextScope = normalizeContextScope(record.contextScope); } catch { return null; }
  if (contextScope && (!CONTEXT_ID.test(contextScope.projectId) || contextScope.topicId && !CONTEXT_ID.test(contextScope.topicId))) return null;
  if (record.importance !== 1 || record.recurrenceOf.length > MAX_RECURRENCES ||
    record.recurrenceOf.some(ref => !MISTAKE_ID.test(String(ref.id || '')) ||
    !LINEAGE_ID.test(String(ref.lineageId || '')) || !CONTEXT_ID.test(String(ref.agentId || '')))) return null;
  if (Buffer.byteLength(record.whatWentWrong, 'utf8') > 2048 || Buffer.byteLength(record.correction, 'utf8') > 2048 ||
    Buffer.byteLength(record.resultingFix, 'utf8') > 2048 || Buffer.byteLength(record.evidence.excerpt, 'utf8') > 4096 ||
    !/^[0-9a-f]{64}$/.test(String(record.requestDigest || ''))) return null;
  try {
    normalizeIso(record.createdAt, 'Mistake record time');
    normalizeIso(record.evidence.observedAt, 'Evidence observation time');
    boundedText(record.whatWentWrong, 'What went wrong', 2048);
    boundedText(record.correction, 'Correction', 2048);
    boundedText(record.resultingFix, 'Resulting fix', 2048);
    boundedText(record.evidence.excerpt, 'Verified evidence excerpt', 4096);
  } catch { return null; }
  const expectedDigest = digest(stable({ authority: { agentId: record.agentId,
    lineageId: record.lineageId.toLowerCase(), contextScope, author: record.author },
    whatWentWrong: record.whatWentWrong, correction: record.correction, resultingFix: record.resultingFix,
    evidence: record.evidence, recurrenceOf: record.recurrenceOf }));
  if (record.requestDigest !== expectedDigest) return null;
  try { assertContinuitySafe(record); } catch { return null; }
  return record;
}

/**
 * First-class append-only mistake records. All persistence and policy remain
 * injected: this module has no direct access to server state or dated logs.
 */
export function createMemoryMistakeLedger({ authorize, verifyEvidence, resolveRecurrence, loadById, commit,
  now = () => new Date().toISOString() } = {}) {
  if (typeof authorize !== 'function' || typeof verifyEvidence !== 'function' ||
    typeof loadById !== 'function' || typeof commit !== 'function') {
    throw new TypeError('The mistake ledger requires authorization, evidence verification, lookup, and authorized commit functions.');
  }

  async function record(input = {}, trustedAuthority) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['whatWentWrong', 'correction', 'resultingFix', 'evidence', 'recurrenceOf', 'idempotencyKey'].includes(key))) {
      throw fail('Mistake record fields are invalid.');
    }
    const { whatWentWrong, correction, resultingFix, evidence, recurrenceOf = [], idempotencyKey } = input;
    const authority = normalizeAuthority(trustedAuthority);
    if (typeof idempotencyKey !== 'string' || !OPAQUE_ID.test(idempotencyKey)) {
      throw fail('Mistake records require a stable idempotency key.', 'mistake_idempotency_required');
    }
    const requestedEvidence = normalizeEvidenceReference(evidence);
    const wrong = boundedText(whatWentWrong, 'What went wrong', 2048);
    const correctionText = boundedText(correction, 'Correction', 2048);
    const fix = boundedText(resultingFix, 'Resulting fix', 2048);
    const references = normalizeMemoryMistakeRecurrences(recurrenceOf);
    const id = makeMistakeId(authority, idempotencyKey);
    const payload = { whatWentWrong: wrong, correction: correctionText, resultingFix: fix,
      evidence: requestedEvidence, recurrenceOf: references };
    assertContinuitySafe(payload);
    authorizeSynchronously(authorize, { action: 'memory-mistake:record', phase: 'validate', authority });

    const verified = normalizeEvidenceResult(await verifyEvidence({ reference: requestedEvidence, authority }), requestedEvidence);
    assertContinuitySafe(verified);
    if (references.length) {
      if (typeof resolveRecurrence !== 'function') throw fail('Recurrence references require an authorized resolver.', 'mistake_recurrence_unavailable', 409);
      for (const reference of references) {
        const resolved = await resolveRecurrence({ reference, authority });
        const current = normalizeStoredRecord(resolved);
        if (!current || current.id.toLowerCase() !== reference.id || current.lineageId.toLowerCase() !== reference.lineageId || current.agentId !== reference.agentId) {
          throw fail('A recurrence reference could not be verified in its authorized source.', 'mistake_recurrence_unverified', 409);
        }
      }
    }

    const timestamp = normalizeIso(now(), 'Mistake record time');
    const requestDigest = digest(stable({ authority, ...payload, evidence: verified }));
    const record = Object.freeze({ format: 'hexigrid-memory-mistake', version: 1, id, lineageId: authority.lineageId,
      agentId: authority.agentId, contextScope: authority.contextScope,
      author: authority.author, createdAt: timestamp, importance: 1,
      whatWentWrong: wrong, correction: correctionText, resultingFix: fix,
      evidence: verified, recurrenceOf: references, requestDigest });

    const existing = await loadById({ id, lineageId: authority.lineageId, agentId: authority.agentId,
      contextScope: authority.contextScope, author: authority.author });
    authorizeSynchronously(authorize, { action: 'memory-mistake:record', phase: 'commit', authority, record });
    if (existing) {
      const stored = normalizeStoredRecord(existing);
      if (!stored || stored.id !== id || stored.lineageId.toLowerCase() !== authority.lineageId ||
        stored.requestDigest !== requestDigest || stored.agentId !== authority.agentId ||
        stable(stored.contextScope) !== stable(authority.contextScope) || stable(stored.author) !== stable(authority.author)) {
        throw fail('The stable mistake ID is already bound to different content or authority.', 'mistake_idempotency_conflict', 409);
      }
      return Object.freeze({ recorded: true, duplicate: true, id: stored.id, recurrenceCount: stored.recurrenceOf.length });
    }

    // No await occurs between the final synchronous authorization and invoking
    // the injected commit path. Durable integrations must recheck authorization
    // inside their transaction immediately before append if they await first.
    authorizeSynchronously(authorize, { action: 'memory-mistake:record', phase: 'commit-immediate', authority, record });
    const result = await commit(record, { requestDigest, idempotencyKey,
      assertAuthorized: () => authorizeSynchronously(authorize,
        { action: 'memory-mistake:record', phase: 'commit-immediate', authority, record }) });
    if (!result || typeof result !== 'object' || typeof result.created !== 'boolean') {
      throw fail('The authorized mistake commit returned no safe receipt.', 'mistake_commit_invalid', 500);
    }
    const committed = normalizeStoredRecord(result.record);
    if (!committed || committed.id !== record.id || committed.requestDigest !== requestDigest) {
      throw fail('The authorized mistake commit returned a mismatched record.', 'mistake_commit_mismatch', 500);
    }
    return Object.freeze({ recorded: true, duplicate: !result.created, id: committed.id,
      recurrenceCount: committed.recurrenceOf.length });
  }

  return Object.freeze({ record });
}

function datedMemoryId(mistakeId) {
  if (!MISTAKE_ID.test(String(mistakeId || ''))) throw fail('Mistake record identity is invalid.');
  return `memory-${String(mistakeId).slice('mistake-'.length).toLowerCase()}`;
}

function sameScope(left, right) {
  return stable(normalizeContextScope(left)) === stable(normalizeContextScope(right));
}

export function canonicalRecordFromDatedEntry(entry, expected = {}) {
  if (!entry || typeof entry !== 'object' ||
    (expected.lineageId && String(entry.lineageId || '').toLowerCase() !== String(expected.lineageId).toLowerCase()) ||
    (expected.agentId && entry.agentId !== expected.agentId) ||
    (expected.scope !== undefined && !sameScope(entry.contextScope ?? null, expected.scope))) return null;
  const payload = entry.metadata?.memoryMistake;
  if (payload?.format !== 'hexigrid-memory-mistake' || payload.version !== 1) return null;
  const canonical = normalizeStoredRecord(payload.record);
  if (!canonical || String(entry.id || '').toLowerCase() !== datedMemoryId(canonical.id) ||
    String(entry.lineageId || '').toLowerCase() !== canonical.lineageId.toLowerCase() ||
    entry.agentId !== canonical.agentId || !sameScope(entry.contextScope ?? null, canonical.contextScope)) return null;
  return { ...canonical,
    ...(typeof entry.status === 'string' ? { status: entry.status } : {}),
    ...(Number.isSafeInteger(entry.revision) ? { revision: entry.revision } : { revision: 0 }),
    ...(Array.isArray(entry.revisions) ? { revisions: entry.revisions } : { revisions: [] }),
    ...(typeof entry.updatedAt === 'string' ? { updatedAt: entry.updatedAt } : {}) };
}

export function memoryMistakeDatedEntry(record) {
  if (!normalizeStoredRecord(record)) throw fail('Canonical mistake record is invalid.', 'invalid_memory_mistake');
  const createdAt = normalizeIso(record.createdAt, 'Mistake record time');
  return Object.freeze({
    lineageId: record.lineageId,
    agentId: record.agentId,
    date: createdAt.slice(0, 10),
    createdAt,
    id: datedMemoryId(record.id),
    text: `Past mistake: ${record.whatWentWrong}\nCorrection: ${record.correction}\nResulting fix: ${record.resultingFix}`,
    status: 'historical',
    metadata: { memoryMistake: { format: 'hexigrid-memory-mistake', version: 1, record } },
    evidence_excerpt: record.evidence.excerpt,
    contextScope: record.contextScope,
    originKind: record.author.kind === 'owner' ? 'owner-entry' : 'agent-proposal',
    importance: 1,
    identityAnchor: false
  });
}

function normalizeReadAuthority(authority, target = {}) {
  const normalized = normalizeAuthority(authority);
  if ((target.lineageId && normalized.lineageId !== String(target.lineageId).toLowerCase()) ||
    (target.agentId && normalized.agentId !== target.agentId) ||
    (target.scope !== undefined && !sameScope(normalized.contextScope, target.scope))) {
    throw fail('The mistake-ledger read authority does not match the exact requested lineage, agent, and scope.',
      'mistake_not_authorized', 403);
  }
  return normalized;
}

/**
 * Adapt the evidence-backed ledger to the canonical append-only dated-memory
 * log. Persistence and revision mutations are deliberately injected services:
 * this adapter never calls DatedMemoryStore.append/appendRevision directly.
 */
export function createDatedMemoryMistakeLedger({ store, authorize, verifyEvidence, resolveRecurrence,
  commit, revise, now = () => new Date().toISOString() } = {}) {
  if (!store || typeof store.getById !== 'function' || typeof store.listMemoryMistakes !== 'function' ||
    typeof authorize !== 'function' || typeof verifyEvidence !== 'function' ||
    typeof commit !== 'function' || typeof revise !== 'function') {
    throw new TypeError('Dated mistake persistence requires the canonical store and injected authorized read, commit, and revision services.');
  }

  async function loadById({ id, lineageId, agentId, contextScope, author } = {}) {
    const authority = normalizeReadAuthority({ agentId, lineageId, contextScope, author },
      { lineageId, agentId, scope: contextScope });
    authorizeSynchronously(authorize, { action: 'memory-mistake:read', phase: 'lookup', authority, id });
    const entry = await store.getById({ lineageId: authority.lineageId, id: datedMemoryId(id), depth: 2 });
    authorizeSynchronously(authorize, { action: 'memory-mistake:read', phase: 'lookup-complete', authority, id });
    return canonicalRecordFromDatedEntry(entry, { lineageId: authority.lineageId,
      agentId: authority.agentId, scope: authority.contextScope });
  }

  const localResolver = async ({ reference, authority } = {}) => {
    if (reference?.lineageId !== authority?.lineageId || reference?.agentId !== authority?.agentId) {
      if (typeof resolveRecurrence !== 'function') {
        throw fail('Cross-agent or cross-lineage recurrence requires an authorized resolver.',
          'mistake_recurrence_unavailable', 409);
      }
      const prior = await resolveRecurrence({ reference, authority });
      authorizeSynchronously(authorize, { action: 'memory-mistake:read', phase: 'recurrence-complete', authority, reference });
      return prior;
    }
    authorizeSynchronously(authorize, { action: 'memory-mistake:read', phase: 'recurrence', authority, reference });
    const entry = await store.getById({ lineageId: authority.lineageId,
      id: datedMemoryId(reference.id), depth: 2 });
    authorizeSynchronously(authorize, { action: 'memory-mistake:read', phase: 'recurrence-complete', authority, reference });
    const prior = canonicalRecordFromDatedEntry(entry, { lineageId: reference.lineageId,
      agentId: reference.agentId });
    return prior;
  };

  const ledger = createMemoryMistakeLedger({ authorize, verifyEvidence,
    resolveRecurrence: localResolver,
    loadById,
    commit: async (record, options) => {
      const entry = memoryMistakeDatedEntry(record);
      options.assertAuthorized();
      const receipt = await commit({ action: 'memory-mistake:commit', record, entry,
        authority: { agentId: record.agentId, lineageId: record.lineageId,
          contextScope: record.contextScope, author: record.author },
        requestDigest: record.requestDigest, idempotencyKey: options.idempotencyKey,
        assertAuthorized: options.assertAuthorized });
      if (!receipt || typeof receipt !== 'object' || typeof receipt.created !== 'boolean') {
        throw fail('The authorized dated-memory commit returned no safe receipt.', 'mistake_commit_invalid', 500);
      }
      const saved = canonicalRecordFromDatedEntry(receipt.entry || receipt.record, {
        lineageId: record.lineageId, agentId: record.agentId, scope: record.contextScope });
      if (!saved || saved.id !== record.id || saved.requestDigest !== record.requestDigest) {
        throw fail('The authorized dated-memory commit returned a mismatched record.', 'mistake_commit_mismatch', 500);
      }
      return { created: receipt.created, record: saved };
    }, now });

  async function list({ lineageId, agentId, contextScope, limit = 50 } = {}, trustedAuthority) {
    const scope = normalizeContextScope(contextScope);
    const authority = normalizeReadAuthority(trustedAuthority, { lineageId, agentId, scope });
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw fail('Memory mistake page limit is invalid.', 'invalid_mistake_limit');
    }
    authorizeSynchronously(authorize, { action: 'memory-mistake:list', phase: 'read', authority, limit });
    const entries = await store.listMemoryMistakes({ lineageId: authority.lineageId,
      agentId: authority.agentId, contextScope: scope, limit, depth: 2 });
    authorizeSynchronously(authorize, { action: 'memory-mistake:list', phase: 'read-complete', authority, limit });
    if (!Array.isArray(entries)) throw fail('The canonical memory store returned an invalid mistake list.',
      'mistake_store_invalid', 500);
    return entries.map(entry => canonicalRecordFromDatedEntry(entry, { lineageId: authority.lineageId,
      agentId: authority.agentId, scope })).filter(Boolean);
  }

  async function reject({ id, expectedRevision, why, createdAt } = {}, trustedAuthority) {
    const authority = normalizeAuthority(trustedAuthority);
    if (authority.author.kind !== 'owner') {
      throw fail('Only an authenticated owner may reject a mistake record.', 'mistake_owner_required', 403);
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw fail('Mistake rejection requires the current revision.', 'mistake_revision_required');
    }
    const record = await loadById({ id, lineageId: authority.lineageId, agentId: authority.agentId,
      contextScope: authority.contextScope, author: authority.author });
    if (!record) throw fail('The mistake record was not found in this exact lineage, agent, and scope.',
      'mistake_not_found', 404);
    if (record.revision !== expectedRevision) {
      throw fail('Mistake revision conflict; reload the current record.', 'mistake_revision_conflict', 409);
    }
    authorizeSynchronously(authorize, { action: 'memory-mistake:reject', phase: 'validate',
      authority, record, expectedRevision });
    if (record.status === 'rejected') return Object.freeze({ rejected: true, duplicate: true,
      id: record.id, revision: record.revision });
    const by = `owner:${authority.author.id}`;
    const reason = boundedText(why, 'Mistake rejection reason', 4096);
    const timestamp = normalizeIso(createdAt || now(), 'Mistake rejection time');
    authorizeSynchronously(authorize, { action: 'memory-mistake:reject', phase: 'commit-immediate',
      authority, record, expectedRevision });
    const receipt = await revise({ action: 'memory-mistake:reject', authority,
      lineageId: authority.lineageId, agentId: authority.agentId,
      id: record.id, memoryId: datedMemoryId(record.id), expectedRevision,
      createdAt: timestamp, by, why: reason, changes: { status: 'rejected' },
      assertAuthorized: () => authorizeSynchronously(authorize,
        { action: 'memory-mistake:reject', phase: 'commit-immediate', authority, record, expectedRevision }) });
    if (!receipt || typeof receipt !== 'object') {
      throw fail('The authorized mistake revision returned no receipt.', 'mistake_revision_invalid', 500);
    }
    const rejected = await loadById({ id, lineageId: authority.lineageId, agentId: authority.agentId,
      contextScope: authority.contextScope, author: authority.author });
    if (!rejected || rejected.status !== 'rejected' || rejected.revision !== expectedRevision + 1) {
      throw fail('The authorized revision did not persist the expected rejection.', 'mistake_revision_mismatch', 500);
    }
    return Object.freeze({ rejected: true, duplicate: false, id: rejected.id, revision: rejected.revision });
  }

  return Object.freeze({ record: ledger.record, list, reject });
}

function scopeCovered(recordScope, shareScope) {
  if (!recordScope || recordScope.projectId !== shareScope.projectId) return false;
  if (recordScope.topicId === undefined) return true;
  return shareScope.topicId !== undefined && recordScope.topicId === shareScope.topicId;
}

function warningProjection(record) {
  const retirementAudit = (Array.isArray(record.revisions) ? record.revisions : [])
    .filter(revision => ['historical', 'superseded'].includes(revision?.changes?.status))
    .map(revision => ({ id: revision.id, number: revision.number, at: revision.at,
      by: revision.by, why: revision.why, standing: revision.changes.status }));
  return { kind: 'past-mistake', id: record.id, agentId: record.agentId, lineageId: record.lineageId,
    contextScope: record.contextScope, author: record.author, createdAt: record.createdAt,
    status: record.status || 'historical', ...(retirementAudit.length ? { retirementAudit } : {}),
    importance: 1, whatWentWrong: record.whatWentWrong, correction: record.correction,
    resultingFix: record.resultingFix,
    evidence: { kind: record.evidence.kind, id: record.evidence.id, observedAt: record.evidence.observedAt },
    recurrenceOf: record.recurrenceOf,
    dataOnly: true };
}

function boundWarningText(projection) {
  for (const field of ['whatWentWrong', 'correction', 'resultingFix']) {
    if (Buffer.byteLength(projection[field], 'utf8') <= 512) continue;
    let text = '';
    for (const character of projection[field]) {
      if (Buffer.byteLength(text + character, 'utf8') > 512) break;
      text += character;
    }
    projection[field] = text;
    projection.contentExcerpt = true;
  }
  return projection;
}

function sharedWarningProjection(record) {
  const projection = warningProjection(record);
  delete projection.recurrenceOf;
  projection.recurrenceReferencesRedacted = record.recurrenceOf.length;
  return boundWarningText(projection);
}

// The caller has already authorized the exact canonical lineage and scope.
// Ranking is local; evidence excerpts never enter the warning projection.
export function buildLocalMemoryMistakeWarnings({ entries, scores, maxRecords = 3, maxBytes = 4096 } = {}) {
  if (!Array.isArray(entries) || !(scores instanceof Map)) return [];
  const count = Math.min(5, Math.max(0, Number.isSafeInteger(maxRecords) ? maxRecords : 3));
  const budget = Math.min(8192, Math.max(0, Number.isSafeInteger(maxBytes) ? maxBytes : 4096));
  const candidates = entries.map(entry => ({ entry, record: canonicalRecordFromDatedEntry(entry),
    score: Number(scores.get(entry.id)?.score ?? scores.get(entry.id)) }))
    .filter(item => item.record && item.record.status !== 'rejected' && item.score > 0)
    .sort((a, b) => b.score - a.score || b.record.createdAt.localeCompare(a.record.createdAt));
  const warnings = [];
  for (const { record } of candidates) {
    if (warnings.length >= count) break;
    const projection = boundWarningText(warningProjection(record));
    if (Buffer.byteLength(JSON.stringify([...warnings, projection]), 'utf8') <= budget) warnings.push(projection);
  }
  return warnings;
}

/**
 * Read warnings through one currently active, exact existing memory share.
 * Callers must confirm both the source and target lineages are currently active.
 * Unscoped records never cross agents; project/topic scope follows recall's
 * project-wide-plus-exact-topic rule.
 */
export function buildSharedMemoryMistakeWarnings({ records, shares, shareId, sourceAgentId, sourceLineageId,
  sourceLineageActive, targetAgentId, targetLineageId, targetLineageActive, targetLinkId, maxRecords = DEFAULT_WARNING_COUNT,
  maxBytes = DEFAULT_WARNING_BYTES } = {}) {
  const empty = { status: 'empty', format: 'hexigrid-memory-mistake-warnings', dataOnly: true, warnings: [], omittedCount: 0 };
  if (sourceLineageActive !== true || targetLineageActive !== true || !Array.isArray(records) || !Array.isArray(shares) ||
    !Number.isSafeInteger(maxRecords) || maxRecords < 0 || maxRecords > MAX_WARNING_COUNT ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_WARNING_BYTES) return empty;
  if (maxBytes < Buffer.byteLength(JSON.stringify(empty), 'utf8')) {
    throw fail('The warning byte budget is smaller than the minimum response envelope.', 'invalid_mistake_warning_budget');
  }
  let normalizedShares;
  try { normalizedShares = normalizeMemoryShares(shares); } catch { return empty; }
  const share = findActiveMemoryShare(normalizedShares, { id: shareId, targetAgentId, targetLineageId, targetLinkId });
  if (!share || share.sourceAgentId !== sourceAgentId || share.sourceLineageId !== sourceLineageId) return empty;

  const candidates = records.map(normalizeStoredRecord).filter(record => record && record.status !== 'rejected' &&
    record.agentId === sourceAgentId && record.lineageId === sourceLineageId &&
    scopeCovered(record.contextScope, share.scope))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  const header = { status: 'ready', format: 'hexigrid-memory-mistake-warnings', dataOnly: true };
  const warnings = [];
  let omittedCount = 0;
  for (const record of candidates) {
    const projection = sharedWarningProjection(record);
    if (warnings.length >= maxRecords) { omittedCount += 1; continue; }
    warnings.push(projection);
  }
  omittedCount = candidates.length - warnings.length;
  const output = () => warnings.length ? { ...header, warnings, omittedCount } : { ...empty, omittedCount };
  while (warnings.length && Buffer.byteLength(JSON.stringify(output()), 'utf8') > maxBytes) {
    warnings.pop();
    omittedCount += 1;
  }
  const result = output();
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) {
    throw fail('The warning byte budget cannot fit the omission receipt.', 'invalid_mistake_warning_budget');
  }
  if (!warnings.length) return result;
  return result;
}

export const memoryMistakeLedgerLimits = Object.freeze({ maxRecurrences: MAX_RECURRENCES,
  defaultWarningCount: DEFAULT_WARNING_COUNT, maxWarningCount: MAX_WARNING_COUNT,
  defaultWarningBytes: DEFAULT_WARNING_BYTES, maxWarningBytes: MAX_WARNING_BYTES });
