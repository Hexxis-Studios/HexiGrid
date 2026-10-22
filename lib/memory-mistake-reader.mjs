import crypto from 'node:crypto';
import { normalizeContextScope } from './dated-memory.mjs';
import { assertContinuitySafe } from './continuity-security.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MISTAKE_ID = new RegExp(`^mistake-${UUID}$`, 'i');
const LINEAGE_ID = new RegExp(`^lineage-${UUID}$`, 'i');
const MEMORY_ID = new RegExp(`^memory-${UUID}$`, 'i');
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const AUTHOR_KINDS = new Set(['owner', 'agent', 'system']);
const EVIDENCE_KINDS = new Set(['dated-memory', 'link-message', 'link-event', 'owner-feedback', 'room', 'task']);
const DEFAULT_BYTES = 8 * 1024;
const MIN_BYTES = 1024;
const MAX_BYTES = 32 * 1024;

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key));
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function validBoundedText(value, maxBytes) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function canonicalRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
    record.format !== 'hexigrid-memory-mistake' || record.version !== 1 ||
    !MISTAKE_ID.test(String(record.id || '')) || !LINEAGE_ID.test(String(record.lineageId || '')) ||
    !CONTEXT_ID.test(String(record.agentId || '')) || !exactKeys(record.author, ['kind', 'id']) ||
    !AUTHOR_KINDS.has(record.author.kind) || !CONTEXT_ID.test(String(record.author.id || '')) ||
    !validIso(record.createdAt) || record.importance !== 1 ||
    !validBoundedText(record.whatWentWrong, 2048) || !validBoundedText(record.correction, 2048) ||
    !validBoundedText(record.resultingFix, 2048) || !exactKeys(record.evidence, ['kind', 'id', 'excerpt', 'observedAt']) ||
    !EVIDENCE_KINDS.has(record.evidence.kind) || !OPAQUE_ID.test(String(record.evidence.id || '')) ||
    (Object.hasOwn(record.evidence, 'excerpt') && !validBoundedText(record.evidence.excerpt, 4096)) || !validIso(record.evidence.observedAt) ||
    !Array.isArray(record.recurrenceOf) || record.recurrenceOf.length > 8 ||
    !/^[0-9a-f]{64}$/.test(String(record.requestDigest || ''))) return null;

  let contextScope;
  try { contextScope = normalizeContextScope(record.contextScope); }
  catch { return null; }
  if (contextScope && (!CONTEXT_ID.test(contextScope.projectId) ||
    (contextScope.topicId !== undefined && !CONTEXT_ID.test(contextScope.topicId)))) return null;

  const recurrenceKeys = new Set();
  for (const reference of record.recurrenceOf) {
    if (!exactKeys(reference, ['id', 'lineageId', 'agentId']) ||
      !MISTAKE_ID.test(String(reference.id || '')) || !LINEAGE_ID.test(String(reference.lineageId || '')) ||
      !CONTEXT_ID.test(String(reference.agentId || ''))) return null;
    const key = `${reference.lineageId.toLowerCase()}\u0000${reference.id.toLowerCase()}`;
    if (recurrenceKeys.has(key)) return null;
    recurrenceKeys.add(key);
  }

  // The canonical digest binds the verified evidence, scope, author, and all
  // mistake text before a dated-memory projection can be exposed.
  const authority = { agentId: record.agentId, lineageId: record.lineageId.toLowerCase(),
    contextScope, author: record.author };
  // The dated store intentionally removes the source excerpt at depths 0 and
  // 1. Verify the full canonical digest whenever depth 2 supplied it; lower
  // depths still verify the permanent ID, format, authority, and scope mapping.
  if (Object.hasOwn(record.evidence, 'excerpt')) {
    const expectedDigest = digest(stable({ authority, whatWentWrong: record.whatWentWrong,
      correction: record.correction, resultingFix: record.resultingFix, evidence: record.evidence,
      recurrenceOf: record.recurrenceOf }));
    if (expectedDigest !== record.requestDigest) return null;
  }
  try { assertContinuitySafe(record); } catch { return null; }
  return { ...record, contextScope };
}

function datedMemoryId(id) {
  if (!MISTAKE_ID.test(String(id || ''))) return null;
  return `memory-${String(id).slice('mistake-'.length).toLowerCase()}`;
}

function sameScope(left, right) {
  try { return stable(normalizeContextScope(left)) === stable(normalizeContextScope(right)); }
  catch { return false; }
}

function scopeCovered(scope, projectId, topicId) {
  if (!scope || scope.projectId !== projectId) return false;
  if (topicId === undefined) return scope.topicId === undefined;
  return scope.topicId === undefined || scope.topicId === topicId;
}

function canonicalFromEntry(entry, { lineageId, agentId, id, projectId, topicId }) {
  if (!entry || typeof entry !== 'object' || !MEMORY_ID.test(String(entry.id || '')) ||
    String(entry.lineageId || '').toLowerCase() !== lineageId || entry.agentId !== agentId ||
    !['historical', 'rejected'].includes(entry.status)) return null;
  const payload = entry.metadata?.memoryMistake;
  if (payload?.format !== 'hexigrid-memory-mistake' || payload.version !== 1) return null;
  const record = canonicalRecord(payload.record);
  if (!record || record.id.toLowerCase() !== id || record.lineageId.toLowerCase() !== lineageId ||
    record.agentId !== agentId || !scopeCovered(record.contextScope, projectId, topicId) ||
    !sameScope(entry.contextScope ?? null, record.contextScope) ||
    entry.id.toLowerCase() !== datedMemoryId(record.id) ||
    entry.createdAt !== record.createdAt ||
    entry.text !== `Past mistake: ${record.whatWentWrong}\nCorrection: ${record.correction}\nResulting fix: ${record.resultingFix}`) return null;
  return { record, status: entry.status, revision: Number.isSafeInteger(entry.revision) ? entry.revision : 0,
    revisions: Array.isArray(entry.revisions) ? entry.revisions : [] };
}

function safeScope(scope) {
  return scope ? { projectId: scope.projectId, ...(scope.topicId ? { topicId: scope.topicId } : {}) } : null;
}

function selfRecurrences(record, lineageId, agentId) {
  return record.recurrenceOf.filter(reference => reference.lineageId.toLowerCase() === lineageId &&
    reference.agentId === agentId).map(reference => ({ id: reference.id.toLowerCase() }));
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false };
  let output = '';
  for (const character of value) {
    if (Buffer.byteLength(output + character, 'utf8') > maxBytes) break;
    output += character;
  }
  return { value: output, truncated: true };
}

function listSummary(item, lineageId, agentId) {
  const { record, status } = item;
  const truncated = {};
  const summaryText = (field) => {
    const result = truncateUtf8(record[field], 128);
    if (result.truncated) truncated[field] = true;
    return result.value;
  };
  const recurrenceOf = selfRecurrences(record, lineageId, agentId);
  const recurrenceReferencesRedacted = record.recurrenceOf.length - recurrenceOf.length;
  return {
    id: record.id.toLowerCase(), status, createdAt: record.createdAt,
    scope: safeScope(record.contextScope), authorKind: record.author.kind,
    whatWentWrong: summaryText('whatWentWrong'), correction: summaryText('correction'),
    resultingFix: summaryText('resultingFix'),
    evidence: { kind: record.evidence.kind, id: record.evidence.id, observedAt: record.evidence.observedAt },
    ...(recurrenceOf.length ? { recurrenceOf } : {}),
    ...(recurrenceReferencesRedacted ? { recurrenceReferencesRedacted } : {}),
    ...(Object.keys(truncated).length ? { textTruncated: truncated } : {})
  };
}

function revisionSummary(revision, index) {
  if (!revision || typeof revision !== 'object') return null;
  const output = { revision: Number.isSafeInteger(revision.revision) ? revision.revision : index + 1 };
  if (validIso(revision.at)) output.at = revision.at;
  if (typeof revision.why === 'string' && revision.why.trim()) output.why = revision.why;
  if (revision.changes && typeof revision.changes === 'object' && !Array.isArray(revision.changes)) {
    const fields = Object.keys(revision.changes).filter(field => field !== 'evidence_excerpt').sort();
    output.changedFields = fields;
    if (['active', 'conditional', 'historical', 'rejected', 'superseded', 'disputed'].includes(revision.changes.status)) {
      output.status = revision.changes.status;
    }
  }
  return output;
}

function boundedDetail(item, { depth, maxBytes, lineageId, agentId }) {
  const { record, status, revision, revisions } = item;
  const localRecurrences = selfRecurrences(record, lineageId, agentId);
  const foreignRecurrenceOmittedCount = record.recurrenceOf.length - localRecurrences.length;
  const allRevisions = depth > 0 ? revisions.map(revisionSummary).filter(Boolean) : [];
  const retainedRevisions = allRevisions.slice(-20);
  const detail = {
    scope: safeScope(record.contextScope), authorKind: record.author.kind,
    createdAt: record.createdAt, revision,
    whatWentWrong: record.whatWentWrong, correction: record.correction, resultingFix: record.resultingFix,
    evidence: { kind: record.evidence.kind, id: record.evidence.id, observedAt: record.evidence.observedAt },
    ...(depth > 0 ? { revisions: retainedRevisions,
      omittedRevisionCount: allRevisions.length - retainedRevisions.length } : {}),
    ...(localRecurrences.length ? { recurrenceOf: localRecurrences } : {}),
    ...(foreignRecurrenceOmittedCount ? { recurrenceReferencesRedacted: foreignRecurrenceOmittedCount } : {}),
    truncatedFields: []
  };
  if (depth === 2) detail.evidence.excerpt = record.evidence.excerpt;
  const result = { id: record.id.toLowerCase(), state: status === 'rejected' ? 'rejected' : 'recorded',
    status, mistake: detail };

  const markTruncated = (field) => { if (!detail.truncatedFields.includes(field)) detail.truncatedFields.push(field); };
  const textFields = ['whatWentWrong', 'correction', 'resultingFix'];
  const fit = () => byteLength(result) <= maxBytes;
  if (fit()) return result;

  // Revisions are audit detail and can grow over time. Keep the newest ones;
  // the exact omission count is explicit and the permanent record remains gettable.
  while (detail.revisions?.length && !fit()) {
    detail.revisions.shift();
    detail.omittedRevisionCount += 1;
    markTruncated('revisions');
  }
  const shorten = (object, key, fieldName) => {
    const current = object[key];
    if (typeof current !== 'string' || !current.length) return false;
    const currentBytes = Buffer.byteLength(current, 'utf8');
    const nextBytes = Math.max(0, Math.floor(currentBytes / 2));
    if (nextBytes === currentBytes) return false;
    object[key] = truncateUtf8(current, nextBytes).value;
    markTruncated(fieldName);
    return true;
  };
  const reductionOrder = depth === 2 ? [[detail.evidence, 'excerpt', 'evidence.excerpt']] : [];
  for (const [object, key, label] of reductionOrder) {
    while (!fit() && shorten(object, key, label)) { /* reduce until bounded */ }
  }
  while (!fit()) {
    const field = textFields.map(key => ({ key, bytes: Buffer.byteLength(detail[key], 'utf8') }))
      .sort((left, right) => right.bytes - left.bytes)[0];
    if (!field?.bytes || !shorten(detail, field.key, field.key)) break;
  }
  if (!fit()) throw new Error('Memory mistake response budget is too small.');
  return result;
}

function validateScope({ projectId, topicId }) {
  if (typeof projectId !== 'string' || !CONTEXT_ID.test(projectId)) throw new Error('Memory mistake project ID is invalid.');
  if (topicId !== undefined && (typeof topicId !== 'string' || !CONTEXT_ID.test(topicId))) {
    throw new Error('Memory mistake topic ID is invalid.');
  }
}

function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Memory mistake list limit is invalid.');
}

function validateBudget(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_BYTES || maxBytes > MAX_BYTES) {
    throw new Error('Memory mistake response budget is invalid.');
  }
}

/**
 * Bind typed mistake reads to one current signed Link authority. `authorize`
 * must synchronously recheck its current token, active lineage, memory-read
 * grant, and effective local-read policy; it may throw to deny the read.
 */
export function createMemoryMistakeReader({ store, lineageId, agentId, authorize } = {}) {
  const selectedLineage = String(lineageId || '').toLowerCase();
  if (!store || typeof store.getById !== 'function' || typeof store.listMemoryMistakes !== 'function' ||
    !LINEAGE_ID.test(selectedLineage) || !CONTEXT_ID.test(String(agentId || '')) || typeof authorize !== 'function') {
    throw new TypeError('The memory mistake reader requires the dated store and one current authorized Link identity.');
  }
  const selectedAgent = String(agentId);

  function assertCurrent(phase) {
    const result = authorize({ action: 'memory-mistake:read', phase, lineageId: selectedLineage, agentId: selectedAgent });
    if (result && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw new Error('Memory mistake read authorization must be synchronous.');
    }
    if (result === false || result?.allowed === false) throw new Error('Memory mistake read is not authorized.');
  }

  async function list({ projectId, topicId, limit = 10, maxBytes = DEFAULT_BYTES } = {}) {
    validateScope({ projectId, topicId });
    validateLimit(limit);
    validateBudget(maxBytes);
    const scopes = topicId === undefined ? [{ projectId }]
      : [{ projectId }, { projectId, topicId }];
    const readLimit = limit + 1;
    const candidates = [];
    let moreMayExist = false;
    for (const contextScope of scopes) {
      assertCurrent('list-before-read');
      const entries = await store.listMemoryMistakes({ lineageId: selectedLineage, agentId: selectedAgent,
        contextScope, limit: readLimit, depth: 0 });
      assertCurrent('list-after-read');
      if (!Array.isArray(entries)) throw new Error('Memory mistake records are invalid.');
      if (entries.length > limit) moreMayExist = true;
      for (const entry of entries) {
        const id = entry?.metadata?.memoryMistake?.record?.id;
        const normalizedId = typeof id === 'string' ? id.toLowerCase() : '';
        const item = canonicalFromEntry(entry, { lineageId: selectedLineage, agentId: selectedAgent,
          id: normalizedId, projectId, topicId });
        if (item) candidates.push(item);
      }
    }

    const unique = [...new Map(candidates.map(item => [item.record.id.toLowerCase(), item])).values()]
      .sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt) ||
        left.record.id.localeCompare(right.record.id));
    const selected = unique.slice(0, limit).map(item => listSummary(item, selectedLineage, selectedAgent));
    const sourceMayHaveMore = moreMayExist || unique.length > limit;
    const packet = { projectId, ...(topicId !== undefined ? { topicId } : {}), mistakes: [],
      limit, omittedCount: Math.max(0, unique.length - selected.length), additionalRecordsMayExist: sourceMayHaveMore,
      complete: !sourceMayHaveMore && unique.length <= selected.length };
    let byteOmittedCount = 0;
    for (const summary of selected) {
      const next = { ...packet, mistakes: [...packet.mistakes, summary] };
      if (byteLength(next) <= maxBytes) packet.mistakes.push(summary);
      else byteOmittedCount += 1;
    }
    packet.omittedCount += byteOmittedCount;
    packet.complete = packet.omittedCount === 0 && !packet.additionalRecordsMayExist;
    packet.truncated = packet.omittedCount > 0 || packet.additionalRecordsMayExist ||
      packet.mistakes.some(mistake => Object.hasOwn(mistake, 'textTruncated'));
    packet.complete = !packet.truncated;
    if (byteLength(packet) > maxBytes) throw new Error('Memory mistake response budget is too small.');
    assertCurrent('list-before-return');
    return packet;
  }

  async function get({ id, projectId, topicId, depth = 0, maxBytes = DEFAULT_BYTES } = {}) {
    validateScope({ projectId, topicId });
    validateBudget(maxBytes);
    const normalizedId = String(id || '').toLowerCase();
    const memoryId = datedMemoryId(normalizedId);
    if (!memoryId) throw new Error('Memory mistake ID is invalid.');
    if (![0, 1, 2].includes(depth)) throw new Error('Memory mistake depth must be 0, 1, or 2.');
    assertCurrent('get-before-read');
    const entry = await store.getById({ lineageId: selectedLineage, id: memoryId, depth });
    assertCurrent('get-after-read');
    const item = canonicalFromEntry(entry, { lineageId: selectedLineage, agentId: selectedAgent,
      id: normalizedId, projectId, topicId });
    const result = item ? boundedDetail(item, { depth, maxBytes,
      lineageId: selectedLineage, agentId: selectedAgent })
      : { id: normalizedId, state: 'absent', mistake: null };
    if (byteLength(result) > maxBytes) throw new Error('Memory mistake response budget is too small.');
    assertCurrent('get-before-return');
    return result;
  }

  return Object.freeze({ list, get });
}

export const memoryMistakeReaderLimits = Object.freeze({ defaultBytes: DEFAULT_BYTES,
  minimumBytes: MIN_BYTES, maximumBytes: MAX_BYTES, defaultListLimit: 10, maximumListLimit: 50 });
