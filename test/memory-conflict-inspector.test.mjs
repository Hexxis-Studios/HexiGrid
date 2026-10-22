import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/integrations.js', import.meta.url), 'utf8');
const start = source.indexOf('function describeInspectedMemoryFact(');
const end = source.indexOf("document.querySelector('#addMemoryEntity')", start);
assert.ok(start >= 0 && end > start);
const id = n => `memory-${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
function fixture({ links = 4, failed = [], rootFailure = false, input = id(1) } = {}) {
  let handler, dialog;
  const requests = [], notices = [], button = { disabled: false };
  const root = { id: id(1), status: 'conditional', text: '<script>untrusted fact</script>',
    valid_while: 'Synthetic design remains selected', evidence_excerpt: 'Exact source excerpt',
    conflicts: Array.from({ length: links }, (_, i) => ({ otherId: id(i + 2), relation: 'contradicts',
      fromId: id(1), toId: id(i + 2), why: 'Sources disagree', evidence: { kind: 'owner-feedback', text: 'Exact conflict evidence' } })) };
  const context = { state: { editingAgentId: 'agent one' }, document: { querySelector(selector) {
    return selector === '#inspectMemoryFactId' ? { value: input } : { addEventListener(_name, fn) { handler = fn; } };
  } }, api: async url => {
    requests.push(url);
    const memoryId = decodeURIComponent(new URL(url, 'http://local').pathname.split('/').at(-1));
    if (failed.includes(memoryId) || (rootFailure && memoryId === id(1))) throw Error('Exact read unavailable');
    return { memory: memoryId === id(1) ? root : { id: memoryId, status: 'active', text: 'Linked fact' } };
  }, modalRequest: async value => { dialog = value; }, notify: message => notices.push(message) };
  vm.runInNewContext(source.slice(start, end), context);
  return { requests, notices, button, get dialog() { return dialog; }, run: () => handler({ currentTarget: button }) };
}

test('explicit inspection shows exact conditions/evidence and discloses bounded previews without writes', async () => {
  const ui = fixture(); await ui.run();
  assert.equal(ui.requests.length, 4);
  for (const url of ui.requests) assert.match(url, /^\/api\/agents\/agent%20one\/memory-facts\/memory-.*\?depth=2$/);
  assert.match(ui.dialog.message, /4 recorded link.*3 linked fact.*1 more linked fact/);
  assert.match(ui.dialog.fields[0].value, /Valid while: Synthetic design remains selected/);
  assert.match(ui.dialog.fields[0].value, /Source evidence: Exact source excerpt/);
  assert.match(ui.dialog.fields[0].value, /<script>untrusted fact<\/script>/); // readonly text, never HTML
  assert.match(ui.dialog.fields[1].value, /Exact conflict evidence/);
  assert.match(ui.dialog.fields[1].value, new RegExp(id(5)));
  assert.ok(ui.dialog.fields.every(field => field.readonly));
  assert.equal(ui.button.disabled, false);
});

test('one unavailable linked fact preserves root evidence; root failure reports and restores button', async () => {
  const partial = fixture({ failed: [id(2)] }); await partial.run();
  assert.match(partial.dialog.fields[0].value, /Linked fact could not be read/);
  assert.match(partial.dialog.fields[0].value, /Exact source excerpt/);
  const failed = fixture({ rootFailure: true }); await failed.run();
  assert.equal(failed.dialog, undefined); assert.deepEqual(failed.notices, ['Exact read unavailable']);
  assert.equal(failed.button.disabled, false);
});

test('invalid IDs cannot dispatch; larger link histories disclose omitted details', async () => {
  const invalid = fixture({ input: 'memory-' + '-'.repeat(36) }); await invalid.run();
  assert.equal(invalid.requests.length, 0);
  const large = fixture({ links: 21 }); await large.run();
  assert.equal(large.requests.length, 4);
  assert.match(large.dialog.fields[2].value, /1 links omitted.*depth 2/);
});
