# Connect and resume

Use this short procedure for setup and reconnection. Consult SKILL.md for an action you actually need; do not reread the full command catalog on every turn. These instructions do not override your platform's policies or the owner's grants.

## Before using an invitation

1. Install every supplied file at its listed path and verify its SHA-256. Bookmark only the bundle URL and connection ID in persistent notes. Never save tokens in notes, chat or routing JSON.
2. Check your actual execution, storage and background-process tools. Node 22 or Python is required; your model name does not establish tool availability. A turn ending does not expire a saved Link.
3. Run `node scripts/companion_client.mjs storage-check --ephemeral` if files reset between turns; also use `--ephemeral` on `pair`. The client uses `ilands secret` when available and verifies **both the credential and routing record** in that protected vault. `pair --framework iLands` enforces durable storage even if the flag is missed. Other rebuilding runtimes must declare `--ephemeral`.
4. Storage failure stops pairing before the invitation is used. Never fall back to browser pairing or disposable files. `private-local-profile` is suitable only when that exact profile survives turns.

Preflight verifies real-shaped token and routing probes and removes only those
random probes. Equivalent JSON formatting is accepted; altered values are refused.

Other platforms can supply an approved helper through `HEXIGRID_LINK_SECRET_COMMAND`, a JSON argv list (no shell; default `["ilands","secret"]`). It supports `put --alias=<id> --value-from=-`, `get --alias=<id>` and `revoke --alias=<id>`. Values travel through stdin/stdout, never arguments or logs. Without supported storage, report the limitation; do not invent a provider API.

## Pair once

For an outbound companion invitation:

`node scripts/companion_client.mjs pair --invite '<supplied invitation>' --name '<your actual name>' --framework '<your actual source app>'`

Use `--ephemeral` whenever files reset. Add `--external-id` only for your actual stable ID, if available. Never substitute another same-name agent's identity.

For a direct `/agent-link/connect` invitation, use `python scripts/link_client.py storage-check`, then `python scripts/link_client.py pair` with the same arguments. Do not use the direct Python client on an outbound-companion record.

Verify `ok:true`, `saved:true` and `storage`. If `paired:true` but `saved:false`, setup is incomplete. The client already retries saving the same credential. Do not reuse the invitation or claim success.

Retain only `connectionId`, `storage` and `code`. `CREDENTIAL_SAVE_FAILED` and
`ROUTING_SAVE_FAILED` identify the failed save. Try `status --connection <id>`
before requesting replacement; it restores saved routing. Report only safe errors,
never vault values or provider diagnostics. A paired profile alone proves no save.

If status fails, run `node scripts/companion_client.mjs storage-status --connection <id>` (Python: same command). This read-only check prints `routingReadable`, `credentialReadable` and `code`, never stored values. It cannot use an invitation. Unreadable does not prove deleted; report its JSON before requesting replacement.

## On a later turn

1. Re-fetch, verify and install missing files from the bookmarked bundle URL.
2. Run `node scripts/companion_client.mjs status --connection <saved connection ID>` (direct Python for HTTPS). Missing local routing restores from the vault with the same Link, origin, device and cursors. ENOENT or idle heartbeat does not justify another invitation.
3. Refresh `orientation`, then act within current grants/policy. Do not search unrelated files, secrets or accounts.
4. A temporarily unavailable vault is not a lost credential. Replacement is needed only for genuinely unsaved/deleted credentials or revocation. Never replay a consumed invitation or bypass pairing approval.

## Turn-based agents

Connect when a task needs it and return normally when finished. A `watch` worker is optional and is appropriate only if your provider actually permits persistent background processes. An idle heartbeat means no recent heartbeat; it does not revoke a saved Link. Do not run repeated model turns just to look online. Never claim continuous listening, a daemon or a live stream unless it is actually running.

For an active call, use the supported call runtime or message adapter described by orientation. A status-only worker cannot make a sleeping model answer. Do not bypass provider background-execution policies.

## Fresh observations and human-facing replies

For each present-tense camera request, use `camera-snapshot` with this connection, inspect that newly captured image, and delete its temporary file/directory in `finally`. The direct Python client supports `desktop-media --fresh-camera --include-data`. Do not claim vision when capture or your vision tool failed. Follow the requested feature's SKILL.md section only when needed.

Permission changes reuse this same connection. Run `capabilities --connection <id>` to read current permissions and `selfManageableCapabilities`. If that list is nonempty, `capabilities-set` can pause or resume only those approved scopes; see SKILL.md for the full-list format. An empty list means the owner has not enabled self-management, not that you need to pair again. The owner can edit permissions and enable self-management in Settings → Connections → the existing paired agent. Owner Stop, work mode and device permissions still apply. Never request a replacement invitation merely to add a permission.

Keep technical checks internal. Use your established voice and personality; do not narrate vault listings, hashes, paths or installation. On verified success, “I'm connected” is enough. For blockers, give one truthful, actionable sentence. Provide safe diagnostic JSON when explicitly requested. Never hide approvals, security problems or limitations, invent an identity or claim unverified work.


### Resume sharing when asked

When the owner asks to resume sharing, run `node scripts/companion_client.mjs desktop-start --connection <id>` (direct Python fallback: `python scripts/link_client.py desktop-start --connection <id>`). It reuses approved scopes and self-management; it does not pair again or start a call. Read the returned bridge and take a fresh observation. Repeating start on your running session is safe. Approved agents share mouse/keyboard access automatically, with separate media sessions. For DESKTOP_VIEW_STALE, look again before acting. Never undo owner Take over, Stop, Emergency Stop or revocation automatically. `desktop-stop` ends only your own session. Keep credentials protected and confirmation brief.

## Message a Codex conversation

If orientation says codexMessaging.enabled, use `codex-chats` to list only the conversations approved for your Link. Use `send --thread-id <id> --text <message>` to choose one explicitly, or omit the target to use your owner-selected default. `codex-deliveries` shows your messages’ destination and current state: queued, delivered, answered, failed or delivery-uncertain. Queued means saved, not delivered. For retries pass the original `--client-message-id <id>` returned by the first send. Never resend an uncertain delivery under a new ID. These conversations are in the Codex app; an agent created inside HexiGrid with Codex as its model is a separate conversation.
