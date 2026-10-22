import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { HEXIKEYS_CAPTURE_CATEGORIES } from '../lib/hexikeys-bridge.mjs';

const source = await readFile(new URL('../public/hexikeys-ui.js', import.meta.url), 'utf8');
function fixture({ answers = [], responses = [] } = {}) {
  const status = { textContent: '' }, requests = [], modals = [];
  const buttons = ['open', 'refresh', 'connect', 'disconnect', 'request-capture'].map(action => ({
    dataset: { hexikeysAction: action }, disabled: false, hidden: false, insertAdjacentHTML() {}
  }));
  let click;
  const panel = { innerHTML: '', querySelector(selector) {
    if (selector === '[data-hexikeys-status]') return status;
    return buttons.find(button => selector.includes(`"${button.dataset.hexikeysAction}"`));
  }, querySelectorAll: () => buttons, addEventListener(_, fn) { click = fn; } };
  vm.runInNewContext(source, { document: { cookie: 'hexigrid_csrf=synthetic-csrf', querySelectorAll: () => [panel] },
    window: { hexigridModal: async options => { modals.push(options); return answers.shift(); } },
    fetch: async (url, options) => {
      requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      const response = responses.shift() || { ok: true, body: { opened: true } };
      return { ok: response.ok, json: async () => response.body };
    } });
  const act = action => click({ target: { closest: () => buttons.find(button => button.dataset.hexikeysAction === action) } });
  return { status, requests, modals, buttons, act };
}

test('new vault item sends only bounded metadata, preserves it through one approval and reports opened, not saved', async () => {
  const f = fixture({ answers: [[' Example service ', 'API key', ' API key '], true], responses: [
    { ok: false, body: { error: 'Approve this protected request.', approvalRequired: true } },
    { ok: true, body: { opened: true } }
  ] });
  await f.act('request-capture');
  assert.deepEqual(f.requests.map(r => r.body), [
    { title: 'Example service', category: 'API key', fieldLabel: 'API key' },
    { title: 'Example service', category: 'API key', fieldLabel: 'API key', approved: true }
  ]);
  assert.equal(f.requests[0].url, '/api/addons/hexikeys/request-capture');
  assert.equal(f.requests[0].options.headers['x-hexigrid-csrf'], 'synthetic-csrf');
  assert.deepEqual(Array.from(f.modals[0].fields[1].options), [...HEXIKEYS_CAPTURE_CATEGORIES]);
  assert.equal(f.modals[0].fields[1].value, 'Password');
  assert.equal(f.modals[0].fields.some(field => field.type === 'password'), false);
  assert.match(f.status.textContent, /form opened/);
  assert.match(f.status.textContent, /No value has been saved or shared/);
  assert.equal(f.buttons.some(button => button.disabled), false);
});

test('cancel, invalid metadata and declined approval cannot send or repeat a capture', async () => {
  const cancelled = fixture({ answers: [null] }); await cancelled.act('request-capture');
  assert.equal(cancelled.requests.length, 0); assert.match(cancelled.status.textContent, /Nothing was sent/);
  const invalid = fixture({ answers: [[' ', 'Password', 'Password']] }); await invalid.act('request-capture');
  assert.equal(invalid.requests.length, 0);
  const declined = fixture({ answers: [['Example', 'Password', 'Password'], null], responses: [
    { ok: false, body: { error: 'Approval required.', approvalRequired: true } }
  ] }); await declined.act('request-capture');
  assert.equal(declined.requests.length, 1); assert.match(declined.status.textContent, /Approval required/);
  assert.equal(declined.buttons.some(button => button.disabled), false);
});

test('unavailable vault and unconfirmed form never claim an item was opened or saved', async () => {
  for (const response of [
    { ok: false, body: { error: 'HexiKeys is unavailable. Open and unlock it, then retry.' } },
    { ok: true, body: { opened: false } }
  ]) {
    const f = fixture({ answers: [['Example', 'Password', 'Password']], responses: [response] });
    await f.act('request-capture');
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(f.status.textContent, /form opened|saved successfully/);
    assert.equal(f.buttons.some(button => button.disabled), false);
    await f.act('request-capture');
    assert.equal(f.modals[1].fields[0].value, 'Example');
    assert.equal(f.modals[1].fields[1].value, 'Password');
    assert.equal(f.requests.length, 1, 'cancelling a retry must not send again');
  }
});
