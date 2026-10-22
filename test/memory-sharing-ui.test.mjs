import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
function fixture(request) {
  const nodes = new Map();
  const root = { innerHTML: '', querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', disabled: false, hidden: false, innerHTML: '', textContent: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
    return nodes.get(selector);
  } };
  const context = { window: {} }; vm.runInNewContext(source, context);
  const api = context.window.HexiGridMemorySharing.create({ root, request, agents: () => [{ id: 'source', name: '<Source>' }, { id: 'target', name: 'Target' }],
    links: () => [{ id: 'link-target', agentId: 'target', status: 'connected', capabilities: ['memory-read'] }, { id: 'link-source', agentId: 'source', status: 'connected', capabilities: ['memory-read'] }, { id: 'link-denied', agentId: 'target', status: 'connected', capabilities: [] }] });
  const node = name => root.querySelector(`[data-share-${name}]`);
  return { api, node, root };
}
const packet = { result: { structuredContent: { scopes: [{ projectId: 'Project', topicId: 'Topic' }], nextCursor: null } } };
test('sharing requires exact selections and explicit review; cancel writes nothing; confirmed grant and revoke use existing authority path', async () => {
  const writes = [];
  let shared = [];
  const ui = fixture(async (url, options) => {
    if (url.endsWith('/memory-mcp')) return packet;
    if (!options) return { shares: shared };
    const body = JSON.parse(options.body); writes.push({ url, body });
    if (url.endsWith('/revoke')) shared[0].status = 'revoked';
    else shared = [{ id: 'memory-share-test', sourceAgentId: 'source', targetAgentId: 'target', targetLinkId: 'link-target', scope: body.scope, status: 'active' }];
    return {};
  });
  await ui.api.refresh();
  ui.node('source').value = 'source'; await ui.api.refresh();
  assert.doesNotMatch(ui.node('target').innerHTML, /link-source|link-denied/);
  assert.match(ui.node('scope').innerHTML, /Project \/ Topic/);
  ui.node('target').value = 'link-target'; ui.node('target').listeners.change();
  assert.equal(ui.node('submit').disabled, true, 'placeholder is not scope zero');
  ui.node('scope').value = '0'; ui.node('scope').listeners.change();
  ui.node('form').listeners.submit({ preventDefault() {} });
  assert.equal(writes.length, 0); assert.match(ui.node('summary').textContent, /Project \/ Topic/);
  ui.node('cancel').listeners.click(); await ui.node('confirm-button').listeners.click(); assert.equal(writes.length, 0);
  ui.node('form').listeners.submit({ preventDefault() {} }); await ui.node('confirm-button').listeners.click();
  assert.deepEqual(writes[0], { url: '/api/memory-shares', body: { sourceAgentId: 'source', targetLinkId: 'link-target', scope: { projectId: 'Project', topicId: 'Topic' }, approved: true } });
  assert.match(ui.node('list').innerHTML, /&lt;Source&gt;/);
  ui.node('list').listeners.click({ target: { closest: () => ({ dataset: { shareRevoke: 'memory-share-test' } }) } });
  assert.equal(writes.length, 1); await ui.node('confirm-button').listeners.click();
  assert.deepEqual(writes[1], { url: '/api/memory-shares/memory-share-test/revoke', body: { approved: true } });
  assert.match(ui.node('list').innerHTML, /revoked/);
});
test('failed scope or grant request cannot reuse a stale selection or replay a write', async () => {
  let fail = false, writes = 0;
  const ui = fixture(async (url, options) => {
    if (url.endsWith('/memory-mcp')) { if (fail) throw new Error('Disconnected'); return packet; }
    if (!options) return { shares: [] };
    writes++; throw new Error('Disconnected');
  });
  ui.node('source').value = 'source'; await ui.api.refresh();
  ui.node('scope').value = '0'; ui.node('target').value = 'link-target'; ui.node('target').listeners.change();
  ui.node('form').listeners.submit({ preventDefault() {} }); await ui.node('confirm-button').listeners.click();
  await ui.node('confirm-button').listeners.click(); assert.equal(writes, 1); assert.match(ui.node('status').textContent, /not retried/);
  fail = true; await ui.api.refresh(); assert.equal(ui.node('submit').disabled, true); assert.match(ui.node('scope-help').textContent, /Disconnected/);
});
test('a late scope read cannot replace another selected agent and scopes page through the returned cursor', async () => {
  const pending = [];
  const ui = fixture((url, options) => url.endsWith('/memory-mcp') ? new Promise(resolve => pending.push({ body: JSON.parse(options.body), resolve })) : Promise.resolve({ shares: [] }));
  ui.node('source').value = 'source';
  const first = ui.api.refresh();
  await new Promise(resolve => setImmediate(resolve));
  ui.node('source').value = 'target';
  const second = ui.api.refresh();
  await new Promise(resolve => setImmediate(resolve));
  pending[1].resolve({ result: { structuredContent: { scopes: [{ projectId: 'New' }], nextCursor: 'opaque-cursor' } } });
  await second;
  pending[0].resolve(packet); await first;
  assert.match(ui.node('scope').innerHTML, /New/); assert.doesNotMatch(ui.node('scope').innerHTML, /Project/);
  ui.node('more').listeners.click();
  assert.equal(pending[2].body.params.arguments.cursor, 'opaque-cursor');
  pending[2].resolve({ result: { structuredContent: { scopes: [{ projectId: 'Next' }], nextCursor: null } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ui.node('scope').innerHTML, /New.*Next/); assert.equal(ui.node('more').hidden, true);
});
