import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/integrations.js', import.meta.url), 'utf8');
const part = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const changeStart = source.lastIndexOf('for (const [id, key] of [...desktopLinkPermissionFields');

test('active call controls stay available when another agent owns the desktop session', () => {
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); };
  const context = vm.createContext({ document: { querySelector: node },
    state: { data: { settings: { desktopBridge: { linkId: 'desktop-agent', enabled: true } } } },
    window: { HexiGridDesktopMedia: { state: () => ({}) }, HexiGridViewRenderers: { currentAgentLinks: () => [] } },
    desktopVoiceCall: { linkId: 'calling-agent', status: 'active', ownerMuted: false } });
  vm.runInContext(part('function renderDesktopVoiceCall()', 'async function refreshDesktopVoiceCall()') + '\nrenderDesktopVoiceCall();', context);
  assert.equal(node('#desktopVoiceCallEnd').disabled, false);
  assert.equal(node('#desktopVoiceCallMute').disabled, false);
});

function fixture(request) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, disabled: false, listeners: {},
      classList: { toggle() {} }, setAttribute() {}, addEventListener(kind, fn) { this.listeners[kind] = fn; },
      options: [{ textContent: 'Camera-only QA' }], selectedIndex: 0 });
    return nodes.get(id);
  }
  const link = { id: 'link-camera-qa', status: 'offline', authorizationStatus: 'connected', identity: { name: 'Camera-only QA' },
    capabilities: ['messages', 'camera-view', 'tasks'], grantedCapabilities: ['messages', 'camera-view', 'tasks'], selfManagementEnabled: false };
  const state = { data: { agentLinks: [link], settings: { desktopBridge: { enabled: false } } } };
  node('#desktopBridgeLink').value = link.id;
  const context = vm.createContext({ document: { querySelector: node }, state,
    window: { HexiGridViewRenderers: { currentAgentLinks: value => value.agentLinks },
      HexiGridDesktopMedia: { state: () => ({}), start: async () => ({ failures: [] }) } },
    approvedRequest: request, escapeHtml: String, renderDesktopBridgePermissionHint() {}, renderDesktopSpeakerState() {},
    renderDesktopVoiceCall() {}, refreshDesktopBridgeFrame() {}, refreshDesktopVoiceCall() {}, api() {}, clearInterval() {}, setInterval() { return 1; } });
  vm.runInContext([
    part('const desktopLinkPermissionFields', 'const integrationSection'),
    part('let desktopBridgeTimer', 'function renderTailnetLink'),
    part('function renderDesktopBridge()', 'async function renderHexiSpaceLinks'),
    part('async function saveDesktopLinkPermissions', "document.querySelector('#tailnetLinkToggle')"),
    source.slice(changeStart, source.indexOf("document.querySelector('#desktopBridgeSpeakerEnable')", changeStart)),
    'this.paint = renderDesktopBridge;'
  ].join('\n'), context);
  context.paint();
  return { node, state, paint: context.paint,
    change(id, checked) { const input = node(id); input.checked = checked; input.listeners.change({ currentTarget: input }); } };
}

test('existing camera-only connection exposes dynamic permissions and saves the same Link without another invitation', async () => {
  const calls = []; let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ui = fixture(async (route, options) => {
    calls.push({ route, body: JSON.parse(options.body) });
    await pending;
    const body = calls.at(-1).body;
    return { connection: { ...ui.state.data.agentLinks[0], capabilities: body.capabilities,
      grantedCapabilities: body.capabilities, selfManagementEnabled: body.selfManagementEnabled } };
  });
  for (const id of ['View', 'Control', 'Camera', 'Microphone', 'Speaker', 'MemoryRead', 'SelfManage']) {
    assert.equal(ui.node(`#desktopBridge${id}`).disabled, false, `${id} can be changed after pairing`);
  }
  assert.equal(ui.node('#desktopBridgeCamera').checked, true);
  ui.change('#desktopBridgeMicrophone', true);
  ui.change('#desktopBridgeSpeaker', true);
  ui.change('#desktopBridgeSelfManage', true);
  ui.paint();
  assert.equal(ui.node('#desktopBridgeMicrophone').checked, true, 'polling does not erase unsaved changes');
  const saving = ui.node('#desktopBridgeSavePermissions').listeners.click();
  assert.equal(ui.node('#desktopBridgeLink').disabled, true);
  assert.equal(ui.node('#desktopBridgeCamera').disabled, true);
  release(); await saving;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/api/agent-links/link-camera-qa/capabilities');
  assert.equal(calls[0].body.selfManagementEnabled, true);
  assert.deepEqual(calls[0].body.capabilities.slice().sort(), ['messages', 'tasks', 'camera-view', 'microphone-listen', 'speaker-output'].sort());
  assert.equal(ui.state.data.agentLinks[0].id, 'link-camera-qa');
  assert.equal(ui.node('#desktopBridgeLink').disabled, false);
});

test('Start access saves new permissions first and enables both mouse and text input', async () => {
  const calls = [];
  const ui = fixture(async (route, options) => {
    const body = JSON.parse(options.body); calls.push({ route, body });
    if (route.endsWith('/capabilities')) return { connection: { ...ui.state.data.agentLinks[0],
      capabilities: body.capabilities, grantedCapabilities: body.capabilities, selfManagementEnabled: body.selfManagementEnabled } };
    return { bridge: { linkId: body.linkId, enabled: true, viewGranted: body.viewGranted, controlGranted: body.controlGranted } };
  });
  ui.change('#desktopBridgeControl', true);
  assert.equal(ui.node('#desktopBridgeView').checked, true);
  await ui.node('#desktopBridgeForm').listeners.submit({ preventDefault() {}, currentTarget: { querySelector: () => ({}) } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].route, '/api/agent-links/link-camera-qa/capabilities');
  assert.equal(calls[0].body.activate, true);
  assert.equal(calls[0].body.capabilities.includes('desktop-type'), true);
  assert.equal(calls[1].route, '/api/desktop-bridge/start');
  assert.equal(calls[1].body.linkId, 'link-camera-qa');
  assert.equal(calls[1].body.textGranted, true);
});

test('rejected permission save stays editable and never starts access', async () => {
  const calls = [];
  const ui = fixture(async route => { calls.push(route); throw new Error('Current work mode blocks this change.'); });
  ui.change('#desktopBridgeMicrophone', true);
  await ui.node('#desktopBridgeForm').listeners.submit({ preventDefault() {}, currentTarget: { querySelector: () => ({}) } });
  assert.deepEqual(calls, ['/api/agent-links/link-camera-qa/capabilities']);
  assert.equal(ui.node('#desktopBridgeMicrophone').checked, true);
  assert.equal(ui.node('#desktopBridgeMicrophone').disabled, false);
  assert.equal(ui.state.data.agentLinks[0].capabilities.includes('microphone-listen'), false);
  assert.match(ui.node('#desktopBridgeFeedback').textContent, /work mode blocks/);
});


test('new invitations reuse the same permission controls without a second form', () => {
  assert.equal(source.includes('id="desktopInviteForm"'), false);
  assert.equal(source.includes('id="desktopInviteCamera"'), false);
  assert.equal(source.includes('Memory and HexiSpace permissions</summary>'), false);
  assert.match(source, /desktopLinkPermissionFields\.map/);
  const ui = fixture(async () => { throw new Error('render does not issue an invitation'); });
  ui.node('#desktopBridgeLink').value = 'new';
  // The real invitation entry point changes selection through the same owner menu.
  assert.ok(source.includes('window.HexiGridOpenAgentInvitation'));
});
