---
name: architecture-principles
description: >-
  Applies system and software architecture best practices for this monorepo (React web,
  NestJS API, PostgreSQL, shared packages). Use when designing or refactoring features,
  drawing boundaries between apps and packages, defining APIs or data ownership, choosing
  where logic lives, or reviewing structure for maintainability and safety.
---

# Architecture principles

## Non‑negotiables

1. **Clear ownership** — Every capability has one owning module or package. Avoid duplicate sources of truth (two places that “are the API” for the same concept).
2. **Dependency direction** — `packages/*` must not depend on `apps/*`. Shared code flows **out** from `packages/shared` and `packages/ai-prompts`; apps depend on packages, not the reverse.
3. **Stable contracts at boundaries** — HTTP shapes, events, and DB views that cross team/runtime boundaries should use explicit types (e.g. `@sdl/shared`, Zod) and stay backward compatible unless versioned intentionally.
4. **No database in the browser** — All persistence and secrets stay in `@sdl/api`. The web app talks only to HTTP (or other first-class client APIs), never to Postgres/Redis URLs.
5. **Data and migrations** — Schema changes go through Drizzle + reviewed migrations (or an agreed dev `push` workflow). Prefer additive changes; plan backfills and nullability when altering columns in use.

## API and domain layer

- **Thin controllers, rich domain** — Validate and map at the edge; keep business rules in services/modules that are testable without HTTP.
- **Idempotency and errors** — Mutations that retry should be safe or explicitly idempotent; return consistent error shapes and log actionable context server-side.
- **AI and external IO** — Isolate provider calls (tokens, prompts, models) behind narrow interfaces so swapping or testing does not sprawl across controllers.

## Frontend

- **Feature coherence** — Colocate UI, hooks, and small helpers that change together; extract shared UI only when a second consumer exists.
- **State** — Prefer server state via TanStack Query, local UI state explicitly. Avoid duplicating server truth in global stores.
- **Performance by default** — Lazy-load heavy routes/embeds; avoid unnecessary re-renders; keep bundle boundaries sensible for Vite code-splitting.

## Cross-cutting

- **Security** — Assume untrusted input at every HTTP boundary; validate; authorize by resource; never leak secrets or stack traces to clients.
- **Observability** — Meaningful logs on failures; propagate correlation where the stack already supports it; failures should be diagnosable without “run it locally and guess.”
- **Operational simplicity** — Prefer fewer moving parts for the same capability; complexity needs a payoff (scale, safety, or velocity).

## Before shipping structural work

Copy and answer briefly:

```text
- [ ] Who owns this capability, and where does it live?
- [ ] What depends on what (direction of imports / calls)?
- [ ] What is the public contract (API + types), and what breaks clients if it changes?
- [ ] How is data migrated and rolled out (including partial deploys)?
- [ ] What fails if Redis, OpenAI, or Postgres is slow or down?
```

If a shortcut violates the non‑negotiables, call it out and propose the smallest compliant alternative.
