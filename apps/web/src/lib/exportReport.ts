import {
  calibrateAll,
  DEBRIEF_RECOMMENDATION_LABELS,
  fromBaseUnit,
  PROCESS_READINGS,
  SCORE_BAND_NAMES,
  SURFACED_OWN_LIMITATIONS_READING,
  TRACK_LABELS,
  getTrack,
  type EstimationFieldSpec,
  type EstimationProblemSpec,
  type FieldCalibration,
  type InterviewDebrief,
  type PhaseTimeline,
  type ProcessAssessment,
  type TutorUsage
} from "@sdl/shared";
import type {
  ChatMessage,
  LiveConstraint,
  Problem,
  ReferenceSolution,
  RubricCriterion,
  ValidationFeedback,
  ValidationRecord,
  WorkspaceEstimation
} from "./api";
import {
  CRITERION_TABLE_HEADER,
  compareCriterionRows,
  criterionRowToMarkdown,
  DIM_KEYS,
  DIM_LABELS,
  joinCriteriaWithEvaluations,
  markdownFromReference
} from "./workspaceValidationUi";

/**
 * Everything the exported debrief can draw on.
 *
 * Almost all of it is optional, and that is the point: an attempt can
 * legitimately have no interview, no rubric, no estimation and no timer.
 * Every section formatter returns `string | null` and the builder drops the
 * nulls, so a bare board validation produces a valid document with no empty
 * headings rather than a skeleton of "—" placeholders.
 */
export type ExportInput = {
  problem: Problem;
  validations: ValidationRecord[];
  /** Live constraint set. When present it REPLACES the seed bullets: the
   * candidate was graded against live scope, so exporting the seed list would
   * document the wrong problem. */
  liveConstraints?: LiveConstraint[] | null;
  interview?: {
    interviewerLevel?: string;
    startedAt?: string | null;
    endedAt?: string | null;
    status?: string;
  } | null;
  debrief?: InterviewDebrief | null;
  criteria?: RubricCriterion[] | null;
  estimationSpec?: EstimationProblemSpec | null;
  /** Values in BASE units, as persisted. Converted for display here. */
  estimation?: WorkspaceEstimation | null;
  phaseTimeline?: PhaseTimeline | null;
  reference?: ReferenceSolution | null;
  transcript?: ChatMessage[] | null;
  tutorUsage?: TutorUsage | null;
  imageBase64?: string;
  /** Injected so the output is deterministic in tests. */
  now?: Date;
};

type Section = (input: ExportInput, feedback: ValidationFeedback | null) => string | null;

/** Filename for a report: `sdl-<problem-slug>-<yyyy-mm-dd>.md`. */
export function reportFilename(problemTitle: string, now: Date = new Date()): string {
  const slug =
    problemTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "attempt";
  return `sdl-${slug}-${isoDate(now)}.md`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function formatMinutes(seconds: number): string {
  return `${Math.round(seconds / 60)}m`;
}

// ---------------------------------------------------------------------------
// 1. Header
// ---------------------------------------------------------------------------

const headerSection: Section = (input) => {
  const { problem, interview } = input;
  const now = input.now ?? new Date();
  const track = getTrack(problem.track);

  const lines = [
    `# ${problem.title}`,
    "",
    `**Difficulty:** ${problem.difficulty}`,
    ...(track ? [`**Track:** ${TRACK_LABELS[track]}`] : []),
    ...(interview?.interviewerLevel
      ? [`**Interviewer level:** ${interview.interviewerLevel}`]
      : []),
    `**Exported:** ${isoDate(now)}`
  ];

  const duration = interviewDuration(interview);
  if (duration) lines.push(`**Interview duration:** ${duration}`);

  return lines.join("  \n");
};

function interviewDuration(interview: ExportInput["interview"]): string | null {
  if (!interview?.startedAt) return null;
  const start = new Date(interview.startedAt).getTime();
  const end = interview.endedAt ? new Date(interview.endedAt).getTime() : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return formatMinutes((end - start) / 1000);
}

// ---------------------------------------------------------------------------
// 2. Verdict
// ---------------------------------------------------------------------------

const verdictSection: Section = (input, feedback) => {
  const latest = latestValidation(input.validations);
  const score = feedback?.score ?? latest?.score;
  if (typeof score !== "number" && !feedback?.scoreBand) return null;

  const lines: string[] = ["## Verdict", ""];
  if (feedback?.scoreBand) {
    const { band, label } = feedback.scoreBand;
    lines.push(`**Band ${band} of 4 — ${SCORE_BAND_NAMES[band]}**`, "", label, "");
  }
  if (typeof score === "number") lines.push(`- **Overall score:** ${score}/100`);
  if (typeof feedback?.designScore === "number") {
    lines.push(`- **Design:** ${feedback.designScore}/100`);
  }
  if (typeof feedback?.discoveryScore === "number") {
    lines.push(`- **Discovery:** ${feedback.discoveryScore}/100`);
  }
  if (feedback?.scoringMode) {
    lines.push(
      feedback.scoringMode === "rubric"
        ? "- **Scoring mode:** weighted rubric coverage"
        : "- **Scoring mode:** dimension average (fallback — no rubric was available, so this is not comparable with rubric-scored attempts)"
    );
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// 3. Debrief narrative
// ---------------------------------------------------------------------------

const debriefSection: Section = (input) => {
  const debrief = input.debrief;
  if (!debrief) return null;

  const parts: string[] = [
    "## Debrief",
    "",
    `**Strongest signal:** ${debrief.strongestSignal}`,
    "",
    `**Recommendation:** ${DEBRIEF_RECOMMENDATION_LABELS[debrief.recommendation]}`
  ];

  const blocks: Array<[string, string[]]> = [
    ["What went well", debrief.whatWentWell],
    ["Where you struggled", debrief.whereTheyStruggled],
    ["Risk areas", debrief.riskAreas]
  ];
  for (const [heading, items] of blocks) {
    if (items.length === 0) continue;
    parts.push("", `### ${heading}`, "", bullets(items));
  }

  if (debrief.studyPlan.length > 0) {
    parts.push("", "### Study plan", "");
    parts.push(
      debrief.studyPlan
        .map((item, index) => {
          const next = item.suggestedNextProblem
            ? `\n   - Try next: ${item.suggestedNextProblem}`
            : "";
          return `${index + 1}. **${item.topic}** — ${item.why}${next}`;
        })
        .join("\n")
    );
  }

  return parts.join("\n");
};

// ---------------------------------------------------------------------------
// 4. Problem + scope
// ---------------------------------------------------------------------------

const problemSection: Section = (input) => {
  const parts = ["## Problem", "", input.problem.statement];

  const live = input.liveConstraints ?? null;
  if (live && live.length > 0) {
    // Live scope is what the validator graded against, so this is the correct
    // record of "what you were asked to build" — annotated so the evolution
    // from seed to committed decisions stays legible.
    parts.push("", "### Scope as it evolved", "");
    parts.push(
      live
        .map((c) => {
          const status = c.status === "removed" ? " _(scoped out)_" : "";
          return `- ${c.text} — _${c.origin}_${status}`;
        })
        .join("\n")
    );
  } else {
    const seed = input.problem.constraintsJson ?? [];
    if (seed.length > 0) parts.push("", "### Constraints", "", bullets(seed));
  }

  return parts.join("\n");
};

// ---------------------------------------------------------------------------
// 5. Rubric outcome
// ---------------------------------------------------------------------------

const rubricSection: Section = (input, feedback) => {
  const rows = joinCriteriaWithEvaluations(input.criteria, feedback?.criteriaEvaluations).sort(
    compareCriterionRows
  );
  if (rows.length === 0) return null;

  const hidden = rows.filter((r) => r.criterion.visibility === "hidden");
  const surfaced = hidden.filter((r) => !r.neverDiscovered).length;
  const cores = rows.filter((r) => r.criterion.importance === "core");
  const coresMissed = cores.filter((r) => !(r.evaluation?.covered ?? false)).length;

  return [
    "## Rubric outcome",
    "",
    `- Core criteria missed: ${coresMissed} / ${cores.length}`,
    ...(hidden.length > 0
      ? [`- Hidden expectations surfaced: ${surfaced} / ${hidden.length}`]
      : []),
    "",
    // Missed cores first — same ordering as the on-screen reveal.
    CRITERION_TABLE_HEADER,
    rows.map(criterionRowToMarkdown).join("\n")
  ].join("\n");
};

// ---------------------------------------------------------------------------
// 6. Flags
// ---------------------------------------------------------------------------

const flagsSection: Section = (_input, feedback) => {
  const fired = (feedback?.flagObservations ?? []).filter((f) => f.fired);
  if (fired.length === 0) return null;

  const render = (kind: "green" | "red") =>
    fired
      .filter((f) => f.kind === kind)
      .map((f) => `- ${f.text}${f.evidence ? ` — _${f.evidence}_` : ""}`)
      .join("\n");

  const greens = render("green");
  const reds = render("red");

  return [
    "## Observed signals",
    "",
    ...(greens ? ["### What went well", "", greens, ""] : []),
    ...(reds ? ["### Watch out", "", reds] : [])
  ]
    .join("\n")
    .trimEnd();
};

// ---------------------------------------------------------------------------
// 7. Process assessment
// ---------------------------------------------------------------------------

const processSection: Section = (_input, feedback) => {
  const process = feedback?.processAssessment;
  if (!process) return null;

  return [
    "## How you worked",
    "",
    bullets(processReadings(process)),
    "",
    ...process.observations.map((o) => `- ${o.signal}\n  - _${o.evidence}_`),
    "",
    "_Reported only — these observations do not affect the score._"
  ].join("\n");
};

function processReadings(process: ProcessAssessment): string[] {
  return [
    PROCESS_READINGS.clarifiedBeforeDesigning[process.clarifiedBeforeDesigning],
    PROCESS_READINGS.decisiveness[process.decisiveness],
    SURFACED_OWN_LIMITATIONS_READING[process.surfacedOwnLimitations ? "true" : "false"],
    PROCESS_READINGS.adaptedWhenChallenged[process.adaptedWhenChallenged],
    PROCESS_READINGS.drove[process.drove]
  ];
}

// ---------------------------------------------------------------------------
// 8. Estimation
// ---------------------------------------------------------------------------

const CALIBRATION_LABEL: Record<FieldCalibration["verdict"], string> = {
  ok: "in range",
  "off-by-one-order": "off by an order of magnitude",
  "way-off": "way off",
  unknown: "—"
};

const estimationSection: Section = (input) => {
  const spec = input.estimationSpec;
  const estimation = input.estimation;
  if (!spec || !estimation) return null;

  const entered = spec.fields.filter((f) => hasValue(estimation[f.key]));
  if (entered.length === 0) return null;

  const calibration = calibrateAll(spec, estimation as Record<string, unknown>);

  const rows = entered.map((field) => {
    const verdict = calibration.perField[field.key];
    const cells = [
      field.label,
      displayValue(field, estimation[field.key]),
      verdict ? CALIBRATION_LABEL[verdict.verdict] : "—",
      verdict?.rationale ?? ""
    ];
    return `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  });

  return [
    "## Estimation",
    "",
    "| Field | Your value | Calibration | Note |",
    "|---|---|---|---|",
    rows.join("\n")
  ].join("\n");
};

function hasValue(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "string") return raw.trim().length > 0;
  if (typeof raw === "number") return Number.isFinite(raw);
  return false;
}

/** Values are persisted in base units, so a raw dump would show `1024` where
 * the candidate typed `1 KB`. Convert back before printing. */
function displayValue(field: EstimationFieldSpec, raw: unknown): string {
  if (typeof raw !== "number") return String(raw ?? "").trim();
  const shown = fromBaseUnit(field, raw);
  const rounded = Number.isInteger(shown) ? String(shown) : shown.toPrecision(4);
  return field.displayUnit ? `${rounded} ${field.displayUnit}` : rounded;
}

// ---------------------------------------------------------------------------
// 9. Phase timeline
// ---------------------------------------------------------------------------

const timelineSection: Section = (input) => {
  const timeline = input.phaseTimeline;
  if (!timeline || timeline.totalSec <= 0) return null;

  const rows = timeline.phases.map((phase) => {
    const budget = phase.budgetSec > 0 ? formatMinutes(phase.budgetSec) : "—";
    const flag = phase.overBudget ? " ⚠︎" : "";
    return `| ${phase.label} | ${budget} | ${formatMinutes(phase.actualSec)}${flag} |`;
  });

  return [
    "## Pacing",
    "",
    "| Phase | Suggested | Actual |",
    "|---|---|---|",
    rows.join("\n"),
    "",
    `Total: ${formatMinutes(timeline.totalSec)}.`
  ].join("\n");
};

// ---------------------------------------------------------------------------
// 10. Dimensions
// ---------------------------------------------------------------------------

const dimensionsSection: Section = (_input, feedback) => {
  const dimensions = feedback?.dimensions;
  if (!dimensions) return null;
  const notes = feedback?.dimensionNotes ?? {};

  const lines = DIM_KEYS.filter((key) => typeof dimensions[key] === "number").map((key) => {
    const note = notes[key];
    // Rendered on screen but silently dropped from the export until now —
    // the note is what makes the number actionable.
    return `- **${DIM_LABELS[key] ?? key}:** ${dimensions[key]}${note ? ` — ${note}` : ""}`;
  });
  if (lines.length === 0) return null;

  return ["## Dimensions", "", lines.join("\n")].join("\n");
};

// ---------------------------------------------------------------------------
// 11. Validator notes
// ---------------------------------------------------------------------------

const validatorNotesSection: Section = (_input, feedback) => {
  const blocks: Array<[string, string[]]> = [
    ["Strengths", feedback?.strengths ?? []],
    ["Gaps", feedback?.gaps ?? []],
    ["Next steps", feedback?.nextSteps ?? []]
  ];
  const present = blocks.filter(([, items]) => items.length > 0);
  if (present.length === 0) return null;

  return [
    "## Validator notes",
    ...present.flatMap(([heading, items]) => ["", `### ${heading}`, "", bullets(items)])
  ].join("\n");
};

// ---------------------------------------------------------------------------
// 12. Tutor usage
// ---------------------------------------------------------------------------

const tutorSection: Section = (input) => {
  const usage = input.tutorUsage;
  if (!usage || usage.candidateTurns === 0) return null;

  return [
    "## Tutor usage",
    "",
    `Consulted ${usage.candidateTurns} ${usage.candidateTurns === 1 ? "time" : "times"} across ${usage.sessions} ${usage.sessions === 1 ? "session" : "sessions"}.`,
    ...(usage.firstUsedAtPhase ? [`First opened during **${usage.firstUsedAtPhase}**.`] : []),
    ...(usage.topics.length > 0 ? [`Topics: ${usage.topics.join(", ")}.`] : []),
    "",
    "_Recorded for reference, not as a deduction — a topic that needed tutor help is a topic worth practising._"
  ].join("\n");
};

// ---------------------------------------------------------------------------
// 13. Reference, transcript, whiteboard
// ---------------------------------------------------------------------------

const referenceSection: Section = (input) => {
  if (!input.reference) return null;
  return [
    "## Reference solution",
    "",
    // Reuses the on-screen formatter, one heading level down.
    markdownFromReference(input.reference).replace(/^## /gm, "### ")
  ].join("\n");
};

const transcriptSection: Section = (input) => {
  const messages = (input.transcript ?? []).filter(
    (m) => m.role === "user" || m.role === "assistant"
  );
  if (messages.length === 0) return null;

  // Collapsed: the transcript is the longest section by far and would
  // otherwise bury everything that explains the score.
  return [
    "## Transcript",
    "",
    "<details>",
    `<summary>${messages.length} messages</summary>`,
    "",
    messages
      .map((m) => `**${m.role === "user" ? "You" : "Interviewer"}:**\n\n${m.content.trim()}`)
      .join("\n\n---\n\n"),
    "",
    "</details>"
  ].join("\n");
};

const whiteboardSection: Section = (input) => {
  if (!input.imageBase64) return null;
  return [
    "## Whiteboard",
    "",
    `![Board snapshot](data:image/png;base64,${input.imageBase64})`
  ].join("\n");
};

const SECTIONS: Section[] = [
  headerSection,
  verdictSection,
  debriefSection,
  problemSection,
  rubricSection,
  flagsSection,
  processSection,
  estimationSection,
  timelineSection,
  dimensionsSection,
  validatorNotesSection,
  tutorSection,
  referenceSection,
  transcriptSection,
  whiteboardSection
];

function latestValidation(validations: ValidationRecord[]): ValidationRecord | undefined {
  return [...validations].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];
}

/** Build the exported debrief document. */
export function buildAttemptMarkdownReport(input: ExportInput): string {
  const feedback = latestValidation(input.validations)?.feedbackJson ?? null;
  return (
    SECTIONS.map((section) => section(input, feedback))
      .filter((part): part is string => part !== null && part.trim().length > 0)
      .join("\n\n") + "\n"
  );
}

export function downloadMarkdown(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
