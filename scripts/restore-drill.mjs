import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { drillEncryptedBackup } from '../lib/restore-drill.mjs';

// Usage: node scripts/restore-drill.mjs /absolute/encrypted-backup.json
// Supply one JSON object on stdin: {"passphrase":"...","checks":{...}}.
// Read docs/HOW-TO-GUIDE.md for a hidden-input PowerShell invocation.
// The passphrase is never accepted as a command-line argument or printed.
async function main() {
  const file = process.argv[2];
  if (process.argv.length !== 3 || !path.isAbsolute(String(file || ''))) throw new Error('usage');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024) throw new Error('backup');
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 64 * 1024) throw new Error('input');
  }
  const { passphrase, checks } = JSON.parse(input);
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('passphrase');
  const result = await drillEncryptedBackup({ envelope, passphrase, checks });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(() => {
  process.stderr.write('Restore drill failed. Check the encrypted backup and supplied verification checks.\n');
  process.exitCode = 1;
});
