import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerMemory, ownerMemoryFact, ownerMemoryPrompt, ownerMemoryStaleness, recallOwnerMemories, reviseOwnerMemory } from '../lib/owner-memory.mjs';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';

const agentId = 'agent-owner-staleness';
const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const make = (category, at, extra = {}) => createOwnerMemory({ category, content: 'Synthetic bridge route', ...extra }, { agentId, at });

test('owner notes share category expiry, explicit date boundaries and read-only history', () => {
  const temporary = make('temporary', '2026-09-01T00:00:00.000Z');
  const before = JSON.stringify(temporary);
  assert.equal(ownerMemoryStaleness(temporary, '2026-09-08').stale, false);
  assert.equal(ownerMemoryStaleness(temporary, '2026-09-09').stale, true);
  assert.match(ownerMemoryFact(temporary, { today: '2026-09-09' }), /STALE — category lifetime/);
  assert.equal(ownerMemoryStaleness(make('preference', temporary.createdAt), '2026-09-09').stale, false);
  assert.equal(ownerMemoryStaleness(make('__proto__', temporary.createdAt), '2099-01-01').stale, false);
  const deadline = make('preference', temporary.createdAt, { verify_by: '2026-09-09' });
  assert.equal(ownerMemoryStaleness(deadline, '2026-09-09').stale, false);
  assert.match(ownerMemoryFact(deadline, { today: '2026-09-10' }), /STALE — verify_by/);
  const revised = reviseOwnerMemory(temporary, { content: 'Verified current bridge route' },
    { at: '2026-09-09T00:00:00.000Z', why: 'Synthetic recheck', author: 'owner' });
  assert.equal(ownerMemoryStaleness(revised, '2026-09-10').stale, false);
  assert.equal(revised.revisions.length, 1);
  assert.equal(JSON.stringify(temporary), before);
  assert.equal(ownerMemoryStaleness({ ...temporary, category: 'Temporary' }, '2026-09-09').stale, true);
  const fresh = make('temporary', '2026-09-09T00:00:00.000Z');
  const prompt = ownerMemoryPrompt([temporary, fresh], { query: 'bridge route', today: '2026-09-09', maxItems: 1 });
  assert.match(prompt, new RegExp(fresh.id));
  assert.doesNotMatch(prompt, new RegExp(temporary.id));
  assert.equal(ownerMemoryStaleness(make('Project', temporary.createdAt), '2026-12-01').stale, true);
});

test('owner recall and actual signed MCP note tools expose the same stale warning without evidence or foreign notes', async () => {
  const at = new Date(Date.now() - 14 * 86400000).toISOString();
  const note = make('temporary', at, { status: 'conditional', valid_while: 'while the synthetic project stays open',
    evidence_excerpt: 'PRIVATE-SYNTHETIC-EVIDENCE' });
  const foreign = { ...make('temporary', at), agentId: 'foreign-agent' };
  const recalled = recallOwnerMemories([note, foreign], { agentId, depth: 0 });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].stale, true);
  assert.match(recalled[0].warning, /STALE/);
  assert.doesNotMatch(JSON.stringify(recalled), /PRIVATE-SYNTHETIC-EVIDENCE/);
  const handler = createMemoryMcpHandler({ store: { async recall() {}, async getById() {}, async listContext() {}, async listContextScopes() {} },
    rag: { async semanticSearch() {} }, lineageId, agentId,
    ownerNotes: async () => [note, foreign] });
  for (const [name, args] of [['list-owner-notes', {}], ['get-owner-note', { id: note.id }]]) {
    const response = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(response.error, undefined, JSON.stringify(response));
    const packet = response.result.structuredContent;
    const record = packet.note ?? packet.notes[0];
    assert.equal(record.id, note.id);
    assert.equal(record.stale, true);
    assert.match(record.warning, /STALE — category lifetime/);
    assert.match(record.warning, /CONDITIONAL — verify valid_while before relying on this claim/);
    assert.doesNotMatch(JSON.stringify(packet), /PRIVATE-SYNTHETIC-EVIDENCE|foreign-agent/);
  }
  assert.equal(note.status, 'conditional');
  assert.equal(note.revisions.length, 0);
});
