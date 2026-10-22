import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const script = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
function fixture() {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '' }); return nodes.get(id); };
  const ctx = { window: {} };
  vm.runInNewContext(script, ctx);
  $('#activityFilter').value = 'all';
  $('#activityOutcome').value = 'all';
  const state = { data: { agents: [], receipts: ['completed', 'blocked', 'cancelled', 'pending', 'waiting_approval', 'unexpected'].map((status, i) => ({ id: `qa-${i}`, status, source: 'qa', action: status, detail: 'Harmless receipt', capability: 'read_local', createdAt: '2026-09-30T00:00:00Z' })), activity: [{ id: 'note', kind: 'system', text: 'Note', createdAt: '2026-09-30T00:00:00Z' }] } };
  const render = () => ctx.window.HexiGridViewRenderers.renderActivity({ state, $, escapeHtml: text => String(text).replaceAll('<', '&lt;'), timeAgo: () => 'now' });
  return { $, state, render };
}
test('only an explicitly completed receipt is shown as Completed', () => {
  const { $, render } = fixture(); render();
  const html = $('#activityTimeline').innerHTML;
  assert.equal((html.match(/>Completed<\/span>/g) || []).length, 1);
  for (const label of ['Blocked', 'Cancelled', 'Pending', 'Needs approval', 'Unknown', 'Recorded']) assert.ok(html.includes(`>${label}</span>`));
});
test('outcome filters and exact receipt search do not include unrelated events', () => {
  const { $, render } = fixture();
  $('#activityOutcome').value = 'attention'; render();
  assert.equal($('#activityResultCount').textContent, '2 events');
  $('#activityOutcome').value = 'recorded'; render();
  assert.equal($('#activityResultCount').textContent, '1 event');
  $('#activityOutcome').value = 'all'; $('#activitySearch').value = 'qa-3'; render();
  assert.equal($('#activityResultCount').textContent, '1 event');
  assert.match($('#activityTimeline').innerHTML, />Pending<\/span>/);
  assert.match($('#activityTimeline').innerHTML, /read_local/);
});

test('category follows the action while source attribution remains searchable', () => {
  const { $, state, render } = fixture();
  state.data.activity = [];
  state.data.receipts = [
    { id: 'stop', action: 'room:stop', source: 'owner', capability: 'conversation' },
    { id: 'file', action: 'workspace:write', source: 'agent-link', capability: 'workspace-write' },
    { id: 'restore', action: 'backup:import', source: 'backup', capability: 'restore_backup' },
    { id: 'model', action: 'provider:test', source: 'owner' }
  ].map(receipt => ({ ...receipt, status: 'completed', detail: 'QA', createdAt: '2026-09-30T00:00:00Z' }));
  for (const [category, id] of [['chat', 'stop'], ['workspace', 'file'], ['policy', 'restore'], ['model', 'model']]) {
    $('#activityFilter').value = category; render();
    assert.equal($('#activityResultCount').textContent, '1 event');
    assert.match($('#activityTimeline').innerHTML, new RegExp(`<dd>${id}</dd>`));
  }
  $('#activityFilter').value = 'all'; $('#activitySearch').value = 'agent-link'; render();
  assert.equal($('#activityResultCount').textContent, '1 event');
  assert.match($('#activityTimeline').innerHTML, /<dt>Source<\/dt><dd>agent-link/);
});

test('pagination expands the sorted filtered collection without changing its standing', () => {
  const { $, state, render } = fixture();
  state.data.activity = [];
  state.data.receipts = Array.from({ length: 205 }, (_, i) => ({ id: `page-${i}`, action: 'room:stop', status: 'cancelled', source: 'owner', detail: 'QA', createdAt: new Date(Date.UTC(2026, 8, 30, 0, i)).toISOString() }));
  $('#activityFilter').value = 'chat'; render();
  assert.equal($('#activityResultCount').textContent, 'Showing 100 of 205 events');
  assert.equal(($('#activityTimeline').innerHTML.match(/class="timeline-event"/g) || []).length, 100);
  state.activityVisibleCount = 200; render();
  assert.equal($('#activityResultCount').textContent, 'Showing 200 of 205 events');
  state.activityVisibleCount = 300; render();
  assert.equal($('#activityResultCount').textContent, '205 events');
  assert.doesNotMatch($('#activityTimeline').innerHTML, /show-more-activity/);
  assert.equal(($('#activityTimeline').innerHTML.match(/>Cancelled<\/span>/g) || []).length, 205);
});

test('notes use the same categories and avatar actions outrank generic conversation capability', () => {
  const { $, state, render } = fixture();
  state.data.receipts = [{ id: 'avatar', action: 'avatar_model_save', source: 'owner', capability: 'conversation', status: 'completed', detail: 'QA' },
    { id: 'memory', action: 'memory:propose-memory', source: 'memory', capability: 'write_workspace', status: 'completed', detail: 'QA' }];
  state.data.activity = ['room', 'security', 'agent-link'].map(kind => ({ kind, text: 'QA note' }));
  for (const [category, count] of [['chat', '1 event'], ['policy', '1 event'], ['agent', '3 events']]) {
    $('#activityFilter').value = category; render();
    assert.equal($('#activityResultCount').textContent, count);
  }
});
