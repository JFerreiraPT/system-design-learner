import assert from "node:assert/strict";
import test from "node:test";
import { buildAttemptMarkdownReport, reportFilename, type ExportInput } from "./exportReport.js";
import type { Problem, ValidationRecord } from "./api";

const NOW = new Date("2026-08-26T10:00:00.000Z");

const problem: Problem = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Multi-tenant Audit Log!",
  statement: "Design an append-only audit log for a multi-tenant SaaS.",
  difficulty: "medium",
  constraintsJson: ["Up to 500 tenants", "Entries are never edited"],
  evaluationRubricJson: [],
  createdAt: "2026-08-20T10:00:00.000Z"
};

/** The floor: a board validated with no interview, no rubric, no numbers. */
const minimal: ExportInput = {
  problem,
  now: NOW,
  validations: [
    {
      id: "sol-1",
      problemId: problem.id,
      sceneJson: "{}",
      score: 41,
      feedbackJson: { score: 41, strengths: ["Drew a clear write path."] },
      createdAt: "2026-08-26T09:30:00.000Z"
    }
  ]
};

const fullValidation: ValidationRecord = {
  id: "sol-2",
  problemId: problem.id,
  sceneJson: "{}",
  score: 68,
  createdAt: "2026-08-26T09:45:00.000Z",
  feedbackJson: {
    score: 68,
    designScore: 64,
    discoveryScore: 77,
    scoringMode: "rubric",
    scoreBand: { band: 3, label: "Clear design with justified decisions." },
    dimensions: { requirements: 80, security: 40, scalability: null },
    dimensionNotes: { security: "Tenant scoping is implied but never drawn." },
    criteriaEvaluations: [
      {
        criterionId: "tenant_isolation",
        covered: false,
        discovered: false,
        severity: "high",
        evidence: "No tenant_id on the reads path."
      },
      { criterionId: "append_only", covered: true, discovered: true }
    ],
    coreMissed: ["tenant_isolation"],
    flagObservations: [
      {
        areaId: "isolation",
        kind: "green",
        index: 0,
        text: "Clarified tenancy before designing.",
        fired: true,
        evidence: '"do tenants share entries?"'
      },
      {
        areaId: "isolation",
        kind: "red",
        index: 0,
        text: "Trusts a client-supplied tenant id.",
        fired: false
      }
    ],
    processAssessment: {
      clarifiedBeforeDesigning: "yes",
      decisiveness: "decides_and_justifies",
      surfacedOwnLimitations: false,
      adaptedWhenChallenged: "not_tested",
      drove: "candidate_led",
      observations: [
        { signal: "Asked about tenancy first.", evidence: '"do tenants share entries?"' }
      ]
    },
    strengths: ["Committed to an append-only store early."],
    gaps: ["(tenant_isolation) No tenant scoping on reads."],
    nextSteps: ["Draw the per-tenant read path."]
  }
};

const full: ExportInput = {
  problem: { ...problem, track: "backend" },
  now: NOW,
  validations: [fullValidation],
  interview: {
    interviewerLevel: "standard",
    startedAt: "2026-08-26T09:00:00.000Z",
    endedAt: "2026-08-26T09:42:00.000Z",
    status: "completed"
  },
  liveConstraints: [
    {
      id: "c1",
      text: "Up to 500 tenants",
      origin: "seed",
      status: "active"
    },
    {
      id: "c2",
      text: "Retention is 7 years",
      origin: "interviewer",
      status: "active"
    },
    {
      id: "c3",
      text: "Offline export is out of scope",
      origin: "candidate",
      status: "removed"
    }
  ],
  debrief: {
    strongestSignal: "You clarified tenancy before drawing anything.",
    recommendation: "yes",
    whatWentWell: ["Locked the append-only decision early."],
    whereTheyStruggled: ["Never scoped reads by tenant."],
    riskAreas: ["Retention cost at 7 years was never estimated."],
    studyPlan: [
      {
        topic: "Tenant isolation",
        why: "You missed the core criterion on the read path.",
        suggestedNextProblem: "a per-tenant reporting API"
      }
    ],
    generatedAt: "2026-08-26T09:42:10.000Z"
  },
  criteria: [
    {
      id: "tenant_isolation",
      text: "Reads are scoped to the caller's tenant.",
      dimension: "security",
      importance: "core",
      visibility: "hidden"
    },
    {
      id: "append_only",
      text: "Audit entries | are append-only.",
      dimension: "consistency",
      importance: "expected",
      visibility: "visible",
      discoveredVia: { kind: "seed", at: "2026-08-26T09:00:00.000Z" }
    }
  ],
  estimationSpec: {
    fields: [
      {
        key: "entry_bytes",
        label: "Avg entry size",
        type: "number",
        unitKind: "bytes",
        displayUnit: "KB",
        displayMultiplier: 1024,
        expectedMagnitude: { min: 512, max: 8192, rationale: "~1KB is typical for a log line." }
      },
      { key: "tenants", label: "Tenants", type: "number", unitKind: "count" },
      { key: "notes", label: "Notes", type: "text" }
    ]
  },
  // Persisted in BASE units: 2048 bytes is what the candidate typed as "2 KB".
  estimation: { entry_bytes: 2048, tenants: 500 },
  phaseTimeline: {
    phases: [
      { phaseId: "clarify", label: "Clarify", budgetSec: 300, actualSec: 1320, overBudget: true },
      { phaseId: "deep_dive", label: "Deep dive", budgetSec: 600, actualSec: 180, overBudget: false }
    ],
    totalSec: 1500,
    completed: true
  },
  reference: {
    summary: "A partitioned append-only log with per-tenant read scoping.",
    components: [{ name: "Ingest API", role: "write path", tradeoffs: "batching vs latency" }],
    dataFlow: "Writers append; readers query by tenant and time range.",
    keyTradeoffs: ["Retention cost vs query speed"],
    deepDives: ["Partitioning by tenant vs by time"]
  },
  transcript: [
    {
      id: "m1",
      role: "assistant",
      content: "Welcome.",
      createdAt: "2026-08-26T09:00:00.000Z"
    },
    {
      id: "m2",
      role: "user",
      content: "Do tenants share entries?",
      createdAt: "2026-08-26T09:01:00.000Z"
    },
    {
      id: "m3",
      role: "system",
      content: "internal",
      createdAt: "2026-08-26T09:01:30.000Z"
    }
  ],
  tutorUsage: {
    sessions: 1,
    candidateTurns: 3,
    firstUsedAtPhase: "Deep dive",
    topics: ["partitioning"]
  },
  imageBase64: "AAAA"
};

const OPTIONAL_HEADINGS = [
  "## Debrief",
  "## Rubric outcome",
  "## Observed signals",
  "## How you worked",
  "## Estimation",
  "## Pacing",
  "## Dimensions",
  "## Tutor usage",
  "## Reference solution",
  "## Transcript",
  "## Whiteboard"
];

test("the filename carries the problem slug and the date", () => {
  assert.equal(
    reportFilename("Multi-tenant Audit Log!", NOW),
    "sdl-multi-tenant-audit-log-2026-08-26.md"
  );
  assert.equal(reportFilename("!!!", NOW), "sdl-attempt-2026-08-26.md");
});

test("a bare validation produces a valid document with no empty headings", () => {
  const md = buildAttemptMarkdownReport(minimal);

  assert.match(md, /^# Multi-tenant Audit Log!/);
  assert.match(md, /\*\*Overall score:\*\* 41\/100/);
  // Seed constraints are the correct fallback when there is no live scope.
  assert.match(md, /### Constraints/);
  assert.match(md, /- Up to 500 tenants/);
  assert.match(md, /### Strengths/);

  for (const heading of OPTIONAL_HEADINGS) {
    assert.equal(md.includes(heading), false, `${heading} should be absent`);
  }
  // No placeholder rows either.
  assert.doesNotMatch(md, /_—_/);
});

test("the full report contains every section", () => {
  const md = buildAttemptMarkdownReport(full);
  for (const heading of OPTIONAL_HEADINGS) {
    assert.ok(md.includes(heading), `${heading} should be present`);
  }
  assert.match(md, /\*\*Track:\*\* Backend/);
  assert.match(md, /\*\*Interviewer level:\*\* standard/);
  assert.match(md, /\*\*Interview duration:\*\* 42m/);
  assert.match(md, /\*\*Band 3 of 4 — Meets bar\*\*/);
});

test("live scope replaces the seed bullets and is annotated by origin and status", () => {
  const md = buildAttemptMarkdownReport(full);

  assert.match(md, /### Scope as it evolved/);
  assert.match(md, /- Retention is 7 years — _interviewer_/);
  assert.match(md, /- Offline export is out of scope — _candidate_ _\(scoped out\)_/);
  // The seed-only heading must not also appear — the candidate was graded
  // against live scope, so exporting the seed list would be the wrong problem.
  assert.equal(md.includes("### Constraints"), false);
});

test("the rubric table puts missed cores first and escapes pipes", () => {
  const md = buildAttemptMarkdownReport(full);

  assert.match(md, /- Core criteria missed: 1 \/ 1/);
  assert.match(md, /- Hidden expectations surfaced: 0 \/ 1/);
  const missedIndex = md.indexOf("Reads are scoped to the caller's tenant.");
  const coveredIndex = md.indexOf("Audit entries");
  assert.ok(missedIndex > -1 && coveredIndex > missedIndex, "missed cores must come first");
  assert.match(md, /Audit entries \\\| are append-only\./);
  assert.match(md, /never asked/);
  assert.match(md, /No tenant_id on the reads path\./);
});

test("only fired flags are exported", () => {
  const md = buildAttemptMarkdownReport(full);
  assert.match(md, /Clarified tenancy before designing\./);
  assert.equal(md.includes("Trusts a client-supplied tenant id."), false);
});

test("estimation is a table in display units with calibration verdicts", () => {
  const md = buildAttemptMarkdownReport(full);

  assert.match(md, /\| Field \| Your value \| Calibration \| Note \|/);
  // 2048 bytes persisted -> "2 KB" as typed, not a raw base-unit dump.
  assert.match(md, /\| Avg entry size \| 2 KB \| in range \|/);
  assert.match(md, /\| Tenants \| 500 \| — \|/);
  // A text field left blank never becomes a row.
  assert.equal(md.includes("| Notes |"), false);
  assert.doesNotMatch(md, /```json/);
});

test("an out-of-range estimate reports the verdict and its rationale", () => {
  const md = buildAttemptMarkdownReport({
    ...full,
    estimation: { entry_bytes: 5_000_000 }
  });
  assert.match(md, /way off/);
  assert.match(md, /~1KB is typical for a log line\./);
});

test("pacing shows budget vs actual and marks the over-budget phase", () => {
  const md = buildAttemptMarkdownReport(full);
  assert.match(md, /\| Clarify \| 5m \| 22m ⚠︎ \|/);
  assert.match(md, /\| Deep dive \| 10m \| 3m \|/);
  assert.match(md, /Total: 25m\./);
});

test("dimension notes travel with their scores, and null dimensions are hidden", () => {
  const md = buildAttemptMarkdownReport(full);
  assert.match(md, /\*\*Security:\*\* 40 — Tenant scoping is implied but never drawn\./);
  assert.match(md, /\*\*Requirements:\*\* 80/);
  assert.equal(md.includes("Scalability:"), false);
});

test("the transcript is collapsed and drops system messages", () => {
  const md = buildAttemptMarkdownReport(full);

  assert.match(md, /<details>/);
  assert.match(md, /<summary>2 messages<\/summary>/);
  assert.match(md, /\*\*You:\*\*\n\nDo tenants share entries\?/);
  assert.equal(md.includes("internal"), false);
  assert.match(md, /<\/details>/);
});

test("tutor usage is reported as a fact, not a deduction", () => {
  const md = buildAttemptMarkdownReport(full);
  assert.match(md, /Consulted 3 times across 1 session\./);
  assert.match(md, /not as a deduction/);
  assert.equal(
    buildAttemptMarkdownReport({
      ...full,
      tutorUsage: { sessions: 1, candidateTurns: 0, firstUsedAtPhase: null, topics: [] }
    }).includes("## Tutor usage"),
    false
  );
});

test("a validation with no feedback at all still yields a document", () => {
  const md = buildAttemptMarkdownReport({
    problem,
    now: NOW,
    validations: [
      {
        id: "sol-0",
        problemId: problem.id,
        sceneJson: "{}",
        score: null,
        feedbackJson: null,
        createdAt: "2026-08-26T09:00:00.000Z"
      }
    ]
  });

  assert.match(md, /^# Multi-tenant Audit Log!/);
  assert.match(md, /## Problem/);
  assert.equal(md.includes("## Verdict"), false);
  assert.equal(md.includes("## Dimensions"), false);
});
