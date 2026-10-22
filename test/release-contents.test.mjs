import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('actual distribution excludes private development material and includes public guides', async () => {
  // All arguments are fixed; Windows needs cmd to invoke the npm shim.
  const output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 });
  const [packed] = JSON.parse(output);
  const files = packed.files.map(file => file.path);
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const publicDocs = new Set(packageJson.files.filter(file => file.startsWith('docs/')));
  for (const file of files) {
    assert.doesNotMatch(file, /(?:^|\/)(?:AGENTS\.md|WORKER_SUMMARY[^/]*|\.git|\.env(?:\..*)?|node_modules)(?:\/|$)/i);
    assert.doesNotMatch(file, /^scripts\/(?:accept-|benchmark-)/);
    assert.doesNotMatch(file, /^integrations\/call-browser\/native\/(?:bin|obj)\//);
    assert.doesNotMatch(file, /^data\/(?!\.gitkeep$)/);
    if (file.startsWith('docs/')) assert.ok(publicDocs.has(file) || file.startsWith('docs/licenses/'), `Unreviewed document included: ${file}`);
    if (/\.(?:md|js|mjs|html|json|py|ps1)$/i.test(file) && !file.includes('/vendor/')) {
      const text = await readFile(path.join(root, file), 'utf8');
      // Keep existing public legal attribution; reject personal runtime setup.
      assert.equal(/\b(?:ExampleUser|ExampleAgent)\b|deadbeef/i.test(text), false, `Personal setup reference in ${file}`);
      if (!['LICENSE.md', 'COMMERCIAL-LICENSE-TEMPLATE.md'].includes(file)) {
        assert.equal(/\bExampleOwner\b/i.test(text), false, `Personal setup reference in ${file}`);
      }
    }
  }
  for (const required of ['README.md', 'LICENSE.md', 'docs/HOW-TO-GUIDE.md', 'docs/AGENT-INTEGRATION-PROMPT.md', 'docs/ALPHA-RELEASE-NOTES.md', 'docs/licenses/openai-whisper-MIT.txt', 'config/local-embedding-model.json', 'server.mjs', 'lib/agent-link.mjs', 'public/index.html']) {
    assert.ok(files.includes(required), `Missing public/runtime file: ${required}`);
  }
});

test('push preflight refuses private plans retained in earlier commits after current-file removal', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'hexigrid-public-history-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  await fs.mkdir(path.join(fixture, 'scripts'));
  await fs.mkdir(path.join(fixture, 'docs'));
  await fs.copyFile(path.join(root, 'scripts/release-preflight.mjs'), path.join(fixture, 'scripts/release-preflight.mjs'));
  const git = args => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-b', 'main']);
  const commit = message => {
    git(['add', '.']);
    git(['-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid', 'commit', '-m', message]);
  };
  await fs.writeFile(path.join(fixture, 'README.md'), 'Synthetic public application.\n');
  commit('Public source');
  const base = git(['rev-parse', 'HEAD']);
  const script = path.join(fixture, 'scripts/release-preflight.mjs');
  assert.doesNotThrow(() => execFileSync(process.execPath, [script, base], { encoding: 'utf8', stdio: 'pipe' }));
  await fs.writeFile(path.join(fixture, 'docs/WORKSTREAMS.md'), 'Synthetic private planning sentinel.\n');
  commit('Internal development');
  await fs.unlink(path.join(fixture, 'docs/WORKSTREAMS.md'));
  git(['add', '-u']);
  git(['-c', 'user.name=Release test', '-c', 'user.email=release@example.invalid', 'commit', '-m', 'Remove current note']);
  assert.throws(() => execFileSync(process.execPath, [script, 'HEAD', base], { encoding: 'utf8', stdio: 'pipe' }), error => {
    assert.match(String(error.stderr), /outgoing commit history contains internal/);
    assert.equal(String(error.stderr).includes('Synthetic private planning sentinel'), false);
    return error.status === 1;
  });
});
