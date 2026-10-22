import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OutboundCompanionConnection } from '../lib/companion-client.mjs';

test('signed reviewed MCP calls reject drift and revocation before dispatch', async () => {
  let identity = 'synthetic-mcp', description = 'Echo synthetic text', calls = 0;
  let pauseList = null, listArrived = null;
  const service = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: identity, version: '1' } };
    if (rpc.method === 'tools/list') {
      listArrived?.(); if (pauseList) await pauseList;
      result = { tools: [{ name: 'echo', description, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] };
    }
    if (rpc.method === 'tools/call') { calls++; result = { content: [{ type: 'text', text: rpc.params.arguments.text }] }; }
    res.setHeader('content-type', 'application/json');
    if (rpc.method === 'tools/call' && rpc.params.arguments.text === 'fail') res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -1, message: 'Synthetic tool failure' } }));
    else res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(3001, '127.0.0.1', resolve); });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-signed-mcp-'));
  const origin = 'http://127.0.0.1:44748';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, stdio: 'ignore', env: { ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: '44748', HEXIGRID_AGENT_RELAY_PORT: '44749', HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1:44749', HEXIGRID_DATA_DIR: dataDir, OPENCODE_CLI: 'missing-mcp-qa' } });
  let agent, releaseList;
  const owner = async (route, method = 'GET', body) => {
    const res = await fetch(origin + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
      if (child.exitCode !== null) throw Error('Isolated MCP host exited.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready);
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    const installed = await owner('/api/mcp', 'POST', { name: 'Synthetic MCP', transport: 'http', url: 'http://127.0.0.1:3001/mcp' });
    assert.equal(installed.status, 201);
    const id = installed.body.server.id;
    const review = async () => {
      const discovered = await owner(`/api/mcp/${id}/test`, 'POST', {});
      assert.equal(discovered.status, 200);
      assert.equal((await owner(`/api/mcp/${id}/enable`, 'PATCH', { enabled: true, toolGrants: { echo: { capability: 'run_tools', risk: 'low', approved: true } } })).status, 200);
    };
    await review();
    await owner('/api/network/agent-relay', 'POST', { provider: 'stable', approved: true });
    const invite = await owner('/api/agent-links/invites', 'POST', { capabilities: ['messages', 'desktop-view', 'desktop-control'] });
    agent = new OutboundCompanionConnection({ inviteUrl: invite.body.companionInvitationUrl, capabilities: ['messages', 'desktop-view', 'desktop-control'], automaticControl: false });
    await agent.connect();
    const paired = await agent.pair({ name: 'Disposable MCP agent', framework: 'test' });
    const run = (input = { text: 'harmless echo' }, extra = {}) => agent.linkRequest(`/agent-link/v1/mcp/${id}/call`, { method: 'POST', body: { tool: 'echo', input, ...extra } });
    assert.equal((await agent.linkRequest('/agent-link/v1/mcp')).status, 403);
    const credentials = (serverId, body) => agent.linkRequest(`/agent-link/v1/mcp/${serverId}/secrets`, { method: 'POST', body });
    assert.equal((await credentials(id, { secrets: {} })).status, 403);
    const remove = serverId => agent.linkRequest(`/agent-link/v1/mcp/${serverId}/remove`, { method: 'POST', body: { approved: true } });
    assert.equal((await remove(id)).status, 403);
    const register = extra => agent.linkRequest('/agent-link/v1/mcp', { method: 'POST', body: { name: 'Agent registered QA MCP', transport: 'http', url: 'http://127.0.0.1:3001/mcp', ...extra } });
    assert.equal((await register()).status, 403);
    assert.equal((await run()).status, 403);
    assert.equal((await agent.linkRequest(`/agent-link/v1/mcp/${id}/enable`, { method: 'POST', body: { enabled: false } })).status, 403);
    await owner(`/api/agent-links/${paired.connection.id}/trust`, 'PATCH', { trustLevel: 'owner', approved: true });
    assert.equal((await run()).status, 403);
    assert.equal((await agent.linkRequest(`/agent-link/v1/mcp/${id}/enable`, { method: 'POST', body: { enabled: false } })).status, 403);
    await owner('/api/desktop-bridge/start', 'POST', { linkId: paired.connection.id, viewGranted: true, controlGranted: true, approved: true });
    const catalog = await agent.linkRequest('/agent-link/v1/mcp');
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.servers[0].tools[0].name, 'echo');
    assert.doesNotMatch(JSON.stringify(catalog.body), /127\.0\.0\.1:3001/);
    const discover = extra => agent.linkRequest(`/agent-link/v1/mcp/${id}/test`, { method: 'POST', body: extra || {} });
    await owner('/api/settings', 'PATCH', { workMode: 'plan', approvalPolicy: 'full' });
    assert.equal((await discover({ approved: true })).status, 403);
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'ask' });
    assert.equal((await discover({ approved: true })).status, 409);
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    const countBeforeRegister = (await owner('/api/mcp')).body.servers.length;
    for (const [workMode, approvalPolicy, expected] of [['plan', 'full', 403], ['build', 'ask', 409]]) {
      await owner('/api/settings', 'PATCH', { workMode, approvalPolicy });
      assert.equal((await register({ approved: true })).status, expected);
      assert.equal((await owner('/api/mcp')).body.servers.length, countBeforeRegister);
    }
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    assert.equal((await register({ url: 'http://remote.invalid/mcp' })).status, 400);
    const registered = await register({ secrets: { SYNTHETIC_QA_KEY: 'disposable-mcp-vault-marker' } });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.server.enabled, false);
    assert.equal(registered.body.server.hasSecrets, true);
    assert.doesNotMatch(JSON.stringify(registered.body), /disposable-mcp-vault-marker/);
    assert.deepEqual(registered.body.server.tools, []);
    assert.equal(registered.body.receipt.agentId, paired.agent.id);
    assert.doesNotMatch(JSON.stringify(registered.body), /127\.0\.0\.1:3001/);
    const registeredId = registered.body.server.id;
    const agentDiscovery = await agent.linkRequest(`/agent-link/v1/mcp/${registeredId}/test`, { method: 'POST', body: {} });
    assert.equal(agentDiscovery.status, 200);
    assert.equal((await agent.linkRequest(`/agent-link/v1/mcp/${registeredId}/enable`, { method: 'POST', body: { enabled: true, expectedToolSetDigest: agentDiscovery.body.server.toolSetDigest, toolGrants: { echo: { capability: 'run_tools', risk: 'low', approved: true } } } })).status, 200);
    assert.equal((await agent.linkRequest(`/agent-link/v1/mcp/${registeredId}/call`, { method: 'POST', body: { tool: 'echo', input: { text: 'registered signed echo' } } })).body.result.content[0].text, 'registered signed echo');
    const standingBeforeCredentials = (await owner('/api/mcp')).body.servers.find(item => item.id === registeredId);
    for (const [workMode, approvalPolicy, expected] of [['plan', 'full', 403], ['build', 'ask', 409]]) {
      await owner('/api/settings', 'PATCH', { workMode, approvalPolicy });
      assert.equal((await credentials(registeredId, { secrets: {}, approved: true })).status, expected);
      assert.equal((await owner(`/api/mcp/${registeredId}/secrets`, 'PUT', { secrets: {} })).status, expected);
      assert.deepEqual((await owner('/api/mcp')).body.servers.find(item => item.id === registeredId), standingBeforeCredentials);
    }
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    assert.equal((await credentials(registeredId, {})).status, 400);
    assert.equal((await credentials(registeredId, { secrets: { NODE_OPTIONS: 'blocked' } })).status, 400);
    pauseList = new Promise(resolve => { releaseList = resolve; });
    const credentialsListArrived = new Promise(resolve => { listArrived = resolve; });
    const oldDiscovery = agent.linkRequest(`/agent-link/v1/mcp/${registeredId}/test`, { method: 'POST', body: {} });
    let credentialTimer;
    try { await Promise.race([credentialsListArrived, new Promise((_, reject) => { credentialTimer = setTimeout(() => reject(Error('Expected pending credential QA discovery.')), 5000); })]); }
    finally { clearTimeout(credentialTimer); }
    const updated = await credentials(registeredId, { secrets: { SYNTHETIC_QA_KEY: 'disposable-mcp-vault-marker-2' } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.receipt.agentId, paired.agent.id);
    assert.equal(updated.body.server.enabled, false);
    assert.deepEqual(updated.body.server.tools, []);
    assert.deepEqual(updated.body.server.toolGrants, {});
    assert.doesNotMatch(JSON.stringify(updated.body), /disposable-mcp-vault-marker/);
    releaseList(); pauseList = null; listArrived = null;
    assert.equal((await oldDiscovery).status, 409);
    const cleared = await credentials(registeredId, { secrets: {} });
    assert.equal(cleared.status, 200); assert.equal(cleared.body.server.hasSecrets, false);
    assert.equal((await credentials(registeredId, { secrets: { SYNTHETIC_QA_KEY: 'disposable-mcp-vault-marker' } })).status, 200);
    const reviewedAgain = await agent.linkRequest(`/agent-link/v1/mcp/${registeredId}/test`, { method: 'POST', body: {} });
    assert.equal(reviewedAgain.status, 200);
    assert.equal((await agent.linkRequest(`/agent-link/v1/mcp/${registeredId}/enable`, { method: 'POST', body: { enabled: true, expectedToolSetDigest: reviewedAgain.body.server.toolSetDigest, toolGrants: { echo: { capability: 'run_tools', risk: 'low', approved: true } } } })).status, 200);
    for (const [workMode, approvalPolicy, expected] of [['plan', 'full', 403], ['build', 'ask', 409]]) {
      await owner('/api/settings', 'PATCH', { workMode, approvalPolicy });
      assert.equal((await remove(registeredId)).status, expected);
      assert.equal((await owner('/api/mcp')).body.servers.find(item => item.id === registeredId).enabled, true);
    }
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    if (process.platform === 'win32') {
      const protectedPath = path.join(dataDir, 'vault', `mcp-${registeredId}.protected`);
      const protectedBytes = await readFile(protectedPath);
      await rm(protectedPath); await mkdir(protectedPath);
      const updateFailure = await credentials(registeredId, { secrets: { SYNTHETIC_QA_KEY: 'disposable-mcp-vault-marker-3' } });
      assert.equal(updateFailure.status, 503); assert.equal(updateFailure.body.receipt.status, 'failed');
      assert.equal(updateFailure.body.server.enabled, false); assert.deepEqual(updateFailure.body.server.tools, []);
      const cleanupFailure = await remove(registeredId);
      assert.equal(cleanupFailure.status, 503);
      assert.equal(cleanupFailure.body.receipt.status, 'failed');
      assert.equal(cleanupFailure.body.server.enabled, false);
      assert.match(cleanupFailure.body.error, /retry Remove/);
      assert.equal((await agent.linkRequest(`/agent-link/v1/mcp/${registeredId}/call`, { method: 'POST', body: { tool: 'echo', input: { text: 'disabled' } } })).status, 409);
      await rm(protectedPath, { recursive: true }); await writeFile(protectedPath, protectedBytes);
    }
    const removed = await remove(registeredId);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.receipt.agentId, paired.agent.id);
    assert.equal(removed.body.receipt.status, 'completed');
    assert.equal((await remove(registeredId)).status, 404);
    assert.equal((await agent.linkRequest(`/agent-link/v1/mcp/${registeredId}/call`, { method: 'POST', body: { tool: 'echo', input: { text: 'gone' } } })).status, 404);
    assert.ok(!(await agent.linkRequest('/agent-link/v1/mcp')).body.servers.some(item => item.id === registeredId));
    const discoveredByAgent = await discover(); assert.equal(discoveredByAgent.status, 200);
    assert.equal(discoveredByAgent.body.receipt.agentId, paired.agent.id);
    assert.equal(discoveredByAgent.body.server.enabled, false);
    assert.equal(discoveredByAgent.body.server.toolGrants.echo.approved, false);
    assert.doesNotMatch(JSON.stringify(discoveredByAgent.body), /127\.0\.0\.1:3001/);
    await review();
    const setEnabled = body => agent.linkRequest(`/agent-link/v1/mcp/${id}/enable`, { method: 'POST', body });
    assert.equal((await setEnabled({})).status, 400);
    const originalGrants = catalog.body.servers[0].toolGrants;
    const disabled = await setEnabled({ enabled: false, toolGrants: { echo: { capability: 'external_write', risk: 'critical', approved: true } } });
    assert.equal(disabled.status, 200); assert.equal(disabled.body.receipt.agentId, paired.agent.id);
    assert.deepEqual(disabled.body.server.toolGrants, originalGrants);
    assert.equal((await run()).status, 409);
    const enableBody = { enabled: true, expectedToolSetDigest: catalog.body.servers[0].toolSetDigest, toolGrants: { echo: { capability: 'run_tools', risk: 'low', approved: true } } };
    assert.equal((await setEnabled({ ...enableBody, expectedToolSetDigest: 'stale' })).status, 409);
    assert.equal((await setEnabled({ enabled: true })).status, 409);
    await owner('/api/settings', 'PATCH', { workMode: 'plan', approvalPolicy: 'full' });
    assert.equal((await setEnabled({ ...enableBody, approved: true })).status, 403);
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'ask' });
    assert.equal((await setEnabled({ ...enableBody, approved: true })).status, 409);
    assert.equal((await owner('/api/mcp')).body.servers[0].enabled, false);
    assert.deepEqual((await owner('/api/mcp')).body.servers[0].toolGrants, originalGrants);
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    const enabled = await setEnabled(enableBody); assert.equal(enabled.status, 200); assert.equal(enabled.body.receipt.agentId, paired.agent.id);
    const success = await run();
    assert.equal(success.status, 200);
    assert.equal(success.body.result.content[0].text, 'harmless echo');
    assert.equal(success.body.receipt.agentId, paired.connection.agentId);
    const failure = await run({ text: 'fail' });
    assert.equal(failure.status, 502);
    assert.equal(failure.body.receipt.status, 'failed');
    const before = calls;
    assert.equal((await run({ text: 7 })).status, 400);
    assert.equal((await run({}, { tool: 'unknown' })).status, 400);
    for (const [workMode, approvalPolicy, status] of [['plan', 'full', 403], ['build', 'ask', 409]]) {
      await owner('/api/settings', 'PATCH', { workMode, approvalPolicy });
      assert.equal((await run({ text: 'blocked' }, { approved: true })).status, status);
    }
    await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    identity = 'changed-identity';
    assert.equal((await run()).status, 409);
    assert.equal(calls, before, 'Identity drift must stop tools/call, not just discard its result.');
    assert.equal((await owner('/api/mcp')).body.servers[0].enabled, false);
    identity = 'synthetic-mcp'; await review();
    description = 'Changed tool';
    assert.equal((await run()).status, 409);
    assert.equal(calls, before);
    description = 'Echo synthetic text'; await review();
    pauseList = new Promise(resolve => { releaseList = resolve; });
    const arrived = new Promise(resolve => { listArrived = resolve; });
    const pending = run();
    void pending.catch(() => {});
    let arrivalTimer;
    try {
      await Promise.race([arrived, new Promise((_, reject) => { arrivalTimer = setTimeout(() => reject(Error('Expected live tools/list request did not arrive.')), 5000); })]);
    } finally { clearTimeout(arrivalTimer); }
    await owner('/api/desktop-bridge/takeover', 'POST', { approved: true });
    releaseList(); pauseList = null; listArrived = null;
    assert.equal((await pending).status, 403);
    assert.equal(calls, before, 'Revocation during discovery must prevent tool dispatch.');
    await owner('/api/desktop-bridge/resume', 'POST', { approved: true });
    const standingBeforeRevocation = (await owner('/api/mcp')).body.servers[0];
    pauseList = new Promise(resolve => { releaseList = resolve; });
    const discoveryArrived = new Promise(resolve => { listArrived = resolve; });
    const pendingDiscovery = discover(); void pendingDiscovery.catch(() => {});
    let discoveryTimer;
    try { await Promise.race([discoveryArrived, new Promise((_, reject) => { discoveryTimer = setTimeout(() => reject(Error('Expected signed discovery did not arrive.')), 5000); })]); }
    finally { clearTimeout(discoveryTimer); }
    await owner('/api/desktop-bridge/takeover', 'POST', { approved: true });
    releaseList(); pauseList = null; listArrived = null;
    assert.equal((await pendingDiscovery).status, 403);
    const standingAfterRevocation = (await owner('/api/mcp')).body.servers[0];
    assert.equal(standingAfterRevocation.enabled, standingBeforeRevocation.enabled);
    assert.deepEqual(standingAfterRevocation.toolGrants, standingBeforeRevocation.toolGrants);
    await owner('/api/desktop-bridge/resume', 'POST', { approved: true });
    await owner(`/api/mcp/${id}/enable`, 'PATCH', { enabled: false });
    assert.equal((await run()).status, 409);
    const history = await owner('/api/bootstrap');
    assert.ok(history.body.receipts.some(item => item.id === success.body.receipt.id));
    assert.ok(history.body.receipts.some(item => item.id === failure.body.receipt.id));
    assert.equal((await fetch('http://127.0.0.1:44749/api/mcp')).status, 404);
  } finally {
    releaseList?.(); await agent?.close();
    if (child.exitCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; }
    await new Promise(resolve => service.close(resolve));
    assert.equal(path.dirname(dataDir), os.tmpdir()); await rm(dataDir, { recursive: true, force: true });
  }
});
