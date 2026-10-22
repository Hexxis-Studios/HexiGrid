import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptBackup } from '../lib/backup.mjs';
import { buildPackageIdentity } from '../lib/plugin-security.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 43927;
let child;
let dataDir;

async function request(url, method = 'GET', body, extraHeaders = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: body === undefined ? extraHeaders : { 'content-type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, body: await response.json().catch(() => ({})) };
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('E2E server did not start.');
}

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-e2e-'));
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, env: { ...process.env, HEXIGRID_PORT: String(port), HEXIGRID_DATA_DIR: dataDir, HEXIGRID_PODMAN: path.join(dataDir, 'missing-podman'), OPENCODE_CLI: 'missing-opencode-for-e2e' }, stdio: 'ignore' });
  await waitUntilReady();
});

after(async () => {
  child?.kill();
  await rm(dataDir, { recursive: true, force: true });
});

test('backup export/import includes private files and is authenticated', async () => {
  const mode = await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
  assert.equal(mode.response.status, 200);
  const saved = await request('/api/workspace/file', 'PUT', { path: '/e2e-note.txt', content: 'restore me' });
  assert.equal(saved.response.status, 200);
  await mkdir(path.join(dataDir, 'dated-memory', 'lineage-e2e'), { recursive: true });
  await mkdir(path.join(dataDir, 'memory-index'), { recursive: true });
  await writeFile(path.join(dataDir, 'dated-memory', 'lineage-e2e', '2026-09-21.json'), 'dated-memory-original');
  await writeFile(path.join(dataDir, 'memory-index', 'lineage-e2e.sqlite'), 'rag-index-original');
  const exported = await request('/api/backup/export', 'POST', { passphrase: 'e2e-backup-passphrase' });
  assert.equal(exported.response.status, 200);
  assert.equal(exported.body.receipt.source, 'backup');
  const payload = decryptBackup(exported.body.envelope, 'e2e-backup-passphrase');
  assert.equal(payload.privateFiles.files.some((file) => file.path === 'e2e-note.txt'), true);
  assert.deepEqual([...payload.privateFiles.areas].sort(), ['dated-memory', 'media', 'memory-index', 'plugins', 'workspace']);
  assert.equal(payload.backup.version, 3);
  assert.match(payload.backup.manifest.snapshotSha256, /^[a-f0-9]{64}$/);
  const changed = await request('/api/workspace/file', 'PUT', { path: '/e2e-note.txt', content: 'changed', expectedSha256: saved.body.sha256 });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
  await request('/api/settings', 'PATCH', { owner: { displayName: 'Before restore owner' } });
  await writeFile(path.join(dataDir, 'dated-memory', 'lineage-e2e', '2026-09-21.json'), 'dated-memory-changed');
  await writeFile(path.join(dataDir, 'memory-index', 'lineage-e2e.sqlite'), 'rag-index-changed');
  assert.equal((await request('/api/backup/import', 'POST', { envelope: exported.body.envelope, passphrase: 'e2e-backup-passphrase' })).response.status, 409);
  const restored = await request('/api/backup/import', 'POST', { envelope: exported.body.envelope, passphrase: 'e2e-backup-passphrase', confirmReplace: true });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.receipt.action, 'backup:import');
  assert.equal(await readFile(path.join(dataDir, 'workspace', 'e2e-note.txt'), 'utf8'), 'restore me');
  assert.equal(await readFile(path.join(dataDir, 'dated-memory', 'lineage-e2e', '2026-09-21.json'), 'utf8'), 'dated-memory-original');
  assert.equal(await readFile(path.join(dataDir, 'memory-index', 'lineage-e2e.sqlite'), 'utf8'), 'rag-index-original');
  assert.equal((await request('/api/bootstrap')).body.backupRecovery.localRollbackAvailable, true);
  // Normal saves after import used to overwrite the rolling rollback state.
  await request('/api/settings', 'PATCH', { owner: { displayName: 'After restore owner' } });
  const postRestoreEdit = await request('/api/workspace/file', 'PUT', { path: '/e2e-note.txt', content: 'post-restore edit', expectedSha256: saved.body.sha256 });
  assert.equal(postRestoreEdit.response.status, 200, JSON.stringify(postRestoreEdit.body));
  assert.equal((await request('/api/backup/import', 'POST', { envelope: exported.body.envelope, passphrase: 'wrong-backup-passphrase', confirmReplace: true })).response.status, 400);
  const rolledBack = await request('/api/backup/rollback', 'POST', {});
  assert.equal(rolledBack.response.status, 200);
  assert.equal((await request('/api/bootstrap')).body.settings.owner.displayName, 'Before restore owner');
  assert.equal(await readFile(path.join(dataDir, 'workspace', 'e2e-note.txt'), 'utf8'), 'changed');
  assert.equal((await request('/api/bootstrap')).body.backupRecovery.localRollbackAvailable, false);
});

test('unlimited Runner profiles are isolated and dynamically listed', async () => {
  const first = await request('/api/ilands/profiles', 'POST', { label: 'Account one', harness: 'codex' });
  const second = await request('/api/ilands/profiles', 'POST', { label: 'Account two', harness: 'claude-code' });
  assert.equal(first.response.status, 201); assert.equal(second.response.status, 201);
  const listed = await request('/api/ilands/profiles');
  assert.equal(listed.response.status, 200); assert.equal(listed.body.profiles.length, 2);
  assert.notEqual(listed.body.profiles[0].id, listed.body.profiles[1].id);
  const profileDirs = (await import('node:fs/promises')).readdir(path.join(dataDir, 'runner-profiles'));
  assert.equal((await profileDirs).length, 2);
});

test('plugin install, schema input, enablement, receipt, and execution are real', async () => {
  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).response.status, 200);
  const manifest = { schemaVersion: 2, id: 'e2e-plugin', name: 'E2E plugin', version: '1.0.0', entry: 'plugin.mjs', capabilities: [{ id: 'greet', label: 'Greet', risk: 'low', permissions: { files: { readRoots: [], writeRoots: [] }, network: [] }, inputSchema: { type: 'object', properties: { name: { type: 'string', title: 'Name' } }, required: ['name'], additionalProperties: false }, outputSchema: { type: 'object', properties: { hello: { type: 'string' } }, required: ['hello'], additionalProperties: false } }] };
  const files = [{ path: 'plugin.mjs', content: 'export const capabilities={greet:async(input)=>({hello:`Hi ${input.name}`})};' }];
  assert.equal((await request('/api/plugins/install', 'POST', { manifest, files, approved: true })).response.status, 409);
  const installed = await request('/api/plugins/install', 'POST', { manifest, files, approved: true, localOwnerApproved: true });
  assert.equal(installed.response.status, 201);
  assert.match(installed.body.plugin.package.digest, /^sha256:[a-f0-9]{64}$/);
  const enabled = await request('/api/plugins/e2e-plugin/enable', 'PATCH', { enabled: true });
  assert.equal(enabled.response.status, 200);
  const run = await request('/api/plugins/e2e-plugin/run', 'POST', { capability: 'greet', input: { name: 'owner' } });
  assert.equal(run.response.status, 200, JSON.stringify(run.body)); assert.equal(run.body.result.hello, 'Hi owner');
  assert.equal(run.body.receipt.status, 'completed');
  assert.equal(run.body.receipt.action, 'e2e-plugin:greet');
  assert.equal((await request('/api/plugins/e2e-plugin/run', 'POST', { capability: 'greet', input: {} })).response.status, 400);
  for (const capability of [undefined, '', 'unknown']) {
    const rejected = await request('/api/plugins/e2e-plugin/run', 'POST', { capability, input: { name: 'owner' } });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.code, 'INVALID_PLUGIN_CAPABILITY');
  }
  await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'review' });
  const isolated = { schemaVersion: 2, id: 'network-block', name: 'Network boundary', version: '1.0.0', entry: 'plugin.mjs', capabilities: [{ id: 'probe', label: 'Probe', risk: 'high', permissions: { files: { readRoots: [], writeRoots: [] }, network: [] }, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: {}, additionalProperties: true } }] };
  const isolatedFiles = [{ path: 'plugin.mjs', content: "import https from 'node:https'; export const capabilities={probe:async()=>({ok:Boolean(https)})};" }];
  assert.equal((await request('/api/plugins/install', 'POST', { manifest: isolated, files: isolatedFiles, approved: true, localOwnerApproved: true })).response.status, 201);
  assert.equal((await request('/api/plugins/network-block/enable', 'PATCH', { enabled: true })).response.status, 409);
  assert.equal((await request('/api/bootstrap')).body.plugins.find((plugin) => plugin.id === 'network-block').enabled, false);
  assert.equal((await request('/api/plugins/network-block/enable', 'PATCH', { enabled: true, approved: true })).response.status, 200);
  assert.equal((await request('/api/plugins/network-block/run', 'POST', { capability: 'probe', input: {}, approved: true })).response.status, 502);
  await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });

  const secretManifest = { ...manifest, id: 'secret-plugin', name: 'Secret boundary', secrets: [{ id: 'api-token', label: 'API token' }], capabilities: [{ ...manifest.capabilities[0], id: 'inspect-env', label: 'Inspect environment', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: { environment: { type: 'array', items: { type: 'string' } } }, required: ['environment'], additionalProperties: false } }] };
  const secretFiles = [{ path: 'plugin.mjs', content: 'export const capabilities={"inspect-env":async()=>({environment:Object.keys(process.env)})};' }];
  assert.equal((await request('/api/plugins/install', 'POST', { manifest: secretManifest, files: secretFiles, approved: true, localOwnerApproved: true })).response.status, 201);
  assert.equal((await request('/api/plugins/secret-plugin/enable', 'PATCH', { enabled: true })).response.status, 200);
  assert.equal((await request('/api/plugins/secret-plugin/run', 'POST', { capability: 'inspect-env', input: {} })).response.status, 409);
  const secretValue = 'plugin-secret-must-never-leak';
  assert.equal((await request('/api/plugins/secret-plugin/secrets', 'PUT', { secrets: { 'api-token': secretValue }, approved: true })).response.status, 200);
  assert.equal((await request('/api/bootstrap')).body.plugins.find((plugin) => plugin.id === 'secret-plugin').enabled, false,
    'changing protected credentials disables the plugin until it is reviewed and enabled again');
  assert.equal((await request('/api/plugins/secret-plugin/enable', 'PATCH', { enabled: true, approved: true })).response.status, 200);
  const secretRun = await request('/api/plugins/secret-plugin/run', 'POST', { capability: 'inspect-env', input: {} });
  assert.equal(secretRun.response.status, 200, JSON.stringify(secretRun.body));
  assert.deepEqual(secretRun.body.result.environment, []);
  assert.doesNotMatch(JSON.stringify((await request('/api/bootstrap')).body), new RegExp(secretValue));
  assert.doesNotMatch(await readFile(path.join(dataDir, 'control-room.json'), 'utf8'), new RegExp(secretValue));
  assert.doesNotMatch(await readFile(path.join(dataDir, 'vault', 'plugin-secret-plugin-api-token.protected'), 'utf8'), new RegExp(secretValue));
  assert.equal((await request('/api/plugins/secret-plugin/secrets', 'PUT', { secrets: { 'api-token': '' }, approved: true })).response.status, 200);
  assert.equal((await request('/api/plugins/secret-plugin/run', 'POST', { capability: 'inspect-env', input: {} })).response.status, 409);

  const fileManifest = { ...manifest, id: 'file-broker', name: 'File broker', capabilities: [{ ...manifest.capabilities[0], id: 'copy-file', label: 'Copy file', permissions: { files: { readRoots: ['plugin-test/input'], writeRoots: ['plugin-test/output'] }, network: [] }, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: { copied: { type: 'boolean' } }, required: ['copied'], additionalProperties: false } }] };
  const fileSource = 'export const capabilities={"copy-file":async()=>{const value=await hexigrid.files.readText("plugin-test/input/value.txt");await hexigrid.files.writeText("plugin-test/output/value.txt",value);return {copied:true}}};';
  await writeFile(path.join(dataDir, 'workspace', 'plugin-test-input.tmp'), 'unused');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(dataDir, 'workspace', 'plugin-test', 'input'), { recursive: true });
  await writeFile(path.join(dataDir, 'workspace', 'plugin-test', 'input', 'value.txt'), 'brokered');
  assert.equal((await request('/api/plugins/install', 'POST', { manifest: fileManifest, files: [{ path: 'plugin.mjs', content: fileSource }], approved: true, localOwnerApproved: true })).response.status, 201);
  await request('/api/plugins/file-broker/enable', 'PATCH', { enabled: true });
  assert.equal((await request('/api/plugins/file-broker/run', 'POST', { capability: 'copy-file', input: {} })).response.status, 200);
  assert.equal(await readFile(path.join(dataDir, 'workspace', 'plugin-test', 'output', 'value.txt'), 'utf8'), 'brokered');

  const concurrencyManifest = { ...manifest, id: 'concurrency-plugin', name: 'Concurrency guard', capabilities: [{ ...manifest.capabilities[0], id: 'wait', label: 'Wait', limits: { timeoutMs: 3000, concurrency: 1 }, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'], additionalProperties: false } }] };
  const waitSource = 'export const capabilities={wait:async()=>{await new Promise(resolve=>setTimeout(resolve,400));return {done:true}}};';
  await request('/api/plugins/install', 'POST', { manifest: concurrencyManifest, files: [{ path: 'plugin.mjs', content: waitSource }], approved: true, localOwnerApproved: true });
  await request('/api/plugins/concurrency-plugin/enable', 'PATCH', { enabled: true });
  const firstRun = request('/api/plugins/concurrency-plugin/run', 'POST', { capability: 'wait', input: {} });
  await new Promise((resolve) => setTimeout(resolve,75));
  const secondRun = await request('/api/plugins/concurrency-plugin/run', 'POST', { capability: 'wait', input: {} });
  assert.equal(secondRun.response.status, 502);
  assert.match(secondRun.body.error, /concurrency limit/i);
  assert.equal((await firstRun).response.status, 200);

  const tamperManifest = { ...manifest, id: 'tamper-e2e', name: 'Tamper guard' };
  const tamperInstall = await request('/api/plugins/install', 'POST', { manifest: tamperManifest, files, approved: true, localOwnerApproved: true });
  await request('/api/plugins/tamper-e2e/enable', 'PATCH', { enabled: true });
  const tamperPath = path.join(dataDir, 'plugins', ...tamperInstall.body.plugin.installPath.split('/'), 'plugin.mjs');
  await writeFile(tamperPath, 'export const capabilities={greet:async()=>({hello:"changed"})};');
  const tamperedRun = await request('/api/plugins/tamper-e2e/run', 'POST', { capability: 'greet', input: { name: 'owner' } });
  assert.equal(tamperedRun.response.status, 409);
  assert.equal((await request('/api/bootstrap')).body.plugins.find((plugin) => plugin.id === 'tamper-e2e').quarantined, true);

  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signedRaw = { ...manifest, id: 'signed-e2e', name: 'Signed E2E', publisher: { id: 'e2e-publisher', name: 'E2E Publisher', publicKey, signature: 'AA==' } };
  const signedIdentity = buildPackageIdentity(signedRaw, files);
  const signedManifest = { ...signedIdentity.manifest, publisher: { ...signedRaw.publisher, signature: crypto.sign(null, Buffer.from(signedIdentity.digest), keys.privateKey).toString('base64') } };
  const trustPrompt = await request('/api/plugins/install', 'POST', { manifest: signedManifest, files, approved: true });
  assert.equal(trustPrompt.response.status, 409);
  assert.equal(trustPrompt.body.publisherTrustRequired, true);
  assert.equal((await request('/api/plugins/install', 'POST', { manifest: signedManifest, files, approved: true, trustPublisher: true })).response.status, 201);
  assert.equal((await request('/api/bootstrap')).body.pluginPublishers.find((publisher) => publisher.id === 'e2e-publisher').trusted, true);
  assert.equal((await request('/api/plugins/signed-e2e/enable', 'PATCH', { enabled: true })).response.status, 200);
  assert.equal((await request('/api/plugin-publishers/e2e-publisher', 'DELETE', { approved: true })).response.status, 200);
  assert.equal((await request('/api/bootstrap')).body.plugins.find((plugin) => plugin.id === 'signed-e2e').quarantined, true);
  const revokedPublisher = (await request('/api/bootstrap')).body.pluginPublishers.find((publisher) => publisher.id === 'e2e-publisher');
  assert.equal(revokedPublisher?.trusted, false, 'revocation retains an audit tombstone');
  assert.equal(revokedPublisher?.revoked, true, 'revocation remains explicit for future reinstall decisions');

  const state = await request('/api/bootstrap');
  assert.equal(state.body.receipts.some((receipt) => receipt.source === 'plugin' && receipt.status === 'completed'), true);
  assert.equal(state.body.receipts.some((receipt) => receipt.action.startsWith('network-block:') && receipt.status === 'failed'), true);
  assert.equal(state.body.receipts.some((receipt) => receipt.source === 'plugin-broker' && receipt.action === 'file-broker:files.writeText'), true);
});

test('restoring a backup pauses automation and disables installed plugins for review', async () => {
  const agent = await request('/api/agents', 'POST', { name: 'Restore guard', transport: 'local-opencode' });
  const task = await request('/api/tasks', 'POST', { name: 'Restore guard task', agentId: agent.body.agent.id, prompt: 'Do not run during restore.', intervalSeconds: 60, maxRuns: 3 });
  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).response.status, 200);
  assert.equal((await request(`/api/tasks/${task.body.task.id}`, 'PATCH', { status: 'running', approved: true })).response.status, 200);
  const exported = await request('/api/backup/export', 'POST', { passphrase: 'restore-guard-passphrase' });
  assert.equal(exported.response.status, 200);
  const restored = await request('/api/backup/import', 'POST', { envelope: exported.body.envelope, passphrase: 'restore-guard-passphrase', confirmReplace: true });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
  const current = await request('/api/bootstrap');
  assert.equal(current.body.plugins.find((plugin) => plugin.id === 'e2e-plugin').enabled, false);
  assert.equal(current.body.tasks.find((item) => item.id === task.body.task.id).status, 'paused');
});

test('MCP discovery, capability gating, and invocation run through the API', async () => {
  assert.equal((await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).response.status, 200);
  const publishedTools = [
    { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
    { name: 'fail', description: 'Fail safely', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  ];
  const service = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'e2e-http-mcp', version: '1' } };
    if (rpc.method === 'tools/list') result = { tools: publishedTools };
    if (rpc.method === 'tools/call' && rpc.params?.name === 'echo') result = { content: [{ type: 'text', text: rpc.params.arguments.text }] };
    res.setHeader('content-type', 'application/json');
    if (rpc.method === 'tools/call' && rpc.params?.name === 'fail') res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'safe fixture failure' } }));
    else res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(8787, '127.0.0.1', resolve); });
  try {
    const added = await request('/api/mcp', 'POST', { name: 'E2E tools', transport: 'http', url: 'http://127.0.0.1:8787/mcp', secrets: { bearer: 'secret-that-must-not-return' }, approved: true });
    assert.equal(added.response.status, 201);
    assert.doesNotMatch(JSON.stringify(added.body), /secret-that-must-not-return|127\.0\.0\.1:8787/);
    const id = added.body.server.id;
    const tested = await request(`/api/mcp/${id}/test`, 'POST', { approved: true });
    assert.equal(tested.response.status, 200); assert.equal(tested.body.server.tools[0].name, 'echo');
    await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'review' });
    const reviews = Object.fromEntries(tested.body.server.tools.map((tool) => [tool.name, { capability: 'run_tools', risk: 'high', approved: true }]));
    const beforeDeniedReview = (await request('/api/mcp')).body.servers.find(server => server.id === id).toolGrants;
    assert.equal((await request(`/api/mcp/${id}/enable`, 'PATCH', { enabled: true, toolGrants: reviews })).response.status, 409);
    assert.deepEqual((await request('/api/mcp')).body.servers.find(server => server.id === id).toolGrants, beforeDeniedReview, 'approval-required enable cannot mutate standing tool grants');
    assert.equal((await request('/api/mcp')).body.servers.find((server) => server.id === id).enabled, false);
    await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    assert.equal((await request(`/api/mcp/${id}/enable`, 'PATCH', { enabled: true, toolGrants: reviews })).response.status, 200);
    const beforePlan = (await request('/api/mcp')).body.servers.find(server => server.id === id);
    await request('/api/settings', 'PATCH', { workMode: 'plan', approvalPolicy: 'full' });
    const changedReviews = Object.fromEntries(tested.body.server.tools.map(tool => [tool.name, { capability: 'external_write', risk: 'critical', approved: true }]));
    assert.equal((await request(`/api/mcp/${id}/enable`, 'PATCH', { enabled: true, toolGrants: changedReviews, approved: true })).response.status, 403);
    const afterPlan = (await request('/api/mcp')).body.servers.find(server => server.id === id);
    assert.deepEqual(afterPlan.toolGrants, beforePlan.toolGrants); assert.equal(afterPlan.enabled, true);
    await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    const called = await request(`/api/mcp/${id}/call`, 'POST', { tool: 'echo', input: { text: 'hello' }, approved: true });
    assert.equal(called.response.status, 200); assert.equal(called.body.result.content[0].text, 'hello');
    const failed = await request(`/api/mcp/${id}/call`, 'POST', { tool: 'fail', input: {}, approved: true });
    assert.equal(failed.response.status, 502); assert.doesNotMatch(JSON.stringify(failed.body), /secret-that-must-not-return/);
  } finally { await new Promise((resolve) => service.close(resolve)); }

  const local = await request('/api/mcp', 'POST', { name: 'Isolated local tools', transport: 'stdio', image: `example.invalid/mcp@sha256:${'b'.repeat(64)}`, command: 'server', workspaceAccess: 'none', approved: true });
  assert.equal(local.response.status, 201);
  assert.equal(local.body.server.connectionLocation, 'rootless-podman');
  assert.equal(local.body.server.command, undefined);
  const refused = await request(`/api/mcp/${local.body.server.id}/test`, 'POST', { approved: true });
  assert.equal(refused.response.status, 503);
  assert.match(refused.body.error, /Podman is not installed/);
  assert.equal((await request('/api/mcp')).body.servers.find((server) => server.id === local.body.server.id).enabled, false);
});

test('model switching supports a configured provider per agent', async () => {
  const modelServer = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: `model:${body.model}` } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  try {
    const defaultAgent = await request('/api/agents', 'POST', { name: 'Provider-neutral default' });
    assert.equal(defaultAgent.response.status, 201);
    assert.equal(defaultAgent.body.agent.transport, 'local-opencode');
    assert.equal(defaultAgent.body.agent.status, 'local_ready');
    assert.equal(defaultAgent.body.agent.accountLabel, 'New agent');
    assert.equal(defaultAgent.body.agent.learnFromConversations, true);
    const invalidTransport = await request('/api/agents', 'POST', { name: 'External profile', transport: 'agent-link' });
    assert.equal(invalidTransport.response.status, 400);
    assert.match(invalidTransport.body.error, /pair an existing external agent with a HexiGrid Link invitation/);

    const provider = await request('/api/providers', 'POST', { name: 'E2E model', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, models: 'model-one\nmodel-two', apiStyle: 'openai-chat', apiKey: 'secret-that-must-not-return' });
    assert.equal(provider.response.status, 201);
    assert.doesNotMatch(JSON.stringify(provider.body), /secret-that-must-not-return/);
    assert.doesNotMatch(JSON.stringify((await request('/api/bootstrap')).body), /secret-that-must-not-return/);
    const agent = await request('/api/agents', 'POST', { name: 'Switchable', transport: 'local-opencode', model: `provider:${provider.body.provider.id}:model-two` });
    const room = await request('/api/rooms', 'POST', { name: 'Model test' });
    const reply = await request(`/api/rooms/${room.body.room.id}/messages`, 'POST', { content: 'hello', agentIds: [agent.body.agent.id] });
    assert.equal(reply.body.replies[0].content, 'model:model-two');
    assert.equal(reply.body.replies[0].transport, 'hexigrid-local-chat');
    assert.equal(reply.body.replies[0].delivery, 'local-only');

    const linked = await request('/api/agents', 'POST', { name: 'Runner-linked profile', transport: 'ilands-runner', model: `provider:${provider.body.provider.id}:model-one`, ilandsAgentId: 'public-test-agent-id', externalEmail: 'agent@example.test' });
    assert.equal(linked.body.agent.transport, 'ilands-runner');
    assert.equal(linked.body.agent.status, 'not_connected');
    assert.equal(linked.body.agent.learnFromConversations, false);
    assert.equal(linked.body.agent.externalEmail, 'agent@example.test');
    const emailReceipt = await request('/api/live/email-receipt', 'POST', { agentId: linked.body.agent.id, action: 'send', status: 'completed' });
    assert.equal(emailReceipt.response.status, 201);
    assert.equal(emailReceipt.body.receipt.action, 'agent_email:send');
    assert.equal(emailReceipt.body.receipt.agentId, linked.body.agent.id);
    assert.doesNotMatch(JSON.stringify(emailReceipt.body.receipt), /agent@example\.test/);
    const linkedRoom = await request('/api/rooms', 'POST', { name: 'Runner boundary test' });
    const linkedReply = await request(`/api/rooms/${linkedRoom.body.room.id}/messages`, 'POST', { content: 'Does this go to iLands?', agentIds: [linked.body.agent.id] });
    assert.equal(linkedReply.body.replies[0].content, 'model:model-one');
    assert.equal(linkedReply.body.replies[0].transport, 'hexigrid-local-chat');
    assert.equal(linkedReply.body.replies[0].delivery, 'local-only');
    assert.deepEqual(linkedReply.body.replies[0].connector, { id: 'ilands', linked: true, directMessaging: false });
    const boundary = await request('/api/bootstrap');
    assert.equal(boundary.body.bridge.dashboardDirectMessaging, false);
    assert.equal(boundary.body.bridge.runnerMessaging, false);
    assert.equal(boundary.body.bridge.dashboardChatTransport, 'local-only');
    assert.equal(boundary.body.bridge.liveMedia.supported, false);
    assert.equal(boundary.body.bridge.liveMedia.transport, 'runner-native');
    assert.equal(boundary.body.bridge.externalAgentChannels.emailBridge, true);
    assert.equal(boundary.body.bridge.externalAgentChannels.agentAuthoredTools, true);
  } finally { await new Promise((resolve) => modelServer.close(resolve)); }
});

test('a local model outage can recover through a second no-cost provider and return to the first', async () => {
  let primaryAvailable = true;
  const makeModelServer = label => http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (label === 'Primary local' && !primaryAvailable) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'synthetic local outage' }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: `${label}:${body.model}` } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
  });
  const primaryServer = makeModelServer('Primary local');
  const backupServer = makeModelServer('Backup local');
  await Promise.all([primaryServer, backupServer].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  try {
    const addLocalProvider = (name, server, model) => request('/api/providers', 'POST', {
      name,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      models: model,
      apiStyle: 'openai-chat'
    });
    const primary = await addLocalProvider('QA primary local', primaryServer, 'cpu-primary');
    const backup = await addLocalProvider('QA backup local', backupServer, 'cpu-backup');
    assert.equal(primary.response.status, 201);
    assert.equal(backup.response.status, 201);
    assert.equal(primary.body.provider.local, true);
    assert.equal(backup.body.provider.local, true);

    const agent = await request('/api/agents', 'POST', {
      name: 'Local recovery fixture', transport: 'local-opencode',
      model: `provider:${primary.body.provider.id}:cpu-primary`,
      useMemories: false, learnFromConversations: false
    });
    const room = await request('/api/rooms', 'POST', { name: 'Local recovery fixture' });
    const send = content => request(`/api/rooms/${room.body.room.id}/messages`, 'POST', {
      content, agentIds: [agent.body.agent.id]
    });

    const first = await send('Primary online');
    assert.equal(first.body.replies[0].content, 'Primary local:cpu-primary');

    primaryAvailable = false;
    const outage = await send('Primary unavailable');
    assert.equal(outage.response.status, 200);
    assert.equal(outage.body.replies[0].role, 'system');
    assert.match(outage.body.replies[0].content, /Provider request failed \(503\)/);

    const switched = await request(`/api/agents/${agent.body.agent.id}`, 'PATCH', {
      model: `provider:${backup.body.provider.id}:cpu-backup`
    });
    assert.equal(switched.response.status, 200);
    assert.equal(switched.body.agent.model, `provider:${backup.body.provider.id}:cpu-backup`);
    const backupReply = await send('Use backup');
    assert.equal(backupReply.body.replies[0].content, 'Backup local:cpu-backup');

    primaryAvailable = true;
    const returned = await request(`/api/agents/${agent.body.agent.id}`, 'PATCH', {
      model: `provider:${primary.body.provider.id}:cpu-primary`
    });
    assert.equal(returned.response.status, 200);
    const recovered = await send('Primary recovered');
    assert.equal(recovered.body.replies[0].content, 'Primary local:cpu-primary');
  } finally {
    await Promise.all([primaryServer, backupServer].map(server => new Promise(resolve => server.close(resolve))));
  }
});

test('task scheduling can be started and cancelled while the model is working', async () => {
  const slowServer = http.createServer(async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 2500)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
  });
  await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
  try {
    const provider = await request('/api/providers', 'POST', { name: 'Slow model', baseUrl: `http://127.0.0.1:${slowServer.address().port}/v1`, models: 'slow' });
    const agent = await request('/api/agents', 'POST', { name: 'Task runner', transport: 'local-opencode', model: `provider:${provider.body.provider.id}:slow` });
    const task = await request('/api/tasks', 'POST', { name: 'Cancellable', agentId: agent.body.agent.id, prompt: 'wait', maxRuns: 1 });
    const runPromise = request(`/api/tasks/${task.body.task.id}/run`, 'POST', { approved: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const cancelled = await request(`/api/tasks/${task.body.task.id}/cancel`, 'POST', {});
    assert.equal(cancelled.response.status, 200);
    const result = await runPromise;
    assert.ok([200, 502].includes(result.response.status));
    const current = await request('/api/bootstrap');
    const run = current.body.taskRuns.find((item) => item.taskId === task.body.task.id);
    assert.equal(run.status, 'cancelled');
  } finally { await new Promise((resolve) => slowServer.close(resolve)); }
});

test('autonomous task failures use bounded retry backoff', async () => {
  const failingServer = http.createServer((req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise((resolve) => failingServer.listen(0, '127.0.0.1', resolve));
  try {
    const provider = await request('/api/providers', 'POST', { name: 'Failing model', baseUrl: `http://127.0.0.1:${failingServer.address().port}/v1`, models: 'fails' });
    const agent = await request('/api/agents', 'POST', { name: 'Retry target', transport: 'local-opencode', model: `provider:${provider.body.provider.id}:fails` });
    const task = await request('/api/tasks', 'POST', { name: 'Retrying task', agentId: agent.body.agent.id, prompt: 'Retry once.',
      intervalSeconds: 60, maxRuns: 2, maxRetries: 1 });
    assert.equal((await request(`/api/tasks/${task.body.task.id}`, 'PATCH', { status: 'running', approved: true })).response.status, 200);
    const run = await request(`/api/tasks/${task.body.task.id}/run`, 'POST', { approved: true });
    assert.equal(run.response.status, 502);
    const current = await request('/api/tasks');
    const saved = current.body.tasks.find((item) => item.id === task.body.task.id);
    assert.equal(saved.status, 'running'); assert.equal(saved.retryCount, 1); assert.equal(saved.maxRetries, 1); assert.ok(saved.nextRunAt);
  } finally { await new Promise((resolve) => failingServer.close(resolve)); }
});

test('emergency stop pauses queued autonomous work and records a receipt', async () => {
  await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
  const agent = await request('/api/agents', 'POST', { name: 'Emergency target', transport: 'local-opencode' });
  const task = await request('/api/tasks', 'POST', { name: 'Emergency task', agentId: agent.body.agent.id, prompt: 'Do one bounded step.', intervalSeconds: 60, maxRuns: 3 });
  assert.equal((await request(`/api/tasks/${task.body.task.id}`, 'PATCH', { status: 'running', approved: true })).response.status, 200);
  const stopped = await request('/api/emergency/stop', 'POST', {});
  assert.equal(stopped.response.status, 200);
  assert.ok(stopped.body.pausedTasks >= 1);
  const current = await request('/api/tasks');
  assert.equal(current.body.tasks.find((item) => item.id === task.body.task.id).status, 'paused');
  const bootstrap = await request('/api/bootstrap');
  assert.equal(bootstrap.body.receipts.some((receipt) => receipt.action === 'emergency-stop' && receipt.status === 'completed'), true);
});

test('browser mutations require the CSRF token while non-browser API clients remain usable', async () => {
  const status = await request('/api/auth/status');
  const csrf = status.response.headers.get('set-cookie').match(/hexigrid_csrf=([^;]+)/)?.[1];
  assert.ok(csrf);
  const denied = await request('/api/settings', 'PATCH', { workMode: 'plan' }, { cookie: `hexigrid_csrf=${csrf}`, 'sec-fetch-site': 'same-origin' });
  assert.equal(denied.response.status, 403);
  const accepted = await request('/api/settings', 'PATCH', { workMode: 'plan' }, { cookie: `hexigrid_csrf=${csrf}`, 'sec-fetch-site': 'same-origin', 'x-hexigrid-csrf': decodeURIComponent(csrf) });
  assert.equal(accepted.response.status, 200);
});

test('local authentication, recovery, and session revocation work end to end', async () => {
  const setup = await request('/api/auth/setup', 'POST', { password: 'e2e-local-passphrase' });
  assert.equal(setup.response.status, 200); assert.match(setup.body.recoveryCode, /-/);
  const cookie = setup.response.headers.get('set-cookie').match(/hexigrid_session=[^;]+/)?.[0]; assert.ok(cookie);
  const sessions = await request('/api/auth/sessions', 'GET', undefined, { cookie });
  assert.equal(sessions.response.status, 200); assert.equal(sessions.body.sessions.length, 1);
  const repeatedLogin = await request('/api/auth/login', 'POST', { password: 'e2e-local-passphrase' }, { cookie });
  assert.equal(repeatedLogin.response.status, 200);
  assert.match(repeatedLogin.response.headers.get('set-cookie'), new RegExp(cookie.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const sessionsAfterRefresh = await request('/api/auth/sessions', 'GET', undefined, { cookie });
  assert.equal(sessionsAfterRefresh.body.sessions.length, 1);
  const locked = await request('/api/bootstrap'); assert.equal(locked.response.status, 401);
  const recovered = await request('/api/auth/recover', 'POST', { recoveryCode: setup.body.recoveryCode, password: 'e2e-replacement-passphrase' });
  assert.equal(recovered.response.status, 200); assert.ok(recovered.body.recoveryCode);
  const oldSession = await request('/api/bootstrap', 'GET', undefined, { cookie }); assert.equal(oldSession.response.status, 401);
  const login = await request('/api/auth/login', 'POST', { password: 'e2e-replacement-passphrase' }); assert.equal(login.response.status, 200);
});
