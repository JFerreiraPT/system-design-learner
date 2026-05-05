---
name: postgres-drizzle-sdl
description: >-
  PostgreSQL schema, migrations, and Drizzle workflows for this repo. Use when editing
  apps/api/src/db/schema.ts, SQL migrations under apps/api/drizzle, drizzle.config.ts, or
  queries that affect columns, indexes, JSONB, or migrations.
paths:
  - "apps/api/src/db/**"
  - "apps/api/drizzle/**"
  - "apps/api/drizzle.config.ts"
---

# PostgreSQL + Drizzle

## Files

- Schema: `apps/api/src/db/schema.ts`
- Drizzle config: `apps/api/drizzle.config.ts`
- Migrations: `apps/api/drizzle/*.sql` + `drizzle/meta/`

## Workflow

1. Change schema in `schema.ts`.
2. From repo root: `pnpm db:generate` (new migration files) when the team expects versioned migrations.
3. Local dev shortcut: `pnpm db:push` syncs schema without a migration file (use only when that matches team practice).
4. Apply migrations: `pnpm db:migrate`.

## Safety

- Prefer reversible, reviewable SQL migrations for production-bound changes.
- When adding JSONB or nullable columns, consider backfills and API compatibility (see README notes on `backfill` endpoints where applicable).
- Keep types and Zod/shared contracts in sync when columns change.

## Postgres

Runtime DB is PostgreSQL 16 (Docker). Connection string: `DATABASE_URL` in `.env`.

## Reference

Use Context7 MCP for Drizzle 0.39 / `drizzle-kit` CLI details when unsure.
