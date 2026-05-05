import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Difficulty, LiveConstraint, RubricCriterion } from "@sdl/shared";
import { asc, desc, eq } from "drizzle-orm";
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
} as const;

/** Default blend used when computing the overall score from designScore +
 * discoveryScore. Tunable via env so we can recalibrate without a redeploy
 * once we have feel for the scoring. */
const DEFAULT_DESIGN_WEIGHT = 0.7;

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
    imageBase64?: string;
    estimation?: Record<string, unknown>;
    interviewId?: string;
  }) {
    const problemRows = await this.db.select().from(problems).where(eq(problems.id, input.problemId));
    const problem = problemRows[0];
    if (!problem) throw new NotFoundException("Problem not found");

    // Resolve scope sources for this validation:
    //  - constraints: the live active set if there's an interview, else the
    //    seed problem constraints (mirrors prior behavior).
    //  - criteria: the per-interview rubric (when present); the validator
    //    grades importance-weighted against this.
    //  - legacyRubric: only used when criteria is null (old problems with
    //    free-text rubric strings persisted on `problems.evaluation_rubric_json`).
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

    const isEmptyScene = this.isSceneEmpty(input.sceneJson);

    const rawEvaluation = isEmptyScene
      ? this.emptySceneEvaluation()
      : await this.safeAiEvaluation({
          difficulty: problem.difficulty,
          sceneJson: input.sceneJson,
          notes: input.notes,
          imageBase64: input.imageBase64,
          estimation: input.estimation,
          constraints: scoringConstraints,
          criteria: criteria ?? undefined,
          legacyRubric: criteria ? undefined : (problem.evaluationRubricJson ?? [])
        });

    // The model produces `score`, `designScore`, `discoveryScore` itself, but
    // we re-blend the overall on the server with our configured weight so
    // operators can tune the formula without prompt changes. If the model
    // omitted subscores (legacy path with no criteria), fall back to its
    // `score` directly.
    const evaluation = this.applyServerBlend(rawEvaluation);

    // We pass the PNG to the AI for multimodal validation but no longer
    // persist it: every save would otherwise write hundreds of KB to a `text`
    // column. The diagram can always be re-rendered from `scene_json`.
    const inserted = await this.db
      .insert(solutions)
      .values({
        problemId: input.problemId,
        sceneJson: input.sceneJson,
        notes: input.notes,
        score: evaluation.score,
        feedbackJson: evaluation as Record<string, unknown>,
        estimationJson: input.estimation ?? null
      })
      .returning();

    return inserted[0];
  }

  /** Re-blend the overall score from designScore × w + discoveryScore × (1-w)
   * when both are present. Keeps `designScore` / `discoveryScore` intact so
   * the UI can show subscores. Falls through unchanged when subscores are
   * missing (legacy path or stub evaluations). */
  private applyServerBlend<T extends { score?: number; designScore?: number; discoveryScore?: number }>(
    evaluation: T
  ): T {
    if (
      typeof evaluation.designScore !== "number" ||
      typeof evaluation.discoveryScore !== "number"
    ) {
      return evaluation;
    }
    const blended =
      evaluation.designScore * this.designWeight +
      evaluation.discoveryScore * (1 - this.designWeight);
    return { ...evaluation, score: Math.round(blended) };
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

  private emptySceneEvaluation() {
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
    sceneJson: string;
    notes?: string;
    imageBase64?: string;
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
