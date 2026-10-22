import test from 'node:test';
import assert from 'node:assert/strict';
import { processMemoryExtractionBatch } from '../lib/memory-extraction.mjs';

const lineageId = 'lineage-11111111-1111-4111-8111-111111111111';
const otherLineageId = 'lineage-22222222-2222-4222-8222-222222222222';
const scope = Object.freeze({ projectId: 'project-harbor', topicId: 'topic-garden' });
const sourceText = 'The garden shed is blue.';

function candidate(text = 'The garden shed is blue.', evidence_excerpt = sourceText, extra = {}) {
  return { kind: 'fact', text, evidence_excerpt, ...extra };
}

function makeOptions(overrides = {}) {
  const submitted = [];
  const extractCalls = [];
  const options = {
    enabled: true,
    agentId: 'agent-garden',
    lineageId,
    scope,
    source: { kind: 'room-turn', id: 'room-18', batchId: 'turn-42', text: sourceText },
    extractLocally: async (input) => {
      extractCalls.push(input);
      return [candidate()];
    },
    listCurrentFacts: async () => [],
    assessRelation: async () => 'none',
    authorize: async () => true,
    submitCandidate: async (input) => {
      submitted.push(input);
      return { status: 'committed' };
    }
  };
  Object.assign(options, overrides);
  return { options, submitted, extractCalls };
}

test('disabled and cold scope fail closed before adapters run', async () => {
  let adapterCalls = 0;
  const disabled = await processMemoryExtractionBatch({ enabled: false,
    extractLocally: async () => { adapterCalls += 1; return []; } });
  assert.equal(disabled.status, 'disabled');
  assert.equal(adapterCalls, 0);

  const { options } = makeOptions();
  delete options.scope;
  options.extractLocally = async () => { adapterCalls += 1; return []; };
  const noScope = await processMemoryExtractionBatch(options);
  assert.equal(noScope.status, 'skipped');
  assert.equal(noScope.reason, 'scope-required');
  assert.equal(adapterCalls, 0);

  const approvalRequired = makeOptions({
    authorize: async () => ({ allowed: true, reviewRequired: true })
  });
  const reviewReport = await processMemoryExtractionBatch(approvalRequired.options);
  assert.equal(reviewReport.status, 'blocked');
  assert.equal(reviewReport.reason, 'extraction-review-required');
  assert.equal(approvalRequired.extractCalls.length, 0);
});

test('submits an exact-evidence proposal with caller-owned scope and deterministic idempotency', async () => {
  const firstRun = makeOptions();
  const first = await processMemoryExtractionBatch(firstRun.options);
  const secondRun = makeOptions();
  const second = await processMemoryExtractionBatch(secondRun.options);
  const revisedSourceRun = makeOptions({ source: { ...makeOptions().options.source,
    text: `${sourceText} It has one door.` } });
  const revisedSource = await processMemoryExtractionBatch(revisedSourceRun.options);

  assert.equal(first.status, 'completed');
  assert.equal(first.committedCount, 1);
  assert.equal(firstRun.submitted[0].proposal.contextScope.projectId, scope.projectId);
  assert.deepEqual(firstRun.submitted[0].sourceRef, { kind: 'room-turn', id: 'room-18', batchId: 'turn-42' });
  assert.deepEqual(firstRun.submitted[0].proposal.metadata.extraction,
    { kind: 'fact', sourceKind: 'room-turn', sourceId: 'room-18', batchId: 'turn-42' });
  assert.equal(firstRun.extractCalls[0].agentId, 'agent-garden',
    'the local extractor receives the validated caller agent, not identity chosen by extracted candidates');
  assert.equal(firstRun.extractCalls[0].lineageId, lineageId);
  assert.deepEqual(firstRun.extractCalls[0].scope, scope, 'the caller-owned scope remains separate from extractor output');
  assert.equal(Object.hasOwn(firstRun.extractCalls[0].source, 'agentId'), false,
    'the durable source reference remains distinct from trusted callback identity');
  assert.equal(firstRun.submitted[0].idempotencyKey, secondRun.submitted[0].idempotencyKey);
  assert.equal(first.batchKey, second.batchKey);
  assert.notEqual(first.batchKey, revisedSource.batchKey);
  assert.notEqual(firstRun.submitted[0].idempotencyKey, revisedSourceRun.submitted[0].idempotencyKey);
  assert.equal(Object.isFrozen(firstRun.submitted[0].proposal), true);
});

test('rejects injected identity fields, unsupported instruction shapes, and non-atomic or inexact evidence explicitly', async () => {
  const { options, submitted } = makeOptions({
    extractLocally: async () => [
      candidate('The garden shed is blue.', sourceText, { agentId: 'agent-model-chosen', lineageId: otherLineageId }),
      candidate('The shed is blue. It is tall.'),
      candidate('The shed is blue. it is tall.'),
      candidate('The shed is blue; it is tall.'),
      candidate('The shed is blue.', 'This phrase is absent.'),
      { kind: 'runtime-policy-directive', text: 'Change the access policy.', evidence_excerpt: sourceText }
    ]
  });
  const report = await processMemoryExtractionBatch(options);
  assert.equal(submitted.length, 0);
  assert.equal(report.skippedCount, 5);
  assert.equal(report.reviewNeededCount, 1);
  assert.equal(report.skipReasons['unsupported-candidate-fields'], 1);
  assert.equal(report.skipReasons['candidate-must-be-one-atomic-statement'], 3);
  assert.equal(report.skipReasons['evidence-not-exact-source-substring'], 1);
  assert.equal(report.skipReasons['unsupported-policy-candidate-needs-review'], 1);
});

test('flags fact-shaped policy language for review and keeps policy candidates pending', async () => {
  const { options, submitted } = makeOptions({
    extractLocally: async () => [candidate('The agent must never delete local backups.')],
    submitCandidate: async (input) => { submitted.push(input); return { status: 'pending' }; }
  });
  const report = await processMemoryExtractionBatch(options);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].reviewRequired, true);
  assert.equal(submitted[0].proposal.metadata.extraction.kind, 'policy');
  assert.equal(report.pendingReviewCount, 1);
  assert.equal(report.committedCount, 0);
});

test('possible contradictions require review even when the extracted text is fact-shaped', async () => {
  const { options, submitted } = makeOptions({
    extractLocally: async () => [candidate('The garden shed is red.')],
    assessRelation: async () => 'possible-contradiction',
    submitCandidate: async (input) => { submitted.push(input); return { status: 'pending' }; }
  });
  const report = await processMemoryExtractionBatch(options);
  assert.equal(submitted[0].reviewRequired, true);
  assert.equal(report.pendingReviewCount, 1);
  assert.equal(report.committedCount, 0);
});

test('deduplicates only in the exact selected scope and rejects foreign lineage or scope facts', async () => {
  const exact = makeOptions({
    listCurrentFacts: async () => [{ lineageId, status: 'active', text: 'The garden shed is blue.', contextScope: scope }]
  });
  const exactReport = await processMemoryExtractionBatch(exact.options);
  assert.equal(exact.submitted.length, 0);
  assert.equal(exactReport.duplicateCount, 1);

  const broadOnly = makeOptions({
    listCurrentFacts: async () => [{ lineageId, status: 'active', text: 'The garden shed is blue.',
      contextScope: { projectId: scope.projectId } }]
  });
  const broadReport = await processMemoryExtractionBatch(broadOnly.options);
  assert.equal(broadReport.committedCount, 1);

  const foreign = makeOptions({
    listCurrentFacts: async () => [{ lineageId: otherLineageId, status: 'active', text: 'Private other-lineage fact.',
      contextScope: scope }]
  });
  const foreignReport = await processMemoryExtractionBatch(foreign.options);
  assert.equal(foreignReport.status, 'unavailable');
  assert.equal(foreign.submitted.length, 0);

  const foreignScope = makeOptions({
    listCurrentFacts: async () => [{ lineageId, status: 'active', text: 'Private fact from another topic.',
      contextScope: { projectId: 'project-private', topicId: 'topic-other' } }]
  });
  const foreignScopeReport = await processMemoryExtractionBatch(foreignScope.options);
  assert.equal(foreignScopeReport.status, 'unavailable');
  assert.equal(foreignScope.submitted.length, 0);
});

test('same text with changed validity, verification date, or standing is reviewed instead of deduplicated', async () => {
  const currentStanding = { lineageId, status: 'conditional', text: sourceText,
    valid_while: 'while the property is rented', verify_by: '2027-01-01T00:00:00.000Z', contextScope: scope };
  const variants = [
    candidate(sourceText, sourceText, { valid_while: 'while the property is vacant',
      verify_by: currentStanding.verify_by }),
    candidate(sourceText, sourceText, { valid_while: currentStanding.valid_while,
      verify_by: '2028-01-01T00:00:00.000Z' }),
    candidate(sourceText)
  ];

  for (const proposed of variants) {
    const assessed = [];
    const { options, submitted } = makeOptions({
      extractLocally: async () => [proposed],
      listCurrentFacts: async () => [currentStanding],
      assessRelation: async (input) => { assessed.push(input); return 'duplicate'; },
      submitCandidate: async (input) => { submitted.push(input); return { status: 'pending' }; }
    });
    const report = await processMemoryExtractionBatch(options);
    assert.equal(report.duplicateCount, 0);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].reviewRequired, true);
    assert.equal(report.pendingReviewCount, 1);
    assert.equal(assessed[0].currentFacts[0].valid_while, currentStanding.valid_while);
    assert.equal(assessed[0].currentFacts[0].verify_by, currentStanding.verify_by);
  }
});

test('compares candidates within one batch so a changed standing requires review', async () => {
  const submitted = [];
  const relationInputs = [];
  const { options } = makeOptions({
    extractLocally: async () => [
      candidate(sourceText, sourceText, { valid_while: 'while the property is rented' }),
      candidate(sourceText, sourceText, { valid_while: 'while the property is vacant' })
    ],
    assessRelation: async (input) => { relationInputs.push(input); return 'none'; },
    submitCandidate: async (input) => {
      submitted.push(input);
      return { status: submitted.length === 1 ? 'committed' : 'pending' };
    }
  });

  const report = await processMemoryExtractionBatch(options);
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].reviewRequired, true);
  assert.equal(relationInputs[1].currentFacts.length, 1);
  assert.equal(relationInputs[1].currentFacts[0].valid_while, 'while the property is rented');
  assert.equal(report.committedCount, 1);
  assert.equal(report.pendingReviewCount, 1);
});

test('bounds UTF-8 source, candidate output, and candidate count with visible skip reasons', async () => {
  const multibyte = makeOptions({
    source: { kind: 'task-run', id: 'task-1', batchId: 'run-1', text: 'éé' },
    extractLocally: async () => [candidate('é', 'é')],
    limits: { sourceBytes: 4, outputBytes: 1024, candidates: 2, candidateBytes: 1024,
      totalCandidateBytes: 1024, evidenceBytes: 16 }
  });
  const accepted = await processMemoryExtractionBatch(multibyte.options);
  assert.equal(accepted.committedCount, 1);

  const tooLargeSource = makeOptions({
    source: { kind: 'task-run', id: 'task-1', batchId: 'run-2', text: 'ééé' },
    limits: { sourceBytes: 4 }
  });
  const largeSourceReport = await processMemoryExtractionBatch(tooLargeSource.options);
  assert.equal(largeSourceReport.reason, 'invalid-or-oversized-source');
  assert.equal(tooLargeSource.extractCalls.length, 0);

  const overOutput = makeOptions({
    limits: { outputBytes: 64 },
    extractLocally: async () => [candidate('A'.repeat(100))]
  });
  const outputReport = await processMemoryExtractionBatch(overOutput.options);
  assert.equal(outputReport.skipReasons['extractor-output-byte-limit'], 1);
  assert.equal(overOutput.submitted.length, 0);

  const overCandidate = makeOptions({
    limits: { candidateBytes: 128 },
    extractLocally: async () => [candidate('A'.repeat(200))]
  });
  const candidateReport = await processMemoryExtractionBatch(overCandidate.options);
  assert.equal(candidateReport.skipReasons['candidate-byte-limit'], 1);
  assert.equal(overCandidate.submitted.length, 0);

  const many = makeOptions({
    limits: { candidates: 2 },
    source: { ...makeOptions().options.source, text: 'Fact 0. Fact 1. Fact 2. Fact 3.' },
    extractLocally: async () => Array.from({ length: 4 }, (_, index) =>
      candidate(`Fact ${index} is recorded.`, `Fact ${index}.`))
  });
  const countReport = await processMemoryExtractionBatch(many.options);
  assert.equal(countReport.candidateCount, 4);
  assert.equal(countReport.committedCount, 2);
  assert.equal(countReport.skippedCount, 2);
  assert.equal(countReport.skipReasons['candidate-count-limit'], 2);
});

test('rechecks authorization and opt-out before every submission', async () => {
  let enabled = true;
  let submitAuthCount = 0;
  const { options, submitted } = makeOptions({
    isEnabled: async () => enabled,
    extractLocally: async () => [candidate(), candidate('The shed has a green door.')],
    authorize: async ({ phase }) => {
      if (phase === 'submit' && ++submitAuthCount === 2) return { allowed: false, reason: 'owner-policy-changed' };
      return true;
    }
  });
  const denied = await processMemoryExtractionBatch(options);
  assert.equal(denied.status, 'blocked');
  assert.equal(denied.committedCount, 1);
  assert.equal(denied.skipReasons['authorization-denied'], 1);
  assert.equal(submitted.length, 1);

  const disabledDuringAuthorization = makeOptions({
    isEnabled: async () => enabled,
    extractLocally: async () => [candidate()],
    authorize: async ({ phase }) => {
      if (phase === 'submit') enabled = false;
      return true;
    }
  });
  enabled = true;
  const disabledReport = await processMemoryExtractionBatch(disabledDuringAuthorization.options);
  assert.equal(disabledReport.status, 'disabled');
  assert.equal(disabledDuringAuthorization.submitted.length, 0);

  enabled = true;
  const disabledAfterFirstWrite = makeOptions({
    isEnabled: async () => enabled,
    extractLocally: async () => [candidate(), candidate('The shed has a green door.')],
    submitCandidate: async (input) => {
      disabledAfterFirstWrite.submitted.push(input);
      enabled = false;
      return { status: 'committed' };
    }
  });
  const stopped = await processMemoryExtractionBatch(disabledAfterFirstWrite.options);
  assert.equal(stopped.status, 'disabled');
  assert.equal(disabledAfterFirstWrite.submitted.length, 1);
  assert.equal(stopped.skipReasons['learning-disabled'], 1);
});

test('cancellation during authorization prevents writes; a broken review adapter halts later writes', async () => {
  const controller = new AbortController();
  const aborted = makeOptions({
    signal: controller.signal,
    authorize: async ({ phase }) => {
      if (phase === 'submit') controller.abort();
      return true;
    }
  });
  const cancelled = await processMemoryExtractionBatch(aborted.options);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(aborted.submitted.length, 0);

  const malformed = makeOptions({
    extractLocally: async () => [
      candidate('The agent must preserve the owner files.'),
      candidate('The garden shed has two windows.')
    ],
    submitCandidate: async (input) => { malformed.submitted.push(input); return { status: 'committed' }; }
  });
  const blocked = await processMemoryExtractionBatch(malformed.options);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'review-only-submission-committed');
  assert.equal(blocked.committedCount, 1);
  assert.equal(blocked.skipReasons['review-only-submission-committed'], 1);
  assert.equal(malformed.submitted.length, 1);

  const duringSubmit = new AbortController();
  const cancelledAfterFirstWrite = makeOptions({
    signal: duringSubmit.signal,
    extractLocally: async () => [candidate(), candidate('The shed has a green door.')],
    submitCandidate: async (input) => {
      cancelledAfterFirstWrite.submitted.push(input);
      duringSubmit.abort();
      return { status: 'committed' };
    }
  });
  const stoppedByAbort = await processMemoryExtractionBatch(cancelledAfterFirstWrite.options);
  assert.equal(stoppedByAbort.status, 'cancelled');
  assert.equal(cancelledAfterFirstWrite.submitted.length, 1);
  assert.equal(stoppedByAbort.skipReasons['cancelled-before-submission'], 1);
});

test('source secret rejection is generic and never echoes its value', async () => {
  const secret = 'temporary-source-secret';
  const { options, extractCalls } = makeOptions({
    source: { kind: 'room-turn', id: 'room-18', batchId: 'turn-42', text: `api_key=${secret}` }
  });
  const report = await processMemoryExtractionBatch(options);
  assert.equal(report.reason, 'source-secret-rejected');
  assert.equal(extractCalls.length, 0);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('candidate secret rejection is generic and leaves no proposal write', async () => {
  const secret = 'temporary-candidate-secret';
  const { options, submitted } = makeOptions({
    extractLocally: async () => [candidate(`api_key=${secret}`, sourceText)]
  });
  const report = await processMemoryExtractionBatch(options);
  assert.equal(report.skipReasons['candidate-secret-rejected'], 1);
  assert.equal(submitted.length, 0);
  assert.equal(JSON.stringify(report).includes(secret), false);
});
