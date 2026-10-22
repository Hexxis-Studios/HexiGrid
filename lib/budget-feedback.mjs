export function usageBudgetFeedback(limit, records, now = Date.now()) {
  const configured = Number.isSafeInteger(limit) && limit > 0;
  const start = now - 7 * 86400000;
  const tokens = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const used = (Array.isArray(records) ? records : []).filter(item => { const time = Date.parse(item.createdAt); return Number.isFinite(time) && time >= start && time <= now; })
    .reduce((sum, item) => sum + tokens(item.inputTokens) + tokens(item.outputTokens), 0);
  return { window: '7d', limit: configured ? limit : null, used, remaining: configured ? Math.max(0, limit - used) : null,
    flag: !configured ? 'unconfigured' : used >= limit ? 'exhausted' : used >= limit * 0.8 ? 'approaching' : 'under-budget' };
}

// Stops subsequent dispatches based on the existing local ledger. A crossing
// request or overlapping requests can exceed the target; this is not billing.
export function assertUsageBudgetAvailable(state, now = Date.now()) {
  const budget = usageBudgetFeedback(state.settings.tokenBudget7d, state.usage, now);
  if (budget.flag === 'exhausted') {
    throw Object.assign(new Error('The local 7-day token budget is exhausted. Increase or disable it in Usage, or wait for older usage to leave the window.'), {
      status: 429, code: 'LOCAL_TOKEN_BUDGET_EXHAUSTED'
    });
  }
  return budget;
}
