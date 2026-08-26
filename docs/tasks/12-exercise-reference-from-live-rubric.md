# 12 · Build the reference solution from the live rubric

**Area:** Exercises · **Priority:** P2 · **Size:** S · **Depends on:** 10 (soft)
**Labels:** `agent-ready`, `exercises`, `api`

> **Status: DONE.** `GET /problems/:id/reference?interviewId=` builds from live constraints + the full rubric + `signatureChallenge`, cached on the new `interviews.reference_json`; without the parameter the prompt is byte-identical to before (asserted). `criterionCoverage` ids are resolved server-side and unresolvable ones dropped; the Validate tab pairs each missed criterion with its coverage line.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

The reference solution and the grade disagree, and the candidate sees both.

`buildReferenceSolutionPrompt` (`packages/ai-prompts/src/index.ts:473-497`) takes
only `title`, `statement`, `difficulty`, `constraints` — and the constraints it
receives are the **seed** bullets from `problems.constraints_json`, not the
interview's live scope.

It therefore never sees:

- the per-interview **rubric criteria**, including every `hidden` criterion the
  candidate was graded on missing (`interviews.criteria_json`);
- the **live constraints**, which are the actual source of truth for scope during
  an interview (`interviews.live_constraints_json`, and the validator explicitly
  scores against them — `apps/api/src/solutions/solutions.service.ts:169-173`);
- the problem's `signatureChallenge` once task 10 lands.

The result: a candidate is penalised for missing `per_user_isolation`, opens the
reference solution unlocked by that same validation
(`apps/web/src/pages/WorkspacePage.tsx:883-905`, gated on `hasValidationAttempt`),
and finds a model answer that never mentions isolation. The "here is what good
looks like" moment actively contradicts the score.

There is a second, structural issue: the reference is cached per **problem**
(`problems.reference_json`, `apps/api/src/db/schema.ts:15`) while rubrics are per
**interview**. One cached reference cannot serve rubrics that differ by
interviewer level.

## Desired behaviour

### Interview-aware reference

`GET /problems/:id/reference` accepts an optional `?interviewId=` query parameter.
The web client already knows the interview id in the Validate tab and should pass
it.

When `interviewId` is present and the interview has criteria:

- Build the prompt from **live active constraints** + the **full criteria set**
  (both visible and hidden, with `satisfiedBy` bullets) + `signatureChallenge`
  when available.
- Require the reference to explicitly address every `core` criterion, and to
  discuss the `signatureChallenge` in `keyTradeoffs` or `deepDives`.
- Cache under a **separate key** — `interviews.reference_json` (new nullable
  column) — so the per-problem cache stays valid for the no-interview path.

When `interviewId` is absent or the interview has no criteria, behaviour is
exactly today's: seed constraints, `problems.reference_json` cache.

### Prompt

Extend `buildReferenceSolutionPrompt`'s input with optional `criteria` and
`signatureChallenge`. Add an output field so the mapping is checkable:

```ts
/** For each core criterion id, one sentence on how this reference addresses it.
 *  Lets the UI show "this is what covering `per_user_isolation` looks like". */
criterionCoverage: z.array(z.object({
  criterionId: z.string().max(80),
  howAddressed: z.string().max(300)
})).optional()
```

Add it to `ReferenceSolutionSchema` (`packages/shared/src/index.ts:82-95`) as
optional so cached legacy references keep parsing.

### UI

In the reference block (`apps/web/src/pages/WorkspacePage.tsx:883-905`), when
`criterionCoverage` exists, show the coverage line for each criterion the
candidate **missed** directly beneath the rubric reveal
(`apps/web/src/components/CriteriaReveal.tsx`). That is the highest-value pairing
in the whole panel: *here is what you missed → here is what covering it looks
like.*

## Files to touch

- `apps/api/src/db/schema.ts` — `interviews.reference_json` + migration.
- `packages/shared/src/index.ts` — `ReferenceSolutionSchema`.
- `packages/ai-prompts/src/index.ts` — `buildReferenceSolutionPrompt`.
- `apps/api/src/ai/ai.service.ts` — `generateReference` signature.
- `apps/api/src/problems/problems.service.ts`, `problems.controller.ts` — query param, cache split.
- `apps/web/src/lib/api.ts`, `apps/web/src/pages/WorkspacePage.tsx`.
- `docs/ARCHITECTURE.md`.

## Acceptance criteria

- [ ] `GET /problems/:id/reference?interviewId=…` builds the reference from live constraints + full criteria; without the parameter behaviour is byte-for-byte unchanged.
- [ ] Interview-scoped references cache on `interviews.reference_json`; the per-problem cache is never overwritten by an interview-scoped generation.
- [ ] The generated reference addresses every `core` criterion, and `criterionCoverage` resolves to real criterion ids from that interview — unresolvable ids are dropped server-side.
- [ ] The Validate tab pairs each **missed** criterion with its coverage line when available.
- [ ] Cached legacy references (no `criterionCoverage`) parse and render unchanged.
- [ ] The existing reveal gate is preserved: the reference stays locked until at least one validation exists.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Invalidating or regenerating existing `problems.reference_json` rows.
- Generating a reference *diagram*.
