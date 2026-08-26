# 16 · Export the full debrief, not half of it

**Area:** Evaluation · **Priority:** P2 · **Size:** M · **Depends on:** 02, 03, 07, 15
**Labels:** `agent-ready`, `evaluation`, `web`

> **Status: DONE.** `exportReport.ts` is now fifteen section formatters returning `string | null`, covered by `exportReport.test.ts` (minimal and full fixtures). Live constraints replace the seed list and are annotated by origin/status; the rubric table reuses `criterionRowToMarkdown` so screen and export cannot drift; estimation renders in display units with calibration verdicts; `dimensionNotes` are included; the transcript sits in a `<details>` block. Filename is `sdl-<slug>-<yyyy-mm-dd>.md`.
> Verified with `pnpm -w turbo run typecheck` and `pnpm -w turbo run test`.

## Problem

`buildAttemptMarkdownReport` (`apps/web/src/lib/exportReport.ts:44-118`) emits:
title, difficulty, statement, **seed** constraints, estimation JSON blob,
overall score, design/discovery subscores, dimension bars, strengths, gaps, next
steps, board PNG.

Everything the Validate panel shows on screen that actually explains the score is
missing from the file the user keeps:

| On screen | In the export |
|---|---|
| Rubric reveal — covered / missed / never-asked (`CriteriaReveal.tsx`) | ✗ |
| Discovery counts — "3 / 7 hidden surfaced" (`CriteriaReveal.tsx:66-77`) | ✗ |
| Live constraints as they evolved (`WorkspaceProblemRail`) | ✗ — exports **seed** constraints (`exportReport.ts:77`) |
| The interview transcript | ✗ |
| Reference solution (`markdownFromReference`, `workspaceValidationUi.ts:112-120`) | ✗ |
| Score band (task 02) | ✗ |
| Flags (task 03) | ✗ |
| Process assessment (task 15) | ✗ |
| Debrief narrative (task 07) | ✗ |

Exporting the **seed** constraints rather than the live set is a correctness bug
on its own: the candidate was graded against live scope
(`apps/api/src/solutions/solutions.service.ts:169-173`), so the exported report
documents the wrong problem.

The estimation section dumps raw JSON (`exportReport.ts:58-64`) — unreadable, and
after task 04 the values are in base units, so a `payload_bytes: 1024` line will
not even match what the user typed.

## Desired behaviour

Restructure the export into a kit-shaped debrief document. Section order:

1. **Header** — title, difficulty, track (task 14), interviewer level, date,
   interview duration.
2. **Verdict** — score band + generated band description (task 02), overall score,
   design / discovery subscores, `scoringMode` (task 01).
3. **Debrief narrative** (task 07) — strongest signal, recommendation, what went
   well, where they struggled, risk areas, study plan.
4. **Problem** — statement, then **live** constraints annotated by origin
   (`seed` / `interviewer` / `candidate`) and status, so scope evolution is legible.
5. **Rubric outcome** — the full `CriteriaReveal` table as markdown: criterion,
   importance, dimension, visibility, discovered, covered, evidence. Missed cores
   first, matching `compareCriterionRows` (`workspaceValidationUi.ts:90-110`).
6. **Flags** (task 03) — fired greens, fired reds, with evidence.
7. **Process assessment** (task 15).
8. **Estimation** — a **table** (field label, entered value with display unit,
   calibration verdict from task 05), not a JSON blob.
9. **Phase timeline** (task 08) — budget vs actual per phase.
10. **Dimensions** — existing bars, plus `dimensionNotes`, which are rendered on
    screen (`DimensionBreakdown.tsx:22-45`) but dropped from the export today.
11. **Reference solution** — reuse `markdownFromReference`.
12. **Transcript** — full interviewer/candidate exchange in a collapsible
    `<details>` block so it does not dominate the document.
13. **Whiteboard** — existing embedded PNG.

**Every section must degrade gracefully.** Validating without an interview, on a
legacy problem, means most sections are absent — the export must omit them
entirely rather than printing empty headings.

Refactor `exportReport.ts` into one small formatter per section, each taking its
input and returning `string | null`, with the builder filtering nulls. The current
single template literal will not survive thirteen conditional sections.

Filename: `sdl-<problem-slug>-<yyyy-mm-dd>.md` instead of the current generic name.

## Files to touch

- `apps/web/src/lib/exportReport.ts` — restructure into section formatters.
- `apps/web/src/pages/WorkspacePage.tsx` — `exportMarkdown` gathers the extra inputs (transcript, live constraints, reveal, timeline, debrief).
- `apps/web/src/lib/workspaceValidationUi.ts` — extract a shared criterion-row → markdown formatter so screen and export cannot drift.
- `apps/web/src/lib/exportReport.test.ts` — **new**.

## Acceptance criteria

- [ ] The export uses **live** constraints when an interview exists, annotated by origin and status, and falls back to seed constraints only when there is no interview.
- [ ] The rubric outcome table is present with covered / discovered / evidence per criterion, ordered missed-cores-first.
- [ ] Estimation renders as a readable table with display units and calibration verdicts — no raw JSON blob.
- [ ] `dimensionNotes` appear alongside the dimension scores.
- [ ] The transcript is embedded inside a collapsible `<details>` block.
- [ ] Every optional section is omitted entirely when its data is absent — a validation with no interview produces a valid document with no empty headings; assert this with a fixture.
- [ ] Each section is produced by its own formatter returning `string | null`.
- [ ] The filename includes the problem slug and the date.
- [ ] Tests cover the minimal case (no interview, no criteria, no estimation) and the full case, asserting section presence/absence.
- [ ] `pnpm -w lint` and `pnpm -w turbo run typecheck` pass.

## Out of scope

- PDF or HTML export.
- Server-side report generation.
- Emailing or uploading the report anywhere.

## Sequencing note

This task consumes the output of 02, 03, 07 and 15. It can be implemented before
they all land — gate each section on its data being present, which is required
behaviour anyway. If a dependency has not landed, that section simply never
renders and its acceptance criterion is satisfied vacuously; note which in the PR.
