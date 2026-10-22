# Trust, modes, and approvals

HexiGrid uses intersecting constraints. The effective permission is always the narrowest result of:

`work mode ∩ approval profile ∩ agent grant ∩ plugin scope ∩ connector scope ∩ device scope`

## Approval profiles

### Ask for approval

Every permitted tool action pauses for the owner. Conversation itself does not prompt. Approval is specific to the exact action and scope; the owner can deny, approve once, approve for the session, or promote a recurring grant.

### Approve for me

Routine, reversible, in-scope work proceeds. High- or critical-risk actions pause. Risk review checks destructive changes, credential access, privacy/export risk, external communication, spending, persistent permission changes, unsafe device motion, and difficult-to-reverse actions. Uncertain reviews fail closed and ask.

### Full access

No per-action prompt is shown for actions already allowed by the active mode and existing grants. It never creates a new plugin, account, filesystem, financial, browser, or device scope by itself.

## Work modes

- Converse: no tool actions.
- Plan: read and plan only; no writes, execution, delegation, schedules, purchases, or external changes.
- Goal: pursue a named outcome, checkpoint progress, and delegate within the goal budget.
- Sketch: create local drafts, previews, mockups, and simulations; no connected-service mutations.
- Research: browse/read and create local research notes with provenance.
- Build: change local workspaces and use approved integrations.
- Watch: monitor approved sources and notify on meaningful changes.

The current mode catalog is intentionally fixed so each mode has a clear, testable permission ceiling. Connector-specific grants remain separate from the mode and are intersected at execution time.

## Subagents

Subagents inherit the parent goal, mode ceiling, approval profile ceiling, budget, and connector scopes. A child may be more restricted but never broader than its parent. Parallel writes to the same resource require leases or serialization. The owner can inspect, interrupt, or stop every child from the task graph.

## Non-negotiable controls

- Global pause and per-agent stop.
- Spend limits use prepaid/virtual cards or connector-enforced envelopes, never raw banking credentials in prompts.
- Robot/device motion requires device-specific limits and an emergency stop outside the model path.
- Human-verification challenges are a hard handoff: HexiGrid never claims to be human, ticks an “I am human” box, solves a CAPTCHA, or bypasses a bot/security check. The agent pauses and asks the owner to take over.
- Permanent permission promotion always requires the owner, even when an agent recommends it.
