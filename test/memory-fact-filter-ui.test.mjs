import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const rendererSource = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');

function makeNode(value = '', registry = null) {
  const listeners = new Map();
  const classes = new Set();
  let html = '';
  return {
    value, textContent: '', disabled: false, dataset: {}, children: [], listeners,
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); },
      contains(name) { return classes.has(name); }
    },
    get innerHTML() { return html; },
    set innerHTML(markup) {
      html = markup;
      if (this.id === 'memoryRecallAgent') {
        const values = [...markup.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]);
        if (!values.includes(this.value)) this.value = values[0] || '';
      }
    },
    addEventListener(type, callback) { listeners.set(type, callback); },
    appendChild(child) { this.children.push(child); if (child.id) registry?.set(`#${child.id}`, child); },
    replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); },
    setAttribute(name, selected) { if (name === 'id') { this.id = selected; registry?.set(`#${selected}`, this); } },
    closest() { return null; }
  };
}

function createUi({ request, agents = [{ id: 'agent-one', name: 'First agent' }], ask = async () => null, health = false }) {
  const nodes = new Map();
  for (const [name, value] of Object.entries({
    Agent: '', Status: '', List: '', Query: '', Standing: 'current', Depth: '0',
    Refresh: '', More: '', Profile: '', Store: 'facts', CreateSkill: ''
  })) {
    const node = makeNode(value, nodes);
    node.id = `memoryRecall${name}`;
    nodes.set(`#memoryRecall${name}`, node);
  }
  nodes.set('.memory-recall-meta', makeNode('', nodes));
  nodes.set('.memory-recall-controls', makeNode('', nodes));
  if (health) for (const name of ['Status', 'Issues', 'Check', 'More']) nodes.set(`#memoryHealth${name}`, makeNode('', nodes));
  const root = {
    querySelector: selector => nodes.get(selector),
    ownerDocument: { createElement: () => makeNode('', nodes) }
  };
  const context = { window: {}, Intl, Date, TextEncoder, URLSearchParams, clearTimeout, setTimeout };
  vm.runInNewContext(rendererSource, context);
  const api = context.window.HexiGridViewRenderers.createMemoryRecall({
    root, request, agents: () => agents, label: agent => agent.name,
    openProfile() {}, ask
  });
  return { api, nodes, agents };
}

const scopedValue = JSON.stringify({ projectId: 'studio', topicId: 'design' });
const facets = {
  categories: ['Location', 'Operations', 'Remote-only category'],
  scopes: [
    { value: '__unscoped__', label: 'Unscoped' },
    { value: scopedValue, label: 'studio / design' },
    { value: JSON.stringify({ projectId: 'another-project', topicId: '' }), label: 'another-project' }
  ]
};

function fact(id, text, category = 'Location', contextScope = { projectId: 'studio', topicId: 'design' }, status = 'active') {
  return { id, text, status, metadata: { category }, contextScope, verification: 'unverified', originKind: 'owner-entry' };
}

function pastMistake({ status = 'historical', revision = 4, depth = 0 } = {}) {
  const memoryId = 'memory-11111111-1111-4111-8111-111111111111';
  const scope = { projectId: 'studio', topicId: 'design' };
  const record = {
    format: 'hexigrid-memory-mistake', version: 1,
    id: 'mistake-11111111-1111-4111-8111-111111111111',
    lineageId: 'lineage-agent-one', agentId: 'agent-one', contextScope: scope,
    author: { kind: 'agent', id: 'agent-one' }, createdAt: '2026-10-01T10:00:00.000Z',
    whatWentWrong: 'I used a stale build result.', correction: 'Rebuild after the source change.',
    resultingFix: 'The current build now includes the source change.',
    evidence: { kind: 'agent-link-message', id: 'link-message-synthetic-evidence', observedAt: '2026-10-01T09:30:00.000Z', excerpt: 'Synthetic verified source excerpt.' },
    recurrenceOf: []
  };
  return {
    id: memoryId, text: 'Past mistake: I used a stale build result.', status, revision,
    lineageId: record.lineageId, agentId: record.agentId, contextScope: scope,
    metadata: { memoryMistake: { format: 'hexigrid-memory-mistake', version: 1, record } },
    evidence_excerpt: depth >= 2 ? record.evidence.excerpt : '',
    revision_count: status === 'rejected' ? 1 : 0,
    revisions: status === 'rejected' ? [{ revision: 5, at: '2026-10-02T10:00:00.000Z', by: 'owner:qa', why: 'Reject synthetic mistake', changes: { status: { from: 'historical', to: 'rejected' } } }] : []
  };
}

async function settleRefresh() { await new Promise(resolve => setImmediate(resolve)); }

test('memory health opens an exact fact with other-store controls and filters reset', async () => {
  const urls = [], memoryId = 'memory-11111111-1111-4111-8111-111111111111';
  const ui = createUi({ health: true, request: async url => {
    urls.push(url);
    if (url.includes('/memory-health')) return { scanned: 1, total: 1, anchors: { status: 'not-configured' }, issues: [{ memoryId, reasons: ['stale'] }] };
    return { facts: [], skills: [], total: 0, facets };
  } });
  await ui.api.refresh();
  ui.nodes.get('#memoryRecallStore').value = 'skills';
  ui.nodes.get('#memoryRecallStore').listeners.get('change')();
  await settleRefresh();
  ui.nodes.get('#memoryRecallKind').value = 'mistakes';
  ui.nodes.get('#memoryRecallCategory').value = 'Location';
  ui.nodes.get('#memoryRecallScope').value = scopedValue;
  ui.nodes.get('#memoryHealthCheck').listeners.get('click')();
  await settleRefresh();
  assert.match(ui.nodes.get('#memoryHealthIssues').innerHTML, /Recheck date passed/);
  ui.nodes.get('#memoryHealthIssues').listeners.get('click')({ target: { closest: () => ({ dataset: { memoryHealthId: memoryId, memoryHealthStore: 'facts' } }) } });
  await settleRefresh();
  const selected = new URL(urls.at(-1), 'http://localhost');
  assert.match(selected.pathname, /memory-facts$/);
  assert.equal(selected.searchParams.get('query'), memoryId);
  assert.equal(selected.searchParams.get('standing'), 'all');
  assert.equal(selected.searchParams.get('kind'), 'all');
  assert.equal(selected.searchParams.has('category'), false);
  assert.equal(selected.searchParams.has('scope'), false);
  assert.equal(ui.nodes.get('#memoryRecallDepth').disabled, false);
});

test('memory health opens a flagged owner note in the notes store', async () => {
  const urls = [], memoryId = 'memory-22222222-2222-4222-8222-222222222222';
  const ui = createUi({ health: true, request: async url => {
    urls.push(url);
    if (url.includes('/memory-health')) return { scanned: 1, total: 1, anchors: { status: 'not-configured' },
      issues: [{ memoryId, store: 'notes', reasons: ['invalid-provenance'] }] };
    return { facts: [], memories: [], skills: [], total: 0, facets };
  } });
  await ui.api.refresh();
  ui.nodes.get('#memoryHealthCheck').listeners.get('click')();
  await settleRefresh();
  assert.match(ui.nodes.get('#memoryHealthIssues').innerHTML, /Review note/);
  ui.nodes.get('#memoryHealthIssues').listeners.get('click')({ target: { closest: () => ({ dataset: {
    memoryHealthId: memoryId, memoryHealthStore: 'notes' } }) } });
  await settleRefresh();
  assert.equal(ui.nodes.get('#memoryRecallStore').value, 'notes');
  assert.match(new URL(urls.at(-1), 'http://localhost').pathname, /\/memories$/);
});

test('memory health does not display late results after switching agents, and failed reads can retry', async () => {
  let release, fail = false;
  const agents = [{ id: 'agent-one', name: 'First' }, { id: 'agent-two', name: 'Second' }];
  const ui = createUi({ health: true, agents, request: async url => {
    if (url.includes('/agent-one/memory-health')) return new Promise(resolve => { release = resolve; });
    if (url.includes('/memory-health')) {
      if (fail) throw new Error('unavailable');
      return { scanned: 0, total: 0, issues: [] };
    }
    return { facts: [], total: 0, facets };
  } });
  await ui.api.refresh();
  ui.nodes.get('#memoryHealthCheck').listeners.get('click')();
  ui.nodes.get('#memoryRecallAgent').value = 'agent-two';
  await ui.api.refresh();
  release({ scanned: 99, total: 99, issues: [] });
  await settleRefresh();
  assert.doesNotMatch(ui.nodes.get('#memoryHealthStatus').textContent, /99/);
  fail = true;
  ui.nodes.get('#memoryHealthCheck').listeners.get('click')();
  await settleRefresh();
  assert.match(ui.nodes.get('#memoryHealthStatus').textContent, /preserved/);
  assert.equal(ui.nodes.get('#memoryHealthCheck').disabled, false);
  fail = false;
  ui.nodes.get('#memoryHealthCheck').listeners.get('click')();
  await settleRefresh();
  assert.match(ui.nodes.get('#memoryHealthStatus').textContent, /0 of 0/);
});

test('memory empty states give actions for the selected store and record kind', async () => {
  let ownerNotes = [];
  const ui = createUi({ request: async url => {
    const route = new URL(url, 'http://localhost').pathname;
    if (route.endsWith('/memories')) return { memories: ownerNotes };
    if (route.endsWith('/skills')) return { skills: [] };
    return { facts: [], total: 0, nextCursor: null, disputedCount: 0, facets };
  } });
  const list = ui.nodes.get('#memoryRecallList');
  await ui.api.refresh();
  assert.match(list.innerHTML, /No matching dated facts/);
  assert.match(list.innerHTML, /search, agent, category, scope or standing/);
  assert.match(list.innerHTML, /change Record kind/);

  const kind = ui.nodes.get('#memoryRecallKind');
  kind.value = 'mistakes';
  kind.listeners.get('change')();
  await settleRefresh();
  assert.match(list.innerHTML, /No matching past mistakes/);
  assert.match(list.innerHTML, /choose All facts in Record kind/);
  assert.doesNotMatch(list.innerHTML, /This view does not include agent skills/);

  const store = ui.nodes.get('#memoryRecallStore');
  store.value = 'notes';
  store.listeners.get('change')();
  await settleRefresh();
  assert.match(list.innerHTML, /No owner notes for this agent and standing/);
  assert.match(list.innerHTML, /another agent or standing/);
  assert.match(list.innerHTML, /switch Store to browse facts or learned skills/);

  ownerNotes = [{ id: 'note-1', content: 'A greenhouse preference', category: 'General', status: 'active' }];
  ui.nodes.get('#memoryRecallQuery').value = 'unmatched phrase';
  await ui.api.refresh();
  assert.match(list.innerHTML, /No matching owner notes/);
  assert.match(list.innerHTML, /another search, agent or standing/);

  store.value = 'skills';
  store.listeners.get('change')();
  await settleRefresh();
  ui.nodes.get('#memoryRecallQuery').value = 'unmatched procedure';
  ui.nodes.get('#memoryRecallQuery').listeners.get('input')();
  assert.match(list.innerHTML, /No matching agent skills/);
  assert.match(list.innerHTML, /another search, agent or standing, or choose another Store/);
});

test('category and scope filters use server facets and refresh the matching page from the backend', async () => {
  const urls = [];
  const ui = createUi({ request: async url => {
    urls.push(url);
    const parsed = new URL(url, 'http://localhost');
    if (parsed.searchParams.get('category') === 'Operations' && parsed.searchParams.get('scope') === scopedValue) {
      return { facts: [fact('memory-server-filtered', 'Server-selected result', 'Operations')], total: 17,
        nextCursor: 'next-page', disputedCount: 3, facets: { ...facets, truncated: { categories: false, scopes: true } } };
    }
    return { facts: [fact('memory-first-page', 'First server result')], total: 82,
      nextCursor: 'first-next', disputedCount: 3, facets: { ...facets, truncated: { categories: true, scopes: false } } };
  } });

  ui.nodes.get('#memoryRecallQuery').value = 'an owner alias';
  await ui.api.refresh();
  const category = ui.nodes.get('#memoryRecallCategory');
  const scope = ui.nodes.get('#memoryRecallScope');
  assert.deepEqual(category.children.map(option => option.value), ['', ...facets.categories]);
  assert.deepEqual(scope.children.map(option => option.value), ['', ...facets.scopes.map(item => item.value)]);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Showing 1 of 82 matching dated facts/);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Load more results/);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Some categories are omitted/);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallStatus').textContent, /Some scopes are omitted/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /First server result/);
  assert.equal(new URL(urls[0], 'http://localhost').searchParams.get('query'), 'an owner alias');

  category.value = 'Operations';
  category.listeners.get('change')();
  await settleRefresh();
  scope.value = scopedValue;
  scope.listeners.get('change')();
  await settleRefresh();

  const selected = new URL(urls.at(-1), 'http://localhost');
  assert.equal(selected.searchParams.get('category'), 'Operations');
  assert.equal(selected.searchParams.get('scope'), scopedValue);
  assert.equal(selected.searchParams.has('after'), false, 'changing a filter requests page one');
  assert.equal(selected.searchParams.get('limit'), '30');
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Server-selected result/);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /First server result/);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Showing 1 of 17 matching dated facts/);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Some scopes are omitted/);

  ui.nodes.get('#memoryRecallMore').listeners.get('click')();
  await settleRefresh();
  const nextPage = new URL(urls.at(-1), 'http://localhost');
  assert.equal(nextPage.searchParams.get('category'), 'Operations');
  assert.equal(nextPage.searchParams.get('scope'), scopedValue);
  assert.equal(nextPage.searchParams.get('after'), 'next-page');
});

test('fact category labels use only bounded nonempty string metadata', async () => {
  const ui = createUi({ request: async () => ({ facts: [
    { ...fact('memory-object-category', 'Object category'), metadata: { category: { label: 'Unsupported' } } },
    fact('memory-long-category', 'Oversized category', '界'.repeat(54)),
    fact('memory-valid-category', 'Valid category', 'Research')
  ], total: 3, disputedCount: 0, facets }) });
  await ui.api.refresh();
  const rendered = ui.nodes.get('#memoryRecallList').innerHTML;
  assert.match(rendered, /<strong>General<\/strong>/);
  assert.equal((rendered.match(/<strong>General<\/strong>/g) || []).length, 2);
  assert.match(rendered, /<strong>Research<\/strong>/);
  assert.doesNotMatch(rendered, /Unsupported|界{54}/);
});

test('Review disputed applies the disputed standing through the same server list', async () => {
  const urls = [];
  const ui = createUi({ request: async url => {
    urls.push(url);
    const parsed = new URL(url, 'http://localhost');
    if (parsed.searchParams.get('standing') === 'disputed') {
      return { facts: [fact('memory-disputed', 'A disputed fact', 'Location', null, 'disputed')], total: 1,
        nextCursor: null, disputedCount: 4, facets };
    }
    return { facts: [fact('memory-current', 'Current fact')], total: 22,
      nextCursor: 'next-page', disputedCount: 4, facets };
  } });
  await ui.api.refresh();

  const category = ui.nodes.get('#memoryRecallCategory');
  const scope = ui.nodes.get('#memoryRecallScope');
  category.value = 'Location';
  scope.value = scopedValue;
  ui.nodes.get('#memoryRecallQuery').value = 'old query';
  const review = ui.nodes.get('#memoryRecallReviewDisputed');
  assert.equal(review.textContent, 'Review disputed (4)');
  assert.equal(review.classList.contains('hidden'), false);
  review.listeners.get('click')();
  await settleRefresh();

  const selected = new URL(urls.at(-1), 'http://localhost');
  assert.equal(selected.searchParams.get('standing'), 'disputed');
  assert.equal(selected.searchParams.get('query'), '');
  assert.equal(selected.searchParams.has('category'), false);
  assert.equal(selected.searchParams.has('scope'), false);
  assert.equal(selected.searchParams.has('after'), false);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /A disputed fact/);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Showing 1 of 1 matching dated facts/);
});

test('past-mistake filter requests all standings, renders canonical provenance, and reuses expected-revision rejection', async () => {
  const urls = [];
  const writes = [];
  let current = pastMistake();
  const ui = createUi({ ask: async options => {
    assert.match(options.title, /past-mistake record/);
    return ['Reject synthetic mistake'];
  }, request: async (url, options) => {
    urls.push(url);
    if (options) {
      const body = JSON.parse(options.body);
      writes.push(body);
      current = pastMistake({ status: 'rejected', revision: body.expectedRevision + 1, depth: 2 });
      return { committed: true, id: current.id, revision: current.revision };
    }
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname.includes('/memory-facts/memory-11111111-1111-4111-8111-111111111111')) return { memory: current };
    if (parsed.searchParams.get('kind') === 'mistakes') {
      current = pastMistake({ status: current.status, revision: current.revision, depth: Number(parsed.searchParams.get('depth')) });
      return { facts: [current], total: 1, nextCursor: null, disputedCount: 0, facets };
    }
    return { facts: [], total: 0, nextCursor: null, disputedCount: 0, facets };
  } });

  await ui.api.refresh();
  const kind = ui.nodes.get('#memoryRecallKind');
  assert.deepEqual(kind.children.map(option => option.value), ['all', 'mistakes']);
  kind.value = 'mistakes';
  kind.listeners.get('change')();
  await settleRefresh();

  const firstPage = new URL(urls.at(-1), 'http://localhost');
  assert.equal(firstPage.searchParams.get('kind'), 'mistakes');
  assert.equal(firstPage.searchParams.get('standing'), 'all', 'the initial mistake view includes historical entries');
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /What went wrong/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /I used a stale build result/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Correction/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Rebuild after the source change/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Resulting fix/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /link-message-synthetic-evidence/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /agent · agent-one/);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /Synthetic verified source excerpt/);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /data-fact-edit/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /data-fact-reject/);

  ui.nodes.get('#memoryRecallStanding').value = 'historical';
  ui.nodes.get('#memoryRecallStanding').listeners.get('change')();
  await settleRefresh();
  const selectedStanding = new URL(urls.at(-1), 'http://localhost');
  assert.equal(selectedStanding.searchParams.get('kind'), 'mistakes');
  assert.equal(selectedStanding.searchParams.get('standing'), 'historical', 'the standing filter remains adjustable');

  ui.nodes.get('#memoryRecallStanding').value = 'all';
  ui.nodes.get('#memoryRecallStanding').listeners.get('change')();
  await settleRefresh();
  ui.nodes.get('#memoryRecallDepth').value = '2';
  ui.nodes.get('#memoryRecallDepth').listeners.get('change')();
  await settleRefresh();
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Source evidence/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Synthetic verified source excerpt/);

  const list = ui.nodes.get('#memoryRecallList');
  const rejectButton = { disabled: false, dataset: { factReject: current.id } };
  await list.listeners.get('click')({ target: { closest: selector => selector === '[data-fact-edit], [data-fact-reject], [data-fact-review], [data-fact-supersede]' ? rejectButton : null } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].operation, 'revise');
  assert.equal(writes[0].id, current.id);
  assert.equal(writes[0].expectedRevision, 4);
  assert.deepEqual(writes[0].changes, { status: 'rejected' });
  assert.equal(writes[0].why, 'Reject synthetic mistake');
  assert.equal(writes[0].approved, true);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /excluded from future mistake warnings/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /rejected/);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /data-fact-reject/);
});

test('changing agents clears filters; failed server-filter reads clear stale rows and allow retry', async () => {
  let failFilteredRead = false;
  const requests = [];
  const agents = [{ id: 'agent-one', name: 'First agent' }, { id: 'agent-two', name: 'Second agent' }];
  const ui = createUi({ agents, request: async url => {
    requests.push(url);
    const parsed = new URL(url, 'http://localhost');
    if (failFilteredRead && parsed.searchParams.has('category')) throw new Error('Filter service unavailable');
    return { facts: [fact(`${parsed.pathname.includes('agent-two') ? 'second' : 'first'}-fact`,
      parsed.pathname.includes('agent-two') ? 'Second agent fact' : 'First agent fact')], total: 9,
      nextCursor: null, disputedCount: 2, facets };
  } });
  await ui.api.refresh();

  const category = ui.nodes.get('#memoryRecallCategory');
  const scope = ui.nodes.get('#memoryRecallScope');
  category.value = 'Operations';
  scope.value = scopedValue;
  failFilteredRead = true;
  category.listeners.get('change')();
  await settleRefresh();
  assert.equal(ui.nodes.get('#memoryRecallList').innerHTML, '');
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Filter service unavailable.*Refresh to retry/);
  assert.equal(ui.nodes.get('#memoryRecallRefresh').disabled, false);

  failFilteredRead = false;
  await ui.api.refresh();
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /First agent fact/);
  const picker = ui.nodes.get('#memoryRecallAgent');
  picker.value = 'agent-two';
  picker.listeners.get('change')();
  await settleRefresh();
  const switched = new URL(requests.at(-1), 'http://localhost');
  assert.equal(switched.pathname, '/api/agents/agent-two/memory-facts');
  assert.equal(switched.searchParams.has('category'), false);
  assert.equal(switched.searchParams.has('scope'), false);
  assert.equal(category.value, '');
  assert.equal(scope.value, '');
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Second agent fact/);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /First agent fact/);
});
