# Optional local account pool

HexiGrid can connect to a separately installed local [codex-lb](https://github.com/Soju06/codex-lb) service. Upstream license: MIT; inspected integration version1.25.0-beta.9, commit f8ffbac2099a113fba54dfd8d77774f5bca80ffa. HexiGrid uses its authentication, quota and routing APIs. No account credentials or upstream executable are included in this package.

## Use the pool

1. Install and run the pool using its official instructions. Sign in to your own accounts in the pool's interface.
2. In HexiGrid, open **Settings → Connections → AI providers** and the **Local account pool** card.
3. Refresh the pool. Read each account's standing, remaining quota window, reset time and freshness. Unknown means unavailable, not zero or unlimited.
4. Choose routing/sticky conversation settings only if you want to change them. Other users' accounts are never preconfigured.

A ChatGPT subscription allowance, purchased credits and API billing are separate balances. HexiGrid can show only what the connected pool actually reports; recorded local usage is not a provider invoice or a promise of model entitlement. Limits and compatible models depend on the account and provider.

## Agent access

Local owner API: GET /api/model-pool; POST /api/model-pool/routing.

Signed owner Link: GET /agent-link/v1/model-pool; POST /agent-link/v1/model-pool/routing. Use the live manifest for exact request fields and required grants. Existing owner trust, active computer session and work-mode policy apply. Ordinary scoped Links cannot administer the account pool.

Pool worker helpers are optional advanced tools. Worker jobs require narrowly scoped assignments and review of outputs. Account keys stay protected and must never enter a prompt, command argument, log or exported job artifact. Never launch duplicate pool engines or copy the account database to bypass its lock. Optional paid use requires the user's authorization; no paid pool is required for core HexiGrid workflows.
