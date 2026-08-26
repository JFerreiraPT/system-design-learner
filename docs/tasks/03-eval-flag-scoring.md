# 03 · Evaluate green/red flags against the transcript

**Area:** Evaluation · **Priority:** P0 · **Size:** M · **Depends on:** 01
**Labels:** `agent-ready`, `evaluation`, `api`, `web`

> **Status: DONE.** Flags block in the validator prompt; observations sanitised against the stored playbook in `apps/api/src/solutions/flagObservations.ts`; `FlagsPanel` renders them. Scores untouched.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

The interview kit's System Design section is built around **observable behaviour
checkboxes** — its Green Flags / Red Flags lists are what the interviewer actually
fills in, and they feed the 1–4 score directly. Examples from
`templates/backend-senior/variant-1.md`:

> **Green:** Chooses an appropriate algorithm and justifies it · Adapts design when challenged with new constraints
> **Red:** In-memory counter — breaks immediately on multi-node deployment · Cannot explain how clients know when to retry

We generate exactly this. `InterviewerPlaybookAreaSchema`
(`packages/shared/src/index.ts:432-433`) requires 1–6 `greenFlags` and 1–6
`redFlags` per probe area, the prompt demands they be "concrete observable
signals, not generic praise" (`packages/ai-prompts/src/index.ts:274-275`), and
they are normalised and persisted (`apps/api/src/ai/ai.service.ts:422-431`).

They are then read by exactly one function — `formatPlaybookBlock`
(`packages/ai-prompts/src/index.ts:593-594`) — which injects them into the
interviewer's private prompt so it knows what to probe for. **Nothing ever
evaluates whether a flag actually fired.** The single highest-signal feedback the
candidate could receive is generated, stored, and discarded.

The transcript is already available to the validator: `SolutionsService.validate`
loads and formats the full interview transcript
(`apps/api/src/solutions/solutions.service.ts:175-190`) and passes it into
`buildValidationPrompt` (`packages/ai-prompts/src/index.ts:433-442`).

## Desired behaviour

The validator marks which flags fired, citing evidence. The Validate panel shows
them as two lists.

### Prompt

Extend `buildValidationPrompt` (`packages/ai-prompts/src/index.ts:346`) with an
optional `playbook` in its `scope` argument. When present, append a block listing
every flag with a stable address (`areaId` + index + `kind`), and instruct:

- Mark a flag as fired **only** on direct evidence in the diagram, notes, or
  transcript — quote or paraphrase the evidence.
- Be conservative. An unfired green flag is not a red flag, and vice versa; they
  are independent observations, not two ends of one axis.
- Do **not** infer a red flag purely from absence unless the flag itself is
  phrased as an absence ("Never mentions monitoring").

### Schema

Add to `packages/shared/src/index.ts`:

```ts
export const FlagObservationSchema = z.object({
  areaId: z.string().min(1).max(80),
  kind: z.enum(["green", "red"]),
  index: z.number().int().nonnegative(),   // position within that area's flag array
  text: z.string().max(220),               // denormalised so the UI needs no join
  fired: z.boolean(),
  evidence: z.string().max(500).optional()
});
```

and `flagObservations: z.array(FlagObservationSchema).max(60).optional()` on
`ValidationFeedbackSchema` (`:118`).

Mirror it on the validator's output schema in
`apps/api/src/ai/ai.service.ts` (`ValidationSchema`, near `:207-230`).

### Server hardening

Do not trust model-supplied `areaId`/`index`/`text`. In `computeServerScores`
(or a dedicated helper), drop observations whose `(areaId, kind, index)` does not
resolve against the stored playbook, and overwrite `text` from the playbook so
the UI can never render a hallucinated flag.

### Scoring

Flags are **reported, not scored** in this task — they do not move `designScore`.
Keeping them descriptive avoids double-counting the criteria they overlap with,
and gives us a calibration period before wiring them into the number.

### UI

New `FlagsPanel` component in `apps/web/src/components/`, rendered in the Validate
tab under the rubric reveal (`apps/web/src/pages/WorkspacePage.tsx:869-878`):

- Two columns: "What went well" (fired greens) / "Watch out" (fired reds).
- Unfired flags collapsed behind a "show N not observed" toggle, matching the
  stretch-criteria disclosure pattern in
  `apps/web/src/components/CriteriaReveal.tsx:83-92`.
- Evidence shown as a small muted line under each fired flag, like
  `CriterionItem`'s evidence line (`CriteriaReveal.tsx:150-152`).

## Files to touch

- `packages/shared/src/index.ts` — `FlagObservationSchema`, `ValidationFeedbackSchema`.
- `packages/ai-prompts/src/index.ts` — `buildValidationPrompt` accepts + formats the playbook.
- `apps/api/src/ai/ai.service.ts` — validator output schema, pass playbook through `validateSolution`.
- `apps/api/src/solutions/solutions.service.ts` — load playbook (same read as task 02), pass to the AI call, sanitise observations before persisting.
- `apps/web/src/lib/api.ts`, `apps/web/src/components/FlagsPanel.tsx` (new), `apps/web/src/pages/WorkspacePage.tsx`.
- `packages/ai-prompts/src/index.test.ts` — prompt-shape assertions.

## Acceptance criteria

- [ ] `buildValidationPrompt` includes a flags block **only** when a playbook is supplied, and the existing prompt output is unchanged when it is not (assert this in `packages/ai-prompts/src/index.test.ts`).
- [ ] Every flag from every `areasToProbe` entry appears in the prompt with a resolvable address.
- [ ] `ValidationFeedback.flagObservations` is persisted, and every entry resolves to a real flag in the interview's stored playbook — observations that do not resolve are dropped server-side, not rendered.
- [ ] `text` on persisted observations always comes from the stored playbook, never from the model output.
- [ ] `designScore`, `discoveryScore` and `score` are numerically unchanged by this task — add a test asserting a fixture scores identically with and without `flagObservations` present.
- [ ] The Validate tab renders fired greens and fired reds separately, with evidence, and collapses unobserved flags behind a toggle.
- [ ] Legacy interviews (no playbook) and non-interview validations render no flags panel and do not error.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Letting flags influence the numeric score (revisit after a calibration period).
- Per-area flag aggregation on the dashboard.
- Changing how `greenFlags` / `redFlags` are generated.
