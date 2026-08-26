# Improvement tasks — exercises, estimation, flow, evaluation

Each file in this folder is a self-contained task spec, written so the body can be
pasted **verbatim** into a GitHub issue for the autonomous runner
(`pnpm task:start` → `scripts/prompt-for-issue.sh`). Every task carries explicit
acceptance criteria because `validate-done` grades the diff against them.

## Origin

These come from a gap analysis between this repo and the **interview kit**
(`~/Dev_2/interviews/interview-kit`) — specifically `PLAYBOOK.md` and the
`templates/*/variant-*.md` **§2 System Design** sections, which are the reference
for what a real system-design interview section contains.

The kit's System Design section has seven elements. We generate roughly three:

| Kit element | SDL today |
|---|---|
| **The Challenge** + verbatim framing script | `statement` only, no framing |
| "Don't give constraints upfront for senior" | ✅ visible/hidden criteria split |
| **3 progressive reveals** (scale → failure → debug) | per-criterion `discoveryHints` only |
| **Areas to probe**, grouped by phase | ✅ `playbook.areasToProbe` |
| **Green flags / Red flags** | generated + stored, **never scored or shown** |
| **1–4 score band table** | generated as `scoreRubric`, **never used** |
| Interviewer notes → narrative | partial (`strengths` / `gaps`) |

The two highest-value elements — flags and the 1–4 bands — already exist in the
schema, are generated on every interview, and are persisted. They are then only
pasted into the interviewer's *private* prompt
(`packages/ai-prompts/src/index.ts:593-618`) and never reach the candidate or the
score. Several tasks below are pure harvest of data we already pay to produce.

## Priority order

### P0 — scoring correctness (everything else is measured through this)

| # | Task | Area |
|---|---|---|
| [01](01-eval-weighted-design-score.md) ✅ | Weighted-coverage design score, real stretch bonus, one formula | Evaluation |
| [02](02-eval-score-band-1-4.md) ✅ | Surface the generated 1–4 score band | Evaluation |
| [03](03-eval-flag-scoring.md) ✅ | Evaluate green/red flags against the transcript | Evaluation |

### P1 — estimation becomes real

| # | Task | Area |
|---|---|---|
| [04](04-estimation-spec-magnitudes-units.md) ✅ | `expectedMagnitude` + real units in the estimation spec | Estimation |
| [05](05-estimation-calibration-engine.md) ✅ | Deterministic calibration + derived math for generated specs | Estimation |
| [06](06-estimation-scoring-dimension.md) ✅ | `capacityEstimation` dimension so estimates are graded | Estimation |

### P1 — flow closes the loop

| # | Task | Area |
|---|---|---|
| [07](07-flow-end-interview.md) | End an interview: status lifecycle + wrap-up + debrief | Flow |
| [08](08-flow-persist-phase-timeline.md) | Persist phase transitions server-side | Flow |
| [09](09-flow-phase-transition-prompts.md) | Interviewer proposes phase transitions | Flow |

### P2 — exercise quality

| # | Task | Area |
|---|---|---|
| [10](10-exercise-signature-challenge.md) | `signatureChallenge` + `progressiveReveals` on problems | Exercises |
| [11](11-exercise-difficulty-guidance.md) | Fill out difficulty guidance for easy/medium/hard/expert | Exercises |
| [12](12-exercise-reference-from-live-rubric.md) | Build the reference solution from the live rubric | Exercises |
| [13](13-exercise-model-tier-rebalance.md) | Rebalance model tiers (generation vs grading) | Exercises |
| [14](14-exercise-track-specialization.md) | Optional track axis (backend / frontend / fullstack / devops / ai) | Exercises |

### P2 — evaluation depth and reporting

| # | Task | Area |
|---|---|---|
| [15](15-eval-proactiveness-assessment.md) | Score proactiveness / communication from the transcript | Evaluation |
| [16](16-eval-complete-export-report.md) | Export the full debrief, not half of it | Evaluation |

### P3 — integrity and cleanup

| # | Task | Area |
|---|---|---|
| [17](17-flow-level-change-rubric-resync.md) | Level change mid-interview desyncs the rubric | Flow |
| [18](18-flow-tutor-usage-visibility.md) | Record tutor usage in the debrief | Flow |
| [19](19-cleanup-dead-progressive-nudges.md) | Wire or remove dead `RubricCriterion.progressiveNudges` | Cleanup |

## Status

Tasks 01-06 are **implemented and verified** on the working tree (typecheck +
tests green across all six workspaces). Each completed file carries a `Status:
DONE` banner naming the modules that landed.

> **Line references drift.** Every `file:line` in these documents was accurate
> against the tree as of writing. Tasks 01-06 edited several of those files, so
> references into `packages/shared/src/index.ts`,
> `packages/ai-prompts/src/index.ts`, `apps/api/src/ai/ai.service.ts`,
> `apps/api/src/solutions/solutions.service.ts` and
> `apps/web/src/pages/WorkspacePage.tsx` have shifted. The symbol names are
> still correct — grep for those rather than trusting the numbers.

## Dependency graph

```text
01 ──┬─> 02 ──> 16
     ├─> 03 ──> 16
     ├─> 15 ──> 16
     └─> 06
04 ──> 05 ──> 06
07 ──┬─> 16
08 ──┴─> 09
10 ──> 12
```

Tasks with no inbound edge can start immediately and in parallel.
`01` is the one true blocker: it changes the meaning of `score`, and `02`, `03`,
`06` and `15` all write into the same feedback object.

## Conventions for every task

- Branch: `feat/issue-<N>` (created by the runner).
- Commit: conventional, footer `Refs: #<N>`.
- Tests: `tests-for-diff` — cover only the behaviour the diff introduces.
- Gate: `validate-done` ≥ 95 before PR.
- Schema changes: add the column in `apps/api/src/db/schema.ts`, then
  `pnpm db:generate`; note in the PR that `pnpm db:push` is needed. Never
  backfill destructively — legacy rows stay `NULL` and services must tolerate it.
- Back-compat is mandatory: every persisted shape here already has rows in the
  wild with `NULL` (`criteria_json`, `estimation_spec_json`, `interview_plan_json`).
  New optional fields must not break `getRubricCriteria` / `getRubricPlaybook`
  parsing of old rows.
