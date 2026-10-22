import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { agentInterfaceManifest } from '../lib/agent-interface.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(await read('public/view-renderers.js'), context);
const { agentCatalogEntries, createMemoryReview } = context.window.HexiGridViewRenderers;

test('agent catalog discovers signed memory operations and owner-only resources without mixing authentication', () => {
  const manifest = agentInterfaceManifest();
  const signed = agentCatalogEntries(manifest, { query: 'memory semantic-search', authentication: 'signed' });
  assert.equal(signed.length, 1);
  assert.equal(signed[0].path, '/agent-link/v1/memory-mcp');
  const owner = agentCatalogEntries(manifest, { query: 'skills', authentication: 'owner' });
  assert.ok(owner.some((entry) => entry.name === 'agentSkill' && entry.kind === 'resources'));
  assert.ok(owner.every((entry) => entry.action.ownerOnly));
  assert.equal(agentCatalogEntries(manifest, { query: 'not-a-real-operation' }).length, 0);
  assert.equal(agentCatalogEntries(manifest).length, Object.keys(manifest.resources).length + Object.keys(manifest.actions).length);
});

function reviewFixture(request) {
  const nodes = new Map(['#memoryReviewList', '#memoryReviewCount', '#memoryReviewStatus', '#memoryReviewRefresh'].map((key) => [key, {
    innerHTML: '', textContent: '', disabled: false, listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; }
  }]));
  const review = createMemoryReview({ root: { querySelector: (selector) => nodes.get(selector) }, request, agents: () => [{ id: 'a', name: 'ExampleAgent' }] });
  const proposal = { id: 'proposal/1', agentId: 'a', kind: 'create', payload: { text: '<script>private fact</script>', valid_while: 'test mode' } };
  function decisionEvent(decision, reason = '') {
    const button = { dataset: { memoryDecision: decision }, disabled: false, closest() { return card; } };
    const card = { dataset: { memoryReviewId: proposal.id }, querySelector: () => ({ value: reason }), querySelectorAll: () => [button] };
    return { target: { closest: () => button } };
  }
  return { review, nodes, proposal, decide: (decision, reason) => nodes.get('#memoryReviewList').listeners.click(decisionEvent(decision, reason)) };
}

test('both review surfaces escape memory content and commit only an explicit proposal decision', async () => {
  const calls = [];
  let committed = false;
  const fixture = reviewFixture(async (path, options) => {
    calls.push({ path, options });
    if (!options) return { proposals: committed ? [] : [fixture.proposal] };
    committed = true;
    return { status: 'approved' };
  });
  await fixture.review.refresh();
  assert.match(fixture.nodes.get('#memoryReviewList').innerHTML, /&lt;script&gt;/);
  assert.match(fixture.nodes.get('#memoryReviewList').innerHTML, /Valid while: test mode/);
  assert.equal(calls.length, 1, 'reading suggestions never approves them');
  await fixture.decide('approve');
  assert.equal(calls[1].path, '/api/memory-proposals/proposal%2F1/decision');
  assert.deepEqual(JSON.parse(calls[1].options.body), { decision: 'approve' });
  assert.equal(fixture.nodes.get('#memoryReviewCount').textContent, '(0)');
  assert.equal(fixture.nodes.get('#memoryReviewStatus').textContent, 'Saved as unverified memory.');
});

test('reject requires a reason and a failed load does not pretend there are zero proposals', async () => {
  const fixture = reviewFixture(async () => ({ proposals: [fixture.proposal] }));
  await fixture.review.refresh();
  await fixture.decide('reject');
  assert.equal(fixture.nodes.get('#memoryReviewStatus').textContent, 'Enter a short rejection reason first.');
  const failed = reviewFixture(async () => { throw new Error('Session unavailable'); });
  await failed.review.refresh();
  assert.equal(failed.nodes.get('#memoryReviewCount').textContent, '(?)');
  assert.match(failed.nodes.get('#memoryReviewList').innerHTML, /could not be loaded/);
  assert.equal(failed.nodes.get('#memoryReviewRefresh').disabled, false);
});

test('human memory page and agent task anchors reach real controls, with shared renderer loaded first', async () => {
  const [human, agent, app, agentScript] = await Promise.all([read('public/index.html'), read('public/agent-interface.html'), read('public/app.js'), read('public/agent-interface.js')]);
  assert.match(human, /data-view="memory"/);
  assert.match(human, /id="view-memory"/);
  assert.match(app, /view === "memory"[\s\S]*createMemoryReview/);
  assert.match(app, /action === "open-computer-access"[\s\S]*showView\("integrations"\)/);
  const anchors = [...agent.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  for (const anchor of anchors) assert.ok(agent.includes(`id="${anchor}"`), `missing section ${anchor}`);
  assert.ok(agent.indexOf('src="/view-renderers.js"') < agent.indexOf('src="/agent-interface.js"'));
  assert.match(agentScript, /createMemoryReview/);
  assert.match(agentScript, /agentActionSearch'\)\.addEventListener\('input', renderActionCatalog\)/);
});

test('durable room discovery keeps local owner authentication separate from signed replies',()=>{
  const manifest=agentInterfaceManifest();
  const local=agentCatalogEntries(manifest,{query:'startRoomTurn',authentication:'owner'});
  const durable=local.find(entry=>entry.name==='startRoomTurn');assert.ok(durable);assert.ok(local.every(entry=>entry.authentication==='owner'));assert.equal(durable.path,'/api/rooms/{roomId}/turns');
  assert.equal(agentCatalogEntries(manifest,{query:'startRoomTurn',authentication:'signed'}).length,0);
  const signed=agentCatalogEntries(manifest,{query:'signedLinkRoomReply',authentication:'signed'});
  assert.equal(signed.length,1);assert.equal(signed[0].path,'/agent-link/v1/rooms/reply');
  const roomResources=agentCatalogEntries(manifest,{query:'/api/rooms',authentication:'owner'});
  assert.ok(roomResources.some(entry=>entry.name==='rooms'));
  assert.ok(roomResources.some(entry=>entry.name==='roomEvents'));
  assert.match(durable.action.note,/not answered/);
  assert.match(durable.action.note,/uncertain/);
});

test('agent work records retain exact standing, escaped instructions, zero limits and bounded per-task runs',()=>{
  const {agentWorkRecords}=context.window.HexiGridViewRenderers;
  const snapshot={agents:[{id:'agent',name:'<Agent>'}],tasks:[{id:'task',name:'<QA>',agentId:'agent',status:'cancelled',maxRuns:0,intervalSeconds:3600,prompt:'<script>instructions</script>',lastError:'denied <private>',lastOutput:'<output>'}],taskRuns:Array.from({length:12},(_,index)=>({id:`run-${index}`,taskId:'task',status:'completed',output:`<run-${index}>`})).concat({id:'foreign',taskId:'other',output:'foreign output'}),rooms:[{id:'room',name:'QA',archived:true,agentIds:['agent'],messages:[],replyChain:{requestId:'exact-request',agentIds:['agent'],index:0,status:'interrupted',error:'uncertain <result>'}}]};
  const rendered=agentWorkRecords(snapshot);
  assert.match(rendered.tasks,/no run limit/);assert.match(rendered.tasks,/&lt;script&gt;instructions/);assert.doesNotMatch(rendered.tasks,/<script>|foreign output|run-10/);
  assert.match(rendered.tasks,/Recent runs \(10\)/);assert.match(rendered.rooms,/interrupted/);assert.match(rendered.rooms,/exact-request/);assert.match(rendered.rooms,/Archived/);assert.match(rendered.rooms,/uncertain &lt;result&gt;/);
  const empty=agentWorkRecords({});assert.match(empty.tasks,/No tasks/);assert.match(empty.rooms,/No rooms/);
});

test('grouped signed social contracts remain discoverable under the signed authentication filter', () => {
  const manifest = agentInterfaceManifest();
  const entries = agentCatalogEntries(manifest, { query: 'hexispace/friendship/respond', authentication: 'signed' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'signedHexiSpace');
  assert.equal(agentCatalogEntries(manifest, { query: 'hexispace/friendship/respond', authentication: 'workspace' }).length, 0);
});
