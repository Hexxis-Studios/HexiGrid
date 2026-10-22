import crypto from 'node:crypto';
import { assertContinuitySafe } from './continuity-security.mjs';
import { assessMemoryWriteRisk } from './memory-risk.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SKILL_ID = new RegExp(`^agent-skill-${UUID}$`);
const LINEAGE_ID = new RegExp(`^lineage-${UUID}$`);
const SNAPSHOT_FIELDS = Object.freeze(['name', 'whenToUse', 'procedure', 'successCheck', 'status']);
const REVISION_FIELDS = Object.freeze(['revision', ...SNAPSHOT_FIELDS, 'by', 'why', 'at']);
const RECORD_FIELDS = Object.freeze(['id', 'agentId', 'lineageId', 'revisions']);
const TEXT_LIMITS = Object.freeze({ name: 120, whenToUse: 1000, procedure: 8000, successCheck: 2000, by: 160, why: 500 });

export const AGENT_SKILL_STATUSES = Object.freeze(['active', 'retired']);

function recordObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function onlyFields(value, allowed, label) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${label} contains an unknown field.`);
}

function textField(value, label, maxBytes) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  const text = value.trim();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
  return text;
}

function identity(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function agentIdentity(value) {
  const id = textField(value, 'Agent ID', 160);
  if (id !== value || /[\u0000-\u001f\u007f]/u.test(id)) throw new Error('Agent ID is invalid.');
  return id;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Revision timestamp must be a valid UTC ISO timestamp.');
  }
  return value;
}

function status(value) {
  if (!AGENT_SKILL_STATUSES.includes(value)) throw new Error('Agent skill status is invalid.');
  return value;
}

export function assessAgentSkillRisk(value) {
  return assessMemoryWriteRisk({ text: JSON.stringify({
    name: value.name,
    whenToUse: value.whenToUse,
    procedure: value.procedure,
    successCheck: value.successCheck,
    status: value.status
  }) });
}

function rejectRiskySnapshot(value) {
  const risk = assessAgentSkillRisk(value);
  if (risk.disposition === 'allow') return;
  const error = new Error('Agent skill content is quarantined by the local memory risk gate.');
  error.code = 'AGENT_SKILL_QUARANTINED';
  error.status = 422;
  error.reasonCodes = risk.reasonCodes;
  throw error;
}

function snapshot(value, { rejectRisk = false } = {}) {
  const result = {
    name: textField(value.name, 'Skill name', TEXT_LIMITS.name),
    whenToUse: textField(value.whenToUse, 'When to use', TEXT_LIMITS.whenToUse),
    procedure: textField(value.procedure, 'Procedure', TEXT_LIMITS.procedure),
    successCheck: textField(value.successCheck, 'Success check', TEXT_LIMITS.successCheck),
    status: status(value.status)
  };
  assertContinuitySafe(result);
  if (rejectRisk) rejectRiskySnapshot(result);
  return result;
}

function revisionTrust(by) {
  if (by.startsWith('agent-link:')) return {
    provenance: 'agent-link',
    verification: 'unverified',
    warning: '[UNVERIFIED AGENT SKILL — owner review required]'
  };
  if (by.startsWith('owner:')) return {
    provenance: 'authenticated-owner',
    verification: 'owner-confirmed',
    warning: ''
  };
  return {
    provenance: 'legacy-or-unspecified',
    verification: 'unverified',
    warning: '[UNVERIFIED SKILL SOURCE — verify before acting]'
  };
}

function revisionMetadata({ by, why, at }) {
  const result = {
    by: textField(by, 'Revision authorizer', TEXT_LIMITS.by),
    why: textField(why, 'Revision reason', TEXT_LIMITS.why),
    at: timestamp(at)
  };
  assertContinuitySafe(result);
  return result;
}

function sameSnapshot(left, right) {
  return SNAPSHOT_FIELDS.every((field) => left[field] === right[field]);
}

/** Validate a stored skill and return a detached canonical copy without discarding history. */
export function normalizeAgentSkill(value) {
  const record = recordObject(value, 'Agent skill');
  onlyFields(record, RECORD_FIELDS, 'Agent skill');
  const id = identity(record.id, 'Agent skill ID', SKILL_ID);
  const agentId = agentIdentity(record.agentId);
  const lineageId = identity(record.lineageId, 'Continuity lineage ID', LINEAGE_ID);
  if (!Array.isArray(record.revisions) || !record.revisions.length) throw new Error('Agent skill history is required.');
  const revisions = [];
  for (const [index, raw] of record.revisions.entries()) {
    const entry = recordObject(raw, 'Agent skill revision');
    onlyFields(entry, REVISION_FIELDS, 'Agent skill revision');
    if (entry.revision !== index + 1) throw new Error('Agent skill revision history is out of sequence.');
    const normalized = { revision: entry.revision, ...snapshot(entry), ...revisionMetadata(entry) };
    if (revisions.length && sameSnapshot(revisions.at(-1), normalized)) throw new Error('Agent skill history contains a no-op revision.');
    if (revisions.length && normalized.at < revisions.at(-1).at) throw new Error('Agent skill revision timestamps are out of order.');
    revisions.push(normalized);
  }
  return { id, agentId, lineageId, revisions };
}

/** Missing persisted state migrates to an empty collection; malformed records fail closed. */
export function normalizeAgentSkills(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Agent skills must be an array.');
  const seen = new Set();
  return Array.from(value, (record) => {
    const normalized = normalizeAgentSkill(record);
    if (seen.has(normalized.id)) throw new Error('Duplicate agent skill ID.');
    seen.add(normalized.id);
    return normalized;
  });
}

/** Create an agent and continuity scoped skill with revision 1. */
export function createAgentSkill(input, { agentId, lineageId, by, why, at } = {}) {
  const draft = recordObject(input, 'Agent skill draft');
  onlyFields(draft, SNAPSHOT_FIELDS, 'Agent skill draft');
  const initial = { ...draft, status: draft.status ?? 'active' };
  return {
    id: `agent-skill-${crypto.randomUUID()}`,
    agentId: agentIdentity(agentId),
    lineageId: identity(lineageId, 'Continuity lineage ID', LINEAGE_ID),
    revisions: [{ revision: 1, ...snapshot(initial, { rejectRisk: true }), ...revisionMetadata({ by, why, at }) }]
  };
}

/** Append a full snapshot only when the caller holds the current revision and scope. */
export function reviseAgentSkill(value, patch, { expectedRevision, agentId, lineageId, by, why, at } = {}) {
  const record = normalizeAgentSkill(value);
  if (agentIdentity(agentId) !== record.agentId || identity(lineageId, 'Continuity lineage ID', LINEAGE_ID) !== record.lineageId) {
    throw new Error('Agent skill scope does not match its agent and continuity lineage.');
  }
  const current = record.revisions.at(-1);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision !== current.revision) {
    const error = new Error('Agent skill revision conflict: expectedRevision is stale or invalid.');
    error.code = 'AGENT_SKILL_REVISION_CONFLICT';
    error.status = 409;
    throw error;
  }
  const changes = recordObject(patch, 'Agent skill patch');
  onlyFields(changes, SNAPSHOT_FIELDS, 'Agent skill patch');
  const next = snapshot({ ...current, ...changes }, { rejectRisk: true });
  if (sameSnapshot(current, next)) throw new Error('Agent skill revision must change at least one field.');
  const metadata = revisionMetadata({ by, why, at });
  if (metadata.at < current.at) throw new Error('Agent skill revision timestamp precedes the current revision.');
  return { ...record, revisions: [...record.revisions, { revision: current.revision + 1, ...next, ...metadata }] };
}

/** Return a compact, current-state view while keeping history on the stored record. */
export function currentAgentSkill(value) {
  const record = normalizeAgentSkill(value);
  const current = record.revisions.at(-1);
  const risk = assessAgentSkillRisk(current);
  const trust = revisionTrust(current.by);
  const quarantined = risk.disposition === 'quarantine';
  return {
    id: record.id,
    agentId: record.agentId,
    lineageId: record.lineageId,
    revision: current.revision,
    name: current.name,
    whenToUse: current.whenToUse,
    procedure: current.procedure,
    successCheck: current.successCheck,
    status: quarantined && current.status === 'active' ? 'quarantined' : current.status,
    provenance: trust.provenance,
    verification: trust.verification,
    warning: quarantined
      ? '[QUARANTINED SKILL — excluded from current guidance; owner review required]'
      : trust.warning,
    riskReasonCodes: risk.reasonCodes,
    createdAt: record.revisions[0].at,
    updatedAt: current.at
  };
}

/** Read complete historical snapshots in descending revision order. Cursor is exclusive. */
export function pageAgentSkillRevisions(value, { beforeRevision, limit = 10 } = {}) {
  const record = normalizeAgentSkill(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Agent skill revision page limit must be 1 to 20.');
  if (beforeRevision !== undefined && (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1 || beforeRevision > record.revisions.length + 1)) {
    throw new Error('Agent skill revision cursor must be a valid positive revision.');
  }
  const end = beforeRevision === undefined ? record.revisions.length : beforeRevision - 1;
  const start = Math.max(0, end - limit);
  const revisions = record.revisions.slice(start, end).reverse().map((revision) => {
    const risk = assessAgentSkillRisk(revision);
    return {
      ...revision,
      ...revisionTrust(revision.by),
      riskReasonCodes: risk.reasonCodes,
      ...(risk.disposition === 'quarantine' ? {
        guidanceEligible: false,
        warning: '[QUARANTINED SKILL VERSION — historical content is not current guidance]'
      } : { guidanceEligible: true })
    };
  });
  const hasMore = start > 0;
  return { revisions, nextBeforeRevision: hasMore ? revisions.at(-1).revision : null, hasMore };
}

/** List skills only for one bound agent and continuity lineage. */
export function listAgentSkills(records, { agentId, lineageId, includeRetired = false } = {}) {
  const selectedAgentId = agentIdentity(agentId);
  const selectedLineageId = identity(lineageId, 'Continuity lineage ID', LINEAGE_ID);
  if (typeof includeRetired !== 'boolean') throw new Error('includeRetired must be a boolean.');
  return normalizeAgentSkills(records)
    .filter((record) => record.agentId === selectedAgentId && record.lineageId === selectedLineageId)
    .map(currentAgentSkill)
    .filter((view) => includeRetired || view.status === 'active');
}
