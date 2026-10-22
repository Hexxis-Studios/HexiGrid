// Synthetic local plugin QA. No network/file permissions or real owner data.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, rename } from 'node:fs/promises';
import os from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { buildPackageIdentity } from '../lib/plugin-security.mjs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-plugin-visual-'));
const origin = 'http://127.0.0.1:44728';
const app = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true,
  env: { ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: '44728', HEXIGRID_AGENT_RELAY_PORT: '44729', HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1:44729', HEXIGRID_DATA_DIR: dataDir, HEXIGRID_AGENT_LINK_WORKSPACE_ROOT: dataDir, OPENCODE_CLI: 'missing-synthetic-plugin-model' },
  stdio: ['ignore', 'ignore', 'ignore'] });
let cookie = '', stopped = false;
async function stop() {
  if (stopped) return; stopped = true;
  if (app.exitCode === null) { const exit = new Promise(resolve => app.once('exit', resolve)); app.kill(); await exit; }
  if (path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('hexigrid-plugin-visual-')) throw Error('Disposable cleanup path changed.');
  await rm(dataDir, { recursive: true, force: true });
}
process.on('SIGINT', () => stop().then(() => process.exit()));
process.on('SIGTERM', () => stop().then(() => process.exit()));
async function call(route, method, body) {
  const response = await fetch(origin + route, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  if (!response.ok) throw Error(`Synthetic setup failed at ${route}: ${response.status}`);
  return response;
}
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (app.exitCode !== null) throw Error('Synthetic plugin host exited.');
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw Error('Synthetic plugin host unavailable.');
  cookie = (await call('/api/auth/setup', 'POST', { password: 'public-disposable-QA-fixture-only' })).headers.get('set-cookie').split(';')[0];
  await call('/api/settings', 'PATCH', { workMode: 'build', approvalPolicy: 'full' });
  const manifest = { schemaVersion: 2, id: 'visual-calculator', name: 'QA calculator', version: '1.0.0', entry: 'plugin.mjs', secrets: [{ id: 'qa-key', label: 'QA protected key', required: false }], description: 'Synthetic calculator: no file or network access.',
    capabilities: [{ id: 'calculate', label: 'Calculate', risk: 'low',
      inputSchema: { type: 'object', properties: { left: { type: 'number', default: 2 }, right: { type: 'number', default: 2 }, fail: { type: 'boolean', title: 'Fail intentionally', default: true } }, required: ['left', 'right', 'fail'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false },
      permissions: { files: { readRoots: [], writeRoots: [] }, network: [] }, limits: { timeoutMs: 3000, memoryMb: 48, outputBytes: 32768, requestBytes: 32768, brokerRequests: 1, concurrency: 1 } }] };
  await call('/api/plugins/install', 'POST', { manifest, files: [{ path: 'plugin.mjs', content: 'export const capabilities={calculate:async input=>{if(input.fail)throw Error("Synthetic plugin failure; switch Fail intentionally off to retry.");return {answer:input.left+input.right};}};' }], localOwnerApproved: true, approved: true });
  if (process.argv.includes('--removal-failure')) {
    if (process.platform !== 'win32') throw Error('This disposable removal fixture requires Windows.');
    await call('/api/plugins/visual-calculator/secrets', 'PUT', { secrets: { 'qa-key': 'public-synthetic-key' }, approved: true });
    const protectedPath = path.join(dataDir, 'vault', 'plugin-visual-calculator-qa-key.protected');
    await rename(protectedPath, protectedPath + '.qa-original'); await mkdir(protectedPath);
    const failed = await fetch(origin + '/api/plugins/visual-calculator', { method: 'DELETE', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ approved: true }) });
    if (failed.status !== 503 || !(await failed.json()).plugin?.removalPending) throw Error('Expected isolated cleanup recovery state.');
  }
  if (process.argv.includes('--publisher-failure')) {
    if (process.platform !== 'win32') throw Error('This disposable publisher fixture requires Windows.');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = { ...manifest, id: 'publisher-calculator', publisher: { id: 'qa-publisher', name: 'QA Publisher', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), signature: Buffer.from('pending').toString('base64') } };
    const files = [{ path: 'plugin.mjs', content: 'export const capabilities={calculate:async()=>({answer:4})};' }];
    const identity = buildPackageIdentity(raw, files);
    const signed = { ...raw, package: identity.manifest.package, publisher: { ...raw.publisher, signature: sign(null, Buffer.from(identity.digest), privateKey).toString('base64') } };
    await call('/api/plugins/install', 'POST', { manifest: signed, files, trustPublisher: true, approved: true });
    const protectedPath = path.join(dataDir, 'vault', 'plugin-publisher-qa-publisher.protected');
    await rename(protectedPath, protectedPath + '.qa-original'); await mkdir(protectedPath);
    const failed = await fetch(origin + '/api/plugin-publishers/qa-publisher', { method: 'DELETE', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ approved: true }) });
    if (failed.status !== 503 || !(await failed.json()).publisher?.cleanupPending) throw Error('Expected isolated publisher cleanup recovery state.');
  }
  if (process.argv.includes('--credential-unavailable')) {
    if (process.platform !== 'win32') throw Error('This disposable credential fixture requires Windows.');
    await call('/api/plugins/visual-calculator/secrets', 'PUT', { secrets: { 'qa-key': 'public-synthetic-key' }, approved: true });
    const protectedPath = path.join(dataDir, 'vault', 'plugin-visual-calculator-qa-key.protected');
    await rename(protectedPath, protectedPath + '.qa-original'); await mkdir(protectedPath);
    const failed = await fetch(origin + '/api/plugins/visual-calculator/secrets', { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ secrets: { 'qa-key': 'public-synthetic-replacement' }, approved: true }) });
    if (failed.status !== 503 || !(await failed.json()).plugin?.credentialError) throw Error('Expected isolated credential recovery state.');
  }
  await call('/api/settings', 'PATCH', { approvalPolicy: 'ask' });
  const commands = createInterface({ input: process.stdin });
  commands.on('line', async line => { if (line.trim() === 'stop') { commands.close(); await stop(); console.log('Disposable plugin QA stopped and cleaned.'); } });
  console.log('Disposable calculator QA ready at localhost44728; plugin disabled, ask policy, no real Link or model.');
} catch (error) { await stop(); console.error(error.message); process.exitCode = 1; }
