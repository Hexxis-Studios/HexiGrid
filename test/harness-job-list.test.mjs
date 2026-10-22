import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluatePolicy } from '../lib/policy.mjs';
import { handleHarnessJobRequest, publicOwnerHarnessJobs } from '../lib/harness-job-routes.mjs';

function routeContext(workMode, { jobs = [], onList = () => {}, onStart = () => {} } = {}) {
  const response = { status: null, body: null };
  const policyCalls = [];
  return {
    response,
    policyCalls,
    ctx: {
      pathname: '/api/harness-jobs', method: 'GET',
      json(_res, status, body) { response.status = status; response.body = body; },
      connectorPolicy(capability, risk, approved) {
        policyCalls.push({ capability, risk, approved });
        const policy = evaluatePolicy({ approvalPolicy: 'review', workMode, capability, risk });
        if (policy.decision === 'deny') return { error: policy.reason, denied: true };
        if (policy.decision === 'ask' && approved !== true) return { error: policy.reason, approvalRequired: true };
        return null;
      },
      listHarnessJobs() { onList(); return jobs; },
      startHarnessJob() { onStart(); throw new Error('GET must never execute a job'); }
    }
  };
}

test('recent owner list filters linked and ineligible agents, caps at 20, and exposes metadata only', () => {
  const jobs = Array.from({ length: 25 }, (_, index) => ({
    id: `local-job-${index}`,
    agentId: 'local-a',
    status: index % 2 ? 'completed' : 'running',
    createdAt: new Date(Date.UTC(2026, 9, 5, 0, index)).toISOString(),
    finishedAt: index % 2 ? new Date(Date.UTC(2026, 9, 5, 0, index + 1)).toISOString() : null,
    cancellationRequested: index === 24,
    prompt: 'private prompt marker', output: 'private output marker', error: 'private error marker',
    clientJobId: 'private client id marker', token: 'private token marker'
  }));
  jobs.push({ ...jobs[24], id: 'linked-job', linkId: 'link-1' });
  jobs.push({ ...jobs[24], id: 'other-profile-job', agentId: 'not-local' });

  const listed = publicOwnerHarnessJobs(jobs, new Set(['local-a']));
  assert.equal(listed.length, 20);
  assert.equal(listed[0].id, 'local-job-24', 'most recent jobs appear first');
  assert.equal(listed.at(-1).id, 'local-job-5');
  assert.equal(listed.some((job) => job.id === 'linked-job' || job.id === 'other-profile-job'), false);
  const allowed = ['id', 'agentId', 'status', 'createdAt', 'finishedAt', 'cancellationRequested'].sort();
  for (const job of listed) assert.deepEqual(Object.keys(job).sort(), allowed);
  const serialized = JSON.stringify(listed);
  for (const privateValue of ['private prompt marker', 'private output marker', 'private error marker', 'private client id marker', 'private token marker']) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('Plan mode can read the list without dispatching an executor', async () => {
  let listCalls = 0, startCalls = 0;
  const { ctx, response, policyCalls } = routeContext('plan', {
    jobs: [{ id: 'safe-job', agentId: 'local-a', status: 'completed', createdAt: '2026-10-05T12:00:00.000Z', finishedAt: null, cancellationRequested: false }],
    onList: () => { listCalls += 1; }, onStart: () => { startCalls += 1; }
  });
  assert.equal(await handleHarnessJobRequest({}, {}, ctx), true);
  assert.deepEqual(policyCalls, [{ capability: 'read_local', risk: 'medium', approved: true }]);
  assert.equal(response.status, 200);
  assert.equal(response.body.jobs[0].id, 'safe-job');
  assert.equal(listCalls, 1);
  assert.equal(startCalls, 0);
});

test('a denied local read returns before listing or executing', async () => {
  let listCalls = 0, startCalls = 0;
  const { ctx, response } = routeContext('converse', {
    onList: () => { listCalls += 1; }, onStart: () => { startCalls += 1; }
  });
  assert.equal(await handleHarnessJobRequest({}, {}, ctx), true);
  assert.equal(response.status, 403);
  assert.equal(response.body.denied, true);
  assert.equal(listCalls, 0);
  assert.equal(startCalls, 0);
});

test('the list remains behind the existing owner auth gate and prunes the shared retained store', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const authGate = source.indexOf('if (authGate(req, res, url)) return;');
  const jobRoute = source.indexOf('if (await handleHarnessJobRequest(req, res, {');
  assert.ok(authGate >= 0 && jobRoute > authGate, 'the global owner middleware runs before harness-job routes');
  assert.match(source, /function listHarnessJobs\(\)\s*\{\s*pruneHarnessJobs\(\);/);
  assert.match(source, /publicOwnerHarnessJobs\(\[\.\.\.harnessJobs\.values\(\)\], localAgentIds\)/);
  assert.match(source, /agent\.transport === 'local-opencode' && !linkedAgents\.has\(agent\.id\)/);
});
