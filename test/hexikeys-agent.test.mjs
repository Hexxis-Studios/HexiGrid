import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { OutboundCompanionConnection } from '../lib/companion-client.mjs';

async function port() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

test('ExampleAgent signed Link can request a metadata-only HexiKeys capture through the protected bridge', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const keysRoot = path.resolve(root, '..', 'password manager');
  const python = path.join(keysRoot, '.venv', 'Scripts', 'python.exe');
  try { await access(python); } catch { t.skip('Standalone HexiKeys test environment is unavailable.'); return; }
  const data = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-addon-qa-'));
  const ownerPort = await port();
  const relayPort = await port();
  const origin = `http://127.0.0.1:${ownerPort}`;
  const descriptorPath = path.join(data, 'pairing', 'hexikeys-pairing.dpapi');
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
    ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: String(ownerPort), HEXIGRID_AGENT_RELAY_PORT: String(relayPort),
    HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`, HEXIGRID_DATA_DIR: data,
    HEXIGRID_HEXIKEYS_PAIRING_DESCRIPTOR: descriptorPath, OPENCODE_CLI: 'missing-addon-test-model'
  } });
  let agent, liveVault;
  t.after(async () => {
    await agent?.close();
    if (liveVault) {
      liveVault.stdin.end();
      if (liveVault.exitCode === null) await new Promise(resolve => liveVault.once('exit', resolve));
    }
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    await rm(data, { recursive: true, force: true });
  });
  const cookies = new Map();
  async function owner(route, method = 'GET', body) {
    const response = await fetch(origin + route, { method, headers: {
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...(body ? { 'content-type': 'application/json', 'x-hexigrid-csrf': decodeURIComponent(cookies.get('hexigrid_csrf') || '') } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0]; const split = pair.indexOf('=');
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return { status: response.status, body: await response.json() };
  }
  let started = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(child.exitCode, null, 'Disposable backend exited before startup.');
    try { if ((await fetch(origin + '/api/auth/status')).ok) { started = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(started, true);
  const asset = await fetch(origin + '/hexikeys-ui.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(await asset.text(), /data-hexikeys-addon/);
  assert.equal((await owner('/api/addons/hexikeys')).status, 403);
  await owner('/api/auth/status');
  assert.equal((await owner('/api/auth/setup', 'POST', { password: 'synthetic-addon-qa-passphrase' })).status, 200);
  assert.equal((await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
  const manifest = { schemaVersion: 2, id: 'vault-reference-qa', name: 'Disposable vault reference', version: '1.0.0', entry: 'plugin.mjs', secrets: [{ id: 'api-key', label: 'Synthetic token', required: true }], capabilities: [{ id: 'request', label: 'Request', risk: 'high', permissions: { files: { readRoots: [], writeRoots: [] }, network: [{ origin: 'https://example.invalid', pathPrefix: '/v1/', methods: ['POST'], secretHeaders: [{ secret: 'api-key', header: 'authorization', prefix: 'Bearer ' }] }] }, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: {}, additionalProperties: true } }] };
  assert.equal((await owner('/api/plugins/install', 'POST', { manifest, files: [{ path: 'plugin.mjs', content: 'export const capabilities={request:async()=>({})};' }], localOwnerApproved: true })).status, 201);
  const referenceFields = { capability: 'request', secretId: 'api-key' };
  const ownerScope = await owner('/api/plugins/vault-reference-qa/hexikeys-scope', 'POST', referenceFields);
  assert.equal(ownerScope.status, 200);
  assert.equal(ownerScope.body.recipe.connectorId, manifest.id);
  assert.equal(ownerScope.body.recipe.origin, 'https://example.invalid');
  const missingGrant = await owner('/api/plugins/vault-reference-qa/hexikeys-reference', 'POST', { ...referenceFields, grantId: 'a'.repeat(32) });
  assert.equal(missingGrant.status, 400);
  assert.match(missingGrant.body.error, /unavailable/i);
  const absent = await owner('/api/addons/hexikeys');
  assert.equal(absent.status, 200);
  assert.equal(absent.body.addon.paired, false);
  assert.equal((await owner('/api/addons/hexikeys/connect', 'POST', { secret: 'synthetic-should-not-be-accepted' })).status, 400);
  assert.equal((await owner('/api/addons/hexikeys/connect', 'POST', { descriptorPath })).status, 400);
  assert.equal((await owner('/api/addons/hexikeys/consume', 'POST', {})).status, 404);
  assert.equal((await owner('/api/addons/hexikeys/open', 'POST', { command: 'forbidden' })).status, 400);
  await new Promise((resolve, reject) => {
    const fixture = spawn(python, ['-c', 'import sys; from pathlib import Path; from vault_pairing import restore_pairing_descriptor; restore_pairing_descriptor(Path(sys.stdin.read()), pipe_id="hexikeys-"+"a"*32, hmac_key=bytes.fromhex("b"*64))'], { cwd: keysRoot, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    fixture.on('error', reject);
    fixture.on('exit', code => code === 0 ? resolve() : reject(new Error('Synthetic protected descriptor setup failed.')));
    fixture.stdin.end(path.join(data, 'pairing'));
  });
  const connected = await owner('/api/addons/hexikeys/connect', 'POST', {});
  assert.equal(connected.status, 200);
  assert.deepEqual([connected.body.addon.paired, connected.body.addon.available], [true, false]);
  assert.doesNotMatch(JSON.stringify(connected.body), /hmacKey|pipeId|bbbbbbbb|synthetic-should-not/);
  assert.equal((await owner('/api/network/agent-relay', 'POST', { provider: 'stable', approved: true })).status, 200);
  const invited = await owner('/api/agent-links/invites', 'POST', { capabilities: ['messages', 'desktop-view', 'desktop-control'] });
  assert.equal(invited.status, 201);
  agent = new OutboundCompanionConnection({ inviteUrl: invited.body.companionInvitationUrl, identity: { name: 'ExampleAgent', accountLabel: 'ExampleAgent local agent' }, capabilities: ['messages', 'desktop-view', 'desktop-control'], automaticControl: false });
  await agent.connect();
  const paired = await agent.pair();
  const statusPath = '/agent-link/v1/addons/hexikeys';
  const scopedDenied = await agent.linkRequest(statusPath);
  assert.equal(scopedDenied.status, 403, scopedDenied.body.error);
  assert.equal((await agent.linkRequest('/agent-link/v1/plugins/vault-reference-qa/hexikeys-scope', { method: 'POST', body: referenceFields })).status, 403);
  assert.equal((await owner(`/api/agent-links/${paired.connection.id}/trust`, 'PATCH', { trustLevel: 'owner', approved: true })).status, 200);
  assert.equal((await agent.linkRequest(statusPath)).status, 403);
  assert.equal((await owner('/api/desktop-bridge/start', 'POST', { linkId: paired.connection.id, viewGranted: true, controlGranted: true, approved: true })).status, 200);
  assert.equal((await agent.linkRequest(statusPath)).status, 200);
  const agentScope = await agent.linkRequest('/agent-link/v1/plugins/vault-reference-qa/hexikeys-scope', { method: 'POST', body: referenceFields });
  assert.equal(agentScope.status, 200);
  assert.notEqual(agentScope.body.recipe.taskId, ownerScope.body.recipe.taskId);
  const delegatedScope = await owner('/api/plugins/vault-reference-qa/hexikeys-scope', 'POST', { ...referenceFields, recipientLinkId: paired.connection.id });
  assert.equal(delegatedScope.status, 200);
  assert.equal(delegatedScope.body.recipe.taskId, agentScope.body.recipe.taskId);
  assert.equal((await agent.linkRequest('/agent-link/v1/plugins/vault-reference-qa/hexikeys-scope', { method: 'POST', body: { ...referenceFields, recipientLinkId: paired.connection.id } })).status, 400);
  assert.equal((await agent.linkRequest('/agent-link/v1/plugins/vault-reference-qa/hexikeys-reference', { method: 'POST', body: { ...referenceFields, grantId: null } })).status, 200);
  assert.equal((await agent.linkRequest('/agent-link/v1/addons/hexikeys/connect', { method: 'POST', body: { secrets: { value: 'synthetic' } } })).status, 400);
  // An actual authenticated Windows pipe, using only disposable synthetic data.
  // This covers the positive binding path rather than merely rejecting missing grants.
  const fixtureScript = `
import sys, json, time
from pathlib import Path
from vault_bridge import VaultBridgeServer
from vault_references import create_reference_grant
from vault_store import save_vault
config = json.loads(sys.stdin.readline())
capture_path = Path(config["data"]) / "bridge-capture.json"
vault = {"entries": [{"id": "qa-entry", "title": "Synthetic QA", "fields": [{"label": "Token", "value": "SYNTHETIC-ONLY-route-token", "private": True}]}]}
ids = []
for recipe in config["recipes"]:
    vault, grant_id = create_reference_grant(vault, entry_id="qa-entry", field_index=0, connector_id=recipe["connectorId"], capability_id=recipe["capabilityId"], task_id=recipe["taskId"], origin=recipe["origin"], path_prefix=recipe["pathPrefix"], methods=recipe["methods"], header=recipe["header"], prefix=recipe["prefix"], expires_at=int(time.time())+600, max_uses=2)
    ids.append(grant_id)
vault_path = Path(config["data"]) / "synthetic-vault.json"
save_vault(vault_path, vault, "synthetic-only-fixture-password")
def persist(candidate):
    global vault
    save_vault(vault_path, candidate, "synthetic-only-fixture-password")
    vault = candidate
def capture(request):
    capture_path.write_text(json.dumps(request), encoding="utf-8")
    return {"opened": True}
bridge = VaultBridgeServer("hexikeys-"+"a"*32, bytes.fromhex("b"*64), get_status=lambda: {"available": True, "unlocked": True}, get_vault=lambda: vault, persist_candidate=persist, request_new_item=capture)
bridge.start()
print(json.dumps({"grants": ids}), flush=True)
sys.stdin.read()
bridge.stop()
bridge.wait_closed(5)
`;
  liveVault = spawn(python, ['-c', fixtureScript], { cwd: path.join(root, 'integrations', 'hexikeys'), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: liveVault.stdout });
  const ready = new Promise((resolve, reject) => {
    lines.once('line', line => { try { resolve(JSON.parse(line)); } catch { reject(new Error('Synthetic vault fixture failed.')); } });
    liveVault.once('error', reject);
    liveVault.once('exit', () => reject(new Error('Synthetic vault fixture exited before readiness.')));
  });
  liveVault.stdin.write(JSON.stringify({ recipes: [ownerScope.body.recipe, agentScope.body.recipe], data }) + '\n');
  const fixture = await ready;
  const available = await owner('/api/addons/hexikeys');
  assert.deepEqual([available.body.addon.available, available.body.addon.unlocked], [true, true]);
  assert.equal((await owner('/api/plugins/vault-reference-qa/hexikeys-reference', 'POST', { ...referenceFields, grantId: fixture.grants[0] })).status, 200);
  assert.equal((await agent.linkRequest('/agent-link/v1/plugins/vault-reference-qa/hexikeys-reference', { method: 'POST', body: { ...referenceFields, grantId: fixture.grants[0] } })).status, 400, 'Owner grants cannot be rebound to an agent actor.');
  assert.equal((await agent.linkRequest('/agent-link/v1/plugins/vault-reference-qa/hexikeys-reference', { method: 'POST', body: { ...referenceFields, grantId: fixture.grants[1] } })).status, 200);
  assert.equal(paired.connection.identity.name, 'ExampleAgent');
  const capture = { title: 'ExampleAgent synthetic integration', category: 'API key', fieldLabel: 'API token' };
  const capturePath = '/agent-link/v1/addons/hexikeys/request-capture';
  const ownerCapture = await owner('/api/addons/hexikeys/request-capture', 'POST', capture);
  assert.equal(ownerCapture.status, 200);
  assert.deepEqual(ownerCapture.body, { opened: true });
  const agentCapture = await agent.linkRequest(capturePath, { method: 'POST', body: capture });
  assert.equal(agentCapture.status, 200);
  assert.deepEqual(agentCapture.body, { opened: true });
  const bridgeCapture = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(data, 'bridge-capture.json'), 'utf8'));
  assert.deepEqual({ title: bridgeCapture.title, category: bridgeCapture.category, fieldLabel: bridgeCapture.fieldLabel }, capture);
  assert.match(bridgeCapture.requestedBy, /^Owner agent Link [a-f0-9]{8}$/);
  assert.equal(bridgeCapture.requestedBy, `Owner agent Link ${paired.connection.id.slice(-8)}`);
  assert.equal(Object.hasOwn(bridgeCapture, 'value'), false);
  assert.equal((await agent.linkRequest(capturePath, { method: 'POST', body: { ...capture, value: 'forbidden-secret' } })).status, 400);
  assert.equal((await agent.linkRequest(capturePath, { method: 'POST', body: { ...capture, requestedBy: 'forged owner' } })).status, 400);
  assert.equal((await owner('/api/addons/hexikeys/request-capture', 'POST', { ...capture, category: 'Unsupported' })).status, 400);
  await owner('/api/settings', 'PATCH', { workMode: 'plan', approvalPolicy: 'full' });
  assert.equal((await agent.linkRequest(capturePath, { method: 'POST', body: capture })).status, 403);
  assert.equal((await agent.linkRequest('/agent-link/v1/plugins/vault-reference-qa/hexikeys-reference', { method: 'POST', body: { ...referenceFields, grantId: null } })).status, 403);
  assert.equal((await owner('/api/addons/hexikeys/open', 'POST', {})).status, 403);
  assert.equal((await agent.linkRequest('/agent-link/v1/addons/hexikeys/open', { method: 'POST', body: {} })).status, 403);
  assert.equal((await agent.linkRequest('/agent-link/v1/addons/hexikeys/disconnect', { method: 'POST', body: {} })).status, 403);
  await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
  const disconnected = await agent.linkRequest('/agent-link/v1/addons/hexikeys/disconnect', { method: 'POST', body: {} });
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.body.addon.paired, false);
  const bootstrap = await owner('/api/bootstrap');
  const visibleOutput = JSON.stringify({ receipts: bootstrap.body.receipts, status: available.body, asset: await (await fetch(origin + '/hexikeys-ui.js')).text() });
  assert.match(visibleOutput, /Opened an owner-reviewed private item form/);
  assert.doesNotMatch(visibleOutput, /hmacKey|bbbbbbbb|SYNTHETIC-ONLY-route-token|ExampleAgent synthetic integration|API token|forbidden-secret/);
  if (process.env.HEXIGRID_ADDON_VISUAL_QA === '1') {
    process.stdout.write(`Disposable addon visual QA: ${origin}\n`);
    process.stdout.write('Synthetic login: synthetic-addon-qa-passphrase. Enter stop to clean up.\n');
    await new Promise(resolve => {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', resolve);
      process.stdin.resume();
    });
    process.stdin.pause();
  }
});
