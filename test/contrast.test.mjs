import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const palettes = {
  'system dark': { text:'#f7f8fa', muted:'#b1b7c2', dim:'#848d9b', backgrounds:['#111318','#191d24','#20252e'] },
  'system light': { text:'#17202a', muted:'#52606e', dim:'#5f6b77', backgrounds:['#f4f6f8','#ffffff','#f0f3f6'] },
  'prism dark': { text:'#f8f4ff', muted:'#c2bdd0', dim:'#a49bb8', backgrounds:['#101017','#1b1b28','#242433'] },
  'parchment light': { text:'#27231f', muted:'#635847', dim:'#736451', backgrounds:['#f4eee4','#fffdf7','#ece5d8'] }
};

const brandPalettes = {
  'Dark': { stops: ['#d9fbff','#9cb4ff','#8ff2d9'], backgrounds: ['#111318','#191d24'] },
  'Light': { stops: ['#163f7a','#6640a3','#08685c'], backgrounds: ['#f4f6f8','#ffffff'] },
  'Prism': { stops: ['#fff4df','#c9afff','#ffca91'], backgrounds: ['#101017','#1b1b28'] },
  'Parchment': { stops: ['#402764','#8a4315','#164f59'], backgrounds: ['#f4eee4','#fffdf7'] }
};

function luminance(hex) {
  const values = hex.match(/[a-f\d]{2}/gi).map((part) => Number.parseInt(part, 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
}
function ratio(left, right) {
  const a = luminance(left), b = luminance(right);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

test('all theme text levels meet WCAG AA against common surfaces', () => {
  for (const [theme, palette] of Object.entries(palettes)) {
    for (const foreground of [palette.text, palette.muted, palette.dim]) {
      for (const background of palette.backgrounds) assert.ok(ratio(foreground, background) >= 4.5, `${theme}: ${foreground} on ${background}`);
    }
  }
});

test('native select menus and placeholders define readable colors', async () => {
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /select option, select optgroup \{[^}]*background-color: var\(--surface-2\);[^}]*color: var\(--text\)/);
  assert.match(css, /select option:disabled \{ color: var\(--muted\); \}/);
  assert.match(css, /input::placeholder, textarea::placeholder \{ color: var\(--dim\); opacity: 1; \}/);
});

test('every animated HexiGrid wordmark color stays readable in its theme', () => {
  for (const [theme, palette] of Object.entries(brandPalettes)) {
    for (const stop of palette.stops) {
      for (const background of palette.backgrounds) assert.ok(ratio(stop, background) >= 4.5, `${theme}: ${stop} on ${background}`);
    }
  }
});
