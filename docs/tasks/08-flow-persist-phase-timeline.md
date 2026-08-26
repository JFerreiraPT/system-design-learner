# 08 · Persist phase transitions server-side

**Area:** Flow · **Priority:** P1 · **Size:** M · **Depends on:** —
**Labels:** `agent-ready`, `flow`, `api`, `web`

> **Status: DONE.** `interview_phase_events` table + `(interview_id, at)` index; `POST /interviews/:id/phase-events` (clamped, fire-and-forget) and `GET /interviews/:id/phase-timeline`. Reducer is `buildPhaseTimeline` in `@sdl/shared` (pure, `reset`-aware). `localStorage` still drives the live ribbon; a failing POST is swallowed by `postPhaseEvent`. The interviewer prompt gained a private cross-phase pacing block.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

Phase state lives **only in `localStorage`**. `WorkspacePage` persists
`{ phaseIndex, elapsedSecInPhase, running }` under `workspace:${id}:phase`
(`apps/web/src/pages/WorkspacePage.tsx:419-426`) and restores it on mount
(`:373-394`). Nothing reaches the server.

The API sees only an instantaneous snapshot: `PhaseRuntimeInfo`
(`packages/shared/src/index.ts:479-494`) is attached to each chat message's
workspace context (`WorkspacePage.tsx:453-461`) and used to shape the current
question. There is no history.

So the system cannot observe pacing — and pacing is a real seniority signal. The
kit allocates 4–5 min to requirements, 7–8 to high-level, 10–12 to deep dive
(`PLAYBOOK.md`, §How to structure the 25-minute block); a candidate who spends 22
minutes clarifying and 3 on the deep dive has told you something specific that we
currently cannot see, cannot grade, and cannot report. Clearing site data also
silently destroys the timeline.

## Desired behaviour

Record every phase transition on the server as an append-only log.

### Schema

New table in `apps/api/src/db/schema.ts`:

```ts
export const interviewPhaseEvents = pgTable("interview_phase_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  interviewId: uuid("interview_id").notNull().references(() => interviews.id),
  phaseId: text("phase_id").notNull(),
  phaseIndex: integer("phase_index").notNull(),
  kind: text("kind").notNull(),                 // "enter" | "exit" | "reset"
  /** Client-accumulated seconds in the phase at the moment of the event.
   *  Client-reported by necessity — the timer is pausable and lives in the
   *  browser. Server clamps to a sane range; never trusted for billing. */
  elapsedSec: integer("elapsed_sec").notNull().default(0),
  at: timestamp("at", { withTimezone: true }).defaultNow().notNull()
});
```

Index on `(interview_id, at)`.

### API

`POST /interviews/:id/phase-events` — body
`{ phaseId, phaseIndex, kind, elapsedSec }`, Zod-validated via the existing
`ZodValidationPipe`. Clamp `elapsedSec` to `[0, 86400]`. Reject events on a
completed interview (`409`) once task 07 lands.

`GET /interviews/:id/phase-timeline` — reduced view:

```ts
{ phases: Array<{ phaseId, label, budgetSec, actualSec, overBudget: boolean }>,
  totalSec: number,
  completed: boolean }
```

`label` and `budgetSec` come from the problem's `interviewPlanJson`, falling back
to `DEFAULT_INTERVIEW_PLAN`.

### Client

Emit from `WorkspacePage`:

- `enter` for phase 0 when an interview starts.
- `exit` (old phase) + `enter` (new phase) on **Next**
  (`WorkspacePage.tsx:555-560`).
- `reset` on **Reset** (`:561-565`).

Fire-and-forget: a failed POST must never block the UI or surface an error toast.
`localStorage` remains the source of truth for live timer rendering — this is a
telemetry log, not a state move.

### Consumers

- `buildInterviewerPrompt` scope gains an optional compact timeline summary so the
  interviewer can reference pacing across phases, not just the current one. Keep
  the existing rule from `packages/ai-prompts/src/index.ts:700-705`: never quote
  elapsed time at the candidate.
- The debrief prompt (task 07) receives the timeline when available.

## Files to touch

- `apps/api/src/db/schema.ts` + generated migration.
- `apps/api/src/interview/interview.service.ts`, `interview.controller.ts`, `interview.dto.ts`.
- `packages/shared/src/index.ts` — event + timeline schemas.
- `apps/web/src/lib/api.ts`, `apps/web/src/pages/WorkspacePage.tsx`.
- `packages/ai-prompts/src/index.ts` — optional timeline block.
- `docs/ARCHITECTURE.md` — routes + data model.

## Acceptance criteria

- [ ] `interview_phase_events` exists with the index, and `pnpm db:generate` produces a migration.
- [ ] Starting an interview, advancing phases, and resetting all produce the correct event sequence.
- [ ] `GET /interviews/:id/phase-timeline` returns per-phase actual vs budget, correctly attributing `label` and `budgetSec` from the problem's plan, and falling back to `DEFAULT_INTERVIEW_PLAN` when the plan is `NULL`.
- [ ] `elapsedSec` is clamped server-side; an absurd client value is stored clamped, not rejected with a 500.
- [ ] A failing phase-event POST is swallowed on the client — no error UI, no blocked interaction; assert this in a test.
- [ ] An interview with zero recorded events (every legacy interview) returns a timeline with `actualSec: 0` per phase and does not error.
- [ ] Live timer rendering is unchanged; `localStorage` still drives the ribbon.
- [ ] `docs/ARCHITECTURE.md` documents the table and both routes.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Moving timer state ownership to the server.
- Scoring pacing (the timeline is input to the debrief narrative, not a number).
- Backfilling timelines for existing interviews.
