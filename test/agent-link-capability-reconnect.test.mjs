import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signatureFor } from '../lib/agent-link.mjs';
import { OutboundCompanionConnection } from '../lib/companion-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testRootPrefix = 'hexigrid-link-capability-reconnect-';
const ownerPassword = 'synthetic-link-capability-test-passphrase';
const capabilities = ['messages', 'status', 'token-metering'];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const childExited = (child) => child.exitCode !== null || child.signalCode !== null;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function exitedWithin(child, timeoutMs) {
  if (childExited(child)) return true;
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => {
      child.off('exit', finish);
      resolve(childExited(child));
    }, timeoutMs);
    child.once('exit', finish);
  });
}

async function removeGeneratedTree(candidate, generatedRoot) {
  const absoluteRoot = path.resolve(generatedRoot);
  const absoluteTarget = path.resolve(candidate);
  assert.ok(path.isAbsolute(absoluteRoot) && path.isAbsolute(absoluteTarget), 'cleanup paths must be absolute');
  assert.equal(absoluteTarget, absoluteRoot, 'recursive cleanup is limited to the generated test root');
  assert.ok(path.basename(absoluteRoot).startsWith(testRootPrefix), 'cleanup root must be the test-generated temp directory');
  const realTemp = await fs.realpath(os.tmpdir());
  const realRoot = await fs.realpath(absoluteRoot);
  const relative = path.relative(realTemp, realRoot);
  assert.ok(relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'generated cleanup root must remain inside the operating-system temp directory');
  await fs.rm(realRoot, { recursive: true, force: true });
}

function waitForEvent(target, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    const onEvent = (event) => { clearTimeout(timer); target.removeEventListener(name, onEvent); resolve(event.detail); };
    const timer = setTimeout(() => {
      target.removeEventListener(name, onEvent);
      reject(new Error('The shipped companion did not reconnect before the bounded deadline.'));
    }, timeoutMs);
    target.addEventListener(name, onEvent, { once: true });
  });
}

test('scoped Link capabilities pause, resume, and survive owned-server restart and revoke', { timeout: 90_000 }, async () => {
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), testRootPrefix));
  const dataDir = path.join(generatedRoot, 'local-data');
  const workspaceRoot = path.join(generatedRoot, 'synthetic-workspace');
  const profileRoot = path.join(generatedRoot, 'synthetic-profile');
  await fs.mkdir(profileRoot, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'README.md'), 'Synthetic local Link regression fixture.\n', { mode: 0o600 });

  let server = null;
  let companion = null;
  let ownerCookie = '';
  const port = await freePort();
  let relayPort = await freePort();
  while (relayPort === port) relayPort = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const relayOrigin = 'http://127.0.0.1:' + relayPort;

  async function startOwnedServer() {
    const childEnv = {
      HEXIGRID_HOST: '127.0.0.1',
      HEXIGRID_PORT: String(port),
      HEXIGRID_AGENT_RELAY_PORT: String(relayPort),
      HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: relayOrigin,
      HEXIGRID_DATA_DIR: dataDir,
      HEXIGRID_AGENT_LINK_WORKSPACE_ROOT: workspaceRoot,
      HEXIGRID_DISABLE_OS_VAULT: '1',
      HOME: profileRoot, USERPROFILE: profileRoot, APPDATA: profileRoot, LOCALAPPDATA: profileRoot,
      CODEX_HOME: path.join(profileRoot, 'codex'),
      CODEX_CLI: path.join(profileRoot, 'absent-codex'),
      CLAUDE_CLI: path.join(profileRoot, 'absent-claude'),
      OPENCODE_CLI: 'missing-link-capability-regression-model'
    };
    if (process.platform === 'win32' && process.env.SystemRoot) {
      childEnv.SystemRoot = process.env.SystemRoot;
      childEnv.SYSTEMROOT = process.env.SystemRoot;
    }
    const ownedChild = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    server = ownedChild;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (childExited(ownedChild)) throw new Error('The test-owned server exited before readiness.');
      try {
        const response = await fetch(origin + '/', { signal: AbortSignal.timeout(700) });
        if (response.ok) return;
      } catch { /* bounded readiness poll against the owned loopback server */ }
      await delay(75);
    }
    throw new Error('The test-owned server did not become ready before its bounded deadline.');
  }

  async function stopOwnedServer() {
    const ownedChild = server;
    if (!ownedChild) return;
    if (!childExited(ownedChild)) {
      ownedChild.kill();
      if (!await exitedWithin(ownedChild, 4_000)) {
        ownedChild.kill('SIGKILL');
        if (!await exitedWithin(ownedChild, 2_000)) throw new Error('The exact test-owned server child did not stop.');
      }
    }
    server = null;
  }

  async function ownerCall(pathname, method = 'GET', body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (ownerCookie) headers.cookie = ownerCookie;
    const response = await fetch(origin + pathname, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000)
    });
    return {
      status: response.status,
      body: await response.json().catch(() => ({})),
      cookie: response.headers.get('set-cookie')?.split(';', 1)[0] || ''
    };
  }

  function signedSpec(token, pathname, method = 'GET', body, nonce = 'link-' + crypto.randomUUID()) {
    const timestamp = new Date().toISOString();
    return {
      token, pathname, method, body, timestamp, nonce,
      signature: signatureFor({ token, method, pathname, timestamp, nonce, body: body ?? null })
    };
  }

  async function sendSigned(spec) {
    const headers = {
      authorization: 'Bearer ' + spec.token,
      'x-hexigrid-timestamp': spec.timestamp,
      'x-hexigrid-nonce': spec.nonce,
      'x-hexigrid-signature': spec.signature
    };
    if (spec.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(origin + spec.pathname, {
      method: spec.method,
      headers,
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
      signal: AbortSignal.timeout(5_000)
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }

  async function ownerSetCapabilities(connectionId, nextCapabilities) {
    const result = await ownerCall('/api/agent-links/' + connectionId + '/capabilities', 'PATCH', {
      capabilities: nextCapabilities, approved: true
    });
    assert.equal(result.status, 200, 'owner capability change should succeed');
    assert.equal(result.body.connection.id, connectionId, 'owner update must retain the exact Link');
    assert.equal(result.body.connection.authorizationStatus, 'connected', 'capability changes must retain authorization');
    return result.body.connection;
  }

  function tokenReport(token) {
    return sendSigned(signedSpec(token, '/agent-link/v1/tokens', 'POST', {
      origin: 'ilands', before: 1000, after: 990, unit: 'synthetic test units', note: 'isolated capability regression'
    }));
  }

  function agentMessage(token, ordinal) {
    return sendSigned(signedSpec(token, '/agent-link/v1/messages', 'POST', {
      clientMessageId: 'capability-reconnect-' + ordinal + '-' + crypto.randomUUID(),
      text: 'Synthetic metadata and message ' + ordinal,
      metadata: { regression: 'capability-reconnect', ordinal }
    }));
  }

  async function ownerLink(connectionId) {
    const result = await ownerCall('/api/agent-links');
    assert.equal(result.status, 200, 'owner Link state should be readable');
    const link = result.body.connections.find((item) => item.id === connectionId);
    assert.ok(link, 'the exact Link should remain in owner state');
    return link;
  }

  try {
    await startOwnedServer();
    const setup = await ownerCall('/api/auth/setup', 'POST', { password: ownerPassword });
    assert.equal(setup.status, 200, 'synthetic local owner setup should succeed');
    ownerCookie = setup.cookie;
    assert.ok(ownerCookie, 'the test owner session should be returned');

    const policy = await ownerCall('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
    assert.equal(policy.status, 200, 'local test policy should allow the explicitly approved owner actions');

    const relay = await ownerCall('/api/network/agent-relay', 'POST', { approved: true, provider: 'stable' });
    assert.equal(relay.status, 200, 'the configured loopback relay should start');
    assert.equal(relay.body.agentRelay.running, true, 'the test-owned loopback relay should be running');
    assert.equal(relay.body.agentRelay.relayProvider, 'configured-reverse-proxy');

    const invited = await ownerCall('/api/agent-links/invites', 'POST', { capabilities });
    assert.equal(invited.status, 201, 'scoped Link invitation should be created');
    assert.ok(invited.body.companionInvitationUrl, 'the shipped outbound companion invitation should be available');
    assert.deepEqual(invited.body.invite.requestedCapabilities, capabilities);

    const boundedFetch = (url, init = {}) => fetch(url, {
      ...init,
      ...(init.signal ? {} : { signal: AbortSignal.timeout(String(url).includes('/poll?') ? 25_000 : 5_000) })
    });
    companion = new OutboundCompanionConnection({
      inviteUrl: invited.body.companionInvitationUrl,
      capabilities,
      fetchFn: boundedFetch,
      requestTimeoutMs: 5_000,
      automaticControl: false
    });
    await companion.connect();
    const paired = await companion.pair({
      name: 'Synthetic capability regression Link',
      framework: 'test',
      externalId: 'synthetic-capability-reconnect'
    });
    const connectionId = paired.connection.id;
    const token = paired.token;
    assert.equal(typeof token, 'string', 'pairing should return the synthetic Link token');
    assert.deepEqual(paired.connection.capabilities, capabilities);
    assert.equal(paired.connection.authorizationStatus, 'connected');
    assert.equal(paired.connection.identity.externalId, 'synthetic-capability-reconnect');
    assert.equal(paired.connection.capabilities.some((item) => /desktop|workspace|owner-filesystem|owner-process/.test(item)), false,
      'the scoped Link must not receive desktop, filesystem, or system scopes');

    const bootstrap = await ownerCall('/api/bootstrap');
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.security.localStateEncryption, 'encrypted-local-key-fallback',
      'only the synthetic local encrypted-state fallback should be active');
    const stateEnvelope = JSON.parse(await fs.readFile(path.join(dataDir, 'control-room.json'), 'utf8'));
    assert.equal(stateEnvelope.format, 'hexigrid-local-state');
    assert.equal(stateEnvelope.cipher, 'aes-256-gcm');
    assert.equal(JSON.stringify(stateEnvelope).includes(token), false, 'the generated local state envelope must not expose the Link token');

    const signedOnce = signedSpec(token, '/agent-link/v1/tokens', 'POST', {
      origin: 'ilands', before: 1000, after: 990, unit: 'synthetic test units', note: 'signature regression'
    }, 'capability-reconnect-replay-nonce');
    const invalidSignature = await sendSigned({ ...signedOnce, signature: 'invalid-signature' });
    assert.equal(invalidSignature.status, 401, 'an invalid Link signature must be rejected');
    const acceptedSignature = await sendSigned(signedOnce);
    assert.equal(acceptedSignature.status, 201, 'a valid signature should be accepted after a rejected signature');
    assert.equal(acceptedSignature.body.measurement.delta, 10);
    const replayedNonce = await sendSigned(signedOnce);
    assert.equal(replayedNonce.status, 401, 'a valid signed nonce must be rejected on replay');

    const beforeRemoval = await ownerLink(connectionId);
    assert.equal(beforeRemoval.authorizationStatus, 'connected');
    assert.equal(beforeRemoval.tokenUsage.measurements.length, 1, 'only the accepted signed measurement should persist');
    const withoutMetering = capabilities.filter((item) => item !== 'token-metering');
    const removedMetering = await ownerSetCapabilities(connectionId, withoutMetering);
    assert.deepEqual(removedMetering.capabilities, withoutMetering);
    assert.equal((await tokenReport(token)).status, 403, 'signed token measurement must be denied while token metering is removed');
    const messageWithoutMetering = await agentMessage(token, 1);
    assert.equal(messageWithoutMetering.status, 201, 'messages must remain available without token metering');
    assert.equal(messageWithoutMetering.body.message.metadata.regression, 'capability-reconnect');
    assert.equal(messageWithoutMetering.body.message.metadata.ordinal, 1);

    const restored = await ownerSetCapabilities(connectionId, capabilities);
    assert.deepEqual(restored.capabilities, capabilities);
    assert.equal((await tokenReport(token)).status, 201, 'signed token measurement should recover when the owner restores token metering');

    const withoutMessages = capabilities.filter((item) => item !== 'messages');
    const paused = await ownerSetCapabilities(connectionId, withoutMessages);
    assert.deepEqual(paused.capabilities, withoutMessages);
    assert.equal((await agentMessage(token, 2)).status, 403, 'the paused messages scope must deny signed messages');
    assert.equal((await tokenReport(token)).status, 201, 'token metering must remain independent while messages are paused');
    const resumed = await ownerSetCapabilities(connectionId, capabilities);
    assert.deepEqual(new Set(resumed.capabilities), new Set(capabilities));
    const recoveredMessage = await agentMessage(token, 3);
    assert.equal(recoveredMessage.status, 201, 'messages should recover after the owner resumes their scope');

    const beforeRestart = await ownerLink(connectionId);
    assert.equal(beforeRestart.authorizationStatus, 'connected');
    assert.equal(beforeRestart.messages.length, 2, 'messages should persist independently across capability changes');
    assert.equal(beforeRestart.messages[0].metadata.ordinal, 1);
    assert.equal(beforeRestart.messages[1].metadata.ordinal, 3);
    const reconnectEvent = waitForEvent(companion, 'reconnected', 20_000);
    await stopOwnedServer();
    await startOwnedServer();

    const relogin = await ownerCall('/api/auth/login', 'POST', { password: ownerPassword });
    assert.equal(relogin.status, 200, 'the synthetic local owner should be able to resume its session');
    ownerCookie = relogin.cookie;
    assert.ok(ownerCookie);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await ownerCall('/api/network');
      if (status.status === 200 && status.body.agentRelay.running === true) break;
      if (attempt === 99) assert.fail('the test-owned loopback relay did not resume before its bounded deadline');
      await delay(75);
    }
    const reconnected = await reconnectEvent;
    assert.equal(companion.state.state, 'connected', 'the shipped companion should report a connected resumed session');
    assert.ok(reconnected.peerId, 'the companion should establish a new relay peer');

    const resumedByCompanion = await companion.linkRequest('/agent-link/v1/capabilities');
    assert.equal(resumedByCompanion.status, 200, 'the shipped companion should use the same Link after restart');
    assert.equal(resumedByCompanion.body.connection.id, connectionId);
    assert.equal(resumedByCompanion.body.connection.authorizationStatus, 'connected');
    assert.deepEqual(new Set(resumedByCompanion.body.connection.capabilities), new Set(capabilities));
    const resumedByToken = await sendSigned(signedSpec(token, '/agent-link/v1/capabilities'));
    assert.equal(resumedByToken.status, 200, 'the exact old signed token should survive the server restart');
    assert.equal(resumedByToken.body.connection.id, connectionId);
    assert.equal(resumedByToken.body.connection.authorizationStatus, 'connected');

    const afterRestart = await ownerLink(connectionId);
    assert.equal(afterRestart.authorizationStatus, 'connected');
    assert.deepEqual(new Set(afterRestart.capabilities), new Set(capabilities));
    assert.equal(afterRestart.messages.length, 2);
    assert.equal(afterRestart.tokenUsage.measurements.length, 3,
      'only accepted usage reports should persist through the owner capability changes and restart');

    const revoked = await ownerCall('/api/agent-links/' + connectionId, 'DELETE', { approved: true });
    assert.equal(revoked.status, 200, 'permanent owner revoke should succeed');
    assert.equal(revoked.body.connection.authorizationStatus, 'revoked');
    assert.equal((await sendSigned(signedSpec(token, '/agent-link/v1/capabilities'))).status, 410,
      'the old signed token must be permanently refused after revoke');
  } finally {
    if (companion) await companion.close().catch(() => {});
    await stopOwnedServer();
    await removeGeneratedTree(generatedRoot, generatedRoot);
  }
});
