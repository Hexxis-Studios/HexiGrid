import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../public/providers.js', import.meta.url), 'utf8');
const apply = source.slice(source.indexOf('function updateProviderSubmitState()'), source.indexOf('\nfunction renderProviders()'));

test('service selection clears a draft key only when the destination changes', () => {
  const fields = new Map();
  const document = { querySelector: id => { if (id === '#providerForm') return { checkValidity: () => true }; if (!fields.has(id)) fields.set(id, { value: '', firstChild: {}, open: false }); return fields.get(id); } };
  const context = { document, providerPresets: { a: { name: 'A', address: 'https://a.example/v1' }, b: { name: 'B', address: 'https://b.example/v1' } }, providerKeyRequired: () => false };
  vm.runInNewContext(apply, context);
  document.querySelector('#providerPreset').value = 'a'; context.applyProviderPreset();
  document.querySelector('#providerKey').value = 'synthetic-key'; context.applyProviderPreset();
  assert.equal(document.querySelector('#providerKey').value, 'synthetic-key');
  document.querySelector('#providerPreset').value = 'b'; context.applyProviderPreset();
  assert.equal(document.querySelector('#providerKey').value, '');
  assert.equal(document.querySelector('#providerAddress').value, 'https://b.example/v1');
});

test('an unselected provider keeps the form inert until the user chooses a service', () => {
  const fields = new Map();
  const document = { querySelector: id => {
    if (id === '#providerForm') return { checkValidity: () => true };
    if (!fields.has(id)) fields.set(id, { value: '', textContent: '', innerHTML: '', disabled: false, open: false, firstChild: { textContent: '2. Paste your API key' } });
    return fields.get(id);
  } };
  document.querySelector('#providerPreset').value = '';
  document.querySelector('#providerKey').value = 'stale synthetic draft';
  document.querySelector('#providerName').value = 'Old service';
  document.querySelector('#providerAddress').value = 'https://old.example/v1';
  document.querySelector('.advanced-settings').open = true;
  const context = { document, providerPresets: { a: { name: 'A', address: 'https://a.example/v1', style: 'openai-chat', key: 'API key', hint: 'Hint', guide: 'guide' } }, providerKeyRequired: () => false };
  vm.runInNewContext(apply, context);
  context.applyProviderPreset();
  assert.equal(document.querySelector('#providerKey').value, '');
  assert.equal(document.querySelector('#providerName').value, '');
  assert.equal(document.querySelector('#providerAddress').value, '');
  assert.equal(document.querySelector('#providerForm button[type="submit"]').disabled, true);
  assert.equal(document.querySelector('#providerHint').textContent, 'Choose a service above. HexiGrid will show its setup steps before connecting.');
  assert.equal(document.querySelector('.advanced-settings').open, false);
});

test('typing a custom destination clears the prior destination draft key', () => {
  const start = source.indexOf("document.querySelector('#providerAddress').addEventListener('input'");
  const end = source.indexOf('\n});', start) + 4;
  const key = { value: 'synthetic-key' }; let listener;
  vm.runInNewContext(source.slice(start, end), { document: { querySelector: id => id === '#providerKey' ? key : { addEventListener: (event, fn) => { assert.equal(event, 'input'); listener = fn; } } }, updateProviderSubmitState() {} });
  listener(); assert.equal(key.value, '');
});

test('pending discovery locks the exact draft, rejects duplicate submits and restores failed input', async () => {
  const fields = new Map(); let listener, rejectRequest, requests = 0;
  const controls = [{ disabled: false }, { disabled: true }];
  const document = { querySelector: id => {
    if (id === '#providerForm') return { addEventListener: (_, fn) => { listener = fn; }, querySelectorAll: () => controls };
    if (!fields.has(id)) fields.set(id, { value: id === '#providerAddress' ? 'http://127.0.0.1:1/v1' : id === '#providerPreset' ? 'synthetic' : 'Synthetic draft', checked: false });
    return fields.get(id);
  }, querySelectorAll: () => controls.slice(0, 1) };
  const start = source.indexOf('let providerFormSaving = false;');
  const end = source.indexOf("\ndocument.addEventListener('click',async(event)=>", start);
  vm.runInNewContext(source.slice(start, end), { document, providerPresets: { synthetic: { name: 'Synthetic', address: 'http://127.0.0.1:1/v1', style: 'openai-chat' } }, providerKeyRequired: () => false,
    isHostBrowser: () => true, isStandaloneBrowser: () => false, refresh: async () => {},
    api: () => { requests++; return new Promise((_, reject) => { rejectRequest = reject; }); } });
  const first = listener({ preventDefault() {} });
  assert.equal(controls[0].disabled, true);
  await listener({ preventDefault() {} }); assert.equal(requests, 1);
  rejectRequest(new Error('Synthetic unavailable local server')); await first;
  assert.equal(controls[0].disabled, false); assert.equal(controls[1].disabled, true);
  assert.equal(document.querySelector('#providerKey').value, 'Synthetic draft');
  assert.match(document.querySelector('#providerFeedback').textContent, /unavailable local server/);
});

test('submitting the blank provider choice explains the required next step without connecting', async () => {
  const fields = new Map(); let listener, requests = 0;
  const controls = [{ disabled: true }, { disabled: false }];
  const document = { querySelector: id => {
    if (id === '#providerForm') return { addEventListener: (_, fn) => { listener = fn; }, querySelectorAll: () => controls };
    if (!fields.has(id)) fields.set(id, { value: id === '#providerPreset' ? '' : '', textContent: '' });
    return fields.get(id);
  }, querySelectorAll: () => controls };
  const start = source.indexOf('let providerFormSaving = false;');
  const end = source.indexOf("\ndocument.addEventListener('click',async(event)=>", start);
  vm.runInNewContext(source.slice(start, end), { document, providerPresets: {}, providerKeyRequired: () => false,
    api: async () => { requests++; }, isHostBrowser: () => true, isStandaloneBrowser: () => false, refresh: async () => {} });
  await listener({ preventDefault() {} });
  assert.equal(document.querySelector('#providerFeedback').textContent, 'Choose a service before connecting.');
  assert.equal(requests, 0);
  assert.equal(controls[0].disabled, true);
  assert.equal(controls[1].disabled, false);
});
