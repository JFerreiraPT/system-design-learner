# 19 · Wire or remove dead `RubricCriterion.progressiveNudges`

**Area:** Cleanup · **Priority:** P3 · **Size:** S · **Depends on:** —
**Labels:** `agent-ready`, `cleanup`, `prompts`

## Problem

There are **two** `progressiveNudges` fields. One is used; one is dead.

**Used** — `InterviewerPlaybookAreaSchema.progressiveNudges`
(`packages/shared/src/index.ts:427-431`), a required 3-tuple per probe area. Read
by `formatPlaybookBlock` (`packages/ai-prompts/src/index.ts:592`) and injected
into the interviewer's private prompt.

**Dead** — `RubricCriterion.progressiveNudges`
(`packages/shared/src/index.ts:395-399`), an optional 3-tuple per criterion. It is:

- requested by the generation prompt (`packages/ai-prompts/src/index.ts:259`),
- accepted by the AI output schema (`apps/api/src/ai/ai.service.ts:207`),
- normalised through `normalizeThreeNudges` (`apps/api/src/ai/ai.service.ts:349-353`),
- persisted into `interviews.criteria_json`,

and then **read by nothing.** Grep confirms the only consumers of the identifier
are the schema, the normaliser, and test fixtures. The interviewer prompt's
undiscovered-criteria block uses `discoveryHints` only
(`packages/ai-prompts/src/index.ts:649-668`), and `CriteriaReveal` uses
`discoveryHints[0]` (`apps/web/src/components/CriteriaReveal.tsx:153-157`).

We pay generation tokens for it on every interview and store it forever.

## Desired behaviour

Pick **one** — implement it fully, and state in the PR which was chosen and why.

### Option A (preferred) — wire it up

Criterion-level nudges are strictly better than area-level ones for the coaching
path, because the interviewer's coaching rules operate on a *specific undiscovered
criterion* (`COACHING_RULES_BY_LEVEL`, `packages/ai-prompts/src/index.ts:563-581`)
while the playbook block operates on a *probe area*. Today that per-criterion
coaching has only `discoveryHints` — flat phrasings with no escalation.

In `buildInterviewerPrompt`'s `undiscoveredBlock` (`:649-668`), emit
`progressiveNudges` when present and instruct the model to escalate in order
across turns: gentle first, sharpen only if the candidate stays on the same topic
without surfacing it. Keep `discoveryHints` as the fallback when nudges are
absent.

This also improves `CriteriaReveal`: the post-validate "Try asking:" line
(`CriteriaReveal.tsx:153-157`) can show the *gentle* nudge, which reads better as
a study prompt than a bare hint.

### Option B — remove it

Delete the field from `RubricCriterionSchema`, the generation prompt line, the AI
output schema, and the normaliser. Keep parsing tolerant of the extra key so
existing `criteria_json` rows still validate (Zod objects strip unknown keys by
default — verify, do not assume). Remove it from test fixtures.

## Files to touch

- `packages/shared/src/index.ts` — `RubricCriterionSchema`.
- `packages/ai-prompts/src/index.ts` — `buildCriteriaPrompt` (`:259`), `buildInterviewerPrompt` (Option A).
- `apps/api/src/ai/ai.service.ts` — output schema (`:207`), `normalizeThreeNudges` (`:349`).
- `apps/web/src/components/CriteriaReveal.tsx` (Option A).
- Test fixtures in `packages/shared/src/index.test.ts`, `packages/ai-prompts/src/index.test.ts`, `apps/api/src/ai/ai.service.test.ts`.

## Acceptance criteria

- [ ] The PR body states which option was taken and why.
- [ ] **No** field is left in the state of being generated, validated, and persisted but never read — verify with a grep over `apps` and `packages` and paste the result in the PR.
- [ ] Existing `interviews.criteria_json` rows parse successfully under the new schema, whether or not they contain the key — covered by a test using a realistic legacy fixture.
- [ ] Option A only: the interviewer prompt includes criterion-level nudges with an explicit escalation rule when present, and falls back to `discoveryHints` when absent — assert both branches.
- [ ] Option A only: `CriteriaReveal` prefers the gentle nudge over the raw hint when available.
- [ ] Option B only: no reference to `RubricCriterion.progressiveNudges` remains anywhere, including prompts and fixtures.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Touching `InterviewerPlaybookArea.progressiveNudges` — that one is live and correct.
- Regenerating criteria for existing interviews.
