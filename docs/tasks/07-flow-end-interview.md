# 07 · End an interview: status lifecycle + wrap-up + debrief

**Area:** Flow · **Priority:** P1 · **Size:** L · **Depends on:** —
**Labels:** `agent-ready`, `flow`, `api`, `web`

> **Status: DONE.** `POST /interviews/:id/end` completes the interview, stamps `endedAt` and persists `interviews.debrief_json` (idempotent — a second call returns the stored copy). `wrap_up` phase added to `DEFAULT_INTERVIEW_PLAN`; generated plans are required to end with a closing phase. Transcript helpers now live only in `apps/api/src/common/transcript.ts`. Messages on a completed interview return `409` before any row is written. UI: End-interview button + `ConfirmDialog`, `InterviewDebrief.tsx`, disabled composer.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

**Interviews never end.** `interviews.status` defaults to `"active"`
(`apps/api/src/db/schema.ts:39`) and *nothing in the codebase ever sets it to
anything else* — a repo-wide grep for status writes on the interview row returns
only the seed insert (`apps/api/src/interview/interview.service.ts:103`) and the
unrelated `LiveConstraint.status` field. The `endedAt` column already exists
(`apps/api/src/db/schema.ts:57`) and is never written.

Consequences:

- No completion moment. The candidate validates whenever, and the session just
  stops existing.
- The interview kit's **Wrap-up** phase has no home. The kit spends its last 3–4
  minutes on *"What would you change at 10x scale?"* and *"What would you tackle
  next?"* (`PLAYBOOK.md`, §System design in 25 minutes). Our default plan ends at
  `tradeoffs` (`packages/shared/src/index.ts:169-214`) with no closing summary from
  the candidate and no closing assessment from the interviewer.
- There is no debrief artefact. The kit's entire output is a narrative:
  *strongest signal → what went well → where they struggled → risk areas*
  (`PLAYBOOK.md`, §The narrative feedback template). We produce eight bars and
  three bullet lists.

## Desired behaviour

A first-class **End interview** action producing a persisted debrief.

### API

`POST /interviews/:id/end`

1. Reject with `409` if `status !== "active"` (idempotent-safe: a second call
   returns the existing debrief rather than regenerating).
2. Require at least one `solutions` row for the problem — the debrief needs a
   graded attempt. Return `400` with an actionable message otherwise.
3. Load: latest validation feedback, the full transcript
   (reuse `formatInterviewTranscript` / `truncateInterviewTranscript`,
   `apps/api/src/solutions/solutions.service.ts:42-66` — extract them to a shared
   helper module rather than duplicating), the rubric + playbook, live
   constraints, and the phase timeline if task 08 has landed.
4. One LLM call (`gpt-4o`) producing the kit-shaped narrative.
5. Persist to a new `interviews.debrief_json` column; set
   `status = "completed"`, `endedAt = now()`.

### Debrief schema

New in `packages/shared/src/index.ts`:

```ts
export const InterviewDebriefSchema = z.object({
  /** The kit's "STRONGEST SIGNAL (one sentence)". */
  strongestSignal: z.string().max(300),
  recommendation: z.enum(["strong_yes", "yes", "no", "strong_no"]),
  whatWentWell: z.array(z.string().max(400)).min(1).max(6),
  whereTheyStruggled: z.array(z.string().max(400)).max(6),
  riskAreas: z.array(z.string().max(400)).max(4),
  /** Ordered, concrete practice suggestions — this is a learning tool, so the
   *  debrief ends with what to do next, not with a verdict. */
  studyPlan: z.array(z.object({
    topic: z.string().max(120),
    why: z.string().max(300),
    suggestedNextProblem: z.string().max(160).optional()
  })).max(5),
  generatedAt: z.string()
});
```

The prompt must ground every bullet in a specific observable — a diagram element,
a quoted transcript line, or a criterion id — mirroring the kit's rule that a
verdict is *"traceable to specific, observable behaviors mapped to rubric
dimensions"* (`PLAYBOOK.md`, §anti-pattern 7).

### Wrap-up phase

Append a `wrap_up` phase to `DEFAULT_INTERVIEW_PLAN`
(`packages/shared/src/index.ts:169-214`), ~4 min, with a `candidateGuide`
directing the candidate to summarise their design, name what they would change at
10× scale, and state what they would tackle next. Instruct `buildProblemPrompt`
(`packages/ai-prompts/src/index.ts:33`) to always include a closing phase in
generated plans.

### UI

- **End interview** button in the Validate tab beside Export, disabled until at
  least one validation exists (`hasValidationAttempt` already exists in
  `apps/web/src/pages/WorkspacePage.tsx`).
- Confirmation via the existing `ConfirmDialog`
  (`apps/web/src/components/ConfirmDialog.tsx`) — the action is irreversible.
- After completion, render the debrief at the top of the Validate tab and
  **disable the interviewer composer** (a completed interview accepts no new
  messages). Board, Tutor and Export stay usable.
- `POST /interviews/:id/messages` must reject on a completed interview with a
  clear `409`.

## Files to touch

- `apps/api/src/db/schema.ts` — `debrief_json` column, then `pnpm db:generate`.
- `packages/shared/src/index.ts` — `InterviewDebriefSchema`, `wrap_up` phase.
- `packages/ai-prompts/src/index.ts` — `buildDebriefPrompt` (new), closing-phase rule.
- `apps/api/src/ai/ai.service.ts` — `generateDebrief`.
- `apps/api/src/interview/interview.service.ts` — `end()`, message guard.
- `apps/api/src/interview/interview.controller.ts` — route.
- `apps/api/src/solutions/solutions.service.ts` — extract transcript helpers to shared.
- `apps/web/src/lib/api.ts`, `apps/web/src/pages/WorkspacePage.tsx`, new `InterviewDebrief.tsx`.
- `docs/ARCHITECTURE.md` — REST surface + AI method table.

## Acceptance criteria

- [ ] `POST /interviews/:id/end` sets `status = "completed"` and `endedAt`, and persists a schema-valid debrief.
- [ ] Calling it twice does not regenerate — the second call returns the stored debrief.
- [ ] Ending with zero validations returns `400` with an actionable message.
- [ ] `POST /interviews/:id/messages` on a completed interview returns `409` and writes no message row.
- [ ] The transcript-formatting helpers exist in exactly one place and both services import them — no duplicated implementation.
- [ ] `DEFAULT_INTERVIEW_PLAN` ends with a `wrap_up` phase, and newly generated plans include a closing phase.
- [ ] The Validate tab renders the debrief after completion and the interviewer composer is disabled.
- [ ] Legacy interviews with `status = "active"` and no debrief behave exactly as today.
- [ ] `pnpm db:generate` produces a migration; the PR body states that `pnpm db:push` is required.
- [ ] `docs/ARCHITECTURE.md` lists the new route and the new AI method.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Auto-ending on a timer.
- Putting the debrief in the export (task 16).
- Dashboard surfacing of completed vs active interviews.
