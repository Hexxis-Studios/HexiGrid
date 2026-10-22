import crypto from 'node:crypto';
import { assertContinuitySafe } from './continuity-security.mjs';
import { assessMemoryWriteRisk } from './memory-risk.mjs';
import { assessAgentSkillRisk } from './agent-skills.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const LINEAGE_ID = /^lineage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKILL_ID = /^agent-skill-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUARANTINE_ID = /^agent-skill-quarantine-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_TEXT_FIELDS = Object.freeze(['name', 'whenToUse', 'procedure', 'successCheck']);
const DRAFT_FIELDS = Object.freeze([...DRAFT_TEXT_FIELDS, 'status']);
const DRAFT_LIMITS = Object.freeze({ name: 120, whenToUse: 1000, procedure: 8000, successCheck: 2000 });
const WHY_LIMIT = 500;
const RISK_REASONS = new Set(['delayed_prompt_injection', 'high_confidence_ssn', 'payment_card_number',
  'unsupported_shape', 'input_too_large', 'write_spike']);
const STATUSES = new Set(['pending', 'rejected']);
const RECORD_FIELDS = Object.freeze(['id', 'agentId', 'lineageId', 'linkId', 'draft', 'intent', 'riskReasonCodes',
  'status', 'createdAt', 'reviewHistory']);
const HISTORY_FIELDS = Object.freeze(['status', 'at', 'actorKind', 'actorId', 'reason']);
const MAX_PENDING = 100;
const MAX_RESOLVED = 100;

function fail(message, status = 400, code = 'invalid_agent_skill_quarantine') {
  return Object.assign(new Error(message), { status, code });
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyFields(value, allowed, label) {
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw fail(`${label} is invalid.`); }
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw fail(`${label} contains an unknown field.`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw fail(`${label} contains an accessor field.`);
  }
}

function requiredText(value, label, maxBytes) {
  if (typeof value !== 'string' || !value.trim()) throw fail(`${label} is required.`);
  const text = value.trim();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw fail(`${label} exceeds its UTF-8 byte limit.`);
  return text;
}

function safeReviewText(value, label, code) {
  const text = requiredText(value, label, WHY_LIMIT);
  try { assertContinuitySafe({ text }); }
  catch { throw fail(`${label} contains unsafe content.`, 400, code); }
  if (assessMemoryWriteRisk({ text }).disposition !== 'allow') {
    throw fail(`${label} contains unsafe content.`, 400, code);
  }
  return text;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw fail(`${label} is invalid.`);
  return value;
}

function lineage(value) {
  if (typeof value !== 'string' || !LINEAGE_ID.test(value)) throw fail('Continuity lineage ID is invalid.');
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw fail('Quarantine timestamp must be a valid UTC ISO timestamp.');
  }
  return value;
}

function normalizeScope(value) {
  if (!isRecord(value)) throw fail('Agent skill quarantine scope is required.');
  onlyFields(value, ['agentId', 'lineageId', 'linkId'], 'Agent skill quarantine scope');
  return {
    agentId: identifier(value.agentId, 'Agent ID'),
    lineageId: lineage(value.lineageId),
    linkId: identifier(value.linkId, 'Link ID')
  };
}

function normalizeDraft(value) {
  if (!isRecord(value)) throw fail('Agent skill draft must be an object.');
  onlyFields(value, DRAFT_FIELDS, 'Agent skill draft');
  const draft = Object.fromEntries(DRAFT_TEXT_FIELDS.map((field) =>
    [field, requiredText(value[field], `Skill ${field}`, DRAFT_LIMITS[field])]));
  const status = value.status ?? 'active';
  if (!['active', 'retired'].includes(status)) throw fail('Skill status is invalid.');
  draft.status = status;
  return draft;
}

function normalizeIntent(value) {
  if (!isRecord(value)) throw fail('Agent skill quarantine intent must be an object.');
  const allowed = ['operation', 'why', ...(value.operation === 'revise' ? ['skillId', 'expectedRevision'] : [])];
  onlyFields(value, allowed, 'Agent skill quarantine intent');
  const why = safeReviewText(value.why, 'Skill change reason', 'unsafe_agent_skill_quarantine_intent');
  if (value.operation === 'create') {
    return { operation: 'create', why };
  }
  if (value.operation !== 'revise') throw fail('Skill operation must be create or revise.');
  if (typeof value.skillId !== 'string' || !SKILL_ID.test(value.skillId)) throw fail('Revised skill ID is invalid.');
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) {
    throw fail('Expected skill revision must be a positive safe integer.');
  }
  return { operation: 'revise', skillId: value.skillId, expectedRevision: value.expectedRevision, why };
}

function detectedRisk(draft) {
  return assessAgentSkillRisk(draft);
}

function sameDraft(left, right) {
  return DRAFT_FIELDS.every((field) => left[field] === right[field]);
}

function sameIntent(left, right) {
  return left.operation === right.operation && left.why === right.why &&
    (left.operation === 'create' || (left.skillId === right.skillId && left.expectedRevision === right.expectedRevision));
}

function normalizeHistory(value, { status, createdAt, linkId }) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) throw fail('Quarantine review history is invalid.');
  const history = value.map((entry, index) => {
    if (!isRecord(entry)) throw fail('Quarantine review history entry is invalid.');
    onlyFields(entry, HISTORY_FIELDS, 'Quarantine review history entry');
    const eventStatus = entry.status;
    if (index === 0 && eventStatus !== 'pending') throw fail('Quarantine history must begin pending.');
    if (index === 1 && eventStatus !== 'rejected') throw fail('Quarantine history transition is invalid.');
    if (index > 0 && !['pending', 'rejected'].includes(eventStatus)) throw fail('Quarantine history status is invalid.');
    const actorKind = index === 0 ? 'agent-link' : 'owner';
    if (entry.actorKind !== actorKind) throw fail('Quarantine history actor is invalid.');
    const actorId = identifier(entry.actorId, 'Quarantine history actor ID');
    if (index === 0 && actorId !== linkId) throw fail('Quarantine submitter does not match its Link scope.');
    if (index === 1 && entry.status === 'pending') throw fail('Quarantine history cannot return to pending.');
    const at = timestamp(entry.at);
    if (index === 0 && Object.hasOwn(entry, 'reason')) throw fail('Submission history cannot contain a review reason.');
    if (index === 1) {
      const reason = safeReviewText(entry.reason, 'Owner decision reason', 'unsafe_agent_skill_quarantine_reason');
      return { status: eventStatus, at, actorKind, actorId, reason };
    }
    return { status: eventStatus, at, actorKind, actorId };
  });
  if (history[0].at !== createdAt || (history.length === 2 && history[1].at < history[0].at) ||
      history.at(-1).status !== status || (status === 'pending') !== (history.length === 1)) {
    throw fail('Quarantine status does not match its append-only history.');
  }
  return history;
}

function normalizeRecord(value) {
  if (!isRecord(value)) throw fail('Agent skill quarantine record must be an object.');
  onlyFields(value, RECORD_FIELDS, 'Agent skill quarantine record');
  if (typeof value.id !== 'string' || !QUARANTINE_ID.test(value.id)) throw fail('Agent skill quarantine ID is invalid.');
  const scope = normalizeScope({ agentId: value.agentId, lineageId: value.lineageId, linkId: value.linkId });
  const draft = normalizeDraft(value.draft);
  const intent = normalizeIntent(value.intent);
  if (!STATUSES.has(value.status)) throw fail('Agent skill quarantine status is invalid.');
  const createdAt = timestamp(value.createdAt);
  if (!Array.isArray(value.riskReasonCodes) || value.riskReasonCodes.length < 1 || value.riskReasonCodes.length > 6 ||
      value.riskReasonCodes.some((reason) => typeof reason !== 'string' || !RISK_REASONS.has(reason)) ||
      new Set(value.riskReasonCodes).size !== value.riskReasonCodes.length) {
    throw fail('Agent skill quarantine risk reasons are invalid.');
  }
  const reasons = [...new Set([...detectedRisk(draft).reasonCodes, ...value.riskReasonCodes])];
  if (!reasons.length || reasons.length > 6) throw fail('Agent skill quarantine must retain a risk reason.');
  return {
    id: value.id,
    ...scope,
    draft,
    intent,
    riskReasonCodes: reasons,
    status: value.status,
    createdAt,
    reviewHistory: normalizeHistory(value.reviewHistory, { status: value.status, createdAt, linkId: scope.linkId })
  };
}

function retainBounded(records) {
  const pending = records.filter((record) => record.status === 'pending').slice(-MAX_PENDING);
  const resolved = records.filter((record) => record.status !== 'pending').slice(-MAX_RESOLVED);
  const retained = new Set([...pending, ...resolved].map((record) => record.id));
  return records.filter((record) => retained.has(record.id));
}

/** Drop malformed imports and retain recent pending and resolved review records within fixed bounds. */
export function normalizeAgentSkillQuarantines(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw fail('Agent skill quarantines must be an array.');
  const valid = [];
  for (const item of value) {
    try { valid.push(normalizeRecord(item)); } catch { /* Malformed local records fail closed. */ }
  }
  const counts = new Map();
  for (const record of valid) counts.set(record.id, (counts.get(record.id) || 0) + 1);
  return retainBounded(valid.filter((record) => counts.get(record.id) === 1));
}

function copyRecord(record) {
  return normalizeRecord(record);
}

function authorizeOwner(authorize, callerIdentity, scope) {
  const identity = identifier(callerIdentity, 'Owner caller identity');
  let allowed;
  try { allowed = authorize(identity, Object.freeze({ ...scope })); }
  catch { throw fail('Owner authorization could not be verified.', 403, 'agent_skill_quarantine_owner_required'); }
  if (allowed && typeof allowed.then === 'function') {
    Promise.resolve(allowed).catch(() => {});
    throw fail('Owner authorization must complete synchronously.', 500, 'invalid_agent_skill_quarantine_authorization');
  }
  if (allowed !== true) throw fail('Owner authorization is required for skill quarantine review.', 403, 'agent_skill_quarantine_owner_required');
  return identity;
}

/** Local review queue. Owner review can reject drafts; this service never approves or writes canonical skills. */
export function createAgentSkillQuarantineService({ state, saveState, authorizeOwner: authorize, addReceipt, now = () => new Date().toISOString() } = {}) {
  if (!state || typeof saveState !== 'function' || typeof authorize !== 'function') {
    throw new TypeError('Agent skill quarantine requires state, persistence, and owner authorization adapters.');
  }
  state.agentSkillQuarantines = normalizeAgentSkillQuarantines(state.agentSkillQuarantines);

  async function submit({ scope: rawScope, draft: rawDraft, intent: rawIntent } = {}) {
    const scope = normalizeScope(rawScope);
    const draft = normalizeDraft(rawDraft);
    const intent = normalizeIntent(rawIntent);
    const risk = detectedRisk(draft);
    const prior = state.agentSkillQuarantines.find((record) => record.agentId === scope.agentId &&
      record.lineageId === scope.lineageId && record.linkId === scope.linkId && sameDraft(record.draft, draft) &&
      sameIntent(record.intent, intent));
    if (prior) return { created: false, status: prior.status, quarantineId: prior.id, reasonCodes: [...prior.riskReasonCodes] };
    if (risk.disposition !== 'quarantine') return { created: false, status: 'not-risky', reasonCodes: [] };
    if (state.agentSkillQuarantines.filter((record) => record.status === 'pending').length >= MAX_PENDING) {
      throw fail('The agent skill review queue is full.', 429, 'agent_skill_quarantine_queue_full');
    }
    const createdAt = timestamp(now());
    const record = {
      id: `agent-skill-quarantine-${crypto.randomUUID()}`,
      ...scope,
      draft,
      intent,
      riskReasonCodes: [...risk.reasonCodes],
      status: 'pending',
      createdAt,
      reviewHistory: [{ status: 'pending', at: createdAt, actorKind: 'agent-link', actorId: scope.linkId }]
    };
    const previous = state.agentSkillQuarantines;
    state.agentSkillQuarantines = normalizeAgentSkillQuarantines([...previous, record]);
    let receipt;
    try {
      if (addReceipt) receipt = addReceipt({ agentId: scope.agentId, action: 'agent-skill:quarantine', capability: 'self_modify',
        risk: 'high', status: 'pending-review', detail: 'One risky skill draft was saved for owner review. Skill text was excluded.', source: 'agent-skills' });
      await saveState();
    } catch (error) {
      state.agentSkillQuarantines = previous;
      if (receipt?.id && Array.isArray(state.receipts)) state.receipts = state.receipts.filter((item) => item.id !== receipt.id);
      throw error;
    }
    return { created: true, status: 'pending', quarantineId: record.id, reasonCodes: [...record.riskReasonCodes],
      ...(receipt?.id ? { receiptId: receipt.id } : {}) };
  }

  function list({ scope: rawScope, callerIdentity } = {}) {
    const scope = normalizeScope(rawScope);
    authorizeOwner(authorize, callerIdentity, scope);
    return state.agentSkillQuarantines.filter((record) => record.agentId === scope.agentId &&
      record.lineageId === scope.lineageId && record.linkId === scope.linkId).map(copyRecord);
  }

  async function resolve({ quarantineId, scope: rawScope, callerIdentity, decision, reason: rawReason } = {}) {
    const scope = normalizeScope(rawScope);
    const ownerIdentity = authorizeOwner(authorize, callerIdentity, scope);
    if (decision !== 'rejected') throw fail('Quarantine decision must be rejected.');
    const reason = safeReviewText(rawReason, 'Owner decision reason', 'unsafe_agent_skill_quarantine_reason');
    if (typeof quarantineId !== 'string' || !QUARANTINE_ID.test(quarantineId)) throw fail('Agent skill quarantine ID is invalid.');
    const index = state.agentSkillQuarantines.findIndex((record) => record.id === quarantineId &&
      record.agentId === scope.agentId && record.lineageId === scope.lineageId && record.linkId === scope.linkId);
    if (index < 0) throw fail('Agent skill quarantine record was not found in this exact scope.', 404, 'agent_skill_quarantine_not_found');
    const current = state.agentSkillQuarantines[index];
    if (current.status === decision) {
      return { changed: false, status: current.status, quarantineId: current.id };
    }
    if (current.status !== 'pending') throw fail('Agent skill quarantine already has a different terminal decision.', 409, 'agent_skill_quarantine_already_resolved');
    const at = timestamp(now());
    if (at < current.reviewHistory.at(-1).at) throw fail('Review timestamp precedes the pending quarantine.');
    const updated = {
      ...current,
      status: decision,
      reviewHistory: [...current.reviewHistory, { status: decision, at, actorKind: 'owner', actorId: ownerIdentity, reason }]
    };
    const previous = state.agentSkillQuarantines;
    state.agentSkillQuarantines = [...previous];
    state.agentSkillQuarantines[index] = updated;
    let receipt;
    try {
      if (addReceipt) receipt = addReceipt({ agentId: scope.agentId, action: 'agent-skill:quarantine-reject', capability: 'self_modify',
        risk: 'high', status: 'completed', detail: 'The authenticated owner rejected one quarantined skill draft. Skill text and review reason were excluded.', source: 'agent-skills' });
      await saveState();
    } catch (error) {
      state.agentSkillQuarantines = previous;
      if (receipt?.id && Array.isArray(state.receipts)) state.receipts = state.receipts.filter((item) => item.id !== receipt.id);
      throw error;
    }
    return { changed: true, status: updated.status, quarantineId: updated.id, ...(receipt?.id ? { receiptId: receipt.id } : {}) };
  }

  return Object.freeze({ submit, list, resolve });
}

export const agentSkillQuarantineLimits = Object.freeze({ maxPending: MAX_PENDING, maxResolved: MAX_RESOLVED,
  draftBytes: Object.freeze({ ...DRAFT_LIMITS }), whyBytes: WHY_LIMIT, decisionReasonBytes: WHY_LIMIT });
