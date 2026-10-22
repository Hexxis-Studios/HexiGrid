import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';
import { agentLinkOrientation } from '../lib/agent-link-orientation.mjs';

const lineageId = 'lineage-12345678-1234-4234-8234-123456789abc';
const agentId = 'scope-guidance-test';

test('memory MCP gives fixed contextScope guidance without reading or committing private memory', async () => {
  const privateAccesses = [];
  let ragReads = 0;
  const store = {
    recall: async () => { privateAccesses.push('recall'); throw new Error('PRIVATE_INTERNAL_DETAIL_MARKER'); },
    getById: async () => { privateAccesses.push('getById'); return null; },
    listContext: async () => { privateAccesses.push('listContext'); return []; },
    listContextScopes: async () => { privateAccesses.push('listContextScopes'); return []; },
    append: async () => { privateAccesses.push('append'); }
  };
  const handler = createMemoryMcpHandler({
    store,
    rag: { semanticSearch: async () => { ragReads += 1; return []; } },
    lineageId,
    agentId
  });
  const invoke = (id, name, args) => handler({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: args } });

  const rejected = await invoke(1, 'propose-memory', {
    text: 'Synthetic scope proposal.',
    contextScope: { project: 'PRIVATE_PROJECT_MARKER', topic: 'PRIVATE_TOPIC_MARKER' }
  });
  assert.equal(rejected.error.code, -32000);
  assert.equal(rejected.error.message, 'contextScope requires projectId and optional topicId; aliases project/topic are unsupported.');
  assert.equal(rejected.error.data.reason, 'request-rejected');
  assert.deepEqual(rejected.error.data.discovery, { method: 'tools/list' });
  assert.doesNotMatch(rejected.error.message, /PRIVATE_PROJECT_MARKER|PRIVATE_TOPIC_MARKER/);
  assert.deepEqual(privateAccesses, []);
  assert.equal(ragReads, 0);

  const accepted = await invoke(2, 'propose-memory', {
    text: 'Synthetic scope proposal.',
    contextScope: { projectId: 'project-demo', topicId: 'topic-demo' }
  });
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.result.structuredContent.accepted, true);
  assert.equal(accepted.result.structuredContent.committed, false);
  assert.deepEqual(privateAccesses, []);
  assert.equal(ragReads, 0);

  const internalFailure = await invoke(3, 'read-log-range', { from: '2026-01-01', to: '2026-01-01' });
  assert.equal(internalFailure.error.code, -32000);
  assert.equal(internalFailure.error.message, 'The private memory request was rejected safely.');
  assert.equal(internalFailure.error.data.reason, 'memory-unavailable');
  assert.doesNotMatch(JSON.stringify(internalFailure.error), /PRIVATE_INTERNAL_DETAIL_MARKER/);
  assert.deepEqual(privateAccesses, ['recall']);
});

test('advertised write and recall examples execute the existing schemas with different scope shapes', async () => {
  const selections = [];
  const handler = createMemoryMcpHandler({
    store: { recall() {}, getById() {}, listContextScopes() {},
      listContext: async options => { selections.push(options); return []; } },
    rag: { semanticSearch: async () => [] }, lineageId, agentId
  });
  const orientation = agentLinkOrientation({ id: 'scope-guidance-link', status: 'connected',
    trustLevel: 'scoped', capabilities: ['memory-read', 'memory-write'] });
  const methods = orientation.available.flatMap(item => item.methods || []);
  for (const name of ['propose-memory', 'recall-context']) {
    const body = methods.find(method => method.body?.params?.name === name).body;
    const response = await handler(body);
    assert.equal(response.error, undefined, name);
    if (name === 'propose-memory') assert.equal(response.result.structuredContent.committed, false);
  }
  assert.equal(selections.length, 1);
  assert.equal(selections[0].projectId, 'project-id');
  assert.equal(selections[0].topicId, 'topic-id');
});
