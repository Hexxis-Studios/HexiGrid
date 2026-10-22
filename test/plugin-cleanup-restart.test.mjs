import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, rename, access } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { buildPackageIdentity } from '../lib/plugin-security.mjs';

test('plugin and publisher cleanup denial survives real server restart and recovers', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-cleanup-restart-'));
  const root = path.resolve(import.meta.dirname, '..');
  const origin = 'http://127.0.0.1:44808';
  let child;
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(origin + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const stop = async () => {
    if (child && child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
  };
  const start = async () => {
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
      ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: '44808', HEXIGRID_AGENT_RELAY_PORT: '44809',
      HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1:44809', HEXIGRID_DATA_DIR: dataDir, OPENCODE_CLI: 'missing-restart-qa-model'
    } });
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw Error('Disposable cleanup host failed to start.');
      try { if ((await fetch(origin)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Disposable cleanup host did not become ready.');
  };
  const collision = async id => {
    const target = path.join(dataDir, 'vault', id + '.protected');
    await rename(target, target + '.qa-original'); await mkdir(target);
    return async () => { await rm(target, { recursive: true }); await rename(target + '.qa-original', target); };
  };
  try {
    await start();
    assert.equal((await request('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
    const manifest = { schemaVersion: 2, id: 'restart-calculator', name: 'Restart QA', version: '1.0.0', entry: 'plugin.mjs', secrets: [{ id: 'qa-key', label: 'QA key', required: false }], capabilities: [{ id: 'calculate', label: 'Calculate', risk: 'low', permissions: { files: { readRoots: [], writeRoots: [] }, network: [] }, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false } }] };
    const files = [{ path: 'plugin.mjs', content: 'export const capabilities={calculate:async()=>({answer:4})};' }];
    assert.equal((await request('/api/plugins/install', 'POST', { manifest, files, localOwnerApproved: true })).status, 201);
    await request('/api/plugins/restart-calculator/secrets', 'PUT', { secrets: { 'qa-key': 'public-synthetic-key' } });
    const repairPlugin = await collision('plugin-restart-calculator-qa-key');
    assert.equal((await request('/api/plugins/restart-calculator', 'DELETE', {})).status, 503);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = { ...manifest, id: 'restart-publisher-calculator', secrets: [], publisher: { id: 'restart-publisher', name: 'Restart publisher', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), signature: Buffer.from('pending').toString('base64') } };
    const identity = buildPackageIdentity(raw, files);
    const signed = { ...raw, package: identity.manifest.package, publisher: { ...raw.publisher, signature: sign(null, Buffer.from(identity.digest), privateKey).toString('base64') } };
    assert.equal((await request('/api/plugins/install', 'POST', { manifest: signed, files, trustPublisher: true })).status, 201);
    const repairPublisher = await collision('plugin-publisher-restart-publisher');
    assert.equal((await request('/api/plugin-publishers/restart-publisher', 'DELETE', {})).status, 503);
    const unavailable = { ...manifest, id: 'unavailable-calculator' };
    assert.equal((await request('/api/plugins/install', 'POST', { manifest: unavailable, files, localOwnerApproved: true })).status, 201);
    await request('/api/plugins/unavailable-calculator/secrets', 'PUT', { secrets: { 'qa-key': 'public-synthetic-key' } });
    await request('/api/plugins/unavailable-calculator/enable', 'PATCH', { enabled: true });
    const repairUnavailable = await collision('plugin-unavailable-calculator-qa-key');
    await stop(); await start();
    const standing = (await request('/api/bootstrap')).body;
    assert.equal(standing.plugins.find(item => item.id === manifest.id).removalPending, true);
    assert.equal(standing.plugins.find(item => item.id === manifest.id).enabled, false);
    const publisher = standing.pluginPublishers.find(item => item.id === raw.publisher.id);
    assert.equal(publisher.revoked, true); assert.equal(publisher.cleanupPending, true); assert.equal(publisher.trusted, false);
    assert.equal(standing.plugins.find(item => item.id === raw.id).quarantined, true);
    assert.equal((await request('/api/plugins/restart-calculator/enable', 'PATCH', { enabled: true })).status, 409);
    assert.equal((await request('/api/plugins/restart-publisher-calculator/enable', 'PATCH', { enabled: true })).status, 409);
    const unavailableStanding = standing.plugins.find(item => item.id === unavailable.id);
    assert.equal(unavailableStanding.enabled, false);
    assert.match(unavailableStanding.credentialError, /Protected credentials are unavailable/);
    assert.equal((await request('/api/plugins/unavailable-calculator/enable', 'PATCH', { enabled: true })).status, 409);
    await repairUnavailable();
    assert.equal((await request('/api/plugins/unavailable-calculator/secrets', 'PUT', { secrets: { 'qa-key': 'public-synthetic-repaired-key' } })).body.plugin.credentialError, '');
    assert.equal((await request('/api/plugins/unavailable-calculator/enable', 'PATCH', { enabled: true })).status, 200);
    assert.equal((await request('/api/plugins/unavailable-calculator/run', 'POST', { capability: 'calculate', input: {} })).body.result.answer, 4);
    await repairPlugin(); await repairPublisher();
    assert.equal((await request('/api/plugins/restart-calculator', 'DELETE', {})).status, 200);
    assert.equal((await request('/api/plugin-publishers/restart-publisher', 'DELETE', {})).status, 200);
    await assert.rejects(access(path.join(dataDir, 'vault', 'plugin-publisher-restart-publisher.protected')), { code: 'ENOENT' });
    await stop(); await start();
    const recovered = (await request('/api/bootstrap')).body;
    assert.equal(recovered.plugins.some(item => item.id === manifest.id), false);
    assert.equal(recovered.pluginPublishers.find(item => item.id === raw.publisher.id).revoked, true);
    assert.equal(recovered.pluginPublishers.find(item => item.id === raw.publisher.id).cleanupPending, false);
  } finally {
    await stop();
    assert.equal(path.dirname(dataDir), os.tmpdir());
    await rm(dataDir, { recursive: true, force: true });
  }
});
