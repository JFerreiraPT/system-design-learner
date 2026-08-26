import type {
  CriterionEvaluation,
  FeedbackDimensions,
  ReferenceSolution,
  RubricCriterion,
  ValidationFeedback,
  ValidationRecord
} from "./api";

export const DIM_KEYS: Array<keyof FeedbackDimensions> = [
  "requirements",
  "scalability",
  "reliability",
  "consistency",
  "latencyPerformance",
  "cost",
  "security",
  "operability",
  "capacityEstimation"
];

export const DIM_LABELS: Record<string, string> = {
  requirements: "Requirements",
  scalability: "Scalability",
  reliability: "Reliability",
  consistency: "Consistency",
  latencyPerformance: "Latency",
  cost: "Cost",
  security: "Security",
  operability: "Ops",
  capacityEstimation: "Capacity"
};

export function aggregateWeakDimensions(rows: ValidationRecord[], topN = 3) {
  const sums: Partial<Record<string, { sum: number; n: number }>> = {};
  for (const row of rows) {
    const d = row.feedbackJson?.dimensions;
    if (!d) continue;
    for (const k of DIM_KEYS) {
      const v = d[k];
      if (typeof v !== "number") continue;
      if (!sums[k]) sums[k] = { sum: 0, n: 0 };
      sums[k]!.sum += v;
      sums[k]!.n += 1;
    }
  }
  const out: { key: string; avg: number }[] = [];
  for (const [key, agg] of Object.entries(sums)) {
    if (!agg || agg.n === 0) continue;
    out.push({ key, avg: agg.sum / agg.n });
  }
  return out.sort((a, b) => a.avg - b.avg).slice(0, topN);
}

export function markdownFromFeedback(fb: ValidationFeedback | null | undefined) {
  if (!fb) return "";
  return [
    ...(fb.strengths ?? []).map((s: string) => `- **Strength:** ${s}`),
    ...(fb.gaps ?? []).map((g: string) => `- **Gap:** ${g}`),
    ...(fb.nextSteps ?? []).map((n: string) => `- **Next step:** ${n}`)
  ].join("\n");
}

export type CriterionRow = {
  criterion: RubricCriterion;
  evaluation?: CriterionEvaluation;
  /** True when the criterion was hidden AND never surfaced. Drives the
   * "you should have asked about this" framing in the post-validate reveal. */
  neverDiscovered: boolean;
};

/** Joins the validator's per-criterion outcomes back to the full criterion
 * bodies (texts, hints) so the post-validate UI can render the reveal.
 * Falls back gracefully when criteria or evaluations are missing on legacy
 * solutions / interviews. */
export function joinCriteriaWithEvaluations(
  criteria: RubricCriterion[] | null | undefined,
  evaluations: CriterionEvaluation[] | null | undefined
): CriterionRow[] {
  if (!criteria || criteria.length === 0) return [];
  const evalById = new Map((evaluations ?? []).map((e) => [e.criterionId, e] as const));
  return criteria.map((criterion) => {
    const evaluation = evalById.get(criterion.id);
    const neverDiscovered =
      criterion.visibility === "hidden" && !criterion.discoveredVia;
    return { criterion, evaluation, neverDiscovered };
  });
}

/** Sort criteria for the post-validate reveal: missed cores first (highest
 * pedagogical value), then missed expecteds, then covered, then stretch. */
export function compareCriterionRows(a: CriterionRow, b: CriterionRow) {
  const score = (row: CriterionRow) => {
    const c = row.criterion;
    const covered = row.evaluation?.covered ?? false;
    if (c.importance === "core" && !covered) return 0;
    if (c.importance === "expected" && !covered) return 1;
    if (c.importance === "core" && covered) return 2;
    if (c.importance === "expected" && covered) return 3;
    if (c.importance === "stretch" && !covered) return 4;
    return 5;
  };
  return score(a) - score(b);
}

/** Header for the rubric-outcome table in the exported report. */
export const CRITERION_TABLE_HEADER = [
  "| Criterion | Importance | Dimension | Visibility | Surfaced | Covered | Evidence |",
  "|---|---|---|---|---|---|---|"
].join("\n");

/** One criterion as a markdown table row.
 *
 * Lives here, next to `joinCriteriaWithEvaluations` and `compareCriterionRows`,
 * so the exported table and the on-screen reveal are computed from the same
 * join and the same ordering — two implementations of "what was graded" would
 * eventually disagree, and the export is the copy the user keeps.
 */
export function criterionRowToMarkdown(row: CriterionRow): string {
  const { criterion: c, evaluation: ev, neverDiscovered } = row;
  const surfaced =
    c.visibility === "hidden" ? (neverDiscovered ? "never asked" : "discovered") : "shown upfront";
  const covered = ev ? (ev.covered ? "yes" : "**no**") : "not judged";
  const cells = [
    c.text,
    c.importance,
    DIM_LABELS[c.dimension] ?? c.dimension,
    c.visibility,
    surfaced,
    covered,
    ev?.evidence ?? "—"
  ];
  return `| ${cells.map(escapeTableCell).join(" | ")} |`;
}

/** Pipes and newlines would break the table structure. */
function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function markdownFromReference(ref: ReferenceSolution) {
  return [
    `## Summary\n\n${ref.summary}`,
    `## Components\n\n${ref.components.map((c) => `- **${c.name}** (${c.role}): ${c.tradeoffs}`).join("\n")}`,
    `## Data flow\n\n${ref.dataFlow}`,
    `## Trade-offs\n\n${ref.keyTradeoffs.map((t) => `- ${t}`).join("\n")}`,
    `## Deep dives\n\n${ref.deepDives.map((d) => `- ${d}`).join("\n")}`
  ].join("\n\n");
}
