import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import https from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

function secureRequest(url, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { headers, method, rejectUnauthorized: false }, (response) => {
      let responseBody = '';
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: responseBody }));
    });
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('HTTPS test request timed out.')));
    request.end(body);
  });
}

async function waitForSecureServer(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return await secureRequest(url); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('Secure network server did not start.');
}

test('network mode fails closed unless HTTPS credentials are configured', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-network-security-'));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.mjs', '--network'], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      HEXIGRID_PORT: String(port),
      HEXIGRID_DATA_DIR: dataDir,
      HEXIGRID_HOST: '0.0.0.0',
      HEXIGRID_TLS_PFX: '',
      HEXIGRID_TLS_CERT: '',
      HEXIGRID_TLS_KEY: '',
      HEXIGRID_TLS_PASSPHRASE: '',
      OPENCODE_CLI: 'missing-opencode-for-network-test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let timer;
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
      timer = setTimeout(() => { child.kill(); reject(new Error('Network server did not fail closed.')); }, 5000);
      timer.unref?.();
    });
    assert.notEqual(code, 0);
    assert.match(output, /Network access requires HTTPS/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/bootstrap`));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('network mode serves paired desktop and mobile clients only over HTTPS', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-network-tls-'));
  const pfxPath = path.join(dataDir, 'network-test.pfx');
  const passphrase = 'temporary-network-test-passphrase';
  const port = 45000 + Math.floor(Math.random() * 1000);
  const pairCode = 'A1B2C3D4';
  const certificateScript = [
    `$pfxPath = '${pfxPath.replaceAll("'", "''")}'`,
    `$passphrase = '${passphrase}'`,
    '$rsa = [System.Security.Cryptography.RSA]::Create(2048)',
    "$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)",
    '$certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(1))',
    '$bytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $passphrase)',
    '[System.IO.File]::WriteAllBytes($pfxPath, $bytes)',
    '$certificate.Dispose()',
    '$rsa.Dispose()'
  ].join('; ');
  const encodedScript = Buffer.from(certificateScript, 'utf16le').toString('base64');
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], { windowsHide: true });
  const child = spawn(process.execPath, ['server.mjs', '--network'], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      HEXIGRID_PORT: String(port),
      HEXIGRID_DATA_DIR: dataDir,
      HEXIGRID_HOST: '0.0.0.0',
      HEXIGRID_TLS_PFX: pfxPath,
      HEXIGRID_TLS_PASSPHRASE: passphrase,
      HEXIGRID_PAIR_CODE: pairCode,
      OPENCODE_CLI: 'missing-opencode-for-network-test'
    },
    stdio: 'ignore'
  });
  try {
    const desktop = await waitForSecureServer(`https://127.0.0.1:${port}/api/auth/status`);
    assert.equal(desktop.status, 200);
    assert.equal(desktop.headers['strict-transport-security'], 'max-age=31536000');
    assert.match(String(desktop.headers['set-cookie']), /hexigrid_csrf=.*; Secure/);

    const setupPayload = JSON.stringify({ password: 'network-owner-passphrase' });
    const setup = await secureRequest(`https://127.0.0.1:${port}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(setupPayload)) },
      body: setupPayload
    });
    assert.equal(setup.status, 200);

    const lanAddress = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
    if (lanAddress) {
      const unpaired = await secureRequest(`https://${lanAddress}:${port}/`);
      assert.equal(unpaired.status, 401);
      assert.match(unpaired.body, /href="\/pairing\.css"/);
      const pairingStyle = await secureRequest(`https://${lanAddress}:${port}/pairing.css`);
      assert.equal(pairingStyle.status, 200); assert.match(pairingStyle.headers['content-type'], /text\/css/);
      const paired = await secureRequest(`https://${lanAddress}:${port}/?pair=${pairCode}`);
      assert.equal(paired.status, 302);
      const pairingCookies = (Array.isArray(paired.headers['set-cookie']) ? paired.headers['set-cookie'] : [paired.headers['set-cookie']]).filter(Boolean);
      const pairingCookie = pairingCookies.filter((cookie) => /^(hexigrid_lan|hexigrid_session)=/.test(cookie)).map((cookie) => cookie.split(';', 1)[0]).join('; ');
      assert.ok(pairingCookie);
      assert.match(pairingCookies.find((cookie) => cookie.startsWith('hexigrid_lan=')), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200; Secure/);
      assert.ok(pairingCookies.some((cookie) => cookie.startsWith('hexigrid_session=')));
      const mobile = await secureRequest(`https://${lanAddress}:${port}/api/auth/status`, { headers: { cookie: pairingCookie } });
      assert.equal(mobile.status, 200);
      const mobileAuth = JSON.parse(mobile.body);
      assert.equal(mobileAuth.authenticated, true);
      assert.equal(mobileAuth.paired, true);
      assert.equal(mobile.headers['strict-transport-security'], 'max-age=31536000');

      const secretPayload = JSON.stringify({ name: 'Must not persist', baseUrl: 'https://example.test/v1', models: 'model', apiKey: 'mobile-secret-canary' });
      const secretAttempt = await secureRequest(`https://${lanAddress}:${port}/api/providers`, {
        method: 'POST',
        headers: { cookie: pairingCookie, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(secretPayload)) },
        body: secretPayload
      });
      assert.equal(secretAttempt.status, 403);
      assert.doesNotMatch(secretAttempt.body, /mobile-secret-canary/);

      const backupPayload = JSON.stringify({ passphrase: 'mobile-backup-secret' });
      const backupAttempt = await secureRequest(`https://${lanAddress}:${port}/api/backup/export`, {
        method: 'POST',
        headers: { cookie: pairingCookie, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(backupPayload)) },
        body: backupPayload
      });
      assert.equal(backupAttempt.status, 403);
      assert.doesNotMatch(backupAttempt.body, /mobile-backup-secret/);
    }
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
