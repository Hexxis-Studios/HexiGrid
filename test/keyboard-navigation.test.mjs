import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

function keyboardHarness({ mobile = true } = {}) {
  const listeners = {};
  const classes = new Set();
  const attributes = new Map();
  const makeElement = () => ({ inert: false, focusCalls: 0, focus() { this.focusCalls++; document.activeElement = this; }, setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); } });
  const sidebar = makeElement();
  const toggle = makeElement();
  const close = makeElement();
  sidebar.querySelector = (selector) => selector === '.sidebar-close' ? close : null;
  const scrim = makeElement();
  const body = { classList: { toggle(name, value) { value ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } } };
  const document = {
    body, activeElement: null,
    querySelector(selector) { return ({ '#workspaceNavigation': sidebar, '.mobile-menu': toggle, '.nav-scrim': scrim })[selector]; },
    querySelectorAll() { return [makeElement(), makeElement(), makeElement()]; },
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  const window = { matchMedia: () => ({ matches: mobile }) };
  const setStart = appSource.indexOf('function setMobileNavigation(');
  const setEnd = appSource.indexOf('\nfunction viewFromHash', setStart);
  const keyStart = appSource.indexOf('document.addEventListener("keydown", (event) => {');
  const keyEnd = appSource.indexOf('\n\nasync function initialize()', keyStart);
  assert.ok(setStart >= 0 && setEnd > setStart && keyStart >= 0 && keyEnd > keyStart, 'production keyboard code remains extractable');
  const code = `${appSource.slice(setStart, setEnd)}\n${appSource.slice(keyStart, keyEnd)}`;
  vm.runInNewContext(code, { window, document, closeAgentModal() {}, closeConnectModal() {}, closeGuideTopic() {} });
  return { sidebar, toggle, close, scrim, document, listeners, classes, attributes };
}

test('Escape closes the mobile navigation dialog and returns focus to its trigger', () => {
  const ui = keyboardHarness();
  // Invoke the exact production function from a context that shares the harness DOM.
  const setStart = appSource.indexOf('function setMobileNavigation(');
  const setEnd = appSource.indexOf('\nfunction viewFromHash', setStart);
  vm.runInNewContext(`${appSource.slice(setStart, setEnd)}\nsetMobileNavigation(true)`, { window: { matchMedia: () => ({ matches: true }) }, document: ui.document });
  const event = { key: 'Escape', prevented: false, preventDefault() { this.prevented = true; } };
  ui.listeners.keydown(event);
  assert.equal(event.prevented, true);
  assert.equal(ui.classes.has('nav-open'), false);
  assert.equal(ui.attributes.has('role'), false);
  assert.equal(ui.document.activeElement, ui.toggle);
});

test('closing the navigation dialog restores focus to the menu trigger', () => {
  const ui = keyboardHarness();
  const start = appSource.indexOf('function setMobileNavigation(');
  const end = appSource.indexOf('\nfunction viewFromHash', start);
  vm.runInNewContext(`${appSource.slice(start, end)}\nsetMobileNavigation(true); setMobileNavigation(false)`, { window: { matchMedia: () => ({ matches: true }) }, document: ui.document });
  assert.equal(ui.document.activeElement, ui.toggle);
  assert.equal(ui.toggle.focusCalls, 1);
});

test('mobile navigation is inert when the desktop navigation is active', () => {
  const ui = keyboardHarness({ mobile: false });
  const start = appSource.indexOf('function setMobileNavigation(');
  const end = appSource.indexOf('\nfunction viewFromHash', start);
  vm.runInNewContext(`${appSource.slice(start, end)}\nsetMobileNavigation(true, { restoreFocus: false })`, { window: { matchMedia: () => ({ matches: false }) }, document: ui.document });
  assert.equal(ui.sidebar.inert, false, 'desktop sidebar stays available');
  assert.equal(ui.classes.has('nav-open'), false);
  assert.equal(ui.attributes.has('role'), false);
});
