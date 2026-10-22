import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// Capture once at startup. Reading files after a source edit must not make a
// stale process appear to have loaded the new implementation.
export async function runtimeSourceDigest(root) {
  const files = ['server.mjs', 'package.json', 'package-lock.json'];
  for (const directory of ['lib', 'public']) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isFile() && /\.(?:mjs|js|html|css)$/.test(entry.name)) files.push(`${directory}/${entry.name}`);
    }
  }
  const digest = crypto.createHash('sha256');
  for (const name of files.sort()) {
    digest.update(name).update('\0').update(await readFile(path.join(root, name))).update('\0');
  }
  return digest.digest('hex');
}
