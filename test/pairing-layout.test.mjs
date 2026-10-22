import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('HexiSpace pairing scopes use compact checkboxes separate from full-width text input', async () => {
  const css = await readFile(fileURLToPath(new URL('../public/pairing.css', import.meta.url)), 'utf8');
  assert.match(css, /input:not\(\[type="checkbox"\]\), button\s*\{[^}]*width:\s*100%/);
  assert.match(css, /fieldset label\s*\{[^}]*grid-template-columns:\s*20px minmax\(0, 1fr\)/);
  assert.match(css, /input\[type="checkbox"\]\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px/);
});
