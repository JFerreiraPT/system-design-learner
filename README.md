# System Design Learner

Single-user platform to practice system design with an Excalidraw board, AI-generated problems, solution validation, AI interviewer, and a tutor chat.

## Stack

- **Monorepo**: pnpm + Turborepo
- **Web**: React 19, Vite, Tailwind, shadcn/ui, Excalidraw, TanStack Query, Zustand
- **API**: NestJS 11, Drizzle ORM, Redis, Vercel AI SDK + OpenAI
- **Data**: PostgreSQL 16

## Prerequisites

- Node.js 22+
- pnpm 9+
- Docker & Docker Compose

## Quick start (Docker)

1. Copy env: `cp .env.example .env` and set `OPENAI_API_KEY`.
2. From repo root: `docker compose -f infra/docker-compose.yml up --build`
3. Open **http://localhost:5173** (web) — API at **http://localhost:3001**

If ports are already used locally, keep defaults `POSTGRES_PORT=5433` and `REDIS_PORT=6380` (or pick other free ports) in `.env`.

## Local dev (API + web on host, DB in Docker)

1. `docker compose up postgres redis -d` (from repo root; uses `compose.yaml`, which includes `infra/docker-compose.yml`) — or `docker compose -f infra/docker-compose.yml up postgres redis -d`.
2. `cp .env.example .env` — use `DATABASE_URL` and `REDIS_URL` pointing at localhost (`REDIS_PORT` controls host mapping). The API and Drizzle load this file from the **repo root** (not `apps/api/.env`).
3. `pnpm install`
4. `pnpm db:push` (or `pnpm db:migrate` after generate)
5. `pnpm db:seed` — load the curated problem catalogue (optional, but it gives you something to work with without spending model calls)
6. `pnpm dev`

If `db:push` reports **password authentication failed for user "sdl"**, you are usually connecting to the wrong Postgres (for example port **5432** on the host while Compose maps **5433**) or an old volume still has a different password. Fix `DATABASE_URL` to match `.env.example`, or reset the DB volume: `docker compose down -v` (destructive) then bring Postgres up again.

## Scripts

| Command | Description |
|--------|-------------|
| `pnpm dev` | Run web + API in dev mode |
| `pnpm build` | Build all packages |
| `pnpm db:generate` | Drizzle generate migrations |
| `pnpm db:push` | Push schema to DB (dev) |
| `pnpm db:migrate` | Run migrations |
| `pnpm db:seed` | Upsert the curated problem catalogue (`--dry-run` validates only) |
| `pnpm task:start` | Pick `agent-ready` issues and run them autonomously in parallel |
| `pnpm task:run <N>` | Run a single issue by number (add `--bg` to background it) |
| `pnpm task:status` | Show running task slots, branches, and last log line |
| `pnpm task:cleanup <N>` | Tear down container, worktree, branch, and locks for issue N |
| `pnpm agent:login` | One-time Cursor login inside a container (persists creds to `cursor-auth` volume) |
| `pnpm agent:status` | Verify the persisted Cursor credentials are still valid |
| `pnpm agent:logout` | Sign the persisted credentials out |

## Autonomous task runner

Fully local agent pipeline. Each task runs in its own Git worktree + isolated Docker Compose stack (Postgres + Redis per task). The headless `cursor-agent` inside the container authenticates via `CURSOR_API_KEY` — generated from your Cursor dashboard, uses the same quota as your existing subscription (no extra billing).

```bash
# One-time host setup
# 1) Generate a user API key at https://cursor.com/dashboard/integrations (under "API Keys")
# 2) Put it in .devcontainer/.env
cp .devcontainer/.env.example .devcontainer/.env
# edit .devcontainer/.env and set CURSOR_API_KEY=cursor_xxxxx
gh auth login                     # GitHub CLI auth for issues + PRs
pnpm task:labels                  # create the agent-ready / agent-in-progress / agent-blocked labels

# Trigger autonomous work
pnpm task:start                   # picks up to MAX_PARALLEL_TASKS open `agent-ready` issues
pnpm task:start 12 14 19          # run a specific list of issue numbers in parallel
pnpm task:start --max 2           # cap concurrency

# Monitor / clean up
pnpm task:status
tail -f .agent-runs/issue-12/run.log
pnpm task:cleanup 12              # only needed if a task hung
```

The runner picks each issue, creates `feat/issue-<N>` worktree, spins up a per-task `sdl-task-<N>` compose stack with private Postgres/Redis (no host port bindings), boots `cursor-agent --print --force --trust`, runs lint/typecheck/tests, and on green commits + pushes + opens a PR via `gh`. Concurrency is bounded by `MAX_PARALLEL_TASKS` (default `3`).

## Project layout

- `apps/web` — React frontend
- `apps/api` — NestJS backend
- `packages/shared` — Shared types & Zod schemas
- `packages/ai-prompts` — Prompt templates
- `infra/` — Docker Compose and Dockerfiles

## Curated problem catalogue

`POST /problems/generate` invents a problem per request, which is novel but unvetted and costs a model call. Alongside it, `apps/api/src/db/seeds/` holds hand-authored versions of the classic interview questions — Netflix, YouTube, the Twitter timeline, WhatsApp, Uber, Google Docs, Ticketmaster, Stripe, Slack, a URL shortener, a rate limiter, a RAG assistant, and a canary deployment platform — spanning `easy` to `expert` across all five tracks.

```bash
pnpm db:seed --dry-run   # validate the catalogue, write nothing
pnpm db:seed             # upsert every seed
```

Seeds carry the same payload the generator produces (`narrative_json`, `estimation_spec_json`, `interview_plan_json`), so framing scripts, stall ladders, per-problem phases, and magnitude calibration all behave identically on them.

### Rubrics are seeded too, via projection

Interviewer level changes exactly **one** thing about a rubric: which expectations are hidden rather than printed on the Problem rail (`LEVEL_HIDDEN_GUIDANCE` in `@sdl/ai-prompts` is the only place level enters rubric generation — every other budget comes from difficulty). So rather than store four near-duplicate rubrics per problem and let them drift, each seed stores **one** canonical criteria set in `problems.seeded_rubric_json`, with every criterion tagged by the level at which it goes hidden:

```ts
{ id: "edge_prepositioning", importance: "core", hiddenFrom: "standard", ... }
// guided -> visible | standard, hard, staff -> hidden
```

`projectRubricForLevel` binds it to a level at interview start, producing exactly what the generator would have — including pre-marking `visible` criteria as discovered so the rail does not ask the candidate to "find" a bullet they can already read. **A seeded problem therefore starts an interview with no model call at all**, at any of the four levels.

`interviews.criteria_json` still stores the projected, per-interview rubric — `discoveredVia` is mutated as the candidate surfaces things, so it has to be per interview. Only the *template* is shared. A seed with no `rubric` is still valid; it just falls back to generating one.

Adding a problem: drop a file in `seeds/catalog/`, export it from `seeds/index.ts`, then run `pnpm db:seed --dry-run`. Validation is stricter than the DB schema and checks **every level's projection**, not just one — a discovery floor satisfied at `staff` but violated at `guided` would otherwise ship silently and leave guided candidates nothing to discover. It also enforces the same `CRITERIA_BUDGET_BY_DIFFICULTY` the generator is held to, rejects magnitude bands narrower than 10x, and rejects derived formulas that would be silently discarded at runtime. `pnpm --filter @sdl/api test` covers the whole catalogue.

The runner matches on `title` and updates in place, so re-seeding never duplicates rows or orphans a running interview, and it only ever touches rows whose title matches a seed.

## Schema changes (Drizzle)

After pulling updates, apply DB schema changes:

```bash
pnpm db:push
```

New columns include `problems.tags_json`, `problems.track`, `problems.narrative_json`,
`problems.reference_json`, `solutions.estimation_json`, **`interviews.criteria_json`**
(per-interview rubric — see "Hidden criteria & discovery scoring" below),
`interviews.criteria_level`, `interviews.debrief_json`,
`interviews.pending_phase_proposal_json`, `interviews.reference_json`, the
`interview_phase_events` table, and `tutor_sessions.interview_id` / `topics_json`.

Existing rows get `NULL` until you run the matching backfill. All of these are **optional** —
newly generated problems and newly started interviews already include the data, and every
consumer treats `NULL` as "behave as before":

```bash
# problems generated before a column existed
curl -X POST http://localhost:3001/problems/backfill-tags
curl -X POST http://localhost:3001/problems/backfill-tracks
curl -X POST http://localhost:3001/problems/backfill-narrative
curl -X POST http://localhost:3001/problems/backfill-estimation-specs
curl -X POST http://localhost:3001/problems/backfill-interview-plans

# interviews started before per-interview rubrics existed
curl -X POST http://localhost:3001/interviews/backfill-criteria
```

`backfill-narrative` and `backfill-estimation-specs` also accept `?force=true` to refresh
problems that already have the column filled (needed when the shape gains fields).

### Model selection

Every OpenAI model id is resolved from one map (`apps/api/src/ai/ai.models.ts`) with an env
override per purpose — see the commented `AI_MODEL_*` block in `.env.example`. Problem and
rubric generation default to the stronger tier because everything downstream (interviewer
coaching, the discovery loop, validation, the debrief) is built on those two artefacts;
per-turn matchers stay on the cheap tier.

## Hidden criteria & discovery scoring

Each interview now generates a structured rubric of evaluation criteria scoped to the chosen difficulty + interviewer level. Some criteria are **visible** (overlapping the seed bullets the candidate sees on the Problem rail); others are **hidden** — latent expectations the candidate must surface by asking clarifying questions, by committing to assumptions, or by drawing them on the board.

- **Importance tiers**: `core` (significant penalty if missing), `expected` (moderate), `stretch` (bonus only).
- **Discovery**: hidden criteria flip to *discovered* when a per-turn matcher detects them in the latest exchange. Discovered hidden criteria become live constraints on the Problem rail with a back-link.
- **Scoring**: validation now returns `designScore` (how well the diagram addresses scope) and `discoveryScore` (how much hidden scope was surfaced). Overall is blended `0.7 × design + 0.3 × discovery` by default — tunable via `SCORING_DESIGN_WEIGHT` (0–1) in `.env`.
- **Reveal**: after the candidate submits at least one validation, the full rubric (including hidden bodies) is shown in the Validate panel, with covered / missed / never-asked status per criterion.

Out-of-scope dimensions return `null` instead of a fake middling 60 — the UI hides those bars rather than misleading the candidate into thinking they were graded on something irrelevant to the rubric.

## Ending an interview

Interviews now finish. **End interview** in the Validate tab (enabled once you have
validated at least once) completes the session and writes a **debrief**: strongest signal,
recommendation, what went well, where you struggled, risk areas, and an ordered study plan —
every bullet grounded in a diagram element, a quoted line, or a criterion id. It is
generated once and stored, so re-opening it never regenerates. After that the interviewer
composer closes; the board, Tutor and Export stay available, and **Replay** starts fresh.

Two things feed the debrief and are also reported on their own, but **never scored**:

- **How you worked** — clarified before designing, decisiveness, whether you surfaced your
  own design's limitations, whether you adapted when challenged, and who drove. Judged from
  the transcript only, and calibrated to the interviewer level (at Guided, being led is
  expected).
- **Tutor usage** — how often you consulted the tutor and about what. Using the tutor is
  often the right move; this exists so that when you re-read the attempt in a month you can
  tell a score reached with help apart from one reached without it.

Pacing is recorded server-side as an append-only phase-event log, so the interviewer can
offer a transition ("Ready to move to Deep dive?") when you pass ~80% of a phase's budget or
have surfaced everything that phase probes. It **never** auto-advances — you always decide.

**Export report** produces the whole thing as markdown: verdict, debrief, live scope
annotated by origin, the full rubric table with missed cores first, flags, process, an
estimation table in the units you typed, pacing, dimension notes, the reference answer and
the transcript in a collapsible block. Sections with no data are omitted entirely.
