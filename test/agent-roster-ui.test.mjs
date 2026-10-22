import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/agent-ui.js', import.meta.url), 'utf8');
const rendererSource = await fs.readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function usesPairedAgentModel('), source.indexOf('function renderAgentCard(')) + source.slice(source.indexOf('function agentRosterAccountLabel('), source.indexOf('function renderAgents()'));

test('agent interface roster uses live Link standing rather than stale profile connected status', async () => {
  const script = await fs.readFile(new URL('../public/agent-interface.js', import.meta.url), 'utf8');
  const helper = script.slice(script.indexOf('  function rosterStanding('), script.indexOf('  const interfaceRoot'));
  const context = { window: {}, Intl, Date, connectedLinks: state => state.agentLinks.filter(link => link.authorizationStatus === 'connected') };
  vm.runInNewContext(rendererSource, context);
  vm.runInNewContext(`${helper}\nthis.standing = rosterStanding; this.model = rosterModel;`, context);
  const item = { id: 'qa', transport: 'ilands-link', status: 'connected' };
  const state = { agentLinks: [{ agentId: 'qa', authorizationStatus: 'revoked', heartbeat: { state: 'online' } }] };
  assert.equal(context.standing(item, state), 'No active link');
  state.agentLinks.push({ agentId: 'qa', authorizationStatus: 'connected', heartbeat: { state: 'offline' } });
  assert.equal(context.standing(item, state), 'Paired · heartbeat idle');
  state.agentLinks[1].heartbeat.state = 'online';
  assert.equal(context.standing(item, state), 'Online');
  assert.equal(context.standing({ transport: 'local-opencode', status: 'local_ready' }, state), 'Local ready');
  assert.equal(context.standing({ ...item, transport: 'agent-link' }, state), 'Online');
  assert.equal(context.standing({ ...item, transport: 'local-opencode' }, state), 'Online');
  assert.equal(context.model({ ...item, model: 'harness:codex:default' }, state), 'Managed in agent’s app');
  assert.equal(context.model({ ...item, transport: 'local-opencode' }, state), 'Managed in agent’s app');
  const unlinked = { agentLinks: [] };
  assert.equal(context.standing({ ...item, transport: 'agent-link' }, unlinked), 'No active link');
  assert.equal(context.model({ ...item, transport: 'agent-link' }, unlinked), 'Managed in agent’s app');
  assert.equal(context.model({ id: 'local', transport: 'local-opencode', model: 'local-model' }, state), 'local-model');
  assert.equal(context.model({ id: 'local', transport: 'local-opencode' }, state), 'not-configured');
});

function roster(links) {
  const context = { state: { data: { agentLinks: links } }, window: {}, Intl, Date };
  vm.runInNewContext(rendererSource, context);
  vm.runInNewContext(`${helpers}\nthis.findLink = agentRosterLink; this.presence = agentRosterPresence; this.accountLabel = agentRosterAccountLabel;`, context);
  return context;
}

test('agent roster identifies the newest authorized link without treating a revoked link as live', () => {
  const links = [
    { id: 'old-revoked', agentId: 'exampleagent', authorizationStatus: 'revoked', connectedAt: '2026-09-23T10:00:00Z', status: 'revoked' },
    { id: 'live-earlier', agentId: 'exampleagent', authorizationStatus: 'connected', connectedAt: '2026-09-23T11:00:00Z', heartbeat: { state: 'offline' } },
    { id: 'live-later', agentId: 'exampleagent', authorizationStatus: 'connected', connectedAt: '2026-09-23T12:00:00Z', heartbeat: { state: 'online' } },
    { id: 'different-agent', agentId: 'other', authorizationStatus: 'connected', connectedAt: '2026-09-23T13:00:00Z' }
  ];
  const ui = roster(links);
  assert.equal(ui.findLink({ id: 'exampleagent', transport: 'ilands-link' })?.id, 'live-later');
  assert.equal(ui.presence(ui.findLink({ id: 'exampleagent', transport: 'ilands-link' })).label, 'Online');
  assert.equal(ui.findLink({ id: 'local', transport: 'local-opencode' }), null);
  assert.equal(roster([links[0]]).findLink({ id: 'exampleagent', transport: 'ilands-link' }), null);
});

test('authorized but heartbeat-idle links preserve pairing in the roster', () => {
  const ui = roster([{ id: 'link', agentId: 'exampleagent', authorizationStatus: 'connected', heartbeat: { state: 'offline' } }]);
  assert.equal(ui.presence(ui.findLink({ id: 'exampleagent', transport: 'ilands-link' })).label, 'Paired · heartbeat idle');
});

test('legacy link labels do not misidentify a provider-neutral agent as iLands', () => {
  const ui = roster([]);
  assert.equal(ui.accountLabel({ transport: 'ilands-link', accountLabel: 'Existing iLands account' }), 'Agent profile');
  assert.equal(ui.accountLabel({ transport: 'ilands-runner', accountLabel: 'Existing iLands account' }), 'Existing iLands account');
  assert.equal(ui.accountLabel({ transport: 'ilands-link', accountLabel: 'Owner-chosen label' }), 'Owner-chosen label');
});

test('overview connected metric counts live companion heartbeats, not stale authorizations', async () => {
  const script = await fs.readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
  const nodes = new Map();
  const context = { window: {} };
  vm.runInNewContext(script, context);
  const state = {
    data: {
      agents: [], rooms: [], activity: [],
      settings: { sync: { enabled: false }, subagents: { enabled: false } },
      runnerProfiles: [{ runtime: { running: true } }],
      agentLinks: [
        { authorizationStatus: 'connected', heartbeat: { state: 'online' } },
        { authorizationStatus: 'connected', heartbeat: { state: 'offline' } },
        { authorizationStatus: 'revoked', heartbeat: { state: 'online' } }
      ]
    }
  };
  context.window.HexiGridViewRenderers.renderOverview({
    state, $: (selector) => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); },
    escapeHtml: String, timeAgo: () => '', workMode: () => null, approvalProfile: () => null,
    renderAgentCard: () => ''
  });
  assert.equal(nodes.get('#metricConnected').textContent, 2);
});

test('paired idle agents stay discoverable ahead of unlinked profiles without rewriting roster order', () => {
  const ui = roster([{ agentId: 'paired', authorizationStatus: 'connected', heartbeat: { state: 'offline' } }, { agentId: 'revoked', authorizationStatus: 'revoked' }]);
  const agents = [{ id: 'old' }, { id: 'revoked' }, { id: 'local', status: 'local_ready' }, { id: 'paired' }, { id: 'other' }];
  const result = ui.window.HexiGridViewRenderers.orderAgents(agents, ui.state.data.agentLinks);
  assert.deepEqual(Array.from(result, item => item.id), ['paired', 'local', 'old', 'revoked', 'other']);
  assert.deepEqual(agents.map(item => item.id), ['old', 'revoked', 'local', 'paired', 'other']);
});
