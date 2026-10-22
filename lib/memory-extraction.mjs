import crypto from 'node:crypto';
import { validateMemoryProposal } from './dated-memory.mjs';
import { assertContinuitySafe } from './continuity-security.mjs';

const LINEAGE_ID = /^lineage-[0-9a-f-]{36}$/i;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SOURCE_KINDS = new Set(['room-turn', 'task-run']);
const FACT_KINDS = new Set(['fact', 'decision', 'preference', 'correction', 'policy', 'rule', 'instruction', 'permission', 'access-control']);
const POLICY_KINDS = new Set(['policy', 'rule', 'instruction', 'permission', 'access-control']);
const CANDIDATE_FIELDS = new Set(['kind', 'text', 'evidence_excerpt', 'valid_while', 'verify_by']);
const CURRENT_STATUSES = new Set(['active', 'conditional']);
const QUARANTINE_REASON_CODES = new Set(['delayed_prompt_injection', 'high_confidence_ssn',
  'payment_card_number', 'unsupported_shape', 'input_too_large', 'write_spike']);
const MAX_QUARANTINE_REASON_CODES = 4;
const DEFAULT_LIMITS = Object.freeze({ sourceBytes: 32 * 1024, outputBytes: 16 * 1024,
  candidates: 8, candidateBytes: 3 * 1024, totalCandidateBytes: 12 * 1024, evidenceBytes: 2 * 1024 });
const MAX_LIMITS = Object.freeze({ sourceBytes: 64 * 1024, outputBytes: 32 * 1024,
  candidates: 16, candidateBytes: 4 * 1024, totalCandidateBytes: 16 * 1024, evidenceBytes: 4 * 1024 });
const POLICY_FIELD = /policy|permission|instruction|rule|access.?control/i;
const POLICY_LANGUAGE = /\b(?:must(?:\s+not|n't)?|shall(?:\s+not)?|should(?:\s+not|n't)?|may\s+not|can(?:not|'t)|do\s+not|don't|never|always|required|forbidden|prohibit(?:ed)?|allow(?:ed)?|disallow(?:ed)?|permission|policy|rule|instruction|access\s+control)\b/i;
const MAX_CURRENT_FACTS = 128;
const MAX_CURRENT_FACT_BYTES = 64 * 1024;

/**
 * Process one already-authorized retained conversation batch into bounded
 * proposal submissions. This module owns no storage, scheduler, provider, or
 * memory writes. `extractLocally`, `listCurrentFacts`, `assessRelation`,
 * `authorize`, and `submitCandidate` are caller adapters. The caller must
 * provide a local-only extractor and a submit adapter that rechecks effective
 * policy at commit; `reviewRequired` must always remain pending for an owner.
 *
 * Caller-supplied agent, lineage, source reference, and scope are the only
 * identity/provenance values used. The extractor cannot choose them. Exact
 * evidence is required. Structural checks reject obvious multi-statement
 * formatting, and a small policy-language heuristic routes likely rules to
 * review; neither is a complete natural-language safety classifier. The
 * caller's submit adapter remains responsible for enforcing review at commit.
 * A quarantined result from that adapter is a terminal outcome for this
 * candidate, counted separately from accepted submissions and owner review.
 */
export async function processMemoryExtractionBatch(options = {}) {
  const report = createReport();
  if (options.enabled !== true) return finish(report, 'disabled', 'learning-disabled');

  const limits = normalizeLimits(options.limits);
  if (!limits) return finish(report, 'skipped', 'invalid-limits');
  const identity = normalizeIdentity(options);
  if (!identity) return finish(report, 'skipped', Object.hasOwn(options, 'scope') ? 'invalid-caller-identity-or-scope' : 'scope-required');
  const source = normalizeSource(options.source, limits);
  if (!source) return finish(report, 'skipped', 'invalid-or-oversized-source');
  if (source.error) return finish(report, 'skipped', source.error);

  const callbacks = ['extractLocally', 'listCurrentFacts', 'assessRelation', 'authorize', 'submitCandidate'];
  if (callbacks.some((name) => typeof options[name] !== 'function')) return finish(report, 'unavailable', 'required-adapter-unavailable');
  if (isCancelled(options.signal)) return finish(report, 'cancelled', 'cancelled-before-extraction');
  if (!await isEnabledNow(options)) return finish(report, 'disabled', 'learning-disabled');

  const initialAuthorization = await authorize(options.authorize, {
    phase: 'extract', ...identity, sourceRef: source.ref, signal: options.signal
  });
  if (!initialAuthorization.allowed || initialAuthorization.reviewRequired) {
    return finish(report, 'blocked', initialAuthorization.reviewRequired ? 'extraction-review-required' :
      initialAuthorization.reason || 'extraction-not-authorized');
  }
  if (isCancelled(options.signal)) return finish(report, 'cancelled', 'cancelled-before-extraction');
  if (!await isEnabledNow(options)) return finish(report, 'disabled', 'learning-disabled');

  let extracted;
  try {
    extracted = await options.extractLocally({ source: Object.freeze({ ...source.ref, text: source.text }),
      agentId: identity.agentId, lineageId: identity.lineageId, scope: identity.scope,
      maxCandidates: limits.candidates, maxOutputBytes: limits.outputBytes, signal: options.signal });
  } catch {
    return finish(report, isCancelled(options.signal) ? 'cancelled' : 'unavailable',
      isCancelled(options.signal) ? 'cancelled-during-extraction' : 'local-extractor-failed');
  }
  if (isCancelled(options.signal)) return finish(report, 'cancelled', 'cancelled-during-extraction');
  if (!await isEnabledNow(options)) return finish(report, 'disabled', 'learning-disabled');

  let extractedLength;
  try {
    if (!Array.isArray(extracted)) return finish(report, 'skipped', 'invalid-extractor-output');
    extractedLength = extracted.length;
  } catch {
    return finish(report, 'skipped', 'invalid-extractor-output');
  }
  report.candidateCount = extractedLength;
  if (!extractedLength) return finish(report, 'empty', 'no-candidates');

  const accepted = [];
  let acceptedBytes = 0;
  let extractorOutputBytes = 2;
  // Source IDs identify a retained batch, while the digest distinguishes a
  // legitimate source revision that reused those IDs. Keep the digest only in
  // the opaque key; never return or persist the source text from this module.
  const batchKey = digest({ lineageId: identity.lineageId, scope: identity.scope,
    source: source.ref, contentDigest: digest(source.text) });
  report.batchKey = `memory-extract-${batchKey}`;
  const processCount = Math.min(extractedLength, limits.candidates);
  for (let index = 0; index < processCount; index += 1) {
    let candidateValue;
    let serialized;
    try {
      candidateValue = extracted[index];
      serialized = serializeCandidate(candidateValue, limits.candidateBytes);
    } catch {
      addIssue(report, index, 'skipped', 'candidate-schema-invalid');
      continue;
    }
    if (!serialized.encoded) {
      addIssue(report, index, serialized.outcome || 'skipped', serialized.reason || 'invalid-extractor-candidate');
      continue;
    }
    if (typeof serialized.encoded !== 'string') {
      addIssue(report, index, 'skipped', 'invalid-extractor-candidate');
      continue;
    }
    const candidateOutputBytes = Buffer.byteLength(serialized.encoded, 'utf8');
    const separatorBytes = index ? 1 : 0;
    if (extractorOutputBytes + separatorBytes + candidateOutputBytes > limits.outputBytes) {
      addIssue(report, index, 'skipped', 'extractor-output-byte-limit');
      addManyIssues(report, index + 1, processCount - index - 1, 'skipped', 'extractor-output-byte-limit');
      break;
    }
    extractorOutputBytes += separatorBytes + candidateOutputBytes;
    let parsed;
    try {
      parsed = validateCandidate(candidateValue, { sourceText: source.text, sourceRef: source.ref,
        scope: identity.scope, limits });
    } catch {
      parsed = { reason: 'candidate-schema-invalid' };
    }
    if (!parsed.proposal) {
      addIssue(report, index, parsed.outcome || 'skipped', parsed.reason || 'candidate-invalid');
      continue;
    }
    const bytes = Buffer.byteLength(JSON.stringify(parsed.proposal), 'utf8');
    if (acceptedBytes + bytes > limits.totalCandidateBytes) {
      addIssue(report, index, 'skipped', 'candidate-batch-byte-limit');
      continue;
    }
    acceptedBytes += bytes;
    accepted.push({ index, proposal: freezeProposal(parsed.proposal), kind: parsed.kind,
      reviewRequired: parsed.reviewRequired, key: `memory-extract-${digest({ batchKey, proposal: parsed.proposal })}` });
  }
  if (extractedLength > limits.candidates) {
    addManyIssues(report, limits.candidates, extractedLength - limits.candidates, 'skipped', 'candidate-count-limit');
  }
  if (!accepted.length) return finish(report, 'skipped', 'no-valid-candidates');

  let currentFacts;
  try {
    if (isCancelled(options.signal)) return finish(report, 'cancelled', 'cancelled-before-current-fact-check');
    if (!await isEnabledNow(options)) return finish(report, 'disabled', 'learning-disabled');
    currentFacts = await options.listCurrentFacts({ lineageId: identity.lineageId,
      scope: identity.scope, signal: options.signal });
    currentFacts = validateCurrentFacts(currentFacts, identity);
  } catch {
    return finish(report, isCancelled(options.signal) ? 'cancelled' : 'unavailable',
      isCancelled(options.signal) ? 'cancelled-during-current-fact-check' : 'current-fact-check-failed');
  }

  const submittedFacts = [];
  const quarantinedKeys = new Set();
  for (let offset = 0; offset < accepted.length; offset += 1) {
    const item = accepted[offset];
    if (isCancelled(options.signal)) {
      skipRemaining(report, accepted, offset, 'cancelled-before-submission');
      return finish(report, 'cancelled', 'cancelled-before-submission');
    }
    if (!await isEnabledNow(options)) {
      skipRemaining(report, accepted, offset, 'learning-disabled');
      return finish(report, 'disabled', 'learning-disabled');
    }
    if (quarantinedKeys.has(item.key)) {
      addIssue(report, item.index, 'duplicate', 'duplicate-candidate-in-batch');
      continue;
    }

    const exactKey = comparableText(item.proposal.text);
    const comparisonFacts = [...currentFacts, ...submittedFacts];
    const sameTextInScope = comparisonFacts.filter((record) => sameExactScope(record.contextScope ?? null, identity.scope) &&
      comparableText(record.text) === exactKey);
    const exactStandingExists = sameTextInScope.some((record) => sameMemoryStanding(record, item.proposal));
    const changedStanding = sameTextInScope.some((record) => !sameMemoryStanding(record, item.proposal));
    if (exactStandingExists && !changedStanding) {
      addIssue(report, item.index, 'duplicate', submittedFacts.some((record) => sameMemoryStanding(record, item.proposal))
        ? 'duplicate-candidate-in-batch' : 'duplicate-current-fact');
      continue;
    }

    let relation;
    try {
      relation = await options.assessRelation({ candidate: item.proposal.text,
        candidateKind: item.kind, currentFacts: Object.freeze(comparisonFacts), lineageId: identity.lineageId,
        scope: identity.scope, signal: options.signal });
    } catch {
      addIssue(report, item.index, 'skipped', 'relation-check-failed');
      continue;
    }
    if (isCancelled(options.signal)) {
      skipRemaining(report, accepted, offset, 'cancelled-before-submission');
      return finish(report, 'cancelled', 'cancelled-before-submission');
    }
    if (relation === 'duplicate' && !changedStanding) {
      addIssue(report, item.index, 'duplicate', 'duplicate-current-fact'); continue;
    }
    if (!['none', 'possible-contradiction'].includes(relation) && !(relation === 'duplicate' && changedStanding)) {
      addIssue(report, item.index, 'skipped', 'invalid-relation-result');
      continue;
    }

    const reviewRequired = item.reviewRequired || changedStanding || relation === 'possible-contradiction';
    if (!await isEnabledNow(options)) {
      skipRemaining(report, accepted, offset, 'learning-disabled');
      return finish(report, 'disabled', 'learning-disabled');
    }
    const permission = await authorize(options.authorize, { phase: 'submit', ...identity,
      sourceRef: source.ref, idempotencyKey: item.key, reviewRequired, signal: options.signal });
    if (!permission.allowed) {
      skipRemaining(report, accepted, offset, permission.reason || 'authorization-changed');
      return finish(report, 'blocked', permission.reason || 'authorization-changed');
    }
    if (isCancelled(options.signal)) {
      skipRemaining(report, accepted, offset, 'cancelled-before-submission');
      return finish(report, 'cancelled', 'cancelled-before-submission');
    }
    if (!await isEnabledNow(options)) {
      skipRemaining(report, accepted, offset, 'learning-disabled');
      return finish(report, 'disabled', 'learning-disabled');
    }

    try {
      const submitted = await options.submitCandidate({ proposal: item.proposal,
        agentId: identity.agentId, lineageId: identity.lineageId, sourceRef: source.ref,
        idempotencyKey: item.key, reviewRequired: reviewRequired || permission.reviewRequired === true,
        signal: options.signal });
      if (submitted && typeof submitted === 'object' && submitted.quarantined === true) {
        quarantinedKeys.add(item.key);
        addQuarantine(report, item.index, submitted.reasonCodes);
      } else if (!submitted || !['committed', 'pending', 'duplicate'].includes(submitted.status)) {
        addIssue(report, item.index, 'skipped', 'proposal-service-rejected-candidate');
      } else if (submitted.status === 'duplicate') {
        addIssue(report, item.index, 'duplicate', 'proposal-already-submitted');
      } else {
        report.submittedCount += 1;
        if (submitted.status === 'committed') report.committedCount += 1;
        else { report.pendingReviewCount += 1; report.reviewNeededCount += 1; }
        submittedFacts.push(Object.freeze({ lineageId: identity.lineageId, text: item.proposal.text,
          status: item.proposal.status, valid_while: item.proposal.valid_while,
          verify_by: item.proposal.verify_by, contextScope: item.proposal.contextScope }));
        if ((reviewRequired || permission.reviewRequired === true) && submitted.status === 'committed') {
          addIssue(report, item.index, 'review-required', 'proposal-service-committed-review-only-candidate');
          skipRemaining(report, accepted, offset + 1, 'review-only-submission-committed');
          return finish(report, 'blocked', 'review-only-submission-committed');
        }
      }
    } catch {
      addIssue(report, item.index, 'skipped', 'proposal-submission-failed');
      skipRemaining(report, accepted, offset + 1, 'proposal-submission-stopped');
      return finish(report, 'unavailable', 'proposal-submission-failed');
    }
  }
  return finish(report, 'completed', report.skippedCount ? 'some-candidates-skipped'
    : report.quarantinedCount ? 'some-candidates-quarantined' : 'batch-processed');
}

function validateCandidate(value, { sourceText, sourceRef, scope, limits }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return { reason: 'candidate-schema-invalid' };
  }
  if (Object.keys(value).length > CANDIDATE_FIELDS.size) {
    return { outcome: 'review-needed', reason: 'unsupported-candidate-shape-needs-review' };
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { reason: 'candidate-schema-invalid' };
  }
  try { assertContinuitySafe(value); }
  catch (error) {
    if (error?.code === 'CONTINUITY_SECRET') return { reason: 'candidate-secret-rejected' };
    return { reason: 'candidate-safety-check-failed' };
  }

  const keys = Object.keys(value);
  const extra = keys.filter((key) => !CANDIDATE_FIELDS.has(key));
  if (extra.length) {
    return { outcome: extra.some((key) => POLICY_FIELD.test(key)) ? 'review-needed' : 'skipped',
      reason: extra.some((key) => POLICY_FIELD.test(key)) ? 'unsupported-policy-shape-needs-review' : 'unsupported-candidate-fields' };
  }
  const kind = typeof value.kind === 'string' ? value.kind.trim().toLowerCase() : '';
  if (!FACT_KINDS.has(kind)) return POLICY_FIELD.test(kind)
    ? { outcome: 'review-needed', reason: 'unsupported-policy-candidate-needs-review' }
    : { reason: 'unsupported-candidate-kind' };
  if (typeof value.text !== 'string' || typeof value.evidence_excerpt !== 'string') return { reason: 'candidate-text-and-evidence-required' };
  if (Buffer.byteLength(value.text, 'utf8') > limits.candidateBytes || Buffer.byteLength(value.evidence_excerpt, 'utf8') > limits.candidateBytes ||
    (typeof value.valid_while === 'string' && Buffer.byteLength(value.valid_while, 'utf8') > limits.candidateBytes) ||
    (typeof value.verify_by === 'string' && Buffer.byteLength(value.verify_by, 'utf8') > limits.candidateBytes)) {
    return { reason: 'candidate-byte-limit' };
  }
  if (Object.hasOwn(value, 'valid_while') && (typeof value.valid_while !== 'string' || !value.valid_while.trim())) {
    return { reason: 'candidate-valid-while-invalid' };
  }
  if (Object.hasOwn(value, 'verify_by') && value.verify_by !== null && typeof value.verify_by !== 'string') {
    return { reason: 'candidate-verify-by-invalid' };
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > limits.candidateBytes) return { reason: 'candidate-byte-limit' };
  if (!value.evidence_excerpt.trim() || Buffer.byteLength(value.evidence_excerpt, 'utf8') > limits.evidenceBytes ||
    !sourceText.includes(value.evidence_excerpt)) return { reason: 'evidence-not-exact-source-substring' };
  if (value.text.includes('\n') || value.text.includes('\r') || value.text.includes(';') ||
    /[.!?]["')\]]*\s+\p{L}/u.test(value.text)) return { reason: 'candidate-must-be-one-atomic-statement' };

  const normalizedKind = POLICY_KINDS.has(kind) || POLICY_LANGUAGE.test(value.text) ? 'policy' : kind;
  const proposalInput = {
    text: value.text,
    status: value.valid_while ? 'conditional' : 'active',
    evidence_excerpt: value.evidence_excerpt,
    ...(value.valid_while === undefined ? {} : { valid_while: value.valid_while }),
    ...(value.verify_by === undefined ? {} : { verify_by: value.verify_by }),
    metadata: { extraction: { kind: normalizedKind, sourceKind: sourceRef.kind,
      sourceId: sourceRef.id, batchId: sourceRef.batchId } },
    ...(scope ? { contextScope: scope } : {})
  };
  let proposal;
  try { proposal = validateMemoryProposal(proposalInput); }
  catch (error) {
    return { reason: error?.code === 'CONTINUITY_SECRET' ? 'candidate-secret-rejected' : 'candidate-validation-failed' };
  }
  return { proposal, kind: normalizedKind, reviewRequired: normalizedKind === 'policy' };
}

function normalizeIdentity(options) {
  const lineageId = String(options.lineageId || '').toLowerCase();
  const agentId = String(options.agentId || '').trim();
  if (!LINEAGE_ID.test(lineageId) || !AGENT_ID.test(agentId) || !Object.hasOwn(options, 'scope')) return null;
  if (options.scope === null) return Object.freeze({ lineageId, agentId, scope: null });
  if (!options.scope || typeof options.scope !== 'object' || Array.isArray(options.scope)) return null;
  try {
    const checked = validateMemoryProposal({ text: 'scope validation', contextScope: options.scope });
    if (!checked.contextScope || typeof checked.contextScope.projectId !== 'string') return null;
    Object.freeze(checked.contextScope);
    return Object.freeze({ lineageId, agentId, scope: checked.contextScope });
  } catch { return null; }
}

function serializeCandidate(value, maxBytes) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return { reason: 'candidate-schema-invalid' };
  let keys;
  try { keys = Object.keys(value); } catch { return { reason: 'candidate-schema-invalid' }; }
  if (keys.length > CANDIDATE_FIELDS.size) {
    return { outcome: 'review-needed', reason: 'unsupported-candidate-shape-needs-review' };
  }
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { return { reason: 'candidate-schema-invalid' }; }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { reason: 'candidate-schema-invalid' };
    const field = descriptor.value;
    if (field !== null && typeof field !== 'string') return { reason: 'candidate-schema-invalid' };
    if (typeof field === 'string' && Buffer.byteLength(field, 'utf8') > maxBytes) return { reason: 'candidate-byte-limit' };
  }
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' && Buffer.byteLength(encoded, 'utf8') <= maxBytes
      ? { encoded } : { reason: 'candidate-byte-limit' };
  } catch { return { reason: 'candidate-schema-invalid' }; }
}

function normalizeSource(value, limits) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SOURCE_KINDS.has(value.kind) ||
    !SOURCE_ID.test(String(value.id || '')) || !SOURCE_ID.test(String(value.batchId || '')) ||
    typeof value.text !== 'string' || !value.text.trim() ||
    Buffer.byteLength(value.text, 'utf8') > limits.sourceBytes) return null;
  const ref = Object.freeze({ kind: value.kind, id: String(value.id), batchId: String(value.batchId) });
  try { assertContinuitySafe(value.text); }
  catch (error) { return { ref, text: value.text, error: error?.code === 'CONTINUITY_SECRET' ? 'source-secret-rejected' : 'source-safety-check-failed' }; }
  return { ref, text: value.text };
}

function validateCurrentFacts(records, identity) {
  if (!Array.isArray(records)) throw new Error('Current-fact lookup must return an array.');
  if (records.length > MAX_CURRENT_FACTS) throw new Error('Current-fact lookup exceeded its bounded fact count.');
  const current = [];
  let totalBytes = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object' || typeof record.text !== 'string') throw new Error('Current-fact lookup returned an invalid record.');
    if (String(record.lineageId || '').toLowerCase() !== identity.lineageId) throw new Error('Current-fact lookup crossed lineage.');
    const contextScope = record.contextScope == null ? null : validateMemoryProposal({
      text: 'scope validation', contextScope: record.contextScope
    }).contextScope;
    if (!scopeIsInRecallAperture(contextScope, identity.scope)) throw new Error('Current-fact lookup crossed scope.');
    totalBytes += Buffer.byteLength(record.text, 'utf8');
    if (totalBytes > MAX_CURRENT_FACT_BYTES) throw new Error('Current-fact lookup exceeded its bounded byte size.');
    if (CURRENT_STATUSES.has(record.status)) {
      // Normalize standing through the same validator used for proposals so
      // validity conditions and verification dates participate in duplicate
      // and conflict handling instead of being silently discarded.
      const standing = validateMemoryProposal({ text: record.text, status: record.status,
        valid_while: record.valid_while, verify_by: record.verify_by,
        contextScope: contextScope ?? null });
      if (standing.contextScope) Object.freeze(standing.contextScope);
      current.push(Object.freeze({ lineageId: identity.lineageId, text: standing.text,
        status: standing.status, valid_while: standing.valid_while,
        verify_by: standing.verify_by, contextScope: standing.contextScope }));
    }
  }
  return Object.freeze(current);
}

function scopeIsInRecallAperture(recordScope, selectedScope) {
  if (selectedScope === null) return recordScope === null;
  if (!recordScope || recordScope.projectId !== selectedScope.projectId) return false;
  if (selectedScope.topicId === undefined) return recordScope.topicId === undefined;
  return recordScope.topicId === undefined || recordScope.topicId === selectedScope.topicId;
}

function sameExactScope(left, right) {
  if (left === null || right === null) return left === right;
  return Boolean(left && right && left.projectId === right.projectId && left.topicId === right.topicId &&
    Object.hasOwn(left, 'topicId') === Object.hasOwn(right, 'topicId'));
}

function sameMemoryStanding(left, right) {
  return comparableText(left.text) === comparableText(right.text) &&
    left.status === right.status &&
    (left.valid_while || '') === (right.valid_while || '') &&
    (left.verify_by ?? null) === (right.verify_by ?? null);
}

function freezeProposal(proposal) {
  if (proposal.contextScope) Object.freeze(proposal.contextScope);
  if (proposal.metadata?.extraction) Object.freeze(proposal.metadata.extraction);
  if (proposal.metadata) Object.freeze(proposal.metadata);
  return Object.freeze(proposal);
}

function normalizeLimits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const limits = {};
  for (const name of Object.keys(DEFAULT_LIMITS)) {
    const selected = value[name] === undefined ? DEFAULT_LIMITS[name] : value[name];
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > MAX_LIMITS[name]) return null;
    limits[name] = selected;
  }
  return limits;
}

async function authorize(callback, input) {
  try {
    const result = await callback(input);
    if (result === true) return { allowed: true, reviewRequired: false };
    if (result === false || !result || typeof result !== 'object') return { allowed: false, reason: 'authorization-denied' };
    return { allowed: result.allowed === true, reviewRequired: result.reviewRequired === true,
      reason: result.allowed === true ? '' : 'authorization-denied' };
  } catch { return { allowed: false, reason: 'authorization-unavailable' }; }
}

async function isEnabledNow(options) {
  try { return typeof options.isEnabled === 'function' ? await options.isEnabled() === true : options.enabled === true; }
  catch { return false; }
}

function isCancelled(signal) { return signal?.aborted === true; }

function comparableText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createReport() {
  return { status: 'unavailable', reason: '', batchKey: null, candidateCount: 0,
    submittedCount: 0, committedCount: 0, pendingReviewCount: 0, duplicateCount: 0,
    quarantinedCount: 0, quarantineReasonCounts: {}, skippedCount: 0, reviewNeededCount: 0,
    issues: [], skipReasons: {} };
}

function addQuarantine(report, index, reasonCodes) {
  const boundedCodes = normalizeQuarantineReasonCodes(reasonCodes);
  report.quarantinedCount += 1;
  for (const code of boundedCodes) {
    report.quarantineReasonCounts[code] = (report.quarantineReasonCounts[code] || 0) + 1;
  }
  if (report.issues.length < 32) {
    report.issues.push({ index, outcome: 'quarantined', reasonCodes: boundedCodes });
  }
}

function normalizeQuarantineReasonCodes(value) {
  const result = [];
  try {
    if (!Array.isArray(value)) return result;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0) return result;
    for (let index = 0; index < Math.min(length, MAX_QUARANTINE_REASON_CODES); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
      const code = descriptor.value;
      if (QUARANTINE_REASON_CODES.has(code) && !result.includes(code)) result.push(code);
    }
  } catch {
    // Adapter diagnostics are never allowed to turn into arbitrary report text.
  }
  return result;
}

function addIssue(report, index, outcome, reason) {
  if (outcome === 'duplicate') report.duplicateCount += 1;
  else if (outcome === 'review-needed' || outcome === 'review-required') report.reviewNeededCount += 1;
  else report.skippedCount += 1;
  report.skipReasons[reason] = (report.skipReasons[reason] || 0) + 1;
  if (report.issues.length < 32) report.issues.push({ index, outcome, reason });
}

function addManyIssues(report, start, count, outcome, reason) {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  if (outcome === 'duplicate') report.duplicateCount += count;
  else if (outcome === 'review-needed' || outcome === 'review-required') report.reviewNeededCount += count;
  else report.skippedCount += count;
  report.skipReasons[reason] = (report.skipReasons[reason] || 0) + count;
  const capacity = Math.max(0, 32 - report.issues.length);
  for (let offset = 0; offset < Math.min(count, capacity); offset += 1) {
    report.issues.push({ index: start + offset, outcome, reason });
  }
}

function skipRemaining(report, items, start, reason) {
  for (let index = start; index < items.length; index += 1) addIssue(report, items[index].index, 'skipped', reason);
}

function finish(report, status, reason) {
  report.status = status;
  report.reason = reason;
  return report;
}
