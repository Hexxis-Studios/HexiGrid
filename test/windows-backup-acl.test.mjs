import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decryptBackup, encryptBackup } from '../lib/backup.mjs';
import { writeEncryptedSnapshot } from '../lib/whole-app-backup.mjs';

function readWindowsAcl(filename) {
  const script = `$ErrorActionPreference='Stop'; $target=[Console]::In.ReadToEnd(); $acl=[IO.File]::GetAccessControl($target); $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); rights=$_.FileSystemRights.ToString(); inherited=$_.IsInherited } }); [pscustomobject]@{ ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; currentSid=$identity.Value; protected=$acl.AreAccessRulesProtected; rules=$rules } | ConvertTo-Json -Depth 5 -Compress`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`PowerShell ACL inspection failed with exit code ${code}.${stderr ? ` ${stderr}` : ''}`));
    });
    child.stdin.end(filename);
  });
}

test('published Windows backup is decryptable and its protected ACL grants only the current owner', {
  skip: process.platform !== 'win32'
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-windows-backup-acl-'));
  const filename = path.join(directory, 'hexigrid-backup-acl-check.json');
  const passphrase = 'synthetic ACL test passphrase';
  const payload = { agents: [{ id: 'synthetic-acl-agent' }], settings: {}, rooms: [] };
  try {
    await writeEncryptedSnapshot({ directory, envelope: encryptBackup(payload, passphrase), filename: path.basename(filename) });
    assert.deepEqual(decryptBackup(JSON.parse(await readFile(filename, 'utf8')), passphrase), payload);

    const acl = await readWindowsAcl(filename);
    assert.equal(acl.protected, true, 'the file must not inherit access from its parent folder');
    assert.equal(acl.ownerSid, acl.currentSid, 'the current Windows user must own the backup file');
    const allows = acl.rules.filter((rule) => rule.type === 'Allow');
    assert.ok(allows.length > 0, 'the owner must retain access to the backup');
    assert.ok(allows.every((rule) => rule.sid === acl.currentSid && rule.inherited === false && rule.rights.includes('FullControl')),
      'only the current owner may have an explicit full-control allow rule');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
