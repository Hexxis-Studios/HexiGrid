import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { createMemoryMcpHandler, SIGNED_LINK_ONLY_MEMORY_TOOLS } from '../lib/memory-mcp.mjs';
import { createMemoryMistakeReader } from '../lib/memory-mistake-reader.mjs';
import { createDatedMemoryMistakeLedger } from '../lib/memory-mistake-ledger.mjs';

const lineageId = 'lineage-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherLineageId = 'lineage-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const agentId = 'agent-source';
const otherAgentId = 'agent-other';
const projectId = 'project-readiness';
const topicId = 'task-flow';
const sourceExcerpt = 'Private verified task excerpt for depth two only.';

function makeLedger(store, { agent = agentId, lineage = lineageId, resolveRecurrence, clock }) {
  const authorize = () => ({ allowed: true });
  return createDatedMemoryMistakeLedger({
    store, authorize, resolveRecurrence, now: clock,
    verifyEvidence: async ({ reference }) => ({ verified: true, ...reference,
      excerpt: sourceExcerpt, observedAt: '2026-10-01T12:00:00.000Z' }),
    commit: async ({ entry, assertAuthorized }) => {
      assertAuthorized();
      const result = await store.append(entry);
      return { created: result.appended, entry: result.entry };
    },
    revise: async ({ lineageId: selectedLineage, memoryId, expectedRevision, createdAt, by, why, changes, assertAuthorized }) => {
      assertAuthorized();
      return store.appendRevision({ lineageId: selectedLineage, id: memoryId,
        expectedRevision, createdAt, by, why, changes });
    }
  });
}

function authority(agent, lineage, contextScope) {
  return { agentId: agent, lineageId: lineage, contextScope,
    author: { kind: 'agent', id: agent } };
}

function proposal(key, overrides = {}) {
  return { whatWentWrong: `Earlier ${key} description ${'x'.repeat(1800)}`,
    correction: `Current correction for ${key} ${'c'.repeat(1800)}`,
    resultingFix: `Resulting fix for ${key} ${'f'.repeat(1800)}`,
    evidence: { kind: 'task', id: `task-source-${key}` }, idempotencyKey: `mistake-write-${key}`,
    ...overrides };
}

function createReader(store, options = {}) {
  return createMemoryMistakeReader({ store, lineageId, agentId,
    authorize: options.authorize || (() => ({ allowed: true })) });
}

async function invoke(handler, name, arguments_) {
  const reply = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } });
  if (reply.error) throw new Error(reply.error.message);
  assert.deepEqual(reply.result.content, [], 'mistake packets are returned once in structured content');
  return reply.result.structuredContent;
}

test('mistake MCP tools are discoverable only with the injected signed reader and expose bounded scope-only schemas', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-mistake-mcp-discovery-'));
  try {
    const store = new DatedMemoryStore({ root });
    const rag = { semanticSearch: async () => [] };
    const base = { store, rag, lineageId, agentId };
    const unavailable = createMemoryMcpHandler(base);
    const absent = await unavailable({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(!absent.result.tools.some(tool => /mistake/.test(tool.name)));

    const mistakeReader = createReader(store);
    const handler = createMemoryMcpHandler({ ...base, mistakeReader });
    const discovered = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = discovered.result.tools.find(tool => tool.name === 'list-memory-mistakes');
    const get = discovered.result.tools.find(tool => tool.name === 'get-memory-mistake');
    assert.ok(list && get);
    assert.deepEqual(list.inputSchema.required, ['projectId']);
    assert.deepEqual(get.inputSchema.required, ['id', 'projectId']);
    assert.equal(list.inputSchema.properties.limit.minimum, 1);
    assert.equal(list.inputSchema.properties.limit.maximum, 50);
    assert.equal(list.inputSchema.properties.maxBytes.minimum, 1024);
    assert.equal(list.inputSchema.properties.maxBytes.maximum, 32768);
    assert.equal(get.inputSchema.properties.depth.minimum, 0);
    assert.equal(get.inputSchema.properties.depth.maximum, 2);
    for (const tool of [list, get]) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(Object.hasOwn(tool.inputSchema.properties, 'agentId'), false);
      assert.equal(Object.hasOwn(tool.inputSchema.properties, 'lineageId'), false);
    }
    assert.ok(SIGNED_LINK_ONLY_MEMORY_TOOLS.includes('list-memory-mistakes'));
    assert.ok(SIGNED_LINK_ONLY_MEMORY_TOOLS.includes('get-memory-mistake'));
    await assert.rejects(invoke(handler, 'list-memory-mistakes', { projectId, agentId }), /unsupported fields/i);
    await assert.rejects(invoke(handler, 'list-memory-mistakes', { projectId, limit: 51 }), /limit/i);
    await assert.rejects(invoke(handler, 'get-memory-mistake', { id: 'mistake-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId, depth: 3 }), /depth/i);
    await assert.rejects(invoke(handler, 'get-memory-mistake', { id: 'mistake-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectId, maxBytes: 32769 }), /budget/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('typed mistake reads include project-wide topic history, hide foreign scope and identity, and reveal evidence only at depth two', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-mistake-reader-'));
  try {
    const store = new DatedMemoryStore({ root });
    let tick = 0;
    const clock = () => new Date(Date.parse('2026-10-01T12:00:00.000Z') + tick++ * 60_000).toISOString();
    let ledger = makeLedger(store, { clock });
    const projectWide = await ledger.record(proposal('project-wide'), authority(agentId, lineageId, { projectId }));
    const topic = await ledger.record(proposal('topic'), authority(agentId, lineageId, { projectId, topicId }));
    const otherTopic = await ledger.record(proposal('other-topic'), authority(agentId, lineageId, { projectId, topicId: 'other-topic' }));
    await ledger.record(proposal('other-project'), authority(agentId, lineageId, { projectId: 'other-project', topicId }));
    await ledger.record(proposal('unscoped'), authority(agentId, lineageId, null));
    await makeLedger(store, { agent: otherAgentId, clock }).record(proposal('other-agent'), authority(otherAgentId, lineageId, { projectId, topicId }));
    const otherLineage = await makeLedger(store, { lineage: otherLineageId, clock }).record(
      proposal('other-lineage'), authority(agentId, otherLineageId, { projectId, topicId }));

    const foreign = await makeLedger(store, { agent: otherAgentId, clock }).record(
      proposal('foreign-reference'), authority(otherAgentId, lineageId, { projectId, topicId }));
    const resolveRecurrence = async ({ reference }) => {
      const entry = await store.getById({ lineageId: reference.lineageId,
        id: `memory-${reference.id.slice('mistake-'.length)}`, depth: 2 });
      return entry?.metadata?.memoryMistake?.record || null;
    };
    ledger = makeLedger(store, { clock, resolveRecurrence });
    const withForeignReference = await ledger.record(proposal('foreign-recurrence', {
      recurrenceOf: [{ id: foreign.id, lineageId, agentId: otherAgentId }]
    }), authority(agentId, lineageId, { projectId, topicId }));
    const reader = createReader(store);
    const handler = createMemoryMcpHandler({ store, rag: { semanticSearch: async () => [] }, lineageId, agentId, mistakeReader: reader });

    const listed = await invoke(handler, 'list-memory-mistakes', { projectId, topicId });
    assert.deepEqual(new Set(listed.mistakes.map(item => item.id)), new Set([projectWide.id, topic.id, withForeignReference.id]));
    assert.ok(listed.mistakes.some(item => item.scope.projectId === projectId && !item.scope.topicId),
      'a topic read includes project-wide mistakes');
    assert.equal(listed.complete, false, 'content truncation is reflected in the completeness flag');
    assert.ok(listed.truncated);
    assert.equal(listed.mistakes.find(item => item.id === withForeignReference.id).recurrenceReferencesRedacted, 1);
    assert.ok(!JSON.stringify(listed).includes(sourceExcerpt));
    assert.ok(!JSON.stringify(listed).includes(otherAgentId));
    assert.ok(!JSON.stringify(listed).includes(otherLineageId));

    const noTopic = await invoke(handler, 'list-memory-mistakes', { projectId });
    assert.deepEqual(noTopic.mistakes.map(item => item.id), [projectWide.id]);
    const bounded = await invoke(handler, 'list-memory-mistakes', { projectId, topicId, maxBytes: 1024 });
    assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 1024);
    assert.ok(bounded.truncated || bounded.mistakes.some(item => item.textTruncated));

    const depth0 = await invoke(handler, 'get-memory-mistake', { id: withForeignReference.id, projectId, topicId, depth: 0 });
    assert.equal(depth0.state, 'recorded');
    assert.equal(Object.hasOwn(depth0.mistake.evidence, 'excerpt'), false);
    assert.equal(Object.hasOwn(depth0.mistake, 'revisions'), false);
    assert.equal(depth0.mistake.recurrenceReferencesRedacted, 1);
    assert.ok(!JSON.stringify(depth0).includes(otherAgentId));
    assert.ok(!JSON.stringify(depth0).includes(otherLineageId));
    assert.ok(!JSON.stringify(depth0).includes(sourceExcerpt));
    const tightDetail = await invoke(handler, 'get-memory-mistake', { id: withForeignReference.id, projectId, topicId,
      depth: 0, maxBytes: 1024 });
    assert.ok(Buffer.byteLength(JSON.stringify(tightDetail), 'utf8') <= 1024);
    assert.ok(tightDetail.mistake.truncatedFields.length > 0);
    const depth1 = await invoke(handler, 'get-memory-mistake', { id: withForeignReference.id, projectId, topicId, depth: 1 });
    assert.equal(Object.hasOwn(depth1.mistake.evidence, 'excerpt'), false);
    assert.ok(Array.isArray(depth1.mistake.revisions));
    assert.ok(!JSON.stringify(depth1).includes(sourceExcerpt));
    const depth2 = await invoke(handler, 'get-memory-mistake', { id: withForeignReference.id, projectId, topicId, depth: 2, maxBytes: 16384 });
    assert.equal(depth2.mistake.evidence.excerpt, sourceExcerpt);
    assert.ok(Buffer.byteLength(JSON.stringify(depth2), 'utf8') <= 16384);

    const wrongProject = await invoke(handler, 'get-memory-mistake', { id: topic.id, projectId: 'other-project', topicId });
    assert.deepEqual(wrongProject, { id: topic.id, state: 'absent', mistake: null });
    const foreignAgentRead = await invoke(handler, 'get-memory-mistake', { id: foreign.id, projectId, topicId });
    assert.deepEqual(foreignAgentRead, { id: foreign.id, state: 'absent', mistake: null });
    const foreignLineageRead = await invoke(handler, 'get-memory-mistake', { id: otherLineage.id, projectId, topicId });
    assert.deepEqual(foreignLineageRead, { id: otherLineage.id, state: 'absent', mistake: null });
    const otherTopicRead = await invoke(handler, 'get-memory-mistake', { id: otherTopic.id, projectId, topicId });
    assert.deepEqual(otherTopicRead, { id: otherTopic.id, state: 'absent', mistake: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejected records are retained for audit without warnings and async reads recheck current authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-mistake-reader-guard-'));
  try {
    const store = new DatedMemoryStore({ root });
    let tick = 0;
    const clock = () => new Date(Date.parse('2026-10-01T12:00:00.000Z') + tick++ * 60_000).toISOString();
    const ownerAuthority = { agentId, lineageId, contextScope: { projectId }, author: { kind: 'owner', id: 'owner-local' } };
    const ledger = makeLedger(store, { clock });
    const created = await ledger.record(proposal('rejected'), authority(agentId, lineageId, { projectId }));
    const owner = makeLedger(store, { clock });
    await owner.reject({ id: created.id, expectedRevision: 0, why: 'Retained only for audit.', createdAt: clock() }, ownerAuthority);
    const reader = createReader(store);
    const handler = createMemoryMcpHandler({ store, rag: { semanticSearch: async () => [] }, lineageId, agentId, mistakeReader: reader });
    const listed = await invoke(handler, 'list-memory-mistakes', { projectId });
    assert.equal(listed.mistakes[0].status, 'rejected');
    assert.equal(Object.hasOwn(listed.mistakes[0], 'warning'), false);
    const rejected = await invoke(handler, 'get-memory-mistake', { id: created.id, projectId, depth: 1 });
    assert.equal(rejected.state, 'rejected');
    assert.equal(rejected.status, 'rejected');
    assert.equal(Object.hasOwn(rejected, 'warning'), false);

    let authorized = true;
    const revocableStore = {
      getById: async (options) => {
        const entry = await store.getById(options);
        authorized = false;
        return entry;
      },
      listMemoryMistakes: async (options) => {
        const entries = await store.listMemoryMistakes(options);
        authorized = false;
        return entries;
      }
    };
    const guarded = createReader(revocableStore, { authorize: () => {
      if (!authorized) throw new Error('Current Link authority changed during read.');
      return { allowed: true };
    } });
    await assert.rejects(guarded.get({ id: created.id, projectId }), /authority changed/i);
    authorized = true;
    await assert.rejects(guarded.list({ projectId }), /authority changed/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mistake reader rejects noncanonical mapping or malformed record format as absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-mistake-reader-invalid-'));
  try {
    const store = new DatedMemoryStore({ root });
    const ledger = makeLedger(store, { clock: () => '2026-10-01T12:00:00.000Z' });
    const created = await ledger.record(proposal('canonical'), authority(agentId, lineageId, { projectId }));
    const originalGet = store.getById.bind(store);
    const invalidStore = { ...store,
      getById: async (options) => {
        const entry = await originalGet(options);
        return { ...entry, metadata: { ...entry.metadata,
          memoryMistake: { ...entry.metadata.memoryMistake, format: 'other-format' } } };
      },
      listMemoryMistakes: store.listMemoryMistakes.bind(store)
    };
    const reader = createReader(invalidStore);
    assert.deepEqual(await reader.get({ id: created.id, projectId }), { id: created.id, state: 'absent', mistake: null });
    const mappingStore = { ...store,
      getById: async (options) => {
        const entry = await originalGet(options);
        return { ...entry, id: 'memory-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
      },
      listMemoryMistakes: store.listMemoryMistakes.bind(store)
    };
    const mappingReader = createReader(mappingStore);
    assert.deepEqual(await mappingReader.get({ id: created.id, projectId }), { id: created.id, state: 'absent', mistake: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});
