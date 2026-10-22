// Explicit source-only snapshot of the owner's standalone addon. Never copy vault data.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(process.argv[2] || path.join(root, '..', 'password manager'));
const destination = path.join(root, 'integrations', 'hexikeys');
const files = ['app.py', 'vault_crypto.py', 'vault_store.py', 'vault_references.py', 'vault_pairing.py', 'vault_bridge.py', 'vault_grant_ui.py',
  'requirements.txt', 'requirements-build.txt', 'build.ps1', 'launch.ps1', 'assets/hexikeys.ico',
  'scripts/generate_icon.py', 'tests/test_vault_bridge.py', 'tests/test_vault_pairing.py', 'tests/test_vault_grant_ui.py', 'tests/test_app_bridge.py', 'tests/test_vault_references.py', 'tests/test_secret_field_editor.py', 'tests/test_capture_request.py'];
const snapshots = [];
for (const file of files) {
  const input = path.join(source, file);
  const stat = await fs.lstat(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Unsafe addon source: ${file}`);
  const bytes = await fs.readFile(input);
  snapshots.push({ file, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
}
for (const snapshot of snapshots) {
  const output = path.join(destination, snapshot.file);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, snapshot.bytes);
}
await fs.writeFile(path.join(destination, 'source-manifest.json'), JSON.stringify({ version: 1, files: snapshots.map(({ file, sha256 }) => ({ file, sha256 })) }, null, 2) + '\n');
console.log(`Bundled ${snapshots.length} source files. No vault, descriptor, environment or executable was copied.`);
