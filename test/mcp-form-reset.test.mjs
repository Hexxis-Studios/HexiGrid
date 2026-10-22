import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the production handler rather than a duplicate reset implementation.
async function ownerForm(failure = false, initialTransport = 'http') {
  const source = await readFile(new URL('../public/integrations.js', import.meta.url), 'utf8');
  const fields = new Map();
  for (const id of ['mcpTransport', 'mcpName', 'mcpImage', 'mcpCommand', 'mcpArgs', 'mcpWorkspaceAccess', 'mcpUrl', 'mcpSecretName', 'mcpSecretValue', 'mcpFeedback', 'mcpStdioFields', 'mcpHttpFields']) {
    const classes = new Set();
    fields.set(`#${id}`, { value: '', textContent: '', classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } }, addEventListener() {} });
  }
  const get = (id) => fields.get(`#${id}`);
  get('mcpTransport').value = initialTransport; get('mcpName').value = 'Calculator'; get('mcpUrl').value = 'http://127.0.0.1:3001/mcp';
  let submit, sent, refreshed = 0, resets = 0;
  const form = { addEventListener(_name, handler) { submit = handler; }, reset() { resets++; for (const field of fields.values()) field.value = ''; get('mcpTransport').value = 'stdio'; } };
  const context = vm.createContext({ document: { querySelector: (id) => id === '#mcpForm' ? form : fields.get(id) }, isHostBrowser: () => true, notify() {}, approvedRequest: async (_path, options) => { sent = JSON.parse(options.body); if (failure) throw Error('Connection unavailable'); }, refresh: async () => { refreshed++; } });
  const sync = source.slice(source.indexOf('function syncMcpTransportFields()'), source.indexOf("document.querySelector('#imageProvider').addEventListener"));
  const handler = source.slice(source.indexOf("document.querySelector('#mcpForm').addEventListener('submit'"), source.indexOf("document.querySelector('#imageForm').addEventListener('submit'"));
  assert.ok(sync && handler);
  vm.runInContext(sync + handler, context);
  const initial = { imageRequired: get('mcpImage').required, urlRequired: get('mcpUrl').required, stdioHidden: get('mcpStdioFields').classList.contains('hidden'), httpHidden: get('mcpHttpFields').classList.contains('hidden') };
  await submit({ preventDefault() {}, target: form });
  return { get, sent, refreshed, resets, initial };
}

test('first render requires the stdio image and ignores the hidden HTTP address', async () => {
  const { initial } = await ownerForm(false, 'stdio');
  assert.deepEqual(initial, { imageRequired: true, urlRequired: false, stdioHidden: false, httpHidden: true });
});

test('successful HTTP add restores the stdio default and matching visible fields', async () => {
  const { get, sent, refreshed, resets } = await ownerForm();
  assert.equal(sent.transport, 'http');
  assert.equal(sent.url, 'http://127.0.0.1:3001/mcp');
  assert.equal(resets, 1); assert.equal(refreshed, 1);
  assert.equal(get('mcpTransport').value, 'stdio');
  assert.equal(get('mcpStdioFields').classList.contains('hidden'), false);
  assert.equal(get('mcpHttpFields').classList.contains('hidden'), true);
  assert.equal(get('mcpImage').required, true);
  assert.equal(get('mcpUrl').required, false);
  assert.equal(get('mcpUrl').value, '');
});

test('failed add preserves the HTTP draft and its fields for retry', async () => {
  const { get, resets, refreshed } = await ownerForm(true);
  assert.equal(resets, 0); assert.equal(refreshed, 0);
  assert.equal(get('mcpTransport').value, 'http');
  assert.equal(get('mcpUrl').value, 'http://127.0.0.1:3001/mcp');
  assert.equal(get('mcpStdioFields').classList.contains('hidden'), true);
  assert.equal(get('mcpHttpFields').classList.contains('hidden'), false);
  assert.equal(get('mcpImage').required, false);
  assert.equal(get('mcpUrl').required, true);
  assert.equal(get('mcpFeedback').textContent, 'Connection unavailable');
});
