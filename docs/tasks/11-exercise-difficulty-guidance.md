# 11 · Fill out difficulty guidance for easy/medium/hard/expert

**Area:** Exercises · **Priority:** P2 · **Size:** S · **Depends on:** —
**Labels:** `agent-ready`, `exercises`, `prompts`

> **Status: DONE.** All five difficulties now use the same six slots, with an *avoid* ladder and a concrete component count each; `buildProblemPrompt` carries the anti-compression rule. `CRITERIA_BUDGET_BY_DIFFICULTY` untouched.
> Note: the real-key generation spot-check in the Verification note below was **not** run — it needs a live `OPENAI_API_KEY`.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

`DIFFICULTY_CONTEXT_SNIPPETS` (`packages/ai-prompts/src/index.ts:10-19`) is wildly
asymmetric:

- `beginner` — ~8 lines: tone, domain whitelist, an explicit *avoid* list,
  expected answer breadth ("two to four labeled boxes"), constraint count, tag
  rules.
- `easy` — one sentence.
- `medium` — one sentence.
- `hard` — one sentence.
- `expert` — one sentence.

The four levels actually used in practice get almost no steering. The visible
symptom is difficulty compression: `medium` and `hard` problems come out looking
alike because "Realistic midsize SaaS breadth" and "Large-scale assumptions,
sharper constraints" do not give the generator anything concrete to differentiate
on.

`beginner` got the full treatment because it was failing loudly — the same
structure is what the other four need.

## Desired behaviour

Bring every level to the `beginner` level of specificity, using the same six-slot
structure so they are directly comparable:

1. **Tone** — what the candidate is assumed to already know.
2. **Problem choice** — concrete domain examples appropriate to the level.
3. **Avoid altogether** — an explicit exclusion list. This is the slot doing most
   of the work for `beginner` and it is missing everywhere else.
4. **Expected answer breadth** — roughly how many components a complete answer
   has, stated in boxes-on-a-whiteboard terms.
5. **constraints** — how many seed bullets and at what altitude.
6. **tags** — how many, and which families fit.

The **avoid** slots must form a ladder, so each level is defined partly by what
belongs to the level above it:

- `easy` — avoid multi-region, sharding, consensus, event sourcing, CDN fleets,
  streaming.
- `medium` — avoid multi-region actives, custom consensus, regulatory/compliance
  regimes, exotic storage engines.
- `hard` — avoid compliance-driven narratives unless the domain genuinely implies
  them; avoid research-grade novelty.
- `expert` — nothing excluded; require genuine principal-level ambiguity rather
  than merely a bigger number.

Calibrate breadth against the kit's own examples, which are the target standard:

- `medium` ≈ *"Design an API rate limiter shared across microservices with
  per-user and per-endpoint limits, burst allowances, three tiers"*
  (`templates/backend-senior/variant-1.md`).
- `hard` ≈ same, plus *"~100 microservices and millions of API calls per minute"*
  and a fail-open/fail-closed decision under cluster loss.

Also add a **cross-level anti-compression rule** to `buildProblemPrompt`
(`packages/ai-prompts/src/index.ts:33`): state that difficulty is expressed
through *number of interacting concerns and sharpness of trade-offs*, not through
inflating the user count. A `hard` problem is not a `medium` problem with more
zeros.

## Files to touch

- `packages/ai-prompts/src/index.ts` — `DIFFICULTY_CONTEXT_SNIPPETS`,
  `difficultyContextBlock` (`:22`), `buildProblemPrompt`.
- `packages/ai-prompts/src/index.test.ts` — structural assertions.

## Acceptance criteria

- [ ] All five entries in `DIFFICULTY_CONTEXT_SNIPPETS` use the same six-slot structure.
- [ ] Every level except `expert` has a non-empty explicit *avoid* list, and the lists form the documented ladder.
- [ ] Every level states expected answer breadth in concrete component-count terms.
- [ ] `buildProblemPrompt` contains the anti-compression rule.
- [ ] A test asserts each difficulty's prompt contains its own slots and that no two levels produce identical guidance text.
- [ ] `getCriteriaHiddenMin` and `CRITERIA_BUDGET_BY_DIFFICULTY` (`packages/ai-prompts/src/index.ts:108-127`) are **unchanged** — this task touches generation guidance only.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Changing the difficulty enum or adding levels.
- Regenerating existing problems.
- Rubric budgets or hidden-criteria floors.

## Verification note

This is a prompt-quality change, so unit tests can only assert structure. Before
opening the PR, generate one problem at each of `easy`, `medium`, `hard`, `expert`
against a real key and paste the four titles + constraint lists into the PR body
so the difficulty ladder is visible to a reviewer.
