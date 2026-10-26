# Agent computer-control practice

Start from the HexiGrid source directory:

```powershell
node scripts/serve-agent-practice.mjs
```

Open the localhost address printed by the command in a desktop browser. The
window title is **HexiGrid Agent Practice**. Keep that page visible while the
agent uses HexiGrid's screen/UI inspection and mouse/keyboard tools. This does
not require owner-machine permissions or a different work mode when the Link's
existing desktop grants and current policy allow computer control.

Give the agent this instruction:

> Use your existing HexiGrid Link to operate only the **HexiGrid Agent Practice**
> Chrome window on my PC. Start your approved computer session if needed, and
> confirm screen, mouse and typing access are active. Follow the eight steps
> shown on that page using HexiGrid screen/UI inspection and mouse/keyboard
> controls. Do not use scripts, developer tools, direct HTTP or DOM automation
> to fill the form. Verify the saved values and the cancel/reset results, then
> report the final checklist result and any exact error. Stop your own computer
> session afterward. Do not change grants, work mode, other windows or files.
> Calling is already accepted; do not repeat it.

The task enters a name, chooses a category, sets a quantity, toggles a checkbox,
types a note, saves, cancels a reset, then confirms a reset. The progress display
records observed form events, not proof of the tool or identity that caused them;
the agent's Link receipts and before/after observations supply that evidence.

The page has no accounts, API, filesystem access, persistent storage or external
assets. All form state is in browser memory and disappears on reload. Its server
binds to `127.0.0.1` on a separate port and serves exactly two fixed assets;
mutating HTTP methods, other paths and other Host values are rejected. Browser
policy blocks outgoing page connections and native form submissions.

This is a disposable target, **not an OS sandbox for the agent**. The Link's
desktop permissions still apply to the desktop, so the authorized task is
limited to this window. It does not test real memory, task scheduling, social
actions or machine-owner tools. No additional dependencies or borrowed package
are used; the server follows the repository's existing `accept-vrm-viewer.mjs`
fixture pattern and uses Node's standard library with native HTML controls.

Reload the page to clear a run. Enter `stop` in the launcher to stop only the
practice server after testing. Keep the page open during the test; do not close
Codex or its browser bridge for cleanup.
