import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OutboundCompanionConnection } from '../lib/companion-client.mjs';

const WAIT_MS = 5000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

function within(promise, label, timeoutMs = WAIT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms.')), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function reserveHostPorts() {
  const servers = [net.createServer(), net.createServer()];
  try {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    })));
    const ports = servers.map(server => server.address().port);
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    return ports;
  } catch (error) {
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
    throw error;
  }
}

async function startFakeMcp() {
  const callArrived = deferred();
  const releaseCall = deferred();
  const state = { calls: 0, responseAborted: false, responseSent: false };
  const handler = async (req, res) => {
    let raw = '';
    try {
      for await (const chunk of req) raw += chunk;
      const rpc = JSON.parse(raw);
      if (rpc.id === undefined) { res.writeHead(202).end(); return; }
      if (rpc.method === 'initialize') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-inflight-mcp', version: '1' } } }));
        return;
      }
      if (rpc.method === 'tools/list') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'echo', description: 'Echo harmless fixture text', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 100 } }, required: ['text'], additionalProperties: false } }] } }));
        return;
      }
      if (rpc.method === 'tools/call') {
        state.calls += 1;
        res.on('close', () => { if (!res.writableEnded) state.responseAborted = true; });
        callArrived.resolve();
        await releaseCall.promise;
        if (res.destroyed) return;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'synthetic harmless MCP result' }] } }));
        state.responseSent = true;
        return;
      }
      res.writeHead(404).end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: String(error?.message || 'fixture error') }));
    }
  };

  for (const port of [3001, 8787, 8080, 8000, 3000, 80]) {
    const server = http.createServer(handler);
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.removeListener('listening', onListening); reject(error); };
        const onListening = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return { server, url: 'http://127.0.0.1:' + port + '/mcp', callArrived, releaseCall, state };
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].includes(error.code)) throw error;
    }
  }
  throw new Error('No allowed loopback MCP fixture port was available.');
}

async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections?.();
  await within(closed, 'Fixture server shutdown', 3000);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await within(exited, 'Isolated fixture server exit', 5000);
}

test('rejects a returned MCP result when the Link computer session was revoked in flight', { timeout: 45000 }, async () => {
  const fixture = await startFakeMcp();
  let dataDir;
  let child;
  let agent;
  let pendingRun;
  const releaseCall = () => fixture.releaseCall.resolve();
  try {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-mcp-inflight-'));
    const [hostPort, relayPort] = await reserveHostPorts();
    const origin = 'http://127.0.0.1:' + hostPort;
    const relayOrigin = 'http://127.0.0.1:' + relayPort;
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      windowsHide: true,
      stdio: 'ignore',
      env: {
        HEXIGRID_HOST: '127.0.0.1',
        HEXIGRID_PORT: String(hostPort),
        HEXIGRID_AGENT_RELAY_PORT: String(relayPort),
        HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: relayOrigin,
        HEXIGRID_DATA_DIR: dataDir
      }
    });

    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch {}
      if (child.exitCode !== null) throw new Error('The isolated fixture server exited during startup.');
      await wait(100);
    }
    assert.equal(ready, true, 'The isolated fixture server should become ready within its bounded startup window.');

    const owner = async (route, method = 'GET', body) => {
      const response = await fetch(origin + route, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(WAIT_MS)
      });
      return { status: response.status, body: await response.json() };
    };

    assert.equal((await owner('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
    const installed = await owner('/api/mcp', 'POST', { name: 'Synthetic in-flight MCP', transport: 'http', url: fixture.url });
    assert.equal(installed.status, 201);
    const mcpId = installed.body.server.id;
    assert.equal((await owner('/api/mcp/' + mcpId + '/test', 'POST', {})).status, 200);
    const enabled = await owner('/api/mcp/' + mcpId + '/enable', 'PATCH', {
      enabled: true,
      toolGrants: { echo: { capability: 'run_tools', risk: 'low', approved: true } }
    });
    assert.equal(enabled.status, 200);

    assert.equal((await owner('/api/network/agent-relay', 'POST', { provider: 'stable', approved: true })).status, 200);
    const invitation = await owner('/api/agent-links/invites', 'POST', { capabilities: ['messages', 'desktop-view', 'desktop-control'] });
    assert.equal(invitation.status, 201);
    agent = new OutboundCompanionConnection({
      inviteUrl: invitation.body.companionInvitationUrl,
      capabilities: ['messages', 'desktop-view', 'desktop-control'],
      automaticControl: false,
      requestTimeoutMs: 12000,
      eventWaitMs: 1000
    });
    await within(agent.connect(), 'Fixture Link connect');
    const paired = await within(agent.pair({ name: 'Disposable MCP in-flight agent', framework: 'test' }), 'Fixture Link pair');
    assert.equal((await owner('/api/agent-links/' + paired.connection.id + '/trust', 'PATCH', { trustLevel: 'owner', approved: true })).status, 200);
    const started = await owner('/api/desktop-bridge/start', 'POST', { linkId: paired.connection.id, viewGranted: true, controlGranted: true, approved: true });
    assert.equal(started.status, 200);

    pendingRun = agent.linkRequest('/agent-link/v1/mcp/' + mcpId + '/call', {
      method: 'POST',
      body: { tool: 'echo', input: { text: 'harmless fixture request' } }
    });
    let runSettled = false;
    void pendingRun.then(() => { runSettled = true; }, () => { runSettled = true; });
    await within(fixture.callArrived.promise, 'Fake tools/call arrival');
    assert.equal(fixture.state.calls, 1);

    const takeover = await owner('/api/desktop-bridge/takeover', 'POST', { approved: true });
    assert.equal(takeover.status, 200);
    assert.equal(runSettled, false, 'The paused connector request must still be awaiting its result after session revocation.');
    assert.equal(fixture.state.responseAborted, false, 'Revocation must not be described as an MCP transport abort.');

    releaseCall();
    const result = await within(pendingRun, 'In-flight Link MCP result');
    assert.equal(fixture.state.responseSent, true, 'The fake connector completed tools/call and returned a result.');
    assert.equal(result.status, 403);
    assert.equal(Object.hasOwn(result.body, 'result'), false);
    assert.match(result.body.error, /revoked or became inactive/i);
    assert.equal(result.body.receipt.status, 'failed');
    assert.equal(result.body.receipt.source, 'mcp');
    assert.equal(result.body.receipt.agentId, paired.agent.id);
    assert.match(result.body.receipt.detail, /revoked or became inactive/i);

    const stored = await owner('/api/bootstrap');
    const storedReceipt = stored.body.receipts.find(item => item.id === result.body.receipt.id);
    assert.equal(storedReceipt?.status, 'failed');
    assert.match(storedReceipt?.detail || '', /revoked or became inactive/i);

    const later = await agent.linkRequest('/agent-link/v1/mcp/' + mcpId + '/call', {
      method: 'POST',
      body: { tool: 'echo', input: { text: 'must not dispatch' } }
    });
    assert.equal(later.status, 403);
    assert.equal(fixture.state.calls, 1, 'A later request after takeover must not dispatch tools/call.');
  } finally {
    releaseCall();
    if (pendingRun) await within(pendingRun.catch(() => {}), 'In-flight fixture cleanup', 3000).catch(() => {});
    if (agent) await within(agent.close(), 'Fixture Link cleanup', 3000).catch(() => {});
    let serverStopped = !child || child.exitCode !== null || child.signalCode !== null;
    let cleanupError;
    try { await stopChild(child); serverStopped = !child || child.exitCode !== null || child.signalCode !== null; }
    catch (error) { cleanupError = error; }
    try { await closeServer(fixture.server); }
    catch (error) { cleanupError ||= error; }
    if (dataDir && serverStopped) {
      assert.equal(path.dirname(dataDir), os.tmpdir());
      await rm(dataDir, { recursive: true, force: true });
    }
    if (cleanupError) throw cleanupError;
  }
});
