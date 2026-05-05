---
name: react-vite-web
description: >-
  Frontend patterns for @sdl/web — React 19, Vite, TanStack Query, Zustand, React Router,
  Axios, Excalidraw. Use when editing apps/web, API calls from the client, routing, or
  client state.
paths:
  - "apps/web/**"
---

# React web app (`apps/web`)

## Stack

- React 19, Vite 5, TypeScript
- Data fetching: TanStack Query + Axios
- State: Zustand
- Routing: React Router 7
- Board: `@excalidraw/excalidraw`
- Markdown: `react-markdown` + `remark-gfm`
- Shared types/schemas: import from `@sdl/shared`

## Conventions

- Keep feature boundaries clear; prefer colocating hooks and small components near routes or features.
- Use existing patterns for API base URL and error handling before introducing new HTTP layers.
- After dependency or Vite config changes, verify `pnpm --filter @sdl/web build`.

## Monorepo

Run from root: `pnpm dev` or `pnpm --filter @sdl/web dev`. Do not add a second package manager in `apps/web`.

## Current library APIs

For React, Vite, TanStack Query, or Router APIs, use Context7 MCP so examples match installed majors.
