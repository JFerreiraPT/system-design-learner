import type {
  InterviewerPlaybook,
  RubricCriterion,
  ScoreBand,
  ValidationDimensions
} from "@sdl/shared";
import { DEFAULT_SCORE_BAND_DESCRIPTIONS, scoreBandFor } from "@sdl/shared";

/** Relative weight of a criterion when computing weighted coverage. Also used
 * for the discovery score, so a missed `core` hidden costs more discovery than
 * a missed `stretch` one. */
export const IMPORTANCE_WEIGHT = { core: 3, expected: 2, stretch: 1 } as const;

/** Partial credit for a criterion the design did NOT cover.
 *
 * Severity is the validator's judgement of how badly it was missed, so a "low"
 * miss still earns most of the criterion's weight while a "high" miss earns
 * none. This replaces the old flat `100 - penalty` model, under which four
 * missed cores zeroed the score no matter how much else was covered. */
export const SEVERITY_CREDIT = { low: 0.5, medium: 0.25, high: 0 } as const;

/** Stretch criteria are bonus-only: missing one never costs points (they are
 * excluded from the denominator), covering one adds a small capped bonus. */
export const STRETCH_BONUS_PER_ITEM = 3;
export const STRETCH_BONUS_CAP = 6;

/** Which regime produced a `designScore`. See `ValidationFeedbackSchema`. */
export type ScoringMode = "rubric" | "dimensions";

export type CriterionEvaluationInput = {
  criterionId: string;
  covered: boolean;
  discovered: boolean;
  severity?: "high" | "medium" | "low";
  evidence?: string;
};

export type DesignScoreResult = {
  designScore: number;
  scoringMode: ScoringMode;
  /** IDs of `core` criteria the design covered. */
  coreCovered: string[];
  /** IDs of `core` criteria the design missed. */
  coreMissed: string[];
};

/** Mean of the non-null dimension bars.
 *
 * This is the FALLBACK scale, used only when there is no rubric to grade
 * against. It is not comparable with the rubric scale, which is why callers
 * persist `scoringMode` alongside the number. */
export function estimateScoreFromDimensions(
  dimensions: ValidationDimensions | undefined
): number {
  if (!dimensions) return 0;
  const values = Object.values(dimensions).filter(
    (v): v is number => typeof v === "number" && v !== null
  );
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Share of the *hidden* scope the candidate surfaced during the interview,
 * weighted by importance. 100 when there is nothing hidden to find. */
export function computeDiscoveryScore(criteria: RubricCriterion[] | null | undefined): number {
  if (!criteria?.length) return 100;
  const hiddens = criteria.filter((c) => c.visibility === "hidden");
  const totalHiddenWeight = hiddens.reduce((s, c) => s + IMPORTANCE_WEIGHT[c.importance], 0);
  if (totalHiddenWeight === 0) return 100;
  const discoveredHiddenWeight = hiddens
    .filter((c) => c.discoveredVia)
    .reduce((s, c) => s + IMPORTANCE_WEIGHT[c.importance], 0);
  return Math.round((discoveredHiddenWeight / totalHiddenWeight) * 100);
}

/**
 * Weighted coverage of the rubric.
 *
 * `designScore = 100 × (Σ weight × credit) / (Σ weight) + stretchBonus`
 *
 * Because it is a *ratio*, rubric size no longer changes what a given level of
 * performance scores: covering half the weight is 50 whether the rubric has 6
 * criteria or 14. Stretch criteria sit outside the ratio entirely — they can
 * only add.
 *
 * Falls back to the dimension mean when there is no rubric, when the validator
 * returned no per-criterion judgments, or when nothing gradeable survived
 * (e.g. an all-stretch rubric, or every evaluation naming an unknown id).
 */
export function computeDesignScore(input: {
  criteria: RubricCriterion[] | null | undefined;
  evaluations: CriterionEvaluationInput[] | null | undefined;
  dimensionEstimate: number;
}): DesignScoreResult {
  const { criteria, evaluations, dimensionEstimate } = input;

  if (!criteria?.length || !evaluations?.length) {
    return {
      designScore: dimensionEstimate,
      scoringMode: "dimensions",
      coreCovered: [],
      coreMissed: []
    };
  }

  const byId = new Map(criteria.map((c) => [c.id, c] as const));
  const coreCovered: string[] = [];
  const coreMissed: string[] = [];
  let earnedWeight = 0;
  let totalWeight = 0;
  let stretchCovered = 0;

  for (const ev of evaluations) {
    const criterion = byId.get(ev.criterionId);
    // The validator occasionally invents an id. Ignore rather than throw —
    // a hallucinated criterion must never move the score in either direction.
    if (!criterion) continue;

    if (criterion.importance === "stretch") {
      if (ev.covered) stretchCovered += 1;
      continue;
    }

    const weight = IMPORTANCE_WEIGHT[criterion.importance];
    totalWeight += weight;

    if (ev.covered) {
      earnedWeight += weight;
      if (criterion.importance === "core") coreCovered.push(criterion.id);
    } else {
      const severity =
        ev.severity ?? (criterion.importance === "core" ? ("high" as const) : ("medium" as const));
      earnedWeight += weight * SEVERITY_CREDIT[severity];
      if (criterion.importance === "core") coreMissed.push(criterion.id);
    }
  }

  if (totalWeight === 0) {
    return {
      designScore: dimensionEstimate,
      scoringMode: "dimensions",
      coreCovered,
      coreMissed
    };
  }

  const base = (earnedWeight / totalWeight) * 100;
  const bonus = Math.min(STRETCH_BONUS_CAP, stretchCovered * STRETCH_BONUS_PER_ITEM);
  const designScore = Math.max(0, Math.min(100, Math.round(base + bonus)));

  return { designScore, scoringMode: "rubric", coreCovered, coreMissed };
}

/** Overall = designScore × w + discoveryScore × (1 − w). */
export function blendScore(
  designScore: number,
  discoveryScore: number,
  designWeight: number
): number {
  return Math.round(designWeight * designScore + (1 - designWeight) * discoveryScore);
}

/**
 * Band the overall score on the 1-4 scale, preferring the interview
 * playbook's calibrated wording for that band.
 *
 * Always returns a band. A validation with no interview — or an interview
 * from before playbooks existed — still gets one, just with the generic
 * `DEFAULT_SCORE_BAND_DESCRIPTIONS` copy, so the callout is never empty.
 */
export function resolveScoreBand(
  score: number,
  playbook: InterviewerPlaybook | null | undefined
): { band: ScoreBand; label: string } {
  const band = scoreBandFor(score);
  const generated = playbook?.scoreRubric?.[String(band) as "1" | "2" | "3" | "4"];
  const label = generated?.trim() ? generated.trim() : DEFAULT_SCORE_BAND_DESCRIPTIONS[band];
  return { band, label };
}
