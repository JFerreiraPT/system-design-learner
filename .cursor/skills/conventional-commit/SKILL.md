---
name: conventional-commit
description: >-
  Generate and apply a conventional commit message from the current diff, scoped
  to changed packages, with optional issue reference footer.
---

# Conventional commit helper

Use this skill after implementation and validation pass.

## Inputs

- Current branch has staged/unstaged changes ready to commit.
- Optional issue number (for `Refs: #<n>` footer).

## Message format

- Subject: `type(scope): short reason`
- Body: 1-3 bullets focused on impact/why.
- Footer: `Refs: #<issue>` when provided.

Types to use:

- `feat` for user-facing behavior or API additions.
- `fix` for bug fixes/regressions.
- `refactor` for internal restructuring without behavior change.
- `test` for test-only changes.
- `chore` for tooling/scripts/docs updates.

## Steps

1. Inspect changed files via `git status --porcelain` and `git diff --name-only`.
2. Infer scope from top-level area:
   - `apps/api` -> `api`
   - `apps/web` -> `web`
   - `packages/*` -> package name
   - `infra|scripts|.devcontainer|.cursor` -> `tooling`
3. Draft a concise commit subject in imperative mood.
4. Add body bullets summarizing outcomes and constraints.
5. Stage all intended files, then commit using a heredoc:

```bash
git add <files...>
git commit -m "$(cat <<'EOF'
feat(tooling): add local task runner automation

- add per-task worktree + devcontainer orchestration for issue execution
- add validation and status utilities for concurrent runs

Refs: #123
EOF
)"
```

6. If hooks fail, fix and create a new commit (do not amend unless explicitly requested).
