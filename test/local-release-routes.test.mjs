import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleLocalReleaseRequest } from '../lib/local-release-routes.mjs';

async function writeJson(target, value) {
  await fs.writeFile(target, `${JSON.stringify(value)}\n`);
}

async function makeRelease(target, version) {
  await fs.mkdir(path.join(target, 'lib'), { recursive: true });
  await fs.mkdir(path.join(target, 'public'), { recursive: true });
  await fs.mkdir(path.join(target, 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(target, 'data'), { recursive: true });
  await writeJson(path.join(target, 'package.json'), { name: 'hexigrid', version, engines: { node: '>=22' } });
  await writeJson(path.join(target, 'package-lock.json'), { name: 'hexigrid', version, lockfileVersion: 3, packages: {} });
  await fs.writeFile(path.join(target, 'server.mjs'), 'export {};\n');
  await fs.writeFile(path.join(target, 'Start-Control-Room.ps1'), 'Write-Output "HexiGrid"\n');
  await fs.writeFile(path.join(target, 'lib', 'runtime.mjs'), `export const version = '${version}';\n`);
  await fs.writeFile(path.join(target, 'public', 'app.js'), 'globalThis.hexigrid = true;\n');
  await fs.writeFile(path.join(target, 'data', '.gitkeep'), '');
}

async function makeWorld(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-local-release-routes-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'manager');
  const releases = path.join(root, 'releases');
  await fs.mkdir(releases, { recursive: true });
  await writeJson(path.join(root, 'package.json'), { name: 'hexigrid', version: '1.0.0' });
  await fs.writeFile(path.join(root, 'server.mjs'), 'export {};\n');
  await fs.writeFile(path.join(root, 'Start-Control-Room.ps1'), 'Write-Output "HexiGrid"\n');
  await makeRelease(path.join(releases, 'a'), '1.0.0');
  await makeRelease(path.join(releases, 'b'), '2.0.0');
  const sentinel = path.join(base, 'independent-private-sentinel.txt');
  await fs.writeFile(sentinel, 'SYNTHETIC_PRIVATE_SENTINEL_4d16');
  return { base, root, releases, sentinel };
}

function makeRequestContext(world, { pathname, method, body, policyResult = null, io, receipts = [] }) {
  let response;
  const policyCalls = [];
  const ctx = {
    pathname,
    method,
    root: world.root,
    io,
    readBody: async () => body,
    json: (_res, statusCode, payload) => { response = { statusCode, payload }; },
    connectorPolicy: (...args) => { policyCalls.push(args); return policyResult; },
    recordReceipt: (receipt) => receipts.push(receipt)
  };
  return {
    run: async () => {
      const handled = await handleLocalReleaseRequest({}, {}, ctx);
      return { handled, response, policyCalls };
    },
    receipts,
    policyCalls: () => policyCalls
  };
}

test('owner routes report, register, activate, switch, and roll back prepared releases', async (t) => {
  const world = await makeWorld(t);
  const receipts = [];
  const get = makeRequestContext(world, { pathname: '/api/local-releases', method: 'GET', receipts });
  const initial = await get.run();
  assert.equal(initial.handled, true);
  assert.equal(initial.response.statusCode, 200);
  assert.deepEqual(initial.response.payload, { activeId: null, previousId: null, releases: [], appliesOn: 'next-startup' });
  assert.deepEqual(initial.policyCalls, [['read_local', 'medium', true]]);

  const registerA = makeRequestContext(world, { pathname: '/api/local-releases/register', method: 'POST', body: { id: 'a', confirm: true, approved: true }, receipts });
  const a = await registerA.run();
  const registerB = makeRequestContext(world, { pathname: '/api/local-releases/register', method: 'POST', body: { id: 'b', confirm: true, approved: true }, receipts });
  const b = await registerB.run();
  assert.equal(a.response.statusCode, 200);
  assert.match(a.response.payload.result.digest, /^[a-f0-9]{64}$/);
  assert.match(b.response.payload.result.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(a.response.payload), ['result', 'status']);
  assert.equal(a.response.payload.status.appliesOn, 'next-startup');

  const activate = async (id) => makeRequestContext(world, { pathname: '/api/local-releases/activate', method: 'POST', body: { id, confirm: true, approved: true }, receipts }).run();
  const activeA = await activate('a');
  const activeB = await activate('b');
  const rollback = await makeRequestContext(world, { pathname: '/api/local-releases/rollback', method: 'POST', body: { confirm: true, approved: true }, receipts }).run();
  assert.equal(activeA.response.payload.status.activeId, 'a');
  assert.equal(activeB.response.payload.status.activeId, 'b');
  assert.equal(activeB.response.payload.status.previousId, 'a');
  assert.equal(rollback.response.payload.result.id, 'a');
  assert.equal(rollback.response.payload.status.activeId, 'a');
  assert.equal(rollback.response.payload.status.previousId, 'b');
  assert.deepEqual(receipts.map(({ action, id, capability, risk }) => ({ action, id, capability, risk })), [
    { action: 'register', id: 'a', capability: 'self_modify', risk: 'high' },
    { action: 'register', id: 'b', capability: 'self_modify', risk: 'high' },
    { action: 'activate', id: 'a', capability: 'self_modify', risk: 'high' },
    { action: 'activate', id: 'b', capability: 'self_modify', risk: 'high' },
    { action: 'rollback', id: 'a', capability: 'self_modify', risk: 'high' }
  ]);
  for (const receipt of receipts) assert.deepEqual(Object.keys(receipt).sort(), ['action', 'capability', 'id', 'risk']);
  assert.equal((await fs.readFile(world.sentinel, 'utf8')), 'SYNTHETIC_PRIVATE_SENTINEL_4d16');
  assert.equal(JSON.stringify([initial.response.payload, a.response.payload, b.response.payload, activeA.response.payload, activeB.response.payload, rollback.response.payload]).includes(world.root), false);
});

test('Plan denial runs policy before touching release files', async (t) => {
  const world = await makeWorld(t);
  let filesystemAccesses = 0;
  const countingIo = new Proxy(fs, {
    get(target, property) {
      filesystemAccesses += 1;
      return Reflect.get(target, property, target);
    }
  });
  const request = makeRequestContext(world, {
    pathname: '/api/local-releases/register',
    method: 'POST',
    body: { id: 'a', confirm: true, approved: true },
    policyResult: { denied: true, error: 'Plan is read only.' },
    io: countingIo
  });
  const denied = await request.run();
  assert.equal(denied.response.statusCode, 403);
  assert.deepEqual(denied.policyCalls, [['self_modify', 'high', true]]);
  assert.equal(filesystemAccesses, 0);
  await assert.rejects(fs.stat(path.join(world.root, 'release-selection.json')), { code: 'ENOENT' });
  assert.equal((await fs.readFile(world.sentinel, 'utf8')), 'SYNTHETIC_PRIVATE_SENTINEL_4d16');
});

test('bad confirmation, id, approval type, and body keys fail before policy or filesystem access', async (t) => {
  const world = await makeWorld(t);
  let filesystemAccesses = 0;
  const countingIo = new Proxy(fs, {
    get(target, property) {
      filesystemAccesses += 1;
      return Reflect.get(target, property, target);
    }
  });
  const cases = [
    { body: { id: 'a', approved: true } },
    { body: { id: '../a', confirm: true, approved: true } },
    { body: { id: 'a', confirm: true, approved: 'true' } },
    { body: { id: 'a', confirm: true, approved: true, root: world.root } }
  ];
  for (const { body } of cases) {
    const request = makeRequestContext(world, { pathname: '/api/local-releases/register', method: 'POST', body, io: countingIo });
    const result = await request.run();
    assert.equal(result.response.statusCode, 400);
    assert.deepEqual(result.policyCalls, []);
  }
  assert.equal(filesystemAccesses, 0);
  await assert.rejects(fs.stat(path.join(world.root, 'release-selection.json')), { code: 'ENOENT' });
});

test('status fails closed for selected-source drift and malformed selection without exposing paths', async (t) => {
  const world = await makeWorld(t);
  const register = makeRequestContext(world, { pathname: '/api/local-releases/register', method: 'POST', body: { id: 'a', confirm: true, approved: true } });
  await register.run();
  const registerB = makeRequestContext(world, { pathname: '/api/local-releases/register', method: 'POST', body: { id: 'b', confirm: true, approved: true } });
  await registerB.run();
  const activate = makeRequestContext(world, { pathname: '/api/local-releases/activate', method: 'POST', body: { id: 'a', confirm: true, approved: true } });
  await activate.run();
  const activateB = makeRequestContext(world, { pathname: '/api/local-releases/activate', method: 'POST', body: { id: 'b', confirm: true, approved: true } });
  await activateB.run();
  await fs.writeFile(path.join(world.releases, 'a', 'lib', 'runtime.mjs'), 'export const changed = true;\n');

  const drift = await makeRequestContext(world, { pathname: '/api/local-releases', method: 'GET' }).run();
  assert.equal(drift.response.statusCode, 500);
  assert.equal(drift.response.payload.error, 'Registered release source has changed.');
  assert.equal(JSON.stringify(drift.response.payload).includes(world.root), false);

  await fs.writeFile(path.join(world.root, 'release-selection.json'), '{malformed');
  const malformed = await makeRequestContext(world, { pathname: '/api/local-releases', method: 'GET' }).run();
  assert.equal(malformed.response.statusCode, 500);
  assert.equal(JSON.stringify(malformed.response.payload).includes(world.root), false);
  assert.equal(JSON.stringify(malformed.response.payload).includes('SYNTHETIC_PRIVATE_SENTINEL_4d16'), false);
  assert.equal((await fs.readFile(world.sentinel, 'utf8')), 'SYNTHETIC_PRIVATE_SENTINEL_4d16');
});
