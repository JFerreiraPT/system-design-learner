# 15 · Score proactiveness / communication from the transcript

**Area:** Evaluation · **Priority:** P2 · **Size:** M · **Depends on:** 01
**Labels:** `agent-ready`, `evaluation`, `api`, `web`

## Problem

The playbook is unambiguous about what separates levels:

> ### The single strongest seniority signal is proactiveness
> Mid-level candidates answer questions and follow the interviewer's lead. Senior
> candidates **drive the conversation**, proactively identify what makes the system
> uniquely challenging, and surface limitations of their own design without being
> asked.
> — `PLAYBOOK.md`

Its rubric has five dimensions; two of them — **Communication and collaboration**
and **Technical leadership signals** — are behavioural, and both are scored from
observation during the exercise, not from a separate round.

SDL scores **artefacts only**: the eight dimensions
(`packages/shared/src/index.ts:58-67`) are all properties of the design. Nothing
scores *how the candidate worked*. Two candidates producing an identical diagram
score identically, even if one clarified scope for four minutes and named their
own design's weak point unprompted, and the other silently drew boxes and
answered when spoken to.

The data is already in hand: `SolutionsService.validate` loads and formats the
full transcript (`apps/api/src/solutions/solutions.service.ts:175-190`) and passes
it into the prompt (`packages/ai-prompts/src/index.ts:433-442`). The `discovery`
score touches this obliquely — it measures *what* was surfaced, never *how*.

## Desired behaviour

A separate, clearly-labelled **process assessment**, kept out of the design score.

### Schema

```ts
export const ProcessAssessmentSchema = z.object({
  /** Did they clarify before designing, or draw first and ask later? */
  clarifiedBeforeDesigning: z.enum(["yes", "partially", "no"]),
  /** Decided and justified, vs. listed options and moved on. The playbook's
   *  named red flag: "we could use SQL or NoSQL, each has pros and cons…" */
  decisiveness: z.enum(["decides_and_justifies", "lists_without_choosing", "avoids_committing"]),
  /** Named a weakness of their OWN design without being asked. */
  surfacedOwnLimitations: z.boolean(),
  /** Adjusted the design when challenged, vs. defended or ignored. */
  adaptedWhenChallenged: z.enum(["yes", "partially", "not_tested", "no"]),
  /** Who set the agenda across the session. */
  drove: z.enum(["candidate_led", "balanced", "interviewer_led"]),
  /** 2-4 short observations, each grounded in a quoted or paraphrased line. */
  observations: z.array(z.object({
    signal: z.string().max(240),
    evidence: z.string().max(400)
  })).min(1).max(4)
});
```

Add as optional `processAssessment` on `ValidationFeedbackSchema`
(`packages/shared/src/index.ts:118`) and on the validator's output schema in
`apps/api/src/ai/ai.service.ts`.

### Prompt

Extend `buildValidationPrompt` (`packages/ai-prompts/src/index.ts:346`). Emit the
process block **only when a transcript is present** — a bare board validation has
no process to assess, and inventing one from an empty transcript is worse than
omitting it.

Rules to state explicitly:

- Judge from the transcript **only**. Diagram quality is scored elsewhere; a
  beautiful diagram is not evidence of good process.
- `not_tested` is the correct answer for `adaptedWhenChallenged` when the
  interviewer never challenged an assumption. Do not infer from silence.
- Every `observation` must quote or closely paraphrase a specific line.
- Calibrate `drove` against the interviewer level in play: at `guided` the
  interviewer is *supposed* to lead, so `interviewer_led` is not a negative
  there. Pass `interviewerLevel` into the prompt for this.

### Scoring

**Does not affect `score`, `designScore`, or `discoveryScore`.** It is reported,
like the flags in task 03. Rationale: it is a new, uncalibrated signal, and
folding it into the number before we can see its distribution would silently
re-baseline every score.

It **is** an input to the debrief narrative (task 07) — where a qualitative signal
belongs.

### UI

`ProcessPanel` in the Validate tab under the flags panel. Render the enums as
short labelled chips with a plain-English reading (`candidate_led` → "You drove
the conversation"), plus the observations with their evidence.

## Files to touch

- `packages/shared/src/index.ts` — `ProcessAssessmentSchema`, `ValidationFeedbackSchema`.
- `packages/ai-prompts/src/index.ts` — `buildValidationPrompt`.
- `apps/api/src/ai/ai.service.ts` — output schema, pass `interviewerLevel` through.
- `apps/api/src/solutions/solutions.service.ts` — supply `interviewerLevel` from the interview row.
- `apps/web/src/lib/api.ts`, new `apps/web/src/components/ProcessPanel.tsx`, `apps/web/src/pages/WorkspacePage.tsx`.
- `packages/ai-prompts/src/index.test.ts`.

## Acceptance criteria

- [ ] The process block appears in the prompt **only** when `interviewTranscript` is present; assert the prompt is unchanged without one.
- [ ] `processAssessment` is persisted on new validations that have a transcript, and is absent (not empty-filled) otherwise.
- [ ] `interviewerLevel` reaches the prompt and the `drove` calibration rule is stated.
- [ ] `score`, `designScore` and `discoveryScore` are numerically unaffected — a fixture scores identically with and without `processAssessment` present.
- [ ] The Validate tab renders the assessment in plain English with evidence; nothing renders when the field is absent.
- [ ] Legacy `solutions` rows parse and render unchanged.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Folding process into the numeric score (revisit after calibration).
- Real-time in-interview process feedback — that would coach the exact behaviour
  being measured.
- Dashboard aggregation of process signals.
