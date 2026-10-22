import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EncryptedStateStore, localStateFormat } from '../lib/local-state.mjs';
import { callMcpTool, discoverMcpServer, validateMcpServer } from '../lib/mcp-client.mjs';
import { openCodePermissionConfig, parseOpenCodeEvents } from '../lib/opencode-runtime.mjs';
import { publicRunnerEvent, supportedRunnerHarnesses } from '../lib/ilands-runner.mjs';
import { generateImageWithProvider } from '../lib/providers.mjs';
import { collectPortableFiles, restorePortableFiles } from '../lib/portable-files.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fakePodman = { command: process.execPath, prefixArgs: [path.join(root, 'test', 'fixtures', 'fake-podman.mjs')] };
const pinnedMcpImage = `example.invalid/hexigrid-mcp@sha256:${'a'.repeat(64)}`;

class MemoryVault {
  values = new Map();
  async get(id) { return this.values.get(id) || ''; }
  async set(id, value) { this.values.set(id, value); }
}

test('local state migrates plaintext to authenticated encryption without retaining readable data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-state-'));
  try {
    const file = path.join(directory, 'state.json'); const vault = new MemoryVault();
    await writeFile(file, JSON.stringify({ agents: [], rooms: [], private: 'do-not-leak' }));
    const store = new EncryptedStateStore(file, vault); const loaded = await store.read();
    assert.equal(store.loadedPlaintext, true); assert.equal(loaded.private, 'do-not-leak');
    await store.write(loaded); const raw = await readFile(file, 'utf8');
    assert.doesNotMatch(raw, /do-not-leak/); assert.equal(JSON.parse(raw).format, localStateFormat);
    await assert.rejects(readFile(store.previousFile), /ENOENT/);
    assert.deepEqual(await store.read(), loaded);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('tampered encrypted local state is rejected', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-state-'));
  try {
    const file = path.join(directory, 'state.json'); const store = new EncryptedStateStore(file, new MemoryVault());
    await store.write({ agents: [], rooms: [] }); const envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.data = `${envelope.data.slice(0, -2)}AA`; await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(store.read(), /could not be decrypted/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dedicated encrypted restore point survives ordinary saves and a new store instance', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-restore-point-'));
  try {
    const file=path.join(directory,'state.json'), vault=new MemoryVault();
    const store=new EncryptedStateStore(file,vault);
    const original={agents:[],rooms:[],private:'pre-restore standing'};
    await store.write(original); await store.writeRestorePoint(original);
    await store.write({agents:[],rooms:[],private:'imported'});
    await store.write({agents:[],rooms:[],private:'later edit'});
    assert.doesNotMatch(await readFile(store.restorePointFile,'utf8'),/pre-restore standing/);
    const restarted=new EncryptedStateStore(file,vault);
    assert.deepEqual(await restarted.readRestorePoint(),original);
    const damaged=JSON.parse(await readFile(store.restorePointFile,'utf8'));
    damaged.tag=Buffer.alloc(16).toString('base64url');
    await writeFile(store.restorePointFile,JSON.stringify(damaged));
    await assert.rejects(restarted.readRestorePoint(),/could not be decrypted/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('pre-rename encrypted local state migrates without data loss', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-legacy-state-'));
  try {
    const file = path.join(directory, 'state.json'); const vault = new MemoryVault();
    const original = new EncryptedStateStore(file, vault);
    await original.write({ agents: [], rooms: [], legacyValue: 'preserved' });
    const legacyEnvelope = JSON.parse(await readFile(file, 'utf8'));
    legacyEnvelope.format = 'aveniq-local-state';
    await writeFile(file, JSON.stringify(legacyEnvelope));
    const migrated = new EncryptedStateStore(file, vault);
    const loaded = await migrated.read();
    assert.equal(loaded.legacyValue, 'preserved');
    await migrated.write(loaded);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).format, localStateFormat);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('OpenCode event parsing preserves session, exact tokens, text, and tool receipts', () => {
  const raw = [
    { type: 'step_start', sessionID: 'ses_123', part: { type: 'step-start' } },
    { type: 'text', sessionID: 'ses_123', part: { type: 'text', text: 'hello' } },
    { type: 'tool_use', sessionID: 'ses_123', part: { type: 'tool', tool: 'read', status: 'completed' } },
    { type: 'step_finish', sessionID: 'ses_123', part: { tokens: { input: 12, output: 3 } } }
  ].map(JSON.stringify).join('\n');
  const parsed = parseOpenCodeEvents(raw);
  assert.equal(parsed.content, 'hello'); assert.equal(parsed.sessionId, 'ses_123'); assert.equal(parsed.inputTokens, 12); assert.equal(parsed.outputTokens, 3); assert.equal(parsed.toolReceipts[0].tool, 'read');
});

test('OpenCode inline policy cannot let full access escape Plan mode', () => {
  const config = openCodePermissionConfig('plan', 'full', true, true);
  assert.equal(config.permission.edit, 'deny'); assert.equal(config.permission.bash, 'deny'); assert.equal(config.permission.task, 'deny'); assert.equal(config.permission.read, 'allow');
});

test('MCP stdio client discovers and calls real tools', async () => {
  const server = { transport: 'stdio', image: pinnedMcpImage, command: 'fixture', args: [], workspaceAccess: 'none' };
  const discovery = await discoverMcpServer(server, {}, { podmanCommand: fakePodman }); const tool = discovery.tools.find((item) => item.name === 'echo'); assert.ok(tool.digest); assert.ok(discovery.toolSetDigest); assert.ok(discovery.serverIdentity); assert.ok(discovery.executableDigest);
  const pinned = { ...server, serverIdentity: discovery.serverIdentity, executableDigest: discovery.executableDigest };
  const result = await callMcpTool(pinned, {}, 'echo', { text: 'working' }, { expectedToolSetDigest: discovery.toolSetDigest, expectedToolDigest: tool.digest, podmanCommand: fakePodman }); assert.equal(result.content[0].text, 'working');
  await assert.rejects(callMcpTool(pinned, {}, 'echo', { text: 'working', undeclared: true }, { expectedToolSetDigest: discovery.toolSetDigest, expectedToolDigest: tool.digest, podmanCommand: fakePodman }), /undeclared field/);
  await assert.rejects(callMcpTool(pinned, { MCP_DRIFT: '1' }, 'echo', { text: 'working' }, { expectedToolSetDigest: discovery.toolSetDigest, expectedToolDigest: tool.digest, podmanCommand: fakePodman }), Object.assign(/changed after review/, {}));
  await assert.rejects(callMcpTool(pinned, { MCP_CHANGED_IDENTITY: '1' }, 'echo', { text: 'working' }, { expectedToolSetDigest: discovery.toolSetDigest, expectedToolDigest: tool.digest, podmanCommand: fakePodman }), /identity changed/);
  process.env.HEXIGRID_MCP_LEAK = 'must-not-cross-boundary';
  try { const envTool = discovery.tools.find((item) => item.name === 'env-check'); const isolated = await callMcpTool(pinned, {}, envTool.name, {}, { expectedToolSetDigest: discovery.toolSetDigest, expectedToolDigest: envTool.digest, podmanCommand: fakePodman }); assert.equal(isolated.content[0].text, 'isolated'); } finally { delete process.env.HEXIGRID_MCP_LEAK; }
  const slow = discovery.tools.find((item) => item.name === 'slow'); const controller = new AbortController(); setTimeout(() => controller.abort(), 100);
  await assert.rejects(callMcpTool(pinned, {}, slow.name, {}, { expectedToolSetDigest: discovery.toolSetDigest, expectedToolDigest: slow.digest, signal: controller.signal, podmanCommand: fakePodman }), /cancelled/);
  assert.throws(() => validateMcpServer({ name: 'unsafe', transport: 'stdio', command: 'launch.cmd' }), /digest-pinned/);
  await assert.rejects(discoverMcpServer(server, {}, { podmanCommand: { command: path.join(root, 'missing-podman'), prefixArgs: [] } }), /Podman is not installed/);
  assert.throws(() => validateMcpServer({ name: 'pivot', transport: 'http', url: 'https://example.com:22/mcp' }), /blocked network port/);
});

test('MCP launch-file pinning and HTTP destination controls fail closed', async () => {
  const stdio = { transport: 'stdio', image: pinnedMcpImage, command: 'fixture', args: [], workspaceAccess: 'none' }; const discovery = await discoverMcpServer(stdio, {}, { podmanCommand: fakePodman }); const echo = discovery.tools.find((item) => item.name === 'echo');
  await assert.rejects(callMcpTool({ ...stdio, command: 'changed', executableDigest: discovery.executableDigest, serverIdentity: discovery.serverIdentity }, {}, 'echo', { text: 'blocked' }, { expectedToolSetDigest: discovery.toolSetDigest, expectedToolDigest: echo.digest, podmanCommand: fakePodman }), /runtime, image, or container command changed/);

  let bearer = ''; const service = http.createServer(async (req, res) => { bearer = String(req.headers.authorization || ''); let raw = ''; for await (const chunk of req) raw += chunk; const rpc = JSON.parse(raw); if (rpc.id === undefined) { res.writeHead(202).end(); return; } let result = {}; if (rpc.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } }; if (rpc.method === 'tools/list') result = { tools: [{ name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }; if (rpc.method === 'tools/call') result = { content: [{ type: 'text', text: 'ok' }] }; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })); });
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  try { const address = service.address(); const config = { transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, local: true }; const discovered = await discoverMcpServer(config, { bearer: 'protected' }); const tool = discovered.tools[0]; const result = await callMcpTool({ ...config, serverIdentity: discovered.serverIdentity }, { bearer: 'protected' }, tool.name, {}, { expectedToolSetDigest: discovered.toolSetDigest, expectedToolDigest: tool.digest }); assert.equal(result.content[0].text, 'ok'); assert.equal(bearer, 'Bearer protected'); }
  finally { await new Promise((resolve) => service.close(resolve)); }
  await assert.rejects(discoverMcpServer({ transport: 'http', url: 'https://127.0.0.1/mcp', local: false }), /private|loopback|reserved/);
});

test('Runner events expose only public authorization fields', () => {
  const event = publicRunnerEvent({ event: 'runner_authorization_required', verificationUrlComplete: 'https://ilands.ai/device?code=OK', userCode: 'OK', expiresAt: 'soon', deviceCode: 'secret', privateKey: 'secret' });
  assert.equal(event.userCode, 'OK'); assert.equal(event.deviceCode, undefined); assert.equal(event.privateKey, undefined);
  assert.deepEqual(supportedRunnerHarnesses('win32'), ['codex', 'claude-code']);
  assert.equal(publicRunnerEvent({ event: 'runner_authorization_required', verificationUrlComplete: 'https://evil.example/phish' }).verificationUrlComplete, undefined);
});

test('image provider accepts base64 results without leaking response bodies', async () => {
  const bytes = Buffer.from('image-data');
  const fetcher = async () => new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await generateImageWithProvider({ baseUrl: 'https://example.test/v1' }, 'key', 'image-model', 'test', { fetcher });
  assert.deepEqual(result.bytes, bytes); assert.equal(result.mimeType, 'image/png');
});

test('portable private files round-trip with hashes and reject traversal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-files-'));
  const source = Object.fromEntries(['workspace', 'media', 'plugins'].map((area) => [area, path.join(directory, 'source', area)]));
  const destination = Object.fromEntries(['workspace', 'media', 'plugins'].map((area) => [area, path.join(directory, 'destination', area)]));
  try {
    for (const root of [...Object.values(source), ...Object.values(destination)]) await mkdir(root, { recursive: true });
    await mkdir(path.join(source.workspace, 'notes'), { recursive: true });
    await writeFile(path.join(source.workspace, 'notes', 'memory.txt'), 'portable private content');
    const bundle = await collectPortableFiles(source);
    assert.equal(bundle.files.length, 1); assert.equal(bundle.files[0].area, 'workspace');
    const result = await restorePortableFiles(bundle, destination);
    assert.equal(result.files, 1); assert.equal(await readFile(path.join(destination.workspace, 'notes', 'memory.txt'), 'utf8'), 'portable private content');
    const malicious = structuredClone(bundle); malicious.files[0].path = '../escape.txt';
    await assert.rejects(restorePortableFiles(malicious, destination), /unsafe|escapes/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
