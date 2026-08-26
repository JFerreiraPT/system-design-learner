# 13 · Rebalance model tiers (generation vs grading)

**Area:** Exercises · **Priority:** P2 · **Size:** S · **Depends on:** —
**Labels:** `agent-ready`, `exercises`, `api`, `config`

> **Status: DONE.** `apps/api/src/ai/ai.models.ts` owns every model id; no literal remains (`grep 'openai("'` is empty). `problemGeneration` and `criteriaGeneration` moved to `gpt-4o`; everything else keeps its previous effective model. `.env.example` documents all ten keys; garbage values fall back rather than throwing.
> Cost: `generateProblem` runs once per problem and `generateCriteria` once per interview start, both then cached — a few calls per practice session against a per-turn chat volume already on `gpt-4o`.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

The model assignment is inverted relative to leverage. Current state
(`apps/api/src/ai/ai.service.ts`):

| Method | Line | Model | What it actually does |
|---|---|---|---|
| `generateProblem` | `:537` | `gpt-4o-mini` | Statement, constraints, tags, estimation spec **and** the whole interview plan |
| `generateCriteria` | `:626` | `gpt-4o-mini` | The rubric + interviewer playbook — the spine of scoring, coaching and discovery |
| `validateSolution` | `:581` | `gpt-4o` | Judges `covered` / `discovered` booleans against an already-written rubric |
| `generateReference` | `:695` | `gpt-4o` | Model answer |
| `matchCriteriaDiscovery` | `:676` | `gpt-4o-mini` | Per-turn conservative matcher (correctly cheap) |
| `extractConstraintProposals` | `:796` | `gpt-4o-mini` | Conservative extraction (correctly cheap) |
| `inferTags` / `inferEstimationSpec` / `inferInterviewPlan` | `:705` / `:726` / `:842` | `gpt-4o-mini` | Backfills |

The two artefacts everything downstream depends on — the problem and the rubric —
run on the cheapest model. Meanwhile the most expensive model is spent on
per-criterion boolean judgement, which is comparatively mechanical and is already
heavily scaffolded by `satisfiedBy` bullets
(`packages/ai-prompts/src/index.ts:376-379`).

A bad rubric poisons the interviewer's coaching, the discovery loop, the
validation and the debrief. A slightly worse `covered` judgement costs one
criterion.

There is also no configurability: every model id is a string literal, so
recalibrating requires a code change and redeploy.

## Desired behaviour

### 1. Centralise

A single `AI_MODELS` map in `apps/api/src/ai/ai.service.ts` (or a small
`ai.models.ts`), keyed by purpose, with env overrides:

```ts
const AI_MODELS = {
  problemGeneration: env("AI_MODEL_PROBLEM",   "gpt-4o"),
  criteriaGeneration: env("AI_MODEL_CRITERIA", "gpt-4o"),
  validation:        env("AI_MODEL_VALIDATION","gpt-4o"),
  reference:         env("AI_MODEL_REFERENCE", "gpt-4o"),
  interviewerChat:   env("AI_MODEL_INTERVIEWER","gpt-4o"),
  tutorChat:         env("AI_MODEL_TUTOR",     "gpt-4o-mini"),
  discoveryMatch:    env("AI_MODEL_DISCOVERY", "gpt-4o-mini"),
  proposals:         env("AI_MODEL_PROPOSALS", "gpt-4o-mini"),
  backfill:          env("AI_MODEL_BACKFILL",  "gpt-4o-mini")
} as const;
```

Read through `ConfigService`, matching how `SCORING_DESIGN_WEIGHT` is handled
(`apps/api/src/solutions/solutions.service.ts:136-142`). No literal model id
anywhere else in the service.

### 2. Promote generation

`problemGeneration` and `criteriaGeneration` move to the stronger tier. Everything
else keeps its current effective model — this task changes **two** assignments and
makes the rest configurable.

### 3. Document

- `.env.example` — every `AI_MODEL_*` key with its default, plus a comment that
  generation quality is the highest-leverage spend.
- `docs/ARCHITECTURE.md` — the AI integration table (§AI integration) currently
  hardcodes model names; make it reference the config keys instead so it cannot
  drift.

### Cost note for the PR body

`generateProblem` runs once per problem (then cached forever on the row) and
`generateCriteria` once per interview start. Neither is on a hot path. The delta
is a few calls per practice session, against a per-turn chat volume that is
already on `gpt-4o` (`streamInterviewer`, `:903`). State the expected impact
explicitly in the PR.

## Files to touch

- `apps/api/src/ai/ai.service.ts` (or new `apps/api/src/ai/ai.models.ts`).
- `.env.example`.
- `docs/ARCHITECTURE.md`.
- `apps/api/src/ai/ai.service.test.ts` — assert override resolution.

## Acceptance criteria

- [ ] No model id string literal remains outside the `AI_MODELS` map — grep for `openai("` returns only map-driven call sites.
- [ ] Every entry is overridable by its documented env var, and an unset var resolves to the documented default.
- [ ] `problemGeneration` and `criteriaGeneration` default to the stronger tier; all other assignments are unchanged from current behaviour.
- [ ] `.env.example` documents every key.
- [ ] `docs/ARCHITECTURE.md`'s AI table references config keys rather than hardcoded model names.
- [ ] A test asserts that an override env var changes the resolved model and that an empty/garbage value falls back to the default rather than throwing.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Switching provider or SDK.
- Per-difficulty model selection.
- Adding retry/fallback chains.
