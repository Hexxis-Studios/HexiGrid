import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('browser code contains no inline style sinks that require unsafe-inline', async () => {
  const files = ['index.html', 'boot-loader.js', 'app.js', 'providers.js', 'harnesses.js', 'control-shell.js', 'task-ui.js', 'plugin-ui.js', 'backup-ui.js', 'auth-ui.js', 'google-backup.js', 'integrations.js', 'hexispace-approve.js'];
  for (const file of files) {
    const source = await readFile(path.join(root, 'public', file), 'utf8');
    assert.doesNotMatch(source, /\sstyle\s*=/i, `${file} contains an inline style attribute`);
    assert.doesNotMatch(source, /\.style(?:\.|\[)|cssText|setAttribute\(\s*['"]style['"]/i, `${file} contains a runtime inline style sink`);
    assert.doesNotMatch(source, /<style[\s>]/i, `${file} contains an inline style element`);
  }
});

test('server-rendered pairing HTML also uses an external stylesheet', async () => {
  const server = await readFile(path.join(root, 'server.mjs'), 'utf8');
  assert.doesNotMatch(server, /<style[\s>]/i);
  assert.doesNotMatch(server, /\sstyle\s*=/i);
  assert.match(server, /href=\"\/pairing\.css\"/);
});

test('dynamic presentation uses bounded classes and image-only color tiles', async () => {
  const [app, styles] = await Promise.all([readFile(path.join(root, 'public', 'app.js'), 'utf8'), readFile(path.join(root, 'public', 'styles.css'), 'utf8')]);
  assert.match(app, /function safeAgentColor/); assert.match(app, /function levelClass/);
  assert.match(styles, /\.level-20/); assert.match(styles, /\.progress-5/); assert.match(styles, /\.onboarding-progress-5/); assert.match(styles, /\.clipboard-fallback/);
});
