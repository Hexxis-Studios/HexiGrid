import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
const createdId = 'memory-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeNode(value = '', registry = null) {
  const listeners = new Map();
  const classes = new Set();
  return {
    value, textContent: '', innerHTML: '', disabled: false, dataset: {}, children: [], listeners,
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); },
      contains(name) { return classes.has(name); }
    },
    addEventListener(type, callback) { listeners.set(type, callback); },
    appendChild(child) { this.children.push(child); if (child.id) registry?.set(`#${child.id}`, child); },
    replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); },
    setAttribute(name, value) { if (name === 'id') { this.id = value; registry?.set(`#${value}`, this); } },
    closest() { return null; }
  };
}

function factRecord({ id = createdId, text = 'The studio is in Portland.', revision = 0, status = 'active', category = 'Location', evidence = 'Owner said Portland.' } = {}) {
  return {
    id, agentId: 'agent-one', text, revision, revision_count: revision, status,
    verification: 'unverified', originKind: 'owner-entry', metadata: { category },
    contextScope: { projectId: 'studio', topicId: 'design' },
    valid_while: '', verify_by: null, evidence_excerpt: evidence,
    createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
    revisions: []
  };
}

function makeHarness({ request, ask, agents = [{ id: 'agent-one', name: 'First agent' }, { id: 'agent-two', name: 'Second agent' }] }) {
  const nodes = new Map();
  for (const [name, value] of Object.entries({
    Agent: '', Status: '', List: '', Query: '', Standing: 'current', Depth: '0',
    Refresh: '', More: '', Profile: '', Store: 'facts', CreateSkill: ''
  })) nodes.set(`#memoryRecall${name}`, makeNode(value, nodes));
  nodes.set('.memory-recall-meta', makeNode('', nodes));
  nodes.set('.memory-recall-controls', makeNode('', nodes));
  const picker = nodes.get('#memoryRecallAgent');
  let selectedAgent = '';
  Object.defineProperty(picker, 'value', { get: () => selectedAgent, set: value => { selectedAgent = value; } });
  Object.defineProperty(picker, 'innerHTML', {
    get() { return ''; },
    set(markup) {
      const choices = [...markup.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]);
      if (!choices.includes(selectedAgent)) selectedAgent = choices[0] || '';
    }
  });
  const root = {
    querySelector(selector) { return nodes.get(selector); },
    ownerDocument: { createElement: () => makeNode('', nodes) }
  };
  const context = {
    window: {}, Intl, Date, URLSearchParams, clearTimeout, setTimeout,
    crypto: { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
  };
  vm.runInNewContext(source, context);
  const api = context.window.HexiGridViewRenderers.createMemoryRecall({ root, request, agents: () => agents, label: agent => agent.name, openProfile() {}, ask });
  return {
    api, nodes, picker, createFactButton: nodes.get('.memory-recall-meta').children[0],
    async clickFact(kind, id) {
      const key = kind === 'edit' ? 'factEdit' : kind === 'review' ? 'factReview' : kind === 'supersede' ? 'factSupersede' : 'factReject';
      const button = { disabled: false, dataset: { [key]: id } };
      return nodes.get('#memoryRecallList').listeners.get('click')({ target: { closest: selector => selector.includes(`[data-fact-${kind}]`) ? button : null } });
    }
  };
}

function localMemoryService(initial = []) {
  const facts = new Map(initial.map(fact => [fact.id, structuredClone(fact)]));
  const requests = [];
  const agents = new Map([['agent-one', 'First agent'], ['agent-two', 'Second agent']]);
  let conflictNextRevision = false;
  async function request(url, options) {
    requests.push({ url, options });
    const parsed = new URL(url, 'http://localhost');
    const match = parsed.pathname.match(/^\/api\/agents\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
    assert.ok(match, `unexpected request path: ${parsed.pathname}`);
    const [, agentId, endpoint, memoryId] = match;
    assert.ok(agents.has(agentId), `request used unknown agent ${agentId}`);
    if (options?.method === 'POST') {
      assert.equal(endpoint, 'memory-commit');
      const body = JSON.parse(options.body);
      assert.equal(body.approved, true);
      if (body.operation === 'create') {
        assert.equal(facts.has(body.id), false);
        const fact = { ...factRecord({ id: body.id, text: body.text, status: body.status, category: body.metadata.category, evidence: body.evidence_excerpt }),
          metadata: body.metadata, contextScope: body.contextScope, valid_while: body.valid_while, verify_by: body.verify_by };
        facts.set(body.id, fact);
        return { committed: true, id: fact.id, revision: 0 };
      }
      assert.equal(body.operation, 'revise');
      const fact = facts.get(body.id);
      assert.ok(fact, `missing fact ${body.id}`);
      if (conflictNextRevision) {
        conflictNextRevision = false;
        fact.revisions.unshift({ at: '2026-10-02T11:00:00.000Z', why: 'Concurrent update', by: 'agent-link:second', changes: { text: { from: fact.text, to: 'Concurrent current text.' } } });
        fact.text = 'Concurrent current text.';
        fact.revision += 1;
        fact.revision_count = fact.revision;
        fact.updatedAt = '2026-10-02T11:00:00.000Z';
        const error = new Error(`Memory revision conflict: expected revision ${body.expectedRevision}, found ${fact.revision}`);
        error.status = 409;
        throw error;
      }
      assert.equal(body.expectedRevision, fact.revision, 'a write must use the detail revision just reviewed');
      const previous = fact.text;
      Object.assign(fact, body.changes);
      fact.text = body.changes.text ?? previous;
      fact.revision += 1;
      fact.revision_count = fact.revision;
      fact.updatedAt = '2026-10-02T12:00:00.000Z';
      fact.revisions.unshift({ at: fact.updatedAt, why: body.why, by: 'owner:test', changes: Object.fromEntries(Object.entries(body.changes).map(([key, value]) => [key, { from: key === 'text' ? previous : null, to: value }])) });
      return { committed: true, id: fact.id, revision: fact.revision };
    }
    if (endpoint === 'memory-facts' && memoryId) {
      assert.equal(parsed.searchParams.get('depth'), '2', 'fact action must read exact depth-2 detail');
      const fact = facts.get(memoryId);
      return fact ? { memory: structuredClone(fact) } : { memory: null };
    }
    assert.equal(endpoint, 'memory-facts');
    const standing = parsed.searchParams.get('standing') || 'current';
    const depth = Number(parsed.searchParams.get('depth') || '0');
    const query = (parsed.searchParams.get('query') || '').toLowerCase();
    const matching = [...facts.values()].filter(fact => fact.agentId === agentId)
      .filter(fact => standing === 'all' || (standing === 'current' ? ['active', 'conditional'].includes(fact.status) : fact.status === standing))
      .filter(fact => !query || [fact.text, fact.contextScope?.projectId, fact.contextScope?.topicId].some(value => String(value || '').toLowerCase().includes(query)));
    return { facts: matching.map(fact => {
      const copy = structuredClone(fact);
      if (depth < 1) { delete copy.revisions; delete copy.revision_count; }
      if (depth < 2) delete copy.evidence_excerpt;
      return copy;
    }), total: matching.length, nextCursor: null };
  }
  return { request, requests, facts, conflictOnNextRevision() { conflictNextRevision = true; } };
}

const acceptedFact = ['The studio is in Portland.', 'Location', 'studio', 'design', 'active', '', '', 'Owner said Portland.'];

test('replacement reviews both current facts and submits exact revisions, time and evidence through the owner path', async () => {
  const old = factRecord({ id: 'memory-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', text: 'The studio was in Seattle.', revision: 2 });
  const current = { ...factRecord(), conflictCount: 1, conflicts: [{ relation: 'contradicts', otherId: old.id }] };
  const service = localMemoryService([current, old]); let payload, dialog;
  const request = async (url, options) => {
    if (options?.method === 'POST') {
      payload = JSON.parse(options.body);
      return { committed: true, linkId: 'conflict-qa', fromId: current.id, toId: old.id, relation: 'supersedes' };
    }
    return service.request(url, options);
  };
  const ui = makeHarness({ request, ask: async options => { dialog = options; return ['', old.id, '', '2026-10-04T12:00:00.000Z', 'Owner reviewed the move.', 'Move receipt confirmed the effective date.']; } });
  await ui.api.refresh(); await ui.clickFact('supersede', current.id);
  assert.match(dialog.fields[0].value, /Portland/);
  assert.match(dialog.fields[2].value, /Seattle/);
  assert.deepEqual(payload, { operation: 'conflict', fromId: current.id, toId: old.id, relation: 'supersedes', expectedFromRevision: 0, expectedToRevision: 2,
    valid_from: '2026-10-04T12:00:00.000Z', why: 'Owner reviewed the move.', source: { kind: 'owner-feedback', text: 'Move receipt confirmed the effective date.' }, approved: true });
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Replacement recorded/);
});

test('replacement cancellation, changed agent, foreign scope, invalid dates and mismatched receipts cannot report success', async () => {
  const old = factRecord({ id: 'memory-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  const current = { ...factRecord(), conflictCount: 1, conflicts: [{ relation: 'contradicts', otherId: old.id }] };
  for (const mode of ['cancel', 'agent', 'scope', 'date', 'receipt', 'stale']) {
    const service = localMemoryService([current, mode === 'scope' ? { ...old, contextScope: { projectId: 'unrelated' } } : old]);
    let writes = 0, ui;
    const request = async (url, options) => {
      if (options?.method === 'POST') {
        writes++;
        if (mode === 'stale') throw Error('Current revisions changed');
        return { committed: true, linkId: 'conflict-qa', fromId: current.id, toId: 'wrong-id', relation: 'supersedes' };
      }
      return service.request(url, options);
    };
    ui = makeHarness({ request, ask: async () => {
      if (mode === 'cancel') return null;
      if (mode === 'agent') ui.picker.value = 'agent-two';
      return ['', old.id, '', mode === 'date' ? '2026-02-31T00:00:00.000Z' : '2026-10-04T12:00:00.000Z', 'Reviewed', 'Evidence'];
    } });
    await ui.api.refresh(); await ui.clickFact('supersede', current.id);
    assert.equal(writes, ['receipt', 'stale'].includes(mode) ? 1 : 0, mode);
    assert.doesNotMatch(ui.nodes.get('#memoryRecallStatus').textContent, /Replacement recorded/, mode);
    if (mode === 'stale') assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /fresh revisions.*retained draft/);
  }
});

test('guided standing review preserves text, conditions, evidence and exact revision authority', async () => {
  const fact = { ...factRecord({ status: 'disputed' }), valid_while: 'While the studio lease is active', conflictCount: 1,
    conflicts: [{ otherId: 'other-id', relation: 'contradicts', why: 'Documents differ', evidence: { text: 'Reviewed retained evidence' } }] };
  const service = localMemoryService([fact]); let dialog;
  const ui = makeHarness({ request: service.request, ask: async options => { dialog = options; return ['', '', 'conditional', 'Owner reviewed the lease evidence.']; } });
  ui.nodes.get('#memoryRecallStanding').value = 'all'; await ui.api.refresh();
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Review standing/);
  await ui.clickFact('review', createdId);
  const body = JSON.parse(service.requests.find(item => item.options?.method === 'POST').options.body);
  assert.deepEqual(body.changes, { status: 'conditional' }); assert.equal(body.expectedRevision, 0);
  assert.equal(body.id, fact.id); assert.equal(body.approved, true);
  assert.match(dialog.fields[0].value, /While the studio lease is active.*Source evidence/s);
  assert.match(dialog.fields[1].value, /Reviewed retained evidence/);
  assert.equal(service.facts.get(fact.id).text, fact.text);
  assert.equal(service.facts.get(fact.id).evidence_excerpt, fact.evidence_excerpt);
  assert.equal(service.facts.get(fact.id).verification, 'unverified');
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Review saved as conditional/);
});

test('standing review cancellation, no-op and changed-agent confirmation cannot write', async () => {
  for (const scenario of ['cancel', 'same', 'changed']) {
    const service = localMemoryService([factRecord({ status: 'disputed' })]); let ui;
    ui = makeHarness({ request: service.request, ask: async () => {
      if (scenario === 'cancel') return null;
      if (scenario === 'changed') ui.picker.value = 'agent-two';
      return ['', '', scenario === 'same' ? 'disputed' : 'active', 'Evidence reviewed.'];
    } });
    ui.nodes.get('#memoryRecallStanding').value = 'all'; await ui.api.refresh(); await ui.clickFact('review', createdId);
    assert.equal(service.requests.filter(item => item.options?.method === 'POST').length, 0);
  }
});

test('standing review stale revisions reload current detail and retain the reason for explicit retry', async () => {
  const service = localMemoryService([factRecord({ status: 'disputed' })]); const dialogs = [];
  const ui = makeHarness({ request: service.request, ask: async options => { dialogs.push(options); return ['', '', 'active', 'Retained review reason']; } });
  ui.nodes.get('#memoryRecallStanding').value = 'all'; await ui.api.refresh();
  service.conflictOnNextRevision(); await ui.clickFact('review', createdId);
  assert.equal(service.facts.get(createdId).status, 'disputed');
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Review standing.*nothing was overwritten/);
  await ui.clickFact('review', createdId);
  assert.equal(dialogs[1].fields[3].value, 'Retained review reason');
  const writes = service.requests.filter(item => item.options?.method === 'POST');
  assert.equal(JSON.parse(writes[1].options.body).expectedRevision, 1);
  assert.equal(service.facts.get(createdId).revision, 2);
});

test('standing review denial is not success and retains reason', async () => {
  const service = localMemoryService([factRecord({ status: 'disputed' })]); const dialogs = [];
  const ui = makeHarness({ request: async (url, options) => { if (options?.method === 'POST') throw Error('Policy denied'); return service.request(url, options); },
    ask: async options => { dialogs.push(options); return ['', '', 'active', 'Keep my reason']; } });
  ui.nodes.get('#memoryRecallStanding').value = 'all'; await ui.api.refresh(); await ui.clickFact('review', createdId);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /not confirmed.*Policy denied/);
  await ui.clickFact('review', createdId); assert.equal(dialogs[1].fields[3].value, 'Keep my reason');
  assert.equal(service.facts.get(createdId).status, 'disputed');
});

test('manual fact creation, depth-2 detail, versioned edit, reject, and current recall exclusion', async () => {
  const service = localMemoryService();
  const dialogs = [];
  const answers = [
    acceptedFact,
    ['The studio moved to Bend.', 'Location', 'studio', 'design', 'active', '', '', 'Owner confirmed the move.', 'Owner updated the location.'],
    ['The location is no longer useful.']
  ];
  const ui = makeHarness({ request: service.request, ask: async options => { dialogs.push(options); return answers.shift(); } });
  ui.nodes.get('#memoryRecallDepth').value = '2';
  await ui.api.refresh();
  assert.equal(ui.createFactButton.textContent, 'New fact');
  assert.equal(ui.createFactButton.classList.contains('hidden'), false);

  ui.createFactButton.listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  const create = service.requests.find(item => item.options?.method === 'POST');
  const createBody = JSON.parse(create.options.body);
  assert.match(create.url, /\/api\/agents\/agent-one\/memory-commit$/);
  assert.deepEqual(createBody, {
    operation: 'create', id: createdId, text: acceptedFact[0], metadata: { category: 'Location' },
    contextScope: { projectId: 'studio', topicId: 'design' }, status: 'active', valid_while: '', verify_by: null,
    evidence_excerpt: 'Owner said Portland.', approved: true
  });
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /created locally as unverified/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Entered by owner/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Source evidence/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Owner said Portland\./);

  const edit = ui.clickFact('edit', createdId);
  await edit;
  assert.match(service.requests.map(item => item.url).join('\n'), new RegExp(`/api/agents/agent-one/memory-facts/${createdId}\\?depth=2`));
  assert.equal(dialogs[1].title, 'Edit versioned fact');
  assert.match(dialogs[1].message, /Current revision 0 and evidence are loaded/);
  const editWrite = service.requests.filter(item => item.options?.method === 'POST')[1];
  const editBody = JSON.parse(editWrite.options.body);
  assert.equal(editBody.operation, 'revise');
  assert.equal(editBody.expectedRevision, 0);
  assert.equal(editBody.why, 'Owner updated the location.');
  assert.equal(editBody.changes.text, 'The studio moved to Bend.');
  assert.equal(editBody.changes.evidence_excerpt, 'Owner confirmed the move.');
  assert.equal(ui.nodes.get('#memoryRecallList').innerHTML.includes('Revision history (1)'), true);
  assert.equal(ui.nodes.get('#memoryRecallList').innerHTML.includes('Owner updated the location. · owner:test'), true);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Owner confirmed the move\./);

  ui.nodes.get('#memoryRecallStanding').value = 'all';
  await ui.clickFact('reject', createdId);
  const rejectWrite = service.requests.filter(item => item.options?.method === 'POST')[2];
  const rejectBody = JSON.parse(rejectWrite.options.body);
  assert.equal(dialogs[2].title, 'Reject this fact from recall?');
  assert.match(dialogs[2].message, /local history; nothing is physically erased/);
  assert.equal(rejectBody.operation, 'revise');
  assert.equal(rejectBody.expectedRevision, 1);
  assert.equal(rejectBody.why, 'The location is no longer useful.');
  assert.deepEqual(rejectBody.changes, { status: 'rejected' });
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /history remains saved/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Revision history \(2\)/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /The location is no longer useful\./);

  ui.nodes.get('#memoryRecallStanding').value = 'current';
  await ui.api.refresh();
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /No matching dated facts/);
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /0 of 0 matching dated facts/);
});

test('409 reloads current detail, preserves attempted values, and waits for a deliberate resubmission', async () => {
  const service = localMemoryService([factRecord({ revision: 1 })]);
  service.conflictOnNextRevision();
  const dialogs = [];
  const answers = [
    ['Attempted edit stays in my draft.', 'Location', 'studio', 'design', 'active', '', '', 'Attempted evidence.', 'Attempted reason.'],
    null
  ];
  const ui = makeHarness({ request: service.request, ask: async options => { dialogs.push(options); return answers.shift(); } });
  ui.nodes.get('#memoryRecallDepth').value = '2';
  await ui.api.refresh();
  await ui.clickFact('edit', createdId);

  assert.equal(service.requests.filter(item => item.options?.method === 'POST').length, 1);
  assert.equal(service.requests.filter(item => item.url.includes(`/${createdId}?depth=2`)).length, 2,
    'the conflict path reloads current detail after the original detail read');
  assert.match(ui.nodes.get('#memoryRecallStatus').textContent, /Revision 2 is now loaded and your attempted values are retained/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Concurrent current text\./);
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /Attempted edit stays in my draft\./);

  await ui.clickFact('edit', createdId);
  assert.equal(dialogs[1].fields[0].value, 'Attempted edit stays in my draft.');
  assert.equal(dialogs[1].fields[7].value, 'Attempted evidence.');
  assert.equal(dialogs[1].fields[8].value, 'Attempted reason.');
  assert.equal(service.requests.filter(item => item.options?.method === 'POST').length, 1,
    'loading/reviewing the reloaded draft never retries the write automatically');
});

test('changing the selected agent while the edit dialog is open cancels the captured action', async () => {
  const service = localMemoryService([factRecord()]);
  let answer;
  let opened;
  const dialogOpened = new Promise(resolve => { opened = resolve; });
  const ui = makeHarness({ request: service.request, ask: options => { answer = options; opened(); return new Promise(resolve => { answer.resolve = resolve; }); } });
  await ui.api.refresh();
  const action = ui.clickFact('edit', createdId);
  await dialogOpened;
  assert.equal(answer.title, 'Edit versioned fact');

  ui.picker.value = 'agent-two';
  ui.picker.listeners.get('change')();
  await new Promise(resolve => setImmediate(resolve));
  answer.resolve(['Must not be saved for another agent.', 'Location', 'studio', 'design', 'active', '', '', '', 'Reason']);
  await action;

  assert.equal(service.requests.filter(item => item.options?.method === 'POST').length, 0);
  assert.equal(ui.picker.value, 'agent-two');
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /The studio is in Portland\./);
});

test('a fact dialog is single-flight while an action is pending', async () => {
  const service = localMemoryService([factRecord()]);
  let resolveAnswer;
  let askCount = 0;
  const ui = makeHarness({ request: service.request, ask: () => {
    askCount += 1;
    return new Promise(resolve => { resolveAnswer = resolve; });
  } });
  await ui.api.refresh();
  const firstAction = ui.clickFact('edit', createdId);
  const duplicateAction = ui.clickFact('edit', createdId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(askCount, 1);
  assert.equal(service.requests.filter(item => item.url.includes(`/${createdId}?depth=2`)).length, 1);

  resolveAnswer(['Single saved edit.', 'Location', 'studio', 'design', 'active', '', '', '', 'One deliberate reason.']);
  await Promise.all([firstAction, duplicateAction]);
  assert.equal(service.requests.filter(item => item.options?.method === 'POST').length, 1);
});

test('search keeps backend relevance results while category and scope fetch matching server results', async () => {
  const result = factRecord({ text: 'A result found through an owner-confirmed alias.', category: 'Continuity' });
  const other = { ...factRecord({ id: 'memory-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', text: 'Another relevance result.', category: 'Operations' }), contextScope: { projectId: 'another-project' } };
  const base = localMemoryService([result, other]);
  const queries = [];
  const request = async (url, options) => {
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname.endsWith('/memory-facts') && !parsed.pathname.includes(result.id)) {
      queries.push(parsed.searchParams.get('query'));
      const selected = [result, other].filter(fact =>
        (!parsed.searchParams.get('category') || fact.metadata.category === parsed.searchParams.get('category')) &&
        (!parsed.searchParams.get('scope') || JSON.stringify({ projectId: fact.contextScope.projectId, topicId: fact.contextScope.topicId || '' }) === parsed.searchParams.get('scope')));
      return { facts: selected.map(fact => structuredClone(fact)), total: selected.length, nextCursor: null,
        facets: { categories: ['Continuity', 'Operations'], scopes: [result, other].map(fact => ({
          value: JSON.stringify({ projectId: fact.contextScope.projectId, topicId: fact.contextScope.topicId || '' }),
          label: fact.contextScope.projectId })), truncated: { categories: false, scopes: false } }, disputedCount: 0 };
    }
    return base.request(url, options);
  };
  const ui = makeHarness({ request, ask: async () => null });
  ui.nodes.get('#memoryRecallQuery').value = 'the alias wording is not in this text';
  await ui.api.refresh();
  assert.deepEqual(queries, ['the alias wording is not in this text']);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /A result found through an owner-confirmed alias\./);

  const category = ui.nodes.get('#memoryRecallCategory');
  assert.ok(category, 'the category filter is available for dated facts');
  category.value = 'Operations';
  category.listeners.get('change')();
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /owner-confirmed alias/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Another relevance result\./);

  category.value = '';
  category.listeners.get('change')();
  await new Promise(resolve => setImmediate(resolve));
  const scope = ui.nodes.get('#memoryRecallScope');
  scope.value = JSON.stringify({ projectId: 'another-project', topicId: '' });
  scope.listeners.get('change')();
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(ui.nodes.get('#memoryRecallList').innerHTML, /owner-confirmed alias/);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Another relevance result\./);
  assert.match(ui.nodes.get('#memoryRecallList').innerHTML, /Scope/);
});

test('fact browser labels durable origins clearly without displaying forged enum text', async () => {
  for (const [originKind, label] of [['owner-entry', 'Entered by owner'], ['agent-proposal', 'Agent proposal'], ['automatic-learning', 'Automatic learning'], ['legacy-unknown', 'Origin not recorded'], ['<script>forged</script>', 'Origin not recorded']]) {
    const service = localMemoryService([{ ...factRecord(), originKind }]);
    const ui = makeHarness({ request: service.request, ask: async () => null });
    await ui.api.refresh();
    const rendered = ui.nodes.get('#memoryRecallList').innerHTML;
    assert.match(rendered, new RegExp(`<strong>Origin</strong> ${label}`));
    assert.doesNotMatch(rendered, /forged/);
  }
});
