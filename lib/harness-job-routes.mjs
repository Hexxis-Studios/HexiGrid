/**
 * Owner and signed-Link harness-job routes share the same bounded job store.
 * The runner itself remains in server orchestration; this module owns only
 * HTTP validation, policy decisions, and redacted job responses.
 */
export async function handleHarnessJobRequest(req, res, ctx) {
  const { pathname, method, readBody, json, connectorPolicy, findAgent, startHarnessJob, findHarnessJob, listHarnessJobs, publicHarnessJob, cancelHarnessJob, addReceipt, saveState, cleanString } = ctx;
  if (method === 'POST' && pathname === '/api/harness-jobs') {
    const body = await readBody(req, 64 * 1024);
    const denied = connectorPolicy('run_tools', 'high', body.approved);
    if (denied) {
      json(res, denied.denied ? 403 : 409, denied);
      return true;
    }
    try {
      const job = await startHarnessJob({ agent: findAgent(cleanString(body.agentId)), prompt: body.prompt, approved: body.approved === true, source: 'agent-interface', clientJobId: body.clientJobId });
      json(res, 202, { job: publicHarnessJob(job), notice: 'The job runs against the selected local model under the active policy. Poll the job endpoint for its bounded result.' });
    } catch (error) { json(res, error.status || 400, { error: error.message }); }
    return true;
  }
  if (method === 'GET' && pathname === '/api/harness-jobs') {
    const denied = connectorPolicy('read_local', 'medium', true);
    if (denied) {
      json(res, denied.denied ? 403 : 409, denied);
      return true;
    }
    json(res, 200, { jobs: listHarnessJobs() });
    return true;
  }
  const ownerMatch = pathname.match(/^\/api\/harness-jobs\/([a-z0-9-]+)(?:\/(cancel))?$/);
  if (ownerMatch && method === 'GET' && !ownerMatch[2]) {
    const job = findHarnessJob(ownerMatch[1]);
    json(res, job ? 200 : 404, job ? { job: publicHarnessJob(job, { includeOutput: true }) } : { error: 'Harness job not found.' });
    return true;
  }
  if (ownerMatch && method === 'POST' && ownerMatch[2] === 'cancel') {
    const job = findHarnessJob(ownerMatch[1]);
    if (!job) { json(res, 404, { error: 'Harness job not found.' }); return true; }
    if (cancelHarnessJob(job, 'The owner cancelled this harness job.')) {
      addReceipt({ agentId: job.agentId, action: `harness-job:${job.id}:cancel`, capability: 'run_tools', risk: 'high', status: 'cancelled', detail: 'The owner cancelled a queued or running harness job.', source: 'owner' });
      await saveState();
    }
    json(res, 200, { job: publicHarnessJob(job) });
    return true;
  }
  return false;
}

// Recent owner jobs are deliberately metadata-only. Callers provide the
// currently eligible local-profile agent IDs after applying store retention.
export function publicOwnerHarnessJobs(jobs, localAgentIds) {
  const allowedAgents = localAgentIds instanceof Set ? localAgentIds : new Set(localAgentIds || []);
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job && typeof job.id === 'string' && typeof job.agentId === 'string' &&
      allowedAgents.has(job.agentId) && !job.linkId && typeof job.createdAt === 'string' &&
      Number.isFinite(Date.parse(job.createdAt)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 20)
    .map((job) => ({
      id: job.id,
      agentId: job.agentId,
      status: typeof job.status === 'string' ? job.status : 'unknown',
      createdAt: job.createdAt,
      finishedAt: typeof job.finishedAt === 'string' ? job.finishedAt : null,
      cancellationRequested: job.cancellationRequested === true
    }));
}
