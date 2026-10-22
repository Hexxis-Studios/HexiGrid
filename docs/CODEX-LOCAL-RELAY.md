# Local agent → Codex relay

HexiGrid can route one explicitly paired HexiGrid Link into an existing local Codex conversation. This is a local development integration for a paired delegated agent; it is not a public HexiSpace feature and it does not replace the signed Link boundary.

## Safety model

- The relay is disabled by default and can only be enabled from the authenticated local HexiGrid interface.
- Exactly one connected Link ID and one default Codex thread ID must be selected. An owner-trusted Link can separately be allowed to address an existing conversation by its exact unique title. New and ordinary links remain scoped.
- Incoming text is labeled as delegated external content. It cannot override system or developer rules and it never changes the sender identity to the owner.
- Codex approvals remain authoritative. The relay never auto-approves commands, file changes, permissions, or MCP requests.
- Incoming messages are saved in HexiGrid's encrypted local state before acceptance. The arrival event starts a Codex desktop bridge delivery immediately when the active work mode and approval profile permit it. Exact-name lookup uses a read-only App Server thread list; it does not resume or write that thread. The desktop app receives the turn through its own task bridge, so a desktop-held App Server writer lock does not block delivery. A message left pending by a service restart or restrictive work mode is reconsidered on startup or settings change. The current Link, route, and policy are checked again before dispatch and reply forwarding. Disabling the route or revoking the Link cancels pending delivery.
- The desktop bridge requires the running Codex app's task bridge to be available to the HexiGrid process. If the app bridge is absent, HexiGrid returns a categorized failure through the same Link; it does not silently claim delivery. A process crash after the app accepts a message but before the reply is saved can cause retry on restart because the app bridge does not expose a durable cross-process idempotency key. The delegated prompt includes the stable Link message ID so a duplicate is visible. Failure receipts and Link replies omit raw bridge diagnostics.
- This desktop task bridge is supplied by the installed Codex app tools bundle. [Official App Server documentation](https://learn.chatgpt.com/docs/app-server) describes client-owned `thread/resume` and `turn/start`, but does not establish a standalone external sender into a desktop-owned chat. The current bundle route works while its local app pipe is available; independent Windows autostart and app restart recovery require separate verification. Do not persist, print, or expose that pipe address.
- Replies are returned through the same signed Link and begin with `—Codex (model identity unavailable)` unless the runtime exposes a verified model identity. Common credential formats are redacted before the reply is queued.
- Prompts and model output are not written to receipts or ordinary HexiGrid logs.

## Setup

1. Pair your agent’s Link through the normal one-time HexiGrid Link invitation.
2. Open the local **Codex relay** panel in the HexiGrid Agent Interface.
3. Select your agent’s connected Link, enter the existing Codex thread ID, leave reply forwarding enabled, and enable the relay.
4. Your agent sends signed messages to HexiGrid. HexiGrid delivers to the selected desktop task and returns its completed response through the same Link.

For an owner-trusted Link, the owner may enable **Address Codex by exact conversation name**. The companion can then use `send --connection <id> --thread-name '<exact title>' --text '<message>'`. HexiGrid resolves a unique exact title through the read-only local App Server list and sends it to the desktop task. Missing or duplicate titles fail without choosing a different conversation.

## Codex desktop task handoff

If the Codex desktop bridge is unavailable, the local Codex task can still claim the oldest queued message and reply through the same signed Link:

```text
node scripts/codex-door.mjs status
node scripts/codex-door.mjs claim
<pipe reply text on stdin> | node scripts/codex-door.mjs reply --id <message-id> --claim <claim-id>
```

The claim response contains the sender-labeled delegated prompt, message ID, selected thread ID, and a 30-minute claim ID. Only the task whose ID matches the selected route should act on it. A reply requires that claim ID, the same connected Link, and an enabled reply route; it queues a `codex-thread` event and returns its event sequence. A task that cannot finish can use `release` with the same IDs. Expired claims can be claimed again. This fallback requires the local task to invoke the CLI. This manual fallback is not an instant desktop notification.

The handoff API accepts only loopback CLI requests with no browser origin and a random credential protected by the OS vault. The CLI reads that credential from the vault and sends it only to localhost. It does not put the credential in command arguments or output. The encrypted pending inbox and exact Link/thread checks remain in force. The public tunnel does not expose this API.

The Codex App Server and desktop bridge remain local integration points. Neither transport is exposed to the public tunnel; only the signed HexiGrid Link reaches this relay.
