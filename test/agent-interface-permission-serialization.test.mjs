import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/agent-interface.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `source section starts at ${start}`);
  assert.notEqual(to, -1, `source section ends at ${end}`);
  return source.slice(from, to);
}

const state = section('  let latestManifest = null;', '  function setBusy(');
const permissionRender = section('  function setLinkPermissionEditBusy(', '  function renderActionCatalog(');
const linkSelectionHandler = section("  document.querySelector('#desktopBridgeLink')?.addEventListener('change'", "  document.querySelector('#agentSpeechSettings')");
const bulkHandlers = section('  async function updateDoorScopes(grant)', "  for (const [id, kind] of [['desktopBridgeCamera'");
const permissionHandlers = section("  document.querySelector('#desktopLinkPermissions')?.addEventListener", "  document.querySelector('#desktopBridgeMicrophoneDevice')");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(request) {
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', checked: false, disabled: false, innerHTML: '', textContent: '', hidden: false, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
    return nodes.get(selector);
  };
  const link = { id: 'link-a', status: 'online', trustLevel: 'scoped', capabilities: ['desktop-view', 'camera-view', 'microphone-listen'] };
  const initialState = { agentLinks: [link], settings: { desktopBridge: { linkId: link.id, enabled: false } } };
  node('#desktopBridgeLink').value = link.id;
  const context = vm.createContext({
    document: { querySelector: node },
    window: {
      HexiGridDesktopMedia: { state: () => ({}), active: () => ({}), stop: async () => {} },
      HexiGridDesktopScreen: { stop() {} }
    },
    request,
    connectedLinks: value => value.agentLinks || [],
    escape: String,
    linkLabel: item => item.id,
    renderSpeechSettings() {},
    renderMicrophoneState() {},
    renderSpeakerState() {},
    renderVoiceCall() {},
    clearInterval() {},
    setInterval() { return 1; },
    initialState
  });
  vm.runInContext(`${state}\n${permissionRender}\n${linkSelectionHandler}\n${bulkHandlers}\n${permissionHandlers}
    function render(manifest, nextState) { latestManifest = manifest; latestState = nextState; renderDesktopBridge(nextState); }
    this.permissionTest = {
      render: () => renderDesktopBridge(latestState),
      state: () => latestState,
      busy: () => linkPermissionEditBusy
    };
    latestState = initialState;
    renderDesktopBridge(latestState);`, context);
  return { node, link, context, api: context.permissionTest };
}

function checkbox(scope, checked) {
  return { dataset: { linkPermission: scope }, checked, disabled: false, closest() { return this; } };
}

function inputTag(f, scope) {
  const tag = f.node('#desktopLinkPermissions').innerHTML.match(new RegExp(`<input type="checkbox" data-link-permission="${scope}"[^>]*>`));
  assert.ok(tag, `permission input for ${scope} is rendered`);
  return tag[0];
}

test('permission changes serialize competing toggles and keep the lock through refresh renders', async () => {
  const pending = deferred();
  const calls = [];
  const f = fixture((path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return pending.promise; });
  const permissions = f.node('#desktopLinkPermissions');
  f.node('#desktopBridgeLink').value = 'link-a';
  const first = checkbox('desktop-view', true);
  first.checked = false;
  const firstEdit = permissions.listeners.change({ target: { closest: () => first } });
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/agent-links/link-a/capabilities');
  assert.deepEqual(calls[0].body.capabilities, ['camera-view', 'microphone-listen']);
  assert.equal(f.api.busy(), true);

  f.api.render();
  assert.equal(f.node('#desktopBridgeLink').disabled, true);
  for (const selector of ['#desktopBridgeGrant', '#desktopBridgeRevoke', '#ownerAgentGrant', '#ownerAgentRevoke']) assert.equal(f.node(selector).disabled, true);
  const renderedInputs = f.node('#desktopLinkPermissions').innerHTML.match(/<input type="checkbox"[^>]*>/g);
  assert.ok(renderedInputs.length > 0 && renderedInputs.every(tag => tag.includes('disabled')));
  assert.doesNotMatch(inputTag(f, 'desktop-view'), /\bchecked\b/, 'pending save keeps the requested revoked value visible');

  const second = checkbox('camera-view', true);
  second.checked = false;
  await permissions.listeners.change({ target: { closest: () => second } });
  f.node('#desktopBridgeGrant').listeners.click();
  f.node('#desktopBridgeRevoke').listeners.click();
  f.node('#ownerAgentGrant').listeners.click();
  f.node('#ownerAgentRevoke').listeners.click();
  assert.equal(calls.length, 1);
  assert.equal(second.checked, true, 'overlapping toggle reverts to the current Link grant');

  const select = f.node('#desktopBridgeLink');
  select.value = 'link-b';
  select.listeners.change({ currentTarget: select });
  assert.equal(select.value, 'link-a', 'the selected Link remains pinned during the write');

  pending.resolve({ connection: { ...f.link, capabilities: calls[0].body.capabilities } });
  await firstEdit;
  assert.equal(f.api.busy(), false);
  assert.deepEqual(Array.from(f.api.state().agentLinks[0].capabilities), ['camera-view', 'microphone-listen']);
  assert.equal(select.disabled, false);
  assert.doesNotMatch(inputTag(f, 'desktop-view'), /\bchecked\b/);
  assert.match(inputTag(f, 'camera-view'), /\bchecked\b/);
  assert.doesNotMatch(inputTag(f, 'camera-view'), /\bdisabled\b/);
  assert.match(inputTag(f, 'owner-filesystem-read'), /\bdisabled\b/, 'normal trust restrictions remain after unlock');
  assert.equal(f.node('#desktopBridgeGrant').disabled, false);
  assert.equal(f.node('#desktopBridgeRevoke').disabled, false);
  assert.equal(f.node('#ownerAgentGrant').disabled, false);
  assert.equal(f.node('#ownerAgentRevoke').disabled, true);
});

test('rejected permission changes unlock and preserve the original disabled standing', async () => {
  const pending = deferred();
  const calls = [];
  const f = fixture((path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return pending.promise; });
  const select = f.node('#desktopBridgeLink');
  select.disabled = true;
  const input = checkbox('desktop-view', true);
  input.checked = false;
  const edit = f.node('#desktopLinkPermissions').listeners.change({ target: { closest: () => input } });
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(f.api.busy(), true);
  f.api.render();
  assert.equal(select.disabled, true);
  pending.reject(new Error('Permission denied'));
  await edit;

  assert.equal(f.api.busy(), false);
  assert.equal(select.disabled, true, 'the selector returns to its prior disabled state');
  assert.deepEqual(Array.from(f.api.state().agentLinks[0].capabilities), ['desktop-view', 'camera-view', 'microphone-listen']);
  assert.match(inputTag(f, 'desktop-view'), /\bchecked\b/);
  assert.doesNotMatch(inputTag(f, 'desktop-view'), /\bdisabled\b/);
  assert.match(inputTag(f, 'owner-filesystem-read'), /\bdisabled\b/);
  assert.equal(f.node('#ownerAgentGrant').disabled, false);
  assert.equal(f.node('#ownerAgentRevoke').disabled, true);
});
