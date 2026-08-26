# 04 · `expectedMagnitude` + real units in the estimation spec

**Area:** Estimation · **Priority:** P1 · **Size:** M · **Depends on:** —
**Labels:** `agent-ready`, `estimation`, `api`, `shared`

> **Status: DONE.** `unitKind` / `displayUnit` / `displayMultiplier` / `expectedMagnitude` on the field spec; `toBaseUnit` / `fromBaseUnit`; `normalizeEstimationSpec` guard; backfill takes `?force=true`.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

The estimation checklist cannot tell the candidate the one thing that matters in
back-of-envelope practice: **you are off by four orders of magnitude.**

`EstimationFieldSpecSchema` (`packages/shared/src/index.ts:220-232`) carries
`key`, `label`, `type`, `placeholder`, `hint`, `unit`. There is no target range,
so no code — deterministic or otherwise — can judge a submitted number. The
generator is asked only for `derivedHints`: 3–6 free-text "sanity check" strings
(`packages/ai-prompts/src/index.ts:47-50`) that the candidate must apply to
themselves by hand.

`unit` is worse than absent — it is decorative. The label renders as
`Payload (KB)` (`apps/web/src/components/EstimationPanel.tsx:51-57`) but the stored
value is a bare `number`. A candidate typing `2` meaning 2 KB and one typing
`2048` meaning 2048 bytes are indistinguishable downstream, and both are dumped
straight into the validator prompt as raw JSON
(`apps/api/src/ai/ai.service.ts:559-561`) where the model silently guesses.

## Desired behaviour

Numeric estimation fields get a canonical unit and an expected order-of-magnitude
band, produced at generation time.

### Schema

Extend `EstimationFieldSpecSchema` (`packages/shared/src/index.ts:220`):

```ts
/** Canonical unit family. `count` = dimensionless. Values are always stored in
 *  the family's BASE unit (bytes, seconds, count) regardless of display unit. */
unitKind: z.enum(["count", "bytes", "seconds", "ratio", "currency"]).optional(),
/** Display unit within the family, e.g. "KB", "ms", "req/s". Presentation only. */
displayUnit: z.string().max(24).optional(),
/** Multiply the entered display value by this to reach the base unit
 *  (KB -> 1024, ms -> 0.001). Defaults to 1. */
displayMultiplier: z.number().positive().optional(),
/** Order-of-magnitude band a reasonable answer falls in, in BASE units.
 *  Deliberately wide — this checks magnitude, not arithmetic. */
expectedMagnitude: z.object({
  min: z.number().positive(),
  max: z.number().positive(),
  rationale: z.string().max(300).optional()
}).optional()
```

All new fields are **optional**: `problems.estimation_spec_json` has existing rows
and `LEGACY_ESTIMATION_SPEC` (`:242`) must keep parsing untouched.

Add a shared helper so web and api agree on conversion:

```ts
export function toBaseUnit(field: EstimationFieldSpec, displayValue: number): number
export function fromBaseUnit(field: EstimationFieldSpec, baseValue: number): number
```

### Generation

`buildProblemPrompt` (`packages/ai-prompts/src/index.ts:33`) and
`inferEstimationSpec` (`apps/api/src/ai/ai.service.ts:718`) must both request the
new fields. Prompt rules:

- Every `type: "number"` field MUST have `unitKind` and `expectedMagnitude`.
  `type: "text"` fields must have neither.
- `expectedMagnitude.min` / `.max` are expressed in the **base** unit and should
  span **at least one order of magnitude** (`max >= min * 10`) — we are checking
  whether the candidate is in the right ballpark, not marking arithmetic.
- `rationale` is one short clause explaining the band ("~1KB per message is
  typical for text chat") so it can be shown after a mismatch.
- Bands must be anchored to the problem's own stated scale, not generic web-scale
  defaults, and must respect the difficulty (`beginner` problems are explicitly
  scoped to homework scale — see `DIFFICULTY_CONTEXT_SNIPPETS`,
  `packages/ai-prompts/src/index.ts:10-14`).

### Storage semantics

The persisted `solutions.estimation_json` / workspace estimation record stores
**base-unit values**. The `EstimationPanel` input shows and accepts display units
and converts on change. This is the single behavioural break in this task, so:

- Extend `apps/web/src/lib/estimationMigrate.ts` to be spec-aware: values loaded
  from `localStorage` that predate this change are already in whatever unit the
  user typed. Treat legacy stored values as **already base** (no conversion) —
  fields without `displayMultiplier` convert with factor 1, so this is a no-op
  for every legacy spec.

### Backfill

Extend the existing `POST /problems/backfill-estimation-specs` endpoint
(`apps/api/src/problems/problems.controller.ts`) so re-running it regenerates
specs with the new fields. Do not auto-run it.

## Files to touch

- `packages/shared/src/index.ts` — schema + `toBaseUnit` / `fromBaseUnit`.
- `packages/ai-prompts/src/index.ts` — `buildProblemPrompt` estimation section.
- `apps/api/src/ai/ai.service.ts` — `inferEstimationSpec` prompt.
- `apps/web/src/components/EstimationPanel.tsx` — display-unit label + conversion on change.
- `apps/web/src/lib/estimationMigrate.ts` — spec-aware migration.
- `packages/shared/src/index.test.ts` — conversion round-trip tests.

## Acceptance criteria

- [ ] `EstimationFieldSpecSchema` accepts the new optional fields and still parses `LEGACY_ESTIMATION_SPEC` and every existing persisted spec shape unchanged.
- [ ] `toBaseUnit` / `fromBaseUnit` round-trip losslessly for `count`, `bytes`, `seconds`, `ratio`, `currency`, and are identity functions when `displayMultiplier` is absent.
- [ ] Newly generated problems emit `unitKind` + `expectedMagnitude` on **every** numeric field and on **no** text field.
- [ ] Generated bands satisfy `max >= min * 10`; add a runtime guard that drops a malformed `expectedMagnitude` rather than persisting it.
- [ ] `EstimationPanel` shows `displayUnit` in the field label and stores base-unit values.
- [ ] A spec with none of the new fields behaves exactly as today — no conversion, no visual change.
- [ ] `POST /problems/backfill-estimation-specs` regenerates specs including the new fields.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Any calibration feedback UI or derived arithmetic — that is task 05.
- Scoring the estimate — that is task 06.
- Migrating `solutions.estimation_json` history.
