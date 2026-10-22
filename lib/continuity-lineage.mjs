import crypto from 'node:crypto';

const clean = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const stamp = (value) => Number.isFinite(Date.parse(String(value || ''))) ? new Date(value).toISOString() : null;

export function newLineageId() {
  return `lineage-${crypto.randomUUID()}`;
}

export function normalizeContinuityLineage(value = {}, { agentId = '', now = new Date().toISOString() } = {}) {
  const id = /^lineage-[0-9a-f-]{36}$/i.test(String(value.id || '')) ? String(value.id).toLowerCase() : newLineageId();
  const memorySyncState = ['awaiting-sync', 'verified'].includes(value.memorySyncState) ? value.memorySyncState : 'none';
  const activityState = memorySyncState === 'awaiting-sync' || value.activityState === 'suspended' ? 'suspended' : 'active';
  return {
    id,
    generation: Math.max(0, Math.floor(Number(value.generation) || 0)),
    activityState,
    activeAgentId: activityState === 'suspended' ? null : clean(value.activeAgentId || agentId, 160) || null,
    createdAt: stamp(value.createdAt) || now,
    activatedAt: activityState === 'suspended' ? null : (stamp(value.activatedAt) || now),
    suspendedAt: activityState === 'suspended' ? (stamp(value.suspendedAt) || now) : null,
    lastBackupId: clean(value.lastBackupId, 160) || null,
    restoredFromBackupId: clean(value.restoredFromBackupId, 160) || null,
    restoredAt: stamp(value.restoredAt),
    sourceAgentId: clean(value.sourceAgentId, 160) || null,
    memorySyncState,
    memorySyncId: clean(value.memorySyncId, 160) || null,
    memoryRootDigest: /^[a-f0-9]{64}$/i.test(String(value.memoryRootDigest || '')) ? String(value.memoryRootDigest).toLowerCase() : null
  };
}

export function ensureContinuityLineage(agent, { now = new Date().toISOString() } = {}) {
  if (!agent || typeof agent !== 'object') throw new Error('A local agent is required for continuity.');
  agent.continuityLineage = normalizeContinuityLineage(agent.continuityLineage, { agentId: agent.id, now });
  return agent.continuityLineage;
}

export function lineageActiveAgents(agents = [], lineageId = '') {
  return agents.filter((agent) => agent?.continuityLineage?.id === lineageId && agent.continuityLineage.activityState === 'active');
}

export function assertAgentActivity(agent) {
  if (agent?.continuityLineage?.activityState === 'suspended') {
    const error = new Error('This continuity identity is suspended because activity moved to another profile.');
    error.code = 'CONTINUITY_SUSPENDED'; error.status = 409; throw error;
  }
}

export function stageContinuityRestore({ agents = [], restoredAgent, manifest, moveActivity = false, failAt = '' } = {}) {
  if (!restoredAgent || !manifest?.lineage?.id || !manifest?.backupId) throw new Error('The continuity package is missing lineage information.');
  const staged = structuredClone(agents);
  const lineageId = manifest.lineage.id;
  const existingRestore = staged.find((agent) => agent?.continuityLineage?.restoredFromBackupId === manifest.backupId);
  if (existingRestore) return { agents: staged, agent: existingRestore, reused: true, suspendedAgentIds: [] };
  const active = lineageActiveAgents(staged, lineageId);
  if (active.length > 1) throw Object.assign(new Error('Continuity activity is already duplicated locally. Resolve the lineage before restoring.'), { code: 'CONTINUITY_DUPLICATE_ACTIVE', status: 409 });
  if (active.length && !moveActivity) throw Object.assign(new Error('This identity is active here. Choose Move activity to suspend the source before restoring.'), { code: 'CONTINUITY_SOURCE_ACTIVE', status: 409 });
  if (!active.length && manifest.lineage.sourceActivityState !== 'suspended' && !moveActivity) throw Object.assign(new Error('The source was active when this backup was created. Explicitly choose Move activity before activating the restore.'), { code: 'CONTINUITY_SOURCE_ACTIVE', status: 409 });
  const now = new Date().toISOString();
  const suspendedAgentIds = [];
  if (moveActivity) for (const source of active) {
    source.continuityLineage = { ...normalizeContinuityLineage(source.continuityLineage, { agentId: source.id, now }), activityState: 'suspended', activeAgentId: null, activatedAt: null, suspendedAt: now };
    suspendedAgentIds.push(source.id);
  }
  if (failAt === 'after-suspend') throw new Error('Injected continuity transaction failure after source suspension.');
  const target = structuredClone(restoredAgent);
  target.continuityLineage = normalizeContinuityLineage({
    id: lineageId,
    generation: Math.max(0, Number(manifest.lineage.generation) || 0) + 1,
    activityState: 'active', activeAgentId: target.id,
    createdAt: manifest.lineage.createdAt || now, activatedAt: now,
    restoredFromBackupId: manifest.backupId, restoredAt: now,
    sourceAgentId: manifest.lineage.sourceAgentId || null
  }, { agentId: target.id, now });
  if (failAt === 'before-activate') throw new Error('Injected continuity transaction failure before target activation.');
  staged.push(target);
  const finalActive = lineageActiveAgents(staged, lineageId);
  if (finalActive.length !== 1 || finalActive[0].id !== target.id) throw new Error('Continuity activity transaction did not produce exactly one active profile.');
  return { agents: staged, agent: target, reused: false, suspendedAgentIds };
}

function memoryMoveIdentity(manifest) {
  const syncId = String(manifest?.syncId || '').toLowerCase();
  const lineageId = String(manifest?.lineageId || '').toLowerCase();
  const rootDigest = String(manifest?.rootDigest || '').toLowerCase();
  if (!/^memory-sync-[0-9a-f-]{36}$/.test(syncId) || !/^lineage-[0-9a-f-]{36}$/.test(lineageId) || !/^[a-f0-9]{64}$/.test(rootDigest)) {
    throw new Error('The verified memory sync identity is invalid.');
  }
  return { syncId, lineageId, rootDigest };
}

export function stageMemoryMoveStart({ agents = [], sourceAgentId, restoredAgent, manifest, backupId = '', failAt = '' } = {}) {
  const identity = memoryMoveIdentity(manifest);
  const staged = structuredClone(agents);
  const source = staged.find((agent) => agent?.id === sourceAgentId);
  if (!source || !restoredAgent?.id) throw new Error('Memory-backed continuity requires source and destination profiles.');
  const existing = staged.find((agent) => agent?.continuityLineage?.memorySyncId === identity.syncId || agent?.id === restoredAgent.id);
  if (existing) {
    const existingLineage = normalizeContinuityLineage(existing.continuityLineage, { agentId: existing.id });
    if (existingLineage.memoryRootDigest !== identity.rootDigest) throw new Error('The memory sync identity conflicts with an existing destination.');
    return { agents: staged, source, target: existing, reused: true };
  }
  const sourceLineage = normalizeContinuityLineage(source.continuityLineage, { agentId: source.id });
  if (sourceLineage.id !== identity.lineageId || sourceLineage.activityState !== 'active') throw Object.assign(new Error('The continuity source is not the one active profile for this lineage.'), { code: 'CONTINUITY_SOURCE_INACTIVE', status: 409 });
  if (lineageActiveAgents(staged, identity.lineageId).length !== 1) throw Object.assign(new Error('Memory-backed continuity requires exactly one active source.'), { code: 'CONTINUITY_DUPLICATE_ACTIVE', status: 409 });
  const now = new Date().toISOString();
  source.continuityLineage = { ...sourceLineage, activityState: 'suspended', activeAgentId: null, activatedAt: null, suspendedAt: now, memorySyncState: 'none' };
  if (failAt === 'after-suspend') throw new Error('Injected memory move failure after source suspension.');
  const target = structuredClone(restoredAgent);
  target.continuityLineage = normalizeContinuityLineage({
    id: identity.lineageId, generation: sourceLineage.generation + 1, activityState: 'suspended',
    createdAt: sourceLineage.createdAt, suspendedAt: now, restoredFromBackupId: clean(backupId, 160) || null,
    restoredAt: now, sourceAgentId: source.id, memorySyncState: 'awaiting-sync', memorySyncId: identity.syncId,
    memoryRootDigest: identity.rootDigest
  }, { agentId: target.id, now });
  if (failAt === 'before-target') throw new Error('Injected memory move failure before destination staging.');
  staged.push(target);
  if (lineageActiveAgents(staged, identity.lineageId).length !== 0) throw new Error('The destination cannot await memory sync while a lineage profile remains active.');
  return { agents: staged, source, target, reused: false };
}

export function stageMemoryMoveComplete({ agents = [], targetAgentId, verification, failAt = '' } = {}) {
  const identity = memoryMoveIdentity(verification?.manifest || verification);
  if (verification?.status !== 'verified') throw Object.assign(new Error('The destination cannot activate before memory sync verification completes.'), { code: 'MEMORY_SYNC_INCOMPLETE', status: 409 });
  const staged = structuredClone(agents);
  const target = staged.find((agent) => agent?.id === targetAgentId);
  if (!target) throw new Error('The memory-sync destination profile was not found.');
  const lineage = normalizeContinuityLineage(target.continuityLineage, { agentId: target.id });
  if (lineage.id !== identity.lineageId || lineage.memorySyncId !== identity.syncId || lineage.memoryRootDigest !== identity.rootDigest || lineage.memorySyncState !== 'awaiting-sync') {
    throw new Error('The verified memory sync does not match the awaiting destination.');
  }
  if (lineageActiveAgents(staged, identity.lineageId).length !== 0) throw new Error('Another lineage profile became active before memory sync completed.');
  if (failAt === 'before-activate') throw new Error('Injected memory move failure before destination activation.');
  const now = new Date().toISOString();
  target.continuityLineage = normalizeContinuityLineage({ ...lineage, activityState: 'active', activeAgentId: target.id, activatedAt: now, suspendedAt: null, memorySyncState: 'verified' }, { agentId: target.id, now });
  const active = lineageActiveAgents(staged, identity.lineageId);
  if (active.length !== 1 || active[0].id !== target.id) throw new Error('Memory-backed continuity did not produce exactly one active destination.');
  return { agents: staged, target };
}

export function stageMemoryRestoreAwaitingSync({ agents = [], restoredAgent, manifest, backupId = '', failAt = '' } = {}) {
  const identity = memoryMoveIdentity(manifest);
  if (!restoredAgent?.id || manifest.sourceActivityState !== 'suspended') throw new Error('Memory restore requires a suspended source and a destination profile.');
  const staged = structuredClone(agents);
  const existing = staged.find((agent) => agent?.continuityLineage?.memorySyncId === identity.syncId || agent?.id === restoredAgent.id);
  if (existing) {
    const lineage = normalizeContinuityLineage(existing.continuityLineage, { agentId: existing.id });
    if (lineage.memoryRootDigest !== identity.rootDigest) throw new Error('The memory sync identity conflicts with an existing destination.');
    return { agents: staged, target: existing, reused: true };
  }
  if (lineageActiveAgents(staged, identity.lineageId).length) throw Object.assign(new Error('A profile for this continuity lineage is already active on the destination.'), { code: 'CONTINUITY_DESTINATION_ACTIVE', status: 409 });
  const now = new Date().toISOString();
  const target = structuredClone(restoredAgent);
  target.continuityLineage = normalizeContinuityLineage({
    id: identity.lineageId, generation: Math.max(0, Number(restoredAgent.continuityLineage?.generation) || 0) + 1,
    activityState: 'suspended', createdAt: restoredAgent.continuityLineage?.createdAt || now, suspendedAt: now,
    restoredFromBackupId: clean(backupId, 160) || null, restoredAt: now, sourceAgentId: clean(manifest.sourceAgentId, 160) || null,
    memorySyncState: 'awaiting-sync', memorySyncId: identity.syncId, memoryRootDigest: identity.rootDigest
  }, { agentId: target.id, now });
  if (failAt === 'before-target') throw new Error('Injected memory restore failure before destination staging.');
  staged.push(target);
  if (lineageActiveAgents(staged, identity.lineageId).length !== 0) throw new Error('A memory-sync destination became active before verification.');
  return { agents: staged, target, reused: false };
}

export function publicContinuityLineage(value) {
  if (!value) return null;
  const normalized = normalizeContinuityLineage(value, { agentId: value.activeAgentId || '' });
  return { ...normalized };
}
