import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatedMemoryStore, validateDatedMemoryChain } from '../lib/dated-memory.mjs';
import { commitMemoryErasure, withMemoryLineageLock } from '../lib/memory-erasure-transaction.mjs';

const lineageId = 'lineage-12345678-1234-1234-1234-123456789abc';
const firstId = 'memory-12345678-1234-1234-1234-123456789abc', secondId = 'memory-22345678-1234-1234-1234-123456789abc';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'memory-erasure-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DatedMemoryStore({ root }), directory = path.join(root, lineageId);
  for (const [id, date, text] of [[firstId, '2026-10-03', 'erase only this fact'], [secondId, '2026-10-04', 'keep this unrelated fact']]) await store.append({ lineageId, id, date, createdAt: `${date}T12:00:00.000Z`, agentId: 'qa', text, originKind: 'owner-entry' });
  return { root, store, directory };
}

const childScript = `
import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename, open } from 'node:fs/promises';
import path from 'node:path';
const { DatedMemoryStore, validateDatedMemoryChain } = await import(process.argv[1]);
const { commitMemoryErasure } = await import(process.argv[2]);
const root = process.argv[3], mode = process.argv[4], lineageId = ${JSON.stringify(lineageId)}, firstId = ${JSON.stringify(firstId)};
const directory = path.join(root, lineageId), store = new DatedMemoryStore({ root });
if (mode === 'prepared') {
  await store.hardDelete({ lineageId, id: firstId, assertAuthorized() {
    const log = JSON.parse(readFileSync(path.join(directory, '2026-10-03.json'), 'utf8'));
    if (!log.entries.length) process.exit(91);
  } });
} else {
  const dates = ['2026-10-03', '2026-10-04'];
  const originals = await Promise.all(dates.map(date => readFile(path.join(directory, date + '.json'), 'utf8').then(JSON.parse)));
  await store.hardDelete({ lineageId, id: firstId });
  const logs = await Promise.all(dates.map(date => readFile(path.join(directory, date + '.json'), 'utf8').then(JSON.parse)));
  for (const log of originals) await writeFile(path.join(directory, log.date + '.json'), JSON.stringify(log));
  await commitMemoryErasure({ directory, lineageId, originals, logs, validateLogs: logs => validateDatedMemoryChain(logs, { lineageId }),
    async writeLog(file, value, guard) {
      const temp = file + '.test-tmp', handle = await open(temp, 'w', 0o600);
      await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); guard?.(); await rename(temp, file);
      if (path.basename(file) === 'committed.json') process.exit(92);
    } });
}
process.exit(99);
`;
async function crash(root, mode) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript, new URL('../lib/dated-memory.mjs', import.meta.url).href, new URL('../lib/memory-erasure-transaction.mjs', import.meta.url).href, root, mode], { stdio: 'ignore', windowsHide: true });
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(Error('Disposable crash fixture timed out')); }, 10000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
}

test('process exit after first rewrite restores all original dates before recall or export', async t => {
  const f = await fixture(t);
  assert.equal(await crash(f.root, 'prepared'), 91);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, '2026-10-03.json'), 'utf8')).entries, []);
  const reopened = new DatedMemoryStore({ root: f.root });
  const files = await reopened.listFiles({ lineageId });
  assert.equal(files.length, 2);
  assert.equal((await reopened.getById({ lineageId, id: firstId })).text, 'erase only this fact');
  assert.equal((await reopened.getById({ lineageId, id: secondId })).text, 'keep this unrelated fact');
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('.erasure-')), false);
});

test('process exit after durable commit keeps erasure and removes recovery copies before recall', async t => {
  const f = await fixture(t); assert.equal(await crash(f.root, 'committed'), 92);
  const reopened = new DatedMemoryStore({ root: f.root });
  assert.equal(await reopened.getById({ lineageId, id: firstId }), null);
  assert.equal((await reopened.getById({ lineageId, id: secondId })).text, 'keep this unrelated fact');
  assert.equal((await readdir(f.directory)).some(name => name.startsWith('.erasure-')), false);
});

test('damaged rollback backup blocks recall without rewriting another canonical date', async t => {
  const f = await fixture(t); assert.equal(await crash(f.root, 'prepared'), 91);
  const other = path.join(f.directory, '2026-10-04.json'), before = await readFile(other);
  await writeFile(path.join(f.directory, '.erasure-transaction', '2026-10-03.json'), '{}');
  const reopened = new DatedMemoryStore({ root: f.root });
  await assert.rejects(reopened.getById({ lineageId, id: secondId }), /backup is damaged/);
  assert.deepEqual(await readFile(other), before);
});

test('another store reader waits for complete erasure instead of observing a mixed chain', async t => {
  const f = await fixture(t);
  const originals = await Promise.all(['2026-10-03', '2026-10-04'].map(date => readFile(path.join(f.directory, `${date}.json`), 'utf8').then(JSON.parse)));
  await f.store.hardDelete({ lineageId, id: firstId });
  const logs = await Promise.all(['2026-10-03', '2026-10-04'].map(date => readFile(path.join(f.directory, `${date}.json`), 'utf8').then(JSON.parse)));
  for (const log of originals) await writeFile(path.join(f.directory, `${log.date}.json`), JSON.stringify(log));
  let release, enter; const hold = new Promise(r => { release = r; }), entered = new Promise(r => { enter = r; });
  const erasure = withMemoryLineageLock(f.directory, () => commitMemoryErasure({ directory: f.directory, lineageId, originals, logs,
    validateLogs: logs => validateDatedMemoryChain(logs, { lineageId }), async writeLog(file, value) {
      await writeFile(file, JSON.stringify(value));
      if (file === path.join(f.directory, '2026-10-03.json')) { enter(); await hold; }
    } }));
  await entered;
  let returned = false;
  const read = new DatedMemoryStore({ root: f.root }).getById({ lineageId, id: firstId }).then(value => { returned = true; return value; });
  await new Promise(r => setImmediate(r)); assert.equal(returned, false);
  release(); await erasure; assert.equal(await read, null);
});
