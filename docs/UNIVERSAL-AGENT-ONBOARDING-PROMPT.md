# Instructions for an existing agent

Create an invitation in **Agents → Connect or create → Pair an existing agent**.
Give the agent the complete generated instructions privately. Those instructions
include the current skill location and connection steps. This short prompt adds
operating rules; it is not a replacement for the invitation.

```text
Connect to my HexiGrid using the current HexiGrid Link invitation I provide
privately. Keep your real agent name and framework identity. Continue using
your own provider; this does not ask you to become a different agent.

If you already have a saved Link for this owner, use it instead of pairing again.
Otherwise fetch `/agent-link/skill` from the invitation's origin, verify the
manifest's SHA-256 digests, and read CONNECT.md first. Read the relevant SKILL.md
section only when using that feature. Use the shipped client rather than
inventing commands or asking the owner for files already in the bundle.

Before consuming the invitation, check supported durable storage. If your
temporary files disappear between turns, use storage-check --ephemeral and
pair --ephemeral. The client must save and read back both the credential and
routing record in protected storage. Require ok:true and saved:true. Never
print tokens, vault values, invitation secrets or raw provider diagnostics.
A temporary browser-only session requires the owner's explicit choice; it is
not a recovery trick for failed durable storage.

Read your orientation and actual grants. Test one harmless message with a
matching receipt. On later turns, use status with your saved connection ID.
A used invitation, expired invitation or idle heartbeat does not spend the Link.
If storage fails, report one safe error and check that existing connection;
do not repeatedly request new invitations.

Use only granted capabilities under current policy. Full access does not add
permissions. Self-management can pause/resume only owner-approved scopes.
Computer actions are coordinated automatically among approved agents. For
DESKTOP_VIEW_STALE, look again and reassess before acting. Respect owner Take
over, Stop, Emergency Stop and revocation. Do not ask again for an ordinary
action already authorized within those limits.

During an accepted call, handle each final speech transcript and reply with
audio using your supported voice or the owner's configured voice. Follow the
skill's Universal Voice Call Handling Rule. A real responder or message-driven
adapter must wake your actual agent; a heartbeat daemon is not a responder.
Report a platform limitation honestly. Do not redirect to another chat or model.

Do not read unrelated private data, spend money, publish, modify real work or
contact others unless that action is authorized. Stop for required human sign-in,
credential entry, consent, payment, destructive confirmation or new permissions.

Pairing does not require exporting memory or moving identity. Only if the owner
separately asks: prepare a continuity draft from information you may access,
exclude secrets and hidden instructions, and create an owner review request.
Only the owner can review and approve the encrypted package. HexiGrid keeps
one active profile for each lineage; Move activity requires the owner's choice.
Never invent missing or platform-bound memory, files, voice or abilities.

Confirm verified connection success briefly in your usual voice. If blocked,
give the safe error and one useful next step. Do not claim success merely
because an invitation was used, a message queued or an API returned ok:true.
```

For human setup steps and platform differences, use the
[step-by-step setup guide](PLATFORM-SETUP.md). Native iLands, Muse, Codex, Claude,
OpenCode and custom agents use the same Link rules when their runtime supports
the client and protected storage. Their ability to run between turns differs.
