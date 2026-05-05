import type { Problem, ValidationRecord, WorkspaceEstimation } from "./api";

type ExportArgs = {
  problem: Problem;
  estimation: WorkspaceEstimation | null;
  validations: ValidationRecord[];
  imageBase64?: string;
};

function formatDimensionsMarkdown(feedback: ValidationRecord["feedbackJson"]) {
  const d = feedback?.dimensions;
  if (!d) return "_No dimension breakdown._\n";
  const keys = [
    ["requirements", "Requirements"],
    ["scalability", "Scalability"],
    ["reliability", "Reliability"],
    ["consistency", "Consistency"],
    ["latencyPerformance", "Latency / performance"],
    ["cost", "Cost"],
    ["security", "Security"],
    ["operability", "Operability"]
  ] as const;
  // Hide null dimensions in the export — they signal "out of scope for this
  // rubric" and shouldn't surface as a fake "—" line in the report either.
  const lines: string[] = [];
  for (const [k, label] of keys) {
    const v = d[k];
    if (typeof v !== "number") continue;
    lines.push(`- **${label}:** ${v}`);
  }
  return lines.length > 0 ? lines.join("\n") : "_No in-scope dimensions for this rubric._";
}

function formatSubscoresMarkdown(feedback: ValidationRecord["feedbackJson"]) {
  const design = feedback?.designScore;
  const discovery = feedback?.discoveryScore;
  if (typeof design !== "number" && typeof discovery !== "number") return "";
  return [
    `**Design score:** ${typeof design === "number" ? design : "—"}`,
    `**Discovery score:** ${typeof discovery === "number" ? discovery : "—"}`
  ].join("  \n");
}

export function buildAttemptMarkdownReport({
  problem,
  estimation,
  validations,
  imageBase64
}: ExportArgs): string {
  const latest = [...validations].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];

  const feedback = latest?.feedbackJson;

  const estimationBlock =
    estimation && Object.values(estimation).some((v) => v !== undefined && v !== "")
      ? "```json\n" + JSON.stringify(estimation, null, 2) + "\n```\n"
      : "_No estimation captured._\n";

  const img =
    imageBase64 && imageBase64.length > 0
      ? `\n![Board snapshot](data:image/png;base64,${imageBase64})\n`
      : "\n_(No board snapshot available — export from the workspace after drawing.)_\n";

  return `# System design attempt — ${problem.title}

**Difficulty:** ${problem.difficulty}  
**Exported:** ${new Date().toISOString()}

## Problem statement

${problem.statement}

## Constraints

${(problem.constraintsJson ?? []).map((c) => `- ${c}`).join("\n")}

## Back-of-envelope estimation

${estimationBlock}

## Latest validation

**Overall score:** ${feedback?.score ?? latest?.score ?? "N/A"}

${formatSubscoresMarkdown(feedback ?? null)}

### Dimensions

${formatDimensionsMarkdown(feedback ?? null)}

### Strengths

${(feedback?.strengths ?? []).map((s) => `- ${s}`).join("\n") || "_—_"}

### Gaps

${(feedback?.gaps ?? []).map((g) => `- ${g}`).join("\n") || "_—_"}

### Next steps

${(feedback?.nextSteps ?? []).map((n) => `- ${n}`).join("\n") || "_—_"}

## Whiteboard

${img}
`;
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
