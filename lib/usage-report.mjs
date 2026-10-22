import { usageBudgetFeedback } from './budget-feedback.mjs';

const budgetWrites = new WeakSet();
export async function commitUsageBudget(state, input, { requireExpected = false, authorize, saveState, addReceipt, agentId = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some(key => !['tokens', 'expectedTokens', 'approved'].includes(key)) ||
    !(input.tokens === null || (Number.isSafeInteger(input.tokens) && input.tokens > 0 && input.tokens <= 1000000000))) {
    throw Object.assign(new Error('Set a positive 7-day token budget or null to disable it.'), { status: 400 });
  }
  if (requireExpected && !Object.hasOwn(input, 'expectedTokens')) {
    throw Object.assign(new Error('Read the current budget first and supply expectedTokens (null when unconfigured).'), { status: 400 });
  }
  if (typeof authorize !== 'function' || typeof saveState !== 'function' || typeof addReceipt !== 'function') throw new Error('Budget commit requires trusted authority and persistence.');
  if (budgetWrites.has(state)) throw Object.assign(new Error('A budget update is in progress; refresh before saving.'), { status: 409 });
  budgetWrites.add(state);
  const hadBudget = Object.hasOwn(state.settings, 'tokenBudget7d');
  const previous = state.settings.tokenBudget7d;
  const previousReceipts = [...state.receipts];
  let receipt, changed = false;
  try {
    authorize();
    if (Object.hasOwn(input, 'expectedTokens') && input.expectedTokens !== (previous ?? null)) {
      throw Object.assign(new Error('The budget changed; refresh before saving.'), { status: 409 });
    }
    state.settings.tokenBudget7d = input.tokens; changed = true;
    receipt = addReceipt({ agentId, action: 'usage:budget-change', capability: 'write_workspace', risk: 'high', status: 'completed',
      detail: 'Changed the local 7-day token budget. Provider quota, credits and account routing were unchanged.', source: 'usage' });
    await saveState();
    return { tokenBudget7d: input.tokens, ...(receipt?.id ? { receiptId: receipt.id } : {}) };
  } catch (error) {
    if (changed) {
      if (hadBudget) state.settings.tokenBudget7d = previous;
      else delete state.settings.tokenBudget7d;
      if (receipt) {
        state.receipts = state.receipts.filter(item => item !== receipt);
        // addReceipt may trim a full audit list. Restore only displaced prior
        // rows, preserving receipts concurrently added by unrelated work.
        for (const prior of previousReceipts) if (!state.receipts.includes(prior)) state.receipts.push(prior);
      }
    }
    throw error;
  } finally { budgetWrites.delete(state); }
}

// Projection of the existing local accounting ledger. No chat, audit or credential fields.
export function localUsageReport(state, { days = 7, endAt = Date.now() } = {}) {
  if (![1, 7, 30].includes(days)) throw Object.assign(new Error('Choose a usage period of 1, 7 or 30 days.'), { status: 400 });
  const records = (state.usage || []).slice(-10000);
  const from = endAt - days * 86400000;
  const groups = new Map();
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, estimatedRequests: 0, unknownMeteringRequests: 0 };
  for (const item of records) {
    const at = Date.parse(item.createdAt);
    if (!Number.isFinite(at) || at < from || at > endAt) continue;
    const agentId = typeof item.agentId === 'string' ? item.agentId.slice(0, 256) : null;
    if (!groups.has(agentId)) groups.set(agentId, { agentId, requests: 0, inputTokens: 0, outputTokens: 0, estimatedRequests: 0, unknownMeteringRequests: 0 });
    for (const target of [totals, groups.get(agentId)]) {
      target.requests++;
      target.inputTokens += Number.isFinite(item.inputTokens) && item.inputTokens >= 0 ? item.inputTokens : 0;
      target.outputTokens += Number.isFinite(item.outputTokens) && item.outputTokens >= 0 ? item.outputTokens : 0;
      if (item.estimated === true) target.estimatedRequests++;
      else if (item.estimated !== false) target.unknownMeteringRequests++;
    }
  }
  return { report: { days, from: new Date(from).toISOString(), through: new Date(endAt).toISOString(), ...totals, agents: [...groups.values()] },
    budget: usageBudgetFeedback(state.settings.tokenBudget7d, records, endAt),
    accounting: 'Local HexiGrid requests only; estimates are labeled. This is not provider billing, subscription quota or purchased credit balance.' };
}

export function localUsageSnapshot(state, endAt = Date.now()) {
  const week = localUsageReport(state, { days: 7, endAt });
  return { reports: [localUsageReport(state, { days: 1, endAt }).report, week.report, localUsageReport(state, { days: 30, endAt }).report], budget: week.budget, accounting: week.accounting };
}
