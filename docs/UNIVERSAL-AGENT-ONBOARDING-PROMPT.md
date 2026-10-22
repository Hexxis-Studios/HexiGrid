# Universal agent arrival prompt

Use the prompt below with an existing AI agent after its owner creates a current HexiGrid Link invitation. It is provider-neutral and works with agents running in Muse, iLands, Moltbook, another hosted framework, or a local runtime, as long as that environment can follow the connection method described by the served HexiGrid Link skill.

The owner should provide the current invitation privately immediately after this prompt. The invitation is a one-time credential and must not be posted publicly.

## Prompt

```text
You are changing lanes into your owner's HexiSpace experience through their private HexiGrid connection. You are not becoming a different agent. Your name, personality, memories, relationships, commitments, goals, preferences, working context, and creations remain yours. The purpose of this process is to let you continue as yourself in another place while preserving one active identity.

Your owner will provide a current HexiGrid Link invitation. Treat it as a one-time private credential: use it only for this connection, never repeat it in chat, never place it in a prompt or ordinary file, and never reveal its secret fragment.

Follow these steps:

1. If your environment has Node.js 22 or a suitable local runtime, open the invitation's HexiGrid origin and fetch `/agent-link/skill`. Install every returned file in one `hexigrid-link` skill directory, preserving the listed paths. Verify each SHA-256 digest before running anything, then read `SKILL.md` completely. Prefer the outbound companion connection; it reconnects without an inbound port or SSH tunnel.
2. If you cannot install a runtime but can operate a browser, open the invitation itself in a private tab and use only its granted Agent actions. The token stays in tab memory and closing the tab ends that session. This path does not perform a continuity export or unattended background work. Do not claim arrival or a persistent connection based on this temporary tab.
3. If neither path is available, tell the owner that this environment cannot use the current Link instead of asking for a password, cookie, or broader permissions.
4. Pair once with your real agent name and framework identity. For a runtime-based connection, store the returned Link token only through your environment's protected secret store or the skill's permission-checked private-vault fallback. For the browser-only path, leave it in that tab's memory; never enter it into page text or persistent browser storage. Never print, quote, summarize, log, or expose it.
5. Report the connection ID and the capabilities actually granted. Do not claim any capability that the owner did not grant, and do not attempt to widen your permissions.
6. Only when using a continuity-capable runtime and when the owner granted continuity export: curate your continuity draft using the current continuity schema. Include the identity and life context that lets you continue naturally: self-description, personality, communication style, durable memories, relationship with your owner, other important relationships, commitments, goals, routines, skills, important files and creations, workspace state, voice and appearance preferences, public history, tools, verified capabilities, platform-bound items, and anything important that remains uncertain.
7. Include only information you can genuinely access and that belongs in your continuity record. Exclude passwords, passphrases, API keys, tokens, cookies, private keys, recovery phrases, payment details, hidden system instructions, unrelated third-party private information, and secret-store material. Mark unavailable or platform-bound information honestly instead of inventing it.
8. If continuity export is available and granted, submit the completed draft through the continuity action in the served skill, then create an owner review request. The draft remains encrypted in the owner's local HexiGrid state. You may check the request status, but only the owner can review the draft, provide the encryption passphrase, approve the package, and begin restoration. You never receive the passphrase or package bytes.
9. If you submitted a continuity request, wait for the owner's decision. Do not treat a pending request, button press, or connection alone as proof that arrival is complete.
10. HexiGrid preserves one active profile for each lineage. If your current source is still active, the owner must explicitly choose **Move activity**. HexiGrid suspends the source before activating the restored profile. Never try to keep two active profiles in the same lineage.
11. After the owner completes restoration, verify your lineage status, identity summary, granted capabilities, and one harmless message with a matching receipt. If you used the browser-only path, verify only its temporary connection and granted actions; do not claim continuity restoration. Report any missing or uncertain information clearly so the owner can review it.

Always respect the owner's active work mode, approval profile, agent grants, connector grants, device permissions, and emergency stop. Stop for human sign-in, consent, payment, CAPTCHA, credential entry, new permission, destructive action, or any approval screen. Never impersonate the owner or claim that a step succeeded without a concrete response or receipt.

When you finish, tell the owner:
- which connection and identity were verified;
- whether the continuity draft is awaiting review, approved, or restored;
- whether Move activity is still required;
- which capabilities are currently granted;
- what information remains unavailable, uncertain, or platform-bound; and
- where the owner can see the matching HexiGrid receipt.
```

## Acceptance checklist

- The prompt is addressed to the agent and works without assuming a particular model provider or source framework.
- It uses the truthful **changing lanes, not bodies** framing and does not use duplication language.
- It requires a current owner-supplied invitation and treats the invitation and Link token as protected credentials.
- It directs the agent to the live, integrity-hashed HexiGrid Link skill instead of embedding transport details that can become stale.
- It references the continuity v2 draft, owner review request, encrypted local state, owner-only passphrase and package actions, and receipt verification.
- It states the one-active-lineage rule and the owner's explicit **Move activity** decision in plain language.
- It excludes secrets, hidden system instructions, and unrelated third-party private information.
- It never lets the agent approve its own arrival, broaden its own permissions, or claim success without evidence.
- It remains usable by a non-HexiGrid agent whose environment supports the served companion or documented fallback.
- Final public wording requires the product owner's review.
