# System Design Learner

<!-- agent-runner smoke task F -->

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
5. `pnpm dev`

If `db:push` reports **password authentication failed for user "sdl"**, you are usually connecting to the wrong Postgres (for example port **5432** on the host while Compose maps **5433**) or an old volume still has a different password. Fix `DATABASE_URL` to match `.env.example`, or reset the DB volume: `docker compose down -v` (destructive) then bring Postgres up again.

## Scripts

| Command | Description |
|--------|-------------|
| `pnpm dev` | Run web + API in dev mode |
| `pnpm build` | Build all packages |
| `pnpm db:generate` | Drizzle generate migrations |
| `pnpm db:push` | Push schema to DB (dev) |
| `pnpm db:migrate` | Run migrations |

## Project layout

- `apps/web` — React frontend
- `apps/api` — NestJS backend
- `packages/shared` — Shared types & Zod schemas
- `packages/ai-prompts` — Prompt templates
- `infra/` — Docker Compose and Dockerfiles

## Schema changes (Drizzle)

After pulling updates, apply DB schema changes:

```bash
pnpm db:push
```

New columns include `problems.tags_json`, `problems.reference_json`, `solutions.estimation_json`, and **`interviews.criteria_json`** (per-interview rubric — see "Hidden criteria & discovery scoring" below). Existing rows get `NULL` until you run the matching backfill:

```bash
curl -X POST http://localhost:3001/problems/backfill-tags
curl -X POST http://localhost:3001/interviews/backfill-criteria
```

Both are optional — new problems and new interviews already include the data from generation.

## Hidden criteria & discovery scoring

Each interview now generates a structured rubric of evaluation criteria scoped to the chosen difficulty + interviewer level. Some criteria are **visible** (overlapping the seed bullets the candidate sees on the Problem rail); others are **hidden** — latent expectations the candidate must surface by asking clarifying questions, by committing to assumptions, or by drawing them on the board.

- **Importance tiers**: `core` (significant penalty if missing), `expected` (moderate), `stretch` (bonus only).
- **Discovery**: hidden criteria flip to *discovered* when a per-turn matcher detects them in the latest exchange. Discovered hidden criteria become live constraints on the Problem rail with a back-link.
- **Scoring**: validation now returns `designScore` (how well the diagram addresses scope) and `discoveryScore` (how much hidden scope was surfaced). Overall is blended `0.7 × design + 0.3 × discovery` by default — tunable via `SCORING_DESIGN_WEIGHT` (0–1) in `.env`.
- **Reveal**: after the candidate submits at least one validation, the full rubric (including hidden bodies) is shown in the Validate panel, with covered / missed / never-asked status per criterion.

Out-of-scope dimensions return `null` instead of a fake middling 60 — the UI hides those bars rather than misleading the candidate into thinking they were graded on something irrelevant to the rubric.
