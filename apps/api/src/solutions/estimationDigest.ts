import type { EstimationProblemSpec } from "@sdl/shared";
import {
  calibrateAll,
  EstimationProblemSpecSchema,
  evaluateDerivedFormulas,
  fromBaseUnit
} from "@sdl/shared";

/**
 * Turn the candidate's estimation values into a deterministic digest for the
 * validator.
 *
 * Why not just hand over the raw JSON (which is what we used to do): the model
 * had to guess units and had no notion of what a sensible magnitude was for
 * this problem, so it either ignored the numbers or invented an opinion about
 * them. Everything here — units, in/out of band, derived quantities, the
 * filled ratio — is computed in code, so the model is told facts and asked
 * only to judge whether the DESIGN matches them.
 *
 * Returns "" when there is nothing to say, which keeps the prompt unchanged
 * for problems with no spec and attempts with no numbers.
 */
export function buildEstimationDigest(input: {
  estimationSpecJson: unknown;
  estimation: Record<string, unknown> | null | undefined;
}): string {
  const parsed = EstimationProblemSpecSchema.safeParse(input.estimationSpecJson);
  const estimation = input.estimation ?? {};
  const hasValues = Object.keys(estimation).length > 0;

  // No spec to calibrate against: fall back to the old raw dump rather than
  // dropping the candidate's numbers entirely.
  if (!parsed.success) {
    if (!hasValues) return "";
    return [
      "",
      "Candidate back-of-envelope estimation (JSON, no checklist spec available):",
      JSON.stringify(estimation, null, 2)
    ].join("\n");
  }

  const spec: EstimationProblemSpec = parsed.data;
  const calibration = calibrateAll(spec, estimation);
  const derived = evaluateDerivedFormulas(spec, estimation);

  const fieldLines = spec.fields.map((field) => {
    const raw = estimation[field.key];
    const label = `${field.label} (${field.key})`;

    if (raw === undefined || raw === null || raw === "") {
      return `- ${label}: (not filled)`;
    }

    if (field.type !== "number" || typeof raw !== "number") {
      return `- ${label}: ${String(raw)}`;
    }

    const display = fromBaseUnit(field, raw);
    const unit = field.displayUnit ?? field.unit ?? "";
    const shown = unit ? `${trimFloat(display)} ${unit}` : `${trimFloat(display)}`;
    const verdict = calibration.perField[field.key];

    switch (verdict?.verdict) {
      case "ok":
        return `- ${label}: ${shown} (within the expected band)`;
      case "off-by-one-order":
        return `- ${label}: ${shown} (AN ORDER OF MAGNITUDE TOO ${verdict.direction === "low" ? "LOW" : "HIGH"}${
          verdict.rationale ? ` — ${verdict.rationale}` : ""
        })`;
      case "way-off":
        return `- ${label}: ${shown} (SEVERAL ORDERS OF MAGNITUDE TOO ${verdict.direction === "low" ? "LOW" : "HIGH"}${
          verdict.rationale ? ` — ${verdict.rationale}` : ""
        })`;
      default:
        return `- ${label}: ${shown}`;
    }
  });

  const derivedLines = derived
    .filter((d) => d.value !== undefined)
    .map((d) => `- ${d.label}: ${trimFloat(d.value!)}${d.displayUnit ? ` ${d.displayUnit}` : ""}`);

  return [
    "",
    "Estimation calibration (computed deterministically on the server — treat these verdicts as FACT, do not re-derive them):",
    ...fieldLines,
    ...(derivedLines.length > 0
      ? ["", "Derived from those values:", ...derivedLines]
      : []),
    "",
    `Completeness: ${calibration.filled}/${calibration.total} checklist fields filled. ${calibration.wayOff} field(s) off by 100x or more, ${calibration.offByOne} off by an order of magnitude.`,
    "",
    "Score `capacityEstimation` from three things: how much of the checklist was filled, the calibration verdicts above, and whether the components on the board are consistent with the numbers the candidate committed to (e.g. a single database against a peak RPS that needs sharding). Do not re-check the arithmetic — it is already done.",
    ""
  ].join("\n");
}

/** Keep long floats from dominating the prompt. */
function trimFloat(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 0.001 || magnitude >= 1e9)) {
    return value.toExponential(2);
  }
  return String(Number(value.toPrecision(4)));
}
