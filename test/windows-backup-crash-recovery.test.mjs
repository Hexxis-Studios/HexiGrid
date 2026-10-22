import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decryptBackup, encryptBackup } from '../lib/backup.mjs';
import { writeEncryptedSnapshot } from '../lib/whole-app-backup.mjs';

test('a Windows process killed mid-stage preserves the previous backup and allows retry', {
  skip: process.platform !== 'win32',
  timeout: 20_000
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hexigrid-backup-crash-'));
  const filename = 'hexigrid-backup-crash-recovery.json';
  const target = path.join(directory, filename);
  const envelopePath = path.join(directory, 'synthetic-next-envelope.json');
  const passphrase = 'synthetic crash-recovery passphrase';
  const previous = { agents: [{ id: 'synthetic-before-crash' }], rooms: [], settings: {} };
  const next = { agents: [{ id: 'synthetic-after-retry' }], rooms: [], settings: {} };
  const nextEnvelope = encryptBackup(next, passphrase);
  const childSource = `
    import { promises as fs } from 'node:fs';
    const { writeEncryptedSnapshot } = await import(process.env.HEXIGRID_BACKUP_MODULE);
    const originalOpen = fs.open.bind(fs);
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith('.pending')) {
        handle.writeFile = async value => {
          const prefix = Buffer.from(String(value).slice(0, 32));
          await handle.write(prefix, 0, prefix.length, 0);
          process.stdout.write('PARTIAL_STAGE_READY\\n');
          await new Promise(() => {});
        };
      }
      return handle;
    };
    const envelope = JSON.parse(await fs.readFile(process.env.HEXIGRID_TEST_ENVELOPE, 'utf8'));
    await writeEncryptedSnapshot({ directory: process.env.HEXIGRID_TEST_DIR, envelope, filename: process.env.HEXIGRID_TEST_FILENAME });
  `;
  let child;
  try {
    await writeEncryptedSnapshot({ directory, envelope: encryptBackup(previous, passphrase), filename });
    const priorBytes = await readFile(target);
    await writeFile(envelopePath, JSON.stringify(nextEnvelope));
    child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HEXIGRID_BACKUP_MODULE: pathToFileURL(path.resolve('lib/whole-app-backup.mjs')).href,
        HEXIGRID_TEST_DIR: directory,
        HEXIGRID_TEST_FILENAME: filename,
        HEXIGRID_TEST_ENVELOPE: envelopePath
      }
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The synthetic writer did not reach its partial-stage boundary.')), 12_000);
      child.stdout.on('data', chunk => {
        if (stdout.includes('PARTIAL_STAGE_READY')) { clearTimeout(timer); resolve(); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        if (!stdout.includes('PARTIAL_STAGE_READY')) {
          clearTimeout(timer);
          reject(new Error(`The synthetic writer exited before staging. ${stderr}`));
        }
      });
    });

    assert.equal(child.kill(), true, 'the disposable writer should still be waiting at the partial-stage boundary');
    await once(child, 'exit');
    child = null;

    assert.deepEqual(await readFile(target), priorBytes, 'an interrupted stage must leave the last published backup byte-for-byte intact');
    assert.deepEqual(decryptBackup(JSON.parse(await readFile(target, 'utf8')), passphrase), previous);
    const stagedNames = (await readdir(directory)).filter(name => name.endsWith('.pending'));
    assert.equal(stagedNames.length, 1, 'the abrupt process death leaves only its unpublished staging file');
    const partial = await readFile(path.join(directory, stagedNames[0]));
    assert.ok(partial.length > 0 && partial.length < Buffer.byteLength(JSON.stringify(nextEnvelope)));

    await writeEncryptedSnapshot({ directory, envelope: nextEnvelope, filename });
    assert.deepEqual(decryptBackup(JSON.parse(await readFile(target, 'utf8')), passphrase), next, 'a fresh run must publish a complete decryptable backup');
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.pending')), [], 'retry removes only the now-abandoned staging file');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    const absoluteDirectory = path.resolve(directory);
    assert.equal(path.dirname(absoluteDirectory), path.resolve(os.tmpdir()), 'cleanup must stay inside the exact synthetic temp root');
    await rm(absoluteDirectory, { recursive: true, force: true });
  }
});
