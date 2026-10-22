import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function fixture({ approve = true, failApproved = false } = {}) {
  const listeners = [], notifications = [], calls = [], dialogs = [];
  let refreshed = 0;
  const plugin = { id: 'synthetic', capabilities: [{ id: 'calculate', label: 'Calculate', risk: 'low', inputSchema: { properties: {} } }] };
  const context = vm.createContext({
    state: { data: { plugins: [plugin] } },
    document: { querySelector: () => ({ addEventListener() {} }), addEventListener(type, listener) { if (type === 'click') listeners.push(listener); } },
    window: { async hexigridModal(options) { dialogs.push(options); return options.title === 'Calculate' ? [] : options.title === 'Approve plugin action?' ? approve : true; } },
    async api(url, options) {
      calls.push({ url, body: JSON.parse(options.body) });
      if (calls.length === 1) throw Object.assign(Error('Owner approval needed.'), { body: { approvalRequired: true } });
      if (failApproved) throw Error('The synthetic capability rejected its input.');
      return { result: { answer: 4 } };
    },
    notify(message, error) { notifications.push({ message, error }); },
    async refresh() { refreshed++; }
  });
  vm.runInContext(await readFile(new URL('../public/plugin-ui.js', import.meta.url), 'utf8'), context);
  const handler = listeners.find(listener => listener.toString().includes('[data-plugin-execute]'));
  await handler({ target: { closest(selector) { return selector === '[data-plugin-execute]' ? { dataset: { pluginExecute: 'synthetic', pluginCapability: 'calculate' } } : null; } } });
  return { calls, notifications, dialogs, refreshed };
}

test('failure after one-action plugin approval is shown and does not escape the click handler', async () => {
  const outcome = await fixture({ failApproved: true });
  assert.equal(outcome.calls.length, 2);
  assert.equal(outcome.calls[1].body.approved, true);
  assert.deepEqual(outcome.notifications, [{ message: 'The synthetic capability rejected its input.', error: true }]);
  assert.equal(outcome.refreshed, 0);
  assert.equal(outcome.dialogs.some(dialog => dialog.title.includes('completed')), false);
});

test('cancelled plugin approval never dispatches the approved request', async () => {
  const outcome = await fixture({ approve: false });
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.refreshed, 0);
});

test('successful approved plugin execution shows the real result and refreshes once', async () => {
  const outcome = await fixture();
  assert.equal(outcome.calls.length, 2);
  assert.equal(outcome.refreshed, 1);
  assert.equal(outcome.dialogs.find(dialog => dialog.title === 'Calculate completed').message, '{\n  "answer": 4\n}');
  assert.equal(outcome.notifications.length, 0);
});

test('plugin form defaults preserve falsy scalars and serialize structured values as editable JSON', async () => {
  const context = vm.createContext({ document: { querySelector: () => ({ addEventListener() {} }), addEventListener() {} } });
  vm.runInContext(await readFile(new URL('../public/plugin-ui.js', import.meta.url), 'utf8'), context);
  const fields = context.pluginInputFields({ inputSchema: { properties: {
    number: { type: 'number', default: 0 }, toggle: { type: 'boolean', default: false },
    object: { type: 'object', default: { a: 2 } }, array: { type: 'array', default: ['a'] }
  } } });
  assert.equal(fields[0].value, 0);
  assert.equal(fields[1].value, false);
  assert.deepEqual(JSON.parse(fields[2].value), { a: 2 });
  assert.deepEqual(JSON.parse(fields[3].value), ['a']);
});

async function credentialFixture(answer, fail = false) {
  const listeners = [], calls = [], dialogs = [], notices = [];
  let refreshed = 0;
  const context = vm.createContext({
    state: { data: { plugins: [{ id: 'synthetic', secrets: [{ id: 'qa-key', label: 'QA key', required: false }], secretStatus: {} }] } },
    document: { querySelector: () => ({ addEventListener() {} }), addEventListener(type, listener) { if (type === 'click') listeners.push(listener); } },
    window: { async hexigridModal(options) { dialogs.push(options); return answer; } },
    isHostBrowser: () => true,
    async approvedRequest(url, options) { calls.push({ url, body: JSON.parse(options.body) }); if (fail) throw Error('Safe vault failure.'); },
    notify(message) { notices.push(message); },
    async refresh() { refreshed++; }
  });
  vm.runInContext(await readFile(new URL('../public/plugin-ui.js', import.meta.url), 'utf8'), context);
  const handler = listeners.find(listener => listener.toString().includes('const credentials ='));
  await handler({ target: { closest(selector) { return selector === '[data-plugin-secrets]' ? { dataset: { pluginSecrets: 'synthetic' } } : null; } } });
  return { calls, dialogs, notices, refreshed };
}

test('plugin credential dialog cancels or leaves blanks without a write', async () => {
  for (const answer of [null, ['', false]]) {
    const result = await credentialFixture(answer);
    assert.equal(result.calls.length, 0);
    assert.equal(result.dialogs[0].fields[0].type, 'password');
    assert.match(result.dialogs[0].message, /disables/);
  }
});

test('plugin credentials explicitly update or clear and refresh on safe failure', async () => {
  const changed = await credentialFixture(['public-synthetic-key', false]);
  assert.deepEqual(changed.calls[0].body, { secrets: { 'qa-key': 'public-synthetic-key' } });
  const cleared = await credentialFixture(['', true]);
  assert.deepEqual(cleared.calls[0].body, { secrets: { 'qa-key': '' } });
  const failed = await credentialFixture(['public-synthetic-key', false], true);
  assert.equal(failed.refreshed, 1);
  assert.equal(failed.notices[0], 'Safe vault failure.');
});

test('pending plugin removal exposes retry guidance and disables execution controls', async () => {
  const root = { innerHTML: '' };
  const context = vm.createContext({
    document: { querySelector: selector => selector === '#pluginList' ? root : selector === '#pluginPublisherList' ? null : { addEventListener() {} }, addEventListener() {} },
    window: {}, state: {}, isHostBrowser: () => true,
    escapeHtml: value => String(value || '').replaceAll('<', '&lt;'),
    $: () => root
  });
  vm.runInContext(await readFile(new URL('../public/plugin-ui.js', import.meta.url), 'utf8'), context);
  vm.runInContext('state.data={plugins:[{id:"qa",name:"QA",version:"1",trust:"owner-local",package:{digest:"sha256:qa"},capabilities:[],secrets:[],enabled:false,removalPending:true,removalError:"Retry after repairing access."}]};renderPlugins()', context);
  assert.match(root.innerHTML, /Cleanup pending/);
  assert.match(root.innerHTML, /Retry removal/);
  assert.match(root.innerHTML, /data-plugin-toggle="qa"[^>]*disabled/);
  vm.runInContext('state.data.plugins[0].removalPending=false;state.data.plugins[0].credentialError="Repair the OS vault.";renderPlugins()', context);
  assert.match(root.innerHTML, /Credentials unavailable/);
  assert.match(root.innerHTML, /data-plugin-toggle="qa"[^>]*disabled/);
});
