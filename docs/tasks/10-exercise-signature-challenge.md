# 10 · `signatureChallenge` + `progressiveReveals` on problems

**Area:** Exercises · **Priority:** P2 · **Size:** M · **Depends on:** —
**Labels:** `agent-ready`, `exercises`, `api`, `shared`

> **Status: DONE.** `problems.narrative_json` holds `framingScript` / `signatureChallenge` / `progressiveReveals`, repaired field-by-field by `repairNarrative`. The criteria prompt requires a `core` criterion covering the signature challenge; the interviewer prompt gets it as an ordered stall ladder; the welcome opens with the framing script. `POST /problems/backfill-narrative` shares the generation rules verbatim. `signatureChallenge` never reaches the candidate UI.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

**Generated problems have no signature difficulty.** Every problem in the
interview kit has a hard core the whole discussion bends around:

- *Backend senior, rate limiter* — fail-open vs fail-closed when the Redis
  cluster dies; clock skew across nodes.
- *Fullstack senior, e-commerce* — overselling under concurrent checkout; payment
  succeeds but inventory update fails.

`buildProblemPrompt` (`packages/ai-prompts/src/index.ts:33-105`) asks for
`title`, `statement`, `constraints`, `tags`, `estimationSpec`, `interviewPlan`.
Nothing forces a twist, so problems come out as flat "design a system that does
X" prompts with no specific place where a good candidate visibly separates from a
mediocre one.

The kit also always ships **three progressive reveals** in a fixed shape —
a scale nudge, a failure nudge, a debug nudge:

> - *"Let's say we have ~100 microservices and millions of API calls per minute."*
> - *"How would your design change if your rate limiter Redis cluster went down?"*
> - *"A customer says they're hitting limits but shouldn't be — how do you debug that?"*

We have per-criterion `discoveryHints` (`packages/shared/src/index.ts:392`),
which are narrow single-criterion nudges. There is no problem-level escalation
ladder the interviewer can walk when a candidate stalls generally.

Finally, the kit's presentation script matters and we drop it: every template has
a verbatim *"Present it to the candidate as follows"* paragraph, distinct from the
terse challenge line. Our `statement` serves both roles and reads like neither.

## Desired behaviour

### Schema

Add to `ProblemSchema` (`packages/shared/src/index.ts:9`) and to the generation
output schema in `apps/api/src/ai/ai.service.ts` (near `:145-160`):

```ts
/** Verbatim framing the interviewer opens with — conversational, second person,
 *  ends by handing control to the candidate. Distinct from `statement`, which
 *  stays the terse written spec on the Problem rail. */
framingScript: z.string().min(80).max(900).optional(),
/** The one thing that makes THIS problem hard — the place a strong candidate
 *  visibly separates. One or two sentences, names a concrete mechanism. */
signatureChallenge: z.string().min(40).max(400).optional(),
/** Problem-level escalation ladder, always in this order:
 *  [0] scale nudge, [1] failure-mode nudge, [2] debug/operational nudge. */
progressiveReveals: z.tuple([
  z.string().min(20).max(300),
  z.string().min(20).max(300),
  z.string().min(20).max(300)
]).optional()
```

Persist in a new `problems.narrative_json` column rather than widening the table
with three scalars — it keeps the migration cheap and matches the existing
`reference_json` / `estimation_spec_json` pattern
(`apps/api/src/db/schema.ts:15-17`).

### Generation

Extend `buildProblemPrompt` with explicit rules:

- `signatureChallenge` must name a **concrete mechanism** (a race, a partial
  failure, an ordering guarantee, a hot key, a consistency boundary) — not a
  vague quality like "must be scalable".
- It must be reachable at the stated difficulty. Apply the existing
  `DIFFICULTY_CONTEXT_SNIPPETS` constraints
  (`packages/ai-prompts/src/index.ts:10-19`) — a `beginner` problem's signature
  challenge is something like "two people editing the same row", never sharding.
- `progressiveReveals` follows the fixed three-part order above; each reveal must
  be usable verbatim as an interviewer line.
- `framingScript` is second person, conversational, and ends by handing control
  over ("start wherever makes sense to you").

### Consumption

1. **Criteria generation** — pass `signatureChallenge` into `buildCriteriaPrompt`
   (`packages/ai-prompts/src/index.ts:156`) and require at least one `core`
   criterion covering it. This is the mechanism that stops rubrics drifting into
   generic best-practice lists.
2. **Interviewer** — pass `progressiveReveals` into `buildInterviewerPrompt`
   (`:627`) as a *stall ladder*, distinct from the existing per-criterion
   coaching. Rule: use only when the candidate is stuck on the design as a whole;
   never more than one per turn; escalate in order and never skip ahead.
3. **Welcome message** — when `framingScript` exists, `buildInterviewerWelcome`
   (`:499`) opens with it instead of the bare title line.

### Backfill

`POST /problems/backfill-narrative` following the existing backfill pattern
(`apps/api/src/problems/problems.controller.ts`, alongside `backfill-tags` and
`backfill-estimation-specs`). Not auto-run.

## Files to touch

- `apps/api/src/db/schema.ts` — `narrative_json` + migration.
- `packages/shared/src/index.ts` — schemas.
- `packages/ai-prompts/src/index.ts` — `buildProblemPrompt`, `buildCriteriaPrompt`, `buildInterviewerPrompt`, `buildInterviewerWelcome`.
- `apps/api/src/ai/ai.service.ts` — generation schema, `inferProblemNarrative` for backfill.
- `apps/api/src/problems/problems.service.ts`, `problems.controller.ts`.
- `apps/web/src/components/WorkspaceProblemRail.tsx` — **do not** show `signatureChallenge` (see out of scope).
- `docs/ARCHITECTURE.md`.

## Acceptance criteria

- [ ] New problems persist `framingScript`, `signatureChallenge` and exactly three `progressiveReveals`.
- [ ] `buildCriteriaPrompt` receives `signatureChallenge` when present and requires a `core` criterion covering it.
- [ ] The interviewer prompt exposes the reveals as an ordered stall ladder with a one-per-turn, no-skipping rule.
- [ ] `buildInterviewerWelcome` opens with `framingScript` when present and falls back to today's wording when absent — assert both branches.
- [ ] `signatureChallenge` is **never** rendered anywhere in the candidate-facing UI.
- [ ] `POST /problems/backfill-narrative` populates the column for existing problems.
- [ ] Problems with `narrative_json = NULL` behave exactly as today across generation, interview, criteria and validation.
- [ ] `pnpm db:generate` produces a migration; the PR notes `pnpm db:push`.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Showing `signatureChallenge` to the candidate — it is the answer to "what is
  this problem really testing" and revealing it defeats the hidden-criteria loop.
  It is interviewer-private, like the playbook.
- Regenerating existing problems' statements or constraints.
