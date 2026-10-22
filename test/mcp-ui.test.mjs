import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function run(values, fail = false, action = null) {
  const source = await readFile(new URL('../public/integrations.js', import.meta.url), 'utf8');
  const calls = [], notifications = [], dialogs = []; let handler, refreshed = 0;
  const context = vm.createContext({
    document: { addEventListener(type, listener) { handler = listener; } },
    state: { data: { mcpServers: [{ id: 'synthetic', name: 'QA', tools: [{ name: 'echo', inputSchema: { properties: { text: { type: 'string' }, payload: { type: 'object' } }, required: ['text'] } }] }] } },
    async modalRequest(options) { dialogs.push(options); return ['echo', 'Update protected MCP credentials'].includes(options.title) ? values : true; },
    async approvedRequest(url, options) { calls.push(JSON.parse(options.body)); if (fail) throw Error('Synthetic MCP failure'); return { result: { text: 'echoed' } }; },
    notify(message, error) { notifications.push({ message, error }); },
    async refresh() { refreshed++; }
  });
  vm.runInContext(source.slice(source.indexOf("document.addEventListener('click'")), context);
  await handler({ target: { closest(selector) { if (action) return selector === '[data-mcp-action]' ? { dataset: { mcpId: 'synthetic', mcpAction: action } } : null; return selector === '[data-mcp-use]' ? { dataset: { mcpUse: 'synthetic', mcpTool: 'echo' } } : null; } } });
  return { calls, notifications, dialogs, refreshed };
}

test('malformed MCP JSON reports its field without dispatch or unhandled rejection', async () => {
  const result = await run(['harmless', '{']);
  assert.deepEqual(result.notifications, [{ message: 'payload needs valid JSON.', error: true }]);
  assert.equal(result.calls.length, 0); assert.equal(result.refreshed, 0);
});
test('valid MCP structured input reaches execution and result dialog', async () => {
  const result = await run(['harmless', '{"note":"synthetic"}']);
  assert.deepEqual(result.calls, [{ tool: 'echo', input: { text: 'harmless', payload: { note: 'synthetic' } } }]);
  assert.equal(result.dialogs.at(-1).title, 'echo completed'); assert.equal(result.refreshed, 1);
});
test('MCP execution failure remains actionable without false success', async () => {
  const result = await run(['harmless', ''], true);
  assert.deepEqual(result.notifications, [{ message: 'Synthetic MCP failure', error: true }]);
  assert.equal(result.refreshed, 0); assert.equal(result.dialogs.length, 1);
});


test('MCP removal failure refreshes disabled standing and preserves actionable error', async () => {
  const result = await run([], true, 'remove');
  assert.deepEqual(result.notifications, [{ message: 'Synthetic MCP failure', error: true }]);
  assert.equal(result.refreshed, 1);
  assert.equal(result.dialogs[0].title, 'Remove this MCP server?');
});


test('MCP credential dialog masks the value and sends a complete replacement map', async () => {
  const result = await run(['bearer', 'synthetic-protected-value', false], false, 'credentials');
  assert.equal(result.dialogs[0].fields[1].type, 'password');
  assert.deepEqual(result.calls, [{ secrets: { bearer: 'synthetic-protected-value' } }]);
  assert.equal(result.refreshed, 1);
});
test('MCP credential cancel and empty input do not write; clear is explicit', async () => {
  assert.equal((await run(null, false, 'credentials')).calls.length, 0);
  const empty = await run(['', '', false], false, 'credentials');
  assert.equal(empty.calls.length, 0); assert.match(empty.notifications[0].message, /Enter a protected name/);
  assert.deepEqual((await run(['', '', true], false, 'credentials')).calls, [{ secrets: {} }]);
});
