import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { agentInterfaceManifest } from '../lib/agent-interface.mjs';

const routes = await readFile(new URL('../lib/agent-link-routes.mjs', import.meta.url), 'utf8');
const manifest = agentInterfaceManifest();
const descriptors = manifest.actions;

// Each row links an owner descriptor to the signed route contract. Route and
// descriptor references are kept here so parity gaps fail at the operation row.
const matrix = [
  { owner: 'installPlugin', linked: 'installLinkedPlugin', route: '/agent-link/v1/plugins/install', method: 'POST', receipt: true, path: 'lib/agent-link-routes.mjs:212-216; lib/agent-interface.mjs:285' },
  { owner: 'removePlugin', linked: 'removeLinkedPlugin', route: '/agent-link/v1/plugins/{pluginId}/remove', method: 'POST', receipt: true, path: 'lib/agent-link-routes.mjs:217-222; lib/agent-interface.mjs:286' },
  { owner: 'setPluginCredentials', linked: 'setLinkedPluginCredentials', route: '/agent-link/v1/plugins/{pluginId}/secrets', method: 'POST', receipt: true, path: 'lib/agent-link-routes.mjs:223-228; lib/agent-interface.mjs:287' },
  { owner: 'setPluginEnabled', linked: 'enableLinkedPlugin', route: '/agent-link/v1/plugins/{pluginId}/enable', method: 'POST', receipt: true, path: 'lib/agent-link-routes.mjs:229-233; lib/agent-interface.mjs:288' },
  { owner: 'runPlugin', linked: 'runLinkedPlugin', route: '/agent-link/v1/plugins/{pluginId}/run', method: 'POST', receipt: true, path: 'lib/agent-link-routes.mjs:234-238; lib/agent-interface.mjs:289' },
  { owner: 'createMcpServer', linked: 'createLinkedMcpServer', route: '/agent-link/v1/mcp', method: 'POST', receipt: true, path: 'lib/agent-link-routes.mjs:240-243; lib/agent-interface.mjs:296,280' },
  { owner: 'mcpServers', linked: 'linkedMcpCatalog', route: '/agent-link/v1/mcp', method: 'GET', receipt: false, scope: 'owner-filesystem-read', path: 'lib/agent-link-routes.mjs:244-249; lib/agent-interface.mjs:59,281' },
  { owner: 'discoverMcpTools', linked: 'discoverLinkedMcpTools', route: '/agent-link/v1/mcp/{serverId}/test', method: 'POST', receipt: true, path: 'lib/agent-link-routes.mjs:250-254; lib/agent-interface.mjs:299' },
  { owner: 'setMcpEnabled', linked: 'enableLinkedMcpServer', route: '/agent-link/v1/mcp/{serverId}/enable', method: 'POST', receipt: true, path: 'lib/agent-link-routes.mjs:255-260; lib/agent-interface.mjs:300' },
  { owner: 'setMcpCredentials', linked: 'setLinkedMcpCredentials', route: '/agent-link/v1/mcp/{serverId}/secrets', method: 'POST', receipt: true, path: 'lib/agent-link-routes.mjs:261-265; lib/agent-interface.mjs:301' },
  { owner: 'callMcpTool', linked: 'callLinkedMcpTool', route: '/agent-link/v1/mcp/{serverId}/call', method: 'POST', receipt: true, path: 'lib/agent-link-routes.mjs:266-270; lib/agent-interface.mjs:282,305' },
  { owner: 'removeMcpServer', linked: 'removeLinkedMcpServer', route: '/agent-link/v1/mcp/{serverId}/remove', method: 'POST', receipt: true, path: 'lib/agent-link-routes.mjs:271-275; lib/agent-interface.mjs:302' },
];

test('plugin/MCP owner versus linked operation parity matrix', async t => {
  for (const row of matrix) await t.test(`${row.owner} ↔ ${row.linked}`, () => {
    const owner = descriptors[row.owner] || manifest.resources?.[row.owner];
    const linked = descriptors[row.linked];
    assert.ok(owner, `${row.path}: missing owner descriptor ${row.owner}`);
    assert.ok(linked, `${row.path}: missing linked descriptor ${row.linked}`);
    assert.equal(linked.path || linked.pathTemplate, row.route, row.path);
    assert.equal(linked.method, row.method, row.path);
    assert.ok(linked.authentication === 'signed Link' || linked.signedLink === true, row.path);
    assert.match(routes, new RegExp(`ownerAgentAuthorized\\(connection, state\\.settings\\.desktopBridge, '${row.scope || 'owner-process'}'\\)`), row.path);
    const routeNeedle = row.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}/g, '[^/]+');
    assert.match(routes, new RegExp(routeNeedle.split('/').slice(-1)[0]), row.path);
    assert.ok(row.receipt ? /receipt/.test(linked.response || '') || /receipt/.test(linked.note || '') : true, row.path);
    assert.match(linked.note || '', /policy|session|trust|computer/i, row.path);
  });

  await t.test('explicit owner-only exclusions', () => {
    // Credential vault internals and direct owner file/package manipulation have
    // no remote operation; linked install/secrets routes are mediated equivalents.
    const excluded = ['pluginFilesystemPath', 'pluginVaultValues', 'mcpVaultValues'];
    for (const name of excluded) assert.equal(descriptors[name], undefined, name);
    assert.match(descriptors.installPlugin.note, /OS credential vault/);
    assert.match(descriptors.createMcpServer.note, /OS vault/);
  });
});
