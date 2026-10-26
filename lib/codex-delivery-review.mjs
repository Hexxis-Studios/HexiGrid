import { codexApprovedChats, codexRelayForLink } from './codex-relay.mjs';

export function publicCodexDeliveries(jobs = [], relay = {}) {
  return jobs.slice(0, 500).map(job => ({ id: job.id, threadId: job.threadId || '', threadName: job.threadName || '',
    threadTitle: job.threadTitle || codexApprovedChats(codexRelayForLink(relay, job.linkId)).find(chat => chat.threadId === job.threadId)?.title || job.threadName || job.threadId || '',
    createdAt: job.createdAt, delivery: job.delivery || 'queued', reviewRequired: job.delivery === 'delivery-uncertain' }));
}

export async function handleCodexDeliveryReview(req, res, ctx) {
  const match = ctx.pathname.match(/^\/api\/codex-deliveries(?:\/([A-Za-z0-9_-]+)\/dismiss)?$/);
  if (!match) return false;
  const { state, json } = ctx;
  const authorize = () => {
    if (!ctx.isOwner()) throw Object.assign(new Error('Only the local authenticated owner can review Codex deliveries.'), { status: 403 });
  };
  try {
    authorize();
    if (ctx.method === 'GET' && !match[1]) {
      const denied = ctx.policy('read_local', 'medium', false);
      if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
      json(res, 200, { deliveries: publicCodexDeliveries(state.codexRelayPending, state.settings?.codexRelay) }); return true;
    }
    if (ctx.method !== 'POST' || !match[1]) { json(res, 405, { error: 'Unsupported delivery review operation.' }); return true; }
    const body = await ctx.readBody(req);
    authorize();
    if (body.decision !== 'dismiss' || body.expectedDelivery !== 'delivery-uncertain') throw Object.assign(new Error('Confirm dismissal of this held delivery.'), { status: 400 });
    const denied = ctx.policy('write_workspace', 'medium', body.approved === true);
    if (denied) { json(res, denied.denied ? 403 : 409, denied); return true; }
    const job = state.codexRelayPending.find(item => item.id === match[1]);
    if (!job) throw Object.assign(new Error('That pending delivery no longer exists.'), { status: 404 });
    if (job.delivery !== body.expectedDelivery || ctx.isActive(job.id) || ctx.isLocked(job.id)) throw Object.assign(new Error('Delivery changed or is active; refresh before reviewing.'), { status: 409 });
    ctx.lock(job.id);
    const index = state.codexRelayPending.indexOf(job);
    let receipt;
    try {
      state.codexRelayPending.splice(index, 1);
      receipt = ctx.addReceipt({ action: 'codex-relay:dismiss', capability: 'write_workspace', risk: 'medium', status: 'cancelled',
        detail: 'Owner dismissed one uncertain delivery after inspection. No message was resent and no Codex task was stopped.', source: 'codex-relay' });
      await ctx.saveState();
    } catch (error) {
      if (!state.codexRelayPending.some(item => item.id === job.id)) state.codexRelayPending.splice(Math.min(index, state.codexRelayPending.length), 0, job);
      if (receipt) state.receipts = state.receipts.filter(item => item !== receipt);
      throw error;
    } finally { ctx.unlock(job.id); }
    json(res, 200, { dismissed: true, id: job.id, resent: false, taskStopped: false }); return true;
  } catch (error) { json(res, error.status || 500, { error: error.status ? error.message : 'Could not save the delivery review; the held message is retained.' }); return true; }
}
