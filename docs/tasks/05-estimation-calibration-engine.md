# 05 · Deterministic calibration + derived math for generated specs

**Area:** Estimation · **Priority:** P1 · **Size:** M · **Depends on:** 04
**Labels:** `agent-ready`, `estimation`, `web`, `shared`

> **Status: DONE.** `packages/shared/src/estimationCalibration.ts` — hand-written tokeniser + shunting-yard evaluator (no `eval`), `calibrateField` / `calibrateAll`, `derivedFormulas` for every spec shape.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

**The good path lost the calculator.** `computeLegacyDerivedEstimation`
(`apps/web/src/components/EstimationPanel.tsx:131-173`) computes RPS, peak RPS,
read/write split, storage and bandwidth — real, useful arithmetic. It renders only
when `isLegacyDerivedEstimationSpec(spec)` returns true
(`EstimationPanel.tsx:30`, helper at `packages/shared/src/index.ts:266-270`),
which requires the field keys to match `LEGACY_ESTIMATION_SPEC` **exactly, in
order**.

Every newly generated problem gets a bespoke, problem-specific field set. So every
new problem gets **zero** derived math and falls through to the `derivedHints`
branch (`EstimationPanel.tsx:106-120`) — static strings the user must apply by hand.
The modern path is the one without arithmetic.

Meanwhile nothing anywhere checks a submitted number against anything.

## Desired behaviour

Two additions, both **deterministic and client-side** — no LLM call.

### 1. Magnitude calibration

Using `expectedMagnitude` from task 04, flag each numeric field inline as the user
types (debounced, non-blocking):

| Condition (base units) | Treatment |
|---|---|
| `min <= v <= max` | quiet ✓, no styling change |
| within 10× outside the band | amber "an order of magnitude off" |
| beyond 100× outside the band | rose "several orders of magnitude off" |

Never show the band's numbers before the user has entered a value — that would
turn estimation into a fill-in-the-blank. After a value is entered, show the
direction and the `rationale` ("too low — ~1KB per message is typical for text
chat"), not the target range itself.

New shared module `packages/shared/src/estimationCalibration.ts`:

```ts
export type CalibrationVerdict = "ok" | "off-by-one-order" | "way-off" | "unknown";
export function calibrateField(field: EstimationFieldSpec, baseValue: number | undefined): {
  verdict: CalibrationVerdict;
  direction?: "low" | "high";
  rationale?: string;
};
export function calibrateAll(spec: EstimationProblemSpec, estimation: WorkspaceEstimation): {
  perField: Record<string, ReturnType<typeof calibrateField>>;
  offByOne: number;
  wayOff: number;
};
```

`verdict: "unknown"` whenever the field has no `expectedMagnitude` or the value is
blank — legacy specs get `"unknown"` everywhere and render exactly as today.

### 2. Derived math for **all** specs

Replace the exact-key-match gate with unit-kind inference so bespoke specs get
arithmetic too. Add an optional `derivedFormulas` block to
`EstimationProblemSpecSchema` (`packages/shared/src/index.ts:234`):

```ts
derivedFormulas: z.array(z.object({
  id: z.string().max(40).regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().max(80),                       // "Peak RPS"
  expression: z.string().max(200),                 // "dau * sessions_per_day / 86400 * peak_ratio"
  unitKind: z.enum(["count", "bytes", "seconds", "ratio", "currency"]),
  displayUnit: z.string().max(24).optional()
})).max(6).optional()
```

`expression` references field `key`s and supports only `+ - * / ( )` and numeric
literals. Evaluate it with a **small hand-written tokeniser + shunting-yard
evaluator** in `packages/shared/src/estimationCalibration.ts`.

> **Hard requirement: do not use `eval`, `new Function`, or any dependency that
> compiles strings to code.** The expression comes from an LLM. Unknown
> identifiers, division by zero, and malformed input must return `undefined`, not
> throw.

`buildProblemPrompt` and `inferEstimationSpec` request `derivedFormulas` (2–4 per
problem) alongside `derivedHints`. Keep `derivedHints` — they are qualitative
sanity checks and stay useful.

`computeLegacyDerivedEstimation` and `isLegacyDerivedEstimationSpec` stay for the
legacy spec shape and remain the rendering path when `derivedFormulas` is absent.

## Files to touch

- `packages/shared/src/estimationCalibration.ts` — **new**, exported from `index.ts`.
- `packages/shared/src/index.ts` — `derivedFormulas` on `EstimationProblemSpecSchema`.
- `packages/ai-prompts/src/index.ts`, `apps/api/src/ai/ai.service.ts` — request formulas.
- `apps/web/src/components/EstimationPanel.tsx` — inline verdicts + generic derived block.
- `packages/shared/src/estimationCalibration.test.ts` — **new**.

## Acceptance criteria

- [ ] The expression evaluator is hand-written; the diff contains no `eval`, no `new Function`, and no new runtime dependency.
- [ ] Evaluator tests cover: precedence (`a + b * c`), parentheses, unknown identifier → `undefined`, division by zero → `undefined`, empty/garbage input → `undefined`, and deeply nested parens without stack overflow.
- [ ] `calibrateField` returns `"unknown"` for fields with no `expectedMagnitude` and for blank values; a spec with no bands produces no visual change anywhere.
- [ ] The band's numeric target is never rendered before the user enters a value for that field.
- [ ] After entry, an out-of-band value shows direction + `rationale`, and the styling tier matches the 10× / 100× thresholds.
- [ ] Problems with `derivedFormulas` render a derived block with computed values in the right display units; problems without it fall back to `derivedHints`, and the legacy spec still renders `computeLegacyDerivedEstimation`.
- [ ] Calibration never blocks input, never gates the Validate button, and never fires a network request.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Feeding calibration results into the score — that is task 06.
- Nudging the candidate to fill the checklist — that is task 06's completeness signal.
