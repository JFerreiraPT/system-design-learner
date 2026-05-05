import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { generateObject, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import {
  buildCriteriaPrompt,
  buildDiscoveryMatchPrompt,
  buildInterviewerPrompt,
  buildProblemPrompt,
  buildReferenceSolutionPrompt,
  buildValidationPrompt,
  TAG_VOCABULARY_SNIPPET,
  tutorSystemPrompt
} from "@sdl/ai-prompts";
import type {
  Difficulty,
  InterviewerLevel,
  PhaseRuntimeInfo,
  RubricCriterion,
  SceneSummary
} from "@sdl/shared";
import {
  EstimationProblemSpecSchema,
  InterviewPlanSchema,
  RubricCriterionSchema
} from "@sdl/shared";

type WorkspaceContext = {
  problemId?: string;
  problemTitle?: string;
  problemStatement?: string;
  constraints?: string[];
  /** Compact scene projection (preferred over raw scene JSON). */
  sceneSummary?: SceneSummary;
  /** Optional PNG of the board (base64, no data: prefix). */
  imageBase64?: string;
  notes?: string;
  phase?: PhaseRuntimeInfo;
  estimation?: Record<string, unknown>;
  estimationChecklist?: {
    intro?: string;
    fields: Array<{ key: string; label: string; hint?: string }>;
  };
};

function formatSeconds(totalSec: number): string {
  const sign = totalSec < 0 ? "-" : "";
  const s = Math.abs(Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${sign}${m}m${r.toString().padStart(2, "0")}s`;
}

function formatPhaseLine(p: PhaseRuntimeInfo): string {
  const elapsed = formatSeconds(p.elapsedSec);
  const suggested = formatSeconds(p.durationSec);
  const ratio = p.elapsedSec / p.durationSec;
  let pace: string;
  if (ratio < 0.5) pace = "well within budget";
  else if (ratio <= 1) pace = `${Math.round(ratio * 100)}% of budget used`;
  else pace = `~${Math.round(ratio * 100)}% of budget — OVER suggested time, push toward closing this phase`;
  const running = p.running === false ? " (timer paused)" : "";
  return `Current phase: "${p.label}" (phase ${p.index + 1} of ${p.total}). Elapsed ${elapsed} of ~${suggested} suggested — ${pace}${running}.`;
}

/** Returns a compact text block describing the workspace, or empty string.
 * `includeProblem` controls whether the problem title/statement/constraints
 * are emitted (the interviewer already gets the statement via the system
 * prompt, the tutor doesn't, so this lets each caller opt in). */
function formatWorkspaceContextText(
  ctx: WorkspaceContext,
  includeScene: boolean,
  includeProblem: boolean
) {
  const lines: string[] = [];
  if (includeProblem) {
    if (ctx.problemTitle) lines.push(`Problem: ${ctx.problemTitle}`);
    if (ctx.problemStatement) lines.push(`Statement:\n${ctx.problemStatement}`);
  }
  // Constraints are emitted regardless of `includeProblem`, because in an
  // active interview they represent the LIVE scope (seeded from the problem,
  // mutated as the conversation evolves) — not static problem metadata.
  if (ctx.constraints && ctx.constraints.length > 0) {
    lines.push(
      `Current scope (live constraints — score and reason ONLY against these):\n${ctx.constraints
        .map((c) => `- ${c}`)
        .join("\n")}`
    );
  }
  if (ctx.phase) lines.push(formatPhaseLine(ctx.phase));
  if (ctx.notes) lines.push(`Candidate notes: ${ctx.notes}`);
  if (ctx.estimation && Object.keys(ctx.estimation).length > 0) {
    lines.push(`Candidate estimation: ${JSON.stringify(ctx.estimation)}`);
  }
  if (ctx.estimationChecklist) {
    const fields = ctx.estimationChecklist.fields
      .map((f) => `${f.key}=${f.label}${f.hint ? ` (${f.hint})` : ""}`)
      .join("; ");
    lines.push(`Estimation checklist fields: ${fields}`);
  }
  if (includeScene && ctx.sceneSummary) {
    const s = ctx.sceneSummary;
    if (s.summaryText) lines.push(`Whiteboard: ${s.summaryText}`);
    if (s.nodes.length > 0) {
      lines.push(
        `Whiteboard nodes: ${s.nodes
          .map((n) => `${n.id}=${n.label}${n.kind ? `[${n.kind}]` : ""}`)
          .join("; ")}`
      );
    }
    if (s.edges.length > 0) {
      lines.push(
        `Whiteboard edges: ${s.edges
          .map((e) => `${e.from}->${e.to}${e.label ? `(${e.label})` : ""}`)
          .join("; ")}`
      );
    }
  }
  return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

/** Compact scene projection → validator-facing text (replaces raw scene JSON). */
function formatSceneSummaryForValidation(summary: SceneSummary): string {
  const lines: string[] = [
    "Structured whiteboard projection (canonical graph — grade against this, not raw geometry JSON):"
  ];
  if (summary.summaryText) lines.push(summary.summaryText);
  if (summary.nodes.length > 0) {
    lines.push(
      `Nodes: ${summary.nodes.map((n) => `${n.id}=${n.label}${n.kind ? `[${n.kind}]` : ""}`).join("; ")}`
    );
  }
  if (summary.edges.length > 0) {
    lines.push(
      `Edges: ${summary.edges
        .map((e) => `${e.from}->${e.to}${e.label ? `(${e.label})` : ""}`)
        .join("; ")}`
    );
  }
  return lines.join("\n");
}

const GeneratedProblemSchema = z.object({
  title: z.string(),
  statement: z.string(),
  constraints: z.array(z.string()),
  tags: z.array(z.string()).min(2).max(5),
  estimationSpec: EstimationProblemSpecSchema,
  interviewPlan: InterviewPlanSchema
});

// Scores from the validator are nullable per dimension — see
// packages/shared ValidationDimensionsSchema for the contract.
const dimensionScore = z.number().min(0).max(100).nullable();
const ValidationDimensionsSchema = z.object({
  requirements: dimensionScore,
  scalability: dimensionScore,
  reliability: dimensionScore,
  consistency: dimensionScore,
  latencyPerformance: dimensionScore,
  cost: dimensionScore,
  security: dimensionScore,
  operability: dimensionScore
});

const CriterionEvaluationSchema = z.object({
  criterionId: z.string().min(1).max(120),
  covered: z.boolean(),
  discovered: z.boolean(),
  severity: z.enum(["high", "medium", "low"]).optional(),
  evidence: z.string().max(500).optional()
});

const ValidationSchema = z.object({
  dimensions: ValidationDimensionsSchema,
  dimensionNotes: z.record(z.string(), z.string()).optional(),
  criteriaEvaluations: z.array(CriterionEvaluationSchema).optional(),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
  nextSteps: z.array(z.string())
});

/** Stable structured-output settings for grading-related LLM calls. */
const GRADING_OBJECT_SETTINGS = { temperature: 0, seed: 42 } as const;

/** Lenient model-side schema. The strict `RubricCriterionSchema` is enforced
 * AFTER a server-side repair pass — gpt-4o-mini regularly emits one of:
 * - importance="hidden" / "critical" (conflating the two axes),
 * - dimension="performance" instead of "latencyPerformance",
 * - id with hyphens / capitals,
 * - hint strings over the 200-char cap.
 * Any of those would normally drop the whole rubric (criteria=null), so we
 * accept ANY string for the open-text fields and repair them in code. */
const LooseRubricCriterionSchema = z.object({
  id: z.string().min(1).max(200),
  text: z.string().min(2).max(1500),
  dimension: z.string().min(1).max(60),
  importance: z.string().min(1).max(60),
  visibility: z.string().min(1).max(60),
  discoveryHints: z.array(z.string()).max(12).optional(),
  satisfiedBy: z.array(z.string()).max(12).optional(),
  scaleNote: z.string().max(1000).optional()
});

const GeneratedCriteriaSchema = z.object({
  criteria: z.array(LooseRubricCriterionSchema).min(3).max(20)
});

const SCORE_DIMENSIONS = [
  "requirements",
  "scalability",
  "reliability",
  "consistency",
  "latencyPerformance",
  "cost",
  "security",
  "operability"
] as const;
type ScoreDim = (typeof SCORE_DIMENSIONS)[number];

const DIMENSION_ALIASES: Record<string, ScoreDim> = {
  requirements: "requirements",
  functional: "requirements",
  feature: "requirements",
  features: "requirements",
  scalability: "scalability",
  scale: "scalability",
  capacity: "scalability",
  throughput: "scalability",
  reliability: "reliability",
  availability: "reliability",
  durability: "reliability",
  consistency: "consistency",
  correctness: "consistency",
  isolation: "consistency",
  latencyperformance: "latencyPerformance",
  latency: "latencyPerformance",
  performance: "latencyPerformance",
  speed: "latencyPerformance",
  cost: "cost",
  efficiency: "cost",
  security: "security",
  privacy: "security",
  authn: "security",
  authz: "security",
  operability: "operability",
  observability: "operability",
  monitoring: "operability",
  ops: "operability",
  operations: "operability",
  maintainability: "operability"
};

/** Coerce a possibly-loose LLM criterion into the strict schema. Any
 * unrecoverable shape returns `null` and the caller drops the entry. */
function repairCriterion(
  raw: z.infer<typeof LooseRubricCriterionSchema>,
  index: number,
  used: Set<string>
): RubricCriterion | null {
  const importance: "core" | "expected" | "stretch" = (() => {
    const v = raw.importance.trim().toLowerCase();
    if (v === "core" || v === "expected" || v === "stretch") return v;
    if (v === "critical" || v === "required" || v === "must") return "core";
    if (v === "bonus" || v === "optional" || v === "nice-to-have") return "stretch";
    return "expected";
  })();

  const visibility: "visible" | "hidden" = (() => {
    const v = raw.visibility.trim().toLowerCase();
    if (v === "visible" || v === "hidden") return v;
    if (v === "shown" || v === "explicit" || v === "seed") return "visible";
    if (v === "latent" || v === "implicit" || v === "discovery") return "hidden";
    return "visible";
  })();

  const dimensionKey = raw.dimension.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const dimensionMatch = DIMENSION_ALIASES[dimensionKey];
  const dimension: ScoreDim = dimensionMatch
    ? dimensionMatch
    : (SCORE_DIMENSIONS as readonly string[]).includes(dimensionKey)
      ? (dimensionKey as ScoreDim)
      : "requirements";

  const baseSlug = raw.id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]/, "c_$&");
  let slug = baseSlug.length > 0 ? baseSlug.slice(0, 80) : `criterion_${index + 1}`;
  if (used.has(slug)) {
    let n = 2;
    while (used.has(`${slug}_${n}`) && n < 100) n += 1;
    slug = `${slug}_${n}`;
  }
  used.add(slug);

  const text = raw.text.trim().slice(0, 400);
  if (text.length < 4) return null;

  const truncStrings = (xs?: string[], maxLen = 200, maxCount = 4) =>
    xs && xs.length > 0
      ? xs.map((s) => s.trim().slice(0, maxLen)).filter((s) => s.length > 0).slice(0, maxCount)
      : undefined;

  const candidate = {
    id: slug,
    text,
    dimension,
    importance,
    visibility,
    discoveryHints: truncStrings(raw.discoveryHints),
    satisfiedBy: truncStrings(raw.satisfiedBy),
    scaleNote: raw.scaleNote ? raw.scaleNote.trim().slice(0, 300) : undefined
  };
  const parsed = RubricCriterionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

const DiscoveryMatchSchema = z.object({
  discoveries: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        kind: z.enum(["candidate", "interviewer"]),
        rationale: z.string().max(500).optional()
      })
    )
    .max(6)
});

const ReferenceSolutionSchema = z.object({
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

@Injectable()
export class AiService {
  private readonly openai;

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
    this.openai = createOpenAI({
      apiKey: this.configService.getOrThrow<string>("OPENAI_API_KEY")
    });
  }

  async generateProblem(input: {
    difficulty: Difficulty;
    topic?: string;
    existingProblems?: Array<{ title: string; tags: string[]; gist: string }>;
  }) {
    const result = await generateObject({
      model: this.openai("gpt-4o-mini"),
      schema: GeneratedProblemSchema,
      prompt: buildProblemPrompt(input.difficulty, input.topic, input.existingProblems)
    });

    return result.object;
  }

  async validateSolution(input: {
    difficulty: Difficulty;
    sceneSummary: SceneSummary;
    notes?: string;
    estimation?: Record<string, unknown>;
    constraints: string[];
    /** Structured criteria for THIS interview. When provided, drives both
     * importance-weighted scoring and the discovery subscore. */
    criteria?: RubricCriterion[];
    /** Free-text rubric for problems that predate criteria — soft guide only. */
    legacyRubric?: string[];
  }) {
    const estimationText =
      input.estimation && Object.keys(input.estimation).length > 0
        ? `\nCandidate back-of-envelope estimation (JSON):\n${JSON.stringify(input.estimation, null, 2)}`
        : "";
    const sortedCriteria = input.criteria
      ? [...input.criteria].sort((a, b) => a.id.localeCompare(b.id))
      : undefined;

    const promptText = buildValidationPrompt(input.difficulty, estimationText, {
      constraints: input.constraints,
      criteria: sortedCriteria,
      legacyRubric: input.legacyRubric
    });

    const contentParts: Array<{ type: "text"; text: string }> = [
      { type: "text", text: promptText },
      { type: "text", text: formatSceneSummaryForValidation(input.sceneSummary) },
      { type: "text", text: `Candidate notes:\n${input.notes ?? ""}` }
    ];

    const result = await generateObject({
      model: this.openai("gpt-4o"),
      schema: ValidationSchema,
      messages: [{ role: "user", content: contentParts }],
      ...GRADING_OBJECT_SETTINGS
    });

    return result.object;
  }

  /** Generate the per-interview rubric. Called once at interview start (and
   * again on explicit regenerate). Failures throw — caller decides whether
   * to degrade gracefully (interview keeps running with criteria=null). */
  async generateCriteria(input: {
    difficulty: Difficulty;
    interviewerLevel: InterviewerLevel;
    title: string;
    statement: string;
    seedConstraints: string[];
    existingCriteria?: Array<{
      id: string;
      text: string;
      visibility: "visible" | "hidden";
      importance: "core" | "expected" | "stretch";
    }>;
    /** If set, prepended to the prompt as a hard correction (used by the
     * server-side retry when the first attempt produced too few hiddens). */
    regenerationReason?: string;
  }): Promise<RubricCriterion[]> {
    const prompt = buildCriteriaPrompt({
      difficulty: input.difficulty,
      interviewerLevel: input.interviewerLevel,
      title: input.title,
      statement: input.statement,
      seedConstraints: input.seedConstraints,
      existingCriteria: input.existingCriteria,
      regenerationReason: input.regenerationReason
    });

    // Retry once on stochastic schema failure. Even with a fully-loose
    // model-side schema, gpt-4o-mini occasionally emits malformed JSON or
    // omits required fields entirely. A single re-roll fixes ~all of those.
    const callModel = () =>
      generateObject({
        model: this.openai("gpt-4o-mini"),
        schema: GeneratedCriteriaSchema,
        prompt
      });

    let result;
    try {
      result = await callModel();
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "AI_NoObjectGeneratedError" || name === "AI_TypeValidationError") {
        result = await callModel();
      } else {
        throw err;
      }
    }

    const used = new Set<string>();
    const repaired = result.object.criteria
      .map((c, i) => repairCriterion(c, i, used))
      .filter((c): c is RubricCriterion => c !== null);
    if (repaired.length === 0) {
      throw new Error(
        "generateCriteria: every emitted criterion failed strict validation after repair"
      );
    }
    return repaired;
  }

  /** After each interview turn, detect which undiscovered hidden criteria
   * the latest exchange surfaced. Conservative — empty `discoveries` is the
   * common case. Failures swallow and return `[]` so they never break the
   * chat turn. */
  async matchCriteriaDiscovery(input: {
    problemTitle: string;
    problemStatement: string;
    undiscovered: Array<Pick<RubricCriterion, "id" | "text" | "discoveryHints">>;
    lastUserMessage: string;
    lastAssistantMessage: string;
  }): Promise<Array<{ id: string; kind: "candidate" | "interviewer"; rationale?: string }>> {
    if (input.undiscovered.length === 0) return [];
    try {
      const result = await generateObject({
        model: this.openai("gpt-4o-mini"),
        schema: DiscoveryMatchSchema,
        prompt: buildDiscoveryMatchPrompt(input),
        ...GRADING_OBJECT_SETTINGS
      });
      const valid = new Set(input.undiscovered.map((c) => c.id));
      return result.object.discoveries.filter((d) => valid.has(d.id));
    } catch {
      return [];
    }
  }

  async generateReference(input: {
    title: string;
    statement: string;
    difficulty: Difficulty;
    constraints: string[];
  }) {
    const result = await generateObject({
      model: this.openai("gpt-4o"),
      schema: ReferenceSolutionSchema,
      prompt: buildReferenceSolutionPrompt(input)
    });
    return result.object;
  }

  async inferTags(input: { title: string; statement: string; difficulty: Difficulty }) {
    const TagOnlySchema = z.object({ tags: z.array(z.string()).min(2).max(5) });
    const result = await generateObject({
      model: this.openai("gpt-4o-mini"),
      schema: TagOnlySchema,
      prompt: `Given this system design problem, assign 2-5 tags.
${TAG_VOCABULARY_SNIPPET}

Title: ${input.title}
Difficulty: ${input.difficulty}
Statement:
${input.statement}`
    });
    return result.object.tags;
  }

  async inferEstimationSpec(input: {
    title: string;
    statement: string;
    difficulty: Difficulty;
    constraints: string[];
  }) {
    const constraintsBlock = input.constraints.map((c) => "- " + c).join("\n");
    const result = await generateObject({
      model: this.openai("gpt-4o-mini"),
      schema: EstimationProblemSpecSchema,
      prompt: [
        "You tailor back-of-envelope estimation checklists for system design interviews.",
        `Difficulty: ${input.difficulty}`,
        `Title: ${input.title}`,
        "Statement:",
        input.statement,
        "",
        "Constraints:",
        constraintsBlock,
        "",
        "Return JSON with intro (optional), fields (4-10), derivedHints (3-6):",
        "- fields: key snake_case, label, type number|text, optional placeholder/hint/unit",
        "- derivedHints: sanity-check bullets for magnitudes from those fields"
      ].join("\n")
    });
    return result.object;
  }

  /** After the interviewer's streamed reply, derive a small set of proposals
   * to mutate the live constraint set. We run a separate, cheap, structured
   * call (gpt-4o-mini) so the streamed reply stays plain text and parsing
   * doesn't depend on the model formatting a sidecar block correctly. The
   * candidate confirms each proposal before it takes effect.
   *
   * Heuristics encoded in the prompt:
   * - Only propose ADD when the latest assistant turn made an explicit product
   *   commitment ("yes, single-user; no boards in v1; ~10K DAU") that isn't
   *   already covered by an active constraint.
   * - Only propose REMOVE when the conversation has scoped a constraint out
   *   ("we won't worry about offline mode for v1") and a current active
   *   constraint clearly maps to it.
   * - Conservative by default: empty proposals are fine and preferred over
   *   noisy ones. */
  async extractConstraintProposals(input: {
    problemTitle: string;
    problemStatement: string;
    activeConstraints: Array<{ id: string; text: string }>;
    lastUserMessage: string;
    lastAssistantMessage: string;
  }): Promise<Array<{ kind: "add"; text: string; rationale?: string } | { kind: "remove"; targetConstraintId: string; rationale?: string }>> {
    const ProposalSchema = z.object({
      proposals: z
        .array(
          z.discriminatedUnion("kind", [
            z.object({
              kind: z.literal("add"),
              text: z.string().min(2).max(500),
              rationale: z.string().max(500).optional()
            }),
            z.object({
              kind: z.literal("remove"),
              targetConstraintId: z.string().min(1),
              rationale: z.string().max(500).optional()
            })
          ])
        )
        .max(4)
    });

    const activeBlock =
      input.activeConstraints.length > 0
        ? input.activeConstraints
            .map((c) => `- id=${c.id} :: ${c.text}`)
            .join("\n")
        : "(none)";

    try {
      const result = await generateObject({
        model: this.openai("gpt-4o-mini"),
        schema: ProposalSchema,
        ...GRADING_OBJECT_SETTINGS,
        prompt: [
          "You watch a system-design interview and extract proposed updates to the SCOPE/CONSTRAINT list.",
          "Be conservative — empty `proposals` is the right answer most of the time.",
          "",
          "Propose ADD when the last interviewer turn committed to a v1 product decision that ISN'T already covered by an active constraint (e.g. 'flat task list, no boards', '~10K DAU peak', 'mobile-only client').",
          "Propose REMOVE when the conversation explicitly scopes out an existing active constraint (e.g. 'let's drop offline mode for v1'). Use that constraint's id verbatim.",
          "",
          "DO NOT propose:",
          "- Restating something already in the active list.",
          "- Generic best practices ('add monitoring', 'pick a database') that the candidate hasn't been told.",
          "- Anything not actually said in the latest two turns.",
          "",
          `Problem: ${input.problemTitle}`,
          `Statement: ${input.problemStatement}`,
          "",
          "Active constraints (id :: text):",
          activeBlock,
          "",
          "Latest candidate turn:",
          input.lastUserMessage,
          "",
          "Latest interviewer turn:",
          input.lastAssistantMessage,
          "",
          "Return JSON: { proposals: Array<{ kind: 'add', text, rationale? } | { kind: 'remove', targetConstraintId, rationale? }> }",
          "Rationale: one short sentence pointing at the exact phrase from the latest turn."
        ].join("\n")
      });
      return result.object.proposals;
    } catch {
      // Proposal extraction is best-effort. Never let it break the chat turn.
      return [];
    }
  }

  async inferInterviewPlan(input: {
    title: string;
    statement: string;
    difficulty: Difficulty;
    constraints: string[];
  }) {
    const constraintsBlock = input.constraints.map((c) => "- " + c).join("\n");
    const result = await generateObject({
      model: this.openai("gpt-4o-mini"),
      schema: InterviewPlanSchema,
      prompt: [
        "Design an interview phase plan for THIS system design question only.",
        `Difficulty: ${input.difficulty}`,
        `Title: ${input.title}`,
        "Statement:",
        input.statement,
        "",
        "Constraints:",
        constraintsBlock,
        "",
        "Return JSON:",
        "- intro (optional): how you tailored the flow to this problem",
        "- phases: 3-8 ordered steps. Each: id (snake_case), label (short), durationSec (60-3600, sum roughly match typical interview length for difficulty), candidateGuide (markdown-lite: goals + which tabs/board/Validate to use)",
        "Skip or merge generic phases that do not apply (e.g. no separate API phase for purely batch/analytics if irrelevant)."
      ].join("\n")
    });
    return result.object;
  }

  streamInterviewer(args: {
    interviewerLevel: InterviewerLevel;
    problemStatement: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
    message: string;
    workspaceContext?: WorkspaceContext;
    /** When true, the scene hasn't changed since the previous turn so we omit
     * the bulky whiteboard description and image to save tokens. */
    sceneUnchanged?: boolean;
    /** Per-interview criteria used to coach (per-level rules) and to anchor
     * probes on undiscovered hiddens. Optional for legacy interviews. */
    criteria?: RubricCriterion[];
    /** IDs of criteria already discovered; the prompt only nudges toward
     * the complement of this set. */
    discoveredCriterionIds?: string[];
  }) {
    const ctx = args.workspaceContext;
    const includeScene = Boolean(ctx) && !args.sceneUnchanged;
    // Interviewer already gets `problemStatement` injected separately into
    // the system prompt, so we omit problem text here to avoid duplication.
    const contextText = ctx
      ? formatWorkspaceContextText(ctx, includeScene, /* includeProblem */ false)
      : "";

    const userContent = this.buildMultimodalUserContent(
      args.message,
      includeScene ? ctx?.imageBase64 : undefined
    );

    const systemPrompt = buildInterviewerPrompt(args.interviewerLevel, {
      criteria: args.criteria,
      discoveredCriterionIds: args.discoveredCriterionIds
    });

    return streamText({
      model: this.openai("gpt-4o"),
      system: `${systemPrompt}\nProblem:\n${args.problemStatement}${contextText}`,
      messages: [...args.history, { role: "user", content: userContent }]
    });
  }

  streamTutor(args: {
    history: Array<{ role: "user" | "assistant"; content: string }>;
    message: string;
    workspaceContext?: WorkspaceContext;
    sceneUnchanged?: boolean;
  }) {
    const ctx = args.workspaceContext;
    const includeScene = Boolean(ctx) && !args.sceneUnchanged;
    // Tutor's system prompt is generic; it needs the problem details from
    // workspaceContext so it can actually answer questions about it.
    const contextText = ctx
      ? formatWorkspaceContextText(ctx, includeScene, /* includeProblem */ true)
      : "";

    const userContent = this.buildMultimodalUserContent(
      args.message,
      includeScene ? ctx?.imageBase64 : undefined
    );

    // gpt-4o-mini is multimodal too and ~10x cheaper than gpt-4o; the tutor
    // is the lower-stakes surface, so we keep mini and just add the image.
    return streamText({
      model: this.openai("gpt-4o-mini"),
      system: `${tutorSystemPrompt}${contextText}`,
      messages: [...args.history, { role: "user", content: userContent }]
    });
  }

  private buildMultimodalUserContent(message: string, imageBase64?: string) {
    if (!imageBase64) return message;
    return [
      { type: "text" as const, text: message },
      {
        type: "image" as const,
        image: `data:image/png;base64,${imageBase64}`
      }
    ];
  }
}
