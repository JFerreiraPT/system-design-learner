---
name: external-library-docs
description: >-
  Fetches up-to-date third-party documentation via Context7 MCP instead of relying on
  stale training data. Use when the user asks how to configure or call an external
  library (React, Vite, NestJS, Drizzle, TanStack Query, AI SDK, etc.), needs official
  examples, or version-specific API behavior.
---

# External library documentation

## When to use Context7

Use the **Context7** MCP tools when:

- Implementing or debugging an external dependency.
- The answer depends on the library’s current API (especially after recent major upgrades).
- The user says “use context7” or asks for official docs.

## Prompt pattern

Encourage specificity, for example: framework + task + version if known (e.g. “Drizzle Postgres insert returning”, “NestJS 11 validation pipe”).

## Fallback

If Context7 is unavailable or fails, say so and fall back to reading the project’s installed versions in `package.json` and inferring from source in the repo.
