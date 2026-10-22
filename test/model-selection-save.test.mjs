import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const views = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return app.slice(from, to);
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(request) {
  const notices = [], renders = [];
  const state = { data: { settings: { model: 'old' }, bridge: { model: 'old' }, agents: [{ id: 'agent-a', name: 'A', model: 'old' }] } };
  const context = vm.createContext({ state, api: request, modelInfo: id => ({ label: id }), notify: (text, error) => notices.push({ text, error }),
    renderModels() { renders.push(context.pending()); }, renderAll() {}, console });
  vm.runInContext(`let modelSelectionPending = null;
    ${section('async function chooseModel(', 'async function refreshModels(')}
    ${section('async function assignAgentModel(', 'async function askAssistant(')}
    this.pending = () => modelSelectionPending;`, context);
  return { context, state, notices, renders };
}

test('model writes serialize across default and agent selectors until the saved response arrives', async () => {
  const pending = deferred(), calls = [];
  const f = fixture((path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return path === '/api/settings' ? pending.promise : Promise.resolve({ agent: { id: 'agent-a', name: 'A', model: 'agent-new' } }); });
  const save = f.context.chooseModel('new');
  assert.equal(f.context.pending().model, 'new');
  await f.context.assignAgentModel('agent-a', 'competing');
  await f.context.chooseModel('competing');
  assert.equal(calls.length, 1);
  assert.equal(f.state.data.settings.model, 'old');
  pending.resolve({ settings: { model: 'new' } }); await save;
  assert.equal(f.state.data.settings.model, 'new');
  assert.equal(f.context.pending(), null);
  assert.equal(f.notices.length, 1); assert.ok(!f.notices[0].error);
  await f.context.assignAgentModel('agent-a', 'agent-new');
  assert.equal(calls.length, 2);
  assert.equal(f.state.data.agents[0].model, 'agent-new');
  assert.equal(f.context.pending(), null);
});

test('rejected saves and silently ignored server choices never claim success or retain an unsaved selection', async () => {
  for (const agent of [false, true]) {
    const f = fixture(async () => { throw Error('Synthetic host unavailable'); });
    await (agent ? f.context.assignAgentModel('agent-a', 'new') : f.context.chooseModel('new'));
    assert.equal(f.state.data.settings.model, 'old');
    assert.equal(f.state.data.agents[0].model, 'old');
    assert.equal(f.context.pending(), null);
    assert.ok(f.notices[0].error); assert.match(f.notices[0].text, /unavailable/);
    const ignored = fixture(async () => agent ? { agent: { id: 'agent-a', name: 'A', model: 'old' } } : { settings: { model: 'old' } });
    await (agent ? ignored.context.assignAgentModel('agent-a', 'removed-model') : ignored.context.chooseModel('removed-model'));
    assert.ok(ignored.notices[0].error); assert.match(ignored.notices[0].text, /not saved/);
    assert.equal(ignored.context.pending(), null);
    assert.equal(ignored.renders.at(-1), null);
  }
});

test('production renderer shows the requested pending value and keeps every model editor locked after rerenders', () => {
  const window = {}; vm.runInNewContext(views, { window, agentListLabel: item => item.name });
  const nodes = new Map(); const $ = selector => { if (!nodes.has(selector)) nodes.set(selector, { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } }); return nodes.get(selector); };
  const state = { data: { settings: { model: 'old', modelPolicy: 'free-only' }, agents: [{ id: 'agent-a', name: 'A', model: 'old' }], agentLinks: [] } };
  const options = { state, $, escapeHtml: String, availableModels: () => [{ id: 'old', free: true }, { id: 'new', free: true }, { id: 'paid', free: false }],
    modelOptions: value => `selected:${value}`, modelAllowedByPreference: model => model.free, avatarMarkup: () => '', selectionPending: { model: 'new' } };
  window.HexiGridViewRenderers.renderModels(options);
  assert.equal($('#defaultModelSelect').innerHTML, 'selected:new');
  assert.equal($('#globalModelSelect').disabled, true);
  assert.equal($('#modelPolicySelect').disabled, true);
  assert.match($('#agentModelList').innerHTML, /disabled aria-busy="true"/);
  assert.match($('#modelCatalog').innerHTML, /data-model="new" disabled/);
  assert.match($('#agentModelList').innerHTML, /selected:old/); // Default preview does not preview an agent override.
  window.HexiGridViewRenderers.renderModels({ ...options, selectionPending: null });
  assert.equal($('#defaultModelSelect').disabled, false);
  assert.equal($('#defaultModelSelect').innerHTML, 'selected:old');
  assert.match($('#modelCatalog').innerHTML, /data-model="paid" disabled/);
  assert.doesNotMatch($('#agentModelList').innerHTML, /disabled/);
});
