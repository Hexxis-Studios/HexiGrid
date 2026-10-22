import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');

const draft = (overrides = {}) => ({
  id: 'agent-skill-quarantine-11111111-1111-4111-8111-111111111111',
  linkId: 'source-link-qa', status: 'pending', createdAt: '2026-10-19T10:00:00.000Z',
  intent: { operation: 'create', why: 'Observed a recurring task.' },
  riskReasonCodes: ['delayed_prompt_injection'],
  draft: { name: 'Safe skill', whenToUse: 'When asked', procedure: 'Read and summarize.', successCheck: 'Check the source.', status: 'active' },
  ...overrides
});

function reader(request, ask = async () => null) {
  const nodes = new Map();
  const element = (value = '') => ({ value, innerHTML: '', textContent: '', disabled: false, placeholder: '', listeners: {},
    classList: { hidden: true, toggle(name, force) { if (name === 'hidden') this.hidden = Boolean(force); }, add(name) { if (name === 'hidden') this.hidden = true; } },
    addEventListener(type, callback) { this.listeners[type] = callback; }, closest() { return null; } });
  for (const [id, value] of Object.entries({
    memoryRecallAgent: '', memoryRecallStatus: '', memoryRecallList: '', memoryHealthStatus: '', memoryHealthIssues: '',
    memoryHealthCheck: '', memoryHealthMore: '', memoryRecallDepth: '0', memoryRecallStanding: 'active',
    memoryRecallQuery: '', memoryRecallMore: '', memoryRecallProfile: '', memoryRecallRefresh: '',
    memoryRecallStore: 'skills', memoryRecallCreateSkill: '', skillQuarantineReview: '',
    skillQuarantineStatus: '', skillQuarantineList: ''
  })) nodes.set(`#${id}`, element(value));
  const picker = nodes.get('#memoryRecallAgent');
  Object.defineProperty(picker, 'innerHTML', { set(value) { this.value = value.match(/value="([^"]+)"/)?.[1] || ''; } });
  const context = { window: {}, Intl, Date, URLSearchParams, clearTimeout, setTimeout };
  vm.runInNewContext(source, context);
  const api = context.window.HexiGridViewRenderers.createMemoryRecall({ root: { querySelector: selector => nodes.get(selector) || null },
    request, agents: () => [{ id: 'agent-qa', name: 'Owner test agent' }], label: agent => agent.name, ask });
  return { api, nodes, picker };
}

test('skill review loads for the selected owner skill store and escapes the full draft and source', async () => {
  const urls = [];
  const record = draft({ linkId: '<source>', draft: { name: '<img src=x>', whenToUse: 'If <requested>', procedure: '<script>do not run</script>', successCheck: 'No <script>', status: 'active' } });
  const ui = reader(async url => {
    urls.push(url);
    return url.includes('/skill-quarantines') ? { drafts: [record] } : { skills: [] };
  });

  await ui.api.refresh();

  const html = ui.nodes.get('#skillQuarantineList').innerHTML;
  assert.ok(urls.some(url => url === '/api/agents/agent-qa/skill-quarantines'));
  assert.equal(ui.nodes.get('#skillQuarantineReview').classList.hidden, false);
  assert.match(html, /Owner test agent/);
  assert.match(html, /source-link-qa|&lt;source&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /&lt;script&gt;do not run&lt;\/script&gt;/);
  assert.match(html, /Instructions trying to override future decisions/);
  assert.match(html, /data-skill-quarantine-reject=/);
  assert.doesNotMatch(html, /data-(?:approve|activate)|Approve draft|Activate skill/);
});

test('reject requires a reason and posts only the explicit rejection decision', async () => {
  const calls = [];
  const ui = reader(async (url, options) => {
    calls.push({ url, options });
    return url.includes('/skill-quarantines') ? { drafts: calls.some(call => call.options?.method === 'POST') ? [] : [draft()] } : { skills: [] };
  });
  await ui.api.refresh();
  const list = ui.nodes.get('#skillQuarantineList');
  const id = draft().id;
  const input = { value: '', focus() { this.focused = true; } };
  const feedback = { textContent: '' };
  const card = { dataset: { skillQuarantineCard: id }, querySelector(selector) {
    return selector === '[data-skill-quarantine-reason]' ? input : selector === '[data-skill-quarantine-feedback]' ? feedback : null;
  } };
  const button = { disabled: false, dataset: { skillQuarantineReject: id }, closest: selector => selector === '[data-skill-quarantine-card]' ? card : null };
  const click = () => list.listeners.click({ target: { closest: selector => selector === '[data-skill-quarantine-reject]' ? button : null } });

  await click();
  assert.equal(input.focused, true);
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 0);
  assert.match(ui.nodes.get('#skillQuarantineStatus').textContent, /Enter a reason/);

  input.value = 'The procedure tries to override future instructions.';
  await click();
  const write = calls.find(call => call.options?.method === 'POST');
  assert.equal(write.url, `/api/agents/agent-qa/skill-quarantines/${id}`);
  assert.deepEqual(JSON.parse(write.options.body), {
    decision: 'rejected', reason: input.value, approved: true
  });
  assert.match(ui.nodes.get('#skillQuarantineStatus').textContent, /Draft rejected.*not applied/);
  assert.match(ui.nodes.get('#skillQuarantineList').innerHTML, /No pending skill drafts/);
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
});

test('pending review has loading, empty and error states and stays hidden without owner actions', async () => {
  let completeQueue;
  const ui = reader(url => url.includes('/skill-quarantines')
    ? new Promise(resolve => { completeQueue = resolve; }) : Promise.resolve({ skills: [] }));
  const loading = ui.api.refresh();
  assert.match(ui.nodes.get('#skillQuarantineStatus').textContent, /Loading pending skill drafts/);
  completeQueue({ drafts: [] });
  await loading;
  assert.match(ui.nodes.get('#skillQuarantineStatus').textContent, /No pending skill drafts/);

  const failed = reader(async url => {
    if (url.includes('/skill-quarantines')) throw new Error('Owner session required');
    return { skills: [] };
  });
  await failed.api.refresh();
  assert.match(failed.nodes.get('#skillQuarantineStatus').textContent, /could not be loaded: Owner session required/);

  const calls = [];
  const nonOwner = reader(async url => { calls.push(url); return { skills: [] }; }, null);
  await nonOwner.api.refresh();
  assert.equal(calls.some(url => url.includes('/skill-quarantines')), false);
  assert.equal(nonOwner.nodes.get('#skillQuarantineReview').classList.hidden, true);
});
