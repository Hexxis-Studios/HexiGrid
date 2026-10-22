import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { activateLocalRelease, registerLocalRelease, resolveLocalRelease, rollbackLocalRelease } from '../lib/local-releases.mjs';
import { parseLocalReleaseArguments } from '../scripts/manage-local-releases.mjs';

async function writeJson(target, value) {
  await fs.writeFile(target, `${JSON.stringify(value)}\n`);
}

async function makeRelease(target, { version = '1.0.0' } = {}) {
  await fs.mkdir(path.join(target, 'lib'), { recursive: true });
  await fs.mkdir(path.join(target, 'public'), { recursive: true });
  await fs.mkdir(path.join(target, 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(target, 'data'), { recursive: true });
  await writeJson(path.join(target, 'package.json'), { name: 'hexigrid', version, engines: { node: '>=22' } });
  await writeJson(path.join(target, 'package-lock.json'), { name: 'hexigrid', version, lockfileVersion: 3, packages: {} });
  await fs.writeFile(path.join(target, 'server.mjs'), 'export {};\n');
  await fs.writeFile(path.join(target, 'Start-Control-Room.ps1'), 'Write-Output "HexiGrid"\n');
  await fs.writeFile(path.join(target, 'lib', 'runtime.mjs'), 'export const release = true;\n');
  await fs.writeFile(path.join(target, 'public', 'app.js'), 'globalThis.hexigrid = true;\n');
  await fs.writeFile(path.join(target, 'data', '.gitkeep'), '');
}

async function makeWorld(t, ids = ['a', 'b']) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-local-releases-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'manager');
  const releases = path.join(root, 'releases');
  await fs.mkdir(releases, { recursive: true });
  await writeJson(path.join(root, 'package.json'), { name: 'hexigrid', version: '1.0.0' });
  await fs.writeFile(path.join(root, 'server.mjs'), 'export {};\n');
  await fs.writeFile(path.join(root, 'Start-Control-Room.ps1'), 'Write-Output "HexiGrid"\n');
  const folders = {};
  for (const id of ids) {
    folders[id] = path.join(releases, id);
    await makeRelease(folders[id], { version: id === 'b' ? '2.0.0' : '1.0.0' });
  }
  return { base, root, releases, folders };
}

async function selectionBytes(root) {
  return fs.readFile(path.join(root, 'release-selection.json'));
}

test('register, activate, resolve in a fresh reader, then roll back between prepared releases', async (t) => {
  const world = await makeWorld(t);
  const a = await registerLocalRelease({ root: world.root, id: 'a', source: world.folders.a });
  const b = await registerLocalRelease({ root: world.root, id: 'b', source: world.folders.b });
  const metadataPath = path.join(world.root, 'release-selection.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.unrelated = { sentinel: 'preserved' };
  await writeJson(metadataPath, metadata);
  assert.match(a.digest, /^[a-f0-9]{64}$/);
  assert.match(b.digest, /^[a-f0-9]{64}$/);
  await activateLocalRelease({ root: world.root, id: 'a', confirm: true });
  assert.deepEqual(JSON.parse(await fs.readFile(metadataPath, 'utf8')).unrelated, { sentinel: 'preserved' });
  assert.deepEqual(await resolveLocalRelease({ root: world.root }), { root: world.folders.a, ...a });
  const switched = await activateLocalRelease({ root: world.root, id: 'b', confirm: true });
  assert.equal(switched.appliesOn, 'next-startup');
  assert.deepEqual(await resolveLocalRelease({ root: world.root }), { root: world.folders.b, ...b });
  assert.deepEqual(await rollbackLocalRelease({ root: world.root, confirm: true }), { ...a, appliesOn: 'next-startup' });
  assert.deepEqual(await resolveLocalRelease({ root: world.root }), { root: world.folders.a, ...a });
});

test('registration refuses traversal, outside sources, private data, and missing dependencies without changing metadata', async (t) => {
  const world = await makeWorld(t);
  await registerLocalRelease({ root: world.root, id: 'a', source: world.folders.a });
  const original = await selectionBytes(world.root);
  await assert.rejects(registerLocalRelease({ root: world.root, id: '../escape', source: world.folders.a }), /safe opaque identifier/);
  assert.deepEqual(await selectionBytes(world.root), original);
  await assert.rejects(registerLocalRelease({ root: world.root, id: 'b', source: world.folders.a }), /exactly to its managed release folder/);
  assert.deepEqual(await selectionBytes(world.root), original);
  await fs.writeFile(path.join(world.folders.b, 'data', 'private.json'), '{"private":true}');
  await assert.rejects(registerLocalRelease({ root: world.root, id: 'b', source: world.folders.b }), /private data/);
  assert.deepEqual(await selectionBytes(world.root), original);
  await fs.rm(path.join(world.folders.b, 'data', 'private.json'));
  await fs.rm(path.join(world.folders.b, 'node_modules'), { recursive: true });
  await assert.rejects(registerLocalRelease({ root: world.root, id: 'b', source: world.folders.b }), /required real directory/);
  assert.deepEqual(await selectionBytes(world.root), original);
});

test('a junction or symlink release folder is never registered', async (t) => {
  const world = await makeWorld(t, []);
  const outside = path.join(world.base, 'prepared-outside');
  await makeRelease(outside);
  const link = path.join(world.releases, 'linked');
  try {
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('This platform cannot create a synthetic directory junction.');
    return;
  }
  await assert.rejects(registerLocalRelease({ root: world.root, id: 'linked', source: link }), /real directory/);
  await assert.rejects(fs.stat(path.join(world.root, 'release-selection.json')), { code: 'ENOENT' });
});

test('confirmation, unknown releases, missing previous, and digest drift are no-write refusals', async (t) => {
  const world = await makeWorld(t);
  const a = await registerLocalRelease({ root: world.root, id: 'a', source: world.folders.a });
  await registerLocalRelease({ root: world.root, id: 'b', source: world.folders.b });
  const initial = await selectionBytes(world.root);
  await assert.rejects(activateLocalRelease({ root: world.root, id: 'a' }), /explicit --confirm/);
  await assert.rejects(rollbackLocalRelease({ root: world.root }), /explicit --confirm/);
  await assert.deepEqual(await selectionBytes(world.root), initial);
  await assert.rejects(activateLocalRelease({ root: world.root, id: 'not-registered', confirm: true }), /not registered/);
  await assert.deepEqual(await selectionBytes(world.root), initial);
  await activateLocalRelease({ root: world.root, id: 'a', confirm: true });
  const activeA = await selectionBytes(world.root);
  await assert.rejects(rollbackLocalRelease({ root: world.root, confirm: true }), /No previous release/);
  await assert.deepEqual(await selectionBytes(world.root), activeA);
  await fs.writeFile(path.join(world.folders.b, 'lib', 'runtime.mjs'), 'export const release = false;\n');
  await assert.rejects(activateLocalRelease({ root: world.root, id: 'b', confirm: true }), /source has changed/);
  await assert.deepEqual(await selectionBytes(world.root), activeA);
  await fs.writeFile(path.join(world.folders.a, 'lib', 'runtime.mjs'), 'export const release = false;\n');
  await assert.rejects(resolveLocalRelease({ root: world.root }), /source has changed/);
  assert.match(a.digest, /^[a-f0-9]{64}$/);
});

test('malformed, unknown, and traversal selection ids fail closed without rewriting bytes', async (t) => {
  const world = await makeWorld(t);
  const release = await registerLocalRelease({ root: world.root, id: 'a', source: world.folders.a });
  for (const activeId of ['unknown', '../escape']) {
    const bytes = `${JSON.stringify({ schemaVersion: 1, activeId, previousId: null, releases: [{ id: 'a', version: release.version, digest: release.digest }] })}\n`;
    await fs.writeFile(path.join(world.root, 'release-selection.json'), bytes);
    await assert.rejects(resolveLocalRelease({ root: world.root }));
    assert.equal((await selectionBytes(world.root)).toString(), bytes);
  }
});

test('competing lock and registry cap refuse writes', async (t) => {
  const world = await makeWorld(t);
  const lock = path.join(world.root, 'release-selection.json.lock');
  await fs.writeFile(lock, 'held');
  await assert.rejects(registerLocalRelease({ root: world.root, id: 'a', source: world.folders.a }), /operation is in progress/);
  assert.equal(await fs.readFile(lock, 'utf8'), 'held');
  await fs.rm(lock);
  const releases = Array.from({ length: 100 }, (_, index) => ({ id: `r${index}`, version: '1.0.0', digest: 'a'.repeat(64) }));
  const capped = `${JSON.stringify({ schemaVersion: 1, activeId: null, previousId: null, releases })}\n`;
  await fs.writeFile(path.join(world.root, 'release-selection.json'), capped);
  await assert.rejects(registerLocalRelease({ root: world.root, id: 'a', source: world.folders.a }), /limited to 100/);
  assert.equal((await selectionBytes(world.root)).toString(), capped);
});

test('failed atomic persistence preserves the previous active pointer byte-for-byte', async (t) => {
  const world = await makeWorld(t);
  const a = await registerLocalRelease({ root: world.root, id: 'a', source: world.folders.a });
  await registerLocalRelease({ root: world.root, id: 'b', source: world.folders.b });
  await activateLocalRelease({ root: world.root, id: 'a', confirm: true });
  const before = await selectionBytes(world.root);
  const failingIo = new Proxy(fsPromises, {
    get(target, property) {
      if (property === 'rename') return async () => { throw new Error('synthetic atomic persist failure'); };
      return Reflect.get(target, property, target);
    }
  });
  await assert.rejects(activateLocalRelease({ root: world.root, id: 'b', confirm: true, io: failingIo }), /atomically persist/);
  assert.deepEqual(await selectionBytes(world.root), before);
  assert.deepEqual(await resolveLocalRelease({ root: world.root }), { root: world.folders.a, ...a });
});

test('resolve without an active selection returns the validated manager root', async (t) => {
  const world = await makeWorld(t);
  assert.deepEqual(await resolveLocalRelease({ root: world.root }), { root: world.root, id: null, version: null, digest: null });
});

test('authority revoked after staging cannot publish a release selection', async (t) => {
  const world=await makeWorld(t);
  await registerLocalRelease({root:world.root,id:'a',source:world.folders.a});
  await registerLocalRelease({root:world.root,id:'b',source:world.folders.b});
  await activateLocalRelease({root:world.root,id:'a',confirm:true});
  const before=await selectionBytes(world.root);
  let allowed=true;
  const io=new Proxy(fsPromises,{get(target,key){
    if(key==='open')return async (...args)=>{
      const handle=await target.open(...args);
      return new Proxy(handle,{get(h,k){
        if(k==='sync')return async()=>{await h.sync();allowed=false;};
        const value=Reflect.get(h,k,h);return typeof value==='function'?value.bind(h):value;
      }});
    };
    return Reflect.get(target,key,target);
  }});
  await assert.rejects(activateLocalRelease({root:world.root,id:'b',confirm:true,io,assertAuthorized:()=>{if(!allowed)throw Error('Synthetic authority revoked');}}),/atomically persist/);
  assert.deepEqual(await selectionBytes(world.root),before);
  assert.equal((await resolveLocalRelease({root:world.root})).id,'a');
});

test('CLI argument parser requires explicit confirmation and root', () => {
  assert.throws(() => parseLocalReleaseArguments(['activate', '--root', 'manager', '--id', 'a']), /explicit --confirm/);
  assert.throws(() => parseLocalReleaseArguments(['rollback', '--confirm']), /explicit --root/);
  assert.deepEqual(parseLocalReleaseArguments(['activate', '--root', 'manager', '--id', 'a', '--confirm']), {
    command: 'activate', root: 'manager', id: 'a', confirm: true
  });
});
