---
name: validate-done
description: >-
  Evaluate completion confidence using a hybrid gate:
  deterministic checks plus an LLM assessment against issue acceptance criteria.
---

# Validate done (95% confidence)

Use this skill before commit/PR.

## Pass criteria

- Total score >= 95
- Deterministic subtotal >= 70
- LLM subtotal >= 25

## Scoring model

### Deterministic (70 points total)

- 20: lint passes (`pnpm -w lint`)
- 20: typecheck passes (`pnpm -w turbo run typecheck` or fallback `tsc --noEmit`)
- 30: tests pass for impacted workspaces (`pnpm --filter <workspace> test`, fallback `pnpm -w turbo run test`)

### LLM assessment (30 points total)

Requires `OPENAI_API_KEY`.

- 15: diff satisfies issue acceptance criteria.
- 15: diff scope remains focused to requested task.

If LLM grading cannot run, score LLM as 0 and fail gate.

## Output

Write `report.json` with this shape:

```json
{
  "deterministic": { "lint": 20, "typecheck": 20, "tests": 30, "subtotal": 70 },
  "llm": { "criteriaFit": 15, "scopeDiscipline": 15, "subtotal": 30 },
  "total": 100,
  "pass": true,
  "notes": []
}
```

If failing, include actionable remediation bullets in `notes`.
