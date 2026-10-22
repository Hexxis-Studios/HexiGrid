import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const preferenceSource = readFileSync(new URL('../public/device-preferences.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const helperFile = fileURLToPath(new URL('../public/device-preferences.js', import.meta.url));

function createPreferenceContext(localStorage) {
  const context = { localStorage };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(preferenceSource, context, { filename: helperFile });
  return context;
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `expected source section ${startMarker}`);
  return source.slice(start, end);
}

test('uses working native storage for the fixed appearance keys', () => {
  const values = new Map();
  const context = createPreferenceContext({
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value))
  });

  context.window.HexiGridPreferences.setItem('hexigrid-theme', 'system-light');
  assert.equal(context.window.HexiGridPreferences.getItem('hexigrid-theme'), 'system-light');
  assert.equal(values.get('hexigrid-theme'), 'system-light');
  context.window.HexiGridPreferences.setItem('hexigrid-sidebar-collapsed', 'on');
  assert.equal(createPreferenceContext(context.localStorage).window.HexiGridPreferences.getItem('hexigrid-sidebar-collapsed'), 'on');
  context.window.HexiGridPreferences.setItem('hexigrid-session-token', 'secret');
  assert.equal(context.window.HexiGridPreferences.getItem('hexigrid-session-token'), null);
  assert.equal(values.has('hexigrid-session-token'), false);
});

test('denied storage access falls back in memory only for appearance preferences', () => {
  const context = { window: null };
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('denied'); } });
  context.window = context;
  vm.createContext(context);
  vm.runInContext(preferenceSource, context, { filename: helperFile });

  const preferences = context.window.HexiGridPreferences;
  assert.equal(preferences.getItem('hexigrid-motion'), null);
  assert.doesNotThrow(() => preferences.setItem('hexigrid-motion', 'off'));
  assert.equal(preferences.getItem('hexigrid-motion'), 'off');
  preferences.setItem('hexigrid-credential', 'private');
  assert.equal(preferences.getItem('hexigrid-credential'), null);
});

test('a failed write overrides stale native data for this tab', () => {
  const values = new Map([['hexigrid-theme', 'aurora-dark']]);
  const context = createPreferenceContext({
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: () => { throw new Error('quota'); }
  });
  const preferences = context.window.HexiGridPreferences;

  preferences.setItem('hexigrid-theme', 'system-light');
  assert.equal(values.get('hexigrid-theme'), 'aurora-dark');
  assert.equal(preferences.getItem('hexigrid-theme'), 'system-light');
});

test('the actual app migration copies legacy appearance preferences through the helper', () => {
  const values = new Map([
    ['aveniq-theme', 'system-dark'], ['hexigrid-theme', 'aurora-light'],
    ['aveniq-motion', 'off'], ['aveniq-compact', 'on'], ['aveniq-button-sounds', 'off']
  ]);
  const context = createPreferenceContext({
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value))
  });
  const migration = extractBetween(appSource, 'function migrateLocalPreferences() {', '\n\nasync function prepareDevelopmentSession');
  vm.runInContext(migration, context);
  vm.runInContext('migrateLocalPreferences()', context);

  assert.equal(values.get('hexigrid-theme'), 'aurora-light');
  assert.equal(values.get('hexigrid-motion'), 'off');
  assert.equal(values.get('hexigrid-compact'), 'on');
  assert.equal(values.get('hexigrid-button-sounds'), 'off');
});

test('appearance boot and theme/motion updates work when native storage throws', () => {
  const classes = new Map();
  const cards = ['system-dark', 'system-light', 'aurora-dark', 'aurora-light'].map((choice) => ({
    dataset: { themeChoice: choice },
    pressed: null,
    classList: { toggle(name, enabled) { classes.set(`${choice}:${name}`, enabled); } },
    setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value; }
  }));
  const meta = { content: '', setAttribute(name, value) { if (name === 'content') this.content = value; } };
  const bodyClasses = new Map();
  const context = {
    document: {
      documentElement: { dataset: {} },
      body: { classList: { toggle(name, enabled) { bodyClasses.set(name, enabled); } } },
      querySelector: () => meta
    },
    $$: () => cards,
    getComputedStyle: () => ({ getPropertyValue: () => '#123456' }),
    matchMedia: () => ({ matches: false }),
    navigator: { userAgent: 'desktop' },
    window: null
  };
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('denied'); } });
  context.window = context;
  vm.createContext(context);
  vm.runInContext(preferenceSource, context, { filename: helperFile });

  const migration = extractBetween(appSource, 'function migrateLocalPreferences() {', '\n\nasync function prepareDevelopmentSession');
  const appearance = extractBetween(appSource, 'function applyTheme(theme) {', 'function renderDeviceNotice() {');
  const initStart = appSource.indexOf('async function initialize() {');
  const preferenceStart = appSource.indexOf('  migrateLocalPreferences();', initStart);
  const bootPreferences = appSource.slice(preferenceStart, appSource.indexOf('  setMobileNavigation', preferenceStart));
  assert.ok(preferenceStart > initStart && bootPreferences.includes('applyDevicePreferences();'));
  vm.runInContext(`${migration}\n${appearance}\n${bootPreferences}`, context);

  assert.equal(context.document.documentElement.dataset.theme, 'aurora-dark');
  assert.equal(context.window.HexiGridPreferences.getItem('hexigrid-theme'), 'aurora-dark');
  assert.equal(bodyClasses.get('reduce-motion'), false);
  assert.equal(bodyClasses.get('compact-ui'), false);

  context.window.HexiGridPreferences.setItem('hexigrid-motion', 'off');
  vm.runInContext('applyTheme("system-light"); applyDevicePreferences();', context);
  assert.equal(context.document.documentElement.dataset.theme, 'system-light');
  assert.equal(context.window.HexiGridPreferences.getItem('hexigrid-theme'), 'system-light');
  assert.equal(bodyClasses.get('reduce-motion'), true);
  assert.equal(cards.find((card) => card.dataset.themeChoice === 'system-light').pressed, 'true');
  assert.equal(meta.content, '#123456');
});
