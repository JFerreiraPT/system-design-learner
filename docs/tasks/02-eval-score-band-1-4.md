# 02 · Surface the generated 1–4 score band

**Area:** Evaluation · **Priority:** P0 · **Size:** S · **Depends on:** 01
**Labels:** `agent-ready`, `evaluation`, `web`, `api`

> **Status: DONE.** `scoreBandFor` in `@sdl/shared`; `scoreBand` persisted; `ScoreBandCallout` renders above the subscores.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

Every interview generates a per-problem, per-level **1–4 score band table** —
calibrated language for "does this meet the bar", modelled directly on the
interview kit's score tables (`templates/*/variant-*.md`, §2 *Score*).

It is:

- required by the generation prompt (`packages/ai-prompts/src/index.ts:276`),
- validated and normalised (`apps/api/src/ai/ai.service.ts:458-462`),
- persisted in `interviews.criteria_json` under `playbook.scoreRubric`
  (`packages/shared/src/index.ts:437-444`),
- readable via `getRubricPlaybook` (`packages/shared/src/index.ts:468`),

…and then used in exactly one place: pasted into the interviewer's **private**
system prompt (`packages/ai-prompts/src/index.ts:612-618`). The candidate never
sees it, and it never touches the final evaluation.

A raw `Score 73` pill (`apps/web/src/pages/WorkspacePage.tsx:955`, `ScorePill`)
carries far less meaning than *"3 — Meets bar: clear design with justified
decisions; discusses trade-offs; identifies key challenges."*

## Desired behaviour

Map the final blended `score` to a band, attach the band's generated description,
and show it as the headline result.

### Band mapping

Deterministic, server-side, in `SolutionsService.computeServerScores`:

| Band | Score range | Meaning |
|---|---|---|
| 1 | 0–39 | Does not meet bar |
| 2 | 40–64 | Below expectations |
| 3 | 65–84 | Meets bar |
| 4 | 85–100 | Exceeds bar |

Thresholds go in a named exported constant so they are testable and tunable.

### Wiring

- `SolutionsService.validate` already loads the interview row when `interviewId`
  is present (`apps/api/src/solutions/solutions.service.ts:158-174`). Read the
  playbook there with `getRubricPlaybook(interview.criteriaJson)` and pass it to
  `computeServerScores`.
- Add to `ValidationFeedbackSchema` (`packages/shared/src/index.ts:118`):
  ```ts
  scoreBand: z.object({
    band: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    label: z.string().max(400)   // playbook.scoreRubric[band]
  }).optional()
  ```
  Optional: legacy interviews have no playbook, and non-interview validations
  have no rubric at all. When the playbook is missing, fall back to a static
  default label per band (mirroring the kit's standard wording) so the band still
  renders.
- Render in the Validate panel above `DesignDiscoverySubscores`
  (`apps/web/src/pages/WorkspacePage.tsx:858`): band number, short label, and
  the full generated description. Colour-code 1/2 warm, 3/4 cool, consistent with
  `IMPORTANCE_BADGE_CLASS` in `apps/web/src/components/CriteriaReveal.tsx:11-15`.

## Files to touch

- `packages/shared/src/index.ts` — `ValidationFeedbackSchema` + band constants + a
  `scoreBandFor(score: number): 1|2|3|4` helper (shared so web and api agree).
- `apps/api/src/solutions/solutions.service.ts` — load playbook, populate `scoreBand`.
- `apps/web/src/lib/api.ts` — `ValidationFeedback` type (`:63`).
- `apps/web/src/components/DimensionBreakdown.tsx` — new `ScoreBandCallout` export
  (it already owns the score-presentation components).
- `apps/web/src/pages/WorkspacePage.tsx` — render it in the Validate tab.
- Tests for `scoreBandFor` and for playbook-missing fallback.

## Acceptance criteria

- [ ] `scoreBandFor` lives in `@sdl/shared`, is exported, and is the only place band thresholds are defined.
- [ ] `ValidationFeedback.scoreBand` is populated on every new validation that has an `interviewId` with a playbook.
- [ ] When the interview has no playbook (legacy `criteria_json`, or a validation with no `interviewId`), the band is still computed and a static default label is used — the callout never renders empty and never crashes.
- [ ] The Validate tab shows the band prominently above the design/discovery subscores, with the generated description text.
- [ ] Boundary values are covered by tests: 0, 39, 40, 64, 65, 84, 85, 100.
- [ ] Legacy `solutions` rows without `scoreBand` render the existing `ScorePill` and no band callout — no crash, no empty box.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Changing how `score` itself is computed (that is task 01).
- Showing the band on the dashboard or in the export (export is task 16).
- Regenerating playbooks for legacy interviews.
