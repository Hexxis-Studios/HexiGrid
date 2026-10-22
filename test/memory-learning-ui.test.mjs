import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const helperStart = appSource.indexOf('function memoryLearningPauseState(');
const helperEnd = appSource.indexOf('\nfunction renderAll(', helperStart);
assert.notEqual(helperStart, -1);
assert.notEqual(helperEnd, -1);
const memoryLearningUiSource = `let memoryLearningResumePending = false;\nlet memoryLearningResumeMessage = '';\n${appSource.slice(helperStart, helperEnd)}`;

function makeNode() {
  const classes = new Set(['hidden']);
  return {
    hidden: false, disabled: false, textContent: '',
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    }
  };
}

function harness({ data, approvedRequest = async () => ({}), refresh = async () => {}, notify = () => {} }) {
  const nodes = new Map([
    ['#memoryLearningPausedNotice', makeNode()],
    ['#memoryLearningResume', makeNode()],
    ['#memoryLearningPausedReason', makeNode()],
    ['#memoryLearningPausedMessage', makeNode()]
  ]);
  const state = { data };
  const context = vm.createContext({ state, $(selector) { return nodes.get(selector); },
    approvedRequest, refresh, notify, JSON, String });
  vm.runInContext(memoryLearningUiSource, context);
  return { context, state, nodes };
}

test('Memory page stays neutral when pause state is unknown or learning is not confirmed running', () => {
  assert.match(pageSource, /class="panel hidden" id="memoryLearningPausedNotice"/);
  assert.match(pageSource, /data-action="resume-memory-learning"/);
  assert.doesNotMatch(pageSource, /Your agents keep learning locally/);
  assert.match(appSource, /if \(action === "resume-memory-learning"\) \{ await resumeMemoryLearning\(\); return; \}/);

  for (const data of [
    { settings: {} },
    { memoryLearning: { paused: false, workerStarted: false }, settings: { memoryLearningPaused: true } },
    { settings: { memoryLearningPaused: false } }
  ]) {
    const ui = harness({ data });
    ui.context.renderMemoryLearningNotice();
    assert.equal(ui.nodes.get('#memoryLearningPausedNotice').classList.contains('hidden'), true);
    assert.equal(ui.nodes.get('#memoryLearningResume').hidden, true);
    assert.equal(ui.nodes.get('#memoryLearningPausedReason').textContent, '');
    assert.doesNotMatch(ui.nodes.get('#memoryLearningPausedNotice').textContent || '', /learning is enabled/i);
  }
});

test('Stop and restore pause reasons are readable and internal codes are never shown', () => {
  const ui = harness({ data: { memoryLearning: { paused: true, pauseReason: 'emergency-stop', workerStarted: false } } });
  ui.context.renderMemoryLearningNotice();
  assert.equal(ui.nodes.get('#memoryLearningPausedNotice').classList.contains('hidden'), false);
  assert.equal(ui.nodes.get('#memoryLearningResume').hidden, false);
  assert.match(ui.nodes.get('#memoryLearningPausedReason').textContent, /paused by Stop/);
  assert.doesNotMatch(ui.nodes.get('#memoryLearningPausedReason').textContent, /emergency-stop/);

  ui.state.data.memoryLearning.pauseReason = 'restore-review';
  ui.context.renderMemoryLearningNotice();
  assert.match(ui.nodes.get('#memoryLearningPausedReason').textContent, /after restoring a backup/);
  assert.doesNotMatch(ui.nodes.get('#memoryLearningPausedReason').textContent, /restore-review/);

  ui.state.data = { settings: { memoryLearningPaused: true, memoryLearningPauseReason: 'restore-review' } };
  ui.context.renderMemoryLearningNotice();
  assert.match(ui.nodes.get('#memoryLearningPausedReason').textContent, /Review the restored memories/);
});

test('resume uses the existing approval helper, disables duplicates, and renders only confirmed status', async () => {
  let resolveRequest;
  let requests = 0, refreshes = 0;
  const notifications = [];
  const ui = harness({ data: { memoryLearning: { paused: true, pauseReason: 'owner-review', workerStarted: false }, settings: {} },
    approvedRequest(url, options, approvalText) {
      requests += 1;
      assert.equal(url, '/api/memory-learning/resume');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), {});
      assert.match(approvalText, /current policy still applies/i);
      assert.match(approvalText, /saved as unverified memories/i);
      assert.match(approvalText, /queued for owner review/i);
      assert.match(approvalText, /does not verify whether any claim is true/i);
      return new Promise(resolve => { resolveRequest = resolve; });
    },
    async refresh() { refreshes += 1; return true; },
    notify(message, error) { notifications.push({ message, error }); }
  });
  ui.context.renderMemoryLearningNotice();
  const first = ui.context.resumeMemoryLearning();
  assert.equal(ui.nodes.get('#memoryLearningResume').disabled, true);
  const duplicate = ui.context.resumeMemoryLearning();
  assert.equal(requests, 1);
  resolveRequest({ memoryLearning: { paused: false, pauseReason: '', workerStarted: true },
    settings: { memoryLearningPaused: false, memoryLearningPauseReason: '' } });
  await Promise.all([first, duplicate]);
  assert.equal(refreshes, 1);
  assert.equal(ui.state.data.memoryLearning.paused, false);
  assert.equal(ui.nodes.get('#memoryLearningPausedNotice').classList.contains('hidden'), true);
  assert.deepEqual(notifications, [{ message: 'Automatic memory learning resumed.', error: undefined }]);
});

test('resume failure leaves the notice actionable and reports a safe policy explanation', async () => {
  let refreshes = 0;
  const ui = harness({ data: { memoryLearning: { paused: true, pauseReason: 'restore-review', workerStarted: false } },
    async approvedRequest() { throw new Error('Synthetic policy denial with internal connector details'); },
    async refresh() { refreshes += 1; return true; },
    notify() { throw new Error('A paused failure should stay in the Memory notice.'); }
  });
  ui.context.renderMemoryLearningNotice();
  await ui.context.resumeMemoryLearning();
  assert.equal(refreshes, 1);
  assert.equal(ui.state.data.memoryLearning.paused, true);
  assert.equal(ui.nodes.get('#memoryLearningPausedNotice').classList.contains('hidden'), false);
  assert.equal(ui.nodes.get('#memoryLearningResume').hidden, false);
  assert.equal(ui.nodes.get('#memoryLearningResume').disabled, false);
  assert.match(ui.nodes.get('#memoryLearningPausedMessage').textContent, /approval policy did not allow resume/);
  assert.match(ui.nodes.get('#memoryLearningPausedMessage').textContent, /remains paused/);
  assert.doesNotMatch(ui.nodes.get('#memoryLearningPausedMessage').textContent, /internal connector details/);
});

test('an unconfirmed resume response keeps the last known pause visible without claiming the server is current', async () => {
  const ui = harness({ data: { memoryLearning: { paused: true, pauseReason: 'owner-review', workerStarted: false } },
    async approvedRequest() { return {}; }, async refresh() { return false; } });
  ui.context.renderMemoryLearningNotice();
  await ui.context.resumeMemoryLearning();
  assert.equal(ui.nodes.get('#memoryLearningPausedNotice').classList.contains('hidden'), false);
  assert.match(ui.nodes.get('#memoryLearningPausedMessage').textContent, /last confirmed status is paused/);
  assert.match(ui.nodes.get('#memoryLearningPausedMessage').textContent, /could not be checked/);
  assert.doesNotMatch(ui.nodes.get('#memoryLearningPausedMessage').textContent, /server still reports/);
});
