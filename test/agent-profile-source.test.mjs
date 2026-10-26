import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function createAgentMemoryProfileContext({ workMode = 'converse', api } = {}) {
  const source = await readFile(new URL('../public/integrations.js', import.meta.url), 'utf8');
  const start = source.indexOf('let pendingMemoryProposals = [];');
  const end = source.indexOf('\nasync function loadMemoryMetrics', start);
  const wrapperStart = source.indexOf('const openAgentModalBeforeMemories = openAgentModal;');
  const wrapperEnd = source.indexOf("\ndocument.querySelector('#mcpTransport')", wrapperStart);
  assert.ok(start >= 0 && end > start && wrapperStart >= 0 && wrapperEnd > wrapperStart);

  const elements = new Map();
  const document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', replaceChildren() { this.innerHTML = ''; },
      classList: { add() {}, remove() {}, toggle() {} }
    });
    return elements.get(selector);
  } };
  const state = { editingAgentId: null, data: {
    settings: { workMode },
    policyCatalog: { workModes: [
      { id: 'converse', label: 'Converse', capabilities: ['conversation'] },
      { id: 'setup', label: 'Connect', capabilities: ['conversation', 'read_local'] },
      { id: 'build', label: 'Build', capabilities: ['conversation', 'read_local'] }
    ] },
    memories: []
  } };
  const calls = [], notifications = [];
  const context = vm.createContext({ state, document, api: async url => { calls.push(url); return api ? api(url) : {}; },
    notify: (...args) => notifications.push(args), escapeHtml: String, timeAgo: () => '', window: { HexiGridViewRenderers: {} },
    openAgentModal(agentId) { state.editingAgentId = agentId; } });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext(source.slice(wrapperStart, wrapperEnd), context);
  return { context, state, elements, calls, notifications };
}

test('editing a paired profile preserves its Link source, including recovery from an old mislabeled save', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /option value="ilands-link" disabled/);
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, focus() {}, scrollIntoView() { this.scrolled = true; } });
    return elements.get(selector);
  };
  const item = { id: 'paired', name: 'QA', transport: 'ilands-runner', model:'external-only-model' };
  const state = { data: { agents:[item], agentLinks: [{ agentId: item.id, authorizationStatus: 'connected' }], settings: {} } };
  let savedPayload;
  const context = vm.createContext({ $, state, agent: () => item, agentListLabel: x => x.name,
    modelOptions: () => '', availableModels: () => [], api:async (_path,request)=>{savedPayload=JSON.parse(request.body);return {agent:{...item,...savedPayload}};},renderAll(){},notify(){}, document: { addEventListener() {}, body: { classList: { add() {},remove() {} } } } });
  vm.runInContext(await readFile(new URL('../public/agent-ui.js', import.meta.url), 'utf8'), context);
  vm.runInContext('renderAgentPhoto = () => {}', context);
  context.openAgentModal(item.id);
  assert.equal($('#transport').value, 'ilands-link');
  assert.equal($('#transport').disabled, true);
  assert.equal($('#agentConnectionSummary').textContent, 'Paired Agent Link');
  assert.equal($('#agentMemoryDisclosure').open, false);
  assert.equal($('#agentModel').disabled, true);
  assert.equal($('#agentLocalModelField').hidden, true);
  assert.equal($('#agentProviderModelNote').hidden, false);
  assert.equal($('#agentLearnFromConversations').disabled, false);
  assert.equal($('#agentLearnFromConversations').checked, false, 'paired profiles default to no automatic learning');
  assert.equal($('#agentLearningModel').disabled, false);
  $('#agentLearnFromConversations').checked = true;
  $('#agentLearningModel').value = 'local-learning-model';
  await context.saveAgent({preventDefault(){}});
  assert.equal(Object.hasOwn(savedPayload,'model'),false,'saving paired profile must not send a local model override');
  assert.equal(savedPayload.learnFromConversations, true);
  assert.equal(savedPayload.memoryLearningModel, 'local-learning-model');
  assert.equal(Object.hasOwn(savedPayload, 'capabilities'), false);
  assert.equal(Object.hasOwn(savedPayload, 'trustLevel'), false);
  assert.equal(state.data.agents[0].model,'external-only-model');
  context.openAgentModal(item.id, { section: 'memory' });
  assert.equal($('#agentMemoryDisclosure').open, true, 'the memory shortcut opens its section');
  assert.equal($('#agentMemoryDisclosure summary').scrolled, true, 'memory shortcut brings its controls into view');
  state.data.agentLinks[0].authorizationStatus = 'revoked';
  item.transport = 'local-opencode';
  context.openAgentModal(item.id);
  assert.equal($('#transport').value, 'local-opencode');
  assert.equal($('#transport').disabled, false);
  assert.equal($('#agentConnectionSummary').textContent, 'Agent created in HexiGrid');
  assert.equal($('#agentModel').disabled, false);
  assert.equal($('#agentLocalModelField').hidden, false);
  assert.equal($('#agentProviderModelNote').hidden, true);
  assert.equal($('#agentMemoryDisclosure').open, false, 'ordinary edit resets previous disclosure state');
  item.transport = 'agent-link';
  context.openAgentModal(item.id);
  assert.equal($('#transport').value,'ilands-link','neutral Link profiles use the existing paired-source option');
  assert.equal($('#agentModel').disabled,true,'inactive neutral Links still use their original provider');
  $('#transport').value='local-opencode';
  context.updateAgentConnectionSummary();
  assert.equal($('#agentModel').disabled,false,'a permitted source change updates the local model field');
});

test('collapsed appearance does not instantiate a heavy avatar viewer', async () => {
  const elements = new Map(), models = [];
  const $ = selector => { if (!elements.has(selector)) elements.set(selector, { open: false, value: '' }); return elements.get(selector); };
  const context = vm.createContext({ $, state: { avatarDraft: '', avatarModelDraft: { url: '/api/media/qa' } },
    document: { addEventListener() {} },
    colorTile: () => '', escapeHtml: String, initials: () => 'Q',
    window: { HexiGridAvatarViewer: { element: source => { models.push(source); return '<model-viewer></model-viewer>'; } } } });
  vm.runInContext(await readFile(new URL('../public/agent-ui.js', import.meta.url), 'utf8'), context);
  context.renderAgentPhoto('QA');
  assert.equal(models.length, 0);
  $('#agentAppearanceDisclosure').open = true;
  context.renderAgentPhoto('QA');
  assert.equal(models.length, 1);
  assert.match($('#agentModelPreview').innerHTML, /model-viewer/);
  $('#agentAppearanceDisclosure').open = false;
  context.renderAgentPhoto('QA');
  assert.equal(models.length, 1);
  assert.doesNotMatch($('#agentModelPreview').innerHTML, /model-viewer/);
});

test('VRM and GLB uploads select the lazy matching viewer without previewing collapsed profiles', async () => {
  const elements = new Map();
  const $ = selector => { if (!elements.has(selector)) elements.set(selector, { open: false, value: '' }); return elements.get(selector); };
  const viewerCalls = [];
  const context = vm.createContext({ $, state: { avatarDraft: '', avatarModelFile: null, avatarModelDraft: null, avatarModelObjectUrl: '' },
    document: { addEventListener() {} }, URL: { createObjectURL: file => `blob:${file.name}`, revokeObjectURL() {} },
    colorTile: () => '', escapeHtml: String, initials: () => 'Q',
    window: { HexiGridAvatarViewer: { element: (...args) => { viewerCalls.push(args); return args[3] === 'vrm' ? '<hexi-vrm-viewer></hexi-vrm-viewer>' : '<model-viewer></model-viewer>'; } } } });
  vm.runInContext(await readFile(new URL('../public/agent-ui.js', import.meta.url), 'utf8'), context);
  context.chooseAvatarModel({ name: 'QA.vrm', type: '', size: 128 });
  assert.equal(viewerCalls.length, 0);
  $('#agentAppearanceDisclosure').open = true;
  context.renderAgentPhoto('QA');
  assert.equal(viewerCalls[0][3], 'vrm');
  context.chooseAvatarModel({ name: 'QA.glb', type: 'model/gltf-binary', size: 128 });
  context.renderAgentPhoto('QA');
  assert.equal(viewerCalls[1][3], 'glb');
  assert.throws(() => context.chooseAvatarModel({ name: 'not-model.zip', type: '', size: 128 }), /self-contained GLB or VRM/);
});

test('learning model choices exclude remote, keyed, browser and disabled routes', async () => {
  const providers = [
    { id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', local: true, enabled: true },
    { id: 'remote', baseUrl: 'https://example.com/v1', local: false, enabled: true },
    { id: 'keyed', baseUrl: 'http://localhost:8001/v1', local: true, enabled: true, hasKey: true },
    { id: 'disabled', baseUrl: 'http://localhost:8002/v1', local: true, enabled: false },
    { id: 'browser', baseUrl: 'browser://webllm', local: true, enabled: true }
  ];
  const context = vm.createContext({ state: { data: { providers } }, URL, escapeHtml: String,
    availableModels: () => providers.map(provider => ({ id: provider.id, providerId: provider.id, label: provider.id, browser: provider.id === 'browser' })),
    document: { addEventListener() {} } });
  vm.runInContext(await readFile(new URL('../public/agent-ui.js', import.meta.url), 'utf8'), context);
  const options = context.agentLearningModelOptions('local');
  assert.match(options, /value="local" selected/);
  for (const id of ['remote', 'keyed', 'disabled', 'browser']) assert.doesNotMatch(options, new RegExp(`value="${id}"`));
  assert.match(context.agentLearningModelOptions('missing'), /Saved learning model unavailable/);
  assert.match(context.agentLearningModelOptions(), /Use conversation model when local/);
  assert.match(context.agentLearningModelOptions('', true), /Choose a local learning model/);
});

test('profile open skips optional entity reads in Converse and reports that memory is unavailable', async () => {
  const { context, elements, calls, notifications } = await createAgentMemoryProfileContext({
    api: async url => url.includes('/memory-proposals') ? { proposals: [] } : { entities: [] }
  });
  context.openAgentModal('agent-a');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.filter(url => url.includes('/memory-entities')).length, 0);
  assert.equal(calls.filter(url => url.includes('/memory-proposals')).length, 1);
  assert.match(elements.get('#agentMemoryEntities').innerHTML, /unavailable in Converse mode/);
  assert.deepEqual(notifications, []);
});

test('profile entity reads work in a capable mode and ignore a stale prior profile response', async () => {
  let resolveOldEntities;
  const { context, state, elements, calls } = await createAgentMemoryProfileContext({
    workMode: 'setup',
    api: async url => {
      if (url.includes('/memory-proposals')) return { proposals: [] };
      if (url.includes('/agent-a/')) return new Promise(resolve => { resolveOldEntities = resolve; });
      return { entities: [{ id: 'entity-b', label: 'Borealis', entityType: 'project', status: 'confirmed', revision: 1, aliases: [] }] };
    }
  });
  context.openAgentModal('agent-a');
  assert.equal(typeof resolveOldEntities, 'function');
  context.openAgentModal('agent-b');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(url => url.includes('/memory-entities')).length, 2);
  assert.match(elements.get('#agentMemoryEntities').innerHTML, /Borealis/);

  resolveOldEntities({ entities: [{ id: 'entity-a', label: 'Stale name', entityType: 'project', status: 'confirmed', revision: 1, aliases: [] }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.editingAgentId, 'agent-b');
  assert.match(elements.get('#agentMemoryEntities').innerHTML, /Borealis/);
  assert.doesNotMatch(elements.get('#agentMemoryEntities').innerHTML, /Stale name/);
});

test('an entity response cannot appear after the current mode loses local read', async () => {
  let release;
  const { context, state, elements, notifications } = await createAgentMemoryProfileContext({
    workMode: 'setup',
    api: async url => url.includes('/memory-proposals') ? { proposals: [] }
      : new Promise(resolve => { release = resolve; })
  });
  context.openAgentModal('agent-a');
  state.data.settings.workMode = 'converse';
  release({ entities: [{ id: 'late', label: 'Late private name', aliases: [] }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.get('#agentMemoryEntities').innerHTML, /unavailable in Converse mode/);
  assert.doesNotMatch(elements.get('#agentMemoryEntities').innerHTML, /Late private name/);
  assert.deepEqual(notifications, []);
});
