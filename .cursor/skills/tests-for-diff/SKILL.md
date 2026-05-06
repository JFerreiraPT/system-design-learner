---
name: tests-for-diff
description: >-
  Add or update only the tests required by the current implementation diff,
  scoped to changed packages and behavior.
---

# Tests for changed code only

Use this skill immediately after implementation.

## Goal

Create focused tests for newly introduced or changed behavior without broad unrelated test churn.

## Workflow

1. Read changed files (`git diff --name-only`).
2. Ignore pure config/docs changes.
3. For code changes:
   - If `apps/web` or `packages/*`: prefer Vitest patterns already present in that workspace.
   - If `apps/api`: prefer Jest/Vitest style already used by that package scripts.
4. Add or update the nearest relevant `*.spec.ts` / `*.test.ts` file.
5. Ensure each new behavior path has at least one positive and one edge/failure assertion when applicable.
6. Run only impacted tests first, then package-level test command.

## Guardrails

- Do not rewrite unrelated tests.
- Do not add snapshot tests unless the project already relies on them for that module.
- Keep fixtures local to the test file unless reused.
- If behavior cannot be tested meaningfully, document the exact blocker in the PR body.
