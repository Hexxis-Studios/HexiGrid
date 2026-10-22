import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');

test('both readers expose escaped conflict details only at the selected recall depth', async () => {
  const ui = reader(async () => ({ facts: [{ id: 'conflicting-fact', text: 'Current fact', status: 'conditional',
    conflictCount: 1, conflicts: [{ relation: 'contradicts', otherId: 'other-fact', why: '<img src=x>',
      evidence: { text: '<script>private evidence</script>' } }] }] }));
  ui.nodes.get('#memoryRecallStore').value = 'facts';
  await ui.api.refresh();
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /<summary>Conflict links|private evidence|Inspect this fact in the profile/);
  ui.nodes.get('#memoryRecallDepth').value = '1'; await ui.api.refresh();
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Conflict links \(1\).*other-fact/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /&lt;img/);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /private evidence/);
  ui.nodes.get('#memoryRecallDepth').value = '2'; await ui.api.refresh();
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /&lt;script&gt;private evidence/);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /<script>|<img/);
});

function reader(request, ask, { rollback = false } = {}) {
  const nodes = new Map();
  for (const id of ['Agent', 'Status', 'List', 'Query', 'Standing', 'Depth', 'Refresh', 'More', 'Profile', 'Store', 'CreateSkill']) {
    nodes.set(`#memoryRecall${id}`, { value: id === 'Standing' ? 'all' : id === 'Depth' ? '0' : '', textContent: '', innerHTML: '', disabled: false,
      listeners: {}, classList: { toggle() {}, add() {} }, addEventListener(type, callback) { this.listeners[type] = callback; } });
  }
  if (rollback) {
    for (const [id, value] of [['memoryRollbackPanel', ''], ['memoryRollbackStatus', ''], ['memoryRollbackList', ''],
      ['memoryRollbackCreate', ''], ['memoryRollbackLabel', '']]) {
      nodes.set(`#${id}`, { value, textContent: '', innerHTML: '', disabled: false, hidden: false, listeners: {},
        classList: { add(name) { this[name] = true; }, remove(name) { this[name] = false; }, toggle(name, force) { this[name] = force; } },
        addEventListener(type, callback) { this.listeners[type] = callback; } });
    }
  }
  const picker = nodes.get('#memoryRecallAgent');
  Object.defineProperty(picker, 'innerHTML', { set(value) { this.value = value.match(/value="([^"]+)"/)?.[1] || ''; } });
  const context = { window: {}, Intl, Date, URLSearchParams, clearTimeout, setTimeout };
  vm.runInNewContext(source, context);
  const api = context.window.HexiGridViewRenderers.createMemoryRecall({ root: { querySelector: (id) => nodes.get(id) }, request,
    agents: () => [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }], openProfile() {}, ask });
  return { nodes, picker, api };
}

test('owner checkpoint controls load for agent facts and require a fresh-head confirmation before restore', async () => {
  const calls = [];
  let dialog;
  const checkpoint = { id: 'memory-checkpoint-11111111-1111-4111-8111-111111111111', label: 'Before cleanup', sequence: 4, available: true };
  const head = { format: 'hexigrid-memory-checkpoint-v1', lineageId: 'lineage-11111111-1111-4111-8111-111111111111', sequence: 9, hash: 'a'.repeat(64) };
  const ui = reader(async (url, options) => {
    calls.push({ url, options: options && JSON.parse(options.body) });
    if (url.includes('/memory-rollback-checkpoints')) return { current: head, checkpoints: [checkpoint], restored: true, changedRecords: 2 };
    return { facts: [] };
  }, async options => { dialog = options; return true; }, { rollback: true });
  ui.nodes.get('#memoryRecallStore').value = 'facts';
  await ui.api.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(call => call.url === '/api/agents/first/memory-rollback-checkpoints'));
  assert.match(ui.nodes.get('#memoryRollbackList').innerHTML, /Before cleanup/);

  const button = { dataset: { memoryCheckpointRestore: checkpoint.id } };
  await ui.nodes.get('#memoryRollbackList').listeners.click({ target: { closest: selector => selector === '[data-memory-checkpoint-restore]' ? button : null } });
  assert.equal(dialog.title, 'Restore this memory checkpoint?');
  assert.match(dialog.message, /rejected facts stay rejected/);
  const restore = calls.find(call => call.url.endsWith(`/${checkpoint.id}/restore`));
  assert.deepEqual(restore.options, { approved: true, expectedCurrent: head, why: 'Owner restored a saved memory checkpoint.' });
  assert.match(ui.nodes.get('#memoryRollbackStatus').textContent, /restored with 2 history-preserving revisions/i);
  ui.nodes.get('#memoryRecallStore').value = 'notes';
  await ui.api.refresh();
  assert.equal(ui.nodes.get('#memoryRollbackPanel').classList.hidden, true, 'checkpoint control is hidden outside agent facts');
});

function clickReconfirm(ui, id = 'stale-owner-note') {
  const button = { disabled: false, dataset: { ownerMemoryReconfirm: id } };
  const event = { target: { closest: selector => selector === '[data-owner-memory-reconfirm]' ? button : null } };
  return ui.nodes.get('#memoryRecallList').listeners.click(event);
}

function staleOwnerNote(overrides = {}) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return { id: 'stale-owner-note', agentId: 'first', category: 'Temporary', content: 'The bridge uses port 4318.',
    status: 'active', verification: 'owner-confirmed', stale: true, verify_by: yesterday,
    valid_while: 'The local bridge is installed', source: 'owner', evidence_excerpt: 'Checked in local settings', ...overrides };
}

test('out-of-order agent reads cannot replace the newly selected identity or its notes', async () => {
  const pending = [];
  const ui = reader((url) => new Promise((resolve) => pending.push({ url, resolve })));
  const first = ui.api.refresh();
  ui.picker.value = 'second';
  const second = ui.api.refresh();
  pending[1].resolve({ memories: [{ id: 'second-note', content: 'Second fact', status: 'active' }] });
  await second;
  pending[0].resolve({ memories: [{ id: 'first-note', content: 'First fact', status: 'active' }] });
  await first;
  assert.equal(ui.picker.value, 'second');
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Second fact/);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /First fact/);
  assert.equal(ui.nodes.get('#memoryRecallRefresh').disabled, false);
});

test('detail requests use the depth contract and retrieved markup is escaped', async () => {
  const urls = [];
  const ui = reader(async (url) => { urls.push(url); return { memories: [{ id: 'note', content: '<img onerror="run()">', status: 'conditional', valid_while: 'Owner says <yes>', revisions: [], evidence_excerpt: 'Only when requested' }] }; });
  await ui.api.refresh();
  assert.match(urls[0], /\/first\/memories\?depth=0$/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /&lt;img/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Valid while/);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /Only when requested/);
  ui.nodes.get('#memoryRecallDepth').value = '2';
  await ui.api.refresh();
  assert.match(urls[1], /depth=2$/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Source evidence/);
  ui.nodes.get('#memoryRecallQuery').value = 'nothing matches';
  ui.nodes.get('#memoryRecallQuery').listeners.input();
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /No matching owner notes/);
});

test('failed reads clear old content and permit an explicit retry', async () => {
  let fail = false;
  const ui = reader(async () => { if (fail) throw new Error('Service unavailable'); return { memories: [{ id: 'note', content: 'Old fact', status: 'active' }] }; });
  await ui.api.refresh();
  fail = true;
  await ui.api.refresh();
  assert.equal(ui.nodes.get('#memoryRecallList').innerHTML, '');
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Service unavailable.*Refresh to retry/);
  assert.equal(ui.nodes.get('#memoryRecallRefresh').disabled, false);
  fail = false;
  await ui.api.refresh();
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Old fact/);
});

test('category-only stale recall is visible without inventing a date or changing standing', async () => {
  const ui = reader(async () => ({ memories: [
    { id: 'expired', content: 'Old temporary route', category: 'Temporary', status: 'active', stale: true },
    { id: 'fresh', content: 'Current route', category: 'General', status: 'active' },
    { id: 'deadline', content: 'Deadline route', status: 'active', stale: true, verify_by: '2026-01-01' }
  ] }));
  await ui.api.refresh();
  const html = ui.nodes.get('#memoryRecallList').innerHTML;
  assert.equal((html.match(/Category lifetime passed/g) || []).length, 1);
  assert.match(html, /Recheck needed/);
  assert.match(html, /Recheck by.*2026-01-01/);
  assert.equal((html.match(/Re-verify before acting/g) || []).length, 1);
  assert.doesNotMatch(html, /superseded|rejected/);
});

test('only current stale confirmed owner notes expose recheck when the owner action is available', async () => {
  const memories = [
    staleOwnerNote(),
    staleOwnerNote({ id: 'unverified', verification: 'unverified' }),
    staleOwnerNote({ id: 'fresh', stale: false, verify_by: '2999-01-01' }),
    staleOwnerNote({ id: 'retired', status: 'historical' })
  ];
  const ui = reader(async url => url.includes('/memories?') ? { memories } : { facts: [], skills: [] }, async () => null);
  await ui.api.refresh();
  const ownerHtml = ui.nodes.get('#memoryRecallList').innerHTML;
  assert.equal((ownerHtml.match(/data-owner-memory-reconfirm=/g) || []).length, 1);
  assert.match(ownerHtml, /data-owner-memory-reconfirm="stale-owner-note"/);
  ui.nodes.get('#memoryRecallStore').value = 'facts';
  await ui.api.refresh();
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /data-owner-memory-reconfirm/);
  ui.nodes.get('#memoryRecallStore').value = 'skills';
  await ui.api.refresh();
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /data-owner-memory-reconfirm/);
  const noOwnerAction = reader(async () => ({ memories: [staleOwnerNote()] }));
  await noOwnerAction.api.refresh();
  assert.doesNotMatch(noOwnerAction.nodes.get('#memoryRecallList').innerHTML, /data-owner-memory-reconfirm/);
});

test('owner recheck loads depth-two current detail and submits the full revision count', async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const listed = staleOwnerNote({ verify_by: yesterday });
  const detail = { ...listed, revision_count: 137, revisions: [{}, {}], revisions_truncated: true };
  const urls = [], writes = [];
  let confirmed = false, dialog;
  const ui = reader(async (url, options) => {
    urls.push(url);
    if (options) {
      writes.push({ url, body: JSON.parse(options.body) });
      confirmed = true;
      return { memory: { ...detail, verify_by: future, verification: 'owner-confirmed' } };
    }
    if (url.endsWith('/memories?depth=2')) return { memories: [detail] };
    return { memories: [confirmed ? { ...listed, verify_by: future, stale: false } : listed] };
  }, async options => {
    dialog = options;
    return [detail.content, detail.source, detail.valid_while, detail.evidence_excerpt, yesterday, future, 'Owner rechecked the local settings.'];
  });
  await ui.api.refresh();
  await clickReconfirm(ui);
  assert.match(urls[1], /\/api\/agents\/first\/memories\?depth=2$/);
  assert.equal(dialog.title, 'Recheck this owner note?');
  assert.deepEqual(Array.from(dialog.fields.slice(0, 5), field => field.value), [detail.content, detail.source, detail.valid_while, detail.evidence_excerpt, yesterday]);
  assert.ok(dialog.fields.slice(0, 5).every(field => field.readonly));
  assert.equal(dialog.fields[5].type, 'date');
  assert.equal(dialog.fields[5].required, true);
  assert.equal(dialog.fields[6].required, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, `/api/memories/${detail.id}/confirm`);
  assert.deepEqual(writes[0].body, { expectedRevision: 137, why: 'Owner rechecked the local settings.', approved: true, nextVerifyBy: future });
  assert.ok(urls.some(url => url.endsWith('/memories?depth=0')), 'refreshes the owner note list after commit');
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /rechecked and confirmed/);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /data-owner-memory-reconfirm/);
});

test('canceling owner recheck leaves the stale warning and sends no mutation', async () => {
  const detail = { ...staleOwnerNote(), revision_count: 4, revisions: [] };
  const writes = [];
  const ui = reader(async (url, options) => {
    if (options) writes.push(url);
    return { memories: [detail] };
  }, async () => null);
  await ui.api.refresh();
  await clickReconfirm(ui);
  assert.deepEqual(writes, []);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Re-verify before acting/);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /canceled.*marked stale/i);
});

test('invalid dates and denied owner rechecks keep the stale warning without success text', async () => {
  const detail = { ...staleOwnerNote(), revision_count: 8, revisions: [] };
  let answer = [detail.content, detail.source, detail.valid_while, detail.evidence_excerpt, detail.verify_by, '2099-02-30', 'Owner checked the source.'];
  const writes = [];
  const ui = reader(async (url, options) => {
    if (options) { writes.push(url); throw new Error('Plan mode denied'); }
    return { memories: [detail] };
  }, async () => answer);
  await ui.api.refresh();
  await clickReconfirm(ui);
  assert.deepEqual(writes, [], 'invalid calendar dates are rejected before POST');
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /valid future calendar date/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Re-verify before acting/);
  answer = [detail.content, detail.source, detail.valid_while, detail.evidence_excerpt, detail.verify_by,
    new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), 'Owner checked the source.'];
  await clickReconfirm(ui);
  assert.equal(writes.length, 1);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Plan mode denied.*keep treating the note as stale/i);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallStatus').textContent, /rechecked and confirmed/i);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Re-verify before acting/);
});

test('late owner detail cannot open confirmation or commit after agent/store changes', async () => {
  for (const switchView of ['agent', 'store']) {
    let finishDetail, asks = 0, writes = 0;
    const ui = reader(async url => {
      if (url.endsWith('/memories?depth=2')) return new Promise(resolve => { finishDetail = resolve; });
      if (url.includes('/memory-facts?')) return { facts: [] };
      return { memories: [staleOwnerNote({ ...(url.includes('/second/') ? { id: 'second-note', agentId: 'second' } : {}) })] };
    }, async () => { asks += 1; return []; });
    await ui.api.refresh();
    const pendingAction = clickReconfirm(ui);
    if (switchView === 'agent') ui.picker.value = 'second';
    else ui.nodes.get('#memoryRecallStore').value = 'facts';
    await ui.api.refresh();
    finishDetail({ memories: [{ ...staleOwnerNote(), revision_count: 1 }] });
    await pendingAction;
    assert.equal(asks, 0, `${switchView} change prevents a confirmation dialog`);
    assert.equal(writes, 0, `${switchView} change prevents a write`);
  }
});

test('dated fact paging preserves query and depth, deduplicates IDs and resets on a fresh read', async () => {
  const urls = [];
  const ui = reader(async url => {
    urls.push(url);
    return url.includes('after=')
      ? { facts: [{ id: 'one', text: 'First fact', status: 'active' }, { id: 'two', text: 'Second fact', status: 'conditional' }], total: 2, nextCursor: null }
      : { facts: [{ id: 'one', text: 'First fact', status: 'active' }], total: 2, nextCursor: 'one' };
  });
  ui.nodes.get('#memoryRecallStore').value = 'facts';
  ui.nodes.get('#memoryRecallStanding').value = 'current';
  ui.nodes.get('#memoryRecallQuery').value = 'fact & condition';
  ui.nodes.get('#memoryRecallDepth').value = '2';
  await ui.api.refresh();
  await ui.api.refresh({ more: true });
  const next = new URL(urls[1], 'http://localhost');
  assert.equal(next.pathname, '/api/agents/first/memory-facts');
  assert.equal(next.searchParams.get('query'), 'fact & condition');
  assert.equal(next.searchParams.get('depth'), '2');
  assert.equal(next.searchParams.get('after'), 'one');
  assert.equal((ui.nodes.get('#memoryRecallList').innerHTML.match(/First fact/g) || []).length, 1);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Showing 2 of 2 matching dated facts/);
  await ui.api.refresh();
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /Second fact/);
});

test('skills show exact procedures and bounded version history without treating them as facts', async () => {
  const urls = [];
  const skillId = 'agent-skill-11111111-1111-4111-8111-111111111111';
  const skill = { id: skillId, name: 'Disposable QA skill', procedure: '<unsafe markup>', whenToUse: 'QA only', successCheck: 'No side effects', status: 'active', revision: 2 };
  const ui = reader(async url => {
    urls.push(url);
    if (url.includes(`/${skillId}?`)) return { skill, revisions: [{ ...skill, revision: url.includes('beforeRevision') ? 1 : 2, why: 'Corrected from evidence', by: 'owner:qa' }], nextBeforeRevision: url.includes('beforeRevision') ? null : 2 };
    return { skills: [skill], nextCursor: null };
  });
  ui.nodes.get('#memoryRecallStore').value = 'skills';
  ui.nodes.get('#memoryRecallStanding').value = 'active';
  await ui.api.refresh();
  assert.match(urls[0], /\/skills\?limit=20&includeRetired=0$/);
  const list = ui.nodes.get('#memoryRecallList');
  assert.match(list.innerHTML, /version 2/);
  assert.match(list.innerHTML, /&lt;unsafe markup&gt;/);
  assert.doesNotMatch(list.innerHTML, /Unverified|Owner-confirmed/);
  list.querySelector = () => ({ textContent: '' });
  const button = { disabled: false, dataset: { skillHistory: skillId } };
  await list.listeners.click({ target: { closest: selector => selector === '[data-skill-history]' ? button : null } });
  assert.match(list.innerHTML, /Corrected from evidence/);
  assert.match(list.innerHTML, /Load older versions/);
  assert.match(urls[1], /depth=1&limit=5$/);
  const older = { disabled: false, dataset: { skillHistory: skillId, beforeRevision: '2' } };
  await list.listeners.click({ target: { closest: selector => selector === '[data-skill-history]' ? older : null } });
  assert.match(list.innerHTML, /Version history \(2 loaded\)/);
  assert.doesNotMatch(list.innerHTML, /Load older versions/);
});

test('a late skill history response cannot reappear after switching agents', async () => {
  let completeHistory;
  const ui = reader(url => url.includes('/skills/skill-one?') ? new Promise(resolve => { completeHistory = resolve; }) : Promise.resolve({ skills: [{ id: 'skill-one', name: 'First skill', procedure: 'Safe', status: 'active', revision: 1 }] }));
  ui.nodes.get('#memoryRecallStore').value = 'skills';
  ui.nodes.get('#memoryRecallStanding').value = 'active';
  await ui.api.refresh();
  const list = ui.nodes.get('#memoryRecallList');
  list.querySelector = () => ({ textContent: '' });
  const history = list.listeners.click({ target: { closest: selector => selector === '[data-skill-history]' ? ({ disabled: false, dataset: { skillHistory: 'skill-one' } }) : null } });
  ui.picker.value = 'second';
  await ui.api.refresh();
  completeHistory({ revisions: [{ revision: 1, why: 'Late private history' }] });
  await history;
  assert.equal(ui.picker.value, 'second');
  assert.doesNotMatch(list.innerHTML, /Late private history/);
});

test('history refresh updates current skill after an agent revision instead of displaying stale text', async () => {
  const original = { id: 'skill-one', name: 'QA', procedure: 'Old procedure', status: 'active', revision: 1 };
  const current = { ...original, procedure: 'Agent corrected procedure', revision: 2 };
  const ui = reader(async url => url.includes('/skills/skill-one?')
    ? { skill: current, revisions: [{ ...current, why: 'Observed correction', by: 'agent-link:qa' }], nextBeforeRevision: null }
    : { skills: [original] });
  ui.nodes.get('#memoryRecallStore').value = 'skills';
  ui.nodes.get('#memoryRecallStanding').value = 'active';
  await ui.api.refresh();
  const list = ui.nodes.get('#memoryRecallList');
  list.querySelector = () => ({ textContent: '' });
  await list.listeners.click({ target: { closest: selector => selector === '[data-skill-history]'
    ? { disabled: false, dataset: { skillHistory: 'skill-one' } } : null } });
  assert.match(list.innerHTML, /version 2/);
  assert.match(list.innerHTML, /Agent corrected procedure/);
  assert.doesNotMatch(list.innerHTML, /Old procedure/);
});

test('skill edits preserve expected revision and exact reason, while a canceled dialog writes nothing', async () => {
  const writes = [];
  const skill = { id: 'qa-skill', name: 'QA', procedure: 'Read', whenToUse: 'QA only', successCheck: 'No effects', status: 'active', revision: 7 };
  let answer = null;
  const ui = reader(async (url, options) => {
    if (options) writes.push({ url, body: JSON.parse(options.body) });
    return { skills: [skill] };
  }, async () => answer);
  ui.nodes.get('#memoryRecallStore').value = 'skills';
  ui.nodes.get('#memoryRecallStanding').value = 'active';
  await ui.api.refresh();
  const list = ui.nodes.get('#memoryRecallList');
  const event = { target: { closest: selector => selector.includes('data-skill-edit') ? { dataset: { skillEdit: 'qa-skill' } } : null } };
  await list.listeners.click(event);
  assert.equal(writes.length, 0);
  answer = ['QA', 'QA only', 'Read the version', 'No effects', 'Observed QA correction'];
  await list.listeners.click(event);
  assert.equal(writes[0].body.expectedRevision, 7);
  assert.equal(writes[0].body.why, 'Observed QA correction');
  assert.equal(writes[0].body.changes.procedure, 'Read the version');
  assert.equal(writes[0].body.approved, true);
});

test('a denied skill save retains its draft for the same agent without claiming success', async () => {
  const dialogs = [];
  const ui = reader(async (url, options) => { if (options) throw new Error('Build mode required'); return { skills: [] }; }, async options => {
    dialogs.push(options);
    return dialogs.length === 1 ? ['Disposable QA', 'QA only', 'Read only', 'No effects', 'QA reason'] : null;
  });
  ui.nodes.get('#memoryRecallStore').value = 'skills';
  await ui.api.refresh();
  ui.nodes.get('#memoryRecallCreateSkill').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Skill was not saved: Build mode required/);
  ui.nodes.get('#memoryRecallCreateSkill').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialogs[1].fields[0].value, 'Disposable QA');
  assert.equal(dialogs[1].fields[4].value, 'QA reason');
});


function clickRetire(ui,id='stale-owner-note') {
  const button={disabled:false,dataset:{ownerMemoryRetire:id}};
  return ui.nodes.get('#memoryRecallList').listeners.click({target:{closest: selector=>selector==='[data-owner-memory-retire]'?button:null}});
}
test('owner note retirement rechecks exact detail and commits its full current revision',async()=>{
  const calls=[],note=staleOwnerNote({updatedAt:'2026-10-04T12:00:00Z'});let retired=false;
  const ui=reader(async(url,options)=>{
    calls.push({url,options});
    if(options?.method==='DELETE'){retired=true;return{memory:{...note,status:'historical'}};}
    return{memories:retired?[]:[{...note,revision_count:125}]};
  },async form=>{assert.match(form.message,/history stays local/i);assert.equal(form.fields[0].value,note.content);return['reviewed'];});
  await ui.api.refresh();assert.match(ui.nodes.get('#memoryRecallList').innerHTML,/Retire note/);
  await clickRetire(ui);
  const write=calls.find(call=>call.options?.method==='DELETE');
  assert.equal(write.url,'/api/memories/stale-owner-note');assert.equal(JSON.parse(write.options.body).expectedRevision,125);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML,/The bridge uses/);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent,/Note retired.*history remains/);
});
test('canceled or changed owner notes cannot be retired from an old view',async()=>{
  for(const changed of [false,true]){
    let reads=0,asked=0,writes=0;const note=staleOwnerNote();
    const ui=reader(async(url,options)=>{if(options){writes++;return{};}reads++;return{memories:[{...note,revision_count:3,...(changed&&reads>1?{content:'different current note'}:{})}]};},async()=>{asked++;return null;});
    await ui.api.refresh();await clickRetire(ui);assert.equal(writes,0);assert.equal(asked,changed?0:1);
    assert.match(ui.nodes.get('#memoryRecallStatus').textContent,changed?/changed.*Refresh/:/canceled.*unchanged/);
  }
});
test('owner retirement respects agent changes during confirmation and denied commits',async()=>{
  for(const changeAgent of [false,true]){
    let writes=0;const note=staleOwnerNote();let ui;
    ui=reader(async(url,options)=>{if(options){writes++;throw Error('revision conflict');}return{memories:[{...note,revision_count:4}]};},async()=>{if(changeAgent)ui.picker.value='second';return['reviewed'];});
    await ui.api.refresh();await clickRetire(ui);assert.equal(writes,changeAgent?0:1);
    assert.doesNotMatch(ui.nodes.get('#memoryRecallStatus').textContent,/Note retired/);
    if(!changeAgent)assert.match(ui.nodes.get('#memoryRecallStatus').textContent,/revision conflict.*Refresh/);
  }
});


test('inactive owner index is explicit metadata, with no false history or retire action',async()=>{
 const calls=[];
 const ui=reader(async url=>{calls.push(url);return{memories:[{id:'retired-id',agentId:'first',status:'historical',category:'QA',inactiveIndex:true,revision_count:7},{id:'active-secret',status:'active',content:'blue active private text'}],total:101,truncated:true};},async()=>null);
 ui.nodes.get('#memoryRecallStanding').value='inactive';
 ui.nodes.get('#memoryRecallDepth').value='2';
 ui.nodes.get('#memoryRecallQuery').value='blue';
 await ui.api.refresh();
 assert.match(calls[0],/standing=inactive/);assert.match(calls[0],/query=blue/);
 const html=ui.nodes.get('#memoryRecallList').innerHTML;
 assert.match(html,/retired-id/);assert.match(html,/Historical context/);
 assert.doesNotMatch(html,/data-owner-memory-retire|Revision history|No revisions recorded|Unverified|active-secret|blue active private text/);
 assert.match(html,/historical.*revision 7/);
 assert.equal(ui.nodes.get('#memoryRecallDepth').disabled,true);
 assert.match(ui.nodes.get('#memoryRecallStatus').textContent,/narrow the search/);
});
