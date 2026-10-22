import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('modal keeps short passphrases open and clears its error after correction', async () => {
  const source = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
  const nodes = new Map();
  const control = { value: '', minLength: 12, error: '', focus() {}, setCustomValidity(value) { this.error = value; }, reportValidity() { return !this.error && Boolean(this.value); } };
  const classes = { add() {}, remove() {}, toggle() {} };
  const querySelector = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { classList: classes, querySelector: () => control, querySelectorAll: () => [control] });
    return nodes.get(selector);
  };
  const ctx = vm.createContext({
    document: { querySelector, body: { classList: classes, children: [], append() {} }, activeElement: null, addEventListener() {}, removeEventListener() {} },
    setBackgroundInert() {}, focusableControls: () => [], escapeHtml: String
  });
  vm.runInContext(source.slice(source.indexOf('function modalRequest('), source.indexOf('return modalRequest;')), ctx);
  let resolved = false;
  const pending = ctx.modalRequest({ title: 'QA', fields: [{ label: 'Passphrase', type: 'password', required: true, minLength: 12, maxLength: 120 }] }).then(value => { resolved = true; return value; });
  assert.equal(control.maxLength, 120);
  assert.match(nodes.get('#confirmModalFields').innerHTML, /minlength="12"/);
  control.value = 'short';
  nodes.get('#confirmModalAccept').onclick();
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(control.error, 'Use at least 12 characters.');
  control.value = 'Disposable QA value';
  nodes.get('#confirmModalAccept').onclick();
  assert.deepEqual(Array.from(await pending), ['Disposable QA value']);
  assert.equal(control.error, '');
});

test('confirmation modal contains focus and restores the page when cancelled', async () => {
  const source = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
  const start = source.lastIndexOf('(() => {', source.indexOf("const escapeHtml = value => String(value ?? '')"));
  const end = source.indexOf('\n})();', start) + 6;
  const classes = () => {
    const values = new Set();
    return { add: value => values.add(value), remove: value => values.delete(value), toggle(value, force) { force ? values.add(value) : values.delete(value); }, contains: value => values.has(value) };
  };
  let document;
  const node = () => ({ classList: classes(), hidden: false, disabled: false, textContent: '', value: '', focus() { document.activeElement = this; }, getClientRects: () => [{}] });
  const root = node(), fieldRoot = node(), title = node(), message = node(), cancel = node(), accept = node();
  root.querySelectorAll = selector => selector.startsWith('button:') ? [cancel, accept] : [];
  fieldRoot.querySelector = () => null;
  fieldRoot.querySelectorAll = () => [];
  accept.classList.toggle = () => {};
  const selectors = {
    '#hexigridModal': root, '#confirmModalTitle': title, '#confirmModalMessage': message,
    '#confirmModalFields': fieldRoot, '#confirmModalAccept': accept, '#confirmModalCancel': cancel
  };
  const background = { inert: false }, alreadyInert = { inert: true }, listeners = new Map();
  const bodyClasses = classes();
  const opener = node();
  document = {
    activeElement: opener,
    body: { children: [background, alreadyInert], classList: bodyClasses, append(element) { this.children.push(element); } },
    createElement: () => root,
    querySelector: selector => selectors[selector],
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type); }
  };
  const context = vm.createContext({ document, window: {} });
  vm.runInContext(source.slice(start, end), context);
  const request = context.window.HexiGridModal.create();
  const pending = request({ title: 'Confirm' });

  assert.equal(document.activeElement, cancel, 'a fieldless dialog moves focus to its first action');
  assert.equal(background.inert, true, 'the page behind the dialog is inert');
  assert.equal(alreadyInert.inert, true, 'an existing inert state is preserved');
  const tab = (shiftKey = false) => {
    const event = { key: 'Tab', shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
    listeners.get('keydown')(event);
    return event;
  };
  assert.equal(tab().prevented, false, 'Tab can move from the first to last action');
  document.activeElement = accept;
  assert.equal(tab().prevented, true);
  assert.equal(document.activeElement, cancel, 'Tab wraps from the last action to the first');
  assert.equal(tab(true).prevented, true);
  assert.equal(document.activeElement, accept, 'Shift+Tab wraps from the first action to the last');

  cancel.onclick();
  assert.equal(await pending, null);
  assert.equal(background.inert, false);
  assert.equal(alreadyInert.inert, true);
  assert.equal(document.activeElement, opener, 'closing returns focus to the control that opened the dialog');
  assert.equal(listeners.has('keydown'), false);
});

test('confirmation modal remains usable above the locked auth gate and restores its scope on close', async () => {
  const source = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
  const start = source.lastIndexOf('(() => {', source.indexOf("const escapeHtml = value => String(value ?? '')"));
  const end = source.indexOf('\n})();', start) + 6;
  const classes = () => {
    const values = new Set();
    return { add: value => values.add(value), remove: value => values.delete(value), toggle(value, force) { force ? values.add(value) : values.delete(value); }, contains: value => values.has(value) };
  };
  let document;
  const node = () => ({ classList: classes(), hidden: false, disabled: false, textContent: '', value: '', focus() { document.activeElement = this; }, getClientRects: () => [{}] });
  const root = node(), fieldRoot = node(), title = node(), message = node(), cancel = node(), accept = node();
  root.querySelectorAll = selector => selector.startsWith('button:') ? [cancel, accept] : [];
  fieldRoot.querySelector = () => null;
  fieldRoot.querySelectorAll = () => [];
  accept.classList.toggle = () => {};
  const authGate = node(), offlineState = node(), calls = [];
  const selectors = {
    '#hexigridModal': root, '#confirmModalTitle': title, '#confirmModalMessage': message,
    '#confirmModalFields': fieldRoot, '#confirmModalAccept': accept, '#confirmModalCancel': cancel
  };
  const opener = node(), listeners = new Map();
  document = {
    activeElement: opener,
    body: { children: [authGate, offlineState], classList: classes(), append(element) { this.children.push(element); } },
    createElement: () => root,
    getElementById: id => id === 'authGate' ? authGate : id === 'offlineState' ? offlineState : null,
    querySelector: selector => selectors[selector],
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type); }
  };
  const context = vm.createContext({
    document,
    window: { HexiGridInertScopes: { set: (...args) => calls.push(args) } }
  });
  vm.runInContext(source.slice(start, end), context);
  const request = context.window.HexiGridModal.create();
  const pending = request({ title: 'Recover this workspace' });

  assert.deepEqual(calls.map(([name, enabled]) => [name, enabled]), [
    ['confirm-modal', true], ['auth', false]
  ]);
  assert.equal(typeof cancel.onclick, 'function', 'the cancel control is interactive while auth is locked');
  cancel.onclick();
  assert.equal(await pending, null);
  assert.deepEqual(calls.slice(-2).map(([name, enabled]) => [name, enabled]), [
    ['confirm-modal', false], ['auth', true]
  ]);
  assert.equal(calls.at(-1)[2][0], authGate, 'the auth gate is exempted when its inert scope is restored');
});
