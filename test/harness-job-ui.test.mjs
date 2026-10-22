import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/harness-job-ui.js', import.meta.url), 'utf8');
const [shellSource, taskSource, indexSource] = await Promise.all([
  readFile(new URL('../public/control-shell.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/task-ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8')
]);

function ui() {
  const elements = new Map();
  let uuid = 0;
  const element = (selector) => {
    const id = selector.replace(/^#/, '');
    if (!elements.has(id)) elements.set(id, {
      id, value: '', textContent: '', disabled: false, options: [], listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; },
      replaceChildren(...children) { this.options = [...children]; this.value = children[0]?.value || ''; },
      append(option) { this.options.push(option); if (this.options.length === 1 && !this.value) this.value = option.value; }
    });
    return elements.get(id);
  };
  const calls = [], modals = [];
  const context = vm.createContext({
    document: { querySelector: element, createElement: () => ({ value: '', textContent: '' }) },
    window: { crypto: { randomUUID: () => `random-client-${++uuid}` } },
    state: { data: { agents: [
      { id: 'local-a', name: 'Local A', transport: 'local-opencode' },
      { id: 'paired-local', name: 'Paired local', transport: 'local-opencode' },
      { id: 'runner', name: 'External runner', transport: 'ilands-runner' },
      { id: 'revoked-local', name: 'Previously paired', transport: 'local-opencode' },
      { id: 'external', name: 'External link', transport: 'agent-link' }
    ], agentLinks: [{ agentId: 'paired-local', authorizationStatus: 'connected' }, { agentId: 'revoked-local', authorizationStatus: 'revoked' }] } },
    agentListLabel: (agent) => agent.name,
    api: async (url, options) => { calls.push({ url, options }); return {}; },
    encodeURIComponent,
    setTimeout,
    clearTimeout
  });
  context.window.hexigridModal = async (options) => { modals.push(options); return false; };
  vm.runInContext(source, context, { filename: 'harness-job-ui.js' });
  const qa = { context, calls, modals, element, uuidCount: () => uuid };
  context.window.HexiGridHarnessJobUi.render();
  return qa;
}

function submission(qa) {
  return qa.element('#harnessJobForm').listeners.submit({ preventDefault() {} });
}

test('one-shot panel is present on Tasks and loads after the Tasks renderer', () => {
  assert.match(shellSource, /id="harnessJobPanel"/);
  assert.match(shellSource, /maxlength="8000"/);
  assert.match(shellSource, />Run once<\/button>/);
  assert.match(shellSource, /Load recent jobs/);
  assert.match(shellSource, /Open selected job/);
  assert.match(shellSource, /Opening never runs it again/);
  assert.match(taskSource, /window\.HexiGridHarnessJobUi\?\.render\(\);/);
  assert.ok(indexSource.indexOf('src="/task-ui.js"') < indexSource.indexOf('src="/harness-job-ui.js"'));
});

test('uncertain retries reuse one cryptographic client ID; accepted attempts get a new ID', async () => {
  const qa = ui();
  qa.element('#harnessJobPrompt').value = 'Summarize synthetic notes once.';
  assert.deepEqual(qa.element('#harnessJobAgent').options.map((option) => option.value), ['local-a'], 'paired and external Links are excluded');
  assert.equal(qa.calls.length, 0, 'rendering does not run a job');
  let attempt = 0;
  qa.context.api = async (url, options) => {
    qa.calls.push({ url, options });
    if (++attempt === 1) throw new Error('Response unavailable');
    return { job: { id: 'job-one', agentId: 'local-a', status: 'completed' } };
  };
  await submission(qa);
  const first = JSON.parse(qa.calls[0].options.body);
  assert.equal(qa.element('#harnessJobPrompt').value, 'Summarize synthetic notes once.');
  await submission(qa);
  const second = JSON.parse(qa.calls[1].options.body);
  assert.equal(first.clientJobId, second.clientJobId);
  assert.equal(second.agentId, first.agentId);
  assert.equal(second.prompt, first.prompt);
  assert.equal(qa.uuidCount(), 1);
  assert.equal(qa.element('#harnessJobFeedback').textContent.includes(first.clientJobId), false, 'request ID is not displayed');
  await submission(qa);
  const third = JSON.parse(qa.calls[2].options.body);
  assert.notEqual(third.clientJobId, second.clientJobId, 'a new explicit run is a new attempt');
});

test('approval cancellation retains the draft and sends no approved retry', async () => {
  const qa = ui();
  qa.element('#harnessJobPrompt').value = 'Read a synthetic local note.';
  qa.context.api = async (url, options) => {
    qa.calls.push({ url, options });
    throw Object.assign(new Error('Owner approval is required.'), { body: { approvalRequired: true } });
  };
  await submission(qa);
  assert.equal(qa.calls.length, 1);
  assert.equal(qa.modals.length, 1);
  assert.equal(qa.element('#harnessJobPrompt').value, 'Read a synthetic local note.');
  assert.equal(JSON.parse(qa.calls[0].options.body).approved, undefined);
  assert.match(qa.element('#harnessJobFeedback').textContent, /Approval cancelled/);
});

test('approval confirmation retries the frozen request once with the same ID and approval flag', async () => {
  const qa = ui();
  qa.context.window.hexigridModal = async (options) => { qa.modals.push(options); return true; };
  qa.element('#harnessJobPrompt').value = 'One bounded approved request.';
  qa.context.api = async (url, options) => {
    qa.calls.push({ url, options });
    if (qa.calls.length === 1) throw Object.assign(new Error('Approval required.'), { body: { approvalRequired: true } });
    throw Object.assign(new Error('Approval is still required.'), { body: { approvalRequired: true } });
  };
  await submission(qa);
  assert.equal(qa.calls.length, 2, 'only one retry follows the confirmation');
  assert.equal(qa.modals.length, 1);
  const first = JSON.parse(qa.calls[0].options.body), retry = JSON.parse(qa.calls[1].options.body);
  assert.equal(first.agentId, retry.agentId);
  assert.equal(first.prompt, retry.prompt);
  assert.equal(first.clientJobId, retry.clientJobId);
  assert.equal(retry.approved, true);
  assert.equal(qa.element('#harnessJobPrompt').value, 'One bounded approved request.');
});

test('policy refusal keeps the user draft unchanged', async () => {
  const qa = ui();
  qa.element('#harnessJobPrompt').value = 'Keep this refused draft.';
  qa.context.api = async (url, options) => { qa.calls.push({ url, options }); throw new Error('Current policy refuses this request.'); };
  await submission(qa);
  assert.equal(qa.element('#harnessJobPrompt').value, 'Keep this refused draft.');
  assert.equal(qa.element('#harnessJobAgent').value, 'local-a');
  assert.match(qa.element('#harnessJobFeedback').textContent, /refuses this request/);
});

test('a response for another agent is not accepted as this attempt', async () => {
  const qa = ui();
  qa.element('#harnessJobPrompt').value = 'Exact target only.';
  qa.context.api = async () => ({ job: { id: 'wrong-job', agentId: 'another-agent', status: 'completed' } });
  await submission(qa);
  assert.match(qa.element('#harnessJobFeedback').textContent, /did not include this agent/);
  assert.match(qa.element('#harnessJobStatus').textContent, /No current job selected/);
  assert.equal(qa.element('#harnessJobPrompt').value, 'Exact target only.');
});

test('request controls lock while pending and progress/stop failures keep the tracked job', async () => {
  const qa = ui();
  qa.element('#harnessJobPrompt').value = 'Track one synthetic job.';
  let release;
  qa.context.api = (url, options) => {
    qa.calls.push({ url, options });
    return new Promise((resolve) => { release = resolve; });
  };
  const pending = submission(qa);
  await Promise.resolve();
  assert.equal(qa.element('#harnessJobPrompt').disabled, true);
  assert.equal(qa.element('#harnessJobAgent').disabled, true);
  assert.equal(qa.element('#harnessJobRun').disabled, true);
  assert.equal(qa.element('#harnessJobCheck').disabled, true);
  assert.equal(qa.element('#harnessJobStop').disabled, true);
  assert.equal(qa.element('#harnessJobLoadRecent').disabled, true);
  assert.equal(qa.element('#harnessJobRecent').disabled, true);
  release({ job: { id: 'exact-job', agentId: 'local-a', status: 'running' } });
  await pending;
  qa.context.api = async (url, options) => { qa.calls.push({ url, options }); throw new Error('Synthetic local request failure'); };
  await qa.element('#harnessJobCheck').listeners.click();
  assert.match(qa.element('#harnessJobStatus').textContent, /running/);
  assert.match(qa.element('#harnessJobFeedback').textContent, /tracked job was kept/);
  await qa.element('#harnessJobStop').listeners.click();
  assert.match(qa.element('#harnessJobStatus').textContent, /running/);
  assert.match(qa.element('#harnessJobFeedback').textContent, /tracked job was kept/);
  assert.equal(qa.calls[1].url, '/api/harness-jobs/exact-job');
  assert.equal(qa.calls[2].url, '/api/harness-jobs/exact-job/cancel');
});

test('Stop targets the exact tracked job and manual progress renders literal status, error, and output text', async () => {
  const qa = ui();
  const unsafeText = '<img src=x onerror=alert(1)>';
  qa.element('#harnessJobPrompt').value = 'Complete one synthetic run.';
  qa.context.api = async (url, options) => {
    qa.calls.push({ url, options });
    if (url === '/api/harness-jobs') return { job: { id: 'exact-job', agentId: 'local-a', status: 'running' } };
    if (url.endsWith('/cancel')) return { job: { id: 'exact-job', agentId: 'local-a', status: 'cancelled', error: '' } };
    return { job: { id: 'exact-job', agentId: 'local-a', status: 'completed', error: unsafeText, output: unsafeText } };
  };
  await submission(qa);
  assert.match(qa.element('#harnessJobFeedback').textContent, /acceptance does not mean the job is complete/);
  await qa.element('#harnessJobStop').listeners.click();
  assert.equal(qa.calls[1].url, '/api/harness-jobs/exact-job/cancel');
  assert.equal(qa.calls[1].options.method, 'POST');
  assert.equal(qa.calls[1].options.body, '{}');
  assert.match(qa.element('#harnessJobStatus').textContent, /cancelled/);
  await qa.element('#harnessJobCheck').listeners.click();
  assert.match(qa.element('#harnessJobStatus').textContent, /completed/);
  assert.equal(qa.element('#harnessJobError').textContent, unsafeText);
  assert.equal(qa.element('#harnessJobOutput').textContent, unsafeText);
  assert.equal('innerHTML' in qa.element('#harnessJobOutput'), false, 'untrusted output is written as text, never markup');
  assert.equal(qa.calls.length, 3, 'only submit, explicit Stop, and explicit Check progress dispatched requests');
});

test('recent job recovery is explicit, exact, draft preserving, and never submits a new job', async () => {
  const qa = ui();
  qa.element('#harnessJobPrompt').value = 'Keep this draft while reopening.';
  qa.context.api = async (url, options) => {
    qa.calls.push({ url, options });
    if (url === '/api/harness-jobs') return { jobs: [
      { id: 'saved-job', agentId: 'local-a', status: 'running', createdAt: '2026-10-05T12:00:00.000Z', finishedAt: null, cancellationRequested: false }
    ] };
    return { job: { id: 'saved-job', agentId: 'local-a', status: 'running', output: '', error: '', cancellationRequested: false } };
  };
  assert.equal(qa.calls.length, 0, 'initial render does not load or execute jobs');
  await qa.element('#harnessJobLoadRecent').listeners.click();
  assert.equal(qa.calls[0].url, '/api/harness-jobs');
  assert.equal(qa.calls[0].options, undefined, 'loading recent jobs is a read');
  assert.deepEqual(qa.element('#harnessJobRecent').options.map((option) => option.value), ['saved-job']);
  await qa.element('#harnessJobOpenRecent').listeners.click();
  assert.equal(qa.calls[1].url, '/api/harness-jobs/saved-job');
  assert.equal(qa.calls[1].options, undefined, 'opening uses the existing item GET');
  assert.equal(qa.element('#harnessJobPrompt').value, 'Keep this draft while reopening.');
  assert.match(qa.element('#harnessJobStatus').textContent, /running/);
  assert.equal(qa.element('#harnessJobStop').disabled, false, 'a restored running job can be stopped');
  assert.match(qa.element('#harnessJobFeedback').textContent, /was not rerun/);
  assert.equal(qa.calls.some((call) => call.options?.method === 'POST'), false);
});

test('recovery rejects a mismatched job ID or agent ID and reports missing jobs', async () => {
  for (const itemJob of [
    { id: 'other-job', agentId: 'local-a', status: 'completed' },
    { id: 'saved-job', agentId: 'other-agent', status: 'completed' }
  ]) {
    const qa = ui();
    qa.context.api = async (url, options) => {
      qa.calls.push({ url, options });
      return url === '/api/harness-jobs'
        ? { jobs: [{ id: 'saved-job', agentId: 'local-a', status: 'completed', createdAt: '2026-10-05T12:00:00.000Z' }] }
        : { job: itemJob };
    };
    await qa.element('#harnessJobLoadRecent').listeners.click();
    await qa.element('#harnessJobOpenRecent').listeners.click();
    assert.match(qa.element('#harnessJobFeedback').textContent, /did not match the selected job and agent/);
    assert.match(qa.element('#harnessJobStatus').textContent, /No current job selected/);
    assert.equal(qa.calls[1].url, '/api/harness-jobs/saved-job');
  }

  const missing = ui();
  missing.context.api = async (url, options) => {
    missing.calls.push({ url, options });
    if (url === '/api/harness-jobs') return { jobs: [{ id: 'expired-job', agentId: 'local-a', status: 'completed' }] };
    throw new Error('Harness job not found.');
  };
  await missing.element('#harnessJobLoadRecent').listeners.click();
  await missing.element('#harnessJobOpenRecent').listeners.click();
  assert.match(missing.element('#harnessJobFeedback').textContent, /may have expired or become unavailable/);
  assert.match(missing.element('#harnessJobStatus').textContent, /No current job selected/);
});

test('empty recent list and unavailable list have useful feedback', async () => {
  const empty = ui();
  empty.context.api = async (url, options) => { empty.calls.push({ url, options }); return { jobs: [] }; };
  await empty.element('#harnessJobLoadRecent').listeners.click();
  assert.match(empty.element('#harnessJobFeedback').textContent, /No recent owner jobs/);
  assert.equal(empty.element('#harnessJobOpenRecent').disabled, true);

  const unavailable = ui();
  unavailable.context.api = async () => { throw new Error('Local read denied.'); };
  await unavailable.element('#harnessJobLoadRecent').listeners.click();
  assert.match(unavailable.element('#harnessJobFeedback').textContent, /Recent jobs are unavailable: Local read denied/);
});
