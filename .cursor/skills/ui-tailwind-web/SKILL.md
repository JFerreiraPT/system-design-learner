---
name: ui-tailwind-web
description: >-
  UI and styling for the web app — Tailwind CSS 3, layout, typography, accessibility, and
  consistent visual polish. Use when changing components in apps/web, className usage,
  responsive layout, or focus/contrast.
paths:
  - "apps/web/**/*.tsx"
  - "apps/web/**/*.css"
---

# UI & design (Tailwind)

## Stack

- Tailwind CSS 3 (`tailwind.config` / `postcss` under `apps/web`)
- Match existing spacing, type scale, and color usage in components before introducing new tokens.

## Practices

- Prefer composition over ad-hoc pixel values; reuse spacing and radius patterns already in the app.
- Ensure interactive elements have visible focus states and sufficient contrast.
- Keep responsive behavior explicit (`sm:`, `md:`) when layouts differ by breakpoint.
- Avoid large inline style blocks unless the file already relies on them (e.g. third-party embeds).

## shadcn-style note

The product README references shadcn-style UI patterns; if Radix-based primitives appear later, extend them consistently rather than mixing unrelated component libraries.
