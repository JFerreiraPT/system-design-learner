import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  Difficulty,
  InterviewerPlaybook,
  LiveConstraint,
  RubricCriterion,
  ValidationDimensions
} from "@sdl/shared";
import { getRubricCriteria, getRubricPlaybook, projectSceneJson } from "@sdl/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { AiService } from "../ai/ai.service.js";
import { DB } from "../db/db.module.js";
import { interviewMessages, interviews, problems, solutions } from "../db/schema.js";
import { buildEstimationDigest } from "./estimationDigest.js";
import { sanitizeFlagObservations } from "./flagObservations.js";
import {
  blendScore,
  computeDesignScore,
  computeDiscoveryScore,
  estimateScoreFromDimensions,
  resolveScoreBand
} from "./scoring.js";

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
  operability: 5,
  capacityEstimation: 5
} as const satisfies ValidationDimensions;

/** Default blend used when computing the overall score from designScore +
 * discoveryScore. Tunable via env so we can recalibrate without a redeploy
 * once we have feel for the scoring. */
const DEFAULT_DESIGN_WEIGHT = 0.7;

/** Hard cap keeps validation prompts inside practical context limits. */
const MAX_INTERVIEW_TRANSCRIPT_CHARS = 120_000;

function formatInterviewTranscript(
  rows: Array<{ role: string; content: string }>
): string {
  const parts: string[] = [];
  for (const m of rows) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const label = m.role === "user" ? "Candidate" : "Interviewer";
    parts.push(`[${label}]\n${m.content.trim()}`);
  }
  return parts.join("\n\n---\n\n");
}

function truncateInterviewTranscript(text: string): string {
  const t = text.trim();
  if (t.length === 0) return "";
  if (t.length <= MAX_INTERVIEW_TRANSCRIPT_CHARS) return t;
  const omitted = t.length - MAX_INTERVIEW_TRANSCRIPT_CHARS;
  return (
    `[Earlier transcript truncated (~${omitted} characters omitted)]\n\n` +
    t.slice(-MAX_INTERVIEW_TRANSCRIPT_CHARS)
  );
}

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
  flagObservations?: Array<{
    areaId: string;
    kind: "green" | "red";
    index: number;
    text?: string;
    fired: boolean;
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
  /** When validating with an interview, transcript text included in grading. */
  interviewTranscript: string | null;
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
    difficulty: input.difficulty,
    interviewTranscript: input.interviewTranscript
  });

  return createHash("sha1").update(JSON.stringify(payload)).digest("hex");
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
    let playbook: InterviewerPlaybook | null = null;
    let interviewTranscript: string | null = null;

    if (input.interviewId) {
      const interviewRows = await this.db
        .select()
        .from(interviews)
        .where(eq(interviews.id, input.interviewId));
      const interview = interviewRows[0];
      if (!interview) throw new NotFoundException("Interview not found");
      if (interview.problemId !== input.problemId) {
        throw new BadRequestException("Interview does not belong to this problem");
      }

      const live = (interview.liveConstraintsJson as LiveConstraint[] | null) ?? null;
      if (live) {
        scoringConstraints = live.filter((c) => c.status === "active").map((c) => c.text);
      }
      criteria = getRubricCriteria(interview.criteriaJson);
      playbook = getRubricPlaybook(interview.criteriaJson);

      const msgRows = await this.db
        .select({
          role: interviewMessages.role,
          content: interviewMessages.content
        })
        .from(interviewMessages)
        .where(eq(interviewMessages.interviewId, input.interviewId))
        .orderBy(asc(interviewMessages.createdAt));

      const rawTx = formatInterviewTranscript(msgRows);
      const clipped = truncateInterviewTranscript(rawTx);
      interviewTranscript = clipped.length > 0 ? clipped : null;
    }

    const sceneSummary = projectSceneJson(input.sceneJson);
    const estimationNorm =
      input.estimation && Object.keys(input.estimation).length > 0 ? input.estimation : null;

    const inputHash = computeSolutionInputHash({
      sceneSummary,
      activeConstraints: scoringConstraints,
      criteria,
      estimation: estimationNorm,
      difficulty: problem.difficulty,
      interviewTranscript
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
          legacyRubric: criteria ? undefined : (problem.evaluationRubricJson ?? []),
          interviewTranscript: interviewTranscript ?? undefined,
          playbook: playbook ?? undefined,
          estimationDigest: buildEstimationDigest({
            estimationSpecJson: problem.estimationSpecJson,
            estimation: estimationNorm
          })
        });

    const evaluation = this.computeServerScores(rawEvaluation, criteria, playbook);

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
   * judgments (deterministic — the model is explicitly told not to score).
   *
   * `designScore` is a weighted COVERAGE RATIO, not a penalty subtraction, so
   * a rubric with 14 criteria and one with 6 grade on the same scale. See
   * `./scoring.js` for the formula and the partial-credit table.
   */
  private computeServerScores(
    raw: ValidatorLlmOutput & { score?: number; designScore?: number; discoveryScore?: number },
    criteria: RubricCriterion[] | null,
    playbook: InterviewerPlaybook | null = null
  ) {
    const dimensionEstimate = estimateScoreFromDimensions(raw.dimensions);
    const discoveryScore = computeDiscoveryScore(criteria);

    const { designScore, scoringMode, coreCovered, coreMissed } = computeDesignScore({
      criteria,
      evaluations: raw.criteriaEvaluations,
      dimensionEstimate
    });

    // Stub evaluations (empty scene, unparseable model output) carry their own
    // authoritative `score` — an empty board is a 0 regardless of what the
    // placeholder dimension bars would average out to. Only the fallback path
    // can produce one; the rubric path never sets `raw.score`.
    const score =
      scoringMode === "dimensions" && typeof raw.score === "number"
        ? raw.score
        : blendScore(designScore, discoveryScore, this.designWeight);

    // Flags are descriptive only: they are resolved against the stored
    // playbook and reported, but never fold into any of the numbers above.
    const flagObservations = sanitizeFlagObservations(raw.flagObservations, playbook);

    return {
      ...raw,
      designScore,
      discoveryScore,
      scoringMode,
      score,
      scoreBand: resolveScoreBand(score, playbook),
      coreCovered,
      coreMissed,
      flagObservations
    };
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
    interviewTranscript?: string;
    playbook?: InterviewerPlaybook;
    estimationDigest?: string;
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
