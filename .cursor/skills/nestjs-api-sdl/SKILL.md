---
name: nestjs-api-sdl
description: >-
  Backend work on @sdl/api — NestJS 11, Drizzle + pg, Redis (ioredis), Vercel AI SDK,
  Zod, workspace packages @sdl/shared and @sdl/ai-prompts. Use when editing apps/api,
  HTTP modules, services, or AI-backed endpoints.
paths:
  - "apps/api/**"
---

# NestJS API (`apps/api`)

## Stack

- NestJS 11 (`@nestjs/*`, Express adapter)
- DB: Drizzle ORM + `pg` → PostgreSQL 16
- Cache/session: Redis via `ioredis`
- AI: `ai` + `@ai-sdk/openai`
- Config: `@nestjs/config` (env from root `.env`)

## Patterns

- Follow existing module/service layout under `src/` (feature folders).
- Keep DTO validation and shared shapes aligned with `@sdl/shared` / Zod where the codebase already does.
- Database access goes through Drizzle; avoid raw SQL unless the repo already uses it for a specific case.

## Scripts

From repo root: `pnpm db:generate`, `pnpm db:push`, `pnpm db:migrate` (delegate to this package).

## Docs

For NestJS decorators, Drizzle query API, or AI SDK usage, prefer Context7 MCP for version-accurate snippets.
