// Bounded metadata/result snapshots for the existing encrypted local state.
// No prompts, tokens, controllers or authorization decisions are serialized.
export function retainedHarnessJobs(records, { recover = false, timestamp = Date.now() } = {}) {
  const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  const statuses = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
  return (Array.isArray(records) ? records : []).filter(job => job &&
    typeof job.id === 'string' && typeof job.agentId === 'string' && statuses.has(job.status) &&
    Number.isFinite(Date.parse(job.createdAt)) &&
    Date.parse(job.finishedAt || job.createdAt) >= timestamp - 30 * 60 * 1000
  ).slice(-100).map(job => {
    const interrupted = recover && ['queued', 'running'].includes(job.status);
    return {
      id: text(job.id, 160), clientJobId: text(job.clientJobId, 160),
      linkId: text(job.linkId, 160), agentId: text(job.agentId, 160), model: text(job.model, 500),
      status: interrupted ? 'interrupted' : job.status,
      createdAt: job.createdAt, startedAt: text(job.startedAt, 40) || null,
      finishedAt: interrupted ? new Date(timestamp).toISOString() : text(job.finishedAt, 40) || null,
      cancellationRequested: job.cancellationRequested === true,
      output: job.status === 'completed' ? text(job.output, 20000) : '',
      error: interrupted ? 'The engine stopped before this job finished. Review before submitting a new job.' : text(job.error, 1000)
    };
  });
}
