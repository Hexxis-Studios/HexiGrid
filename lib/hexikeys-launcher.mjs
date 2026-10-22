import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function launchBundledHexiKeys(root, { spawnProcess = spawn } = {}) {
  if (process.platform !== 'win32') throw new Error('The bundled HexiKeys desktop addon currently requires Windows.');
  const executable = path.join(path.resolve(root), 'integrations', 'hexikeys', 'dist', 'HexiKeys.exe');
  try {
    const stat = await fs.lstat(executable);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
  } catch { throw new Error('The bundled HexiKeys desktop build is unavailable. Build the included addon before opening it.'); }
  await new Promise((resolve, reject) => {
    // Opening the protected window is an explicit owner/owner-agent action. No
    // secret, item, field or arbitrary command is supplied to the process.
    let child;
    try { child = spawnProcess(executable, [], { cwd: path.dirname(executable), detached: true, windowsHide: false, stdio: 'ignore' }); }
    catch { reject(new Error('HexiKeys could not open its protected window.')); return; }
    child.once('error', () => reject(new Error('HexiKeys could not open its protected window.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { opened: true };
}
