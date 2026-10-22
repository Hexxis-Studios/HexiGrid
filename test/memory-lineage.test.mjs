import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContinuityLineage, stageMemoryMoveComplete, stageMemoryMoveStart, stageMemoryRestoreAwaitingSync } from '../lib/continuity-lineage.mjs';

const lineageId = 'lineage-66666666-6666-4666-8666-666666666666';
const manifest = { syncId: 'memory-sync-77777777-7777-4777-8777-777777777777', lineageId, rootDigest: 'a'.repeat(64) };
const source = { id: 'source-agent', name: 'Source', continuityLineage: normalizeContinuityLineage({ id: lineageId, activityState: 'active' }, { agentId: 'source-agent', now: '2026-09-21T10:00:00.000Z' }) };
const target = { id: 'target-agent', name: 'Target' };

test('memory-backed Move activity suspends source, waits for verified sync, then activates one destination', () => {
  const started = stageMemoryMoveStart({ agents: [source], sourceAgentId: source.id, restoredAgent: target, manifest, backupId: 'continuity-backup-test' });
  assert.equal(started.agents.filter((agent) => agent.continuityLineage.activityState === 'active').length, 0);
  assert.equal(started.target.continuityLineage.memorySyncState, 'awaiting-sync');
  assert.throws(() => stageMemoryMoveComplete({ agents: started.agents, targetAgentId: target.id, verification: { status: 'awaiting-sync', manifest } }), /cannot activate/);
  const completed = stageMemoryMoveComplete({ agents: started.agents, targetAgentId: target.id, verification: { status: 'verified', manifest } });
  const active = completed.agents.filter((agent) => agent.continuityLineage.activityState === 'active');
  assert.deepEqual(active.map((agent) => agent.id), [target.id]);
  assert.equal(active[0].continuityLineage.memorySyncState, 'verified');
  assert.equal(completed.agents.find((agent) => agent.id === source.id).continuityLineage.activityState, 'suspended');
});

test('memory-backed Move activity is staged, idempotent, and injected failures never mutate the source input', () => {
  const original = structuredClone(source);
  assert.throws(() => stageMemoryMoveStart({ agents: [source], sourceAgentId: source.id, restoredAgent: target, manifest, failAt: 'after-suspend' }), /Injected/);
  assert.deepEqual(source, original);
  assert.throws(() => stageMemoryMoveStart({ agents: [source], sourceAgentId: source.id, restoredAgent: target, manifest, failAt: 'before-target' }), /Injected/);
  assert.deepEqual(source, original);
  const first = stageMemoryMoveStart({ agents: [source], sourceAgentId: source.id, restoredAgent: target, manifest });
  const replay = stageMemoryMoveStart({ agents: first.agents, sourceAgentId: source.id, restoredAgent: target, manifest });
  assert.equal(replay.reused, true);
  assert.equal(replay.agents.filter((agent) => agent.id === target.id).length, 1);
  assert.throws(() => stageMemoryMoveComplete({ agents: first.agents, targetAgentId: target.id, verification: { status: 'verified', manifest }, failAt: 'before-activate' }), /Injected/);
  assert.equal(first.agents.find((agent) => agent.id === target.id).continuityLineage.memorySyncState, 'awaiting-sync');
});

test('remote memory restore stays asleep until the signed suspended-source sync verifies', () => {
  const remoteManifest = { ...manifest, sourceActivityState: 'suspended', sourceAgentId: source.id };
  const remote = { id: 'agent-remote', name: 'Remote restore' };
  const staged = stageMemoryRestoreAwaitingSync({ agents: [], restoredAgent: remote, manifest: remoteManifest, backupId: 'continuity-backup-remote' });
  assert.equal(staged.target.continuityLineage.activityState, 'suspended');
  assert.equal(staged.target.continuityLineage.memorySyncState, 'awaiting-sync');
  assert.equal(staged.agents.filter((agent) => agent.continuityLineage.activityState === 'active').length, 0);
  const completed = stageMemoryMoveComplete({ agents: staged.agents, targetAgentId: remote.id, verification: { status: 'verified', manifest: remoteManifest } });
  assert.deepEqual(completed.agents.filter((agent) => agent.continuityLineage.activityState === 'active').map((agent) => agent.id), [remote.id]);
  assert.throws(() => stageMemoryRestoreAwaitingSync({ agents: [], restoredAgent: remote, manifest: { ...remoteManifest, sourceActivityState: 'active' } }), /suspended source/);
});
