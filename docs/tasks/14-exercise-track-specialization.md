# 14 · Optional track axis (backend / frontend / fullstack / devops / ai)

**Area:** Exercises · **Priority:** P2 · **Size:** L · **Depends on:** 11
**Labels:** `agent-ready`, `exercises`, `api`, `web`, `shared`

> **Status: DONE.** `TrackSchema` + `problems.track` (nullable); `TRACK_CONTEXT_SNIPPETS` with the four-slot structure and a non-empty *avoid* list per track. Difficulty owns breadth, track owns subject, and the tie-break is stated in the prompt. Omitting the track leaves the prompt byte-identical (asserted). Selector + filter + badges on the dashboard and the Problem rail; `POST /problems/backfill-tracks` leaves unsure problems `NULL`. No new score dimensions.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

Problems vary along **one** axis: `difficulty`
(`packages/shared/src/index.ts:3`), plus a free-text `topic` hint
(`GenerateProblemInputSchema`, `:23-31`).

The interview kit segments by **role**, and the design prompts are genuinely
different in kind, not just in flavour (`PLAYBOOK.md`, §Sample questions by
specialization):

- **Backend** — distributed rate limiter, notification fan-out, distributed cache.
  Probes: algorithms, shared state, delivery guarantees, consistent hashing.
- **Frontend** — collaborative editor, design system, typeahead. Probes: CRDT/OT
  conflict resolution, WebSocket lifecycle, debouncing, state sync, a11y.
- **Fullstack** — e-commerce end-to-end, multi-tenant SaaS dashboard. Probes: the
  seam between UX and data.
- **DevOps** — CI/CD for microservices, monitoring and alerting. Probes: pipeline
  topology, deployment strategies, the three pillars, alert fatigue.
- **AI engineering** — the kit has `ai-engineer-mid`, `ai-engineer-senior`,
  `ai-ml-engineer-senior` templates.

`tags` (`TAG_VOCABULARY_SNIPPET`, `packages/ai-prompts/src/index.ts:26-31`) exist
but are an *output* used for dashboard grouping
(`apps/web/src/pages/DashboardPage.tsx:110-125`) and dedup
(`buildProblemPrompt`'s `existingBlock`, `:65-79`). They never steer the
archetype. So generation drifts toward generic backend-ish problems and a
frontend-leaning practitioner cannot practise the design work they actually do.

## Desired behaviour

### Schema

```ts
export const TrackSchema = z.enum([
  "backend", "frontend", "fullstack", "devops", "ai-engineering"
]);
```

Optional on `GenerateProblemInputSchema` and on `ProblemSchema`; persisted as
`problems.track` (nullable `text`). `NULL` means "unspecified" and reproduces
today's behaviour exactly — this is an additive axis, not a required one.

### Generation

New `TRACK_CONTEXT_SNIPPETS` in `packages/ai-prompts/src/index.ts`, structured
exactly like `DIFFICULTY_CONTEXT_SNIPPETS` after task 11 reshapes it. Per track:

1. **Domain examples** — three or four, taken from or calibrated against the kit's
   per-role lists.
2. **What the design is actually about** — the concerns that define the track
   (`frontend`: conflict resolution, render/state boundaries, network chattiness,
   a11y; `devops`: pipeline topology, blast radius, rollback, signal quality).
3. **Component vocabulary** — what belongs on the board for this track. A frontend
   design has stores, workers, caches, sync channels — not three microservices and
   a Postgres.
4. **Avoid** — concerns that belong to a different track.

Compose with difficulty rather than replacing it: `difficultyContextBlock`
(`:22`) and a new `trackContextBlock` both feed `buildProblemPrompt`. Where they
conflict, difficulty wins on **breadth**, track wins on **subject**.

### Downstream

- **Criteria** — pass track into `buildCriteriaPrompt` (`:156`) so criteria target
  the right concerns. A frontend problem should not be graded on sharding.
- **Interview plan** — `buildProblemPrompt`'s plan section (`:88-104`) already
  permits replacing phases ("skip a dedicated API phase for offline batch
  systems"). Make it track-aware: a frontend interview wants a
  *component/state model* phase, a devops interview a *pipeline topology* phase.
- **Dimensions** — do **not** add track-specific score dimensions. The eight
  (nine after task 06) axes are general enough; out-of-scope dimensions already
  return `null` and are hidden (`apps/web/src/components/DimensionBreakdown.tsx:20-22`).

### UI

- Track selector beside difficulty in the generate form
  (`apps/web/src/pages/DashboardPage.tsx`), with an explicit "Any" default.
- Track filter in the problem list, next to the existing tag filters.
- Track badge on problem cards and on the Problem rail
  (`apps/web/src/components/WorkspaceProblemRail.tsx`).

### Backfill

`POST /problems/backfill-tracks` — infer a track from title + statement + tags for
existing problems, following the `inferTags` pattern
(`apps/api/src/ai/ai.service.ts:702`).

## Files to touch

- `apps/api/src/db/schema.ts` — `track` column + migration.
- `packages/shared/src/index.ts` — `TrackSchema`, `GenerateProblemInputSchema`, `ProblemSchema`.
- `packages/ai-prompts/src/index.ts` — `TRACK_CONTEXT_SNIPPETS`, `trackContextBlock`, `buildProblemPrompt`, `buildCriteriaPrompt`.
- `apps/api/src/ai/ai.service.ts` — generation input, `inferTrack`.
- `apps/api/src/problems/problems.service.ts`, `problems.controller.ts`, `problems.dto.ts`.
- `apps/web/src/pages/DashboardPage.tsx`, `apps/web/src/components/WorkspaceProblemRail.tsx`, `apps/web/src/lib/api.ts`.
- `docs/ARCHITECTURE.md`, `README.md` (backfill list).

## Acceptance criteria

- [ ] `track` is optional everywhere; generating without one produces today's behaviour with no prompt-text change (assert the prompt is unchanged when track is absent).
- [ ] Each track has a `TRACK_CONTEXT_SNIPPETS` entry using the four-slot structure, including a non-empty *avoid* list.
- [ ] Track and difficulty compose: a `beginner` + `frontend` problem respects both the beginner breadth limits and the frontend subject matter.
- [ ] Generated criteria for a `frontend` problem target frontend concerns and do not require sharding/multi-region.
- [ ] Track is selectable on generate, filterable in the list, and shown as a badge on cards and the Problem rail.
- [ ] `POST /problems/backfill-tracks` populates the column for existing problems.
- [ ] Problems with `track = NULL` render without a badge and are included under the "Any" filter.
- [ ] No new score dimensions were added.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- Track-specific scoring dimensions or rubric budgets.
- Per-track board stencils or Excalidraw libraries.
- Making track required.
