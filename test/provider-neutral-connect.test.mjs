import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('new agent form defaults to a provider-neutral local profile', async () => {
  const elements = new Map();
  const element = () => ({ value: '', textContent: '', innerHTML: '', checked: false, hidden: false, disabled: false, open: false, title: '', dataset: {},
    classList: { add() {}, remove() {}, toggle() {} }, focus() {}, scrollIntoView() {} });
  const $ = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  const source = await readFile(new URL('../public/agent-ui.js', import.meta.url), 'utf8');
  const context = vm.createContext({ $, state: { data: { agentLinks: [], providers: [], settings: { model: 'default' } } },
    document: { addEventListener() {}, body: { classList: { add() {}, remove() {} } } },
    window: { HexiGridViewRenderers: {} }, URL: { revokeObjectURL() {} },
    agent: () => null, agentListLabel: item => item.name, modelOptions: () => '', availableModels: () => [],
    renderAgentPhoto() {},
  });
  vm.runInContext(source, context);
  vm.runInContext('renderAgentPhoto = () => {}', context);
  context.openAgentModal();
  assert.equal($('#transport').value, 'local-opencode');
  assert.equal($('#agentConnectionSummary').textContent, 'Independent local profile');
  assert.equal($('#agentLearnFromConversations').checked, true);
});

test('AI connection choices do not recommend one vendor over local routes', async () => {
  const source = await readFile(new URL('../public/providers.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /OpenCode Zen · recommended|Recommended first cloud option/i);
  assert.match(source, /<select id="providerPreset"><option value="" selected disabled>Choose an API provider<\/option>/);
  assert.match(source, /Choose a local model app/);
  assert.match(source, /Choose an API provider/);
  assert.match(source, /OpenCode Zen is an optional cloud connection/);
  assert.match(source, /For a local route, choose Local model app or This device/);
  assert.match(source, /<strong>Local model app<\/strong>/);
  assert.match(source, /<strong>This device<\/strong>/);
});

test('provider connect stays disabled until required fields and API key are present', async () => {
  const source = await readFile(new URL('../public/providers.js', import.meta.url), 'utf8');
  const start = source.indexOf('function updateProviderSubmitState() {');
  const end = source.indexOf('\nfunction renderProviders()', start);
  assert.ok(start >= 0 && end > start, 'provider form state helpers exist');
  const elements = new Map();
  let formIsValid = true;
  const element = () => ({ value: '', textContent: '', innerHTML: '', disabled: false, open: false, firstChild: { textContent: '' } });
  const form = { checkValidity: () => formIsValid };
  elements.set('#providerForm', form);
  const context = vm.createContext({
    document: { querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); } },
    providerPresets: {
      openai: { name: 'OpenAI', address: 'https://api.openai.com/v1', style: 'openai-responses', key: 'Paste key', hint: 'Choose OpenAI', guide: 'openai' },
      ollama: { name: 'Ollama', address: 'http://127.0.0.1:11434/v1', style: 'openai-chat', key: 'Usually blank', hint: 'Start Ollama', guide: 'ollama' },
      custom: { name: 'Compatible API', address: '', style: 'openai-chat', key: 'If required', hint: 'Set details', guide: 'compatibleApi' }
    },
    providerKeyRequired: address => String(address).includes('api.openai.com')
  });
  vm.runInContext(source.slice(start, end), context);
  const get = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  get('#providerPreset').value = 'openai';
  get('#providerAddress').value = 'https://api.openai.com/v1';
  context.updateProviderSubmitState();
  assert.equal(get('#providerForm button[type="submit"]').disabled, true, 'a key-required provider cannot be submitted with a blank key');
  get('#providerKey').value = 'test-placeholder';
  context.updateProviderSubmitState();
  assert.equal(get('#providerForm button[type="submit"]').disabled, false, 'a valid key enables the connection action');
  get('#providerKey').value = '   ';
  context.updateProviderSubmitState();
  assert.equal(get('#providerForm button[type="submit"]').disabled, true, 'whitespace does not count as a key');

  get('#providerPreset').value = 'ollama';
  get('#providerAddress').value = 'http://127.0.0.1:11434/v1';
  get('#providerKey').value = '';
  context.updateProviderSubmitState();
  assert.equal(get('#providerForm button[type="submit"]').disabled, false, 'a local model app does not require a cloud key');

  get('#providerPreset').value = 'custom';
  formIsValid = false;
  context.updateProviderSubmitState();
  assert.equal(get('#providerForm button[type="submit"]').disabled, true, 'custom providers wait for their required name and address');
});

test('on-device readiness reports WebGPU separately from model memory fit', async () => {
  const source = await readFile(new URL('../public/providers.js', import.meta.url), 'utf8');
  assert.match(source, /WebGPU is available\. \$\{onDeviceCatalog\.models\.length\} model options are listed; actual compatibility and speed depend on your device's GPU memory\./);
  assert.doesNotMatch(source, /models can run in this browser/i);
});

test('Remove download stays disabled until the selected model is cached', async () => {
  const source = await readFile(new URL('../public/providers.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderOnDeviceCatalog() {');
  const end = source.indexOf('\nasync function refreshOnDeviceCache(', start);
  assert.ok(start >= 0 && end > start, 'the on-device catalog renderer exists');
  const elements = new Map();
  const element = () => ({ value: '', className: '', textContent: '', innerHTML: '', disabled: false });
  const context = vm.createContext({
    document: { querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); } },
    onDeviceCatalog: { capabilities: { supported: true }, models: [{ id: 'tiny-model', label: 'Tiny model', vramRequiredMB: 256, lowResource: true }, { id: 'another-model', label: 'Another model', vramRequiredMB: 512, lowResource: true }], selected: 'tiny-model', cache: { modelId: 'tiny-model', status: 'empty' } },
    escapeHtml: value => String(value)
  });
  vm.runInContext(source.slice(start, end), context);
  context.renderOnDeviceCatalog();
  assert.equal(elements.get('[data-on-device-clear]').disabled, true);
  assert.match(elements.get('#onDeviceModelInfo').innerHTML, /No downloaded files yet/);

  context.onDeviceCatalog.cache.status = 'cached';
  context.renderOnDeviceCatalog();
  assert.equal(elements.get('[data-on-device-clear]').disabled, false);
  assert.match(elements.get('#onDeviceModelInfo').innerHTML, /already saved in this browser/);

  context.onDeviceCatalog.selected = 'another-model';
  context.renderOnDeviceCatalog();
  assert.equal(elements.get('[data-on-device-clear]').disabled, true);
});

test('Pair an existing agent opens and focuses the existing invitation form', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-action="open-agent-link-invite"[\s\S]*?<strong>Pair an existing agent<\/strong>/);
  const setup = html.slice(html.indexOf('<section id="view-setup"'), html.indexOf('</section>', html.indexOf('<section id="view-setup"')) + 10);
  assert.match(setup, /Connect your agents, models, and devices[\s\S]*?Pair an existing agent[\s\S]*?iLands is one[\s\S]*?optional provider-specific connection/);
  assert.match(setup, /data-action="open-agent-link-invite">Pair an existing agent<\/button>/);
  assert.doesNotMatch(setup, /connection-card featured/);
  const renderers = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
  assert.match(renderers, /bridge\.runnerInstalled \? "iLands connection ready" : "iLands connection optional"/);
  const integrations = await readFile(new URL('../public/integrations.js', import.meta.url), 'utf8');
  assert.match(integrations, /<form id="desktopInviteForm"/);
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function openAgentLinkInvite() {');
  const end = app.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'the pair action has a dedicated navigation helper');
  const events = [];
  const context = vm.createContext({
    closeConnectModal: () => events.push('close'),
    showView: view => events.push(`view:${view}`),
    setTimeout: (callback, delay) => { assert.equal(delay, 0); callback(); },
    document: { querySelector(selector) { assert.equal(selector, '#desktopInviteForm'); return { scrollIntoView(options) { events.push(`scroll:${options.block}`); } }; } }
  });
  vm.runInContext(app.slice(start, end + 2), context);
  context.openAgentLinkInvite();
  assert.deepEqual(events, ['close', 'view:integrations', 'scroll:start']);
});
