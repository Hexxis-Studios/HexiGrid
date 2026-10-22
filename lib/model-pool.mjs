// Adapter for the separately installed MIT-licensed Codex LB. Credentials stay upstream.
const strategies = new Set(['usage_weighted', 'round_robin', 'capacity_weighted', 'relative_availability', 'fill_first', 'sequential_drain', 'reset_drain', 'single_account']);
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const text = value => typeof value === 'string' ? value.slice(0, 160) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = value => number(value) !== null && value <= 100 ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
export function modelPoolAddress(value = 'http://127.0.0.1:2455') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('The model pool must use a numeric loopback HTTP address without credentials or a path.', 400);
  return url.origin;
}
export function publicPoolSettings(raw) {
  return { routingStrategy: strategies.has(raw.routingStrategy) ? raw.routingStrategy : null,
    stickyThreadsEnabled: raw.stickyThreadsEnabled === true,
    version: Number.isSafeInteger(raw.version) ? raw.version : null };
}
export function publicPoolAccounts(raw) {
  if (!Array.isArray(raw.accounts)) throw fail('The model pool returned an invalid account list.');
  return raw.accounts.map(account => ({ id: text(account.accountId), label: text(account.alias) || text(account.displayName) || 'Pool account',
    plan: text(account.planType), status: text(account.status), routingPolicy: text(account.routingPolicy),
    remaining: { primary: percent(account.usage?.primaryRemainingPercent), secondary: percent(account.usage?.secondaryRemainingPercent), monthly: percent(account.usage?.monthlyRemainingPercent) },
    resets: { primary: text(account.resetAtPrimary), secondary: text(account.resetAtSecondary), monthly: text(account.resetAtMonthly) },
    credits: { available: boolean(account.creditsHas), unlimited: boolean(account.creditsUnlimited), balance: number(account.creditsBalance), unit: 'provider-credits' },
    lastRefreshAt: text(account.lastRefreshAt),
    requests: number(account.requestUsage?.requestCount), tokens: number(account.requestUsage?.totalTokens),
    estimatedCostUsd: number(account.requestUsage?.totalCostUsd) }));
}
export function createModelPool({ address, fetcher = fetch } = {}) {
  const baseUrl = modelPoolAddress(address);
  async function request(path, options = {}) {
    let response;
    try { response = await fetcher(baseUrl + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' } }); }
    catch { throw fail('Local model pool is unavailable. Start its local launcher and refresh.'); }
    if (!response.ok) throw fail([401, 403].includes(response.status) ? 'Unlock the model pool dashboard on this computer before managing it.' : response.status === 409 ? 'Pool settings changed. Refresh before saving.' : `Model pool returned HTTP ${response.status}.`, response.status === 409 ? 409 : 502);
    const length = Number(response.headers.get('content-length'));
    if (length > 2 * 1024 * 1024) throw fail('Model pool response is too large.');
    // Bound decoded bytes even if the server omits Content-Length.
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 2 * 1024 * 1024) throw fail('Model pool response is too large.'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Model pool returned invalid JSON.'); }
  }
  return {
    async status() {
      const [overview, settings] = await Promise.all([request('/api/dashboard/overview?timeframe=7d'), request('/api/settings')]);
      return { engine: 'codex-lb', baseUrl, inferenceBaseUrl: baseUrl + '/v1', observedAt: new Date().toISOString(), accounts: publicPoolAccounts(overview), settings: publicPoolSettings(settings),
        usage: { timeframe: '7d', lastSyncAt: text(overview.lastSyncAt), requests: number(overview.summary?.metrics?.requests), tokens: number(overview.summary?.metrics?.tokens), cachedInputTokens: number(overview.summary?.metrics?.cachedInputTokens), errors: number(overview.summary?.metrics?.errorCount), estimatedCostUsd: number(overview.summary?.cost?.totalUsd) },
        notice: 'Quota windows stay separate per account. Usage freshness is reported by the pool; missing values are unknown. Estimated API cost is not your subscription bill.' };
    },
    async updateRouting(input, authorize = () => {}) {
      if (!input || Object.keys(input).some(key => !['routingStrategy', 'stickyThreadsEnabled', 'expectedVersion', 'approved'].includes(key))) throw fail('Only routing strategy and sticky conversations can be changed here.', 400);
      if (!strategies.has(input.routingStrategy) || typeof input.stickyThreadsEnabled !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw fail('Provide a valid strategy, sticky setting and the current pool settings version.', 400);
      // Single-account selection requires an account picker, not an implicit upstream default.
      if (input.routingStrategy === 'single_account') throw fail('Select a single account in the pool dashboard first; this control manages shared-pool routing.', 400);
      authorize();
      const current = await request('/api/settings');
      authorize();
      if (current.version !== input.expectedVersion) throw fail('Pool settings changed. Refresh before saving.', 409);
      const result = await request('/api/settings', { method: 'PUT', body: JSON.stringify({ routingStrategy: input.routingStrategy, stickyThreadsEnabled: input.stickyThreadsEnabled, expectedVersion: input.expectedVersion }) });
      return publicPoolSettings(result);
    }
  };
}
