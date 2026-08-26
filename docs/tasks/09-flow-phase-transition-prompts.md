# 09 · Interviewer proposes phase transitions

**Area:** Flow · **Priority:** P1 · **Size:** S · **Depends on:** 08
**Labels:** `agent-ready`, `flow`, `api`, `web`

> **Status: DONE.** `evaluatePhaseTransition` in `@sdl/shared` — deterministic, **no extra LLM call** (asserted in `interview.service.test.ts`). Stored in `interviews.pending_phase_proposal_json` with the resolved-phase set, surfaced as a keyboard-accessible banner in `PhaseRibbon`. Never auto-advances. Timer now starts with the interview.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

The kit is explicit about pacing ownership:

> After the requirements phase and at each subsequent transition, **ask the
> candidate if they're ready to move on.** This keeps pacing on track and lets you
> steer toward the areas where you need the most signal.
> — `PLAYBOOK.md`, §How to structure the 25-minute block

In SDL, phase advancement is a silent manual button
(`apps/web/src/pages/WorkspacePage.tsx:555-560`). The interviewer receives
`PhaseRuntimeInfo` and is told to *shape questions* with it
(`packages/ai-prompts/src/index.ts:700-705`) — "prefer summarising and pushing
toward closing the phase (or suggesting **Next phase**)" — but it can only say so
in prose. There is no structured signal and no affordance, so in practice
candidates run the whole interview in one phase and the plan is decorative.

The timer also must be started manually and defaults to stopped
(`WorkspacePage.tsx:99`), so for many sessions `elapsedSec` is `0` and the pacing
guidance is inert on top of that.

## Desired behaviour

A lightweight, **candidate-confirmed** transition proposal — deliberately modelled
on the existing constraint-proposal mechanism, which already establishes that the
AI proposes and the candidate applies
(`ConstraintProposalSchema`, `packages/shared/src/index.ts:334`; apply/dismiss at
`apps/api/src/interview/interview.service.ts:376-424`).

### Detection

After the assistant turn is persisted, in `saveAssistantMessage`
(`apps/api/src/interview/interview.service.ts:427-445`) — alongside the existing
`detectDiscoveries` and `deriveConstraintProposals` calls — evaluate a
**deterministic** rule. No extra LLM call:

Propose advancing when **all** hold:

1. `elapsedSec >= 0.8 × durationSec` for the current phase, **or** every
   non-stretch criterion whose playbook area references this phase has been
   discovered.
2. The current phase is not the last.
3. No transition proposal for this phase is already pending or was dismissed.

Store as `interviews.pending_phase_proposal_json` (nullable, single value — not an
array; only one can be live at a time).

### Surfacing

- A slim inline banner in the phase ribbon
  (`apps/web/src/components/PhaseRibbon.tsx`): *"Ready to move to Deep dive?"*
  with **Advance** / **Stay here**.
- **Advance** performs the existing `onNextPhase` and clears the proposal.
  **Stay here** clears it and suppresses re-proposal for that phase.
- Never auto-advance. The candidate always decides.

### Timer default

Start the phase timer automatically when an interview starts
(`startInterviewMutation.onSuccess`, `WorkspacePage.tsx:153`). Pause/Reset stay
manual. Without this, condition (1) never fires for most sessions.

### Interviewer awareness

Add one line to `buildInterviewerPrompt`
(`packages/ai-prompts/src/index.ts:627`): when a transition proposal is pending,
the interviewer should close out the current thread and offer a natural
transition sentence rather than opening a new line of questioning.

## Files to touch

- `apps/api/src/db/schema.ts` — `pending_phase_proposal_json` + migration.
- `packages/shared/src/index.ts` — `PhaseTransitionProposalSchema`.
- `apps/api/src/interview/interview.service.ts` — detection, apply/dismiss.
- `apps/api/src/interview/interview.controller.ts` — routes.
- `apps/web/src/components/PhaseRibbon.tsx`, `apps/web/src/pages/WorkspacePage.tsx`, `apps/web/src/lib/api.ts`.
- `packages/ai-prompts/src/index.ts`.

## Acceptance criteria

- [ ] Transition detection is deterministic and adds **no** LLM call — assert no new AI service method is invoked in the post-turn path.
- [ ] A proposal appears only when the documented conditions hold, and never on the last phase.
- [ ] Dismissing suppresses re-proposal for that phase for the remainder of the session.
- [ ] The interview never auto-advances a phase under any circumstance.
- [ ] The phase timer starts automatically on interview start; Pause and Reset still work exactly as today.
- [ ] The banner is keyboard-accessible and does not shift the board layout when it appears.
- [ ] Interviews with no criteria (legacy) still get time-based proposals and do not error.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Enforcing phase order or blocking work that belongs to another phase.
- Penalising the candidate for pacing.
- Auto-starting the timer on page reload of an existing interview (restore keeps current behaviour).
