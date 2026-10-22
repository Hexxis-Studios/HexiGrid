import crypto from 'node:crypto';
import { validateMemoryProposal } from './dated-memory.mjs';
import { assertContinuitySafe } from './continuity-security.mjs';
import { assessMemoryWriteRisk } from './memory-risk.mjs';
import { memoryProposalServiceLimits } from './memory-proposal-service.mjs';
import { normalizeOwnerMemoryCaptureIntent } from './owner-memory-correction-service.mjs';

const PROPOSAL_KINDS = new Set(['create', 'correction', 'owner-memory-correction']);
const PROPOSAL_STATUSES = new Set(['pending', 'approved', 'rejected']);
const SOURCE_KINDS = new Set(['agent-link', 'dreaming-worker', 'owner-local']);
const RISK_REASON_CODES = new Set(['delayed_prompt_injection', 'high_confidence_ssn', 'payment_card_number',
  'unsupported_shape', 'input_too_large', 'write_spike']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const LINEAGE_ID = /^lineage-[0-9a-f-]{36}$/i;
const PROPOSAL_ID = /^memory-proposal-[0-9a-f-]{36}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ownerMemoryCaptureLocks = new Map();
const QUARANTINE_PAYLOAD_KEYS = new Set(['text', 'status', 'valid_while', 'valid_from', 'valid_until',
  'verify_by', 'evidence_excerpt', 'metadata', 'contextScope']);

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

function validIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function validIsoTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function normalizeQuarantine(record) {
  try {
    // Credential scanning precedes identity checks, normalization, and any
    // retained-state construction. Failures expose no candidate content.
    assertContinuitySafe(record);

    const provenance = record.provenance;
    if (!PROPOSAL_ID.test(String(record.id || '')) || !validIdentifier(record.agentId) ||
        !LINEAGE_ID.test(String(record.lineageId || '')) || !validIdentifier(record.callerId) ||
        !provenance || typeof provenance !== 'object' || Array.isArray(provenance) ||
        !isPlainRecord(provenance) ||
        !SOURCE_KINDS.has(provenance.kind) || provenance.agentId !== record.agentId ||
        provenance.callerId !== record.callerId) return null;
    const linked = provenance.kind === 'agent-link';
    if (linked) {
      if (!validIdentifier(record.linkId) || record.linkId !== record.callerId || provenance.linkId !== record.linkId) return null;
    } else if (record.linkId !== undefined || provenance.linkId !== undefined) return null;

    if (!validIsoTimestamp(record.createdAt) || !['pending', 'approved', 'rejected'].includes(record.status)) return null;
    if (record.status === 'rejected' && !validIsoTimestamp(record.resolvedAt)) return null;
    if (!SHA256.test(String(record.fingerprint || '')) || !SHA256.test(String(record.payloadDigest || '')) ||
        (record.idempotencyDigest !== undefined && !SHA256.test(String(record.idempotencyDigest)))) return null;

    if (!Array.isArray(record.riskReasonCodes) || record.riskReasonCodes.length < 1 || record.riskReasonCodes.length > 4 ||
        Array.from(record.riskReasonCodes).some(code => typeof code !== 'string' || !RISK_REASON_CODES.has(code)) ||
        new Set(record.riskReasonCodes).size !== record.riskReasonCodes.length) return null;
    const rawPayload = record.payload;
    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload) ||
        !isPlainRecord(rawPayload) ||
        Object.keys(rawPayload).some(key => !QUARANTINE_PAYLOAD_KEYS.has(key) && key !== 'memoryId')) return null;
    const payloadInput = Object.fromEntries(Object.entries(rawPayload).filter(([key]) => QUARANTINE_PAYLOAD_KEYS.has(key)));
    const payload = validateMemoryProposal(payloadInput);
    const payloadDigest = digest(stable(payload));
    if (payloadDigest !== record.payloadDigest) return null;

    const fingerprintPayload = { ...payload, memoryId: '' };
    const fingerprint = linked
      ? digest(JSON.stringify({ kind: 'create', linkId: record.linkId, payload: fingerprintPayload }))
      : digest(`${provenance.kind}\u0000${record.callerId}\u0000${stable(fingerprintPayload)}`);
    if (fingerprint !== record.fingerprint) return null;

    // Preserve prior quarantine reasons and add any findings from the current
    // classifier. A classifier update can add caution, never clear quarantine.
    const detected = assessMemoryWriteRisk({ text: payload.text, valid_while: payload.valid_while,
      evidence_excerpt: payload.evidence_excerpt, verify_by: payload.verify_by }).reasonCodes;
    const riskReasonCodes = [...new Set([...detected, ...record.riskReasonCodes])]
      .filter(code => RISK_REASON_CODES.has(code)).slice(0, 4);

    // An imported approved quarantine is reset to pending quarantine for
    // owner review. Its imported approval/commit metadata is never honored.
    const status = record.status === 'rejected' ? 'rejected' : 'pending';
    return {
      id: record.id,
      kind: 'risk-quarantine',
      agentId: record.agentId,
      lineageId: record.lineageId,
      ...(linked ? { linkId: record.linkId } : {}),
      callerId: record.callerId,
      provenance: { kind: provenance.kind, callerId: record.callerId, agentId: record.agentId,
        ...(linked ? { linkId: record.linkId } : {}) },
      status,
      createdAt: record.createdAt,
      resolvedAt: status === 'rejected' ? record.resolvedAt : null,
      fingerprint,
      ...(record.idempotencyDigest ? { idempotencyDigest: record.idempotencyDigest } : {}),
      payloadDigest,
      quarantined: true,
      riskReasonCodes,
      reviewRequired: true,
      commitState: 'quarantined',
      commitAttempts: 0,
      retryable: false,
      payload
    };
  } catch {
    return null;
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Recovery receipts have priority over disposable resolved proposal history.
 * A flag alone cannot enroll old/imported note history in mistake capture. */
function hasOwnerMemoryCaptureIntent(record) {
  if (record?.kind !== 'owner-memory-correction' || record.status !== 'approved' ||
      !['pending', 'discarded'].includes(record.ownerNoteCaptureState)) return false;
  try {
    const intent = normalizeOwnerMemoryCaptureIntent(record.ownerNoteCaptureIntent);
    return intent.agentId === record.agentId && intent.lineageId === record.lineageId &&
      intent.memoryId === record.payload?.memoryId && intent.source.linkId === record.linkId &&
      intent.expectedRevision === record.payload?.expectedRevision &&
      intent.correctedContent === record.payload?.text && intent.why === record.payload?.why &&
      intent.expectedNextBehavior === record.payload?.expectedNextBehavior &&
      stable(intent.source) === stable(record.payload?.source);
  } catch { return false; }
}

export function hasPendingOwnerMemoryCapture(record) {
  return record?.ownerNoteCaptureState === 'pending' &&
    record.ownerNoteCaptureDiscardedAt === undefined && hasOwnerMemoryCaptureIntent(record);
}

export function hasDiscardedOwnerMemoryCapture(record) {
  return record?.ownerNoteCaptureState === 'discarded' && hasOwnerMemoryCaptureIntent(record) &&
    (record.ownerNoteCaptureDiscardedAt === undefined || validIsoTimestamp(record.ownerNoteCaptureDiscardedAt));
}

/** Serialize capture retries and discard transitions for one retained proposal. */
export async function acquireOwnerMemoryCaptureLock(proposalId) {
  const key = String(proposalId || '');
  if (!PROPOSAL_ID.test(key)) throw new TypeError('Owner-note capture lock requires a proposal ID.');
  const previous = ownerMemoryCaptureLocks.get(key) || Promise.resolve();
  let unlock;
  const hold = new Promise(resolve => { unlock = resolve; });
  const tail = previous.then(() => hold);
  ownerMemoryCaptureLocks.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
    if (ownerMemoryCaptureLocks.get(key) === tail) ownerMemoryCaptureLocks.delete(key);
  };
}

/** Commit the terminal capture disposition and its content-free receipt together. */
export async function commitOwnerMemoryCaptureDiscard({ proposals, proposal, at, by, addReceipt, removeReceipt, saveState, receipt } = {}) {
  if (!Array.isArray(proposals) || typeof addReceipt !== 'function' || typeof removeReceipt !== 'function' ||
      typeof saveState !== 'function' || !validIsoTimestamp(at) || typeof by !== 'string' ||
      !/^(?:owner|agent-link):[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(by)) {
    throw new TypeError('Owner-note capture discard requires proposal, receipt and state-save adapters.');
  }
  if (hasDiscardedOwnerMemoryCapture(proposal)) return { status: 'already-discarded', proposal };
  const index = proposals.indexOf(proposal);
  if (index < 0 || !hasPendingOwnerMemoryCapture(proposal)) return { status: 'not-pending', proposal: null };
  const discarded = { ...proposal, ownerNoteCaptureState: 'discarded', ownerNoteCaptureDiscardedAt: at,
    ownerNoteCaptureDiscardedBy: by };
  proposals[index] = discarded;
  let receiptRecord = null;
  try {
    receiptRecord = addReceipt(receipt);
    if (!receiptRecord || typeof receiptRecord.id !== 'string') throw new Error('Owner-note discard receipt could not be created.');
    await saveState();
    return { status: 'discarded', proposal: discarded, receipt: receiptRecord };
  } catch (error) {
    if (proposals[index] === discarded) proposals[index] = proposal;
    if (receiptRecord) removeReceipt(receiptRecord);
    throw error;
  }
}

export function retainResolvedMemoryProposals(records, limit) {
  const entries = records.map((proposal, index) => ({ proposal, index }));
  const captures = entries.filter(({ proposal }) => hasPendingOwnerMemoryCapture(proposal)).slice(-limit);
  const historySlots = Math.max(0, limit - captures.length);
  const history = historySlots ? entries.filter(({ proposal }) => !hasPendingOwnerMemoryCapture(proposal)).slice(-historySlots) : [];
  return [...captures, ...history].sort((left, right) => left.index - right.index).map(({ proposal }) => proposal);
}

/**
 * Normalize both persisted startup state and imported backup proposal arrays.
 * Pending quarantine records get priority within the shared pending bound so
 * ordinary newer proposals cannot evict a pending forensic record by array order.
 */
export function normalizeMemoryProposalState(records) {
  if (!Array.isArray(records)) return [];
  const pendingLimit = memoryProposalServiceLimits.maxPending;
  const resolvedLimit = memoryProposalServiceLimits.maxResolved;
  const pendingQuarantines = [];
  const pendingOrdinary = [];
  const resolved = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const isQuarantine = record.kind === 'risk-quarantine' || record.quarantined === true;
    if (isQuarantine) {
      const proposal = normalizeQuarantine(record);
      if (!proposal) continue;
      const entry = { index, proposal };
      if (proposal.status === 'pending') pendingQuarantines.push(entry);
      else resolved.push(entry);
      continue;
    }
    if (typeof record.id !== 'string' || !PROPOSAL_KINDS.has(record.kind) ||
        !PROPOSAL_STATUSES.has(record.status) || typeof record.lineageId !== 'string' ||
        typeof record.agentId !== 'string') continue;
    const entry = { index, proposal: record };
    if (record.status === 'pending') pendingOrdinary.push(entry);
    else resolved.push(entry);
  }

  const selectedQuarantines = pendingQuarantines.slice(-pendingLimit);
  const ordinarySlots = Math.max(0, pendingLimit - selectedQuarantines.length);
  const selectedOrdinary = ordinarySlots ? pendingOrdinary.slice(-ordinarySlots) : [];
  const pending = [...selectedQuarantines, ...selectedOrdinary]
    .sort((left, right) => left.index - right.index).map(entry => entry.proposal);
  return pending.concat(retainResolvedMemoryProposals(resolved.map(entry => entry.proposal), resolvedLimit));
}
