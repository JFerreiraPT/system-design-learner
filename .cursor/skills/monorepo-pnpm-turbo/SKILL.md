---
name: monorepo-pnpm-turbo
description: >-
  Works with the system-design-learner monorepo using pnpm workspaces and Turborepo.
  Use when adding packages, wiring workspace dependencies, running root scripts, Docker
  dev flows, or changing turbo tasks.
---

# Monorepo (pnpm + Turborepo)

## Layout

- `apps/web` — `@sdl/web` (Vite + React)
- `apps/api` — `@sdl/api` (NestJS)
- `packages/shared` — `@sdl/shared`
- `packages/ai-prompts` — `@sdl/ai-prompts`
- `infra/` — Docker Compose

## Commands (repo root)

- Install: `pnpm install`
- Dev (web + API): `pnpm dev` → `turbo dev`
- Build all: `pnpm build`
- DB (API package): `pnpm db:push` \| `pnpm db:migrate` \| `pnpm db:generate`

## Workspace deps

Internal packages use `workspace:*` in `package.json`. After adding exports in `packages/*`, run `pnpm install` at root.

## Filtered runs

Target one app/package: `pnpm --filter @sdl/web <script>` or `pnpm --filter @sdl/api <script>`.

## Env & infra

- Copy `.env.example` → `.env`; API keys and `DATABASE_URL` / `REDIS_URL` live there.
- Postgres/Redis: `docker compose -f infra/docker-compose.yml up ...` (see root `README.md`).

## Docs for stack versions

Prefer Context7 MCP or project README over guessing versions (React 19, NestJS 11, Drizzle 0.39, pnpm 9, Node 22+).
