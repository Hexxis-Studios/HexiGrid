import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('restored identity loads workspace even when first bootstrap left data empty', async () => {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {} });
    return elements.get(selector);
  };
  let refreshes = 0, calls = 0;
  const context = vm.createContext({
    state: { data: null }, document: { querySelector: element, body: element('body') },
    isStandaloneBrowser: () => false, api: async () => ({ configured: true, googleLinked: true, authenticated: ++calls > 1 }),
    refresh: async () => { refreshes++; }, notify: error => { throw new Error(error); },
    window: { HexiGridGoogle: {}, hexigridGoogleReady: Promise.resolve() }
  });
  vm.runInContext(await readFile(new URL('../public/auth-ui.js', import.meta.url), 'utf8'), context);
  await context.window.hexigridAuthReady;
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
});

test('auth gate owns focus and composes an inert scope until it is dismissed', async () => {
  const elements = new Map();
  const calls = [];
  const bootCalls = [];
  let focused = '';
  let tabHandler;
  const visibleControls = ['#authPassword', '#authSubmit', '#authSwitch', '#authRecover'].map(selector => ({
    selector,
    disabled: false,
    getClientRects: () => [{}],
    focus() { focused = selector; document.activeElement = this; }
  }));
  const element = selector => {
    if (!elements.has(selector)) {
      const classes = new Set();
      const target = {
        classList: {
          add: value => classes.add(value), remove: value => classes.delete(value),
          contains: value => classes.has(value),
          toggle(value, force) { if (force) classes.add(value); else classes.delete(value); }
        },
        attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, value); },
        addEventListener(type, handler) { if (selector === '#authGate' && type === 'keydown') tabHandler = handler; },
        focus() { focused = selector; document.activeElement = this; },
        querySelectorAll() { return selector === '#authGate' ? visibleControls : []; },
        contains(active) { return visibleControls.includes(active); }
      };
      elements.set(selector, target);
    }
    return elements.get(selector);
  };
  const body = element('body');
  const document = { querySelector: element, getElementById: element, body, activeElement: null };
  const context = vm.createContext({
    document,
    isStandaloneBrowser: () => true,
    window: {
      HexiGridInertScopes: { set: (...args) => calls.push(args) },
      hexigridBoot: { dismissForAuth: () => bootCalls.push('dismiss') }
    }
  });
  vm.runInContext(await readFile(new URL('../public/auth-ui.js', import.meta.url), 'utf8').then(source => source.slice(0, source.indexOf('async function initAuth()'))), context);

  context.window.showAuthGate(true);
  assert.equal(focused, '#authPassword');
  assert.equal(element('#authGate').attributes.get('aria-hidden'), 'false');
  assert.deepEqual(calls.at(-1).slice(0, 2), ['auth', true]);
  assert.deepEqual(bootCalls, ['dismiss'], 'the auth gate dismisses the now-inert boot control');
  let prevented = false;
  tabHandler({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'Shift+Tab from the first control wraps inside the dialog');
  assert.equal(focused, '#authRecover');
  tabHandler({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(focused, '#authPassword', 'Tab from the last control wraps to the first');
  context.window.hideAuthGate();
  assert.equal(element('#authGate').classList.contains('hidden'), true);
  assert.equal(element('#authGate').attributes.get('aria-hidden'), 'true');
  assert.deepEqual(calls.at(-1), ['auth', false]);
});
