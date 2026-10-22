import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/view-renderers.js', import.meta.url), 'utf8');
function reviewHarness(request) {
  const nodes = new Map(['List', 'Count', 'Status', 'Refresh'].map(name => [`#memoryReview${name}`, {
    innerHTML: '', textContent: '', disabled: false, listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; }
  }]));
  const context = { window: {}, Intl, Date };
  vm.runInNewContext(source, context);
  const ui = context.window.HexiGridViewRenderers.createMemoryReview({
    root: { querySelector: selector => nodes.get(selector) }, request,
    agents: () => [{ id: 'test-agent', name: 'QA agent' }]
  });
  return { ui, nodes };
}

test('quarantine is visibly excluded, escaped, and has no approval action', async () => {
  const harness = reviewHarness(async () => ({ proposals: [
    { id: 'quarantine-test', agentId: 'test-agent', kind: 'risk-quarantine',
      riskReasonCodes: ['delayed_prompt_injection'], payload: { text: '<script>never execute</script>' } },
    { id: 'normal-test', agentId: 'test-agent', kind: 'create', payload: { text: 'The studio uses cedar.' } }
  ] }));
  await harness.ui.refresh();
  const html = harness.nodes.get('#memoryReviewList').innerHTML;
  const quarantine = html.slice(html.indexOf('data-memory-review-id="quarantine-test"'), html.indexOf('data-memory-review-id="normal-test"'));
  assert.match(quarantine, /Quarantined candidate/);
  assert.match(quarantine, /Excluded from memory and recall/);
  assert.match(quarantine, /&lt;script&gt;/);
  assert.doesNotMatch(quarantine, /data-memory-decision="approve"/);
  assert.match(quarantine, /data-memory-decision="reject"/);
  assert.match(html.slice(html.indexOf('data-memory-review-id="normal-test"')), /data-memory-decision="approve"/);
});

test('a forged approval click cannot submit quarantine, but rejection still works', async () => {
  const requests = [];
  let pending = true;
  const harness = reviewHarness(async (url, options) => {
    requests.push({ url, options });
    if (options) { pending = false; return { status: 'rejected' }; }
    return { proposals: pending ? [{ id: 'quarantine-test', kind: 'risk-quarantine', agentId: 'test-agent', payload: { text: 'Synthetic candidate' } }] : [] };
  });
  await harness.ui.refresh();
  const actions = [{ disabled: false }];
  const card = { dataset: { memoryReviewId: 'quarantine-test' },
    querySelector: () => ({ value: 'Discard QA candidate' }), querySelectorAll: () => actions };
  const button = { disabled: false, dataset: { memoryDecision: 'approve' }, closest: () => card };
  const event = { target: { closest: () => button } };
  const click = harness.nodes.get('#memoryReviewList').listeners.click;
  await click(event);
  assert.equal(requests.length, 1);
  assert.match(harness.nodes.get('#memoryReviewStatus').textContent, /cannot be approved/);
  button.dataset.memoryDecision = 'reject';
  await click(event);
  assert.equal(requests.filter(row => row.options).length, 1);
  assert.equal(JSON.parse(requests[1].options.body).decision, 'reject');
  assert.equal(harness.nodes.get('#memoryReviewCount').textContent, '(0)');
});

test('approved owner-note capture offers finish and stop-retry while withholding rejection', async () => {
  const requests = [];
  let capturePending = true;
  let retryCount = 0;
  const proposal = {
    id: 'owner-correction-capture', agentId: 'test-agent', kind: 'owner-memory-correction',
    capturePending: true, captureIntent: 'private-capture-intent', captureHash: 'private-capture-hash',
    payload: { text: 'The committed owner note already says use the updated route.', why: 'Preserve the correction record.' }
  };
  const harness = reviewHarness(async (url, options) => {
    requests.push({ url, options });
    if (options) {
      assert.deepEqual(JSON.parse(options.body), { decision: 'approve' });
      retryCount += 1;
      if (retryCount === 1) return { status: 'approved', ownerNote: true, ownerNoteCaptureState: 'pending', capturePending: true };
      capturePending = false;
      return { status: 'approved', ownerNote: true, ownerNoteCaptureState: 'complete', captureComplete: true };
    }
    return { proposals: capturePending ? [proposal] : [] };
  });
  await harness.ui.refresh();
  const list = harness.nodes.get('#memoryReviewList');
  const html = list.innerHTML;
  assert.match(html, /Saved owner note · correction record unfinished/);
  assert.match(html, /owner note is already saved/i);
  assert.match(html, /Finish correction record/);
  assert.match(html, /Stop retry/);
  assert.match(html, /any existing correction evidence unchanged/i);
  assert.doesNotMatch(html, /Approve as unverified|data-memory-decision="reject"|Reason to reject/);
  assert.doesNotMatch(html, /private-capture-intent|private-capture-hash/);

  let inputLookupCount = 0;
  const action = { disabled: false };
  const card = { dataset: { memoryReviewId: proposal.id },
    querySelector() { inputLookupCount += 1; return null; }, querySelectorAll: () => [action] };
  const button = { disabled: false, dataset: { memoryDecision: 'reject' }, closest: () => card };
  const click = list.listeners.click;
  await click({ target: { closest: () => button } });
  assert.equal(requests.filter(row => row.options).length, 0, 'rejecting a committed note must never dispatch');
  assert.equal(inputLookupCount, 0);
  assert.match(harness.nodes.get('#memoryReviewStatus').textContent, /cannot be rejected as though the note were undone/);

  button.dataset.memoryDecision = 'approve';
  await click({ target: { closest: () => button } });
  assert.equal(requests.filter(row => row.options).length, 1);
  assert.equal(JSON.parse(requests.find(row => row.options).options.body).decision, 'approve');
  assert.match(harness.nodes.get('#memoryReviewStatus').textContent, /Note saved; correction record is still unfinished\. Retry when available\./);
  assert.match(list.innerHTML, /Finish correction record/);
  assert.doesNotMatch(list.innerHTML, /data-memory-decision="reject"|Reason to reject/);

  await click({ target: { closest: () => button } });
  assert.equal(requests.filter(row => row.options).length, 2);
  assert.match(harness.nodes.get('#memoryReviewStatus').textContent, /owner note is saved and the correction record is finished/i);
  assert.equal(harness.nodes.get('#memoryReviewCount').textContent, '(0)');
});

test('stopping an unfinished owner-note capture keeps retry visible after failure and removes it after success', async () => {
  const requests = [];
  let capturePending = true;
  let discardAttempts = 0;
  const proposal = {
    id: 'owner-correction-discard', agentId: 'test-agent', kind: 'owner-memory-correction',
    capturePending: true,
    payload: { text: 'The later owner note remains untouched.', why: 'The old correction record cannot be finished.' }
  };
  const harness = reviewHarness(async (url, options) => {
    requests.push({ url, options });
    if (options) {
      assert.deepEqual(JSON.parse(options.body), { decision: 'discard-capture' });
      discardAttempts += 1;
      if (discardAttempts === 1) throw new Error('The exact saved capture is no longer current.');
      capturePending = false;
      return { status: 'approved', ownerNote: true, ownerNoteCaptureState: 'discarded',
        capturePending: false, captureDiscarded: true };
    }
    return { proposals: capturePending ? [proposal] : [] };
  });
  await harness.ui.refresh();
  const list = harness.nodes.get('#memoryReviewList');
  const action = { disabled: false };
  const card = { dataset: { memoryReviewId: proposal.id }, querySelectorAll: () => [action] };
  const button = { disabled: false, dataset: { memoryDecision: 'discard-capture' }, closest: () => card };
  const click = list.listeners.click;

  await click({ target: { closest: () => button } });
  assert.equal(JSON.parse(requests.find(row => row.options).options.body).decision, 'discard-capture');
  assert.match(harness.nodes.get('#memoryReviewStatus').textContent, /retry remains pending/);
  assert.match(list.innerHTML, /Finish correction record|Stop retry/);
  assert.equal(action.disabled, false, 'a failed stop attempt leaves the controls usable');

  await click({ target: { closest: () => button } });
  assert.equal(discardAttempts, 2);
  assert.match(harness.nodes.get('#memoryReviewStatus').textContent, /saved owner note remains/i);
  assert.equal(harness.nodes.get('#memoryReviewCount').textContent, '(0)');
  assert.match(list.innerHTML, /No memory proposals need review/);
});

test('an ambiguous stop response refreshes the capture state instead of claiming retry is pending', async () => {
  let capturePending = true;
  const harness = reviewHarness(async (_url, options) => {
    if (options) {
      assert.deepEqual(JSON.parse(options.body), { decision: 'discard-capture' });
      capturePending = false;
      throw new Error('The response was lost after the save.');
    }
    return { proposals: capturePending ? [{ id: 'owner-correction-ambiguous-stop', agentId: 'test-agent',
      kind: 'owner-memory-correction', capturePending: true, payload: { text: 'Saved note.' } }] : [] };
  });
  await harness.ui.refresh();
  const card = { dataset: { memoryReviewId: 'owner-correction-ambiguous-stop' }, querySelectorAll: () => [] };
  const button = { disabled: false, dataset: { memoryDecision: 'discard-capture' }, closest: () => card };
  await harness.nodes.get('#memoryReviewList').listeners.click({ target: { closest: () => button } });
  assert.match(harness.nodes.get('#memoryReviewStatus').textContent, /Could not verify that the retry stopped/i);
  assert.match(harness.nodes.get('#memoryReviewStatus').textContent, /capture is no longer pending/i);
  assert.doesNotMatch(harness.nodes.get('#memoryReviewStatus').textContent, /retry remains pending/i);
  assert.equal(harness.nodes.get('#memoryReviewCount').textContent, '(0)');
});

test('an inactive-lineage capture offers only terminal cleanup and refuses a forged finish', async () => {
  const calls = [];
  let pending = true;
  const proposal = { id: 'old-lineage-capture', agentId: 'test-agent', kind: 'owner-memory-correction',
    capturePending: true, captureRetryUnavailable: true, payload: { text: 'Retained saved correction.' } };
  const harness = reviewHarness(async (_url, options) => {
    if (!options) return { proposals: pending ? [proposal] : [] };
    calls.push(JSON.parse(options.body));
    pending = false;
    return { captureDiscarded: true, capturePending: false };
  });
  await harness.ui.refresh();
  const list = harness.nodes.get('#memoryReviewList');
  assert.match(list.innerHTML, /inactive or replaced agent lineage/);
  assert.match(list.innerHTML, /Stop retry/);
  assert.doesNotMatch(list.innerHTML, /Finish correction record|data-memory-decision="approve"|data-memory-decision="reject"/);
  const card = { dataset: { memoryReviewId: proposal.id }, querySelectorAll: () => [] };
  const button = { disabled: false, dataset: { memoryDecision: 'approve' }, closest: () => card };
  await list.listeners.click({ target: { closest: () => button } });
  assert.equal(calls.length, 0);
  button.dataset.memoryDecision = 'discard-capture';
  await list.listeners.click({ target: { closest: () => button } });
  assert.deepEqual(calls, [{ decision: 'discard-capture' }]);
  assert.equal(harness.nodes.get('#memoryReviewCount').textContent, '(0)');
});