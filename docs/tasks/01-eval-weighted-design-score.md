# 01 · Weighted-coverage design score, real stretch bonus, one formula

**Area:** Evaluation · **Priority:** P0 · **Size:** M · **Depends on:** —
**Labels:** `agent-ready`, `evaluation`, `api`

> **Status: DONE.** Weighted coverage ratio replaces flat penalties; stretch bonus live; `scoringMode` persisted. Scoring extracted to `apps/api/src/solutions/scoring.ts`.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

`designScore` is computed as a flat subtraction from 100, which produces three
distinct defects:

1. **Rubric size changes the meaning of the score.** A miss costs the same
   absolute points whether the rubric has 5 criteria or 14. `beginner` rubrics
   cap at 6 criteria and `expert` at 14 (`CRITERIA_BUDGET_BY_DIFFICULTY`,
   `packages/ai-prompts/src/index.ts:113-127`), so the same *proportional*
   performance yields wildly different scores across difficulties.
2. **Four missed cores = 0.** `SEVERITY_PENALTY.high` is 25
   (`apps/api/src/solutions/solutions.service.ts:35`), so four high-severity
   misses zero the score regardless of everything covered. There is no floor and
   no credit for what *was* done.
3. **`importance` barely participates.** `IMPORTANCE_WEIGHT`
   (`solutions.service.ts:37`) is used **only** for `discoveryScore`
   (`:314-318`). In the design path, `importance` merely selects a *default*
   severity when the model omits one (`:302-303`) — a `core` and an `expected`
   miss that both come back `severity: "high"` cost exactly the same.

Additionally:

- **Stretch criteria are inert.** Documented as "bonus only"; implemented as
  `if (c.importance === "stretch") continue;` (`solutions.service.ts:301`).
  No bonus is ever added anywhere. Nailing a stretch criterion and ignoring it
  produce identical scores.
- **Two incompatible scoring regimes share one field.** With criteria,
  `designScore = 100 − penalties` (`:311`). Without criteria, `designScore` is
  the *mean of the dimension bars* (`:274`, via `estimateScoreFromDimensions`
  at `:120`). Different scales, same `score` column, plotted on the same
  dashboard trend (`apps/web/src/pages/DashboardPage.tsx:110-125`).

## Desired behaviour

One formula: **weighted coverage ratio**, with severity acting as a partial-credit
modifier rather than an absolute penalty.

```text
weight(c)        = IMPORTANCE_WEIGHT[c.importance]        // core 3, expected 2, stretch 1
credit(c, ev)    = ev.covered ? 1
                 : ev.severity === "low"    ? 0.5          // partially addressed
                 : ev.severity === "medium" ? 0.25
                 : 0                                       // "high" (or default) = no credit

gradedCriteria   = criteria where importance !== "stretch"
earned           = Σ weight(c) × credit(c, ev)   over gradedCriteria
total            = Σ weight(c)                   over gradedCriteria
baseDesign       = total > 0 ? 100 × earned / total : <dimension fallback>

stretchCovered   = count of covered stretch criteria
stretchBonus     = min(STRETCH_BONUS_CAP, stretchCovered × STRETCH_BONUS_PER_ITEM)

designScore      = clamp(0, 100, round(baseDesign + stretchBonus))
```

Constants (module-level, named, commented):

- `STRETCH_BONUS_PER_ITEM = 3`
- `STRETCH_BONUS_CAP = 6`

`discoveryScore` and the `score` blend (`this.designWeight`) are **unchanged**.

### Reconciling the no-criteria path

When `criteria` is null/empty or the model returned no `criteriaEvaluations`, keep
using `estimateScoreFromDimensions` — but that is now the documented *fallback*
rather than a parallel regime. Persist which one ran so the UI and dashboard can
avoid mixing them:

- Add `scoringMode: "rubric" | "dimensions"` to `ValidationFeedbackSchema`
  (`packages/shared/src/index.ts:118`), optional for back-compat.
- Set it in `computeServerScores` on both branches.

## Files to touch

- `apps/api/src/solutions/solutions.service.ts` — `computeServerScores` (`:251-323`),
  constants (`:33-37`).
- `packages/shared/src/index.ts` — `ValidationFeedbackSchema` gains optional
  `scoringMode`.
- `apps/api/src/solutions/solutions.service.test.ts` — **new file**.

## Acceptance criteria

- [ ] `SEVERITY_PENALTY` is removed; scoring is a weighted coverage ratio as specified above.
- [ ] `IMPORTANCE_WEIGHT` is used in the **design** path, not only the discovery path.
- [ ] Covered `stretch` criteria add a bonus, capped at `STRETCH_BONUS_CAP`; missing a stretch criterion still costs nothing.
- [ ] `designScore` is always in `[0, 100]` and is never `0` when at least one non-stretch criterion is covered.
- [ ] Rubric size no longer changes the score for equivalent proportional performance: a 6-criterion rubric with half the weight covered and a 14-criterion rubric with half the weight covered produce the same `designScore`.
- [ ] `ValidationFeedback.scoringMode` is `"rubric"` when criteria evaluations drove the score and `"dimensions"` when the fallback ran; the field is optional so legacy `solutions` rows still parse.
- [ ] `discoveryScore` behaviour and the `SCORING_DESIGN_WEIGHT` blend are byte-for-byte unchanged.
- [ ] `coreCovered` / `coreMissed` remain populated exactly as before.
- [ ] Unit tests cover: all covered → 100 (+bonus); all missed → 0; mixed severities give partial credit; stretch-only rubric does not divide by zero; empty `criteriaEvaluations` falls back to the dimensions path and sets `scoringMode: "dimensions"`; unknown `criterionId` in the evaluations array is ignored without throwing.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Changing `SCORING_DESIGN_WEIGHT` or its default.
- Re-scoring historical `solutions` rows. Old rows keep their stored `score`;
  no migration, no backfill.
- Any UI change beyond what typechecking forces.

## Notes

`solutions.validate` caches on `inputHash` (`solutions.service.ts:203-211`), so
changing the formula does **not** invalidate existing cached rows — that is
intentional and acceptable. Historical scores stay comparable within themselves;
the dashboard mixing old and new is accepted for now and is why `scoringMode` gets
persisted.
