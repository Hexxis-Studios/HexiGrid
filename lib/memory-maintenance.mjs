import crypto from 'node:crypto';
import { memoryStaleness } from './memory-staleness.mjs';
import { assessMemoryWriteRisk } from './memory-risk.mjs';
import { stableContinuityJson } from './continuity-transfer.mjs';
import { normalizeOwnerMemory } from './owner-memory.mjs';

const ID = /^memory-[a-f0-9-]{36}$/i;
const NOTE_CURSOR = /^note:([A-Za-z0-9_-]{1,342})$/;
const LINEAGE = /^lineage-[a-f0-9-]{36}$/i;
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REASONS = new Set(['stale', 'disputed', 'recorded-conflict', 'suspicious-content', 'unconfirmed-anchor', 'inactive-anchor', 'invalid-provenance']);
export const memoryMaintenanceLimits = Object.freeze({ intervalMs: 6 * 60 * 60 * 1000, records: 2000, issues: 30 });

function safeOwnerNoteId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function memoryHealthCursor(record) {
  return record.memoryStore === 'notes' ? `note:${Buffer.from(record.id, 'utf8').toString('base64url')}` : record.id;
}

function memoryHealthCursorTarget(value) {
  if (ID.test(value || '')) return { id: value, store: 'facts' };
  const match = NOTE_CURSOR.exec(String(value || ''));
  if (!match) return null;
  try {
    const id = Buffer.from(match[1], 'base64url').toString('utf8');
    if (!safeOwnerNoteId(id) || Buffer.from(id, 'utf8').toString('base64url') !== match[1]) return null;
    return { id, store: 'notes' };
  } catch { return null; }
}

export function isMemoryHealthCursor(value) { return Boolean(memoryHealthCursorTarget(value)); }

/** A structural consistency report, never an automatic truth/identity verdict. */
export function inspectMemoryHealth({ records, ownerNotes = [], agentId, lineageId, previous, after, now = Date.now() }) {
  if (!Array.isArray(records) || !Array.isArray(ownerNotes) || !AGENT.test(agentId || '') || !LINEAGE.test(lineageId || '') || !Number.isFinite(now)) {
    throw new Error('Memory health request is invalid.');
  }
  if (records.some(record => record?.lineageId !== lineageId)) throw new Error('Memory health lineage does not match.');
  const notes = ownerNotes.filter(note => note?.agentId === agentId).map(note => {
    const id = typeof note?.id === 'string' ? note.id : '';
    if (!safeOwnerNoteId(id)) throw new Error('Memory health owner-note identity is invalid.');
    try {
      const normalized = normalizeOwnerMemory(note);
      if (typeof normalized.content !== 'string') throw new Error('Owner note content is invalid.');
      return { id, lineageId, agentId, revision: normalized.revisions.length, text: normalized.content,
        status: normalized.status, verification: normalized.verification, createdAt: normalized.createdAt,
        updatedAt: normalized.updatedAt, valid_while: normalized.valid_while, verify_by: normalized.verify_by,
        evidence_excerpt: normalized.evidence_excerpt, metadata: { category: String(normalized.category).trim().toLowerCase() },
        memoryStore: 'notes' };
    } catch {
      return { id, lineageId, agentId, revision: Array.isArray(note.revisions) ? note.revisions.length : 0,
        text: '', status: 'historical', verification: 'unverified', memoryStore: 'notes', invalidProvenance: true };
    }
  });
  const ordered = [...records, ...notes].sort((left, right) => String(left.id).localeCompare(String(right.id)) ||
    String(left.memoryStore || 'facts').localeCompare(String(right.memoryStore || 'facts')));
  const identities = ordered.map(record => `${record.memoryStore || 'facts'}\0${record.id}`);
  if (new Set(identities).size !== identities.length) throw new Error('Memory health IDs are ambiguous within a store.');
  const cursorTarget = after === undefined ? null : memoryHealthCursorTarget(after);
  const offset = cursorTarget ? ordered.findIndex(record => record.id === cursorTarget.id &&
    (record.memoryStore === 'notes' ? 'notes' : 'facts') === cursorTarget.store) + 1 : 0;
  if (after !== undefined && (!cursorTarget || offset === 0)) throw new Error('Memory health cursor is stale.');
  const selected = ordered.slice(offset, offset + memoryMaintenanceLimits.records);
  const nextCursor = offset + selected.length < ordered.length ? memoryHealthCursor(selected.at(-1)) : null;
  const sourceVersion = crypto.createHash('sha256').update(stableContinuityJson(ordered.map(record =>
    [record.id, record.memoryStore || 'facts', record.revision, record.updatedAt, record.status, record.text,
      record.valid_while, record.verify_by, record.verification, record.conflicts, record.invalidProvenance === true]))).digest('hex');
  const counts = Object.fromEntries([...REASONS].map(reason => [reason, 0]));
  const issues = [];
  const anchors = ordered.filter(record => record.identityAnchor === true).map(record => ({ id: record.id,
    revision: record.revision, text: record.text, status: record.status, verification: record.verification,
    valid_while: record.valid_while, valid_from: record.valid_from, valid_until: record.valid_until }));
  let anchorReviewCount = 0;
  let issueCount = 0;
  for (const record of selected) {
    if (record.memoryStore === 'notes' ? !safeOwnerNoteId(record.id) : !ID.test(record.id || '')) continue;
    const current = ['active', 'conditional'].includes(record.status);
    const reasons = [];
    if (record.invalidProvenance) reasons.push('invalid-provenance');
    if (current && memoryStaleness(record, now).stale) reasons.push('stale');
    if (record.status === 'disputed') reasons.push('disputed');
    if ((current || record.status === 'disputed') && record.conflicts?.length) reasons.push('recorded-conflict');
    if ((current || record.status === 'disputed') && assessMemoryWriteRisk({ text: record.text,
      valid_while: record.valid_while || '', evidence_excerpt: record.evidence_excerpt || '' }).disposition === 'quarantine') {
      reasons.push('suspicious-content');
    }
    if (record.identityAnchor === true) {
      if (record.verification !== 'owner-confirmed') reasons.push('unconfirmed-anchor');
      const start = record.valid_from && Date.parse(record.valid_from);
      const end = record.valid_until && Date.parse(record.valid_until);
      if (!current || start && start > now || end && end <= now) reasons.push('inactive-anchor');
      if (reasons.length) anchorReviewCount++;
    }
    for (const reason of reasons) counts[reason]++;
    if (reasons.length) {
      issueCount++;
      if (issues.length < memoryMaintenanceLimits.issues) issues.push({ memoryId: record.id,
        store: record.memoryStore === 'notes' ? 'notes' : 'facts', reasons });
    }
  }
  anchors.sort((left, right) => left.id.localeCompare(right.id));
  const anchorFingerprint = crypto.createHash('sha256').update(stableContinuityJson(anchors)).digest('hex');
  const baseline = previous?.agentId === agentId && previous.lineageId === lineageId &&
    /^[a-f0-9]{64}$/.test(previous.anchorFingerprint || '') ? previous : null;
  const changed = Boolean(baseline && baseline.anchorFingerprint !== anchorFingerprint);
  const incomplete = Boolean(nextCursor);
  return { agentId, lineageId, checkedAt: new Date(now).toISOString(), scanned: selected.length, total: ordered.length,
    incomplete, nextCursor, sourceVersion, anchorReviewCount, counts, issues, omittedIssues: Math.max(0, issueCount - issues.length),
    anchors: { count: anchors.length, baselineAvailable: Boolean(baseline), changed,
      lastChangedAt: changed ? new Date(now).toISOString() : previous?.anchors?.lastChangedAt || null,
      status: incomplete ? 'incomplete' : !anchors.length ? 'not-configured' : anchorReviewCount ? 'needs-review' : 'consistent' },
    anchorFingerprint, status: incomplete ? 'incomplete' : issues.length || changed ? 'review-needed' : 'checked',
    note: 'Checks recorded standing, deadlines, explicit conflicts and known risk patterns. It does not prove facts true or verify a model\'s internal identity. Conditions still require verification.' };
}

export function publicMemoryHealth(report) {
  if (!report) return null;
  const { anchorFingerprint, sourceVersion, ...safe } = report;
  return safe;
}

export function normalizeMemoryMaintenanceReports(reports) {
  if (!Array.isArray(reports)) return [];
  const retained = new Map();
  for (const value of reports) {
    if (!value || !AGENT.test(value.agentId || '') || !LINEAGE.test(value.lineageId || '') ||
      !/^[a-f0-9]{64}$/.test(value.anchorFingerprint || '') ||
      !Number.isFinite(Date.parse(value.checkedAt || '')) || !Array.isArray(value.issues) ||
      value.issues.length > memoryMaintenanceLimits.issues ||
      !Number.isSafeInteger(value.scanned) || value.scanned < 0 ||
      !Number.isSafeInteger(value.total) || value.total < value.scanned ||
      !['checked', 'review-needed', 'incomplete'].includes(value.status)) continue;
    const counts = Object.fromEntries([...REASONS].map(reason => [reason,
      Number.isSafeInteger(value.counts?.[reason]) && value.counts[reason] >= 0 ? Math.min(value.counts[reason], value.scanned) : 0]));
    const issues = value.issues.filter(issue => (issue?.store === 'notes' ? safeOwnerNoteId(issue.memoryId) : ID.test(issue?.memoryId || '')) && Array.isArray(issue.reasons) &&
      issue.reasons.length && issue.reasons.every(reason => REASONS.has(reason)))
      .map(issue => ({ memoryId: issue.memoryId, store: issue.store === 'notes' ? 'notes' : 'facts', reasons: [...new Set(issue.reasons)] }));
    retained.set(`${value.agentId}\0${value.lineageId}`, { agentId: value.agentId, lineageId: value.lineageId,
      checkedAt: new Date(value.checkedAt).toISOString(), scanned: value.scanned, total: value.total,
      incomplete: value.incomplete === true, counts, issues, status: value.status,
      nextCursor: isMemoryHealthCursor(value.nextCursor) ? value.nextCursor : null,
      sourceVersion: /^[a-f0-9]{64}$/.test(value.sourceVersion || '') ? value.sourceVersion : '',
      anchorReviewCount: Number.isSafeInteger(value.anchorReviewCount) ? Math.max(0, value.anchorReviewCount) : 0,
      omittedIssues: Number.isSafeInteger(value.omittedIssues) ? Math.max(0, value.omittedIssues) : 0,
      anchors: { count: Number.isSafeInteger(value.anchors?.count) ? Math.max(0, Math.min(value.anchors.count, value.total)) : 0,
        baselineAvailable: value.anchors?.baselineAvailable === true, changed: value.anchors?.changed === true,
        lastChangedAt: Number.isFinite(Date.parse(value.anchors?.lastChangedAt || '')) ? new Date(value.anchors.lastChangedAt).toISOString() : null,
        status: ['consistent', 'needs-review', 'incomplete', 'not-configured'].includes(value.anchors?.status) ? value.anchors.status : 'incomplete' },
      anchorFingerprint: value.anchorFingerprint });
  }
  return [...retained.values()];
}

/** Called by the existing idle scheduler; owns no timer and never edits facts. */
export async function runMemoryMaintenance({ state, store, saveState, eligible, isIdle, now = Date.now() }) {
  if (!isIdle()) return { status: 'deferred' };
  const reports = normalizeMemoryMaintenanceReports(state.memoryMaintenanceReports);
  const agent = (state.agents || []).find(agent => eligible(agent) && !reports.some(report =>
    report.agentId === agent.id && report.lineageId === agent.continuityLineage?.id &&
    !report.nextCursor && Date.parse(report.checkedAt) > now - memoryMaintenanceLimits.intervalMs));
  if (!agent) return { status: 'idle' };
  const lineageId = agent.continuityLineage.id;
  const previous = reports.find(report => report.agentId === agent.id && report.lineageId === lineageId);
  const records = await store.readRange({ lineageId, from: '0001-01-01', to: '9999-12-31', depth: 0 });
  const ownerNotes = state.memories || [];
  if (!isIdle() || !state.agents.includes(agent) || agent.continuityLineage.id !== lineageId || !eligible(agent)) return { status: 'deferred' };
  let report;
  if (previous?.nextCursor) {
    try { report = inspectMemoryHealth({ records, ownerNotes, agentId: agent.id, lineageId, previous, after: previous.nextCursor, now }); }
    catch { /* A changed corpus restarts the scan; no old totals are reused. */ }
  }
  if (!report || report.sourceVersion !== previous?.sourceVersion && previous?.nextCursor) {
    report = inspectMemoryHealth({ records, ownerNotes, agentId: agent.id, lineageId, previous, now });
  } else if (previous?.nextCursor) {
    const allIssues = [...previous.issues, ...report.issues];
    report.scanned += previous.scanned;
    report.anchorReviewCount += previous.anchorReviewCount;
    report.anchors.changed ||= previous.anchors.changed;
    report.anchors.lastChangedAt ||= previous.anchors.lastChangedAt;
    report.omittedIssues += previous.omittedIssues + Math.max(0, allIssues.length - memoryMaintenanceLimits.issues);
    report.issues = allIssues.slice(0, memoryMaintenanceLimits.issues);
    for (const reason of REASONS) report.counts[reason] += previous.counts[reason];
    report.incomplete = Boolean(report.nextCursor);
    report.anchors.status = report.incomplete ? 'incomplete' : !report.anchors.count ? 'not-configured' : report.anchorReviewCount ? 'needs-review' : 'consistent';
    report.status = report.incomplete ? 'incomplete' : report.issues.length || report.anchors.changed ? 'review-needed' : 'checked';
  }
  const prior = state.memoryMaintenanceReports;
  state.memoryMaintenanceReports = reports.filter(row => row.agentId !== agent.id).concat(report);
  try { await saveState(); }
  catch (error) { state.memoryMaintenanceReports = prior; throw error; }
  return { status: 'checked', agentId: agent.id };
}
