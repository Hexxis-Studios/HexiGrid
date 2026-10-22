import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OutboundCompanionConnection } from '../lib/companion-client.mjs';
import { signatureFor } from '../lib/agent-link.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const companionScript = path.join(root, 'integrations', 'hexigrid-link', 'scripts', 'companion_client.mjs');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function runChild(args, env, timeoutMs = 12_000) {
  const child = spawn(process.execPath, [companionScript, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('The companion child exceeded its test deadline.')); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  return { exitCode, stdout, stderr, reports: stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) };
}

test('real owner server and shipped companion resume queued messages through restart and revoke', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-owner-companion-'));
  const agentHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-agent-companion-'));
  t.after(async () => { await stopServer(); await fs.rm(dataDir, { recursive: true, force: true }); await fs.rm(agentHome, { recursive: true, force: true }); });
  const fakeCodexServer = path.join(dataDir, 'fake-codex-app-server.mjs');
  const fakeCodexPrompt = path.join(dataDir, 'codex-relay-prompt.json');
  const fakeCodexBusy = path.join(dataDir, 'codex-relay-busy');
  const fakeCodexCommand = path.join(dataDir, process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex');
  const fakeCodexHome = path.join(dataDir, 'codex-home');
  const fakeDesktopServer = path.join(fakeCodexHome, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools', '0.0.0-test', 'server.mjs');
  await fs.mkdir(path.dirname(fakeDesktopServer), { recursive: true });
  await fs.writeFile(fakeDesktopServer, `import fs from 'node:fs';
let buffer = ''; let sent = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const response = (message, payload) => send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
process.stdin.setEncoding('utf8').on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/); buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: {} });
    if (message.method !== 'tools/call') continue;
    if (message.params.name === 'wait_threads') {
      const threadId = message.params.arguments.targets[0].threadId;
      response(message, { polls: [{ cursor: sent ? 'cursor-new' : 'cursor-old', thread: { id: threadId }, latestTurn: { id: sent ? 'turn-direct-e2e' : 'turn-prior-e2e', status: 'completed' }, latestAssistantMessage: { turnId: sent ? 'turn-direct-e2e' : 'turn-prior-e2e', phase: 'final_answer', text: sent ? 'Codex received the direct companion message.' : 'Prior reply.' } }] });
    } else if (message.params.name === 'read_thread') {
      response(message, { turns: [{ id: sent ? 'turn-direct-e2e' : 'turn-prior-e2e', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: sent ? 'Codex received the direct companion message.' : 'Prior reply.' }] }] });
    } else if (message.params.name === 'list_threads') {
      response(message, { pinnedThreads: [], threads: [{ id: 'thread-named-e2e', title: 'Direct named QA', projectId: 'project-e2e', status: 'completed' }] });
    } else if (message.params.name === 'list_projects') {
      response(message, { projects: [{ projectId: 'project-e2e', label: 'QA', isGitRepository: true }] });
    } else if (message.params.name === 'create_thread') {
      response(message, { threadId: 'thread-created-e2e', hostId: 'local' });
    } else if (message.params.name === 'send_message_to_thread') {
      if (fs.existsSync(process.env.HEXIGRID_TEST_CODEX_BUSY_PATH)) continue;
      sent = true;
      fs.writeFileSync(process.env.HEXIGRID_TEST_CODEX_PROMPT_PATH, JSON.stringify({ threadId: message.params.arguments.threadId, text: message.params.arguments.prompt }));
      response(message, {});
    }
  }
});
`);
  await fs.writeFile(fakeCodexServer, `import fs from 'node:fs';
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.setEncoding('utf8').on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/); buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { serverInfo: { name: 'codex-relay-e2e', version: 'test' } } });
    else if (message.method === 'thread/list') send({ id: message.id, result: { data: [{ id: 'thread-named-e2e', name: 'Direct named QA' }], nextCursor: null } });
    else if (message.method === 'thread/resume') {
      if (fs.existsSync(process.env.HEXIGRID_TEST_CODEX_BUSY_PATH)) send({ id: message.id, error: { code: -32600, message: 'thread ' + message.params.threadId + ' already has an active writer' } });
      else send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    }
    else if (message.method === 'turn/start') {
      const text = (message.params.input || []).filter((item) => item.type === 'text').map((item) => item.text).join('\\n');
      fs.writeFileSync(process.env.HEXIGRID_TEST_CODEX_PROMPT_PATH, JSON.stringify({ threadId: message.params.threadId, text }));
      send({ id: message.id, result: { turn: { id: 'turn-direct-e2e', status: 'inProgress' } } });
      send({ method: 'item/agentMessage/delta', params: { delta: 'Codex received the direct companion message.' } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-direct-e2e', status: 'completed' } } });
    }
  }
});
`);
  if (process.platform === 'win32') {
    const nodePath = process.execPath.replaceAll('"', '""');
    const serverPath = fakeCodexServer.replaceAll('"', '""');
    await fs.writeFile(fakeCodexCommand, `@echo off\r\n@if "%1"=="--version" goto version\r\n@if "%1"=="login" goto login\r\n@"${nodePath}" "${serverPath}" %*\r\n@exit /b %errorlevel%\r\n:version\r\n@echo codex-relay-e2e\r\n@exit /b 0\r\n:login\r\n@echo Logged in\r\n@exit /b 0\r\n`);
  } else {
    await fs.writeFile(fakeCodexCommand, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo codex-relay-e2e; exit 0; fi\nif [ "$1" = "login" ]; then echo Logged in; exit 0; fi\nexec "${process.execPath}" "${fakeCodexServer}" "$@"\n`, { mode: 0o700 });
    await fs.chmod(fakeCodexCommand, 0o700);
  }
  const ownerPort = await freePort();
  const relayPort = await freePort();
  const origin = `http://127.0.0.1:${ownerPort}`;
  let server;
  let serverOutput = '';
  async function startServer() {
    serverOutput = '';
    server = spawn(process.execPath, ['server.mjs'], {
      cwd: root, windowsHide: true,
      env: { ...process.env, HEXIGRID_PORT: String(ownerPort), HEXIGRID_AGENT_RELAY_PORT: String(relayPort), HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: `http://127.0.0.1:${relayPort}`, HEXIGRID_DATA_DIR: dataDir, HEXIGRID_DISABLE_OS_VAULT: '1', HEXIGRID_TEST_CODEX_PROMPT_PATH: fakeCodexPrompt, HEXIGRID_TEST_CODEX_BUSY_PATH: fakeCodexBusy, CODEX_HOME: fakeCodexHome, CODEX_APP_TOOLS_PIPE_PATH: 'test-only', CODEX_CLI: fakeCodexCommand, OPENCODE_CLI: 'missing-opencode-companion-e2e' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    for (const stream of [server.stdout, server.stderr]) stream.setEncoding('utf8').on('data', (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-2000); });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetch(`${origin}/api/system/identity`)).ok && serverOutput.includes(`HexiGrid listening at ${origin}`)) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    throw new Error(`The isolated owner server did not start. ${serverOutput}`);
  }
  async function stopServer() {
    if (!server || server.exitCode !== null) return;
    const stopped = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await stopped;
  }
  let ownerCookie = '';
  async function ownerCall(pathname, method = 'GET', body) {
    const response = await fetch(`${origin}${pathname}`, { method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(ownerCookie ? { cookie: ownerCookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';', 1)[0] || '' };
  }
  async function agentEvents(token) {
    const pathname = '/agent-link/v1/events';
    const timestamp = new Date().toISOString();
    const nonce = `nonce-${crypto.randomUUID()}`;
    const response = await fetch(`${origin}${pathname}`, { headers: {
      authorization: `Bearer ${token}`, 'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signatureFor({ token, method: 'GET', pathname, timestamp, nonce, body: null })
    } });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  async function agentCall(token, pathname, method, body) {
    const timestamp = new Date().toISOString();
    const nonce = `nonce-${crypto.randomUUID()}`;
    const response = await fetch(`${origin}${pathname}`, { method, headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      'x-hexigrid-timestamp': timestamp, 'x-hexigrid-nonce': nonce,
      'x-hexigrid-signature': signatureFor({ token, method, pathname, timestamp, nonce, body })
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }

  await startServer();
  const localDoorWithoutVault = await ownerCall('/api/codex-door/v1/status');
  assert.equal(localDoorWithoutVault.status, 401);
  const browserDoorAttempt = await fetch(`${origin}/api/codex-door/v1/claim`, { method: 'POST', headers: { origin: origin, authorization: 'Bearer invalid', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(browserDoorAttempt.status, 403);
  assert.equal((await ownerCall('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' })).status, 200);
  const relayChoice = await ownerCall('/api/network/agent-relay', 'POST', { approved: true, provider: 'cloudflare-quick-tunnel' });
  assert.equal(relayChoice.status, 502, JSON.stringify(relayChoice.body));
  assert.match(relayChoice.body.error, /configured relay endpoint/);
  const unchangedRelay = await ownerCall('/api/network');
  assert.equal(unchangedRelay.body.agentRelay.running, false);
  assert.equal(unchangedRelay.body.agentRelay.selectedProvider, 'stable');
  const relay = await ownerCall('/api/network/agent-relay', 'POST', { approved: true, provider: 'stable' });
  assert.equal(relay.status, 200, JSON.stringify(relay.body));
  assert.equal(relay.body.agentRelay.selectedProvider, 'stable');
  assert.equal(relay.body.agentRelay.relayProvider, 'configured-reverse-proxy');
  const invited = await ownerCall('/api/agent-links/invites', 'POST', { capabilities: ['messages', 'status', 'memory-read'] });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const companion = new OutboundCompanionConnection({ inviteUrl: invited.body.companionInvitationUrl, capabilities: ['messages', 'status', 'memory-read'], automaticControl: false });
  await companion.connect();
  const paired = await companion.pair({ name: 'Isolated companion QA', framework: 'test', externalId: 'companion-server-e2e' });
  await companion.close();
  const connectionId = paired.connection.id;
  const configDir = path.join(agentHome, '.hexigrid-link');
  const vaultDir = path.join(configDir, 'vault');
  await fs.mkdir(vaultDir, { recursive: true });
  const alias = `hexigrid-link-${connectionId}`;
  await fs.writeFile(path.join(vaultDir, alias), paired.token, { mode: 0o600 });
  const configFile = path.join(configDir, `${connectionId}.json`);
  await fs.writeFile(configFile, JSON.stringify({ mode: 'outbound-companion', connectionId, origin: new URL(invited.body.companionInvitationUrl).origin,
    inviteId: companion.invitation.inviteId, deviceId: companion.invitation.deviceId, clientDeviceId: companion.clientDeviceId,
    tokenAlias: alias, lastSequence: 0 }), { mode: 0o600 });
  const agentEnv = { ...process.env, USERPROFILE: agentHome, HOME: agentHome };

  const codexRelay = await ownerCall('/api/settings', 'PATCH', { codexRelay: {
    enabled: true, linkId: connectionId, threadId: 'thread-companion-e2e', forwardReplies: true
  } });
  assert.equal(codexRelay.status, 200, JSON.stringify(codexRelay.body));
  assert.equal(codexRelay.body.settings.codexRelay.enabled, true);
  const first = await ownerCall(`/api/agent-links/${connectionId}/messages`, 'POST', { text: 'Isolated owner message one' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const watched = await runChild(['watch', '--connection', connectionId, '--for-seconds', '2'], agentEnv);
  assert.equal(watched.exitCode, 0, watched.stderr);
  assert.deepEqual(watched.reports.map((report) => report.type), ['ready', 'orientation', 'event', 'closed']);
  assert.equal(watched.reports[1].orientation.connection.id, connectionId);
  assert.equal(watched.reports[2].event.text, 'Isolated owner message one');
  assert.equal(watched.reports[2].event.sequence, 1);
  assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).lastSequence, 1);
  assert.equal((await agentEvents(paired.token)).body.events[0].acknowledgedAt !== null, true);

  assert.equal((await ownerCall('/api/settings', 'PATCH', { workMode: 'converse' })).status, 200);
  await stopServer();
  await startServer();
  assert.match(serverOutput, /Agent relay auto-start blocked by active work mode: Converse mode does not permit external_write\./);
  assert.doesNotMatch(serverOutput, /Agent relay ready at /);
  assert.equal((await ownerCall('/api/settings', 'PATCH', { workMode: 'build' })).status, 200);
  const resumedRelay = await ownerCall('/api/network/agent-relay', 'POST', { approved: true, provider: 'stable' });
  assert.equal(resumedRelay.status, 200, JSON.stringify(resumedRelay.body));
  const second = await ownerCall(`/api/agent-links/${connectionId}/messages`, 'POST', { text: 'Isolated owner message two' });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const resumed = await runChild(['watch', '--connection', connectionId, '--for-seconds', '2'], agentEnv);
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  assert.deepEqual(resumed.reports.map((report) => report.type), ['ready', 'orientation', 'event', 'closed']);
  assert.equal(resumed.reports[1].orientation.connection.id, connectionId);
  assert.equal(resumed.reports[2].event.text, 'Isolated owner message two');
  assert.equal(resumed.reports[2].event.sequence, 2);
  assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).lastSequence, 2);
  assert.equal((await agentEvents(paired.token)).body.events.every((event) => event.acknowledgedAt), true);

  const incoming = await agentCall(paired.token, '/agent-link/v1/messages', 'POST', {
    clientMessageId: 'codex-relay-e2e-0001', text: 'Direct ExampleAgent-to-Codex door probe.'
  });
  assert.equal(incoming.status, 201, JSON.stringify(incoming.body));
  const directReply = await runChild(['watch', '--connection', connectionId, '--for-seconds', '3'], agentEnv);
  assert.equal(directReply.exitCode, 0, directReply.stderr);
  const directEvent = directReply.reports.find((report) => report.type === 'event')?.event;
  assert.equal(directEvent?.type, 'message');
  assert.match(directEvent?.text || '', /Codex received the direct companion message/);
  assert.equal(directEvent?.metadata?.channel, 'codex-thread');
  assert.equal(directEvent?.metadata?.threadId, 'thread-companion-e2e');
  assert.equal(directEvent?.sequence, 3);
  assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).lastSequence, 3);
  assert.equal((await agentEvents(paired.token)).body.events.every((event) => event.acknowledgedAt), true);
  const directHistory = await agentCall(paired.token, '/agent-link/v1/messages', 'GET');
  assert.equal(directHistory.status, 200, JSON.stringify(directHistory.body));
  assert.equal(directHistory.body.messages.some((message) => message.id === incoming.body.message.id && message.direction === 'from-agent'), true);
  assert.equal(directHistory.body.messages.some((message) => message.id === directEvent.id && message.direction === 'from-codex' && message.text === directEvent.text), true);
  assert.equal(directHistory.body.messages.some((message) => message.direction === 'from-owner' && message.text === 'Isolated owner message one'), true);
  assert.equal(directHistory.body.messages.some((message) => message.direction === 'from-codex' && message.text.includes('Isolated owner message')), false);
  const companionHistory = await runChild(['history', '--connection', connectionId, '--limit', '2'], agentEnv);
  assert.equal(companionHistory.exitCode, 0, companionHistory.stderr);
  assert.equal(companionHistory.reports[0].result.messages.length, 2);
  assert.equal(companionHistory.reports[0].result.messages.some((message) => message.id === directEvent.id && message.direction === 'from-codex'), true);
  const earlierHistory = await runChild(['history', '--connection', connectionId, '--before', companionHistory.reports[0].result.nextCursor], agentEnv);
  assert.equal(earlierHistory.exitCode, 0, earlierHistory.stderr);
  assert.equal(earlierHistory.reports[0].result.messages.some((message) => message.direction === 'from-owner' && message.text === 'Isolated owner message one'), true);
  const codexPrompt = JSON.parse(await fs.readFile(fakeCodexPrompt, 'utf8'));
  assert.equal(codexPrompt.threadId, 'thread-companion-e2e');
  assert.match(codexPrompt.text, new RegExp(`Link message ID: ${incoming.body.message.id}`));
  assert.match(codexPrompt.text, /Sender: Isolated companion QA/);
  assert.match(codexPrompt.text, /Direct ExampleAgent-to-Codex door probe\./);

  await fs.writeFile(fakeCodexBusy, 'active writer');
  const queuedWhileBusy = await agentCall(paired.token, '/agent-link/v1/messages', 'POST', {
    clientMessageId: 'codex-relay-e2e-0002', text: 'Deliver this only after the busy writer and owner restart.'
  });
  assert.equal(queuedWhileBusy.status, 201, JSON.stringify(queuedWhileBusy.body));
  assert.equal((await agentEvents(paired.token)).body.events.some((event) => event.sequence === 4), false);
  await stopServer();
  await fs.rm(fakeCodexBusy);
  await startServer();
  const recovered = await runChild(['watch', '--connection', connectionId, '--for-seconds', '3'], agentEnv);
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  const recoveredEvent = recovered.reports.find((report) => report.type === 'event')?.event;
  assert.equal(recoveredEvent?.sequence, 4);
  assert.equal(recoveredEvent?.metadata?.channel, 'codex-thread');
  assert.match(JSON.parse(await fs.readFile(fakeCodexPrompt, 'utf8')).text, /Deliver this only after the busy writer and owner restart/);

  const ownerFile = path.join(dataDir, 'owner-agent-qa.bin');
  const scopedRead = await agentCall(paired.token, '/agent-link/v1/owner/fs/read', 'POST', { path: ownerFile });
  assert.equal(scopedRead.status, 403);
  const namedWhileScoped = await agentCall(paired.token, '/agent-link/v1/messages', 'POST', { clientMessageId: 'codex-named-scoped', text: 'Do not deliver.', metadata: { codexThreadName: 'Direct named QA' } });
  assert.equal(namedWhileScoped.status, 403);
  const ownerTrust = await ownerCall(`/api/agent-links/${connectionId}/trust`, 'PATCH', { trustLevel: 'owner', approved: true });
  assert.equal(ownerTrust.status, 200, JSON.stringify(ownerTrust.body));
  assert.equal(ownerTrust.body.connection.trustLevel, 'owner');
  const beforeSession = await agentCall(paired.token, '/agent-link/v1/owner/fs/list', 'POST', { path: dataDir });
  assert.equal(beforeSession.status, 403);
  const ownerScopes = await ownerCall(`/api/agent-links/${connectionId}/capabilities`, 'PATCH', { capabilities: [...ownerTrust.body.connection.capabilities, 'desktop-view', 'desktop-control'], approved: true });
  assert.equal(ownerScopes.status, 200, JSON.stringify(ownerScopes.body));
  const session = await ownerCall('/api/desktop-bridge/start', 'POST', { linkId: connectionId, viewGranted: true, controlGranted: true, approved: true });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  const data = Buffer.from([0, 255, 32, 10]);
  const created = await agentCall(paired.token, '/agent-link/v1/owner/fs/write', 'POST', { path: ownerFile, data: data.toString('base64'), createOnly: true });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const read = await agentCall(paired.token, '/agent-link/v1/owner/fs/read', 'POST', { path: ownerFile });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(Buffer.from(read.body.data, 'base64'), data);
  const executed = await agentCall(paired.token, '/agent-link/v1/owner/exec', 'POST', { command: process.execPath, args: ['-e', 'process.stdout.write("owner-live-e2e")'], cwd: dataDir });
  assert.equal(executed.status, 200, JSON.stringify(executed.body));
  assert.equal(executed.body.stdout, 'owner-live-e2e');
  const largeAgentFile = path.join(agentHome, 'agent-large.bin');
  const largeOwnerFile = path.join(dataDir, 'owner-large.bin');
  const largeOutputFile = path.join(agentHome, 'agent-large-readback.bin');
  const largeBytes = crypto.randomBytes(600 * 1024);
  await fs.writeFile(largeAgentFile, largeBytes);
  const largeWrite = await runChild(['owner-write', '--connection', connectionId, '--path', largeOwnerFile, '--file', largeAgentFile, '--create-only'], agentEnv);
  assert.equal(largeWrite.exitCode, 0, largeWrite.stderr);
  assert.deepEqual(await fs.readFile(largeOwnerFile), largeBytes);
  const largeRead = await runChild(['owner-read', '--connection', connectionId, '--path', largeOwnerFile, '--output', largeOutputFile], agentEnv);
  assert.equal(largeRead.exitCode, 0, largeRead.stderr);
  assert.deepEqual(await fs.readFile(largeOutputFile), largeBytes);
  const namedSettings = await ownerCall('/api/settings', 'PATCH', { codexRelay: { enabled: true, linkId: connectionId, threadId: 'thread-companion-e2e', forwardReplies: true, allowNamedThreads: true } });
  assert.equal(namedSettings.status, 200, JSON.stringify(namedSettings.body));
  const named = await agentCall(paired.token, '/agent-link/v1/messages', 'POST', { clientMessageId: 'codex-named-owner-e2e', text: 'Route by exact title now.', metadata: { codexThreadName: 'Direct named QA' } });
  assert.equal(named.status, 201, JSON.stringify(named.body));
  let namedEvent;
  for (let attempt = 0; attempt < 50 && !namedEvent; attempt += 1) {
    namedEvent = (await agentEvents(paired.token)).body.events.find((event) => event.metadata?.threadName === 'Direct named QA');
    if (!namedEvent) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(namedEvent?.metadata?.channel, 'codex-thread');
  assert.equal(namedEvent?.metadata?.threadId, 'thread-named-e2e');
  assert.match(JSON.parse(await fs.readFile(fakeCodexPrompt, 'utf8')).text, /Route by exact title now/);
  const directory = await agentCall(paired.token, '/agent-link/v1/codex/chats', 'GET');
  assert.equal(directory.status, 200, JSON.stringify(directory.body));
  assert.equal(directory.body.chats[0].id, 'thread-named-e2e');
  const projects = await agentCall(paired.token, '/agent-link/v1/codex/projects', 'GET');
  assert.equal(projects.status, 200, JSON.stringify(projects.body));
  assert.equal(projects.body.projects[0].projectId, 'project-e2e');
  const createdChat = await agentCall(paired.token, '/agent-link/v1/codex/chats', 'POST', { projectId: 'project-e2e', prompt: 'Harmless new chat QA', title: 'QA chat' });
  assert.equal(createdChat.status, 201, JSON.stringify(createdChat.body));
  assert.equal(createdChat.body.threadId, 'thread-created-e2e');
  const directById = await agentCall(paired.token, '/agent-link/v1/messages', 'POST', { clientMessageId: 'codex-id-owner-e2e', text: 'Route by exact ID now.', metadata: { codexThreadId: 'thread-named-e2e' } });
  assert.equal(directById.status, 201, JSON.stringify(directById.body));
  let directIdEvent;
  for (let attempt = 0; attempt < 50 && !directIdEvent; attempt += 1) {
    directIdEvent = (await agentEvents(paired.token)).body.events.find((event) => event.metadata?.sourceMessageId === directById.body.message.id);
    if (!directIdEvent) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(directIdEvent?.metadata?.threadId, 'thread-named-e2e');
  assert.equal(directIdEvent?.metadata?.channel, 'codex-thread');
  const auth = await ownerCall('/api/auth/setup', 'POST', { password: 'companion-memory-qa-passphrase' });
  assert.equal(auth.status, 200, JSON.stringify(auth.body));
  ownerCookie = auth.cookie;
  assert.ok(ownerCookie);
  const committed = await ownerCall(`/api/agents/${paired.connection.agentId}/memory-commit`, 'POST', {
    operation: 'create', text: 'Exact companion memory over the encrypted Door.', contextScope: { projectId: 'companion-memory-qa', topicId: 'transport' }
  });
  assert.equal(committed.status, 201, JSON.stringify(committed.body));
  const privateMemory = await ownerCall(`/api/agents/${paired.connection.agentId}/memory-commit`, 'POST', {
    operation: 'create', text: 'This separate scope stays private.', contextScope: { projectId: 'companion-memory-qa', topicId: 'private' }
  });
  assert.equal(privateMemory.status, 201, JSON.stringify(privateMemory.body));
  const targetInvite = await ownerCall('/api/agent-links/invites', 'POST', { capabilities: ['memory-read'] });
  assert.equal(targetInvite.status, 201, JSON.stringify(targetInvite.body));
  const targetCompanion = new OutboundCompanionConnection({ inviteUrl: targetInvite.body.companionInvitationUrl,
    capabilities: ['memory-read'], automaticControl: false });
  await targetCompanion.connect();
  const targetPair = await targetCompanion.pair({ name: 'Recipient companion QA', framework: 'test', externalId: 'shared-memory-recipient-e2e' });
  await targetCompanion.close();
  const targetLinkId = targetPair.connection.id;
  const targetAlias = `hexigrid-link-${targetLinkId}`;
  await fs.writeFile(path.join(vaultDir, targetAlias), targetPair.token, { mode: 0o600 });
  await fs.writeFile(path.join(configDir, `${targetLinkId}.json`), JSON.stringify({ mode: 'outbound-companion', connectionId: targetLinkId,
    origin: new URL(targetInvite.body.companionInvitationUrl).origin, inviteId: targetCompanion.invitation.inviteId,
    deviceId: targetCompanion.invitation.deviceId, clientDeviceId: targetCompanion.clientDeviceId, tokenAlias: targetAlias, lastSequence: 0 }), { mode: 0o600 });
  const beforeGrant = await runChild(['memory-shares', '--connection', targetLinkId], agentEnv);
  assert.equal(beforeGrant.exitCode, 0, beforeGrant.stderr);
  assert.deepEqual(beforeGrant.reports[0].result.shares, []);
  const grant = await ownerCall('/api/memory-shares', 'POST', { sourceAgentId: paired.connection.agentId,
    targetLinkId, scope: { projectId: 'companion-memory-qa', topicId: 'transport' }, approved: true });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  const shareId = grant.body.share.id;
  const shares = await runChild(['memory-shares', '--connection', targetLinkId], agentEnv);
  assert.equal(shares.exitCode, 0, shares.stderr);
  assert.deepEqual(shares.reports[0].result.shares.map((share) => share.id), [shareId]);
  assert.deepEqual(shares.reports[0].result.shares[0].scope, { projectId: 'companion-memory-qa', topicId: 'transport' });
  assert.equal(JSON.stringify(shares.reports[0]).includes('Exact companion memory over the encrypted Door.'), false);
  const sharedContext = await runChild(['memory-shared-context', '--connection', targetLinkId, '--share', shareId], agentEnv);
  assert.equal(sharedContext.exitCode, 0, sharedContext.stderr);
  assert.equal(sharedContext.reports[0].result.context.memories[0].id, committed.body.id);
  assert.equal(sharedContext.reports[0].result.context.memories[0].text, 'Exact companion memory over the encrypted Door.');
  assert.equal(JSON.stringify(sharedContext.reports[0]).includes('This separate scope stays private.'), false);
  const activeShareBackup = await ownerCall('/api/backup/export', 'POST', { passphrase: 'companion-share-backup-passphrase' });
  assert.equal(activeShareBackup.status, 200, JSON.stringify(activeShareBackup.body));
  const discovered = await runChild(['memory-scopes', '--connection', connectionId], agentEnv);
  assert.equal(discovered.exitCode, 0, discovered.stderr);
  assert.ok(discovered.reports[0].result.result.structuredContent.scopes.some((scope) => scope.projectId === 'companion-memory-qa' && scope.topicId === 'transport'));
  const recalled = await runChild(['memory-context', '--connection', connectionId, '--project', 'companion-memory-qa', '--topic', 'transport'], agentEnv);
  assert.equal(recalled.exitCode, 0, recalled.stderr);
  assert.equal(recalled.reports[0].result.result.structuredContent.memories[0].text, 'Exact companion memory over the encrypted Door.');
  assert.equal(recalled.reports[0].result.result.structuredContent.memories[0].id, committed.body.id);
  const selected = await runChild(['memory-select', '--connection', connectionId, '--project', 'companion-memory-qa', '--topic', 'transport'], agentEnv);
  assert.equal(selected.exitCode, 0, selected.stderr);
  assert.equal(selected.reports[0].result.memoryScope.projectId, 'companion-memory-qa');
  const selectedForThread = await runChild(['memory-select', '--connection', connectionId, '--thread-id', 'thread-named-e2e',
    '--project', 'companion-memory-qa', '--topic', 'private'], agentEnv);
  assert.equal(selectedForThread.exitCode, 0, selectedForThread.stderr);
  assert.equal(selectedForThread.reports[0].result.codexThreadId, 'thread-named-e2e');
  assert.equal(selectedForThread.reports[0].result.memoryScope.topicId, 'private');
  const nameTarget = await agentCall(paired.token, '/agent-link/v1/messages', 'POST', {
    clientMessageId: 'codex-named-scope-no-fallback', text: 'A name is not a memory scope key.', metadata: { codexThreadName: 'Direct named QA' }
  });
  assert.equal(nameTarget.status, 201, JSON.stringify(nameTarget.body));
  assert.equal(nameTarget.body.memoryContext.state, 'not-selected');
  await stopServer();
  await startServer();
  const resumedOwner = await ownerCall('/api/auth/login', 'POST', { password: 'companion-memory-qa-passphrase' });
  assert.equal(resumedOwner.status, 200, JSON.stringify(resumedOwner.body));
  ownerCookie = resumedOwner.cookie;
  const persistedShares = await runChild(['memory-shares', '--connection', targetLinkId], agentEnv);
  assert.equal(persistedShares.exitCode, 0, persistedShares.stderr);
  assert.deepEqual(persistedShares.reports[0].result.shares.map((share) => share.id), [shareId]);
  const persistedContext = await runChild(['memory-shared-context', '--connection', targetLinkId, '--share', shareId], agentEnv);
  assert.equal(persistedContext.exitCode, 0, persistedContext.stderr);
  assert.equal(persistedContext.reports[0].result.context.memories[0].id, committed.body.id);
  const automatic = await runChild(['send', '--connection', connectionId, '--text', 'Check the current project context.'], agentEnv);
  assert.equal(automatic.exitCode, 0, automatic.stderr);
  assert.equal(automatic.reports[0].result.memoryContext.state, 'current');
  assert.equal(automatic.reports[0].result.memoryContext.memories[0].id, committed.body.id);
  const threadSpecific = await runChild(['send', '--connection', connectionId, '--thread-id', 'thread-named-e2e', '--text', 'Check this chat’s separate context.'], agentEnv);
  assert.equal(threadSpecific.exitCode, 0, threadSpecific.stderr);
  assert.equal(threadSpecific.reports[0].result.memoryContext.state, 'current');
  assert.equal(threadSpecific.reports[0].result.memoryContext.memories[0].id, privateMemory.body.id);
  const otherTarget = await runChild(['send', '--connection', connectionId, '--thread-id', 'thread-created-e2e', '--text', 'Do not reuse another chat’s context.'], agentEnv);
  assert.equal(otherTarget.exitCode, 0, otherTarget.stderr);
  assert.equal(otherTarget.reports[0].result.memoryContext.state, 'not-selected');
  const clearThread = await runChild(['memory-clear', '--connection', connectionId, '--thread-id', 'thread-named-e2e'], agentEnv);
  assert.equal(clearThread.exitCode, 0, clearThread.stderr);
  assert.equal(clearThread.reports[0].result.codexThreadId, 'thread-named-e2e');
  assert.equal(clearThread.reports[0].result.memoryScope, null);
  const clearedTarget = await runChild(['send', '--connection', connectionId, '--thread-id', 'thread-named-e2e', '--text', 'The cleared chat stays isolated.'], agentEnv);
  assert.equal(clearedTarget.exitCode, 0, clearedTarget.stderr);
  assert.equal(clearedTarget.reports[0].result.memoryContext.state, 'not-selected');
  const cleared = await runChild(['memory-clear', '--connection', connectionId], agentEnv);
  assert.equal(cleared.exitCode, 0, cleared.stderr);
  assert.equal(cleared.reports[0].result.memoryScope, null);
  const revokedShare = await ownerCall(`/api/memory-shares/${shareId}/revoke`, 'POST', { approved: true });
  assert.equal(revokedShare.status, 200, JSON.stringify(revokedShare.body));
  assert.equal(revokedShare.body.share.status, 'revoked');
  const afterRevoke = await runChild(['memory-shares', '--connection', targetLinkId], agentEnv);
  assert.equal(afterRevoke.exitCode, 0, afterRevoke.stderr);
  assert.deepEqual(afterRevoke.reports[0].result.shares, []);
  const deniedSharedContext = await runChild(['memory-shared-context', '--connection', targetLinkId, '--share', shareId], agentEnv);
  assert.notEqual(deniedSharedContext.exitCode, 0);
  assert.match(deniedSharedContext.stderr, /no active grant/i);
  const downgraded = await ownerCall(`/api/agent-links/${connectionId}/trust`, 'PATCH', { trustLevel: 'scoped', approved: true });
  assert.equal(downgraded.status, 200, JSON.stringify(downgraded.body));
  assert.equal((await agentCall(paired.token, '/agent-link/v1/owner/fs/read', 'POST', { path: ownerFile })).status, 403);
  assert.equal((await agentCall(paired.token, '/agent-link/v1/messages', 'POST', { clientMessageId: 'codex-named-after-revoke', text: 'Do not deliver.', metadata: { codexThreadName: 'Direct named QA' } })).status, 403);

  const removed = await ownerCall(`/api/agent-links/${connectionId}`, 'DELETE', {});
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await agentEvents(paired.token)).status, 410);
  const denied = await runChild(['heartbeat', '--connection', connectionId], agentEnv);
  assert.notEqual(denied.exitCode, 0);
  assert.equal(denied.stdout.includes(paired.token), false);
  const restoredBackup = await ownerCall('/api/backup/import', 'POST', { envelope: activeShareBackup.body.envelope,
    passphrase: 'companion-share-backup-passphrase', confirmReplace: true, approved: true });
  assert.equal(restoredBackup.status, 200, JSON.stringify(restoredBackup.body));
  const restoredOwner = await ownerCall('/api/auth/login', 'POST', { password: 'companion-memory-qa-passphrase' });
  assert.equal(restoredOwner.status, 200, JSON.stringify(restoredOwner.body));
  ownerCookie = restoredOwner.cookie;
  const restoredShares = await ownerCall('/api/memory-shares');
  assert.equal(restoredShares.status, 200, JSON.stringify(restoredShares.body));
  assert.equal(restoredShares.body.shares.find((share) => share.id === shareId)?.status, 'revoked');
  assert.equal((await agentCall(targetPair.token, '/agent-link/v1/shared-memory', 'POST', { operation: 'recall', shareId })).status, 401);
});
