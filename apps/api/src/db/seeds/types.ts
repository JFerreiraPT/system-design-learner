import { CRITERIA_BUDGET_BY_DIFFICULTY, hasEstimationPhase } from "@sdl/ai-prompts";
import {
  DifficultySchema,
  EstimationProblemSpecSchema,
  INTERVIEWER_LEVEL_ORDER,
  InterviewPlanSchema,
  MIN_MAGNITUDE_SPAN,
  SeededRubricSchema,
  TrackSchema,
  evaluateExpression,
  hiddenCountAtLevel,
  isHiddenAtLevel,
  normalizeEstimationSpec,
  projectRubricForLevel
} from "@sdl/shared";
import type { InterviewerLevel } from "@sdl/shared";
import { z } from "zod";

/**
 * Curated, hand-authored system design problems — the classic interview
 * catalogue (Netflix, YouTube, Uber, Google Docs, Ticketmaster...).
 *
 * These exist alongside `POST /problems/generate`, not instead of it. A
 * generated problem is novel but unvetted; a seed is a problem thousands of
 * real candidates have been asked, written once and reviewed. Because seeds
 * carry the same `narrative_json` / `estimation_spec_json` /
 * `interview_plan_json` payload the generator produces, every downstream
 * behaviour (framing script, stall ladder, phase gating, magnitude
 * calibration) works identically on them — and seeding costs no model calls.
 *
 * Rubrics ARE seeded, via `rubric`. Interviewer level changes exactly one
 * thing about a rubric — which expectations are hidden rather than printed on
 * the Problem rail — so one canonical criteria set annotated with `hiddenFrom`
 * projects cleanly to all four levels. A seeded problem therefore starts an
 * interview with no model call at all. Omitting `rubric` is still valid and
 * falls back to generating one per interview.
 */

/** Tag vocabulary the generator is held to, mirrored here so seeds cannot
 * invent tags the rest of the product does not recognise. Kept in sync with
 * `TAG_VOCABULARY_SNIPPET` in @sdl/ai-prompts by `seeds.test.ts`. */
export const SEED_TAG_VOCABULARY = [
  "caching",
  "geo-distributed",
  "real-time",
  "search",
  "transactional",
  "streaming",
  "rate-limiting",
  "messaging",
  "storage",
  "consistency",
  "replication",
  "sharding",
  "observability",
  "security",
  "cost-optimization",
  "mobile",
  "api-design",
  "data-pipeline",
  "batch",
  "leader-election",
  "cdn",
  "event-sourcing",
  "multi-tenant",
  "compliance"
] as const;

/** Seeds must carry the whole narrative layer. The column is optional for
 * generated rows because early problems predate it; a hand-written problem has
 * no such excuse, so all three fields are required here. */
const SeedNarrativeSchema = z.object({
  framingScript: z.string().min(80).max(900),
  signatureChallenge: z.string().min(40).max(400),
  progressiveReveals: z.tuple([
    z.string().min(20).max(300),
    z.string().min(20).max(300),
    z.string().min(20).max(300)
  ])
});

export const SeedProblemSchema = z.object({
  /** Stable identity for the upsert and for the catalogue file name. Not a
   * column — `problems` has no slug, so the runner matches on `title`. */
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(4).max(120),
  /** The written spec on the Problem rail. Terse by design — the spoken
   * framing lives in `narrative.framingScript`. */
  statement: z.string().min(200).max(4000),
  difficulty: DifficultySchema,
  track: TrackSchema,
  constraints: z.array(z.string().min(8).max(300)).min(4).max(8),
  tags: z.array(z.enum(SEED_TAG_VOCABULARY)).min(2).max(5),
  narrative: SeedNarrativeSchema,
  estimationSpec: EstimationProblemSpecSchema,
  interviewPlan: InterviewPlanSchema,
  /** Hand-authored rubric, projected per interviewer level at interview start.
   * Optional: a seed without one still works, it just costs a model call. */
  rubric: SeededRubricSchema.optional()
});

export type SeedProblem = z.infer<typeof SeedProblemSchema>;

/** Authoring helper: gives the object literal its type without widening. */
export function defineSeedProblem(problem: SeedProblem): SeedProblem {
  return problem;
}

/**
 * Full validation for one seed.
 *
 * Goes beyond `SeedProblemSchema` because the schema alone cannot catch the
 * failures that actually hurt: a magnitude band too tight to be a fair
 * order-of-magnitude check, or a derived formula referencing a field that does
 * not exist. Both are silently discarded by `normalizeEstimationSpec` at
 * runtime, which means the candidate sees a permanent "—" instead of an error.
 * Seeds are checked eagerly so that never ships.
 *
 * Returns human-readable problems; empty array means the seed is good.
 */
export function validateSeedProblem(seed: SeedProblem): string[] {
  const errors: string[] = [];
  const parsed = SeedProblemSchema.safeParse(seed);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return errors;
  }

  const spec = seed.estimationSpec;
  const numberKeys = new Set(spec.fields.filter((f) => f.type === "number").map((f) => f.key));

  const seenKeys = new Set<string>();
  for (const field of spec.fields) {
    if (seenKeys.has(field.key)) errors.push(`estimationSpec: duplicate field key "${field.key}"`);
    seenKeys.add(field.key);

    if (field.type === "number") {
      if (!field.unitKind) errors.push(`estimationSpec.${field.key}: number field needs unitKind`);
      const band = field.expectedMagnitude;
      if (!band) {
        errors.push(`estimationSpec.${field.key}: number field needs expectedMagnitude`);
      } else if (band.max < band.min * MIN_MAGNITUDE_SPAN) {
        errors.push(
          `estimationSpec.${field.key}: band ${band.min}..${band.max} spans less than ${MIN_MAGNITUDE_SPAN}x and would be dropped`
        );
      }
    } else {
      for (const forbidden of [
        "unitKind",
        "displayUnit",
        "displayMultiplier",
        "expectedMagnitude"
      ] as const) {
        if (field[forbidden] !== undefined) {
          errors.push(`estimationSpec.${field.key}: text field must not carry ${forbidden}`);
        }
      }
    }
  }

  for (const formula of spec.derivedFormulas ?? []) {
    const probe: Record<string, number> = {};
    for (const key of numberKeys) probe[key] = 1;
    if (evaluateExpression(formula.expression, probe) === undefined) {
      errors.push(
        `estimationSpec.derivedFormulas.${formula.id}: "${formula.expression}" does not evaluate and would be dropped`
      );
    }
  }

  // Belt and braces: if normalisation changes the shape, something above was
  // missed and the candidate would silently lose a check.
  const normalized = normalizeEstimationSpec(spec);
  if ((normalized.derivedFormulas?.length ?? 0) !== (spec.derivedFormulas?.length ?? 0)) {
    errors.push("estimationSpec: normalizeEstimationSpec dropped a derived formula");
  }

  const phaseIds = new Set<string>();
  for (const phase of seed.interviewPlan.phases) {
    if (phaseIds.has(phase.id)) {
      errors.push(`interviewPlan: duplicate phase id "${phase.id}"`);
    }
    phaseIds.add(phase.id);
  }

  if (seed.rubric) {
    errors.push(...validateSeededRubric(seed, phaseIds));
  }

  return errors;
}

/**
 * Hold a hand-authored rubric to the same bar as a generated one.
 *
 * Everything here mirrors a rule the criteria prompt states, checked against
 * every level's projection rather than just one. That matters because the
 * whole point of `hiddenFrom` is that one authored rubric becomes four real
 * ones — a discovery floor satisfied at `staff` but violated at `guided` would
 * otherwise ship silently and leave guided candidates with nothing to find.
 */
function validateSeededRubric(seed: SeedProblem, phaseIds: Set<string>): string[] {
  const rubric = seed.rubric;
  if (!rubric) return [];

  const errors: string[] = [];
  const budget = CRITERIA_BUDGET_BY_DIFFICULTY[seed.difficulty];
  const criteria = rubric.criteria;

  const ids = new Set<string>();
  for (const criterion of criteria) {
    if (ids.has(criterion.id)) errors.push(`rubric: duplicate criterion id "${criterion.id}"`);
    ids.add(criterion.id);

    // The prompt requires discoveryHints on anything hidden — without them the
    // interviewer has no way to nudge toward it, and coaching falls back to
    // nothing at exactly the moment it is needed.
    if (criterion.hiddenFrom && (criterion.discoveryHints ?? []).length === 0) {
      errors.push(`rubric.${criterion.id}: hidden criteria need discoveryHints`);
    }
    if (criterion.hiddenFrom && !criterion.progressiveNudges) {
      errors.push(`rubric.${criterion.id}: hidden criteria need progressiveNudges`);
    }
  }

  const [minTotal, maxTotal] = budget.total;
  if (criteria.length < minTotal || criteria.length > maxTotal) {
    errors.push(
      `rubric: ${criteria.length} criteria is outside the ${seed.difficulty} budget of ${minTotal}-${maxTotal}`
    );
  }

  const cores = criteria.filter((c) => c.importance === "core");
  if (cores.length === 0) errors.push("rubric: no core criteria");
  if (cores.length > budget.coreMax) {
    errors.push(`rubric: ${cores.length} core criteria exceeds coreMax ${budget.coreMax}`);
  }

  const stretches = criteria.filter((c) => c.importance === "stretch").length;
  if (stretches > budget.stretchMax) {
    errors.push(`rubric: ${stretches} stretch criteria exceeds stretchMax ${budget.stretchMax}`);
  }

  if (hasEstimationPhase(seed.interviewPlan.phases)) {
    if (!criteria.some((c) => c.dimension === "capacityEstimation")) {
      errors.push(
        'rubric: plan has an estimation phase but no criterion targets dimension="capacityEstimation"'
      );
    }
  }

  // Playbook references must resolve, or `formatPlaybookBlock` emits an area
  // pointing at criteria that do not exist.
  for (const area of rubric.playbook.areasToProbe) {
    for (const ref of area.criterionRefs) {
      if (!ids.has(ref)) errors.push(`rubric.playbook.${area.id}: unknown criterionRef "${ref}"`);
    }
    for (const ref of area.phaseRefs) {
      if (!phaseIds.has(ref)) errors.push(`rubric.playbook.${area.id}: unknown phaseRef "${ref}"`);
    }
  }

  let previousHidden = -1;
  for (const level of INTERVIEWER_LEVEL_ORDER) {
    const hidden = hiddenCountAtLevel(rubric, level);

    if (hidden < budget.hiddenMin) {
      errors.push(
        `rubric at level "${level}": ${hidden} hidden criteria is below the ${seed.difficulty} discovery floor of ${budget.hiddenMin}`
      );
    }
    if (hidden < previousHidden) {
      errors.push(`rubric at level "${level}": hidden count went down as level rose`);
    }
    previousHidden = hidden;

    const hiddenCores = cores.filter((c) => isHiddenAtLevel(c, level)).length;
    if (hiddenCores > budget.hiddenCoreMax) {
      errors.push(
        `rubric at level "${level}": ${hiddenCores} hidden cores exceeds hiddenCoreMax ${budget.hiddenCoreMax}`
      );
    }
    // LEVEL_HIDDEN_GUIDANCE: standard allows at most one hidden core; staff
    // expects the bulk of cores hidden.
    if (level === "standard" && hiddenCores > 1) {
      errors.push(`rubric at level "standard": ${hiddenCores} hidden cores, guidance allows at most 1`);
    }
    if (level === "staff" && hiddenCores * 2 < cores.length) {
      errors.push(
        `rubric at level "staff": only ${hiddenCores} of ${cores.length} cores hidden, guidance expects the bulk of them`
      );
    }

    // Finally, the projection must be a legal InterviewRubric — that is the
    // shape the interview row actually stores.
    const projected = projectRubricForLevel(rubric, level as InterviewerLevel, new Date(0).toISOString());
    if (projected.criteria.length !== criteria.length) {
      errors.push(`rubric at level "${level}": projection lost a criterion`);
    }
  }

  return errors;
}
