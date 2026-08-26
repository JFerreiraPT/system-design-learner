# 06 · `capacityEstimation` dimension so estimates are graded

**Area:** Estimation · **Priority:** P1 · **Size:** M · **Depends on:** 01, 05
**Labels:** `agent-ready`, `estimation`, `evaluation`, `api`, `shared`

> **Status: DONE.** `capacityEstimation` added across all nine consumers; rubric guard + one-shot regeneration; deterministic digest in `apps/api/src/solutions/estimationDigest.ts` replaces the raw JSON dump.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

The interview plan has an **Estimate** phase (`DEFAULT_INTERVIEW_PLAN`,
`packages/shared/src/index.ts:179`), the workspace has an Estimation tab with a
completion badge (`apps/web/src/pages/WorkspacePage.tsx:615-635`), and the generator
produces a bespoke checklist per problem. None of it is graded.

`ScoreDimensionSchema` (`packages/shared/src/index.ts:58-67`) has eight axes and
none of them is capacity or estimation. Since every rubric criterion must target
exactly one of those eight (`packages/ai-prompts/src/index.ts:228`), **no
criterion can ever be about the estimate.** The numbers reach the validator only
as raw context JSON appended to the prompt
(`apps/api/src/ai/ai.service.ts:559-561`), influencing nothing in particular.

Consequences: you can validate with `0/7` fields filled and lose no points, and a
DAU figure four orders of magnitude off costs nothing.

## Desired behaviour

### 1. Ninth dimension

Add `capacityEstimation` to `ScoreDimensionSchema` and to
`ValidationDimensionsSchema` (`packages/shared/src/index.ts:58`, `:70-79`).

This is an **additive enum change** — audit every exhaustive consumer:

- `apps/web/src/lib/workspaceValidationUi.ts:9-30` — `DIM_KEYS`, `DIM_LABELS`.
- `apps/web/src/lib/exportReport.ts:13-24` — the `keys` tuple.
- `packages/ai-prompts/src/index.ts:388-397` — `allDims` in `buildValidationPrompt`.
- `apps/api/src/solutions/solutions.service.ts:20-29` — `DEFAULT_DIMENSIONS`.

Because the dimension is nullable and null dimensions are already hidden
(`apps/web/src/components/DimensionBreakdown.tsx:20-22`), legacy feedback rows
simply never render it.

### 2. Rubric must cover it

In `buildCriteriaPrompt` (`packages/ai-prompts/src/index.ts:156`), require **at
least one** criterion targeting `capacityEstimation` whenever the problem's
interview plan contains an estimate-like phase. Its `satisfiedBy` bullets should
reference the problem's own estimation field keys.

Add a regeneration guard next to the existing hidden-floor retry in
`generateCriteriaSafely` (`apps/api/src/interview/interview.service.ts:145-153`):
if the plan has an estimate phase and no criterion targets `capacityEstimation`,
retry once with an explicit `regenerationReason`. Same shape as the existing
hidden-count retry — one retry, then accept whatever came back.

### 3. Calibration as validator evidence

`SolutionsService.validate` receives `input.estimation`
(`apps/api/src/solutions/solutions.service.ts:148`) and can load the problem's
`estimationSpecJson` (it already loads the problem row at `:154`). Run
`calibrateAll` (task 05) **server-side** and pass a compact digest into the
prompt instead of raw JSON:

```text
Estimation calibration (deterministic, computed server-side — treat as fact):
- dau: 500000 (within expected band)
- payload_bytes: 4 (SEVERAL ORDERS OF MAGNITUDE LOW — ~1KB per message is typical for text chat)
- retention_days: (not filled)
Filled 5/7 fields. 1 field off by >=100x, 0 fields off by 10x.
```

Instruct the validator to treat the calibration verdicts as ground truth rather
than re-deriving them, and to score `capacityEstimation` from: completeness, the
calibration verdicts, and whether the design's components are consistent with the
numbers the candidate committed to.

### 4. Completeness signal

Include the filled/total ratio in the digest. Do **not** hard-gate the Validate
button — an unfilled checklist should cost points, not block the flow.

## Files to touch

- `packages/shared/src/index.ts` — enum + dimensions schema.
- `apps/web/src/lib/workspaceValidationUi.ts`, `apps/web/src/lib/exportReport.ts`.
- `packages/ai-prompts/src/index.ts` — `allDims`, `buildCriteriaPrompt`, `buildValidationPrompt` digest block.
- `apps/api/src/solutions/solutions.service.ts` — `DEFAULT_DIMENSIONS`, calibration digest, spec load.
- `apps/api/src/interview/interview.service.ts` — regeneration guard.
- Tests: digest formatting, regeneration guard, enum exhaustiveness.

## Acceptance criteria

- [ ] `capacityEstimation` exists in `ScoreDimensionSchema` and `ValidationDimensionsSchema`, and every exhaustive consumer listed above handles it.
- [ ] `DIM_LABELS` has a short label ("Capacity") and the bar renders in `DimensionBreakdown` and the export.
- [ ] Legacy `solutions.feedback_json` rows without the key parse and render unchanged (the dimension is nullable and null bars are already hidden).
- [ ] Rubrics for problems with an estimate-style phase contain ≥1 `capacityEstimation` criterion; the one-shot regeneration guard fires when the first attempt omits it, and is asserted by a test.
- [ ] The validator prompt receives the deterministic calibration digest — including per-field verdicts and the filled/total ratio — instead of only the raw estimation JSON.
- [ ] Raw estimation JSON is no longer the sole estimation input to the prompt.
- [ ] Validation with an empty estimation checklist produces a low-but-non-null `capacityEstimation` score and does not throw.
- [ ] The Validate button is never disabled because of estimation completeness.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Backfilling `capacityEstimation` into historical validations.
- Changing the design/discovery blend weights.
