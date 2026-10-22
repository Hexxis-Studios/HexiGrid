import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatedMemoryStore } from '../lib/dated-memory.mjs';
import { buildMemoryTurnContext } from '../lib/memory-turn-context.mjs';

const lineageId = 'lineage-12121212-1212-4212-8212-121212121212';
const foreignLineageId = 'lineage-34343434-3434-4434-8434-343434343434';
const otherLineageId = 'lineage-34343434-3434-4434-8434-343434343434';
const scope = { projectId: 'project-history', topicId: 'topic-memory' };
const asOf = (day, hour = '12') => `2026-09-${day}T${hour}:00:00.000Z`;

function memoryId(digit) {
  return `memory-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
}

function makeRanker(score = 0.9) {
  return { async scoreCandidates({ records }) {
    return new Map(records.map((record) => [record.id, typeof score === 'function' ? score(record) : score]));
  } };
}

function parseFacts(text, label) {
  const section = text.split(`[${label}]`)[1]?.split('[[END HEXIGRID MEMORY DATA]]')[0] || '';
  return section.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function context(store, options = {}) {
  return buildMemoryTurnContext({ store, rag: makeRanker(), lineageId, agentId: 'agent-exampleagent', scope,
    latestMessage: 'bridge route memory', currentTask: 'bridge recovery', now: () => Date.parse(asOf('06')),
    ...options });
}

test('lifecycle recall needs explicit disputed or as-of options and keeps snapshot status visible', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-lifecycle-'));
  const store = new DatedMemoryStore({ root });
  const revisedId = memoryId('1');
  const disputedId = memoryId('2');
  const historicalId = memoryId('3');
  const supersededId = memoryId('4');
  const rejectedId = memoryId('5');
  const foreignAgentId = memoryId('6');
  const foreignProjectId = memoryId('7');
  const append = (id, text, overrides = {}) => store.append({ id, lineageId, agentId: 'agent-exampleagent',
    createdAt: asOf('01', '10'), text, contextScope: scope, evidence_excerpt: `Source for ${id}.`, ...overrides });
  const revise = (id, expectedRevision, day, changes, why = 'Recorded lifecycle review') =>
    store.appendRevision({ lineageId, id, expectedRevision, createdAt: asOf(day),
      by: 'owner:qa', why, changes });

  try {
    await append(revisedId, 'Bridge route uses tunnel alpha.');
    await revise(revisedId, 0, '03', { text: 'Bridge route uses tunnel beta.' }, 'Corrected route from evidence');
    await append(disputedId, 'Bridge recovery detail remains disputed.', { status: 'disputed' });
    await append(historicalId, 'Bridge route from the retired setup.', { status: 'active' });
    await revise(historicalId, 0, '04', { status: 'historical' });
    await append(supersededId, 'Bridge route from the replaced setup.', { status: 'active' });
    await revise(supersededId, 0, '04', { status: 'superseded' });
    await append(rejectedId, 'Bridge route rejected after review.', { status: 'active' });
    await revise(rejectedId, 0, '05', { status: 'rejected' });
    await append(foreignAgentId, 'PRIVATE_AGENT bridge route.', { agentId: 'agent-other' });
    await append(foreignProjectId, 'PRIVATE_PROJECT bridge route.', { contextScope: { projectId: 'private-project', topicId: scope.topicId } });
    await store.append({ id: memoryId('8'), lineageId: foreignLineageId, agentId: 'agent-exampleagent',
      createdAt: asOf('01', '10'), text: 'PRIVATE_LINEAGE bridge route.', contextScope: scope });

    const currentDefault = await context(store);
    assert.equal(currentDefault.status, 'ready');
    assert.match(currentDefault.text, /Bridge route uses tunnel beta/);
    assert.doesNotMatch(currentDefault.text, /remains disputed|retired setup|replaced setup|rejected after review/);
    assert.doesNotMatch(currentDefault.text, /PRIVATE_AGENT|PRIVATE_PROJECT/);
    assert.doesNotMatch(currentDefault.text, /PRIVATE_LINEAGE/);

    const disputedDefault = await context(store, { includeDisputed: true, latestMessage: 'disputed', currentTask: '',
      maxFacts: 1, rag: makeRanker((record) => record.text.includes('disputed') ? 0.99 : 0) });
    assert.equal(disputedDefault.factCount, 1, 'the explicit disputed option still obeys the caller fact-count budget');
    assert.match(disputedDefault.text, /DISPUTED — unresolved; do not treat as settled/);
    assert.doesNotMatch(disputedDefault.text, /rejected after review/);

    const beforeCorrection = await context(store, { asOf: asOf('02') });
    assert.match(beforeCorrection.text, /HISTORICAL SNAPSHOT — append-only revisions recorded by 2026-09-02T12:00:00\.000Z/);
    assert.match(beforeCorrection.text, /HISTORICAL FACTS — RECORDED STANDING AS OF 2026-09-02T12:00:00\.000Z/);
    assert.match(beforeCorrection.text, /Bridge route uses tunnel alpha/);
    assert.doesNotMatch(beforeCorrection.text, /tunnel beta/);
    assert.doesNotMatch(beforeCorrection.text, /remains disputed/,
      'disputed records still need their separate explicit option inside an as-of snapshot');
    assert.doesNotMatch(beforeCorrection.text, /rejected after review/,
      'a currently rejected record is never resurrected by a past snapshot');

    const disputedSnapshot = await context(store, { asOf: asOf('03'), includeDisputed: true });
    assert.match(disputedSnapshot.text, /DISPUTED — unresolved/);
    assert.match(disputedSnapshot.text, /Bridge route uses tunnel beta/);

    const historicalSnapshot = await context(store, { asOf: asOf('04', '13'), maxFacts: 3 });
    const historicalFacts = parseFacts(historicalSnapshot.text,
      'HISTORICAL FACTS — RECORDED STANDING AS OF 2026-09-04T13:00:00.000Z');
    assert.ok(historicalFacts.some((fact) => fact.id === historicalId && fact.status === 'historical'));
    assert.ok(historicalFacts.some((fact) => fact.id === supersededId && fact.status === 'superseded'));
    assert.ok(historicalFacts.some((fact) => fact.id === revisedId && fact.status === 'active'));
    assert.ok(historicalFacts.some((fact) => /HISTORICAL/.test(fact.warning)));
    assert.ok(historicalFacts.some((fact) => /SUPERSEDED/.test(fact.warning)));
    assert.ok(historicalFacts.every((fact) => fact.id !== rejectedId && fact.id !== foreignAgentId && fact.id !== foreignProjectId));
    assert.doesNotMatch(historicalSnapshot.text, /PRIVATE_LINEAGE/);

    const boundedSnapshot = await context(store, { asOf: asOf('04', '13'), maxFacts: 1 });
    assert.equal(boundedSnapshot.factCount, 1, 'explicit history retrieval still honors caller fact budgets');
    const boundedLabel = 'HISTORICAL FACTS — RECORDED STANDING AS OF 2026-09-04T13:00:00.000Z';
    assert.equal(parseFacts(boundedSnapshot.text, boundedLabel).length, 1);

    assert.equal(await store.getById({ lineageId, id: rejectedId, asOf: asOf('02') }), null,
      'the store must keep rejected content excluded even when the requested recorded snapshot predates rejection');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('as-of reconstruction follows append order and rejects a non-monotonic revision timestamp', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-asof-order-'));
  const store = new DatedMemoryStore({ root });
  const id = memoryId('8');
  try {
    await store.append({ id, lineageId, agentId: 'agent-exampleagent', createdAt: asOf('01', '10'),
      text: 'The initial bridge fact.', contextScope: scope });
    await store.appendRevision({ lineageId, id, expectedRevision: 0, createdAt: asOf('03'), by: 'owner:qa',
      why: 'Append a later correction', changes: { text: 'The corrected bridge fact.' } });
    await assert.rejects(store.appendRevision({ lineageId, id, expectedRevision: 1, createdAt: asOf('02'),
      by: 'owner:qa', why: 'Out-of-order timestamp must fail closed', changes: { text: 'Wrong order.' } }),
    /cannot predate its current revision/);

    const past = await store.getById({ lineageId, id, asOf: asOf('02') });
    const present = await store.getById({ lineageId, id, asOf: asOf('04') });
    assert.equal(past.text, 'The initial bridge fact.');
    assert.equal(past.revision, 0);
    assert.equal(present.text, 'The corrected bridge fact.');
    assert.equal(present.revision, 1);
    const contextAtPast = await context(store, { asOf: asOf('02') });
    assert.match(contextAtPast.text, /The initial bridge fact/);
    assert.doesNotMatch(contextAtPast.text, /The corrected bridge fact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('historical context keeps scoped UTF-8 fact output inside its byte budget', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'hexigrid-memory-asof-budget-'));
  const store = new DatedMemoryStore({ root });
  const id = memoryId('9');
  try {
    await store.append({ id, lineageId, agentId: 'agent-exampleagent', createdAt: asOf('01', '10'),
      text: `Bridge route ${'東京🙂'.repeat(200)}`, evidence_excerpt: `Source ${'証拠'.repeat(100)}`,
      status: 'active', valid_while: 'the selected topic remains active', contextScope: scope });
    const maxFactBytes = 760;
    const bounded = await context(store, { asOf: asOf('02'), maxFacts: 1, maxFactBytes });
    const label = `HISTORICAL FACTS — RECORDED STANDING AS OF ${asOf('02')}`;
    const sectionStart = bounded.text.indexOf(`[${label}]`);
    const sectionEnd = bounded.text.indexOf('\n[[END HEXIGRID MEMORY DATA]]', sectionStart);
    assert.ok(sectionStart >= 0);
    assert.ok(Buffer.byteLength(bounded.text.slice(sectionStart, sectionEnd), 'utf8') <= maxFactBytes);
    const [fact] = parseFacts(bounded.text, label);
    assert.equal(fact.status, 'active');
    assert.equal(fact.valid_while, 'the selected topic remains active');
    assert.ok(fact.text_truncated);
    assert.equal(Object.hasOwn(fact, 'evidence_excerpt'), false);
    assert.doesNotMatch(bounded.text, /証拠/);
    assert.doesNotMatch(bounded.text, /\uFFFD/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
