// Owner-approved local setup, not a new external provider or an account login.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data/tools/liveportrait');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'integrations/liveportrait/source-manifest.json'), 'utf8'));
const options = { cwd: root, windowsHide: true, timeout: 1_000_000, maxBuffer: 500_000 };
const upstream = path.join(dir, 'upstream');
await fs.mkdir(dir, { recursive: true });
try { await fs.access(path.join(upstream, '.git')); }
catch {
  await run('git', ['clone', '--no-checkout', '--depth', '1', manifest.source, upstream], options);
  await run('git', ['fetch', '--depth', '1', 'origin', manifest.commit], { ...options, cwd: upstream });
  await run('git', ['checkout', '--detach', manifest.commit], { ...options, cwd: upstream });
}
const revision = await run('git', ['rev-parse', 'HEAD'], { ...options, cwd: upstream });
if (revision.stdout.trim() !== manifest.commit) throw new Error('The portrait source version does not match the pinned version.');
await run('git', ['diff', '--quiet', 'HEAD', '--', 'src'], { ...options, cwd: upstream });
const python = path.join(dir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
try { await fs.access(python); }
catch {
  let executable = '';
  const candidates = ['python3.12', 'python3', 'python'];
  if (process.platform === 'win32') {
    try { const listing = await run('py', ['-0p'], options); candidates.unshift(...listing.stdout.split(/\r?\n/).map(line => line.match(/([A-Z]:\\.*python.exe)\s*$/i)?.[1]).filter(Boolean)); } catch {}
  }
  for (const candidate of candidates) {
    try { const result = await run(candidate, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], options); if (result.stdout.trim() === '3.12') { executable = candidate; break; } } catch {}
  }
  if (!executable && process.platform === 'win32') {
    await run('py', ['install', '3.12'], options);
    const result = await run('py', ['-3.12', '-c', 'import sys; print(sys.executable)'], options); executable = result.stdout.trim();
  }
  if (!executable) throw new Error('Python 3.12 is required for local portrait preparation.');
  await run(executable, ['-m', 'venv', path.join(dir, 'venv')], options);
}
// Probe the machine, never install GPU drivers or alter global Python packages.
let cuda = false;
try { await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], options); cuda = true; } catch {}
await run(python, ['-m', 'pip', 'install', 'torch==2.8.0', '--index-url', `https://download.pytorch.org/whl/${cuda ? 'cu128' : 'cpu'}`, '--disable-pip-version-check'], options);
await run(python, ['-m', 'pip', 'install', '-r', path.join(root, 'integrations/liveportrait/requirements.txt'), '--disable-pip-version-check'], options);
await run(process.execPath, [path.join(root, 'scripts/download-portrait-models.mjs')], options);
await run(python, ['-c', 'import torch, cv2, onnxruntime, yaml, PIL, scipy'], options);
await fs.writeFile(path.join(dir, 'ready.json'), JSON.stringify({ commit: manifest.commit, modelRevision: manifest.modelRevision, preparedAt: new Date().toISOString() }), { mode: 0o600 });
console.log('Local portrait animation is ready.');
