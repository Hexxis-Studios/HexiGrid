import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { buildPackageIdentity } from '../lib/plugin-security.mjs';
import path from 'node:path';
import { OutboundCompanionConnection } from '../lib/companion-client.mjs';

test('encrypted owner Link discovers and runs reviewed plugins with receipts and live revocation', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-signed-plugin-'));
  const root = path.resolve(import.meta.dirname, '..');
  const origin = 'http://127.0.0.1:44738';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
    ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: '44738', HEXIGRID_AGENT_RELAY_PORT: '44739',
    HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1:44739', HEXIGRID_DATA_DIR: dataDir, OPENCODE_CLI: 'missing-plugin-qa-model'
  } });
  let agent;
  const owner = async (route, method = 'GET', body) => {
    const res = await fetch(origin + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
      if (child.exitCode !== null) throw Error('Isolated plugin host exited.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready);
    assert.equal((await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
    const manifest = { schemaVersion: 2, id: 'signed-calculator', name: 'Signed QA calculator', version: '1.0.0', entry: 'plugin.mjs', secrets: [{ id: 'qa-key', label: 'QA protected key', required: false }], capabilities: [{ id: 'calculate', label: 'Calculate', risk: 'low', permissions: { files: { readRoots: [], writeRoots: [] }, network: [] }, inputSchema: { type: 'object', properties: { value: { type: 'number' }, fail: { type: 'boolean' } }, required: ['value'], additionalProperties: false }, outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false } }] };
    assert.equal((await owner('/api/plugins/install', 'POST', { manifest, files: [{ path: 'plugin.mjs', content: 'export const capabilities={calculate:async input=>{if(input.fail)throw Error("Synthetic calculator failed.");return {answer:input.value*2};}};' }], localOwnerApproved: true })).status, 201);
    assert.equal((await owner('/api/plugins/signed-calculator/enable', 'PATCH', { enabled: true })).status, 200);
    assert.equal((await owner('/api/network/agent-relay', 'POST', { provider: 'stable', approved: true })).status, 200);
    const invited = await owner('/api/agent-links/invites', 'POST', { capabilities: ['messages', 'desktop-view', 'desktop-control'] });
    assert.equal(invited.status, 201);
    agent = new OutboundCompanionConnection({ inviteUrl: invited.body.companionInvitationUrl, capabilities: ['messages', 'desktop-view', 'desktop-control'], automaticControl: false });
    await agent.connect();
    const paired = await agent.pair({ name: 'Disposable plugin agent', framework: 'test' });
    const route = '/agent-link/v1/plugins/signed-calculator/run';
    const installBody = { manifest: { ...manifest, id: 'linked-installed-calculator', secrets: [] }, files: [{ path: 'plugin.mjs', content: 'export const capabilities={calculate:async input=>({answer:input.value*2})};' }], localOwnerApproved: true };
    const revokePublisher = (body = {}) => agent.linkRequest('/agent-link/v1/plugin-publishers/qa-publisher/revoke', { method: 'POST', body });
    const install = body => agent.linkRequest('/agent-link/v1/plugins/install', { method: 'POST', body });
    const remove = (body = {}) => agent.linkRequest('/agent-link/v1/plugins/signed-calculator/remove', { method: 'POST', body });
    const credentials = body => agent.linkRequest('/agent-link/v1/plugins/signed-calculator/secrets', { method: 'POST', body });
    const enable = body => agent.linkRequest('/agent-link/v1/plugins/signed-calculator/enable', { method: 'POST', body });
    const run = (body = { capability: 'calculate', input: { value: 2 } }) => agent.linkRequest(route, { method: 'POST', body });
    assert.equal((await revokePublisher()).status, 403);
    assert.equal((await install(installBody)).status, 403);
    assert.equal((await remove()).status, 403);
    assert.equal((await agent.linkRequest('/agent-link/v1/plugins')).status, 403);
    assert.equal((await run()).status, 403);
    assert.equal((await credentials({ secrets: { 'qa-key': 'public-synthetic-key' } })).status, 403);
    assert.equal((await enable({ enabled: true })).status, 403);
    const trusted = await owner(`/api/agent-links/${paired.connection.id}/trust`, 'PATCH', { trustLevel: 'owner', approved: true });
    assert.equal(trusted.status, 200);
    assert.equal((await run()).status, 403); // Trust alone does not create a session.
    assert.equal((await enable({ enabled: true })).status, 403);
    assert.equal((await owner('/api/desktop-bridge/start', 'POST', { linkId: paired.connection.id, viewGranted: true, controlGranted: true, approved: true })).status, 200);
    for (const [workMode, approvalPolicy, status] of [['plan', 'full', 403], ['build', 'ask', 409]]) {
      await owner('/api/settings', 'PATCH', { workMode, approvalPolicy });
      assert.equal((await install({ ...installBody, approved: true })).status, status);
      assert.equal((await owner('/api/bootstrap')).body.plugins.some(item => item.id === installBody.manifest.id), false);
    }
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    assert.equal((await install({ ...installBody, localOwnerApproved: false })).status, 409);
    assert.equal((await install({ ...installBody, files: [{ path: '../escape.mjs', content: 'invalid' }] })).status, 400);
    const installed = await install(installBody);
    assert.equal(installed.status, 201);
    assert.equal(installed.body.plugin.enabled, false);
    assert.equal(installed.body.receipt.agentId, paired.connection.agentId);
    assert.equal((await agent.linkRequest('/agent-link/v1/plugins/linked-installed-calculator/enable', { method: 'POST', body: { enabled: true } })).status, 200);
    assert.equal((await agent.linkRequest('/agent-link/v1/plugins/linked-installed-calculator/run', { method: 'POST', body: { capability: 'calculate', input: { value: 2 } } })).body.result.answer, 4);
    assert.equal((await agent.linkRequest('/agent-link/v1/plugins/linked-installed-calculator/remove', { method: 'POST', body: {} })).status, 200);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const unsignedPublisher = { ...installBody.manifest, id: 'publisher-calculator', publisher: { id: 'qa-publisher', name: 'QA Publisher', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), signature: Buffer.from('pending').toString('base64') } };
    const identity = buildPackageIdentity(unsignedPublisher, installBody.files);
    const publisherBody = { manifest: { ...unsignedPublisher, package: identity.manifest.package, publisher: { ...unsignedPublisher.publisher, signature: sign(null, Buffer.from(identity.digest), privateKey).toString('base64') } }, files: installBody.files };
    assert.equal((await install(publisherBody)).status, 409);
    const trustedInstall = await install({ ...publisherBody, trustPublisher: true });
    assert.equal(trustedInstall.status, 201, JSON.stringify(trustedInstall.body));
    const publisherRoute = '/agent-link/v1/plugins/publisher-calculator';
    assert.equal((await agent.linkRequest(publisherRoute + '/enable', { method: 'POST', body: { enabled: true } })).status, 200);
    assert.equal((await agent.linkRequest('/agent-link/v1/plugin-publishers')).body.publishers.find(item => item.id === 'qa-publisher').trusted, true);
    for (const [workMode, approvalPolicy, status] of [['plan', 'full', 403], ['build', 'ask', 409]]) {
      await owner('/api/settings', 'PATCH', { workMode, approvalPolicy });
      assert.equal((await revokePublisher({ approved: true })).status, status);
      assert.equal((await owner('/api/plugin-publishers/qa-publisher', 'DELETE', {})).status, status);
    }
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    if (process.platform === 'win32') {
      const protectedPath = path.join(dataDir, 'vault', 'plugin-publisher-qa-publisher.protected');
      const bytes = await readFile(protectedPath);
      await rm(protectedPath); await mkdir(protectedPath);
      const failed = await revokePublisher();
      assert.equal(failed.status, 503);
      assert.equal(failed.body.publisher.revoked, true);
      assert.equal(failed.body.publisher.cleanupPending, true);
      assert.equal(failed.body.receipt.status, 'failed');
      assert.equal((await agent.linkRequest('/agent-link/v1/plugin-publishers')).body.publishers.find(item => item.id === 'qa-publisher').trusted, false);
      assert.equal((await agent.linkRequest(publisherRoute + '/enable', { method: 'POST', body: { enabled: true } })).status, 409);
      assert.equal((await install({ ...publisherBody, trustPublisher: true })).status, 409);
      await rm(protectedPath, { recursive: true }); await writeFile(protectedPath, bytes);
    }
    const revoked = await revokePublisher();
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.publisher.revoked, true);
    assert.equal(revoked.body.publisher.trusted, false);
    assert.equal(revoked.body.publisher.cleanupPending, false);
    assert.equal(revoked.body.receipt.agentId, paired.connection.agentId);
    assert.equal((await install(publisherBody)).status, 409);
    const retrusted = await install({ ...publisherBody, trustPublisher: true });
    assert.equal(retrusted.status, 201, JSON.stringify(retrusted.body));
    assert.equal((await agent.linkRequest('/agent-link/v1/plugin-publishers')).body.publishers.find(item => item.id === 'qa-publisher').trusted, true);
    assert.equal((await agent.linkRequest(publisherRoute + '/enable', { method: 'POST', body: { enabled: true } })).status, 200);
    assert.equal((await agent.linkRequest(publisherRoute + '/run', { method: 'POST', body: { capability: 'calculate', input: { value: 2 } } })).body.result.answer, 4);
    await agent.linkRequest(publisherRoute + '/remove', { method: 'POST', body: {} });
    assert.equal((await revokePublisher()).status, 200);
    const catalog = await agent.linkRequest('/agent-link/v1/plugins');
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.plugins[0].capabilities[0].id, 'calculate');
    assert.equal(catalog.body.plugins[0].enabled, true);
    assert.equal((await enable({})).status, 400);
    const disabled = await enable({ enabled: false });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.plugin.enabled, false);
    assert.equal(disabled.body.receipt.agentId, paired.connection.agentId);
    assert.equal((await run()).status, 409);
    for (const [workMode, approvalPolicy, status] of [['plan', 'full', 403], ['build', 'ask', 409]]) {
      await owner('/api/settings', 'PATCH', { workMode, approvalPolicy });
      assert.equal((await enable({ enabled: true, approved: true })).status, status);
      assert.equal((await owner('/api/bootstrap')).body.plugins.find(item => item.id === 'signed-calculator').enabled, false);
    }
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    const enabled = await enable({ enabled: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.plugin.enabled, true);
    assert.equal(enabled.body.receipt.agentId, paired.connection.agentId);

    for (const body of [{}, { secrets: {} }, { secrets: { 'qa-key': null } }, { secrets: { unknown: 'value' } }]) assert.equal((await credentials(body)).status, 400);
    for (const [workMode, approvalPolicy, status] of [['plan', 'full', 403], ['build', 'ask', 409]]) {
      await owner('/api/settings', 'PATCH', { workMode, approvalPolicy });
      assert.equal((await credentials({ secrets: { 'qa-key': 'public-synthetic-key' }, approved: true })).status, status);
      assert.equal((await remove({ approved: true })).status, status);
      assert.equal((await owner('/api/plugins/signed-calculator', 'DELETE', {})).status, status);
      assert.equal((await owner('/api/plugins/signed-calculator/secrets', 'PUT', { secrets: { 'qa-key': 'public-synthetic-key' } })).status, status);
      assert.equal((await owner('/api/bootstrap')).body.plugins.find(item => item.id === 'signed-calculator').enabled, true);
    }
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    const changed = await credentials({ secrets: { 'qa-key': 'public-synthetic-key' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.plugin.enabled, false);
    assert.equal(changed.body.plugin.secretStatus['qa-key'], true);
    assert.equal(changed.body.receipt.agentId, paired.connection.agentId);
    assert.doesNotMatch(JSON.stringify(changed.body), /public-synthetic-key/);
    assert.equal((await run()).status, 409);
    const cleared = await credentials({ secrets: { 'qa-key': '' } });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.plugin.secretStatus['qa-key'], false);
    if (process.platform === 'win32') {
      await credentials({ secrets: { 'qa-key': 'public-synthetic-key' } });
      const protectedPath = path.join(dataDir, 'vault', 'plugin-signed-calculator-qa-key.protected');
      const bytes = await readFile(protectedPath);
      await rm(protectedPath); await mkdir(protectedPath);
      const failed = await credentials({ secrets: { 'qa-key': '' } });
      assert.equal(failed.status, 503);
      assert.equal(failed.body.receipt.status, 'failed');
      assert.equal(failed.body.plugin.enabled, false);
      assert.equal(failed.body.plugin.secretStatus['qa-key'], true);
      await rm(protectedPath, { recursive: true }); await writeFile(protectedPath, bytes);
      assert.equal((await credentials({ secrets: { 'qa-key': '' } })).status, 200);
    }
    assert.equal((await enable({ enabled: true })).status, 200);

    assert.equal((await run({ capability: 'unknown', input: { value: 2 } })).status, 400);
    assert.equal((await run({ capability: 'calculate', input: { value: 'bad' } })).status, 400);
    const result = await run();
    assert.equal(result.status, 200);
    assert.equal(result.body.result.answer, 4);
    assert.equal(result.body.receipt.status, 'completed');
    assert.equal(result.body.receipt.agentId, paired.connection.agentId);
    const failure = await run({ capability: 'calculate', input: { value: 2, fail: true } });
    assert.equal(failure.status, 502);
    assert.equal(failure.body.receipt.status, 'failed');
    assert.match(failure.body.error, /Synthetic calculator failed/);
    const history = await owner('/api/bootstrap');
    assert.ok(history.body.receipts.some(item => item.id === result.body.receipt.id));
    assert.ok(history.body.receipts.some(item => item.id === failure.body.receipt.id));
    await owner(`/api/agent-links/${paired.connection.id}/capabilities`, 'PATCH', { capabilities: trusted.body.connection.capabilities.filter(item => item !== 'owner-process'), approved: true });
    assert.equal((await run()).status, 403);
    assert.equal((await agent.linkRequest('/agent-link/v1/plugins')).status, 200);
    await owner(`/api/agent-links/${paired.connection.id}/capabilities`, 'PATCH', { capabilities: trusted.body.connection.capabilities, approved: true });
    // A live session revocation must also cut a later broker side effect.
    await mkdir(path.join(dataDir, 'workspace', 'qa'), { recursive: true });
    const delayed = { ...manifest, id: 'delayed-calculator', capabilities: [{ ...manifest.capabilities[0], permissions: { files: { readRoots: [], writeRoots: ['qa'] }, network: [] } }] };
    assert.equal((await owner('/api/plugins/install', 'POST', { manifest: delayed, localOwnerApproved: true, files: [{ path: 'plugin.mjs', content: 'export const capabilities={calculate:async()=>{await hexigrid.files.writeText("qa/started.txt","started");await new Promise(resolve=>setTimeout(resolve,600));await hexigrid.files.writeText("qa/late.txt","must not write");return {answer:4};}};' }] })).status, 201);
    await owner('/api/plugins/delayed-calculator/enable', 'PATCH', { enabled: true });
    const pending = agent.linkRequest('/agent-link/v1/plugins/delayed-calculator/run', { method: 'POST', body: { capability: 'calculate', input: { value: 2 } } });
    let started = false;
    for (let i = 0; i < 50; i++) {
      try { await access(path.join(dataDir, 'workspace', 'qa', 'started.txt')); started = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(started, 'First broker write must be observed before revocation.');
    assert.equal((await agent.linkRequest('/agent-link/v1/plugins/delayed-calculator/secrets', { method: 'POST', body: { secrets: { 'qa-key': 'public-synthetic-key' } } })).status, 409);
    assert.equal((await owner('/api/desktop-bridge/takeover', 'POST', { approved: true })).status, 200);
    assert.equal((await pending).status, 502);
    await assert.rejects(access(path.join(dataDir, 'workspace', 'qa', 'late.txt')), error => error.code === 'ENOENT');
    assert.equal((await owner('/api/desktop-bridge/resume', 'POST', { approved: true })).status, 200);
    for (const [workMode, approvalPolicy, status] of [['plan', 'full', 403], ['build', 'ask', 409]]) {
      await owner('/api/settings', 'PATCH', { workMode, approvalPolicy });
      assert.equal((await run({ capability: 'calculate', input: { value: 2 }, approved: true })).status, status);
    }
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    await owner('/api/plugins/signed-calculator/enable', 'PATCH', { enabled: false });
    assert.equal((await run()).status, 409);
    await owner('/api/plugins/signed-calculator/enable', 'PATCH', { enabled: true });
    // A credential cleanup failure keeps an inspectable, non-runnable record.
    if (process.platform === 'win32') {
      await credentials({ secrets: { 'qa-key': 'public-synthetic-key' } });
      await enable({ enabled: true });
      const protectedPath = path.join(dataDir, 'vault', 'plugin-signed-calculator-qa-key.protected');
      const bytes = await readFile(protectedPath);
      await rm(protectedPath); await mkdir(protectedPath);
      const failed = await remove();
      assert.equal(failed.status, 503);
      assert.equal(failed.body.receipt.status, 'failed');
      assert.equal(failed.body.plugin.removalPending, true);
      assert.equal(failed.body.plugin.enabled, false);
      assert.equal((await enable({ enabled: true })).status, 409);
      assert.equal((await credentials({ secrets: { 'qa-key': 'new' } })).status, 409);
      assert.equal((await run()).status, 409);
      assert.equal((await owner('/api/plugins/install', 'POST', { manifest, files: [{ path: 'plugin.mjs', content: 'export const capabilities={calculate:async()=>({answer:4})};' }], localOwnerApproved: true })).status, 409);
      await access(path.join(dataDir, 'plugins', failed.body.plugin.installPath, 'plugin.mjs'));
      await rm(protectedPath, { recursive: true }); await writeFile(protectedPath, bytes);
    }
    const removed = await remove();
    assert.equal(removed.status, 200);
    assert.equal(removed.body.receipt.agentId, paired.connection.agentId);
    assert.equal(removed.body.receipt.status, 'completed');
    await assert.rejects(access(path.join(dataDir, 'plugins', 'signed-calculator')), error => error.code === 'ENOENT');
    assert.equal((await remove()).status, 404);
    assert.equal((await run()).status, 404);
    assert.equal((await agent.linkRequest('/agent-link/v1/plugins')).body.plugins.some(item => item.id === 'signed-calculator'), false);
    // Removing during an active broker run must cut off the later write.
    const removalManifest = { ...delayed, id: 'removal-calculator', secrets: [] };
    assert.equal((await owner('/api/plugins/install', 'POST', { manifest: removalManifest, localOwnerApproved: true, files: [{ path: 'plugin.mjs', content: 'export const capabilities={calculate:async()=>{await hexigrid.files.writeText("qa/remove-started.txt","started");await new Promise(resolve=>setTimeout(resolve,600));await hexigrid.files.writeText("qa/remove-late.txt","must not write");return {answer:4};}};' }] })).status, 201);
    await owner('/api/plugins/removal-calculator/enable', 'PATCH', { enabled: true });
    const removalRun = agent.linkRequest('/agent-link/v1/plugins/removal-calculator/run', { method: 'POST', body: { capability: 'calculate', input: { value: 2 } } });
    let removalStarted = false;
    for (let i = 0; i < 50; i++) {
      try { await access(path.join(dataDir, 'workspace', 'qa', 'remove-started.txt')); removalStarted = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(removalStarted);
    assert.equal((await agent.linkRequest('/agent-link/v1/plugins/removal-calculator/remove', { method: 'POST', body: {} })).status, 200);
    assert.equal((await removalRun).status, 502);
    await assert.rejects(access(path.join(dataDir, 'workspace', 'qa', 'remove-late.txt')), error => error.code === 'ENOENT');
    await owner('/api/desktop-bridge/takeover', 'POST', { approved: true });
    assert.equal((await run()).status, 403);
    await owner('/api/agent-links/' + paired.connection.id + '/trust', 'PATCH', { trustLevel: 'scoped', approved: true });
    assert.equal((await agent.linkRequest('/agent-link/v1/plugins')).status, 403);
    assert.equal((await run()).status, 403);
    assert.equal((await fetch('http://127.0.0.1:44739/api/bootstrap')).status, 404);
  } finally {
    await agent?.close();
    if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
    assert.equal(path.dirname(dataDir), os.tmpdir());
    await rm(dataDir, { recursive: true, force: true });
  }
});
