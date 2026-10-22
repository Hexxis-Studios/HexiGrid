const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { validIdentity } = require('./policy.cjs');

async function identity(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/system/identity`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    const data = await response.json();
    return response.ok && validIdentity(data, port) ? data : null;
  } catch { return null; }
}

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

const canBindPort = port => new Promise(resolve => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

async function verifiedExisting(port, referenceRoot = path.resolve(__dirname, '..')) {
  const data = await identity(port);
  if (!data || process.platform !== 'win32') return null;
  try {
    const script = `Get-CimInstance Win32_Process -Filter "ProcessId = ${data.pid}" | Select-Object Name,CommandLine | ConvertTo-Json -Compress`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 });
    const processInfo = JSON.parse(stdout);
    if (processInfo.Name !== 'node.exe') return null;
    const match = processInfo.CommandLine.match(/(?:^|\s)(?:"([^"]*server\.mjs)"|(\S*server\.mjs))(?=\s|$)/i);
    if (!match) return null;
    const root = path.dirname(match[1] || match[2]);
    const { runtimeSourceDigest } = await import(pathToFileURL(path.join(referenceRoot, 'lib/runtime-source.mjs')).href);
    if (await runtimeSourceDigest(root) !== data.sourceDigest) return null;
    return { ...data, root };
  } catch { return null; }
}

async function startEngine({ root, node, dataDir, port = 4318, reuse = true, onFailure = () => {} }) {
  // Attach only to a verified local engine. Never stop or copy an existing workspace.
  if (reuse) {
    const existing = await verifiedExisting(port, root);
    if (existing) return { origin: `http://127.0.0.1:${port}`, attached: true, stop: async () => {} };
  }
  if (!port || !(await canBindPort(port))) port = await freePort();
  const relayPort = await freePort();
  await fs.mkdir(dataDir, { recursive: true });
  const { runtimeSourceDigest } = await import(pathToFileURL(path.join(root, 'lib/runtime-source.mjs')).href);
  const digest = await runtimeSourceDigest(root);
  let child; let stopping = false; let failures = 0; let restartTimer;
  const env = { ...process.env, HEXIGRID_HOST: '127.0.0.1', HEXIGRID_PORT: String(port),
    HEXIGRID_AGENT_RELAY_PORT: String(relayPort), HEXIGRID_DATA_DIR: dataDir,
    HEXIGRID_AGENT_LINK_WORKSPACE_ROOT: path.join(dataDir, 'workspace'),
    PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH || ''}` };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'HEXIGRID_AGENT_RELAY_PUBLIC_ORIGIN', 'HEXIGRID_RELEASE_MANAGER_ROOT']) delete env[key];
  const launch = async () => {
    child = spawn(node, [path.join(root, 'server.mjs')], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => onFailure('The local engine could not start. Reopen HexiGrid to retry.'));
    child.once('exit', () => {
      if (!stopping && failures++ < 3) restartTimer = setTimeout(() => launch().catch(() => onFailure('The local engine could not restart. Reopen HexiGrid to retry.')), 1500);
      else if (!stopping) onFailure('The local engine stopped repeatedly. Your saved data is preserved. Reopen HexiGrid to retry.');
    });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) break;
      const data = await identity(port);
      if (data?.pid === child.pid && data.sourceDigest === digest) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('HexiGrid could not start its local workspace. The port may be in use; no other application was stopped.');
  };
  try { await launch(); }
  catch (error) { stopping = true; clearTimeout(restartTimer); child?.kill(); throw error; }
  return {
    origin: `http://127.0.0.1:${port}`, attached: false,
    async stop() {
      stopping = true; clearTimeout(restartTimer);
      if (!child || child.exitCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
  };
}

module.exports = { startEngine, identity, verifiedExisting };
