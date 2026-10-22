import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AVATAR_VIEWER_STYLE_HASHES } from '../lib/avatar-viewer-style-hashes.mjs';

test('avatar CSP pins every fixed vendor shadow stylesheet and permits no arbitrary inline style', async () => {
  const template = await readFile(new URL('../node_modules/@google/model-viewer/lib/template.js', import.meta.url), 'utf8');
  const styles = [...template.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1].replace(/\r\n?/g, '\n'));
  assert.ok(styles.length);
  assert.deepEqual(AVATAR_VIEWER_STYLE_HASHES, styles.map(style => `'sha256-${createHash('sha256').update(style).digest('base64')}'`));
  assert.ok(AVATAR_VIEWER_STYLE_HASHES.every(hash => /^'sha256-[A-Za-z0-9+/]{43}='$/.test(hash)));
});
