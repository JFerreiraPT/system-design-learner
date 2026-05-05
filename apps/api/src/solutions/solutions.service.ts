import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Difficulty, LiveConstraint, RubricCriterion, ValidationDimensions } from "@sdl/shared";
import { projectSceneJson } from "@sdl/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { AiService } from "../ai/ai.service.js";
import { DB } from "../db/db.module.js";
import { interviews, problems, solutions } from "../db/schema.js";

/** Default 0-100 dimension scores used in stub/empty/error evaluations. We
 * use a low-but-not-null value (5) so the bar still renders, signalling
 * "we tried but the diagram had nothing to grade". */
const DEFAULT_DIMENSIONS = {
  requirements: 5,
  scalability: 5,
  reliability: 5,
  consistency: 5,
  latencyPerformance: 5,
  cost: 5,
  security: 5,
  operability: 5
} as const satisfies ValidationDimensions;

/** Default blend used when computing the overall score from designScore +
 * discoveryScore. Tunable via env so we can recalibrate without a redeploy
 * once we have feel for the scoring. */
const DEFAULT_DESIGN_WEIGHT = 0.7;

const SEVERITY_PENALTY = { high: 25, medium: 10, low: 0 } as const;

const IMPORTANCE_WEIGHT = { core: 3, expected: 2, stretch: 1 } as const;

type ValidatorLlmOutput = {
  dimensions: ValidationDimensions;
  dimensionNotes?: Record<string, string>;
  criteriaEvaluations?: Array<{
    criterionId: string;
    covered: boolean;
    discovered: boolean;
    severity?: "high" | "medium" | "low";
    evidence?: string;
  }>;
  strengths: string[];
  gaps: string[];
  nextSteps: string[];
};

/** Recursive JSON canonicalisation for stable SHA1 hashes (sorted object keys). */
function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    out[k] = canonicalizeValue(v);
  }
  return out;
}

function computeSolutionInputHash(input: {
  sceneSummary: ReturnType<typeof projectSceneJson>;
  activeConstraints: string[];
  criteria: RubricCriterion[] | null;
  estimation: Record<string, unknown> | null;
  difficulty: string;
}): string {
  const sortedCriteria =
    input.criteria === null ?
      null
    : [...input.criteria].sort((a, b) => a.id.localeCompare(b.id));

  const payload = canonicalizeValue({
    sceneSummary: input.sceneSummary,
    activeConstraints: [...input.activeConstraints].sort((a, b) => a.localeCompare(b)),
    criteria: sortedCriteria,
    estimation: input.estimation,
    difficulty: input.difficulty
  });

  return createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

function estimateScoreFromDimensions(dimensions: ValidationDimensions | undefined): number {
  if (!dimensions) return 0;
  const values = Object.values(dimensions).filter(
    (v): v is number => typeof v === "number" && v !== null
  );
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

@Injectable()
export class SolutionsService {
  private readonly designWeight: number;

  constructor(
    @Inject(DB) private readonly db: any,
    @Inject(AiService) private readonly aiService: AiService,
    @Inject(ConfigService) configService: ConfigService
  ) {
    const raw = configService.get<string>("SCORING_DESIGN_WEIGHT");
    const parsed = raw ? Number(raw) : NaN;
    this.designWeight =
      Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_DESIGN_WEIGHT;
  }

  async validate(input: {
    problemId: string;
    sceneJson: string;
    notes?: string;
    estimation?: Record<string, unknown>;
    interviewId?: string;
  }) {
    const problemRows = await this.db.select().from(problems).where(eq(problems.id, input.problemId));
    const problem = problemRows[0];
    if (!problem) throw new NotFoundException("Problem not found");

    let scoringConstraints: string[] = problem.constraintsJson ?? [];
    let criteria: RubricCriterion[] | null = null;
    if (input.interviewId) {
      const interviewRows = await this.db
        .select()
        .from(interviews)
        .where(eq(interviews.id, input.interviewId));
      const interview = interviewRows[0];
      const live = (interview?.liveConstraintsJson as LiveConstraint[] | null) ?? null;
      if (live) {
        scoringConstraints = live.filter((c) => c.status === "active").map((c) => c.text);
      }
      criteria = (interview?.criteriaJson as RubricCriterion[] | null) ?? null;
    }

    const sceneSummary = projectSceneJson(input.sceneJson);
    const estimationNorm =
      input.estimation && Object.keys(input.estimation).length > 0 ? input.estimation : null;

    const inputHash = computeSolutionInputHash({
      sceneSummary,
      activeConstraints: scoringConstraints,
      criteria,
      estimation: estimationNorm,
      difficulty: problem.difficulty
    });

    const cachedRows = await this.db
      .select()
      .from(solutions)
      .where(and(eq(solutions.problemId, input.problemId), eq(solutions.inputHash, inputHash)))
      .orderBy(desc(solutions.createdAt))
      .limit(1);

    if (cachedRows.length > 0) {
      return cachedRows[0];
    }

    const isEmptyScene = this.isSceneEmpty(input.sceneJson);

    const rawEvaluation = isEmptyScene
      ? this.emptySceneEvaluation()
      : await this.safeAiEvaluation({
          difficulty: problem.difficulty as Difficulty,
          sceneSummary,
          notes: input.notes,
          estimation: input.estimation,
          constraints: scoringConstraints,
          criteria: criteria ?? undefined,
          legacyRubric: criteria ? undefined : (problem.evaluationRubricJson ?? [])
        });

    const evaluation = this.computeServerScores(rawEvaluation, criteria);

    const inserted = await this.db
      .insert(solutions)
      .values({
        problemId: input.problemId,
        sceneJson: input.sceneJson,
        notes: input.notes,
        score: evaluation.score,
        feedbackJson: evaluation as Record<string, unknown>,
        estimationJson: input.estimation ?? null,
        inputHash
      })
      .returning();

    return inserted[0];
  }

  /**
   * Derives numeric scores and core coverage lists from per-criterion LLM
   * judgments (deterministic).
   */
  private computeServerScores(
    raw: ValidatorLlmOutput & { score?: number; designScore?: number; discoveryScore?: number },
    criteria: RubricCriterion[] | null
  ) {
    const est = estimateScoreFromDimensions(raw.dimensions);

    if (!criteria?.length || !raw.criteriaEvaluations?.length) {
      const discoveryScore =
        criteria?.length ?
          (() => {
            const hiddens = criteria.filter((c) => c.visibility === "hidden");
            const totalHiddenWeight = hiddens.reduce(
              (s, c) => s + IMPORTANCE_WEIGHT[c.importance],
              0
            );
            if (totalHiddenWeight === 0) return 100;
            const discoveredHiddenWeight = hiddens
              .filter((c) => c.discoveredVia)
              .reduce((s, c) => s + IMPORTANCE_WEIGHT[c.importance], 0);
            return Math.round((discoveredHiddenWeight / totalHiddenWeight) * 100);
          })()
        : 100;

      const designScore = est;

      const score =
        typeof raw.score === "number"
          ? raw.score
          : Math.round(this.designWeight * designScore + (1 - this.designWeight) * discoveryScore);

      return {
        ...raw,
        designScore,
        discoveryScore,
        score,
        coreCovered: [] as string[],
        coreMissed: [] as string[]
      };
    }

    const byId = new Map(criteria.map((c) => [c.id, c]));
    let designPenalty = 0;
    const coreCovered: string[] = [];
    const coreMissed: string[] = [];

    for (const ev of raw.criteriaEvaluations) {
      const c = byId.get(ev.criterionId);
      if (!c) continue;
      if (!ev.covered) {
        // Stretch criteria are bonus-only — never penalise design score for missing them.
        if (c.importance === "stretch") continue;
        const severity =
          ev.severity ?? (c.importance === "core" ? ("high" as const) : ("medium" as const));
        designPenalty += SEVERITY_PENALTY[severity];
        if (c.importance === "core") coreMissed.push(c.id);
      } else if (c.importance === "core") {
        coreCovered.push(c.id);
      }
    }

    const designScore = Math.max(0, 100 - designPenalty);

    const hiddens = criteria.filter((c) => c.visibility === "hidden");
    const totalHiddenWeight = hiddens.reduce((s, c) => s + IMPORTANCE_WEIGHT[c.importance], 0);
    const discoveredHiddenWeight = hiddens
      .filter((c) => c.discoveredVia)
      .reduce((s, c) => s + IMPORTANCE_WEIGHT[c.importance], 0);
    const discoveryScore =
      totalHiddenWeight === 0 ? 100 : Math.round((discoveredHiddenWeight / totalHiddenWeight) * 100);

    const score = Math.round(this.designWeight * designScore + (1 - this.designWeight) * discoveryScore);

    return { ...raw, designScore, discoveryScore, score, coreCovered, coreMissed };
  }

  async listByProblem(problemId: string) {
    return this.db
      .select()
      .from(solutions)
      .where(eq(solutions.problemId, problemId))
      .orderBy(asc(solutions.createdAt));
  }

  async listAll(limit: number, offset: number) {
    const l = Math.min(Math.max(limit, 1), 500);
    const o = Math.max(offset, 0);
    return this.db
      .select()
      .from(solutions)
      .orderBy(desc(solutions.createdAt))
      .limit(l)
      .offset(o);
  }

  private isSceneEmpty(sceneJson: string) {
    try {
      const parsed = JSON.parse(sceneJson) as { elements?: Array<unknown> };
      return !parsed.elements || parsed.elements.length === 0;
    } catch {
      return false;
    }
  }

  private emptySceneEvaluation(): ValidatorLlmOutput & { score: number } {
    return {
      score: 0,
      dimensions: { ...DEFAULT_DIMENSIONS },
      strengths: ["You triggered validation, which is a good workflow habit."],
      gaps: ["(requirements) No diagram elements found in the current solution."],
      nextSteps: [
        "Add at least a high-level architecture with client, API layer, storage, and core services.",
        "Label key data flow paths (write/read) and explain trade-offs.",
        "Re-run validation after adding core components."
      ]
    };
  }

  private async safeAiEvaluation(input: {
    difficulty: Difficulty;
    sceneSummary: ReturnType<typeof projectSceneJson>;
    notes?: string;
    estimation?: Record<string, unknown>;
    constraints: string[];
    criteria?: RubricCriterion[];
    legacyRubric?: string[];
  }) {
    try {
      return await this.aiService.validateSolution(input);
    } catch {
      return {
        score: 20,
        dimensions: { ...DEFAULT_DIMENSIONS },
        strengths: ["Partial solution content detected."],
        gaps: ["(operability) Validation model output was not parseable for strict JSON scoring."],
        nextSteps: [
          "Keep iterating on the diagram and validate again.",
          "Ensure major components and data paths are explicitly represented."
        ]
      };
    }
  }
}
