import { withMemoryLineageLock, recoverMemoryErasure, commitMemoryErasure } from './memory-erasure-transaction.mjs';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { assertContinuitySafe } from './continuity-security.mjs';
import { assessMemoryWriteRisk, memoryWriteRiskLimits } from './memory-risk.mjs';
import { stableContinuityJson } from './continuity-transfer.mjs';
import { entityAliasKey, matchConfirmedEntities, matchPendingEntities, materializeEntityRegistry,
  newEntityEventId, newEntityId, normalizeEntityEvent, normalizeEntityLabel, pendingEntityCandidates } from './memory-entities.mjs';

export const DATED_MEMORY_FORMAT = 'hexigrid-dated-memory';
export const DATED_MEMORY_VERSION = 1;
const LINEAGE_ID = /^lineage-[0-9a-f-]{36}$/i;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ENTRY_ID = /^memory-[0-9a-f-]{36}$/i;
const REVISION_ID = /^revision-[0-9a-f-]{36}$/i;
const EVALUATION_ID = /^evaluation-[0-9a-f-]{36}$/i;
const CONFLICT_ID = /^conflict-[0-9a-f-]{36}$/i;
const LEARNING_SOURCE_ID = /^(?:link-message|link-event|feedback)-[A-Za-z0-9-]{8,160}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEMORY_AS_OF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUSES = new Set(['active', 'conditional', 'superseded', 'disputed', 'rejected', 'historical']);
const CURRENT_STATUSES = new Set(['active', 'conditional']);
const ORIGIN_KINDS = new Set(['owner-entry', 'agent-proposal', 'automatic-learning', 'legacy-unknown']);
const VERIFICATIONS = new Set(['unverified', 'owner-confirmed']);
const UNVERIFIED_WARNING = '[UNVERIFIED SOURCE — verify before acting]';
const STALE_WARNING = '[STALE — re-verify before acting]';
const CONFLICT_WARNING = '[CONFLICT — review linked memories before acting]';
const CONFLICT_RELATIONS = new Set(['contradicts', 'supersedes']);
const AUDIT_HASH = /^[0-9a-f]{64}$/;
const AUDIT_GENESIS = '0'.repeat(64);
const MAX_TEXT_BYTES = memoryWriteRiskLimits.textBytes;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES_PER_DAY = 10000;

function assertMemoryWriteRiskSafe(candidate) {
  // Keep the credential boundary first. Risk reasons are deliberately fixed
  // and content-free so they are safe to return from local write APIs.
  assertContinuitySafe(candidate);
  const assessment = assessMemoryWriteRisk(candidate);
  if (assessment.disposition !== 'quarantine') return;
  const error = new Error('Memory content requires safety review.');
  error.code = 'MEMORY_RISK_QUARANTINED';
  error.status = 422;
  error.reasonCodes = Object.freeze(assessment.reasonCodes.slice(0, 4));
  throw error;
}

function ensureDate(value) {
  const date = String(value || '');
  if (!DATE.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('Memory logs require a valid ISO calendar date.');
  }
  return date;
}

export function normalizeMemoryAsOf(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !MEMORY_AS_OF.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Memory as-of time must be a canonical UTC ISO timestamp.');
  }
  return value;
}

export function normalizeMemoryValidAt(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !MEMORY_AS_OF.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Memory valid-at time must be a canonical UTC ISO timestamp.');
  }
  return value;
}

function ensureLineageId(value) {
  const lineageId = String(value || '').toLowerCase();
  if (!LINEAGE_ID.test(lineageId)) throw new Error('Memory logs require a valid continuity lineage.');
  return lineageId;
}

function ensureAgentId(value) {
  const agentId = String(value || '').trim();
  if (!AGENT_ID.test(agentId)) throw new Error('Memory logs require a valid agent identity.');
  return agentId;
}

function iso(value = new Date().toISOString()) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf())) throw new Error('Memory logs require a valid timestamp.');
  return timestamp.toISOString();
}

function safeClone(value, maxBytes, label) {
  const serialized = stableContinuityJson(value ?? {});
  if (Buffer.byteLength(serialized) > maxBytes) throw new Error(`${label} is too large.`);
  return JSON.parse(serialized);
}

function lineageDirectory(root, lineageId) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ensureLineageId(lineageId));
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Memory log path escaped its private root.');
  return target;
}

function datedFilePath(root, lineageId, date) {
  return path.join(lineageDirectory(root, lineageId), `${ensureDate(date)}.json`);
}

async function rejectSymlink(filePath, { allowMissing = false } = {}) {
  try {
    const details = await lstat(filePath);
    if (details.isSymbolicLink()) throw new Error('Memory logs cannot use symbolic links.');
    return details;
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
}

function boundedString(value, maxBytes, label, { required = false } = {}) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new Error(`${label} is required.`);
  if (Buffer.byteLength(result, 'utf8') > maxBytes) throw new Error(`${label} is too large.`);
  return result;
}

function normalizeStatus(value) {
  const status = value === undefined ? 'active' : String(value);
  if (!STATUSES.has(status)) throw new Error('Memory status is invalid.');
  return status;
}

function normalizeOriginKind(value) {
  const originKind = value === undefined ? 'legacy-unknown' : String(value);
  if (!ORIGIN_KINDS.has(originKind)) throw new Error('Memory origin kind is invalid.');
  return originKind;
}

function normalizeVerification(value) {
  const verification = value === undefined ? 'unverified' : String(value);
  if (!VERIFICATIONS.has(verification)) throw new Error('Memory verification is invalid.');
  return verification;
}

function normalizeImportance(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Memory importance must be a number from 0 to 1.');
  }
  return value;
}

function defaultImportance(originKind) {
  if (originKind === 'owner-entry') return 1;
  if (originKind === 'agent-proposal' || originKind === 'automatic-learning') return 0.4;
  return 0.5;
}

function normalizeIdentityAnchor(value) {
  if (typeof value !== 'boolean') throw new Error('Memory identity anchor must be true or false.');
  return value;
}

function normalizeAudit(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => !['sequence', 'previousHash', 'hash'].includes(key)) ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
    !AUDIT_HASH.test(String(value.previousHash || '')) || !AUDIT_HASH.test(String(value.hash || ''))) {
    throw new Error('Memory audit link is invalid.');
  }
  return { sequence: value.sequence, previousHash: value.previousHash, hash: value.hash };
}

function auditPayload(event) {
  const { audit, sourceFile, chunkIndex, ...payload } = event;
  return payload;
}

function auditDigest(previousHash, event) {
  return crypto.createHash('sha256').update(`${previousHash}\n${stableContinuityJson(auditPayload(event))}`).digest('hex');
}

function auditTip(events) {
  let previousHash = AUDIT_GENESIS;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.audit) {
      if (event.audit.sequence !== index + 1 || event.audit.previousHash !== previousHash ||
        event.audit.hash !== auditDigest(previousHash, event)) throw new Error('Memory audit chain is broken.');
    }
    previousHash = auditDigest(previousHash, event);
  }
  return previousHash;
}

function linkAudit(event, earlierEvents) {
  const previousHash = auditTip(earlierEvents);
  return { ...event, audit: { sequence: earlierEvents.length + 1, previousHash,
    hash: auditDigest(previousHash, event) } };
}

function normalizeRollbackCheckpoint(value, lineageId, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    value.format !== 'hexigrid-memory-checkpoint-v1' || value.lineageId !== lineageId ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
    !AUDIT_HASH.test(String(value.hash || ''))) {
    throw new Error(`${label} is invalid or belongs to another memory lineage.`);
  }
  return { format: value.format, lineageId, sequence: value.sequence, hash: value.hash };
}

function checkpointHash(events, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > events.length) {
    throw new Error('Memory rollback checkpoint sequence is outside the retained audit history.');
  }
  return auditTip(events.slice(0, sequence));
}

function rollbackValue(record, key) {
  if (key === 'valid_while' || key === 'evidence_excerpt') return record[key] ?? '';
  if (key === 'verify_by' || key === 'valid_from' || key === 'valid_until' || key === 'contextScope') return record[key] ?? null;
  if (key === 'metadata') return record[key] ?? {};
  if (key === 'identityAnchor') return record[key] === true;
  return record[key];
}

function normalizeValidWhile(value) {
  return boundedString(value, memoryWriteRiskLimits.validWhileBytes, 'Memory valid_while');
}

function normalizeValidTime(value, label) {
  if (value === undefined || value === null) return value;
  try { return normalizeMemoryValidAt(value); }
  catch { throw new Error(`${label} must be a canonical UTC ISO timestamp.`); }
}

function validateValidityWindow(value) {
  const validFrom = value?.valid_from;
  const validUntil = value?.valid_until;
  if (validFrom && validUntil && Date.parse(validFrom) >= Date.parse(validUntil)) {
    throw new Error('Memory valid-time window must end after it starts.');
  }
}

function matchesValidityWindow(record, validAtMs) {
  if (!record || record.status === 'rejected' || typeof record.valid_from !== 'string') return false;
  const from = Date.parse(record.valid_from);
  const until = typeof record.valid_until === 'string' ? Date.parse(record.valid_until) : Infinity;
  return Number.isFinite(from) && from <= validAtMs && validAtMs < until;
}

function withinKnownValidityBounds(record, atMs) {
  if (!record || record.status === 'rejected') return false;
  if (typeof record.valid_from === 'string' && Date.parse(record.valid_from) > atMs) return false;
  if (typeof record.valid_until === 'string' && Date.parse(record.valid_until) <= atMs) return false;
  return true;
}

function normalizeMemoryReadNow(value) {
  if (value === undefined) return Date.now();
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8.64e15) {
    throw new Error('Memory read nowMs must be a finite UTC epoch-millisecond value.');
  }
  return value;
}

function normalizeVerifyBy(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Memory verify_by must be an ISO date or timestamp.');
  if (DATE.test(value)) return ensureDate(value);
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/);
  if (!match) {
    throw new Error('Memory verify_by must be an ISO date or timestamp.');
  }
  try {
    ensureDate(match[1]);
    if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 ||
      (match[6] && (Number(match[6]) > 23 || Number(match[7]) > 59))) {
      throw new Error('Invalid ISO clock time.');
    }
    return iso(value);
  }
  catch { throw new Error('Memory verify_by must be an ISO date or timestamp.'); }
}

function isStale(verifyBy, now = Date.now()) {
  if (!verifyBy) return false;
  const deadline = DATE.test(verifyBy) ? `${verifyBy}T23:59:59.999Z` : verifyBy;
  return now > Date.parse(deadline);
}

function recordAt(record, asOfMs) {
  // Rejected standing is final for retrieval. Even an earlier snapshot must
  // not resurrect content that is now explicitly rejected.
  if (!record || record.status === 'rejected' || Date.parse(record.createdAt) > asOfMs) return null;
  let previousRevisionMs = Date.parse(record.createdAt);
  for (const revision of record.revisions) {
    const revisionMs = Date.parse(revision.at);
    if (!Number.isFinite(revisionMs) || revisionMs < previousRevisionMs) {
      throw new Error('Memory revisions are not ordered by recorded timestamp; as-of recall is unavailable.');
    }
    previousRevisionMs = revisionMs;
  }
  const snapshot = { ...record, revisions: [...record.revisions],
    conflicts: record.conflicts.filter((item) => Date.parse(item.at) <= asOfMs),
    evaluations: record.evaluations.filter((item) => Date.parse(item.at) <= asOfMs) };
  let appliedRevision = 0;
  let updatedAt = record.createdAt;
  for (let index = record.revisions.length - 1; index >= 0; index -= 1) {
    const revision = record.revisions[index];
    if (Date.parse(revision.at) <= asOfMs) {
      appliedRevision = revision.number;
      updatedAt = revision.at;
      break;
    }
    for (const [key, value] of Object.entries(revision.previous)) {
      if (value === undefined) delete snapshot[key];
      else snapshot[key] = value;
    }
  }
  snapshot.revision = appliedRevision;
  snapshot.updatedAt = updatedAt;
  snapshot.revisions = record.revisions.filter((revision) => Date.parse(revision.at) <= asOfMs);
  return snapshot.status === 'rejected' ? null : snapshot;
}

function normalizeEvidence(value) {
  return boundedString(value, memoryWriteRiskLimits.evidenceExcerptBytes, 'Memory evidence excerpt');
}

export function normalizeContextScope(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Memory context scope is invalid.');
  const keys = Object.keys(value);
  if (!keys.includes('projectId') || keys.some((key) => !['projectId', 'topicId'].includes(key))) throw new Error('Memory context scope is invalid.');
  const projectId = String(value.projectId ?? '');
  if (!CONTEXT_ID.test(projectId)) throw new Error('Memory context project ID is invalid.');
  if (!Object.hasOwn(value, 'topicId')) return { projectId };
  const topicId = String(value.topicId ?? '');
  if (!CONTEXT_ID.test(topicId)) throw new Error('Memory context topic ID is invalid.');
  return { projectId, topicId };
}

function normalizeLearningSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || !['agent-link-message', 'owner-feedback'].includes(source.kind)) throw new Error('Memory correction source is invalid.');
  const sourceId = String(source.id ?? '');
  if (!LEARNING_SOURCE_ID.test(sourceId)) throw new Error('Memory correction source ID is invalid.');
  const text = String(source.text ?? '');
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('Memory correction source is empty or too large.');
  const linkId = source.kind === 'agent-link-message' ? boundedString(source.linkId, 160, 'Memory correction link ID', { required: true }) : '';
  return { kind: source.kind, id: sourceId, text, createdAt: iso(source.createdAt), ...(linkId ? { linkId } : {}) };
}

function normalizeLearning(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Memory correction evidence is invalid.');
  return {
    source: normalizeLearningSource(value.source),
    expectedNextBehavior: boundedString(value.expectedNextBehavior, 4096, 'Expected next behavior', { required: true })
  };
}

function normalizeChanges(value, { verificationOnly = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Memory revision changes are invalid.');
  const keys = Object.keys(value);
  if (verificationOnly) {
    if (keys.length !== 1 || keys[0] !== 'verification' || normalizeVerification(value.verification) !== 'owner-confirmed') {
      throw new Error('Memory verification revision is invalid.');
    }
    return { verification: 'owner-confirmed' };
  }
  if (!keys.length || keys.some((key) => !['text', 'status', 'valid_while', 'verify_by', 'valid_from', 'valid_until', 'metadata', 'evidence_excerpt', 'contextScope', 'importance', 'identityAnchor'].includes(key))) throw new Error('Memory revision changes are invalid.');
  const changes = {};
  if (Object.hasOwn(value, 'text')) {
    changes.text = String(value.text ?? '');
    if (!changes.text.trim() || Buffer.byteLength(changes.text, 'utf8') > MAX_TEXT_BYTES) throw new Error('A memory entry is empty or larger than 64 KB.');
  }
  if (Object.hasOwn(value, 'status')) changes.status = normalizeStatus(value.status);
  if (Object.hasOwn(value, 'valid_while')) changes.valid_while = normalizeValidWhile(value.valid_while);
  if (Object.hasOwn(value, 'verify_by')) changes.verify_by = normalizeVerifyBy(value.verify_by);
  if (Object.hasOwn(value, 'valid_from')) changes.valid_from = normalizeValidTime(value.valid_from, 'Memory valid_from');
  if (Object.hasOwn(value, 'valid_until')) changes.valid_until = normalizeValidTime(value.valid_until, 'Memory valid_until');
  if (Object.hasOwn(value, 'metadata')) changes.metadata = safeClone(value.metadata, MAX_METADATA_BYTES, 'Memory metadata');
  if (Object.hasOwn(value, 'evidence_excerpt')) changes.evidence_excerpt = normalizeEvidence(value.evidence_excerpt);
  if (Object.hasOwn(value, 'contextScope')) changes.contextScope = normalizeContextScope(value.contextScope);
  if (Object.hasOwn(value, 'importance')) changes.importance = normalizeImportance(value.importance);
  if (Object.hasOwn(value, 'identityAnchor')) changes.identityAnchor = normalizeIdentityAnchor(value.identityAnchor);
  validateValidityWindow(changes);
  return changes;
}

function normalizeEntry(input, { lineageId, date, now }) {
  const createdAt = iso(input?.createdAt || now);
  if (createdAt.slice(0, 10) !== date) throw new Error('A memory entry timestamp must match its dated log.');
  if (input?.kind === 'entity') {
    const event = normalizeEntityEvent(input, { lineageId, date, now: createdAt });
    if (input.audit !== undefined) event.audit = normalizeAudit(input.audit);
    assertContinuitySafe(event);
    return event;
  }
  if (input?.kind === 'conflict') {
    const conflictId = String(input.conflictId || '').toLowerCase();
    const fromId = String(input.fromId || '').toLowerCase();
    const toId = String(input.toId || '').toLowerCase();
    if (!CONFLICT_ID.test(conflictId) || !ENTRY_ID.test(fromId) || !ENTRY_ID.test(toId) || fromId === toId ||
      !CONFLICT_RELATIONS.has(input.relation)) throw new Error('Memory conflict link is invalid.');
    if (!Number.isSafeInteger(input.expectedFromRevision) || input.expectedFromRevision < 0 ||
      !Number.isSafeInteger(input.expectedToRevision) || input.expectedToRevision < 0) throw new Error('Memory conflict revision is invalid.');
    const by = boundedString(input.by, 200, 'Memory conflict authorizer', { required: true });
    if (!/^owner:[A-Za-z0-9._:-]+$/.test(by)) throw new Error('Memory conflict requires an authenticated owner.');
    const conflict = {
      kind: 'conflict', conflictId, lineageId, date, createdAt, fromId, toId,
      relation: input.relation, expectedFromRevision: input.expectedFromRevision,
      expectedToRevision: input.expectedToRevision, by,
      why: boundedString(input.why, 4096, 'Memory conflict reason', { required: true }),
      evidence: normalizeLearningSource(input.evidence),
      ...(input.valid_from === undefined ? {} : { valid_from: normalizeValidTime(input.valid_from, 'Memory conflict valid_from') }),
      ...(input.audit === undefined ? {} : { audit: normalizeAudit(input.audit) })
    };
    if (conflict.valid_from !== undefined && conflict.relation !== 'supersedes') {
      throw new Error('Only a supersedes conflict may close a valid-time window.');
    }
    assertContinuitySafe(conflict);
    return conflict;
  }
  if (input?.kind === 'evaluation') {
    if (!ENTRY_ID.test(String(input.id || '')) || !EVALUATION_ID.test(String(input.evaluationId || '')) || !REVISION_ID.test(String(input.correctionRevisionId || ''))) throw new Error('Memory evaluation identity is invalid.');
    const outcome = String(input.outcome || '');
    if (!['pass', 'fail', 'unknown'].includes(outcome)) throw new Error('Memory evaluation outcome is invalid.');
    const evaluation = {
      kind: 'evaluation', id: String(input.id).toLowerCase(), evaluationId: String(input.evaluationId).toLowerCase(),
      correctionRevisionId: String(input.correctionRevisionId).toLowerCase(), lineageId,
      agentId: ensureAgentId(input.agentId), date, createdAt, outcome,
      by: boundedString(input.by, 200, 'Memory evaluation authorizer', { required: true }),
      why: boundedString(input.why, 4096, 'Memory evaluation reason', { required: true }),
      observed: normalizeLearningSource(input.observed),
      ...(input.audit === undefined ? {} : { audit: normalizeAudit(input.audit) })
    };
    assertContinuitySafe(evaluation);
    return evaluation;
  }
  if (input?.kind === 'revision') {
    if (!ENTRY_ID.test(String(input.id || '')) || !REVISION_ID.test(String(input.revisionId || ''))) throw new Error('Memory revision identity is invalid.');
    const verificationOnly = input.verificationOnly === true;
    if (verificationOnly && input.learning !== undefined) throw new Error('Memory verification revision is invalid.');
    const revision = {
      kind: 'revision', id: String(input.id).toLowerCase(), revisionId: String(input.revisionId).toLowerCase(),
      lineageId, agentId: ensureAgentId(input.agentId), date, createdAt,
      expectedRevision: Number(input.expectedRevision),
      by: boundedString(input.by, 200, 'Memory revision authorizer', { required: true }),
      why: boundedString(input.why, 4096, 'Memory revision reason', { required: true }),
      changes: normalizeChanges(input.changes, { verificationOnly }),
      ...(verificationOnly ? { verificationOnly: true } : {}),
      ...(input.learning !== undefined ? { learning: normalizeLearning(input.learning) } : {}),
      ...(input.audit === undefined ? {} : { audit: normalizeAudit(input.audit) })
    };
    if (!Number.isSafeInteger(revision.expectedRevision) || revision.expectedRevision < 0) throw new Error('Memory revision number is invalid.');
    assertContinuitySafe(revision);
    return revision;
  }
  const text = String(input?.text ?? '');
  if (!text.trim()) throw new Error('A memory entry cannot be empty.');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('A memory entry is larger than 64 KB.');
  const metadata = safeClone(input?.metadata, MAX_METADATA_BYTES, 'Memory metadata');
  const verification = normalizeVerification(input?.verification);
  const originKind = normalizeOriginKind(input?.originKind);
  if (verification !== 'unverified') throw new Error('A base memory cannot be owner-confirmed.');
  const entry = {
    id: ENTRY_ID.test(String(input?.id || '')) ? String(input.id).toLowerCase() : `memory-${crypto.randomUUID()}`,
    lineageId,
    agentId: ensureAgentId(input?.agentId),
    date,
    createdAt,
    text,
    metadata,
    originKind,
    verification,
    ...(input?.importance === undefined ? {} : { importance: normalizeImportance(input.importance) }),
    ...(input?.identityAnchor === undefined ? {} : { identityAnchor: normalizeIdentityAnchor(input.identityAnchor) }),
    ...(input?.audit === undefined ? {} : { audit: normalizeAudit(input.audit) }),
    ...(input?.status !== undefined ? { status: normalizeStatus(input.status) } : {}),
    ...(input?.valid_from === undefined ? {} : { valid_from: normalizeValidTime(input.valid_from, 'Memory valid_from') }),
    ...(input?.valid_until === undefined ? {} : { valid_until: normalizeValidTime(input.valid_until, 'Memory valid_until') }),
    ...(input?.valid_while !== undefined ? { valid_while: normalizeValidWhile(input.valid_while) } : {}),
    ...(input?.verify_by !== undefined ? { verify_by: normalizeVerifyBy(input.verify_by) } : {}),
    ...(input?.evidence_excerpt !== undefined ? { evidence_excerpt: normalizeEvidence(input.evidence_excerpt) } : {}),
    ...(input?.contextScope !== undefined ? { contextScope: normalizeContextScope(input.contextScope) } : {})
  };
  validateValidityWindow(entry);
  if (entry.status === 'conditional' && !entry.valid_while) throw new Error('Conditional memory requires valid_while.');
  if (entry.identityAnchor && !entry.contextScope) throw new Error('A memory identity anchor requires a project scope.');
  assertContinuitySafe(entry);
  return entry;
}

export function validateMemoryProposal(input = {}) {
  const text = String(input.text ?? '');
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('A memory entry is empty or larger than 64 KB.');
  const proposal = {
    text, status: normalizeStatus(input.status), valid_while: normalizeValidWhile(input.valid_while),
    ...(Object.hasOwn(input, 'valid_from') ? { valid_from: normalizeValidTime(input.valid_from, 'Memory valid_from') } : {}),
    ...(Object.hasOwn(input, 'valid_until') ? { valid_until: normalizeValidTime(input.valid_until, 'Memory valid_until') } : {}),
    verify_by: input.verify_by === undefined ? null : normalizeVerifyBy(input.verify_by),
    evidence_excerpt: normalizeEvidence(input.evidence_excerpt),
    metadata: safeClone(input.metadata, MAX_METADATA_BYTES, 'Memory metadata'),
    contextScope: input.contextScope === undefined ? null : normalizeContextScope(input.contextScope)
  };
  validateValidityWindow(proposal);
  if (proposal.status === 'conditional' && !proposal.valid_while) throw new Error('Conditional memory requires valid_while.');
  assertContinuitySafe(proposal);
  return proposal;
}

function normalizeLog(value, { lineageId, date }) {
  if (value?.format !== DATED_MEMORY_FORMAT || value?.version !== DATED_MEMORY_VERSION || value?.lineageId !== lineageId || value?.date !== date || !Array.isArray(value?.entries)) {
    throw new Error('A dated memory log has an invalid format or identity.');
  }
  if (value.entries.length > MAX_ENTRIES_PER_DAY) throw new Error('A dated memory log exceeds its daily entry limit.');
  const ids = new Set();
  const entries = value.entries.map((entry) => {
    const normalized = normalizeEntry(entry, { lineageId, date, now: entry?.createdAt });
    if (normalized.audit && stableContinuityJson(entry) !== stableContinuityJson(normalized)) {
      throw new Error('Memory audit chain is broken.');
    }
    if (normalized.audit && normalized.audit.hash !== auditDigest(normalized.audit.previousHash, normalized)) {
      throw new Error('Memory audit chain is broken.');
    }
    const eventId = normalized.kind === 'revision' ? normalized.revisionId : normalized.kind === 'evaluation' ? normalized.evaluationId : normalized.kind === 'entity' ? normalized.eventId : normalized.kind === 'conflict' ? normalized.conflictId : normalized.id;
    if (ids.has(eventId)) throw new Error('A dated memory log contains duplicate entry IDs.');
    ids.add(eventId);
    return normalized;
  });
  return { format: DATED_MEMORY_FORMAT, version: DATED_MEMORY_VERSION, lineageId, date, entries };
}

function sameConflictScope(left, right) {
  return left && right && stableContinuityJson(left) === stableContinuityJson(right);
}

function conflictKey(relation, fromId, toId) {
  return relation === 'contradicts' ? `${relation}:${[fromId, toId].sort().join(':')}` : `${relation}:${fromId}:${toId}`;
}

function supersessionEffect(oldRecord, successor, event) {
  if (event.relation !== 'supersedes') return null;
  const boundary = event.valid_from ?? successor.valid_from;
  if (event.valid_from !== undefined && event.valid_from !== null && successor.valid_from !== undefined &&
    successor.valid_from !== null && event.valid_from !== successor.valid_from) {
    throw new Error('A supersedes boundary must match the successor valid_from.');
  }
  // Legacy supersedes links did not carry an effective boundary. Keep them
  // readable without inventing one from their recorded timestamp.
  if (boundary === undefined || boundary === null) return null;
  if (typeof successor.valid_until === 'string' && Date.parse(successor.valid_until) <= Date.parse(boundary)) {
    throw new Error('A superseding memory must remain valid at its valid_from boundary.');
  }
  if (typeof oldRecord.valid_until === 'string' && Date.parse(oldRecord.valid_until) < Date.parse(boundary)) {
    throw new Error('A supersedes boundary cannot extend an earlier valid_until.');
  }
  const changes = { status: 'superseded', valid_until: boundary };
  if (oldRecord.verification === 'owner-confirmed' && oldRecord.status !== 'superseded') {
    changes.verification = 'unverified';
  }
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, oldRecord[key]]));
  validateValidityWindow({ ...oldRecord, ...changes });
  return { boundary, changes, previous };
}

function validateConflictReferences(events) {
  const memories = new Map();
  const links = new Set();
  for (const event of events) {
    if (event.kind === 'entity' || event.kind === 'evaluation') continue;
    if (event.kind === 'revision') {
      const current = memories.get(event.id);
      if (!current) continue;
      if (Object.hasOwn(event.changes, 'contextScope') && current.hasConflict &&
        stableContinuityJson(event.changes.contextScope) !== stableContinuityJson(current.contextScope)) {
        throw new Error('A conflict-linked memory cannot move to another scope.');
      }
      if (Object.hasOwn(event.changes, 'contextScope')) current.contextScope = event.changes.contextScope;
      for (const key of ['status', 'valid_from', 'valid_until']) {
        if (Object.hasOwn(event.changes, key)) current[key] = event.changes[key];
      }
      validateValidityWindow(current);
      current.revision += 1;
      continue;
    }
    if (event.kind === 'conflict') {
      const from = memories.get(event.fromId);
      const to = memories.get(event.toId);
      if (!from || !to || from.revision !== event.expectedFromRevision || to.revision !== event.expectedToRevision ||
        !CURRENT_STATUSES.has(from.status) || !CURRENT_STATUSES.has(to.status) ||
        !sameConflictScope(from.contextScope, to.contextScope)) throw new Error('Memory conflict link requires two current revisions in the same exact scope.');
      const key = conflictKey(event.relation, event.fromId, event.toId);
      if (links.has(key)) throw new Error('Memory conflict link already exists.');
      links.add(key);
      const effect = supersessionEffect(to, from, event);
      if (effect) {
        Object.assign(to, effect.changes);
        validateValidityWindow(to);
        to.revision += 1;
      }
      from.hasConflict = true;
      to.hasConflict = true;
      continue;
    }
    if (ENTRY_ID.test(String(event.id || ''))) memories.set(event.id, {
      revision: 0, status: event.status || 'active', contextScope: event.contextScope === undefined ? null : event.contextScope,
      valid_from: event.valid_from, valid_until: event.valid_until, hasConflict: false
    });
  }
}

export function validateDatedMemoryBytes(content, { lineageId, date } = {}) {
  const selectedLineage = ensureLineageId(lineageId);
  const selectedDate = ensureDate(date);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content || '');
  if (bytes.length > MAX_FILE_BYTES) throw new Error('A dated memory log is larger than 8 MB.');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('A dated memory log cannot be read safely.'); }
  return normalizeLog(parsed, { lineageId: selectedLineage, date: selectedDate });
}

export function validateDatedMemoryChain(logs, { lineageId } = {}) {
  const selectedLineage = ensureLineageId(lineageId);
  if (!Array.isArray(logs)) throw new Error('Memory audit chain is broken.');
  const events = [];
  const dates = new Set();
  for (const log of [...logs].sort((left, right) => String(left?.date).localeCompare(String(right?.date)))) {
    const date = ensureDate(log?.date);
    if (dates.has(date)) throw new Error('Memory audit chain is broken.');
    dates.add(date);
    const normalized = normalizeLog(log, { lineageId: selectedLineage, date });
    normalized.entries.forEach((entry, chunkIndex) => events.push({ ...entry,
      sourceFile: `${selectedLineage}/${date}.json`, chunkIndex }));
  }
  const legacy = events.filter((event) => !event.audit);
  const linked = events.filter((event) => event.audit).sort((left, right) => left.audit.sequence - right.audit.sequence);
  const ordered = [...legacy, ...linked];
  auditTip(ordered);
  if (ordered.some((event) => ['entity', 'conflict'].includes(event.kind) && !event.audit)) throw new Error('Memory audit event is missing its link.');
  materializeEntityRegistry(ordered);
  validateConflictReferences(ordered);
  return ordered;
}

async function readLog(filePath, identity) {
  const details = await rejectSymlink(filePath, { allowMissing: true });
  if (!details) return { format: DATED_MEMORY_FORMAT, version: DATED_MEMORY_VERSION, ...identity, entries: [] };
  if (!details.isFile() || details.size > MAX_FILE_BYTES) throw new Error('A dated memory log is not a valid bounded file.');
  return validateDatedMemoryBytes(await readFile(filePath), identity);
}

async function writeAtomic(filePath, value, assertAuthorized) {
  const serialized = `${stableContinuityJson(value)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) throw new Error('A dated memory log is larger than 8 MB.');
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rejectSymlink(directory);
  await rejectSymlink(filePath, { allowMissing: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    if (assertAuthorized) {
      const checked = assertAuthorized();
      if (checked && typeof checked.then === 'function') throw new Error('Durable memory authorization must be synchronous.');
    }
    await rename(temporary, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function queueLinkedEvent(log, chain, input, { lineageId, date, now }) {
  const event = normalizeEntry(input, { lineageId, date, now });
  const linked = linkAudit(event, chain);
  log.entries.push(linked);
  chain.push(linked);
  return linked;
}

function queueEntityLinks(log, chain, record, { lineageId, date, now }) {
  let registry = materializeEntityRegistry(chain);
  const projectId = record.contextScope?.projectId || null;
  for (const candidate of pendingEntityCandidates(registry, record.text, { projectId })) {
    queueLinkedEvent(log, chain, { kind: 'entity', action: 'propose', eventId: newEntityEventId(),
      entityId: newEntityId(), label: candidate.label, entityType: candidate.entityType,
      projectId, sourceMemoryId: record.id, sourceRevision: record.revision, createdAt: now },
    { lineageId, date, now });
    registry = materializeEntityRegistry(chain);
  }
  const entityIds = [...new Set([
    ...matchConfirmedEntities(registry, record.text, { projectId }),
    ...matchPendingEntities(registry, record.text, { projectId })
  ])].sort();
  if (!entityIds.length && !(registry.links.get(record.id) || []).length) return;
  queueLinkedEvent(log, chain, { kind: 'entity', action: 'links', eventId: newEntityEventId(),
    memoryId: record.id, memoryRevision: record.revision, entityIds, createdAt: now },
  { lineageId, date, now });
}

function queueEntityRelinks(log, chain, records, { lineageId, date, now }) {
  const registry = materializeEntityRegistry(chain);
  for (const record of records.values()) {
    const projectId = record.contextScope?.projectId || null;
    const entityIds = [...new Set([
      ...matchConfirmedEntities(registry, record.text, { projectId }),
      ...matchPendingEntities(registry, record.text, { projectId })
    ])].sort();
    const previous = [...(registry.links.get(record.id) || [])].sort();
    if (stableContinuityJson(entityIds) === stableContinuityJson(previous)) continue;
    queueLinkedEvent(log, chain, { kind: 'entity', action: 'links', eventId: newEntityEventId(),
      memoryId: record.id, memoryRevision: record.revision, entityIds, createdAt: now },
    { lineageId, date, now });
  }
}

export class DatedMemoryStore {
  #root;
  #queues = new Map();
  #mutationStates = new Map();

  constructor({ root }) {
    if (!path.isAbsolute(String(root || ''))) throw new Error('Dated memory storage requires an absolute private root.');
    this.#root = path.resolve(root);
  }

  #erasureContext(lineageId) {
    return { directory: lineageDirectory(this.#root, lineageId), lineageId, writeLog: writeAtomic,
      validateLogs: logs => this.#materialize(validateDatedMemoryChain(logs, { lineageId })) };
  }

  async #events(lineageId) {
    return withMemoryLineageLock(lineageDirectory(this.#root, lineageId), async () => {
      await recoverMemoryErasure(this.#erasureContext(lineageId));
      return this.#readEvents(lineageId);
    });
  }

  async #readEvents(lineageId) {
    const directory = lineageDirectory(this.#root, lineageId);
    const details = await rejectSymlink(directory, { allowMissing: true });
    if (!details) return [];
    if (!details.isDirectory()) throw new Error('The memory lineage path is not a directory.');
    const names = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
    const logs = [];
    for (const name of names) {
      const date = name.slice(0, 10);
      logs.push(await readLog(path.join(directory, name), { lineageId, date }));
    }
    return validateDatedMemoryChain(logs, { lineageId });
  }

  #materialize(events) {
    const records = new Map();
    const revisionIds = new Set();
    for (const event of events) {
      if (event.kind === 'entity') continue;
      if (event.kind === 'conflict') {
        const from = records.get(event.fromId);
        const to = records.get(event.toId);
        if (!from || !to || from.revision !== event.expectedFromRevision || to.revision !== event.expectedToRevision ||
          !CURRENT_STATUSES.has(from.status) || !CURRENT_STATUSES.has(to.status) ||
          !sameConflictScope(from.contextScope, to.contextScope)) throw new Error('Memory conflict link requires two current revisions in the same exact scope.');
        if (from.conflicts.some((link) => conflictKey(link.relation, link.fromId, link.toId) ===
          conflictKey(event.relation, event.fromId, event.toId))) throw new Error('Memory conflict link already exists.');
        if (event.createdAt < from.updatedAt || event.createdAt < to.updatedAt) {
          throw new Error('Memory conflict link cannot predate a current revision.');
        }
        const effect = supersessionEffect(to, from, event);
        const common = { id: event.conflictId, relation: event.relation, fromId: event.fromId, toId: event.toId,
          at: event.createdAt, by: event.by, why: event.why, evidence: event.evidence,
          ...(effect ? { valid_from: effect.boundary } : {}),
          ...(event.audit ? { audit: event.audit } : {}) };
        if (effect) {
          const revisionId = `revision-${event.conflictId.slice('conflict-'.length)}`;
          if (revisionIds.has(revisionId)) throw new Error('A memory revision ID was reused.');
          revisionIds.add(revisionId);
          Object.assign(to, effect.changes);
          to.revision += 1;
          to.updatedAt = event.createdAt;
          to.revisions.push({ id: revisionId, at: event.createdAt, by: event.by, why: event.why,
            previous: effect.previous, changes: effect.changes, number: to.revision,
            causedByConflictId: event.conflictId, ...(event.audit ? { audit: event.audit } : {}) });
        }
        from.conflicts.push({ ...common, role: 'source', otherId: to.id });
        to.conflicts.push({ ...common, role: 'target', otherId: from.id });
        continue;
      }
      if (event.kind === 'evaluation') {
        const record = records.get(event.id);
        if (!record || record.agentId !== event.agentId || !record.revisions.some((revision) => revision.id === event.correctionRevisionId && revision.learning)) throw new Error('A memory evaluation has no valid correction source.');
        if (record.evaluations.some((evaluation) => evaluation.id === event.evaluationId || (evaluation.correctionRevisionId === event.correctionRevisionId && evaluation.observed.id === event.observed.id))) throw new Error('A memory evaluation was duplicated.');
        record.evaluations.push({ id: event.evaluationId, correctionRevisionId: event.correctionRevisionId,
          at: event.createdAt, by: event.by, why: event.why, outcome: event.outcome, observed: event.observed,
          ...(event.audit ? { audit: event.audit } : {}) });
        continue;
      }
      if (event.kind !== 'revision') {
        if (records.has(event.id)) throw new Error('A memory ID appears in multiple dated logs.');
        records.set(event.id, {
          ...event, status: normalizeStatus(event.status), valid_while: normalizeValidWhile(event.valid_while),
          valid_from: event.valid_from, valid_until: event.valid_until,
          verify_by: event.verify_by === undefined ? null : normalizeVerifyBy(event.verify_by),
          originKind: normalizeOriginKind(event.originKind), verification: normalizeVerification(event.verification),
          importance: event.importance === undefined ? defaultImportance(normalizeOriginKind(event.originKind)) : normalizeImportance(event.importance),
          identityAnchor: event.identityAnchor === true,
          contextScope: event.contextScope === undefined ? null : normalizeContextScope(event.contextScope),
          evidence_excerpt: normalizeEvidence(event.evidence_excerpt), revision: 0, revisions: [], evaluations: [], conflicts: [], updatedAt: event.createdAt,
          chunkId: event.id
        });
        continue;
      }
      if (revisionIds.has(event.revisionId)) throw new Error('A memory revision ID was reused.');
      revisionIds.add(event.revisionId);
      const record = records.get(event.id);
      if (!record || record.agentId !== event.agentId || record.revision !== event.expectedRevision) throw new Error('A memory revision has invalid lineage, agent, or order.');
      if (event.verificationOnly && record.verification === 'owner-confirmed') throw new Error('A memory verification is already owner-confirmed.');
      const resetsVerification = !event.verificationOnly && Object.entries(event.changes).filter(([key]) =>
        ['text', 'evidence_excerpt', 'valid_while', 'verify_by', 'valid_from', 'valid_until', 'status'].includes(key)).some(([key, value]) =>
        stableContinuityJson(value) !== stableContinuityJson(record[key]));
      const appliedChanges = { ...event.changes, ...(resetsVerification && record.verification !== 'unverified' ? { verification: 'unverified' } : {}) };
      const previous = Object.fromEntries(Object.keys(appliedChanges).map((key) => [key, record[key]]));
      if (Object.hasOwn(appliedChanges, 'contextScope') && record.conflicts.length &&
        stableContinuityJson(appliedChanges.contextScope) !== stableContinuityJson(record.contextScope)) {
        throw new Error('A conflict-linked memory cannot move to another scope.');
      }
      Object.assign(record, appliedChanges);
      validateValidityWindow(record);
      if (record.status === 'conditional' && !record.valid_while) throw new Error('Conditional memory requires valid_while.');
      record.revision += 1;
      record.updatedAt = event.createdAt;
      record.revisions.push({ id: event.revisionId, at: event.createdAt, by: event.by, why: event.why, previous, changes: appliedChanges, number: record.revision,
        ...(event.audit ? { audit: event.audit } : {}),
        ...(event.learning ? { learning: event.learning } : {}) });
    }
    const registry = materializeEntityRegistry(events);
    for (const record of records.values()) {
      const linked = registry.links.get(record.id) || [];
      const confirmed = new Set();
      const pending = [];
      for (const entityId of linked) {
        const entity = registry.entities.get(entityId);
        if (!entity) continue;
        const resolved = entity.status === 'merged' ? registry.entities.get(entity.targetEntityId) : entity;
        if (resolved?.status === 'confirmed') confirmed.add(resolved.id);
        else if (entity.status === 'pending') pending.push({ id: entity.id, label: entity.label,
          warning: '[UNVERIFIED ENTITY — owner review required]' });
      }
      record.entityIds = [...confirmed].sort();
      record.pendingEntities = pending;
    }
    return records;
  }

  #project(record, depth, now = Date.now()) {
    if (![0, 1, 2].includes(depth)) throw new Error('Memory recall depth must be 0, 1, or 2.');
    const { revisions, evaluations, conflicts, evidence_excerpt, ...current } = record;
    const mistake = current.metadata?.memoryMistake;
    if (depth < 2 && mistake?.record?.evidence) {
      const { excerpt, ...evidence } = mistake.record.evidence;
      current.metadata = { ...current.metadata, memoryMistake: { ...mistake,
        record: { ...mistake.record, evidence } } };
    }
    const warnings = [];
    if (current.verification === 'unverified') warnings.push(UNVERIFIED_WARNING);
    if (isStale(current.verify_by, now)) { current.stale = true; warnings.push(STALE_WARNING); }
    if (conflicts.length) {
      warnings.push(CONFLICT_WARNING);
      current.conflictCount = conflicts.length;
      current.conflicts = conflicts.slice(-3).map(({ id, relation, role, otherId }) => ({ id, relation, role, otherId }));
      if (conflicts.length > 3 && depth === 0) current.conflictsTruncated = true;
    }
    if (warnings.length) current.warning = warnings.join(' ');
    if (depth === 0) return current;
    current.revisions = depth === 1
      ? revisions.map(({ changes, previous, learning, ...revision }) => ({ ...revision,
        ...(learning ? { learning: { ...learning, source: (({ text, ...source }) => source)(learning.source) } } : {}),
        previous: Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'evidence_excerpt')),
        changes: Object.fromEntries(Object.entries(changes).filter(([key]) => key !== 'evidence_excerpt')) }))
      : revisions.map((revision) => ({ ...revision, previous: { ...revision.previous }, changes: { ...revision.changes } }));
    current.evaluations = depth === 1
      ? evaluations.map(({ observed, ...evaluation }) => ({ ...evaluation, observed: (({ text, ...source }) => source)(observed) }))
      : evaluations.map((evaluation) => ({ ...evaluation, observed: { ...evaluation.observed } }));
    if (conflicts.length) current.conflicts = depth === 1
      ? conflicts.map(({ evidence, ...link }) => ({ ...link, evidence: (({ text, ...source }) => source)(evidence) }))
      : conflicts.map((link) => ({ ...link, evidence: { ...link.evidence } }));
    if (depth === 2) current.evidence_excerpt = evidence_excerpt;
    return current;
  }

  async #queued(lineageId, task) {
    const state = this.#mutationStates.get(lineageId) || { version: 0, pending: 0 };
    state.version += 1;
    state.pending += 1;
    this.#mutationStates.set(lineageId, state);
    const previous = this.#queues.get(lineageId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => withMemoryLineageLock(lineageDirectory(this.#root, lineageId), task));
    this.#queues.set(lineageId, operation);
    try { return await operation; }
    finally {
      state.pending -= 1;
      if (this.#queues.get(lineageId) === operation) this.#queues.delete(lineageId);
    }
  }

  // Conservative in-process dependency guard: even a queued or failed write
  // invalidates a previously read source, without changing durable user data.
  getMutationState({ lineageId } = {}) {
    const state = this.#mutationStates.get(ensureLineageId(lineageId));
    return state ? { ...state } : { version: 0, pending: 0 };
  }

  // A checkpoint is a hash-anchored position in the existing append-only log,
  // not a second copy of the memory store. Callers can retain this small token
  // and later request a guarded compensating restore to that exact prefix.
  async getRollbackCheckpoint({ lineageId } = {}) {
    const selectedLineage = ensureLineageId(lineageId);
    const events = await this.#events(selectedLineage);
    return { format: 'hexigrid-memory-checkpoint-v1', lineageId: selectedLineage,
      sequence: events.length, hash: auditTip(events) };
  }

  async restoreRollbackCheckpoint({ lineageId, checkpoint, expectedCurrent, by, why,
    createdAt, assertAuthorized } = {}) {
    if (typeof assertAuthorized !== 'function') {
      throw new Error('Memory rollback requires explicit owner authorization.');
    }
    const selectedLineage = ensureLineageId(lineageId);
    const authorizer = boundedString(by, 200, 'Memory rollback authorizer', { required: true });
    if (!/^owner:[A-Za-z0-9._:-]+$/.test(authorizer)) {
      throw new Error('Memory rollback requires an authenticated owner.');
    }
    const reason = boundedString(why, 4096, 'Memory rollback reason', { required: true });
    return this.#queued(selectedLineage, async () => {
      const authorize = () => {
        const result = assertAuthorized();
        if (result && typeof result.then === 'function') {
          throw new Error('Durable memory authorization must be synchronous.');
        }
      };
      authorize();
      const events = await this.#events(selectedLineage);
      const target = normalizeRollbackCheckpoint(checkpoint, selectedLineage, 'Memory rollback checkpoint');
      const expected = normalizeRollbackCheckpoint(expectedCurrent, selectedLineage, 'Expected current memory checkpoint');
      const current = { format: 'hexigrid-memory-checkpoint-v1', lineageId: selectedLineage,
        sequence: events.length, hash: auditTip(events) };
      if (expected.sequence !== current.sequence || expected.hash !== current.hash) {
        throw Object.assign(new Error('Memory rollback is stale; capture the current checkpoint and review the restore again.'),
          { status: 409, code: 'MEMORY_ROLLBACK_STALE' });
      }
      if (target.sequence > events.length || checkpointHash(events, target.sequence) !== target.hash) {
        throw Object.assign(new Error('Memory rollback checkpoint is no longer present in the verified audit history.'),
          { status: 409, code: 'MEMORY_CHECKPOINT_UNAVAILABLE' });
      }

      // Refuse checkpoints in the middle of a multi-event write (for example,
      // between a fact revision and its entity links) before changing any file.
      const targetEvents = events.slice(0, target.sequence);
      const targetRecords = this.#materialize(targetEvents);
      const currentRecords = this.#materialize(events);
      const timestamp = iso(createdAt);
      const date = timestamp.slice(0, 10);
      const filePath = datedFilePath(this.#root, selectedLineage, date);
      const log = await readLog(filePath, { lineageId: selectedLineage, date });
      const chain = [...events];
      let changedRecords = 0;
      let relinkNeeded = false;

      for (const record of [...currentRecords.values()].sort((left, right) => left.id.localeCompare(right.id))) {
        // Rejection is a final safety decision. Neither an older checkpoint
        // nor a broad rollback may silently revive a fact now marked rejected.
        if (record.status === 'rejected') continue;
        const prior = targetRecords.get(record.id);
        const desired = prior ? {
          text: prior.text, status: prior.status, valid_while: prior.valid_while ?? '',
          verify_by: prior.verify_by ?? null, valid_from: prior.valid_from ?? null,
          valid_until: prior.valid_until ?? null, metadata: prior.metadata ?? {},
          evidence_excerpt: prior.evidence_excerpt ?? '', contextScope: prior.contextScope ?? null,
          importance: prior.importance, identityAnchor: prior.identityAnchor === true
        } : { status: 'historical' };
        const changes = {};
        for (const [key, value] of Object.entries(desired)) {
          if (stableContinuityJson(rollbackValue(record, key)) !== stableContinuityJson(value)) changes[key] = value;
        }
        if (!Object.keys(changes).length) continue;

        if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
          throw new Error('Memory rollback encountered an invalid current revision.');
        }
        validateValidityWindow({ ...record, ...changes });
        if ((changes.status ?? record.status) === 'conditional' && !(changes.valid_while ?? record.valid_while)) {
          throw new Error('Memory rollback cannot restore a conditional fact without valid_while.');
        }
        if (Object.hasOwn(changes, 'contextScope') && record.conflicts.length &&
          stableContinuityJson(changes.contextScope) !== stableContinuityJson(record.contextScope)) {
          throw Object.assign(new Error('Memory rollback would move a conflict-linked fact to another scope.'), { status: 409 });
        }
        if (record.identityAnchor && Object.hasOwn(changes, 'contextScope') &&
          stableContinuityJson(changes.contextScope) !== stableContinuityJson(record.contextScope) &&
          changes.identityAnchor !== false) {
          throw Object.assign(new Error('Unpin the identity anchor before restoring it to another project scope.'), { status: 409 });
        }
        if ((changes.identityAnchor ?? record.identityAnchor) &&
          !(Object.hasOwn(changes, 'contextScope') ? changes.contextScope : record.contextScope)) {
          throw new Error('A memory identity anchor requires a project scope.');
        }
        const contentChanged = ['text', 'valid_while', 'evidence_excerpt'].some((key) =>
          Object.hasOwn(changes, key) && changes[key] !== (record[key] ?? ''));
        if (contentChanged || CURRENT_STATUSES.has(changes.status ?? record.status)) {
          assertMemoryWriteRiskSafe({ text: changes.text ?? record.text,
            valid_while: changes.valid_while ?? record.valid_while ?? '',
            evidence_excerpt: changes.evidence_excerpt ?? record.evidence_excerpt ?? '',
            verify_by: Object.hasOwn(changes, 'verify_by') ? changes.verify_by : record.verify_by ?? null });
        }
        if (timestamp < record.updatedAt) {
          throw new Error('Memory rollback timestamp cannot predate a current fact revision.');
        }

        const event = normalizeEntry({ kind: 'revision', id: record.id,
          revisionId: `revision-${crypto.randomUUID()}`, agentId: record.agentId,
          createdAt: timestamp, expectedRevision: record.revision, by: authorizer,
          why: reason, changes }, { lineageId: selectedLineage, date, now: timestamp });
        const linked = linkAudit(event, chain);
        log.entries.push(linked);
        chain.push(linked);
        changedRecords += 1;
        relinkNeeded ||= Object.hasOwn(changes, 'text') || Object.hasOwn(changes, 'contextScope');
      }

      if (!changedRecords) return { restored: false, changedRecords: 0, checkpoint: target, current };
      if (relinkNeeded) {
        queueEntityRelinks(log, chain, this.#materialize(chain),
          { lineageId: selectedLineage, date, now: timestamp });
      }
      if (log.entries.length > MAX_ENTRIES_PER_DAY) {
        throw new Error('This dated memory log reached its daily entry limit; no rollback changes were written.');
      }
      // Validate the complete proposed chain before the single atomic rename.
      auditTip(chain);
      this.#materialize(chain);
      validateConflictReferences(chain);
      await writeAtomic(filePath, log, authorize);
      const restored = { format: 'hexigrid-memory-checkpoint-v1', lineageId: selectedLineage,
        sequence: chain.length, hash: auditTip(chain) };
      return { restored: true, changedRecords, checkpoint: target, current: restored };
    });
  }

  async hardDelete({ lineageId, id, assertAuthorized } = {}) {
    if (assertAuthorized !== undefined && typeof assertAuthorized !== 'function') throw new Error('Memory erasure authorization must be a trusted function.');
    const selectedLineage = ensureLineageId(lineageId);
    if (!ENTRY_ID.test(String(id || ''))) throw new Error('Memory identity is invalid.');
    return this.#queued(selectedLineage, async () => {
      assertAuthorized?.();
      const events = await this.#events(selectedLineage);
      const originalRecords = this.#materialize(events);
      const record = originalRecords.get(String(id).toLowerCase());
      if (!record) return false;
      const removed = events.filter((event) => event.id === record.id || event.memoryId === record.id || event.sourceMemoryId === record.id ||
        // Erase relationships and their evidence. A retained supersession effect
        // is converted below without restoring the predecessor to active.
        (event.kind === 'conflict' &&
          (event.fromId === record.id || event.toId === record.id)));
      const removedSet = new Set(removed);
      const remaining = events.flatMap(event => {
        if (!removedSet.has(event)) return [event];
        // Removing a successor must not resurrect the retained predecessor.
        // Preserve the already-authorized standing effect as the same revision,
        // while removing the erased relationship and its content-bearing reason.
        if (event.kind !== 'conflict' || event.relation !== 'supersedes' || event.toId === record.id) return [];
        const target = originalRecords.get(event.toId);
        const effect = target?.revisions.find(revision => revision.causedByConflictId === event.conflictId);
        if (!effect) return [];
        const changes = { ...effect.changes };
        delete changes.verification; // Normal revisions derive the same verification reset.
        return [{ kind: 'revision', id: target.id, agentId: target.agentId, lineageId: selectedLineage,
          revisionId: effect.id, expectedRevision: effect.number - 1, date: event.date,
          createdAt: event.createdAt, by: event.by,
          why: 'Retained standing after permanent erasure of a related memory.', changes,
          sourceFile: event.sourceFile, chunkIndex: event.chunkIndex }];
      });
      // Rebuild audit links after excising every content-bearing event for this fact.
      const prior = [];
      // Include emptied dates: otherwise the old file still contains the erased fact.
      const byDate = new Map(events.map(event => [event.sourceFile.slice(-15, -5), []]));
      for (const event of remaining) {
        const { sourceFile, chunkIndex, audit, ...payload } = event;
        const linked = linkAudit(payload, prior);
        prior.push(linked);
        const date = sourceFile.slice(-15, -5);
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date).push(linked);
      }
      const logs = [...byDate].map(([date, entries]) =>
        ({ format: DATED_MEMORY_FORMAT, version: DATED_MEMORY_VERSION, lineageId: selectedLineage, date, entries }));
      // Refuse a dependency-breaking erase before touching any canonical file.
      // Refuse shared entity dependencies or any unexpected change to retained
      // standing before touching canonical files. Conflict-only history is excised.
      try {
        const retained = this.#materialize(validateDatedMemoryChain(logs, { lineageId: selectedLineage }));
        for (const [memoryId, original] of originalRecords) {
          if (memoryId === record.id) continue;
          const current = retained.get(memoryId);
          for (const key of ['text', 'status', 'verification', 'valid_from', 'valid_until', 'valid_while', 'revision', 'updatedAt',
            'metadata', 'contextScope', 'importance', 'identityAnchor', 'evidence_excerpt', 'verify_by', 'entityIds', 'pendingEntities']) {
            if (stableContinuityJson(current?.[key]) !== stableContinuityJson(original[key])) throw new Error('Retained standing changed.');
          }
        }
      }
      catch { throw Object.assign(new Error('This memory has dependent entity or conflict history. Resolve those dependencies before permanent erasure.'), { status: 409 }); }
      const originals = await Promise.all(logs.map(log => readLog(datedFilePath(this.#root, selectedLineage, log.date),
        { lineageId: selectedLineage, date: log.date })));
      await commitMemoryErasure({ ...this.#erasureContext(selectedLineage), originals, logs, assertAuthorized });
      return true;
    });
  }

  async append({ lineageId, agentId, date, createdAt, text, metadata = {}, id, status = 'active', valid_while = '', verify_by,
    valid_from, valid_until, evidence_excerpt = '', contextScope, originKind, verification, importance, identityAnchor = false, assertAuthorized } = {}) {
    if (assertAuthorized !== undefined && typeof assertAuthorized !== 'function') throw new Error('Memory append authorization must be a trusted function.');
    const selectedDate = ensureDate(date || iso(createdAt).slice(0, 10));
    const selectedLineage = ensureLineageId(lineageId);
    const filePath = datedFilePath(this.#root, selectedLineage, selectedDate);
    return this.#queued(selectedLineage, async () => {
      const entry = normalizeEntry({ id, agentId, createdAt, text, metadata, status, valid_while, verify_by,
        ...(valid_from === undefined ? {} : { valid_from }), ...(valid_until === undefined ? {} : { valid_until }),
        evidence_excerpt, contextScope, originKind, verification,
        importance: importance === undefined ? defaultImportance(normalizeOriginKind(originKind)) : importance, identityAnchor },
      { lineageId: selectedLineage, date: selectedDate, now: new Date().toISOString() });
      const events = await this.#events(selectedLineage);
      const existing = events.find((event) => event.kind !== 'revision' && event.id === entry.id);
      if (existing) {
        const comparable = normalizeEntry({ ...existing, audit: undefined, status: existing.status ?? 'active', valid_while: existing.valid_while ?? '', evidence_excerpt: existing.evidence_excerpt ?? '',
          importance: existing.importance ?? defaultImportance(normalizeOriginKind(existing.originKind)), identityAnchor: existing.identityAnchor ?? false },
        { lineageId: selectedLineage, date: existing.date, now: existing.createdAt });
        if (stableContinuityJson(comparable) !== stableContinuityJson(entry)) throw new Error('A memory entry ID was reused with different content.');
        return { entry: existing, sourceFile: existing.sourceFile, appended: false };
      }
      assertMemoryWriteRiskSafe({ text: entry.text, valid_while: entry.valid_while ?? '',
        evidence_excerpt: entry.evidence_excerpt ?? '', verify_by: entry.verify_by ?? null });
      const log = await readLog(filePath, { lineageId: selectedLineage, date: selectedDate });
      const linkedEntry = linkAudit(entry, events);
      log.entries.push(linkedEntry);
      const chain = [...events, linkedEntry];
      queueEntityLinks(log, chain, { ...entry, revision: 0 },
        { lineageId: selectedLineage, date: selectedDate, now: entry.createdAt });
      if (log.entries.length > MAX_ENTRIES_PER_DAY) throw new Error('This dated memory log reached its daily entry limit.');
      materializeEntityRegistry(chain);
      await writeAtomic(filePath, log, assertAuthorized);
      return { entry: linkedEntry, sourceFile: `${selectedLineage}/${selectedDate}.json`, appended: true };
    });
  }

  async appendRevision({ lineageId, id, changes, why, by, expectedRevision, createdAt, learning,
    originKind, verification, verificationOnly, mistakeEntry, assertAuthorized } = {}) {
    if (originKind !== undefined || verification !== undefined || verificationOnly !== undefined) {
      throw new Error('Memory revision cannot change origin or verification.');
    }
    const selectedLineage = ensureLineageId(lineageId);
    if (!ENTRY_ID.test(String(id || ''))) throw new Error('Memory revision identity is invalid.');
    return this.#queued(selectedLineage, async () => {
      const events = await this.#events(selectedLineage);
      const record = this.#materialize(events).get(String(id).toLowerCase());
      if (!record) throw new Error('Memory record was not found.');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== record.revision) throw new Error('Memory revision conflict; reload the current record.');
      const normalizedChanges = normalizeChanges(changes);
      validateValidityWindow({ ...record, ...normalizedChanges });
      if (normalizedChanges.contextScope !== undefined && record.conflicts?.length &&
        stableContinuityJson(normalizedChanges.contextScope) !== stableContinuityJson(record.contextScope)) {
        throw new Error('A conflict-linked memory cannot move to another scope.');
      }
      if (learning && record.importance < 0.9) normalizedChanges.importance = 0.9;
      if ((normalizedChanges.status ?? record.status) === 'conditional' && !(normalizedChanges.valid_while ?? record.valid_while)) throw new Error('Conditional memory requires valid_while.');
      if (record.identityAnchor && normalizedChanges.contextScope !== undefined &&
        stableContinuityJson(normalizedChanges.contextScope) !== stableContinuityJson(record.contextScope) &&
        normalizedChanges.identityAnchor !== false) throw new Error('Unpin the identity anchor before moving its project scope.');
      if ((normalizedChanges.identityAnchor ?? record.identityAnchor) && !(normalizedChanges.contextScope === undefined ? record.contextScope : normalizedChanges.contextScope)) {
        throw new Error('A memory identity anchor requires a project scope.');
      }
      const contentFields = ['text', 'valid_while', 'evidence_excerpt'];
      const contentChanged = contentFields.some((key) => Object.hasOwn(normalizedChanges, key) &&
        normalizedChanges[key] !== (record[key] ?? ''));
      const mergedContent = {
        text: normalizedChanges.text ?? record.text,
        valid_while: normalizedChanges.valid_while ?? record.valid_while ?? '',
        evidence_excerpt: normalizedChanges.evidence_excerpt ?? record.evidence_excerpt ?? '',
        verify_by: Object.hasOwn(normalizedChanges, 'verify_by') ? normalizedChanges.verify_by : record.verify_by ?? null
      };
      const nextStatus = normalizedChanges.status ?? record.status;
      if (contentChanged || CURRENT_STATUSES.has(nextStatus)) assertMemoryWriteRiskSafe(mergedContent);
      const timestamp = iso(createdAt);
      if (timestamp < record.updatedAt) throw new Error('A memory revision cannot predate its current revision.');
      const date = timestamp.slice(0, 10);
      const filePath = datedFilePath(this.#root, selectedLineage, date);
      const event = normalizeEntry({ kind: 'revision', id: record.id, revisionId: `revision-${crypto.randomUUID()}`, agentId: record.agentId, createdAt: timestamp, expectedRevision, by, why, changes: normalizedChanges, learning }, { lineageId: selectedLineage, date, now: timestamp });
      const log = await readLog(filePath, { lineageId: selectedLineage, date });
      const linkedRevision = linkAudit(event, events);
      log.entries.push(linkedRevision);
      const chain = [...events, linkedRevision];
      if (Object.hasOwn(normalizedChanges, 'text') || Object.hasOwn(normalizedChanges, 'contextScope')) {
        queueEntityLinks(log, chain, { ...record, ...normalizedChanges, revision: expectedRevision + 1 },
          { lineageId: selectedLineage, date, now: timestamp });
      }
      let linkedMistake;
      if (mistakeEntry !== undefined) {
        if (!learning || typeof assertAuthorized !== 'function' || mistakeEntry.lineageId !== selectedLineage ||
          mistakeEntry.status !== 'historical' ||
          mistakeEntry.metadata?.memoryMistake?.format !== 'hexigrid-memory-mistake' ||
          stableContinuityJson(mistakeEntry.contextScope ?? null) !== stableContinuityJson(record.contextScope ?? null)) {
          throw new Error('An atomic correction requires its exact authorized canonical mistake entry.');
        }
        if (events.some(item => item.id === mistakeEntry.id && !item.kind)) throw new Error('The correction mistake identity already exists.');
        linkedMistake = queueLinkedEvent(log, chain, mistakeEntry, { lineageId: selectedLineage, date, now: timestamp });
      }
      if (log.entries.length > MAX_ENTRIES_PER_DAY) throw new Error('This dated memory log reached its daily entry limit.');
      materializeEntityRegistry(chain);
      await writeAtomic(filePath, log, assertAuthorized);
      return { id: record.id, revisionId: event.revisionId, revision: expectedRevision + 1, sourceFile: `${selectedLineage}/${date}.json`, date: record.date, committedDate: date,
        ...(linkedMistake ? { mistakeEntry: linkedMistake } : {}) };
    });
  }

  async appendVerification({ lineageId, id, expectedRevision, why, by, createdAt } = {}) {
    const selectedLineage = ensureLineageId(lineageId);
    if (!ENTRY_ID.test(String(id || ''))) throw new Error('Memory verification identity is invalid.');
    return this.#queued(selectedLineage, async () => {
      const events = await this.#events(selectedLineage);
      const record = this.#materialize(events).get(String(id).toLowerCase());
      if (!record) throw new Error('Memory record was not found.');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== record.revision) throw new Error('Memory revision conflict; reload the current record.');
      if (record.verification === 'owner-confirmed') throw new Error('Memory is already owner-confirmed.');
      const timestamp = iso(createdAt);
      if (timestamp < record.updatedAt) throw new Error('A memory verification cannot predate its current revision.');
      const date = timestamp.slice(0, 10);
      const filePath = datedFilePath(this.#root, selectedLineage, date);
      const event = normalizeEntry({ kind: 'revision', verificationOnly: true, id: record.id,
        revisionId: `revision-${crypto.randomUUID()}`, agentId: record.agentId, createdAt: timestamp,
        expectedRevision, by, why, changes: { verification: 'owner-confirmed' } },
      { lineageId: selectedLineage, date, now: timestamp });
      const log = await readLog(filePath, { lineageId: selectedLineage, date });
      if (log.entries.length >= MAX_ENTRIES_PER_DAY) throw new Error('This dated memory log reached its daily entry limit.');
      log.entries.push(linkAudit(event, events));
      await writeAtomic(filePath, log);
      return { id: record.id, revisionId: event.revisionId, revision: expectedRevision + 1,
        verification: 'owner-confirmed', sourceFile: `${selectedLineage}/${date}.json`, date: record.date };
    });
  }

  async appendCorrection({ lineageId, id, changes, why, by, expectedRevision, createdAt, source, expectedNextBehavior, mistakeEntry, assertAuthorized } = {}) {
    if (!changes || !Object.hasOwn(changes, 'text')) throw new Error('A memory correction must provide the replacement guidance text.');
    const timestamp = iso(createdAt);
    const exactSource = source?.kind === 'owner-feedback' && !source.id
      ? { ...source, id: `feedback-${crypto.randomUUID()}`, createdAt: source.createdAt || timestamp }
      : source;
    return this.appendRevision({ lineageId, id, changes, why, by, expectedRevision, createdAt: timestamp,
      learning: { source: exactSource, expectedNextBehavior }, mistakeEntry, assertAuthorized });
  }

  async appendEvaluation({ lineageId, id, correctionRevisionId, outcome, observed, why, by, createdAt } = {}) {
    const selectedLineage = ensureLineageId(lineageId);
    if (!ENTRY_ID.test(String(id || ''))) throw new Error('Memory evaluation identity is invalid.');
    return this.#queued(selectedLineage, async () => {
      const events = await this.#events(selectedLineage);
      const record = this.#materialize(events).get(String(id).toLowerCase());
      if (!record || !record.revisions.some((revision) => revision.id === correctionRevisionId && revision.learning)) throw new Error('Memory evaluation requires an existing correction revision.');
      const timestamp = iso(createdAt);
      const source = observed?.kind === 'owner-feedback' && !observed.id
        ? { ...observed, id: `feedback-${crypto.randomUUID()}`, createdAt: observed.createdAt || timestamp }
        : observed;
      if (record.evaluations.some((evaluation) => evaluation.correctionRevisionId === correctionRevisionId && evaluation.observed.id === source?.id)) throw new Error('Memory evaluation already records this observation.');
      const date = timestamp.slice(0, 10);
      const filePath = datedFilePath(this.#root, selectedLineage, date);
      const event = normalizeEntry({ kind: 'evaluation', id: record.id, evaluationId: `evaluation-${crypto.randomUUID()}`,
        correctionRevisionId, agentId: record.agentId, createdAt: timestamp, outcome, observed: source, why, by },
      { lineageId: selectedLineage, date, now: timestamp });
      const log = await readLog(filePath, { lineageId: selectedLineage, date });
      if (log.entries.length >= MAX_ENTRIES_PER_DAY) throw new Error('This dated memory log reached its daily entry limit.');
      log.entries.push(linkAudit(event, events));
      await writeAtomic(filePath, log);
      return { id: record.id, evaluationId: event.evaluationId, correctionRevisionId: event.correctionRevisionId,
        outcome: event.outcome, sourceFile: `${selectedLineage}/${date}.json` };
    });
  }

  async appendConflictLink({ lineageId, fromId, toId, relation, expectedFromRevision,
    expectedToRevision, by, why, evidence, valid_from, createdAt } = {}) {
    const selectedLineage = ensureLineageId(lineageId);
    if (!ENTRY_ID.test(String(fromId || '')) || !ENTRY_ID.test(String(toId || '')) || fromId === toId) {
      throw new Error('Memory conflict link is invalid.');
    }
    return this.#queued(selectedLineage, async () => {
      const events = await this.#events(selectedLineage);
      const records = this.#materialize(events);
      const from = records.get(String(fromId).toLowerCase());
      const to = records.get(String(toId).toLowerCase());
      if (!from || !to || from.revision !== expectedFromRevision || to.revision !== expectedToRevision ||
        !CURRENT_STATUSES.has(from.status) || !CURRENT_STATUSES.has(to.status) ||
        !sameConflictScope(from.contextScope, to.contextScope)) {
        throw new Error('Memory conflict link requires two current revisions in the same exact scope.');
      }
      if (from.conflicts.some((link) => conflictKey(link.relation, link.fromId, link.toId) === conflictKey(relation, from.id, to.id))) {
        throw new Error('Memory conflict link already exists.');
      }
      const timestamp = iso(createdAt);
      if (timestamp < from.updatedAt || timestamp < to.updatedAt) throw new Error('Memory conflict link cannot predate a current revision.');
      if (relation !== 'supersedes' && valid_from !== undefined) {
        throw new Error('Only a supersedes conflict may close a valid-time window.');
      }
      const boundary = relation !== 'supersedes' ? undefined :
        valid_from === undefined ? from.valid_from : normalizeValidTime(valid_from, 'Memory conflict valid_from');
      if (relation === 'supersedes' && (boundary === undefined || boundary === null)) {
        throw new Error('Superseding a memory requires an explicit valid_from boundary or successor valid_from.');
      }
      if (relation === 'supersedes' && from.valid_from !== undefined && from.valid_from !== null &&
        boundary !== from.valid_from) throw new Error('A supersedes boundary must match the successor valid_from.');
      const source = evidence?.kind === 'owner-feedback' && !evidence.id
        ? { ...evidence, id: `feedback-${crypto.randomUUID()}`, createdAt: evidence.createdAt || timestamp }
        : evidence;
      const date = timestamp.slice(0, 10);
      const filePath = datedFilePath(this.#root, selectedLineage, date);
      const event = normalizeEntry({ kind: 'conflict', conflictId: `conflict-${crypto.randomUUID()}`,
        fromId: from.id, toId: to.id, relation, expectedFromRevision, expectedToRevision,
        by, why, evidence: source, ...(boundary === undefined || boundary === null ? {} : { valid_from: boundary }),
        createdAt: timestamp },
      { lineageId: selectedLineage, date, now: timestamp });
      const log = await readLog(filePath, { lineageId: selectedLineage, date });
      if (log.entries.length >= MAX_ENTRIES_PER_DAY) throw new Error('This dated memory log reached its daily entry limit.');
      const linked = linkAudit(event, events);
      validateConflictReferences([...events, linked]);
      log.entries.push(linked);
      await writeAtomic(filePath, log);
      return { id: event.conflictId, fromId: event.fromId, toId: event.toId,
        relation: event.relation, ...(relation === 'supersedes' ? { valid_from: boundary,
          supersededId: to.id, supersededRevision: to.revision + 1 } : {}),
        sourceFile: `${selectedLineage}/${date}.json` };
    });
  }

  async readRange({ lineageId, from, to, depth = 0 } = {}) {
    const selectedLineage = ensureLineageId(lineageId);
    const fromDate = ensureDate(from);
    const toDate = ensureDate(to);
    if (fromDate > toDate) throw new Error('The memory date range is reversed.');
    return [...this.#materialize(await this.#events(selectedLineage)).values()]
      .filter((record) => record.date >= fromDate && record.date <= toDate)
      .map((record) => this.#project(record, depth));
  }

  async recall({ lineageId, from, to, depth = 0, nowMs } = {}) {
    const selectedNowMs = normalizeMemoryReadNow(nowMs);
    return (await this.readRange({ lineageId, from, to, depth })).filter((record) =>
      (record.status === 'active' || record.status === 'conditional') && withinKnownValidityBounds(record, selectedNowMs));
  }

  async listContext({ lineageId, projectId, topicId, unscopedOnly = false, includeDisputed = false, asOf, validAt, nowMs } = {}) {
    if (typeof unscopedOnly !== 'boolean') throw new Error('Unscoped memory retrieval requires an explicit boolean.');
    if (unscopedOnly && (projectId !== undefined || topicId !== undefined)) {
      throw new Error('Unscoped memory retrieval cannot include a project or topic scope.');
    }
    const requested = unscopedOnly ? null : normalizeContextScope(topicId === undefined ? { projectId } : { projectId, topicId });
    if (typeof includeDisputed !== 'boolean') throw new Error('Disputed memory retrieval requires an explicit boolean.');
    const selectedAsOf = normalizeMemoryAsOf(asOf);
    const asOfMs = selectedAsOf === undefined ? undefined : Date.parse(selectedAsOf);
    const selectedValidAt = normalizeMemoryValidAt(validAt);
    const validAtMs = selectedValidAt === undefined ? undefined : Date.parse(selectedValidAt);
    const selectedNowMs = normalizeMemoryReadNow(nowMs);
    const records = [...this.#materialize(await this.#events(ensureLineageId(lineageId))).values()]
      .map((record) => asOfMs === undefined ? record : recordAt(record, asOfMs))
      .filter(Boolean)
      .filter((record) => validAtMs !== undefined ? matchesValidityWindow(record, validAtMs) :
        asOfMs !== undefined || withinKnownValidityBounds(record, selectedNowMs));
    return records
      .filter((record) => {
        const visibleStatus = CURRENT_STATUSES.has(record.status) || includeDisputed && record.status === 'disputed' ||
          (asOfMs !== undefined || validAtMs !== undefined) && ['historical', 'superseded'].includes(record.status);
        if (!visibleStatus) return false;
        if (unscopedOnly) return record.contextScope === null || record.contextScope === undefined;
        if (record.contextScope?.projectId !== requested.projectId) return false;
        return record.contextScope.topicId === undefined || record.contextScope.topicId === requested.topicId;
      })
      .sort((left, right) => {
        if (unscopedOnly) return Number(right.identityAnchor) - Number(left.identityAnchor) || right.importance - left.importance ||
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
        const leftExact = Number(requested.topicId !== undefined && left.contextScope.topicId === requested.topicId);
        const rightExact = Number(requested.topicId !== undefined && right.contextScope.topicId === requested.topicId);
        return Number(right.identityAnchor) - Number(left.identityAnchor) || right.importance - left.importance ||
          rightExact - leftExact || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
      })
      .map((record) => this.#project(record, 0, asOfMs ?? selectedNowMs));
  }

  async listContextScopes({ lineageId, asOf, validAt, includeDisputed = false, nowMs } = {}) {
    return (await this.contextScopeInventory({ lineageId, asOf, validAt, includeDisputed, nowMs })).scopes;
  }

  async contextScopeInventory({ lineageId, asOf, validAt, includeDisputed = false, nowMs } = {}) {
    if (typeof includeDisputed !== 'boolean') throw new Error('Disputed memory retrieval requires an explicit boolean.');
    const selectedAsOf = normalizeMemoryAsOf(asOf);
    const asOfMs = selectedAsOf === undefined ? undefined : Date.parse(selectedAsOf);
    const selectedValidAt = normalizeMemoryValidAt(validAt);
    const validAtMs = selectedValidAt === undefined ? undefined : Date.parse(selectedValidAt);
    const selectedNowMs = normalizeMemoryReadNow(nowMs);
    const grouped = new Map();
    let unscopedCount = 0;
    for (const currentRecord of this.#materialize(await this.#events(ensureLineageId(lineageId))).values()) {
      const record = asOfMs === undefined ? currentRecord : recordAt(currentRecord, asOfMs);
      if (!record || validAtMs !== undefined && !matchesValidityWindow(record, validAtMs) ||
        validAtMs === undefined && asOfMs === undefined && !withinKnownValidityBounds(record, selectedNowMs) ||
        !(CURRENT_STATUSES.has(record.status) || includeDisputed && record.status === 'disputed' ||
        (asOfMs !== undefined || validAtMs !== undefined) && ['historical', 'superseded'].includes(record.status))) continue;
      if (!record.contextScope) { unscopedCount += 1; continue; }
      const scope = record.contextScope;
      const key = JSON.stringify([scope.projectId, scope.topicId || '']);
      const current = grouped.get(key);
      if (current) {
        current.count += 1;
        if (record.updatedAt > current.updatedAt) current.updatedAt = record.updatedAt;
      } else grouped.set(key, { projectId: scope.projectId, ...(scope.topicId ? { topicId: scope.topicId } : {}), count: 1, updatedAt: record.updatedAt });
    }
    return { unscopedCount, scopes: [...grouped.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) ||
      left.projectId.localeCompare(right.projectId) || (left.topicId || '').localeCompare(right.topicId || '')) };
  }

  async getById({ lineageId, id, depth = 0, asOf, validAt } = {}) {
    if (!ENTRY_ID.test(String(id || ''))) throw new Error('Memory ID is invalid.');
    const selectedAsOf = normalizeMemoryAsOf(asOf);
    const asOfMs = selectedAsOf === undefined ? undefined : Date.parse(selectedAsOf);
    const selectedValidAt = normalizeMemoryValidAt(validAt);
    const validAtMs = selectedValidAt === undefined ? undefined : Date.parse(selectedValidAt);
    const record = this.#materialize(await this.#events(ensureLineageId(lineageId))).get(String(id).toLowerCase());
    const selected = record && asOfMs !== undefined ? recordAt(record, asOfMs) : record;
    return selected && (validAtMs === undefined || matchesValidityWindow(selected, validAtMs))
      ? this.#project(selected, depth, asOfMs ?? Date.now()) : null;
  }

  async getByIds({ lineageId, ids, depth = 0, asOf, validAt } = {}) {
    if (!Array.isArray(ids) || ids.some((id) => !ENTRY_ID.test(String(id || '')))) throw new Error('Memory IDs are invalid.');
    const selectedAsOf = normalizeMemoryAsOf(asOf);
    const asOfMs = selectedAsOf === undefined ? undefined : Date.parse(selectedAsOf);
    const selectedValidAt = normalizeMemoryValidAt(validAt);
    const validAtMs = selectedValidAt === undefined ? undefined : Date.parse(selectedValidAt);
    const records = this.#materialize(await this.#events(ensureLineageId(lineageId)));
    return new Map(ids.map((id) => {
      const record = records.get(id.toLowerCase());
      const selected = record && asOfMs !== undefined ? recordAt(record, asOfMs) : record;
      return [id, selected && (validAtMs === undefined || matchesValidityWindow(selected, validAtMs))
        ? this.#project(selected, depth, asOfMs ?? Date.now()) : null];
    }));
  }

  // Mistake records are intentionally stored with the existing dated-memory
  // audit log, but their historical/rejected status keeps them out of ordinary
  // current-fact recall. This bounded typed query is for the mistake ledger's
  // own history and includes rejected records so they cannot be resurrected by
  // an idempotent retry.
  async listMemoryMistakes({ lineageId, agentId, contextScope, limit = 50, depth = 2 } = {}) {
    const selectedLineage = ensureLineageId(lineageId);
    const selectedAgent = agentId === undefined ? undefined : ensureAgentId(agentId);
    const selectedScope = normalizeContextScope(contextScope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Memory mistake page limit is invalid.');
    if (![0, 1, 2].includes(depth)) throw new Error('Memory recall depth must be 0, 1, or 2.');
    const records = [...this.#materialize(await this.#events(selectedLineage)).values()]
      .filter((record) => (selectedAgent === undefined || record.agentId === selectedAgent) &&
        stableContinuityJson(record.contextScope ?? null) === stableContinuityJson(selectedScope) &&
        record.metadata?.memoryMistake?.format === 'hexigrid-memory-mistake' &&
        record.metadata.memoryMistake.version === 1)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    return records.slice(0, limit).map((record) => this.#project(record, depth));
  }

  async listEntities({ lineageId, limit = 50, after = '' } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Entity page limit is invalid.');
    if (after && !/^entity-[0-9a-f-]{36}$/.test(String(after))) throw new Error('Entity cursor is invalid.');
    const registry = materializeEntityRegistry(await this.#events(ensureLineageId(lineageId)));
    const sorted = [...registry.entities.values()].sort((left, right) => left.id.localeCompare(right.id));
    const start = after ? sorted.findIndex((entity) => entity.id === after) + 1 : 0;
    if (after && !start) throw new Error('Entity cursor is stale.');
    const page = sorted.slice(start, start + limit);
    return { entities: page, hasMore: start + limit < sorted.length,
      nextCursor: start + limit < sorted.length ? page.at(-1).id : null };
  }

  async getEntityHistory({ lineageId, entityId, limit = 50, afterSequence = 0 } = {}) {
    if (!/^entity-[0-9a-f-]{36}$/.test(String(entityId || ''))) throw new Error('Entity ID is invalid.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Entity history page is invalid.');
    const events = await this.#events(ensureLineageId(lineageId));
    const entity = materializeEntityRegistry(events).entities.get(entityId);
    if (!entity) throw new Error('Entity was not found.');
    const history = events.filter((event) => event.kind === 'entity' && event.action !== 'links' &&
      (event.entityId === entityId || event.action === 'merge' && event.targetEntityId === entityId) &&
      event.audit.sequence > afterSequence);
    const selected = history.slice(0, limit);
    return { entity, events: selected, hasMore: history.length > limit,
      nextCursor: history.length > limit ? selected.at(-1).audit.sequence : null };
  }

  async commitEntity({ lineageId, operation, entityId, expectedRevision, label, entityType,
    aliases, projectId = null, targetEntityId, alias, by, why, createdAt } = {}) {
    const selectedLineage = ensureLineageId(lineageId);
    const action = String(operation || '');
    if (!['create', 'confirm', 'reject', 'merge', 'alias-add', 'alias-remove'].includes(action)) throw new Error('Entity operation is invalid.');
    return this.#queued(selectedLineage, async () => {
      const events = await this.#events(selectedLineage);
      const timestamp = iso(createdAt);
      const date = timestamp.slice(0, 10);
      const filePath = datedFilePath(this.#root, selectedLineage, date);
      const log = await readLog(filePath, { lineageId: selectedLineage, date });
      const chain = [...events];
      const selectedEntityId = action === 'create' ? newEntityId() : String(entityId || '').toLowerCase();
      queueLinkedEvent(log, chain, { kind: 'entity', action, eventId: newEntityEventId(),
        entityId: selectedEntityId, createdAt: timestamp, by, why,
        ...(action === 'create' ? { label, entityType, aliases, projectId } :
          { expectedRevision, ...(action === 'confirm' ? { label, entityType, aliases } : {}),
            ...(action === 'merge' ? { targetEntityId, alias } : {}),
            ...(['alias-add', 'alias-remove'].includes(action) ? { alias } : {}) }) },
      { lineageId: selectedLineage, date, now: timestamp });
      materializeEntityRegistry(chain);
      queueEntityRelinks(log, chain, this.#materialize(events),
        { lineageId: selectedLineage, date, now: timestamp });
      if (log.entries.length > MAX_ENTRIES_PER_DAY) throw new Error('This dated memory log reached its daily entry limit.');
      const registry = materializeEntityRegistry(chain);
      await writeAtomic(filePath, log);
      return { operation: action, entity: registry.entities.get(selectedEntityId) };
    });
  }

  async listEntityContext({ lineageId, alias, projectId, topicId } = {}) {
    const selectedLineage = ensureLineageId(lineageId);
    const requested = normalizeContextScope(topicId === undefined ? { projectId } : { projectId, topicId });
    const key = entityAliasKey(normalizeEntityLabel(alias));
    const events = await this.#events(selectedLineage);
    const registry = materializeEntityRegistry(events);
    const visible = [...registry.entities.values()].filter((entity) => !entity.projectId || entity.projectId === requested.projectId);
    const entity = visible.find((candidate) => candidate.status === 'confirmed' &&
      [candidate.label, ...candidate.aliases].some((name) => entityAliasKey(name) === key));
    if (!entity) {
      const pending = visible.find((candidate) => candidate.status === 'pending' && entityAliasKey(candidate.label) === key);
      return pending ? { state: 'pending', entity: { id: pending.id, label: pending.label,
        warning: '[UNVERIFIED ENTITY — owner review required]' }, records: [] } :
        { state: 'absent', entity: null, records: [] };
    }
    const records = [...this.#materialize(events).values()]
      .filter((record) => ['active', 'conditional'].includes(record.status) && record.entityIds.includes(entity.id) &&
        record.contextScope?.projectId === requested.projectId &&
        (requested.topicId ? !record.contextScope.topicId || record.contextScope.topicId === requested.topicId : !record.contextScope.topicId))
      .sort((left, right) => Number(right.identityAnchor) - Number(left.identityAnchor) ||
        right.importance - left.importance || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .map((record) => this.#project(record, 0));
    return { state: 'confirmed', entity: { id: entity.id, label: entity.label, entityType: entity.entityType,
      projectId: entity.projectId, aliases: [...entity.aliases] }, records };
  }

  async listFiles({ lineageId } = {}) {
    const selectedLineage = ensureLineageId(lineageId);
    return withMemoryLineageLock(lineageDirectory(this.#root, selectedLineage), async () => {
      await recoverMemoryErasure(this.#erasureContext(selectedLineage));
      return this.#listRecoveredFiles(selectedLineage);
    });
  }

  async #listRecoveredFiles(selectedLineage) {
    const directory = lineageDirectory(this.#root, selectedLineage);
    const details = await rejectSymlink(directory, { allowMissing: true });
    if (!details) return [];
    const names = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
    const files = [];
    for (const name of names) {
      const filePath = path.join(directory, name);
      const fileDetails = await rejectSymlink(filePath);
      if (!fileDetails.isFile() || fileDetails.size > MAX_FILE_BYTES) throw new Error('A dated memory log is not a valid bounded file.');
      const bytes = await readFile(filePath);
      const date = name.slice(0, 10);
      validateDatedMemoryBytes(bytes, { lineageId: selectedLineage, date });
      files.push({ path: `${selectedLineage}/${name}`, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), content: bytes });
    }
    return files;
  }
}
