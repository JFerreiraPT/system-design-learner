# 18 · Record tutor usage in the debrief

**Area:** Flow · **Priority:** P3 · **Size:** S · **Depends on:** 07 (soft)
**Labels:** `agent-ready`, `flow`, `evaluation`, `api`, `web`

## Problem

The workspace offers a **Tutor** tab alongside the Interviewer during a scored
interview (`apps/web/src/pages/WorkspacePage.tsx:51-58`). The tutor is an
explicitly teaching-oriented assistant — `tutorSystemPrompt`
(`packages/ai-prompts/src/index.ts:710-724`): *"Teach, not just evaluate… give
targeted guidance on next design steps"* — and it receives the same full workspace
context as the interviewer, including the board and the current phase.

Nothing records that it was used. `tutor_sessions` and the interview row are
unlinked, the validator never learns of it, and the export says nothing. A session
where the candidate asked the tutor "how should I shard this?" and then drew the
answer is indistinguishable from one where they reasoned it out.

The interviewer's own welcome message frames the tutor as a side-channel that
*"should not replace answering me here"*
(`packages/ai-prompts/src/index.ts:532`) — but that norm has no teeth and no
visibility.

For a **single-user practice tool** this is deliberately not cheating — using the
tutor is often the right move, and it is why the tutor exists. The problem is
purely that the debrief has an unaccounted-for variable: a high score with heavy
tutor use means something different from a high score without it, and today the
user cannot tell those apart when reviewing their own progress weeks later.

## Desired behaviour

Make tutor usage **visible**, not penalised.

### Link the session

`tutor_sessions` currently has no interview linkage
(`apps/api/src/db/schema.ts`). Add a nullable `interview_id` and set it when a
tutor session is started from a workspace that has an active interview. `NULL`
covers standalone tutor use from `TutorPage`
(`apps/web/src/pages/TutorPage.tsx`), which is unrelated to any interview.

### Summarise

`GET /interviews/:id/tutor-usage` returning:

```ts
{ sessions: number,
  candidateTurns: number,
  firstUsedAtPhase: string | null,   // requires task 08's timeline; null without it
  topics: string[] }                 // up to 5 short topic labels
}
```

`topics` come from a cheap `gpt-4o-mini` call over the tutor transcript, run
**once** and cached on the session row — not on every read.

### Surface

- **Debrief** (task 07): a short factual line in the narrative input — "the
  candidate consulted the tutor 4 times, mostly about partitioning" — with the
  prompt instructed to treat it as **context, not a deduction**, and to fold it
  into the study plan (a topic that needed tutor help is a topic to practise).
- **Export** (task 16): a "Tutor usage" section.
- **Validate tab**: a one-line summary chip next to the score band.

### Explicitly not

- No score penalty. No `designScore` / `discoveryScore` / `score` change.
- No gating, disabling, or warning when the tutor is opened during an interview.

## Files to touch

- `apps/api/src/db/schema.ts` — `tutor_sessions.interview_id`, `topics_json` + migration.
- `apps/api/src/tutor/tutor.service.ts`, `tutor.controller.ts`, `tutor.dto.ts` — accept `interviewId` on start.
- `apps/api/src/interview/interview.service.ts`, `interview.controller.ts` — usage endpoint.
- `apps/api/src/ai/ai.service.ts` — `summariseTutorTopics`.
- `apps/web/src/pages/WorkspacePage.tsx` — pass `interviewId` on tutor start, render the chip.
- `apps/web/src/lib/api.ts`.

## Acceptance criteria

- [ ] Tutor sessions started from a workspace with an active interview persist `interview_id`; sessions started from `TutorPage` persist `NULL`.
- [ ] `GET /interviews/:id/tutor-usage` returns correct counts, and returns zeros (not a 404) for an interview with no tutor session.
- [ ] Topic summarisation runs at most once per tutor session and is cached on the row — assert no repeat AI call on a second read.
- [ ] `score`, `designScore` and `discoveryScore` are unaffected — no code path reads tutor usage into a numeric score.
- [ ] The tutor tab is never disabled, gated, or warned about during an interview.
- [ ] The Validate tab shows a factual usage chip; it renders nothing when usage is zero.
- [ ] Existing tutor sessions with `interview_id = NULL` behave exactly as today.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Penalising or restricting tutor usage.
- A "no tutor" strict interview mode.
- Cross-problem tutor analytics on the dashboard.
