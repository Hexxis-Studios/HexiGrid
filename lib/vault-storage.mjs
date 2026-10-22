import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Input is already OS-protected ciphertext. Publish only a complete synced file.
// The IO override is for deterministic disk-failure tests, not a provider hook.
export async function writeProtectedCredential(target, ciphertext, io = fs) {
  const pending = path.join(path.dirname(target), `${path.basename(target)}.pending-${randomUUID()}`);
  let handle, created = false;
  try {
    handle = await io.open(pending, 'wx', 0o600); created = true;
    await handle.writeFile(ciphertext, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await io.rename(pending, target);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created) await io.rm(pending, { force: true }).catch(() => {});
  }
}
