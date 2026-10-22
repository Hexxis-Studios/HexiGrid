import crypto from 'node:crypto';
import { assertContinuitySafe } from './continuity-security.mjs';
import { normalizeOwnerMemory, reviseOwnerMemory } from './owner-memory.mjs';
import { canonicalRecordFromDatedEntry, createMemoryMistakeLedger, memoryMistakeDatedEntry } from './memory-mistake-ledger.mjs';

const OWNER_NOTE_ID = /^memory-[0-9a-f-]{36}$/i;
const LINEAGE_ID = /^lineage-[0-9a-f-]{36}$/i;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPTURE_FORMAT = 'hexigrid-owner-memory-correction-capture';
const MAX_SOURCE_TEXT = 50_000;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

function same(left, right) { return stable(left) === stable(right); }

function fail(message, code = 'invalid_owner_memory_correction', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function assertAllowed(assertAuthorized, phase, details = {}) {
  if (typeof assertAuthorized !== 'function') throw new TypeError('Owner-note correction requires current authorization.');
  const result = assertAuthorized({ action: 'owner-memory-correction', phase, ...details });
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw fail('Owner-note correction authorization must be synchronous.', 'invalid_owner_memory_authorization', 500);
  }
  if (result === false || result?.allowed === false) {
    throw fail('Owner-note correction is no longer authorized.', 'owner_memory_correction_not_authorized', 403);
  }
}

function boundedText(value, label, max, { required = true } = {}) {
  if (typeof value !== 'string') throw fail(`${label} must be text.`);
  const text = value.trim();
  if ((required && !text) || text.length > max) throw fail(`${label} is empty or too long.`);
  return text;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail(`${label} must be a valid timestamp.`);
  const timestamp = new Date(value).toISOString();
  if (timestamp !== value) throw fail(`${label} must be a canonical UTC timestamp.`);
  return timestamp;
}

function normalizeSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'agent-link-message' ||
      Object.keys(value).some(key => !['kind', 'id', 'linkId', 'text', 'createdAt'].includes(key))) {
    throw fail('An exact retained signed Link message is required.', 'owner_memory_correction_source_required');
  }
  const id = boundedText(value.id, 'Source message ID', 160);
  const linkId = boundedText(value.linkId, 'Source Link ID', 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(id) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(linkId) ||
      typeof value.text !== 'string' || !value.text || value.text.length > MAX_SOURCE_TEXT ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(String(value.createdAt || '')) ||
      !Number.isFinite(Date.parse(value.createdAt))) {
    throw fail('The exact retained signed Link message is invalid.', 'owner_memory_correction_source_invalid');
  }
  return Object.freeze({ kind: 'agent-link-message', id, linkId, text: value.text, createdAt: value.createdAt });
}

function normalizeAuthority(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !CONTEXT_ID.test(String(value.agentId || '')) || !LINEAGE_ID.test(String(value.lineageId || '')) ||
      !value.author || typeof value.author !== 'object' || Array.isArray(value.author) ||
      !['owner', 'agent'].includes(value.author.kind) || !CONTEXT_ID.test(String(value.author.id || ''))) {
    throw fail('Owner-note correction requires a trusted agent, lineage, and author identity.', 'invalid_owner_memory_correction_authority', 403);
  }
  return Object.freeze({ agentId: String(value.agentId), lineageId: String(value.lineageId).toLowerCase(),
    author: Object.freeze({ kind: value.author.kind, id: String(value.author.id) }) });
}

function revisionBy(author) {
  return `${author.kind === 'owner' ? 'owner' : 'agent-link'}:${author.id}`;
}

function authorSnapshot(note) {
  const last = note.revisions.at(-1);
  const author = String(last?.by || note.source || 'unknown').trim().slice(0, 120) || 'unknown';
  const at = canonicalTimestamp(last?.at || note.createdAt || note.updatedAt, 'Original note time');
  return Object.freeze({ author, at });
}

function capturePayload({ note, request, authority, source, revisionAt, revisedNote }) {
  const previousAuthor = authorSnapshot(note);
  const revision = revisedNote.revisions.at(-1);
  const payload = {
    format: CAPTURE_FORMAT,
    version: 1,
    idempotencyKey: `owner-note-correction:${note.id}:${revisedNote.revisions.length}`,
    memoryId: note.id,
    agentId: authority.agentId,
    lineageId: authority.lineageId,
    author: authority.author,
    expectedRevision: request.expectedRevision,
    revision: revisedNote.revisions.length,
    revisionBy: revision.by,
    revisionAt,
    revisionAuditHash: revision.audit?.hash || '',
    previous: Object.freeze({ content: note.content, author: previousAuthor.author, at: previousAuthor.at }),
    correctedContent: revisedNote.content,
    why: revision.why,
    expectedNextBehavior: revision.expectedNextBehavior,
    source
  };
  return Object.freeze({ ...payload, intentDigest: digest(payload) });
}

export function normalizeOwnerMemoryCaptureIntent(value) {
  const keys = ['format', 'version', 'idempotencyKey', 'memoryId', 'agentId', 'lineageId', 'author',
    'expectedRevision', 'revision', 'revisionBy', 'revisionAt', 'revisionAuditHash', 'previous',
    'correctedContent', 'why', 'expectedNextBehavior', 'source', 'intentDigest'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key)) ||
      value.format !== CAPTURE_FORMAT || value.version !== 1 || !OWNER_NOTE_ID.test(String(value.memoryId || '')) ||
      !CONTEXT_ID.test(String(value.agentId || '')) || !LINEAGE_ID.test(String(value.lineageId || '')) ||
      !value.author || !['owner', 'agent'].includes(value.author.kind) || !CONTEXT_ID.test(String(value.author.id || '')) ||
      !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
      value.revision !== value.expectedRevision + 1 ||
      value.idempotencyKey !== `owner-note-correction:${value.memoryId}:${value.revision}` ||
      typeof value.revisionBy !== 'string' || value.revisionBy !== revisionBy(value.author) ||
      typeof value.revisionAuditHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.revisionAuditHash) ||
      typeof value.previous?.content !== 'string' || typeof value.previous?.author !== 'string' ||
      typeof value.previous?.at !== 'string' || typeof value.correctedContent !== 'string' ||
      typeof value.why !== 'string' || typeof value.expectedNextBehavior !== 'string' ||
      typeof value.intentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.intentDigest)) {
    throw fail('The owner-note correction capture intent is invalid.', 'owner_memory_correction_intent_invalid');
  }
  const source = normalizeSource(value.source);
  const revisionAt = canonicalTimestamp(value.revisionAt, 'Correction revision time');
  const previousAt = canonicalTimestamp(value.previous.at, 'Original note time');
  const payload = {
    format: CAPTURE_FORMAT,
    version: 1,
    idempotencyKey: value.idempotencyKey,
    memoryId: value.memoryId,
    agentId: value.agentId,
    lineageId: String(value.lineageId).toLowerCase(),
    author: Object.freeze({ kind: value.author.kind, id: value.author.id }),
    expectedRevision: value.expectedRevision,
    revision: value.revision,
    revisionBy: value.revisionBy,
    revisionAt,
    revisionAuditHash: value.revisionAuditHash,
    previous: Object.freeze({ content: value.previous.content, author: value.previous.author, at: previousAt }),
    correctedContent: value.correctedContent,
    why: value.why,
    expectedNextBehavior: value.expectedNextBehavior,
    source
  };
  if (digest(payload) !== value.intentDigest) throw fail('The owner-note correction intent has changed.', 'owner_memory_correction_intent_mismatch', 409);
  assertContinuitySafe(payload);
  return Object.freeze({ ...payload, intentDigest: value.intentDigest });
}

function requestMatchesIntent(request, authority, intent) {
  return request.expectedRevision === intent.expectedRevision && request.text === intent.correctedContent &&
    request.why === intent.why && request.expectedNextBehavior === intent.expectedNextBehavior &&
    same(normalizeSource(request.source), intent.source) &&
    authority.agentId === intent.agentId && authority.lineageId === intent.lineageId && same(authority.author, intent.author) &&
    (request.createdAt === undefined || request.createdAt === intent.revisionAt);
}

function assertIntentMatchesNote(noteInput, intent) {
  const note = normalizeOwnerMemory(noteInput);
  if (note.id !== intent.memoryId || note.agentId !== intent.agentId || note.revisions.length !== intent.revision ||
      !['active', 'conditional'].includes(note.status) || note.content !== intent.correctedContent ||
      note.updatedAt !== intent.revisionAt) {
    throw fail('The owner note no longer has the exact revision named by this capture intent.', 'owner_memory_correction_stale', 409);
  }
  const revision = note.revisions[intent.expectedRevision];
  const priorRevision = intent.expectedRevision > 0 ? note.revisions[intent.expectedRevision - 1] : null;
  const originalAuthor = String(priorRevision?.by || note.source || 'unknown').trim().slice(0, 120) || 'unknown';
  const originalAt = canonicalTimestamp(priorRevision?.at || note.createdAt || note.updatedAt, 'Original note time');
  if (!revision || revision.at !== intent.revisionAt || revision.by !== intent.revisionBy || revision.why !== intent.why ||
      revision.expectedNextBehavior !== intent.expectedNextBehavior || !same(revision.source, intent.source) ||
      revision.changes?.content?.from !== intent.previous.content || revision.changes?.content?.to !== intent.correctedContent ||
      revision.audit?.hash !== intent.revisionAuditHash || originalAuthor !== intent.previous.author ||
      originalAt !== intent.previous.at) {
    throw fail('The retained owner-note revision does not match its exact correction capture intent.', 'owner_memory_correction_intent_mismatch', 409);
  }
  return note;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Prepare one signed, evidence-backed owner-note correction. The owner note
 * stays in its append-only state.memories history; the returned intent is a
 * durable retry token for a separate canonical mistake-log append. The two
 * stores cannot commit atomically, so callers must persist this intent beside
 * the note revision and retry capture with the same intent after interruption.
 * The authorization callback must compare the live state.memories note ID,
 * lineage, revision, and audit hash on every phase; this module validates only
 * the immutable note snapshot passed to it.
 * Direct owner edits without a retained signed source are deliberately refused.
 */
export function prepareOwnerMemoryCorrection({ current, request, authority, assertAuthorized } = {}) {
  assertAllowed(assertAuthorized, 'prepare');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw fail('Owner-note correction request is invalid.');
  const trusted = normalizeAuthority(authority);
  const note = normalizeOwnerMemory(current);
  if (!OWNER_NOTE_ID.test(note.id) || note.agentId !== trusted.agentId) {
    throw fail('The correction does not target this exact owner note and agent.', 'owner_memory_correction_identity_mismatch', 403);
  }
  const expectedRevision = request.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw fail('Expected owner-note revision is invalid.');
  const source = normalizeSource(request.source);
  const text = boundedText(request.text, 'Replacement note', 4000);
  const why = boundedText(request.why, 'Correction reason', 500);
  const expectedNextBehavior = boundedText(request.expectedNextBehavior, 'Expected next behavior', 2000);
  if (!['active', 'conditional'].includes(note.status)) throw fail('Only a current owner note can be corrected.', 'owner_memory_correction_stale', 409);

  const suppliedIntent = request.captureIntent === undefined ? null : normalizeOwnerMemoryCaptureIntent(request.captureIntent);
  if (suppliedIntent) {
    if (!requestMatchesIntent({ ...request, text, why, expectedNextBehavior, source }, trusted, suppliedIntent) ||
        suppliedIntent.memoryId !== note.id) {
      throw fail('The retry does not match the exact prepared owner-note correction.', 'owner_memory_correction_intent_mismatch', 409);
    }
    if (note.revisions.length === suppliedIntent.revision) {
      const currentRevision = assertIntentMatchesNote(note, suppliedIntent);
      assertAllowed(assertAuthorized, 'prepare-retry-complete', { memoryId: note.id, revision: suppliedIntent.revision });
      return Object.freeze({ revisedNote: currentRevision, captureIntent: suppliedIntent, duplicate: true });
    }
    if (note.revisions.length !== expectedRevision) {
      throw fail('The owner note changed after this correction was prepared.', 'owner_memory_correction_stale', 409);
    }
  } else if (note.revisions.length !== expectedRevision) {
    throw fail('Owner-note revision conflict; older history cannot be enrolled without its saved capture intent.',
      'owner_memory_correction_stale', 409);
  }
  if (note.content === text) throw fail('The correction does not change the current owner note.');

  const revisionAt = suppliedIntent?.revisionAt ?? canonicalTimestamp(request.createdAt ?? new Date().toISOString(), 'Correction revision time');
  const revisionPatch = reviseOwnerMemory(note, { content: text }, { by: revisionBy(trusted.author), why,
    at: revisionAt, source, expectedNextBehavior });
  const candidate = capturePayload({ note, request: { ...request, expectedRevision }, authority: trusted,
    source, revisionAt, revisedNote: revisionPatch });
  if (suppliedIntent && !same(candidate, suppliedIntent)) {
    throw fail('The persisted capture intent differs from the proposed owner-note revision.', 'owner_memory_correction_intent_mismatch', 409);
  }
  const captureIntent = suppliedIntent || candidate;
  assertIntentMatchesNote(revisionPatch, captureIntent);
  assertAllowed(assertAuthorized, 'prepare-complete', { memoryId: note.id, revision: captureIntent.revision });
  return Object.freeze({ revisedNote: revisionPatch, captureIntent: deepFreeze(captureIntent), duplicate: false });
}

function excerpt(value, limit) {
  let output = '';
  let bytes = 0;
  for (const character of String(value ?? '').trim()) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > limit - 18) break;
    output += character;
    bytes += size;
  }
  const full = String(value ?? '').trim();
  return Buffer.byteLength(full, 'utf8') <= limit ? full : `${output} [excerpt limited]`;
}

/**
 * Capture a previously prepared owner-note correction in the existing dated
 * memory log. This is a second, separately durable write. A retry after either
 * side of the boundary uses the same explicit intent and stable ID; it never
 * invents evidence from older note history or rewrites the owner note.
 */
export async function captureOwnerMemoryCorrection({ store, currentNote, intent: rawIntent, assertAuthorized } = {}) {
  if (!store || typeof store.getById !== 'function' || typeof store.append !== 'function') {
    throw new TypeError('Owner-note mistake capture requires the canonical dated-memory store.');
  }
  const intent = normalizeOwnerMemoryCaptureIntent(rawIntent);
  assertAllowed(assertAuthorized, 'capture', { memoryId: intent.memoryId, revision: intent.revision,
    agentId: intent.agentId, lineageId: intent.lineageId });
  const scope = Object.freeze({ projectId: 'owner-notes', topicId: intent.agentId });
  const authority = Object.freeze({ agentId: intent.agentId, lineageId: intent.lineageId,
    contextScope: scope, author: intent.author });
  const note = assertIntentMatchesNote(currentNote, intent);

  const authorize = context => {
    assertAllowed(assertAuthorized, context.phase, { memoryId: intent.memoryId, revision: intent.revision,
      agentId: intent.agentId, lineageId: intent.lineageId });
    assertIntentMatchesNote(note, intent);
    return { allowed: true };
  };
  const sourceId = intent.source.id;
  const sourceExcerpt = excerpt(intent.source.text, 4096);
  const observedAt = new Date(intent.source.createdAt).toISOString();
  const ledger = createMemoryMistakeLedger({
    authorize,
    now: () => intent.revisionAt,
    async verifyEvidence({ reference, authority: verifiedAuthority }) {
      authorize({ phase: 'evidence-before' });
      if (reference.kind !== 'link-message' || reference.id !== sourceId ||
          verifiedAuthority.agentId !== intent.agentId || verifiedAuthority.lineageId !== intent.lineageId ||
          !same(verifiedAuthority.author, intent.author)) {
        throw fail('The retained signed evidence does not match this owner-note correction.', 'owner_memory_correction_source_mismatch', 409);
      }
      const verified = { verified: true, ...reference, excerpt: sourceExcerpt, observedAt };
      assertContinuitySafe(verified);
      authorize({ phase: 'evidence-after' });
      return verified;
    },
    async loadById({ id, lineageId: selectedLineage, agentId }) {
      authorize({ phase: 'lookup-before' });
      const entry = await store.getById({ lineageId: selectedLineage, id: `memory-${id.slice('mistake-'.length)}`, depth: 2 });
      authorize({ phase: 'lookup-after' });
      return canonicalRecordFromDatedEntry(entry, { lineageId: intent.lineageId, agentId: intent.agentId, scope });
    },
    async commit(record, options) {
      const entry = memoryMistakeDatedEntry(record);
      options.assertAuthorized();
      const receipt = await store.append({ ...entry, assertAuthorized: options.assertAuthorized });
      options.assertAuthorized();
      const saved = canonicalRecordFromDatedEntry(receipt?.entry, {
        lineageId: intent.lineageId, agentId: intent.agentId, scope
      });
      if (!saved || saved.id !== record.id || saved.requestDigest !== record.requestDigest) {
        throw fail('The canonical owner-note mistake append returned a mismatched record.', 'owner_memory_correction_commit_mismatch', 500);
      }
      return { created: receipt.appended === true, record: saved };
    }
  });

  const recorded = await ledger.record({
    whatWentWrong: excerpt(intent.previous.content, 2048),
    correction: excerpt(intent.correctedContent, 2048),
    resultingFix: excerpt(intent.expectedNextBehavior, 2048),
    evidence: { kind: 'link-message', id: sourceId },
    idempotencyKey: intent.idempotencyKey
  }, authority);
  authorize({ phase: 'receipt-before-read' });
  const entry = await store.getById({ lineageId: intent.lineageId, id: `memory-${recorded.id.slice('mistake-'.length)}`, depth: 2 });
  authorize({ phase: 'receipt-after-read' });
  const canonical = canonicalRecordFromDatedEntry(entry, { lineageId: intent.lineageId,
    agentId: intent.agentId, scope });
  if (!canonical || canonical.id !== recorded.id) {
    throw fail('The canonical owner-note mistake receipt could not be verified.', 'owner_memory_correction_receipt_invalid', 500);
  }
  return Object.freeze({ ...recorded, entry, record: canonical, scope });
}
