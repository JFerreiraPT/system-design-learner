import { z } from "zod";
import { evaluateExpression } from "./estimationCalibration.js";

export const DifficultySchema = z.enum(["beginner", "easy", "medium", "hard", "expert"]);
export type Difficulty = z.infer<typeof DifficultySchema>;

export const InterviewerLevelSchema = z.enum(["guided", "standard", "hard", "staff"]);
export type InterviewerLevel = z.infer<typeof InterviewerLevelSchema>;

export const ProblemSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string(),
  statement: z.string(),
  difficulty: DifficultySchema,
  constraints: z.array(z.string()),
  /** Free-text rubric kept only for legacy rows. New problems persist
   * structured criteria on the *interview* row instead (see
   * RubricCriterionSchema + interviews.criteria_json); the validator
   * derives its rubric block from those. */
  evaluationRubric: z.array(z.string()).optional(),
  generatedByAi: z.boolean().default(true),
  createdAt: z.string().optional()
});

export const GenerateProblemInputSchema = z.object({
  difficulty: DifficultySchema,
  topic: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((value) => (value && value.length >= 2 ? value : undefined))
});

export const ValidateSolutionInputSchema = z.object({
  problemId: z.string().uuid(),
  sceneJson: z.string().min(2),
  notes: z.string().optional(),
  estimation: z.record(z.string(), z.unknown()).optional(),
  /** Optional: when present, the validator scores against the live constraint
   * set of this interview instead of the seed `problems.constraints_json`. */
  interviewId: z.string().uuid().optional()
});

export const EstimationInputSchema = z.object({
  dau: z.number().positive().optional(),
  peakRatio: z.number().positive().optional(),
  sessionsPerUserPerDay: z.number().nonnegative().optional(),
  payloadBytes: z.number().positive().optional(),
  retentionDays: z.number().positive().optional(),
  readWriteRatio: z.number().positive().optional(),
  notes: z.string().max(2000).optional()
});
export type EstimationInput = z.infer<typeof EstimationInputSchema>;

/** Fixed dimensions the validator can score. A dimension may be `null` when
 * no active criterion or constraint maps to it (out-of-scope), in which case
 * the UI should hide it instead of showing a fake middling bar. */
export const ScoreDimensionSchema = z.enum([
  "requirements",
  "scalability",
  "reliability",
  "consistency",
  "latencyPerformance",
  "cost",
  "security",
  "operability",
  /** Whether the back-of-envelope numbers are present, in the right order of
   * magnitude, and consistent with the design that was drawn. */
  "capacityEstimation"
]);
export type ScoreDimension = z.infer<typeof ScoreDimensionSchema>;

const dimensionScore = z.number().min(0).max(100).nullable();

export const ValidationDimensionsSchema = z.object({
  requirements: dimensionScore,
  scalability: dimensionScore,
  reliability: dimensionScore,
  consistency: dimensionScore,
  latencyPerformance: dimensionScore,
  cost: dimensionScore,
  security: dimensionScore,
  operability: dimensionScore,
  capacityEstimation: dimensionScore
});
export type ValidationDimensions = z.infer<typeof ValidationDimensionsSchema>;

export const ReferenceSolutionSchema = z.object({
  summary: z.string(),
  components: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      tradeoffs: z.string()
    })
  ),
  dataFlow: z.string(),
  keyTradeoffs: z.array(z.string()),
  deepDives: z.array(z.string())
});
export type ReferenceSolution = z.infer<typeof ReferenceSolutionSchema>;

/** Per-criterion validator outcome attached to ValidationFeedback. */
export const CriterionEvaluationSchema = z.object({
  criterionId: z.string().min(1).max(120),
  /** Whether the candidate's design (board / notes / discussion) addressed
   * this criterion. */
  covered: z.boolean(),
  /** Whether the candidate surfaced this criterion in dialogue (asked about
   * it, committed to it, or named it as an assumption). For `visible` seed
   * criteria this is automatically true — discovery only matters for hidden. */
  discovered: z.boolean(),
  /** "high"|"medium"|"low" weight of the gap if `covered=false`, used by the
   * UI to style/sort the missed-cores list. Optional for covered ones. */
  severity: z.enum(["high", "medium", "low"]).optional(),
  /** One-line evidence pointing at the diagram, notes, or transcript. */
  evidence: z.string().max(500).optional()
});
export type CriterionEvaluation = z.infer<typeof CriterionEvaluationSchema>;

/** Interview score band, matching the 1-4 scale every interview playbook
 * generates (`InterviewerPlaybook.scoreRubric`) and the score tables in the
 * interview-kit templates. */
export const ScoreBandSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4)
]);
export type ScoreBand = z.infer<typeof ScoreBandSchema>;

/** Inclusive lower bound of each band, highest first. The ONLY place band
 * thresholds are defined — web and api both resolve through `scoreBandFor`. */
export const SCORE_BAND_MIN: ReadonlyArray<{ band: ScoreBand; min: number }> = [
  { band: 4, min: 85 },
  { band: 3, min: 65 },
  { band: 2, min: 40 },
  { band: 1, min: 0 }
];

/** Short name per band. Stable UI wording, never model-generated. */
export const SCORE_BAND_NAMES: Record<ScoreBand, string> = {
  1: "Does not meet bar",
  2: "Below expectations",
  3: "Meets bar",
  4: "Exceeds bar"
};

/** Generic band descriptions used when the interview has no playbook to supply
 * problem-specific wording. Mirrors the interview-kit's system-design table. */
export const DEFAULT_SCORE_BAND_DESCRIPTIONS: Record<ScoreBand, string> = {
  1: "Cannot structure a design; no requirements gathering; ignores trade-offs.",
  2: "Covers basics but shallow; needs significant guidance; misses failure modes.",
  3: "Clear design with justified decisions; discusses trade-offs; identifies key challenges.",
  4: "Drives the conversation; deep in 2+ areas; proactively surfaces limitations; considers operational readiness."
};

/** Map an overall 0-100 score onto its band. Non-finite input is treated as 0
 * so a corrupt score can never crash the panel. */
export function scoreBandFor(score: number): ScoreBand {
  const clamped = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
  for (const { band, min } of SCORE_BAND_MIN) {
    if (clamped >= min) return band;
  }
  return 1;
}

/** One playbook flag, judged against the attempt.
 *
 * The interview playbook generates concrete observable signals per probe area
 * (`greenFlags` / `redFlags`) modelled on the interview-kit's Green/Red Flag
 * checkboxes. This is the validator's verdict on whether each one actually
 * fired, addressed by `(areaId, kind, index)` so the server can resolve it
 * back to the stored playbook and reject anything hallucinated. */
export const FlagObservationSchema = z.object({
  /** `InterviewerPlaybookArea.id` this flag belongs to. */
  areaId: z.string().min(1).max(80),
  kind: z.enum(["green", "red"]),
  /** Position within that area's `greenFlags` / `redFlags` array. */
  index: z.number().int().nonnegative(),
  /** Denormalised flag text so the UI needs no join. ALWAYS rewritten from the
   * stored playbook server-side — never trusted from model output. */
  text: z.string().max(220),
  fired: z.boolean(),
  /** Quote or close paraphrase of the diagram element / transcript line that
   * triggered the observation. Only meaningful when `fired` is true. */
  evidence: z.string().max(500).optional()
});
export type FlagObservation = z.infer<typeof FlagObservationSchema>;

/** Full model output stored in solutions.feedback_json after A1 */
export const ValidationFeedbackSchema = z.object({
  /** Blended overall = designScore × w_design + discoveryScore × w_discovery. */
  score: z.number().min(0).max(100).optional(),
  /** Score for the diagram/notes against active scope (independent of how
   * much the candidate uncovered in dialogue). */
  designScore: z.number().min(0).max(100).optional(),
  /** Score for how much of the *hidden* scope the candidate surfaced through
   * clarifying questions or commitments. 100 if there were no hiddens. */
  discoveryScore: z.number().min(0).max(100).optional(),
  /** Which regime produced `designScore`.
   *
   * `rubric` — weighted coverage of the interview's structured criteria. This
   * is the real scoring path and the only one that is comparable across
   * attempts.
   * `dimensions` — fallback used when there are no criteria (legacy problems)
   * or the validator returned no per-criterion judgments. It averages the
   * dimension bars, which is a *different scale*; persisting the mode lets the
   * UI and dashboard avoid silently mixing the two.
   *
   * Optional: rows written before this field existed leave it undefined. */
  scoringMode: z.enum(["rubric", "dimensions"]).optional(),
  /** The 1-4 band the overall `score` falls into, plus the calibrated
   * description for that band.
   *
   * `label` prefers the interview playbook's generated `scoreRubric[band]`,
   * which is written for THIS problem at THIS interviewer level, and falls
   * back to `DEFAULT_SCORE_BAND_DESCRIPTIONS` when no playbook exists (legacy
   * interviews, or a validation with no interview at all). */
  scoreBand: z
    .object({
      band: ScoreBandSchema,
      label: z.string().max(400)
    })
    .optional(),
  dimensions: ValidationDimensionsSchema.optional(),
  dimensionNotes: z.record(z.string(), z.string()).optional(),
  /** Per-criterion outcomes, indexed by id. Present when the validator was
   * given an interview's criteria set. */
  criteriaEvaluations: z.array(CriterionEvaluationSchema).optional(),
  /** IDs of `core` criteria the candidate's design covered (subset of
   * criteriaEvaluations). Convenience for UI badges. */
  coreCovered: z.array(z.string()).optional(),
  /** IDs of `core` criteria the candidate's design FAILED to cover. The UI
   * should highlight these prominently — they are the "you missed this" list. */
  coreMissed: z.array(z.string()).optional(),
  /** Per-flag verdicts against the interview playbook. Reported, not scored —
   * flags overlap the criteria they were written alongside, so counting both
   * would double-penalise. Absent when the interview has no playbook. */
  flagObservations: z.array(FlagObservationSchema).max(60).optional(),
  strengths: z.array(z.string()).optional(),
  gaps: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional()
});
export type ValidationFeedback = z.infer<typeof ValidationFeedbackSchema>;

/** Timer strip: phase order and suggested duration (from problem-specific interview plan). */
export const PhaseDefinitionSchema = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(80),
  durationSec: z.number().int().min(60).max(3600)
});
export type PhaseDefinition = z.infer<typeof PhaseDefinitionSchema>;

/** One phase in the gated interview + onboarding copy for the candidate. */
export const InterviewPlanPhaseSchema = PhaseDefinitionSchema.extend({
  candidateGuide: z.string().min(40).max(1500)
});
export type InterviewPlanPhase = z.infer<typeof InterviewPlanPhaseSchema>;

export const InterviewPlanSchema = z.object({
  intro: z.string().max(800).optional(),
  phases: z.array(InterviewPlanPhaseSchema).min(3).max(8)
});
export type InterviewPlan = z.infer<typeof InterviewPlanSchema>;

export function timerPhasesFromPlan(plan: InterviewPlan): PhaseDefinition[] {
  return plan.phases.map(({ id, label, durationSec }) => ({ id, label, durationSec }));
}

/** Default plan when `interview_plan_json` is null (older problems). */
export const DEFAULT_INTERVIEW_PLAN: InterviewPlan = {
  phases: [
    {
      id: "clarify",
      label: "Clarify",
      durationSec: 5 * 60,
      candidateGuide:
        "Scope the problem. **Interact with:** **Problem** tab (re-read statement and constraints). **Interviewer** tab — ask me about users, scale, latency, consistency, or anything ambiguous before you commit to a design. Use **Tutor** only for vocabulary or concepts, not to skip clarifying."
    },
    {
      id: "estimate",
      label: "Estimate",
      durationSec: 8 * 60,
      candidateGuide:
        "Lock rough magnitudes before architecture. **Interact with:** **Estimation** tab — fill every field (numbers or text) so we can sanity-check scale together. Then **Interviewer** tab — tell me your assumptions or ask if an order-of-magnitude is off. Optionally glance at **Problem** again if a constraint affects load."
    },
    {
      id: "api",
      label: "API",
      durationSec: 7 * 60,
      candidateGuide:
        "Shape the contract and data model. **Interact with:** **Board** — sketch main entities and how clients/services talk (reads vs writes). **Interviewer** tab — walk me through APIs or events you have in mind. **Problem** tab if you need to align with a written constraint."
    },
    {
      id: "high_level",
      label: "High-level",
      durationSec: 15 * 60,
      candidateGuide:
        "Lay out the full system. **Interact with:** **Board** — add clients, gateways, services, storage, caches, queues, etc.; draw major flows. **Interviewer** tab — narrate as you go so I can follow. Use **Tutor** if you need a pattern name, then come back here."
    },
    {
      id: "deep_dive",
      label: "Deep dive",
      durationSec: 10 * 60,
      candidateGuide:
        "Go deep on one critical area. **Interact with:** **Board** — zoom in (replication, sharding, ordering, failure paths). **Interviewer** tab — expect pointed follow-ups on that slice. Keep **Estimation** numbers in mind when arguing about scale."
    },
    {
      id: "tradeoffs",
      label: "Trade-offs",
      durationSec: 5 * 60,
      candidateGuide:
        "Stress-test decisions. **Interact with:** **Board** — mark alternatives or limits (e.g. consistency vs latency). **Interviewer** tab — compare options and failure modes. When you want structured feedback on the full attempt, use **Validate** (separate from this chat)."
    }
  ]
};

/** @deprecated use `timerPhasesFromPlan(DEFAULT_INTERVIEW_PLAN)` or the problem's plan */
export const WORKSPACE_PHASES: PhaseDefinition[] = timerPhasesFromPlan(DEFAULT_INTERVIEW_PLAN);

/** AI-generated estimation checklist for a specific problem */
/** Unit family for a numeric estimation field. Values are ALWAYS stored in the
 * family's base unit — bytes, seconds, or a plain count — regardless of the
 * unit the field displays. `ratio` and `currency` are dimensionless in
 * practice but are kept distinct so calibration copy can read correctly. */
export const EstimationUnitKindSchema = z.enum([
  "count",
  "bytes",
  "seconds",
  "ratio",
  "currency"
]);
export type EstimationUnitKind = z.infer<typeof EstimationUnitKindSchema>;

/** Order-of-magnitude band a reasonable answer falls in, in BASE units.
 *
 * Deliberately wide: this checks whether the candidate is in the right
 * ballpark, not whether their arithmetic is exact. A band narrower than one
 * order of magnitude is treated as malformed and dropped — see
 * `normalizeEstimationSpec`. */
export const ExpectedMagnitudeSchema = z.object({
  min: z.number().positive(),
  max: z.number().positive(),
  /** One clause explaining the band, shown only AFTER the candidate answers
   * out of range ("~1KB per message is typical for text chat"). */
  rationale: z.string().max(300).optional()
});
export type ExpectedMagnitude = z.infer<typeof ExpectedMagnitudeSchema>;

/** Minimum span of a usable magnitude band, as a multiplier. */
export const MIN_MAGNITUDE_SPAN = 10;

export const EstimationFieldSpecSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(120),
  type: z.enum(["number", "text"]),
  placeholder: z.string().max(80).optional(),
  hint: z.string().max(500).optional(),
  /** @deprecated Free-text unit kept for specs generated before `displayUnit`.
   * Presentation only; carries no conversion information. */
  unit: z.string().max(40).optional(),
  /** Unit family. Required on new numeric fields, absent on text fields and on
   * every spec generated before magnitudes existed. */
  unitKind: EstimationUnitKindSchema.optional(),
  /** Unit shown next to the label, e.g. "KB", "ms", "req/s". */
  displayUnit: z.string().max(24).optional(),
  /** Multiply an entered display value by this to reach the base unit
   * (KB -> 1024, ms -> 0.001). Absent means 1. */
  displayMultiplier: z.number().positive().optional(),
  expectedMagnitude: ExpectedMagnitudeSchema.optional()
});
export type EstimationFieldSpec = z.infer<typeof EstimationFieldSpecSchema>;

/** Display value -> stored base value. Identity when no multiplier is set, so
 * every legacy spec round-trips untouched. */
export function toBaseUnit(field: EstimationFieldSpec, displayValue: number): number {
  const m = field.displayMultiplier;
  if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) return displayValue;
  return displayValue * m;
}

/** Stored base value -> display value. Inverse of `toBaseUnit`. */
export function fromBaseUnit(field: EstimationFieldSpec, baseValue: number): number {
  const m = field.displayMultiplier;
  if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) return baseValue;
  return baseValue / m;
}

/**
 * Strip incoherent unit/magnitude metadata from a generated spec.
 *
 * Runs after generation so a model slip degrades one field to "no calibration"
 * instead of poisoning the checklist. Drops:
 *   - unit/magnitude metadata on `text` fields, which have no magnitude;
 *   - bands that are inverted, non-finite, or narrower than one order of
 *     magnitude (too tight to be a fair order-of-magnitude check);
 *   - non-positive display multipliers.
 */
export function normalizeEstimationSpec(spec: EstimationProblemSpec): EstimationProblemSpec {
  const fieldKeys = new Set(spec.fields.filter((f) => f.type === "number").map((f) => f.key));

  // A formula that references a field we don't have, or that the evaluator
  // cannot parse, would render as a permanent "—". Drop it at generation time
  // rather than showing a broken row forever.
  const derivedFormulas = spec.derivedFormulas?.filter((formula) => {
    const probe: Record<string, number> = {};
    for (const key of fieldKeys) probe[key] = 1;
    return evaluateExpression(formula.expression, probe) !== undefined;
  });

  return {
    ...spec,
    ...(spec.derivedFormulas
      ? { derivedFormulas: derivedFormulas && derivedFormulas.length > 0 ? derivedFormulas : undefined }
      : {}),
    fields: spec.fields.map((field) => {
      if (field.type !== "number") {
        const { unitKind, displayUnit, displayMultiplier, expectedMagnitude, ...rest } = field;
        return rest;
      }

      const next: EstimationFieldSpec = { ...field };

      const m = next.displayMultiplier;
      if (typeof m === "number" && (!Number.isFinite(m) || m <= 0)) {
        delete next.displayMultiplier;
      }

      const band = next.expectedMagnitude;
      if (band) {
        const usable =
          Number.isFinite(band.min) &&
          Number.isFinite(band.max) &&
          band.min > 0 &&
          band.max >= band.min * MIN_MAGNITUDE_SPAN;
        if (!usable) delete next.expectedMagnitude;
      }

      return next;
    })
  };
}

/** A quantity computed from the candidate's own inputs.
 *
 * `expression` is model-generated, so it is parsed and evaluated by a
 * hand-written tokeniser + shunting-yard evaluator — never `eval`. Grammar:
 * field keys, numeric literals, `+ - * /`, parentheses, unary minus. */
export const EstimationDerivedFormulaSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(80),
  /** References field `key`s, e.g. "dau * sessions_per_day / 86400". */
  expression: z.string().min(1).max(200),
  unitKind: EstimationUnitKindSchema,
  displayUnit: z.string().max(24).optional()
});
export type EstimationDerivedFormula = z.infer<typeof EstimationDerivedFormulaSchema>;

export const EstimationProblemSpecSchema = z.object({
  intro: z.string().max(800).optional(),
  fields: z.array(EstimationFieldSpecSchema).min(3).max(10),
  /** Qualitative sanity-check bullets. Kept alongside `derivedFormulas` —
   * they answer "does this feel right", which arithmetic cannot. */
  derivedHints: z.array(z.string().max(400)).max(8).optional(),
  /** Quantitative checks computed from the entered values. Absent on every
   * spec generated before formulas existed. */
  derivedFormulas: z.array(EstimationDerivedFormulaSchema).max(6).optional()
});
export type EstimationProblemSpec = z.infer<typeof EstimationProblemSpecSchema>;

/** Default template when `estimation_spec_json` is missing (older rows) */
export const LEGACY_ESTIMATION_SPEC: EstimationProblemSpec = {
  intro:
    "Generic capacity template. Prefer generating a problem-specific checklist via Generate or backfill when possible.",
  fields: [
    { key: "dau", label: "DAU", type: "number", hint: "Daily active users" },
    { key: "peak_ratio", label: "Peak / avg ratio", type: "number", placeholder: "e.g. 3" },
    {
      key: "sessions_per_user_per_day",
      label: "Sessions / user / day",
      type: "number"
    },
    { key: "payload_bytes", label: "Avg payload (bytes)", type: "number" },
    { key: "retention_days", label: "Retention (days)", type: "number" },
    {
      key: "read_write_ratio",
      label: "Read:write ratio (R per 1 W)",
      type: "number",
      placeholder: "e.g. 9"
    },
    { key: "notes", label: "Notes", type: "text" }
  ]
};

/** Whether to use numeric derived RPS/storage formulas (legacy template only). */
export function isLegacyDerivedEstimationSpec(spec: EstimationProblemSpec): boolean {
  const keys = spec.fields.map((f) => f.key);
  if (keys.length !== LEGACY_ESTIMATION_SPEC.fields.length) return false;
  return keys.every((k, i) => k === LEGACY_ESTIMATION_SPEC.fields[i]!.key);
}

/** Compact projection of an Excalidraw scene used to give chat models a
 * structured, low-token view of the diagram. We avoid sending raw scene JSON
 * because it is large (appState, files, ids, version stamps...) and forces the
 * model to reason about geometry. */
export const SceneSummarySchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        kind: z.string().optional()
      })
    )
    .max(200),
  edges: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        label: z.string().optional()
      })
    )
    .max(400),
  /** Short human-readable description, e.g. "5 components, 4 connections". */
  summaryText: z.string().max(2000).optional()
});
export type SceneSummary = z.infer<typeof SceneSummarySchema>;

export { projectSceneJson } from "./sceneProjection.js";

export {
  calibrateAll,
  calibrateField,
  evaluateDerivedFormulas,
  evaluateExpression,
  type CalibrationVerdict,
  type DerivedValue,
  type FieldCalibration,
  type SpecCalibration
} from "./estimationCalibration.js";

/** Importance tier for rubric criteria and live constraints. Drives both
 * scoring weight in validation and how aggressively the interviewer probes. */
export const ImportanceSchema = z.enum(["core", "expected", "stretch"]);
export type Importance = z.infer<typeof ImportanceSchema>;

/** A single live constraint for a running interview. Constraints evolve as
 * the conversation progresses — the interviewer commits product decisions and
 * the candidate may add their own assumptions. We soft-remove (status=removed)
 * to preserve audit. The `seed` set is copied from `problems.constraints_json`
 * when an interview starts; subsequent edits live only on the interview row. */
export const LiveConstraintSchema = z.object({
  id: z.string().min(1).max(120),
  text: z.string().min(2).max(500),
  origin: z.enum(["seed", "interviewer", "candidate"]),
  status: z.enum(["active", "removed"]),
  /** ISO timestamp the constraint was first added. */
  addedAt: z.string().optional(),
  /** ISO timestamp the constraint was soft-removed (only when status=removed). */
  removedAt: z.string().optional(),
  /** Carried over from the criterion this constraint was discovered from
   * (set when a hidden criterion gets surfaced). Lets the rail show a "core"
   * pill on the bullet and the validator weight it accordingly. */
  importance: ImportanceSchema.optional(),
  /** Back-link to the criterion this constraint surfaced. Null/undefined for
   * free-form scope adds that don't map to any pre-defined criterion. */
  discoveredFromCriterionId: z.string().min(1).max(120).optional()
});
export type LiveConstraint = z.infer<typeof LiveConstraintSchema>;

/** A pending suggestion to mutate the live constraint set, derived by the AI
 * after each interviewer turn. The candidate confirms with Apply or Dismiss
 * before it takes effect, so the AI never silently mutates scope. */
export const ConstraintProposalSchema = z.object({
  id: z.string().min(1).max(120),
  /** "add" creates a new constraint with `text`. "remove" soft-removes the
   * constraint identified by `targetConstraintId`. */
  kind: z.enum(["add", "remove"]),
  text: z.string().min(2).max(500).optional(),
  targetConstraintId: z.string().min(1).max(120).optional(),
  rationale: z.string().max(500).optional(),
  /** ISO timestamp the proposal was created. */
  createdAt: z.string().optional()
});
export type ConstraintProposal = z.infer<typeof ConstraintProposalSchema>;

/** How a hidden criterion got surfaced during the interview. `seed` means
 * the criterion was visible from the start (e.g. covered by a seed
 * constraint). `interviewer` / `candidate` mean the conversation made the
 * commitment. `match` means the per-turn criterion-discovery model inferred
 * coverage from the transcript. */
export const CriterionDiscoverySchema = z.object({
  kind: z.enum(["seed", "interviewer", "candidate", "match"]),
  /** ISO timestamp of when the discovery was recorded. */
  at: z.string(),
  /** Optional pointer to the message that surfaced it — useful for audit
   * and post-validate "you discovered this here" hints. */
  messageId: z.string().optional(),
  /** Short rationale from the matcher, for debugging false positives. */
  rationale: z.string().max(500).optional()
});
export type CriterionDiscovery = z.infer<typeof CriterionDiscoverySchema>;

/** Structured evaluation criterion attached to an interview at start time.
 *
 * Criteria are a strictly tighter rubric than free-form `evaluationRubric`
 * strings: each carries a `dimension` (so the validator scores the right
 * axis), an `importance` tier (so missing a `core` is a hard penalty while
 * a `stretch` is bonus-only), and a `visibility` flag (so we can hide
 * "things the candidate is supposed to ASK about" until they actually
 * surface them — driving discovery scoring and the level-aware coaching
 * rules in the interviewer prompt). */
export const RubricCriterionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_]*$/),
  /** Plain-English description of what we expect to see covered. */
  text: z.string().min(4).max(400),
  /** Which scoring axis this criterion contributes to. */
  dimension: ScoreDimensionSchema,
  /** core = required at this level; expected = should appear; stretch = bonus only. */
  importance: ImportanceSchema,
  /** visible = overlaps a seed constraint the candidate already sees on the
   * Problem rail. hidden = latent expectation the candidate must DISCOVER
   * (by asking, by committing to it on the board, or via interviewer commit). */
  visibility: z.enum(["visible", "hidden"]),
  /** Probes the interviewer can use to nudge the candidate toward this
   * criterion, scaled to the level (guided uses them eagerly, staff barely
   * at all). 1-3 short prompts. */
  discoveryHints: z.array(z.string().max(200)).max(4).optional(),
  /** Ordered easy -> sharp nudges for the interviewer playbook. These give
   * the AI a controlled escalation path before it reveals too much. */
  progressiveNudges: z
    .tuple([z.string().max(240), z.string().max(240), z.string().max(240)])
    .optional(),
  /** Signals the validator should look for in the diagram/notes when
   * deciding `covered=true`. Free-form bullet hints, not strict matchers. */
  satisfiedBy: z.array(z.string().max(200)).max(4).optional(),
  /** Optional difficulty/scale anchor (e.g. "for beginner: assume <100 users"). */
  scaleNote: z.string().max(300).optional(),
  /** Populated when the criterion gets surfaced. Visible criteria are
   * pre-marked `kind: "seed"` at interview start; hiddens stay null until
   * discovered. */
  discoveredVia: CriterionDiscoverySchema.nullable().optional()
});
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

/** A criteria set is just an array — kept as a named export so api code can
 * validate the JSONB column with a single `.parse(...)`. */
export const RubricCriteriaSetSchema = z.array(RubricCriterionSchema).max(40);
export type RubricCriteriaSet = z.infer<typeof RubricCriteriaSetSchema>;

export const InterviewerPlaybookAreaSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(80),
  /** Phase ids from the generated interview plan where this probe area fits. */
  phaseRefs: z.array(z.string().min(1).max(40)).min(1).max(8),
  /** Criterion ids from this same rubric that the area helps evaluate. */
  criterionRefs: z.array(z.string().min(1).max(80)).min(1).max(8),
  sampleQuestions: z.array(z.string().min(4).max(240)).min(1).max(4),
  progressiveNudges: z.tuple([
    z.string().min(4).max(240),
    z.string().min(4).max(240),
    z.string().min(4).max(240)
  ]),
  greenFlags: z.array(z.string().min(4).max(220)).min(1).max(6),
  redFlags: z.array(z.string().min(4).max(220)).min(1).max(6)
});
export type InterviewerPlaybookArea = z.infer<typeof InterviewerPlaybookAreaSchema>;

export const InterviewerPlaybookSchema = z.object({
  areasToProbe: z.array(InterviewerPlaybookAreaSchema).min(1).max(12),
  scoreRubric: z.object({
    "1": z.string().min(4).max(400),
    "2": z.string().min(4).max(400),
    "3": z.string().min(4).max(400),
    "4": z.string().min(4).max(400)
  })
});
export type InterviewerPlaybook = z.infer<typeof InterviewerPlaybookSchema>;

export const InterviewRubricSchema = z.object({
  criteria: RubricCriteriaSetSchema,
  playbook: InterviewerPlaybookSchema
});
export type InterviewRubric = z.infer<typeof InterviewRubricSchema>;

export type StoredInterviewRubric = InterviewRubric | RubricCriterion[] | null;

export function getRubricCriteria(value: unknown): RubricCriterion[] | null {
  if (value === null || value === undefined) return null;

  const legacyParsed = RubricCriteriaSetSchema.safeParse(value);
  if (legacyParsed.success) return legacyParsed.data;

  const rubricParsed = InterviewRubricSchema.safeParse(value);
  if (rubricParsed.success) return rubricParsed.data.criteria;

  return null;
}

export function getRubricPlaybook(value: unknown): InterviewerPlaybook | null {
  if (value === null || value === undefined || Array.isArray(value)) return null;

  const rubricParsed = InterviewRubricSchema.safeParse(value);
  if (rubricParsed.success) return rubricParsed.data.playbook;

  return null;
}

/** Live pacing info for the current interview phase so AI assistants can
 * gauge how the candidate is doing against the suggested budget. */
export const PhaseRuntimeInfoSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  /** 0-based phase index in the plan. */
  index: z.number().int().nonnegative(),
  /** Total number of phases in the plan. */
  total: z.number().int().positive(),
  /** Seconds spent in this phase so far (timer accumulator). */
  elapsedSec: z.number().int().nonnegative(),
  /** Suggested duration for this phase in seconds (from the plan). */
  durationSec: z.number().int().positive(),
  /** Whether the timer is currently running. */
  running: z.boolean().optional()
});
export type PhaseRuntimeInfo = z.infer<typeof PhaseRuntimeInfoSchema>;

const workspaceContextSchema = z
  .object({
    problemId: z.string().uuid().optional(),
    problemTitle: z.string().optional(),
    problemStatement: z.string().optional(),
    constraints: z.array(z.string()).optional(),
    /** Compact projection of the Excalidraw scene. Preferred over raw JSON. */
    sceneSummary: SceneSummarySchema.optional(),
    /** Optional PNG of the board (base64, no data: prefix), used for multimodal models. */
    imageBase64: z.string().optional(),
    notes: z.string().optional(),
    /** Structured phase + pacing info. Replaces the legacy `currentPhase` string. */
    phase: PhaseRuntimeInfoSchema.optional(),
    estimation: z.record(z.string(), z.unknown()).optional(),
    estimationChecklist: z
      .object({
        intro: z.string().optional(),
        fields: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            hint: z.string().optional()
          })
        )
      })
      .optional()
  })
  .optional();

export const InterviewStartSchema = z.object({
  problemId: z.string().uuid(),
  interviewerLevel: InterviewerLevelSchema
});

export const InterviewPatchSchema = z.object({
  interviewerLevel: InterviewerLevelSchema
});

export const InterviewMessageSchema = z.object({
  content: z.string().min(1),
  workspaceContext: workspaceContextSchema
});

/** Manual edit endpoints (candidate-driven). */
export const AddConstraintInputSchema = z.object({
  text: z.string().min(2).max(500)
});

export const ApplyProposalInputSchema = z.object({
  proposalId: z.string().min(1).max(120)
});

export const TutorStartSchema = z.object({
  title: z.string().min(1).max(100).optional()
});

export const TutorMessageSchema = z.object({
  content: z.string().min(1),
  workspaceContext: workspaceContextSchema
});
