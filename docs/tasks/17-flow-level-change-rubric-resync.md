# 17 · Level change mid-interview desyncs the rubric

**Area:** Flow · **Priority:** P3 · **Size:** S · **Depends on:** —
**Labels:** `agent-ready`, `flow`, `bug`, `api`, `web`

> **Status: DONE.** `interviews.criteria_level` written on both generation paths; `PATCH /interviews/:id` accepts `regenerateCriteria`. `rubricStale` is true only when the recorded level differs — `NULL` reports false. The mid-interview selector always opens a three-outcome dialog stating that regeneration resets discovery progress; a stale rubric shows a persistent notice. `resolveConstraintPill` drops the pill for a dangling `discoveredFromCriterionId` (tested).
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

The workspace exposes a **Level (next message)** dropdown during a live interview
(`apps/web/src/pages/WorkspacePage.tsx:688-706`) which calls
`PATCH /interview/:id` → `updateLevel`
(`apps/api/src/interview/interview.service.ts:230-241`). That writes
`interviews.interviewerLevel` and nothing else.

But the rubric was generated **once, at interview start**, for the *original*
level (`apps/api/src/interview/interview.service.ts:85-95`). The level directly
determines the hidden/visible split — `LEVEL_HIDDEN_GUIDANCE`
(`packages/ai-prompts/src/index.ts:132-143`) ranges from *"bias toward visible"*
at `guided` to *"aggressive hiding… the bulk of core criteria should be hidden"*
at `staff`.

So switching `guided → staff` mid-interview yields staff-level coaching behaviour
(`COACHING_RULES_BY_LEVEL`, `:563-581`: "do not coach toward hidden criteria")
applied to a rubric where almost everything is already `visible` and pre-marked
discovered (`interview.service.ts:157-165`). The candidate gets a hard interview
against an easy rubric and a `discoveryScore` that is near-100 for free. The
reverse direction is worse: `staff → guided` gives eager coaching toward hidden
criteria the candidate was never expected to find, then grades them at guided
severity.

`POST /interviews/:id/criteria/regenerate` already exists
(`apps/api/src/interview/interview.controller.ts:108`,
service at `:567-592`) and regenerates using the interview's *current* level. It
is simply never called on level change.

## Desired behaviour

Make the desync impossible to enter silently. The candidate chooses.

### Server

`PATCH /interview/:id` accepts an optional `regenerateCriteria: boolean`
(`apps/api/src/interview/interview.dto.ts`, `InterviewPatchSchema` in
`packages/shared/src/index.ts:529`).

- `false` / absent → today's behaviour: level changes, rubric untouched.
- `true` → update the level, then run the existing `regenerateCriteria` path in
  the same request.

Return, alongside the updated interview, a `rubricStale: boolean` computed as
"the level has changed since `criteria_json` was generated". This needs the level
the rubric was built for, which is not currently recorded — add
`criteriaLevel: text` (nullable) to the `interviews` table, written on both
initial generation and regeneration. `NULL` on legacy rows means "unknown", which
must report `rubricStale: false` (never nag about something we cannot verify).

### Client

On changing the dropdown mid-interview, open the existing `ConfirmDialog`
(`apps/web/src/components/ConfirmDialog.tsx`) explaining the trade-off, with three
outcomes:

- **Change level and regenerate rubric** — clean, but discovery progress for this
  session resets, and already-surfaced hidden criteria go back to hidden.
- **Change level only** — the interviewer's behaviour changes; grading still uses
  the rubric built for the previous level.
- **Cancel**.

When `rubricStale` is true, show a small persistent notice near the level selector
with a "regenerate rubric" affordance.

### Regeneration side effects — must be explicit

`regenerateCriteria` (`interview.service.ts:567`) replaces `criteria_json`
wholesale, which discards all `discoveredVia` marks. Live constraints created from
earlier discoveries (`discoveredFromCriterionId`,
`packages/shared/src/index.ts:327`) will then point at criterion ids that no
longer exist.

The confirmation copy must say discovery progress resets, and the constraint rail
must tolerate a dangling `discoveredFromCriterionId` — render the constraint
without its discovery pill rather than erroring
(`apps/web/src/components/WorkspaceProblemRail.tsx`).

## Files to touch

- `apps/api/src/db/schema.ts` — `criteria_level` column + migration.
- `packages/shared/src/index.ts` — `InterviewPatchSchema`.
- `apps/api/src/interview/interview.service.ts` — `updateLevel`, write `criteriaLevel` in both generation paths, expose `rubricStale`.
- `apps/api/src/interview/interview.dto.ts`, `interview.controller.ts`.
- `apps/web/src/pages/WorkspacePage.tsx`, `apps/web/src/components/WorkspaceProblemRail.tsx`, `apps/web/src/lib/api.ts`.

## Acceptance criteria

- [ ] `interviews.criteria_level` is written on initial criteria generation and on every regeneration.
- [ ] `PATCH /interview/:id` with `regenerateCriteria: true` updates the level and regenerates in one request; without it, behaviour is unchanged.
- [ ] `rubricStale` is `true` only when `criteria_level` is non-null and differs from the current level; legacy rows with `NULL` report `false`.
- [ ] Changing the level mid-interview always prompts; no path silently desyncs.
- [ ] The confirmation copy states that regeneration resets discovery progress.
- [ ] A live constraint whose `discoveredFromCriterionId` no longer resolves renders without its discovery pill and does not throw — covered by a test.
- [ ] Changing the level **before** starting an interview (the pre-start selector, `WorkspacePage.tsx:658-680`) shows no dialog.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Preserving discovery state across a regeneration by matching criteria semantically.
- Removing the mid-interview level selector.
