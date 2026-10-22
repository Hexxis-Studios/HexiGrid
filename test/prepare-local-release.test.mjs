import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareLocalRelease } from '../scripts/prepare-local-release.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKED_PATHS = ['package.json', 'server.mjs', 'lib/runtime.mjs', 'public/index.html', 'data/.gitkeep'];
const VERSION = '0.0.1';

async function fixture(t, { id = 'release-a', packageFiles, packageName = 'hexigrid', lockName, lockVersion } = {}) {
  const root = await fs.mkdtemp(path.join(PROJECT_ROOT, '.test-prepare-local-release-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const managerRoot = path.join(root, 'manager');
  await fs.mkdir(path.join(sourceRoot, 'data'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'data', '.gitkeep'), '');
  await fs.writeFile(path.join(sourceRoot, 'data', 'private-marker.bin'), Buffer.from([0, 1, 2, 255]));

  const packageJson = {
    name: packageName,
    version: VERSION,
    files: packageFiles ?? ['server.mjs', 'lib/', 'public/', 'data/.gitkeep']
  };
  const lock = {
    name: lockName ?? packageName,
    version: lockVersion ?? VERSION,
    lockfileVersion: 3,
    packages: { '': { name: lockName ?? packageName, version: lockVersion ?? VERSION } }
  };
  const packageBytes = Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`);
  const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  await fs.writeFile(path.join(sourceRoot, 'package.json'), packageBytes);
  await fs.writeFile(path.join(sourceRoot, 'package-lock.json'), lockBytes);
  await fs.mkdir(managerRoot, { recursive: true });
  return { root, sourceRoot, managerRoot, packageJson, packageBytes, lockBytes, id };
}

function mockTools({ fixtureData, manifestPaths = PACKED_PATHS, packFailure, tarFailure, ciFailure } = {}) {
  const calls = [];
  const runTool = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    assert.equal(options.shell, false);
    assert.notEqual(options.env.npm_config_userconfig, options.env.npm_config_globalconfig);
    assert.equal(await fs.readFile(options.env.npm_config_userconfig, 'utf8'), '');
    assert.equal(await fs.readFile(options.env.npm_config_globalconfig, 'utf8'), '');
    if (command === process.execPath && args[1] === 'pack') {
      if (packFailure) throw new Error('private tool output is suppressed');
      const destination = args[args.indexOf('--pack-destination') + 1];
      const filename = `hexigrid-${VERSION}.tgz`;
      await fs.writeFile(path.join(destination, filename), 'mock archive');
      const files = manifestPaths.map((filePath) => ({ path: filePath, size: 1, mode: 0o100644 }));
      return { stdout: JSON.stringify([{ name: 'hexigrid', version: VERSION, filename, files }]) };
    }
    if (command === 'tar') {
      if (tarFailure) throw new Error('private tar output is suppressed');
      const payload = args[args.indexOf('--directory') + 1];
      for (const filePath of manifestPaths) {
        const destination = path.join(payload, ...filePath.split('/'));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const content = filePath === 'package.json'
          ? fixtureData.packageBytes
          : filePath === 'server.mjs'
            ? 'export default true;\n'
            : filePath === 'data/.gitkeep'
              ? ''
              : `fixture ${filePath}\n`;
        await fs.writeFile(destination, content);
      }
      return { stdout: '' };
    }
    if (command === process.execPath && args[1] === 'ci') {
      if (ciFailure) throw new Error('private npm output is suppressed');
      const nodeModules = path.join(options.cwd, 'node_modules');
      await fs.mkdir(nodeModules);
      await fs.writeFile(path.join(nodeModules, 'installed.marker'), 'mock dependency');
      return { stdout: '' };
    }
    assert.fail('Unexpected tool invocation');
  };
  return { calls, runTool };
}

async function assertNoPartialRelease(managerRoot, id) {
  const destination = path.join(managerRoot, 'releases', id);
  await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(managerRoot, 'releases')), []);
}

test('creates the exact dependency-free release with an owned pack and tar flow', async (t) => {
  const data = await fixture(t);
  const previousRelease = path.join(data.managerRoot, 'releases', 'older', 'data', 'state.bin');
  await fs.mkdir(path.dirname(previousRelease), { recursive: true });
  const previousBytes = Buffer.from([9, 8, 7, 0, 255]);
  await fs.writeFile(previousRelease, previousBytes);
  const sourceSentinel = await fs.readFile(path.join(data.sourceRoot, 'data', 'private-marker.bin'));
  const { calls, runTool } = mockTools({ fixtureData: data });

  const result = await prepareLocalRelease({ sourceRoot: data.sourceRoot, managerRoot: data.managerRoot, id: data.id, runTool });
  const destination = path.join(data.managerRoot, 'releases', data.id);
  assert.deepEqual(result, {
    id: data.id,
    prepared: false,
    nextAction: 'Prepare a new release id with --install-dependencies to include dependencies.'
  });
  assert.equal(await fs.readFile(path.join(destination, 'package.json'), 'utf8'), data.packageBytes.toString('utf8'));
  assert.deepEqual(await fs.readFile(path.join(destination, 'package-lock.json')), data.lockBytes);
  assert.equal(await fs.readFile(path.join(destination, 'server.mjs'), 'utf8'), 'export default true;\n');
  await assert.rejects(fs.lstat(path.join(destination, 'data', 'private-marker.bin')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(data.sourceRoot, 'data', 'private-marker.bin')), sourceSentinel);
  assert.deepEqual(await fs.readFile(previousRelease), previousBytes);
  assert.equal(calls.length, 2);

  const [packCall, tarCall] = calls;
  assert.equal(packCall.command, process.execPath);
  assert.equal(path.basename(packCall.args[0]).toLowerCase(), 'npm-cli.js');
  assert.deepEqual(packCall.args.slice(1, 5), ['pack', '--json', '--ignore-scripts', '--pack-destination']);
  assert.equal(packCall.options.cwd, await fs.realpath(data.sourceRoot));
  assert.equal(packCall.options.shell, false);
  assert.equal(tarCall.command, 'tar');
  assert.deepEqual(tarCall.args.slice(0, 3), ['--extract', '--gzip', '--file']);
  assert.equal(tarCall.args[4], '--strip-components=1');
  assert.equal(tarCall.args[5], '--directory');
  assert.ok(tarCall.args[3].startsWith(path.join(data.managerRoot, 'releases', `.prepare-${data.id}-`)));
  assert.ok(tarCall.args[6].startsWith(path.join(data.managerRoot, 'releases', `.prepare-${data.id}-`)));
  assert.deepEqual(await fs.readdir(path.join(data.managerRoot, 'releases')), ['older', data.id]);
});

test('rejects malformed and private packed paths before extraction or installation', async (t) => {
  for (const badPath of ['../escape.txt', 'data/vault/record.json', '.env.local', '.npmrc', '.git/config', 'node_modules/pkg/index.js']) {
    const data = await fixture(t, { id: `bad-${badPath.length}` });
    const { calls, runTool } = mockTools({ fixtureData: data, manifestPaths: [...PACKED_PATHS, badPath] });
    await assert.rejects(prepareLocalRelease({ sourceRoot: data.sourceRoot, managerRoot: data.managerRoot, id: data.id, runTool }), /Local release preparation failed/);
    assert.equal(calls.some((call) => call.command === 'tar'), false, badPath);
    assert.equal(calls.some((call) => call.args[1] === 'ci'), false, badPath);
    await assertNoPartialRelease(data.managerRoot, data.id);
  }

  const badAllowlist = await fixture(t, { id: 'bad-allowlist', packageFiles: ['server.mjs', 'lib/', 'public/', 'data/vault/'] });
  const { calls, runTool } = mockTools({ fixtureData: badAllowlist });
  await assert.rejects(prepareLocalRelease({ sourceRoot: badAllowlist.sourceRoot, managerRoot: badAllowlist.managerRoot, id: badAllowlist.id, runTool }), /Local release preparation failed/);
  assert.equal(calls.length, 0);
});

test('cleans only the generated staging directory after extraction or install failure', async (t) => {
  for (const failure of ['tarFailure', 'ciFailure']) {
    const data = await fixture(t, { id: `failure-${failure}` });
    const { calls, runTool } = mockTools({ fixtureData: data, [failure]: true });
    await assert.rejects(
      prepareLocalRelease({ sourceRoot: data.sourceRoot, managerRoot: data.managerRoot, id: data.id, installDependencies: failure === 'ciFailure', runTool }),
      /Local release preparation failed/
    );
    if (failure === 'ciFailure') assert.ok(calls.some((call) => call.args[1] === 'ci'));
    await assertNoPartialRelease(data.managerRoot, data.id);
  }
});

test('refuses an existing release without changing it or invoking tools', async (t) => {
  const data = await fixture(t);
  const destination = path.join(data.managerRoot, 'releases', data.id);
  await fs.mkdir(destination, { recursive: true });
  const sentinel = path.join(destination, 'keep.bin');
  const bytes = Buffer.from([4, 3, 2, 1]);
  await fs.writeFile(sentinel, bytes);
  const { calls, runTool } = mockTools({ fixtureData: data });
  await assert.rejects(prepareLocalRelease({ sourceRoot: data.sourceRoot, managerRoot: data.managerRoot, id: data.id, runTool }), /Local release preparation failed/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await fs.readFile(sentinel), bytes);
});

test('refuses an existing release junction without touching its target', async (t) => {
  const data = await fixture(t, { id: 'linked-release' });
  const releases = path.join(data.managerRoot, 'releases');
  const destination = path.join(releases, data.id);
  const target = path.join(data.root, 'existing-target');
  await fs.mkdir(releases, { recursive: true });
  await fs.mkdir(target);
  const sentinel = path.join(target, 'keep.bin');
  const bytes = Buffer.from([6, 5, 4, 3]);
  await fs.writeFile(sentinel, bytes);
  await fs.symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
  const { calls, runTool } = mockTools({ fixtureData: data });

  await assert.rejects(prepareLocalRelease({ sourceRoot: data.sourceRoot, managerRoot: data.managerRoot, id: data.id, runTool }), /Local release preparation failed/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await fs.readFile(sentinel), bytes);
});

test('explicit dependency preparation runs only the constrained npm ci and preserves package identity', async (t) => {
  const data = await fixture(t);
  const { calls, runTool } = mockTools({ fixtureData: data });
  const result = await prepareLocalRelease({ sourceRoot: data.sourceRoot, managerRoot: data.managerRoot, id: data.id, installDependencies: true, runTool });
  const destination = path.join(data.managerRoot, 'releases', data.id);
  const ciCall = calls.find((call) => call.args[1] === 'ci');
  assert.equal(result.prepared, true);
  assert.equal(result.id, data.id);
  assert.match(result.nextAction, /not registered or active/);
  assert.ok(ciCall);
  assert.equal(ciCall.command, process.execPath);
  assert.deepEqual(ciCall.args.slice(1), ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(ciCall.options.shell, false);
  assert.ok(ciCall.options.cwd.startsWith(path.join(data.managerRoot, 'releases', `.prepare-${data.id}-`)));
  assert.equal(path.basename(ciCall.options.cwd), 'payload');
  assert.equal(JSON.parse(await fs.readFile(path.join(destination, 'package.json'), 'utf8')).name, 'hexigrid');
  assert.equal(JSON.parse(await fs.readFile(path.join(destination, 'package-lock.json'), 'utf8')).name, 'hexigrid');
  assert.deepEqual(await fs.readFile(path.join(destination, 'package-lock.json')), data.lockBytes);
  assert.equal(await fs.readFile(path.join(destination, 'node_modules', 'installed.marker'), 'utf8'), 'mock dependency');
});

test('rejects package and lock identity mismatches before invoking tools', async (t) => {
  const data = await fixture(t, { id: 'bad-identity', lockName: 'other-package' });
  const { calls, runTool } = mockTools({ fixtureData: data });
  await assert.rejects(prepareLocalRelease({ sourceRoot: data.sourceRoot, managerRoot: data.managerRoot, id: data.id, runTool }), /Local release preparation failed/);
  assert.equal(calls.length, 0);
});

test('same-folder manager preserves private data and refuses a broad release allowlist', async (t) => {
  const data = await fixture(t);
  const sentinel = await fs.readFile(path.join(data.sourceRoot, 'data/private-marker.bin'));
  const {runTool} = mockTools({fixtureData: data});
  await prepareLocalRelease({...data, managerRoot: data.sourceRoot, runTool});
  assert.deepEqual(await fs.readFile(path.join(data.sourceRoot, 'data/private-marker.bin')), sentinel);
  await assert.rejects(fs.stat(path.join(data.sourceRoot, 'releases', data.id, 'data/private-marker.bin')), {code: 'ENOENT'});
  for (const entry of ['releases/', '*', '**/*']) {
    const bad = await fixture(t, {packageFiles: ['server.mjs', 'lib/', 'public/', entry]});
    const tools = mockTools({fixtureData: bad});
    await assert.rejects(prepareLocalRelease({...bad, runTool: tools.runTool}), /Local release preparation failed/);
    assert.equal(tools.calls.length, 0);
  }
});
