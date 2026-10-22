import crypto from 'node:crypto';
import { validateMemoryProposal } from './dated-memory.mjs';
import { assertContinuitySafe } from './continuity-security.mjs';
import { assessMemoryWriteRisk } from './memory-risk.mjs';
import { hasPendingOwnerMemoryCapture, retainResolvedMemoryProposals } from './memory-proposal-state.mjs';
import { consumeMemoryWriteBudget } from './memory-write-budget.mjs';

const MAX_PENDING_PROPOSALS = 100;
const MAX_RESOLVED_PROPOSALS = 100;
const RISK_REASON_CODES = new Set(['delayed_prompt_injection', 'high_confidence_ssn', 'payment_card_number',
  'unsupported_shape', 'input_too_large', 'write_spike']);
const queues = new Map();
const fail = (message, status = 400, code = 'invalid_memory_proposal') => Object.assign(new Error(message), { status, code });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const pendingMemoryProposalCount = proposals => proposals.filter(item =>
  item.status === 'pending' || hasPendingOwnerMemoryCapture(item)).length;
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

function queueKey(source) {
  return `${source.lineageId}\u0000${source.agentId}`;
}

function serializeProposal(source, task) {
  const key = queueKey(source);
  const previous = queues.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(task);
  queues.set(key, operation);
  return operation.finally(() => { if (queues.get(key) === operation) queues.delete(key); });
}

function normalizeSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !['agent-link', 'dreaming-worker', 'owner-local'].includes(value.kind) ||
    typeof value.callerId !== 'string' || !value.callerId.trim() || value.callerId.length > 160 ||
    typeof value.agentId !== 'string' || !value.agentId.trim() || value.agentId.length > 160 ||
    typeof value.lineageId !== 'string' || !/^lineage-[0-9a-f-]{36}$/i.test(value.lineageId) ||
    (value.kind === 'agent-link' && (typeof value.linkId !== 'string' || !value.linkId.trim() || value.linkId.length > 160))) {
    throw fail('The memory proposal has no trusted caller provenance.', 400, 'invalid_memory_provenance');
  }
  return Object.freeze({ kind: value.kind, callerId: value.callerId.trim(), agentId: value.agentId,
    lineageId: value.lineageId, ...(value.kind === 'agent-link' ? { linkId: value.linkId } : {}),
    automatic: value.automatic === true || value.kind === 'dreaming-worker',
    policyReviewRequired: value.policyReviewRequired === true });
}

/**
 * Derive a dated-memory origin from the proposal service's host-retained
 * provenance. Call with persisted proposal.provenance, never request payload.
 */
export function memoryOriginKindFromTrustedProposalProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) ||
    !Object.hasOwn(provenance, 'kind')) return 'agent-proposal';
  return provenance.kind === 'dreaming-worker' ? 'automatic-learning' : 'agent-proposal';
}

function normalizeIdempotencyKey(value, required) {
  if (value === undefined || value === null || value === '') {
    if (required) throw fail('Automatic memory submissions require a stable idempotency key.', 400, 'idempotency_key_required');
    return '';
  }
  if (typeof value !== 'string' || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value)) {
    throw fail('The memory proposal idempotency key is invalid.', 400, 'invalid_idempotency_key');
  }
  return value;
}

function safeRetryCode(error) {
  const code = String(error?.code || '');
  return /^[A-Z0-9_]{1,48}$/.test(code) ? code : 'MEMORY_COMMIT_FAILED';
}

function authorizeSynchronously(authorize, context) {
  const result = authorize(context);
  if (result && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
    // Async authorization is unsupported, but consume a rejected Promise so a
    // fail-closed decision cannot also surface as an unhandled rejection.
    Promise.resolve(result).catch(() => {});
    throw fail('Memory proposal authorization must complete synchronously.', 500, 'invalid_memory_authorization');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
    (result.allowed !== true && result.allowed !== false) ||
    (result.autoCommit !== undefined && typeof result.autoCommit !== 'boolean')) {
    throw fail('Memory proposal authorization returned an invalid result.', 500, 'invalid_memory_authorization');
  }
  return result;
}

function pendingResult(proposal) {
  return { accepted: true, committed: false, proposalId: proposal.id,
    pendingOwnerReview: true, status: proposal.status,
    ...(proposal.retryable === true ? { retryable: true } : {}) };
}

function quarantinedResult(proposal) {
  const reasons = Array.isArray(proposal.riskReasonCodes)
    ? proposal.riskReasonCodes.filter(reason => RISK_REASON_CODES.has(reason)).slice(0, 4)
    : [];
  return { accepted: false, committed: false, quarantined: true, pendingOwnerReview: false,
    proposalId: proposal.id, status: 'quarantined', reasonCodes: reasons.length ? reasons : ['unsupported_shape'] };
}

function publicResult(proposal) {
  if (proposal.kind === 'risk-quarantine' || proposal.quarantined === true) return quarantinedResult(proposal);
  if (proposal.status === 'rejected') return { accepted: false, committed: false,
    proposalId: proposal.id, pendingOwnerReview: false, status: 'rejected' };
  if (proposal.status !== 'approved') return pendingResult(proposal);
  return { accepted: true, committed: true, proposalId: proposal.id,
    memoryId: proposal.payload.memoryId, verified: false, pendingOwnerReview: false,
    status: proposal.status, ...(proposal.committedRevisionId ? { revisionId: proposal.committedRevisionId } : {}) };
}

/**
 * Shared CREATE-memory proposal path. Caller provenance and authorization are
 * supplied by trusted local code; neither can be provided by memory text.
 * Corrections deliberately remain in their existing, revision-checked path.
 */
export function createMemoryProposalService({
  state, saveState, appendMemory, assertActive = async () => {}, authorize,
  now = () => new Date().toISOString()
} = {}) {
  if (!state || typeof saveState !== 'function' || typeof appendMemory !== 'function' || typeof authorize !== 'function') {
    throw new TypeError('The memory proposal service requires state, persistence, append, and authorization functions.');
  }

  async function submitCreate({ payload, source: rawSource, idempotencyKey, reviewRequired = false } = {}) {
    const source = normalizeSource(rawSource);
    if (typeof reviewRequired !== 'boolean') throw fail('The memory review flag must be a boolean.');
    const automatic = source.automatic;
    const requestKey = normalizeIdempotencyKey(idempotencyKey, automatic);
    if (payload && typeof payload === 'object' && Object.keys(payload).some(key =>
      !['text', 'status', 'valid_while', 'valid_from', 'valid_until', 'verify_by', 'evidence_excerpt', 'metadata', 'contextScope'].includes(key))) {
      throw fail('Memory proposal fields must use the validated create schema.');
    }
    const cleanPayload = validateMemoryProposal(payload);
    if (automatic && !cleanPayload.evidence_excerpt.trim()) {
      throw fail('Automatic memory submissions require an evidence excerpt.', 400, 'memory_evidence_required');
    }
    assertContinuitySafe(cleanPayload);
    // Credential-like input was rejected above. The risk classifier receives
    // only validated, bounded content fields and never the provenance envelope.
    let risk = assessMemoryWriteRisk({ text: cleanPayload.text, evidence_excerpt: cleanPayload.evidence_excerpt,
      valid_while: cleanPayload.valid_while, verify_by: cleanPayload.verify_by });
    const effectiveReviewRequired = reviewRequired || source.policyReviewRequired;
    const payloadDigest = digest(stable(cleanPayload));
    const idempotencyDigest = requestKey
      ? digest(`${source.kind}\u0000${source.callerId}\u0000${source.lineageId}\u0000${requestKey}`) : '';

    return serializeProposal(source, async () => {
      await assertActive({ source, action: 'memory-proposal-submit' });
      const submission = authorizeSynchronously(authorize, { source, phase: 'submit' });
      if (!submission || submission.allowed === false) throw fail(submission?.reason || 'The memory proposal is no longer authorized.', submission?.status || 403, 'memory_proposal_not_authorized');

      state.memoryProposals ||= [];
      let proposal = idempotencyDigest
        ? state.memoryProposals.find(item => item.idempotencyDigest === idempotencyDigest)
        : state.memoryProposals.find(item => item.fingerprint === digest(JSON.stringify({ kind: 'create',
          linkId: source.linkId, payload: { ...cleanPayload, memoryId: '' } })) && item.linkId === source.linkId &&
          item.agentId === source.agentId && item.lineageId === source.lineageId);
      if (!proposal && !idempotencyDigest) {
        const quarantineFingerprint = source.kind === 'agent-link'
          ? digest(JSON.stringify({ kind: 'create', linkId: source.linkId,
            payload: { ...cleanPayload, memoryId: '' } }))
          : digest(`${source.kind}\u0000${source.callerId}\u0000${stable({ ...cleanPayload, memoryId: '' })}`);
        proposal = state.memoryProposals.find(item => item.kind === 'risk-quarantine' && item.fingerprint === quarantineFingerprint &&
          item.agentId === source.agentId && item.lineageId === source.lineageId && item.callerId === source.callerId &&
          (item.linkId || '') === (source.linkId || ''));
      }
      if (proposal && (proposal.agentId !== source.agentId || proposal.lineageId !== source.lineageId ||
        (proposal.linkId || '') !== (source.linkId || ''))) {
        throw fail('This memory proposal retry does not match its original caller.', 409, 'memory_proposal_identity_conflict');
      }
      if (proposal && proposal.payloadDigest && proposal.payloadDigest !== payloadDigest) {
        throw fail('This idempotency key was already used for a different memory proposal.', 409, 'idempotency_key_conflict');
      }

      // A quarantine record is terminal for submission retries. Even if a
      // future classifier version changes its opinion, this route cannot turn
      // the forensic candidate into a normal owner-approvable proposal.
      if (proposal?.kind === 'risk-quarantine' || proposal?.quarantined === true) {
        return quarantinedResult(proposal);
      }

      // Exact retries are free. Distinct Link/worker submissions for the same
      // agent share an encrypted rolling budget, including after engine reload.
      if (!proposal && !consumeMemoryWriteBudget(state, { source,
        bytes: Buffer.byteLength(stable(cleanPayload), 'utf8'), at: Date.parse(now()) })) {
        risk = { disposition: 'quarantine', reasonCodes: ['write_spike', ...risk.reasonCodes].slice(0, 4) };
      }

      if (risk.disposition === 'quarantine') {
        if (proposal && proposal.status !== 'pending') {
          if (proposal.status === 'rejected') return publicResult(proposal);
          throw fail('This memory was committed before quarantine could be applied.', 409, 'memory_risk_prior_commit');
        }
        if (pendingMemoryProposalCount(state.memoryProposals) >= MAX_PENDING_PROPOSALS && !proposal) {
          throw fail('The owner memory review queue is full.', 429, 'memory_proposal_queue_full');
        }
        if (proposal) {
          proposal.kind = 'risk-quarantine';
          proposal.status = 'pending';
          proposal.payload = { ...cleanPayload };
          proposal.riskReasonCodes = [...risk.reasonCodes].slice(0, 4);
          proposal.quarantined = true;
          proposal.reviewRequired = true;
          proposal.commitState = 'quarantined';
          proposal.commitAttempts = 0;
          proposal.retryable = false;
          delete proposal.commitCreatedAt;
          delete proposal.nextRetryAt;
        } else {
          const timestamp = now();
          const fingerprint = source.kind === 'agent-link'
            ? digest(JSON.stringify({ kind: 'create', linkId: source.linkId,
              payload: { ...cleanPayload, memoryId: '' } }))
            : digest(`${source.kind}\u0000${source.callerId}\u0000${stable({ ...cleanPayload, memoryId: '' })}`);
          proposal = {
            id: `memory-proposal-${crypto.randomUUID()}`, kind: 'risk-quarantine', agentId: source.agentId,
            lineageId: source.lineageId, ...(source.linkId ? { linkId: source.linkId } : {}),
            callerId: source.callerId, provenance: { kind: source.kind, callerId: source.callerId,
              agentId: source.agentId, ...(source.linkId ? { linkId: source.linkId } : {}) },
            status: 'pending', createdAt: timestamp, resolvedAt: null, fingerprint,
            ...(idempotencyDigest ? { idempotencyDigest } : {}), payloadDigest,
            quarantined: true, riskReasonCodes: [...risk.reasonCodes].slice(0, 4),
            reviewRequired: true, commitState: 'quarantined', commitAttempts: 0,
            retryable: false, payload: { ...cleanPayload }
          };
          state.memoryProposals.push(proposal);
          state.memoryProposals = state.memoryProposals.filter(item => item.status === 'pending')
            .concat(retainResolvedMemoryProposals(state.memoryProposals.filter(item => item.status !== 'pending'), MAX_RESOLVED_PROPOSALS));
        }
        await saveState();
        await assertActive({ source, action: 'memory-proposal-submit' });
        const afterSave = authorizeSynchronously(authorize, { source, phase: 'submit', proposal });
        if (!afterSave || afterSave.allowed === false) throw fail(afterSave?.reason || 'The memory proposal is no longer authorized.', afterSave?.status || 403, 'memory_proposal_not_authorized');
        return quarantinedResult(proposal);
      }

      let created = false;
      if (!proposal) {
        if (pendingMemoryProposalCount(state.memoryProposals) >= MAX_PENDING_PROPOSALS) {
          throw fail('The owner memory review queue is full.', 429, 'memory_proposal_queue_full');
        }
        const timestamp = now();
        const payloadWithId = { ...cleanPayload, memoryId: `memory-${crypto.randomUUID()}` };
        const fingerprint = source.kind === 'agent-link'
          ? digest(JSON.stringify({ kind: 'create', linkId: source.linkId,
            payload: { ...payloadWithId, memoryId: '' } }))
          : digest(`${source.kind}\u0000${source.callerId}\u0000${stable(payloadWithId)}`);
        proposal = {
          id: `memory-proposal-${crypto.randomUUID()}`, kind: 'create', agentId: source.agentId,
          lineageId: source.lineageId, ...(source.linkId ? { linkId: source.linkId } : {}),
          callerId: source.callerId, provenance: { kind: source.kind, callerId: source.callerId,
            agentId: source.agentId, ...(source.linkId ? { linkId: source.linkId } : {}) },
          status: 'pending', createdAt: timestamp, resolvedAt: null, fingerprint,
          ...(idempotencyDigest ? { idempotencyDigest } : {}), payloadDigest,
          reviewRequired: effectiveReviewRequired,
          commitState: effectiveReviewRequired ? 'owner-review-required' : 'awaiting-review',
          commitAttempts: 0, retryable: false, payload: payloadWithId
        };
        state.memoryProposals.push(proposal);
        state.memoryProposals = state.memoryProposals.filter(item => item.status === 'pending')
          .concat(retainResolvedMemoryProposals(state.memoryProposals.filter(item => item.status !== 'pending'), MAX_RESOLVED_PROPOSALS));
        created = true;
        await saveState();
        // saveState() can yield while a Link is revoked or policy changes.
        await assertActive({ source, action: 'memory-proposal-submit' });
        const afterSave = authorizeSynchronously(authorize, { source, phase: 'submit', proposal });
        if (!afterSave || afterSave.allowed === false) throw fail(afterSave?.reason || 'The memory proposal is no longer authorized.', afterSave?.status || 403, 'memory_proposal_not_authorized');
      } else {
        // Upgrade old encrypted queue records in place without changing their
        // stable fingerprint, payload, or existing decision.
        proposal.payloadDigest ||= payloadDigest;
        proposal.callerId ||= source.callerId;
        proposal.provenance ||= { kind: source.kind, callerId: source.callerId,
          agentId: source.agentId, ...(source.linkId ? { linkId: source.linkId } : {}) };
        proposal.reviewRequired = proposal.reviewRequired === true || effectiveReviewRequired;
        proposal.commitAttempts = Number.isSafeInteger(proposal.commitAttempts) ? proposal.commitAttempts : 0;
        proposal.retryable = proposal.retryable === true;
        if (!proposal.commitState) proposal.commitState = proposal.status === 'approved' ? 'committed'
          : proposal.reviewRequired ? 'owner-review-required' : proposal.commitCreatedAt ? 'retryable' : 'awaiting-review';
        if (idempotencyDigest && !proposal.idempotencyDigest) proposal.idempotencyDigest = idempotencyDigest;
      }

      if (proposal.status !== 'pending') return publicResult(proposal);
      // This guard is intentionally structural: model output, an owner-trusted
      // Link, and a caller-provided false value cannot bypass a trusted review
      // decision already attached to the proposal.
      if (proposal.reviewRequired === true) {
        proposal.commitState = 'owner-review-required';
        proposal.retryable = false;
        if (!created) await saveState();
        return publicResult(proposal);
      }

      const initialCommitAuth = authorizeSynchronously(authorize, { source, phase: 'commit', proposal });
      if (!initialCommitAuth || initialCommitAuth.allowed === false || initialCommitAuth.autoCommit !== true) {
        if (!created && proposal.commitState !== 'awaiting-review') {
          proposal.commitState = 'awaiting-review'; proposal.retryable = false; await saveState();
        }
        return publicResult(proposal);
      }

      proposal.commitState = 'committing';
      proposal.commitCreatedAt ||= now();
      proposal.commitAttempts += 1;
      proposal.lastCommitAttemptAt = now();
      proposal.retryable = false;
      proposal.nextRetryAt = null;
      await saveState();
      // Recheck exact caller, current scope/grants, work mode and policy after
      // the durable intent write, immediately before canonical append.
      await assertActive({ source, action: 'memory-proposal-commit' });
      const beforeCommit = authorizeSynchronously(authorize, { source, phase: 'commit', proposal });
      if (!beforeCommit || beforeCommit.allowed === false || beforeCommit.autoCommit !== true) {
        proposal.commitState = 'awaiting-review'; proposal.retryable = false;
        proposal.lastCommitErrorCode = 'AUTHORIZATION_CHANGED';
        await saveState();
        return publicResult(proposal);
      }

      let committed;
      try {
        // No await or external work occurs between this final check and the
        // append invocation. appendMemory must be idempotent on memoryId.
        const finalAuthorization = authorizeSynchronously(authorize, { source, phase: 'commit', proposal });
        if (!finalAuthorization || finalAuthorization.allowed === false || finalAuthorization.autoCommit !== true) {
          proposal.commitState = 'awaiting-review'; proposal.retryable = false;
          proposal.lastCommitErrorCode = 'AUTHORIZATION_CHANGED';
          await saveState();
          return publicResult(proposal);
        }
        committed = await appendMemory({ lineageId: proposal.lineageId, agentId: proposal.agentId,
          createdAt: proposal.commitCreatedAt, id: proposal.payload.memoryId, text: proposal.payload.text,
          status: proposal.payload.status, valid_while: proposal.payload.valid_while,
          ...(proposal.payload.valid_from === undefined ? {} : { valid_from: proposal.payload.valid_from }),
          ...(proposal.payload.valid_until === undefined ? {} : { valid_until: proposal.payload.valid_until }),
          verify_by: proposal.payload.verify_by, evidence_excerpt: proposal.payload.evidence_excerpt,
          metadata: proposal.payload.metadata, contextScope: proposal.payload.contextScope,
          originKind: memoryOriginKindFromTrustedProposalProvenance(proposal.provenance) });
        await assertActive({ source, action: 'memory-proposal-commit' });
        const afterAppend = authorizeSynchronously(authorize, { source, phase: 'commit-result', proposal });
        if (!afterAppend || afterAppend.allowed === false || afterAppend.autoCommit !== true) {
          proposal.commitState = 'retryable'; proposal.retryable = true;
          proposal.lastCommitErrorCode = 'AUTHORIZATION_CHANGED_AFTER_APPEND';
          proposal.nextRetryAt = null;
          await saveState();
          return publicResult(proposal);
        }
      } catch (error) {
        proposal.commitState = 'retryable'; proposal.retryable = true;
        proposal.commitRetryCount = Math.min(1000, (Number(proposal.commitRetryCount) || 0) + 1);
        const retryDelayMs = Math.min(300_000, 5_000 * (2 ** Math.min(6, proposal.commitRetryCount - 1)));
        proposal.nextRetryAt = new Date(Date.parse(now()) + retryDelayMs).toISOString();
        proposal.lastCommitErrorCode = safeRetryCode(error);
        // Keep details and fact text out of receipts and public errors. The
        // durable proposal and stable memory ID make an explicit retry safe.
        await saveState();
        return { ...pendingResult(proposal), error: 'Memory commit could not complete; retry the same proposal later.' };
      }

      proposal.status = 'approved'; proposal.resolvedAt = now();
      proposal.decidedBy = source.kind === 'agent-link' ? 'policy:owner-trusted-link' : `policy:${source.kind}`;
      proposal.autoCommitted = true; proposal.retryable = false; proposal.commitState = 'committed';
      proposal.lastCommitErrorCode = '';
      proposal.committedRevisionId = committed?.revisionId || null;
      proposal.committedDate = committed?.entry?.date || committed?.date || null;
      await saveState();
      return publicResult(proposal);
    });
  }

  return Object.freeze({ submitCreate });
}

export const memoryProposalServiceLimits = Object.freeze({ maxPending: MAX_PENDING_PROPOSALS, maxResolved: MAX_RESOLVED_PROPOSALS });
