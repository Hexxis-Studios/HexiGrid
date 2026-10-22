import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { LocalMemoryRag } from '../lib/local-memory-rag.mjs';
import { createMemoryMcpHandler } from '../lib/memory-mcp.mjs';
import { callMcpTool, discoverMcpServer } from '../lib/mcp-client.mjs';
import { createMemorySyncManifest, MemorySyncReceiver } from '../lib/memory-sync.mjs';
import { normalizeContinuityLineage, stageMemoryMoveComplete, stageMemoryMoveStart } from '../lib/continuity-lineage.mjs';

const lineageId = 'lineage-99999999-9999-4999-8999-999999999999';
const sourceAgentId = 'memory-acceptance-source';
const destinationAgentId = 'memory-acceptance-destination';
const exactText = 'The wake phrase stays on this computer; audio begins crossing the bridge only after local detection.';
const root = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-memory-acceptance-'));
const sourceStore = new DatedMemoryStore({ root: path.join(root, 'source-memory') });
const sourceRag = new LocalMemoryRag({ root: path.join(root, 'source-index'), store: sourceStore });
let networkAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkAttempts += 1; throw new Error('Network access is disabled during local-memory acceptance.'); };
let service;

try {
  const handler = createMemoryMcpHandler({ store: sourceStore, rag: sourceRag, lineageId, agentId: sourceAgentId, assertActive: async () => {} });
  service = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const result = await handler(JSON.parse(raw));
    if (!result) { response.writeHead(202).end(); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(0, '127.0.0.1', resolve); });
  const server = { transport: 'http', url: `http://127.0.0.1:${service.address().port}/mcp`, local: true };
  const discovered = await discoverMcpServer(server);
  const pinned = { ...server, serverIdentity: discovered.serverIdentity };
  const invoke = async (name, input) => {
    const tool = discovered.tools.find((item) => item.name === name);
    return callMcpTool(pinned, {}, name, input, { expectedToolSetDigest: discovered.toolSetDigest, expectedToolDigest: tool.digest });
  };

  const startedAt = performance.now();
  const proposal = await invoke('propose-memory', { text: exactText, status: 'conditional', valid_while: 'local wake detection is enabled' });
  assert.equal(proposal.structuredContent.committed, false);
  await sourceStore.append({ lineageId, agentId: sourceAgentId, createdAt: '2026-09-20T20:00:00.000Z', text: 'ExampleAgent is the orchestrator for the current acceptance work.', id: 'memory-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  await sourceStore.append({ lineageId, agentId: sourceAgentId, createdAt: '2026-09-21T08:00:00.000Z', text: exactText, metadata: { kind: 'decision' }, id: 'memory-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'conditional', valid_while: 'local wake detection is enabled' });
  await sourceRag.indexRange({ lineageId, from: '2026-09-20', to: '2026-09-21' });
  const read = await invoke('read-log-range', { from: '2026-09-20', to: '2026-09-21' });
  const searchStartedAt = performance.now();
  const search = await invoke('semantic-search', { query: 'privacy rule for microphone wake phrase', limit: 2 });
  const searchMs = performance.now() - searchStartedAt;
  assert.equal(read.structuredContent.entries.find((entry) => entry.id.includes('bbbb')).text, exactText);
  assert.equal(search.structuredContent.matches.some((entry) => entry.text === exactText), true);

  const files = await sourceStore.listFiles({ lineageId });
  const manifest = createMemorySyncManifest({ files, lineageId, sourceAgentId, sourceActivityState: 'suspended' });
  const source = { id: sourceAgentId, continuityLineage: normalizeContinuityLineage({ id: lineageId, activityState: 'active' }, { agentId: sourceAgentId }) };
  const destination = { id: destinationAgentId };
  const staged = stageMemoryMoveStart({ agents: [source], sourceAgentId, restoredAgent: destination, manifest });
  assert.equal(staged.agents.some((agent) => agent.continuityLineage.activityState === 'active'), false);
  const destinationStoreRoot = path.join(root, 'destination-memory');
  const receiver = new MemorySyncReceiver({ root: path.join(root, 'sync'), memoryRoot: destinationStoreRoot });
  await receiver.begin(manifest);
  for (const file of files) await receiver.receive(manifest.syncId, file.path, file.content);
  const verified = await receiver.finalize(manifest.syncId);
  const completed = stageMemoryMoveComplete({ agents: staged.agents, targetAgentId: destinationAgentId, verification: verified });
  assert.deepEqual(completed.agents.filter((agent) => agent.continuityLineage.activityState === 'active').map((agent) => agent.id), [destinationAgentId]);
  const destinationStore = new DatedMemoryStore({ root: destinationStoreRoot });
  const restored = await destinationStore.readRange({ lineageId, from: '2026-09-20', to: '2026-09-21' });
  assert.equal(restored.find((entry) => entry.id.includes('bbbb')).text, exactText);
  assert.equal(networkAttempts, 0);
  process.stdout.write(`${JSON.stringify({ ok: true, tools: discovered.tools.map((tool) => tool.name), entries: read.structuredContent.entries.length, exactSearchMatch: true, searchMs: Number(searchMs.toFixed(2)), totalMs: Number((performance.now() - startedAt).toFixed(2)), syncFiles: files.length, syncBytes: manifest.totalBytes, networkAttempts, activeAgentId: destinationAgentId }, null, 2)}\n`);
} finally {
  globalThis.fetch = originalFetch;
  await sourceRag.close().catch(() => {});
  if (service) await new Promise((resolve) => service.close(resolve));
  await rm(root, { recursive: true, force: true });
}
