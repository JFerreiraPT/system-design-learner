import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { generateObject, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import {
  buildCriteriaPrompt,
  buildDebriefPrompt,
  buildDiscoveryMatchPrompt,
  buildInterviewerPrompt,
  buildProblemNarrativePrompt,
  buildProblemPrompt,
  buildReferenceSolutionPrompt,
  buildValidationPrompt,
  ESTIMATION_DERIVED_FORMULA_RULES,
  ESTIMATION_FIELD_RULES,
  TAG_VOCABULARY_SNIPPET,
  tutorSystemPrompt
} from "@sdl/ai-prompts";
import type { DebriefEvidence } from "@sdl/ai-prompts";
import type {
  Difficulty,
  InterviewDebrief,
  InterviewerPlaybook,
  InterviewRubric,
  InterviewerLevel,
  PhaseRuntimeInfo,
  PhaseTimeline,
  ProblemNarrative,
  ProcessAssessment,
  RubricCriterion,
  SceneSummary,
  Track
} from "@sdl/shared";
import {
  EstimationProblemSpecSchema,
  getProblemNarrative,
  getTrack,
  TrackSchema,
  InterviewerPlaybookSchema,
  InterviewPlanSchema,
  normalizeEstimationSpec,
  RubricCriterionSchema
} from "@sdl/shared";
import {
  resolveAiModels,
  resolveVoiceLanguages,
  resolveVoiceMaxResponseTokens,
  resolveVoiceName,
  resolveVoiceReasoningEffort,
  VOICE_SAMPLE_RATE,
  type AiModels,
  type VoiceTurnDetectionConfig
} from "./ai.models.js";
import {
  buildRealtimeSessionConfig,
  REALTIME_CLIENT_SECRETS_URL
} from "../voice/voice.realtime.js";

/** The mint response reports expiry as a unix timestamp; the client only needs
 * something it can compare against `Date.now()`. A missing value is treated as
 * the API's documented one-minute floor rather than "never expires", so the
 * re-mint path in task 26 errs on the side of refreshing too early. */
function normalizeExpiry(raw: number | string | undefined): string {
  const asNumber = typeof raw === "string" ? Number(raw) : raw;
  if (typeof asNumber === "number" && Number.isFinite(asNumber) && asNumber > 0) {
    // Unix seconds if it looks like seconds, milliseconds otherwise.
    const ms = asNumber < 1e12 ? asNumber * 1000 : asNumber;
    return new Date(ms).toISOString();
  }
  return new Date(Date.now() + 60_000).toISOString();
}

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

/** Loose narrative shape for model output. Bounds are wider than
 * `ProblemNarrativeSchema` so an over-long framing paragraph is trimmed by
 * `repairNarrative` rather than discarding the whole generated problem. */
const GeneratedNarrativeSchema = z.object({
  framingScript: z.string().max(4000).optional(),
  signatureChallenge: z.string().max(2000).optional(),
  progressiveReveals: z.array(z.string().max(1200)).max(6).optional()
});

const GeneratedProblemSchema = z.object({
  title: z.string(),
  statement: z.string(),
  constraints: z.array(z.string()),
  tags: z.array(z.string()).min(2).max(5),
  framingScript: z.string().max(4000).optional(),
  signatureChallenge: z.string().max(2000).optional(),
  progressiveReveals: z.array(z.string().max(1200)).max(6).optional(),
  estimationSpec: EstimationProblemSpecSchema,
  interviewPlan: InterviewPlanSchema
});

/**
 * Coerce loose narrative output into the strict schema, field by field.
 *
 * Each field is independent: an over-long framing script must not cost us the
 * signature challenge, and two reveals instead of three must not cost us
 * either. Anything that cannot be made schema-valid is dropped, and consumers
 * already treat a missing field as "behave as before".
 */
export function repairNarrative(
  raw: z.infer<typeof GeneratedNarrativeSchema> | undefined
): ProblemNarrative | null {
  if (!raw) return null;

  const framing = raw.framingScript?.trim();
  const signature = raw.signatureChallenge?.trim();
  const reveals = (raw.progressiveReveals ?? [])
    .map((r) => r.trim())
    .filter((r) => r.length >= 20)
    .map((r) => r.slice(0, 300));

  const candidate: ProblemNarrative = {
    // Bounds mirror ProblemNarrativeSchema; too-short values are genuinely
    // unusable (an 8-word "framing script" is not a framing script), so they
    // are dropped rather than padded.
    ...(framing && framing.length >= 80 ? { framingScript: framing.slice(0, 900) } : {}),
    ...(signature && signature.length >= 40
      ? { signatureChallenge: signature.slice(0, 400) }
      : {}),
    ...(reveals.length >= 3
      ? { progressiveReveals: [reveals[0]!, reveals[1]!, reveals[2]!] as [string, string, string] }
      : {})
  };

  return getProblemNarrative(candidate);
}

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
  operability: dimensionScore,
  capacityEstimation: dimensionScore
});

const CriterionEvaluationSchema = z.object({
  criterionId: z.string().min(1).max(120),
  covered: z.boolean(),
  discovered: z.boolean(),
  severity: z.enum(["high", "medium", "low"]).optional(),
  evidence: z.string().max(500).optional()
});

/** Model-side flag verdict. Loose on purpose: `text` is echoed back by the
 * model but the server overwrites it from the stored playbook, and unresolved
 * addresses are dropped (see `sanitizeFlagObservations`). */
const FlagObservationOutputSchema = z.object({
  areaId: z.string(),
  kind: z.enum(["green", "red"]),
  index: z.number().int().nonnegative(),
  text: z.string().optional(),
  fired: z.boolean(),
  evidence: z.string().optional()
});

/** Model-side process assessment. Enum values are validated strictly (they
 * drive fixed UI copy, so an unknown value has nothing to render) but the free
 * text is loose and trimmed by `sanitizeProcessAssessment`. */
const ProcessAssessmentOutputSchema = z.object({
  clarifiedBeforeDesigning: z.enum(["yes", "partially", "no"]),
  decisiveness: z.enum([
    "decides_and_justifies",
    "lists_without_choosing",
    "avoids_committing"
  ]),
  surfacedOwnLimitations: z.boolean(),
  adaptedWhenChallenged: z.enum(["yes", "partially", "not_tested", "no"]),
  drove: z.enum(["candidate_led", "balanced", "interviewer_led"]),
  observations: z
    .array(z.object({ signal: z.string().max(1200), evidence: z.string().max(2000) }))
    .max(8)
});

/**
 * Trim a model process assessment to the persisted schema.
 *
 * Returns `undefined` when there was no transcript, regardless of what the
 * model returned: without a conversation there is no process to assess, and a
 * fabricated one is worse than an absent field. Also returns `undefined` when
 * every observation is blank — the schema requires at least one, and an
 * assessment with no evidence is exactly what the prompt forbids.
 */
export function sanitizeProcessAssessment(
  raw: z.infer<typeof ProcessAssessmentOutputSchema> | undefined,
  hasTranscript: boolean
): ProcessAssessment | undefined {
  if (!raw || !hasTranscript) return undefined;

  const observations = raw.observations
    .map((o) => ({ signal: o.signal.trim().slice(0, 240), evidence: o.evidence.trim().slice(0, 400) }))
    .filter((o) => o.signal.length > 0 && o.evidence.length > 0)
    .slice(0, 4);
  if (observations.length === 0) return undefined;

  return {
    clarifiedBeforeDesigning: raw.clarifiedBeforeDesigning,
    decisiveness: raw.decisiveness,
    surfacedOwnLimitations: raw.surfacedOwnLimitations,
    adaptedWhenChallenged: raw.adaptedWhenChallenged,
    drove: raw.drove,
    observations
  };
}

const ValidationSchema = z.object({
  dimensions: ValidationDimensionsSchema,
  dimensionNotes: z.record(z.string(), z.string()).optional(),
  criteriaEvaluations: z.array(CriterionEvaluationSchema).optional(),
  flagObservations: z.array(FlagObservationOutputSchema).optional(),
  processAssessment: ProcessAssessmentOutputSchema.optional(),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
  nextSteps: z.array(z.string())
});

/** Stable structured-output settings for grading-related LLM calls. */
/** Structured grading calls: temperature 0 for steadier outputs. OpenAI models
 * used here do not honor `seed` (AI SDK logs a warning if passed), so we omit it. */
const GRADING_OBJECT_SETTINGS = { temperature: 0 } as const;

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
  progressiveNudges: z.array(z.string()).max(6).optional(),
  satisfiedBy: z.array(z.string()).max(12).optional(),
  scaleNote: z.string().max(1000).optional()
});

const LoosePlaybookAreaSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  phaseRefs: z.array(z.string()).max(12),
  criterionRefs: z.array(z.string()).max(12),
  sampleQuestions: z.array(z.string()).max(8),
  progressiveNudges: z.array(z.string()).max(8),
  greenFlags: z.array(z.string()).max(10),
  redFlags: z.array(z.string()).max(10)
});

const LoosePlaybookSchema = z.object({
  areasToProbe: z.array(LoosePlaybookAreaSchema).min(1).max(16),
  scoreRubric: z.object({
    "1": z.string().min(1).max(1200),
    "2": z.string().min(1).max(1200),
    "3": z.string().min(1).max(1200),
    "4": z.string().min(1).max(1200)
  })
});

const GeneratedRubricSchema = z.object({
  criteria: z.array(LooseRubricCriterionSchema).min(3).max(20),
  playbook: LoosePlaybookSchema
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

function toSnakeSlug(raw: string, fallback: string, maxLen = 80): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]/, "c_$&")
    .slice(0, maxLen);
  return slug.length > 0 ? slug : fallback;
}

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

  const baseSlug = toSnakeSlug(raw.id, `criterion_${index + 1}`);
  let slug = baseSlug;
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
    progressiveNudges:
      raw.progressiveNudges && raw.progressiveNudges.length > 0
        ? normalizeThreeNudges(raw.progressiveNudges, [
            `What assumption would help validate ${text}?`,
            `Where should the design show ${text}?`,
            `Make ${text} explicit before moving on.`
          ])
        : undefined,
    satisfiedBy: truncStrings(raw.satisfiedBy),
    scaleNote: raw.scaleNote ? raw.scaleNote.trim().slice(0, 300) : undefined
  };
  const parsed = RubricCriterionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function normalizeThreeNudges(
  raw: string[],
  fallback: [string, string, string]
): [string, string, string] {
  const cleaned = raw.map((s) => s.trim().slice(0, 240)).filter((s) => s.length >= 4);
  return [
    cleaned[0] ?? fallback[0],
    cleaned[1] ?? fallback[1],
    cleaned[2] ?? fallback[2]
  ];
}

function truncateList(xs: string[], maxLen: number, maxCount: number, fallback: string): string[] {
  const cleaned = xs.map((s) => s.trim().slice(0, maxLen)).filter((s) => s.length >= 4);
  return cleaned.length > 0 ? cleaned.slice(0, maxCount) : [fallback];
}

export function sanitizeGeneratedPlaybook(input: {
  raw: z.infer<typeof LoosePlaybookSchema>;
  criteria: RubricCriterion[];
  phases: Array<{ id: string; label: string }>;
}): InterviewerPlaybook {
  const criterionIds = new Set(input.criteria.map((c) => c.id));
  const phaseIds = new Set(input.phases.map((p) => p.id));
  const fallbackPhaseId = input.phases[0]?.id ?? "clarify";
  const fallbackCriterionId = input.criteria[0]?.id ?? "requirements";

  const used = new Set<string>();
  const areas = input.raw.areasToProbe
    .map((area, index) => {
      const baseSlug = toSnakeSlug(area.id, `probe_area_${index + 1}`);
      let slug = baseSlug;
      if (used.has(slug)) {
        let n = 2;
        while (used.has(`${slug}_${n}`) && n < 100) n += 1;
        slug = `${slug}_${n}`;
      }
      used.add(slug);

      const phaseRefs = area.phaseRefs.filter((id) => phaseIds.has(id)).slice(0, 8);
      const criterionRefs = area.criterionRefs.filter((id) => criterionIds.has(id)).slice(0, 8);

      return {
        id: slug,
        label: area.label.trim().slice(0, 80) || `Probe area ${index + 1}`,
        phaseRefs: phaseRefs.length > 0 ? phaseRefs : [fallbackPhaseId],
        criterionRefs: criterionRefs.length > 0 ? criterionRefs : [fallbackCriterionId],
        sampleQuestions: truncateList(
          area.sampleQuestions,
          240,
          4,
          "What trade-off would you like to validate before locking this part of the design?"
        ),
        progressiveNudges: normalizeThreeNudges(area.progressiveNudges, [
          "What assumption matters most before you choose this design?",
          "Which requirement would break this approach first at the target scale?",
          "Make a concrete call here and justify the trade-off."
        ]),
        greenFlags: truncateList(
          area.greenFlags,
          220,
          6,
          "Names a concrete trade-off and ties it to the problem constraints."
        ),
        redFlags: truncateList(
          area.redFlags,
          220,
          6,
          "Lists technology choices without connecting them to requirements."
        )
      };
    })
    .slice(0, 12);

  const candidate = {
    areasToProbe:
      areas.length > 0
        ? areas
        : [
            {
              id: "core_requirements",
              label: "Core Requirements",
              phaseRefs: [fallbackPhaseId],
              criterionRefs: [fallbackCriterionId],
              sampleQuestions: ["What are the core user flows and constraints for v1?"],
              progressiveNudges: normalizeThreeNudges([], [
                "Start by clarifying the users and must-have flows.",
                "Which requirement changes your architecture most?",
                "State the v1 scope explicitly before drawing more components."
              ]),
              greenFlags: ["Clarifies scope before choosing architecture."],
              redFlags: ["Jumps into components without clarifying requirements."]
            }
          ],
    scoreRubric: {
      "1": input.raw.scoreRubric["1"].trim().slice(0, 400),
      "2": input.raw.scoreRubric["2"].trim().slice(0, 400),
      "3": input.raw.scoreRubric["3"].trim().slice(0, 400),
      "4": input.raw.scoreRubric["4"].trim().slice(0, 400)
    }
  };

  const parsed = InterviewerPlaybookSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  return {
    areasToProbe: [
      {
        id: "core_requirements",
        label: "Core Requirements",
        phaseRefs: [fallbackPhaseId],
        criterionRefs: [fallbackCriterionId],
        sampleQuestions: ["What are the core user flows and constraints for v1?"],
        progressiveNudges: [
          "Start by clarifying the users and must-have flows.",
          "Which requirement changes your architecture most?",
          "State the v1 scope explicitly before drawing more components."
        ],
        greenFlags: ["Clarifies scope before choosing architecture."],
        redFlags: ["Jumps into components without clarifying requirements."]
      }
    ],
    scoreRubric: {
      "1": "Cannot structure the design or gather requirements.",
      "2": "Covers basics but misses important constraints or trade-offs.",
      "3": "Meets the bar with a clear design and justified decisions.",
      "4": "Exceeds the bar by driving scope, trade-offs, and operational readiness."
    }
  };
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

/** Model-side debrief shape. `generatedAt` is deliberately absent — the server
 * stamps it, so the model can never backdate or omit it. Bounds are looser than
 * `InterviewDebriefSchema` so a slightly-long bullet is trimmed rather than
 * throwing away the whole narrative. */
const GeneratedDebriefSchema = z.object({
  strongestSignal: z.string().min(1).max(1200),
  recommendation: z.enum(["strong_yes", "yes", "no", "strong_no"]),
  whatWentWell: z.array(z.string()).min(1).max(10),
  whereTheyStruggled: z.array(z.string()).max(10),
  riskAreas: z.array(z.string()).max(8),
  studyPlan: z
    .array(
      z.object({
        topic: z.string().min(1).max(400),
        why: z.string().min(1).max(1200),
        suggestedNextProblem: z.string().max(600).optional()
      })
    )
    .max(8)
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
  deepDives: z.array(z.string()),
  criterionCoverage: z
    .array(
      z.object({
        criterionId: z.string().max(200),
        howAddressed: z.string().max(1200)
      })
    )
    .max(60)
    .optional()
});

/**
 * Keep only coverage entries that resolve to a real criterion in this rubric.
 *
 * The UI joins these back to criterion ids to render "you missed this → this is
 * what covering it looks like". An invented id would render as a coverage line
 * attached to nothing, or worse, to the wrong criterion — so unresolvable
 * entries are dropped, exactly like hallucinated flag addresses.
 */
export function resolveCriterionCoverage(
  raw: Array<{ criterionId: string; howAddressed: string }> | undefined,
  criteria: RubricCriterion[] | undefined
): Array<{ criterionId: string; howAddressed: string }> | undefined {
  if (!raw || raw.length === 0 || !criteria || criteria.length === 0) return undefined;

  const known = new Set(criteria.map((c) => c.id));
  const seen = new Set<string>();
  const resolved: Array<{ criterionId: string; howAddressed: string }> = [];

  for (const entry of raw) {
    const id = entry.criterionId.trim();
    if (!known.has(id) || seen.has(id)) continue;
    const howAddressed = entry.howAddressed.trim().slice(0, 300);
    if (howAddressed.length === 0) continue;
    seen.add(id);
    resolved.push({ criterionId: id, howAddressed });
  }

  return resolved.length > 0 ? resolved : undefined;
}

@Injectable()
export class AiService {
  private readonly openai;
  /** Purpose -> model id. See `ai.models.ts`; no model id is spelled out below. */
  private readonly models: AiModels;

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
    this.openai = createOpenAI({
      apiKey: this.configService.getOrThrow<string>("OPENAI_API_KEY")
    });
    this.models = resolveAiModels((key) => this.configService.get<string>(key));
  }

  async generateProblem(input: {
    difficulty: Difficulty;
    topic?: string;
    track?: Track;
    existingProblems?: Array<{ title: string; tags: string[]; gist: string }>;
  }) {
    const result = await generateObject({
      model: this.openai(this.models.problemGeneration),
      schema: GeneratedProblemSchema,
      prompt: buildProblemPrompt(
        input.difficulty,
        input.topic,
        input.existingProblems,
        input.track
      )
    });

    // Drop incoherent unit/magnitude metadata before it is persisted, so a
    // model slip degrades one field to "no calibration" instead of shipping a
    // band that would mark correct answers wrong.
    return {
      ...result.object,
      estimationSpec: normalizeEstimationSpec(result.object.estimationSpec),
      narrative: repairNarrative({
        framingScript: result.object.framingScript,
        signatureChallenge: result.object.signatureChallenge,
        progressiveReveals: result.object.progressiveReveals
      })
    };
  }

  /** Backfill the narrative layer for a problem that predates it. Uses the
   * same rules as generation so a backfilled problem is indistinguishable from
   * a freshly generated one. */
  async inferProblemNarrative(input: {
    title: string;
    statement: string;
    difficulty: Difficulty;
    constraints: string[];
  }): Promise<ProblemNarrative | null> {
    const result = await generateObject({
      model: this.openai(this.models.backfill),
      schema: GeneratedNarrativeSchema,
      prompt: buildProblemNarrativePrompt(input)
    });
    return repairNarrative(result.object);
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
    /** Chronological interviewer chat when validating with an active interview. */
    interviewTranscript?: string;
    /** Interview playbook, when present — supplies the green/red flags the
     * validator judges as fired or not. */
    playbook?: InterviewerPlaybook;
    /** Deterministic calibration summary built by the solutions service. When
     * present it REPLACES the raw estimation dump — the model should be told
     * facts about the numbers, not asked to infer them. */
    estimationDigest?: string;
    /** Interviewer level in play, used only to calibrate the process
     * assessment's `drove` judgement. */
    interviewerLevel?: InterviewerLevel;
  }) {
    const estimationText =
      input.estimationDigest && input.estimationDigest.trim().length > 0
        ? input.estimationDigest
        : input.estimation && Object.keys(input.estimation).length > 0
          ? `\nCandidate back-of-envelope estimation (JSON):\n${JSON.stringify(input.estimation, null, 2)}`
          : "";
    const sortedCriteria = input.criteria
      ? [...input.criteria].sort((a, b) => a.id.localeCompare(b.id))
      : undefined;

    const promptText = buildValidationPrompt(input.difficulty, estimationText, {
      constraints: input.constraints,
      criteria: sortedCriteria,
      legacyRubric: input.legacyRubric,
      interviewTranscript: input.interviewTranscript,
      playbook: input.playbook,
      interviewerLevel: input.interviewerLevel
    });

    const contentParts: Array<{ type: "text"; text: string }> = [
      { type: "text", text: promptText },
      { type: "text", text: formatSceneSummaryForValidation(input.sceneSummary) },
      { type: "text", text: `Candidate notes:\n${input.notes ?? ""}` }
    ];

    const result = await generateObject({
      model: this.openai(this.models.validation),
      schema: ValidationSchema,
      messages: [{ role: "user", content: contentParts }],
      ...GRADING_OBJECT_SETTINGS
    });

    // Drop the process assessment when there was no transcript to read it
    // from, even if the model emitted one anyway.
    const processAssessment = sanitizeProcessAssessment(
      result.object.processAssessment,
      Boolean(input.interviewTranscript?.trim())
    );

    return {
      ...result.object,
      processAssessment
    };
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
    phases: Array<{ id: string; label: string }>;
    existingCriteria?: Array<{
      id: string;
      text: string;
      visibility: "visible" | "hidden";
      importance: "core" | "expected" | "stretch";
    }>;
    /** The problem's signature difficulty, when it has one — the rubric must
     * grade it or it is grading the wrong problem. */
    signatureChallenge?: string;
    /** Role archetype, so criteria target the right concerns. */
    track?: Track;
    /** If set, prepended to the prompt as a hard correction (used by the
     * server-side retry when the first attempt produced too few hiddens). */
    regenerationReason?: string;
  }): Promise<InterviewRubric> {
    const prompt = buildCriteriaPrompt({
      difficulty: input.difficulty,
      interviewerLevel: input.interviewerLevel,
      title: input.title,
      statement: input.statement,
      seedConstraints: input.seedConstraints,
      phases: input.phases,
      existingCriteria: input.existingCriteria,
      signatureChallenge: input.signatureChallenge,
      track: input.track,
      regenerationReason: input.regenerationReason
    });

    // Retry once on stochastic schema failure. Even with a fully-loose
    // model-side schema, gpt-4o-mini occasionally emits malformed JSON or
    // omits required fields entirely. A single re-roll fixes ~all of those.
    const callModel = () =>
      generateObject({
        model: this.openai(this.models.criteriaGeneration),
        schema: GeneratedRubricSchema,
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
    return {
      criteria: repaired,
      playbook: sanitizeGeneratedPlaybook({
        raw: result.object.playbook,
        criteria: repaired,
        phases: input.phases
      })
    };
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
        model: this.openai(this.models.discoveryMatch),
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

  /** Write the end-of-interview debrief.
   *
   * One call, at the moment the candidate ends the interview, over everything
   * the session produced. Failures propagate: unlike the per-turn best-effort
   * jobs, there is nothing to degrade to here — the caller decides whether to
   * fail the request or leave the interview active. */
  async generateDebrief(input: DebriefEvidence): Promise<InterviewDebrief> {
    const result = await generateObject({
      model: this.openai(this.models.debrief),
      schema: GeneratedDebriefSchema,
      prompt: buildDebriefPrompt(input),
      ...GRADING_OBJECT_SETTINGS
    });

    const raw = result.object;
    const clip = (value: string, max: number) => value.trim().slice(0, max);
    const clipList = (values: string[], max: number, count: number) =>
      values.map((v) => clip(v, max)).filter((v) => v.length > 0).slice(0, count);

    const whatWentWell = clipList(raw.whatWentWell, 400, 6);

    return {
      strongestSignal: clip(raw.strongestSignal, 300),
      recommendation: raw.recommendation,
      // The schema requires at least one entry; a model that returns only
      // blank strings would otherwise fail strict validation and lose the
      // whole debrief over a formatting slip.
      whatWentWell:
        whatWentWell.length > 0
          ? whatWentWell
          : ["You completed the attempt end to end and submitted it for review."],
      whereTheyStruggled: clipList(raw.whereTheyStruggled, 400, 6),
      riskAreas: clipList(raw.riskAreas, 400, 4),
      studyPlan: raw.studyPlan
        .map((item) => ({
          topic: clip(item.topic, 120),
          why: clip(item.why, 300),
          ...(item.suggestedNextProblem
            ? { suggestedNextProblem: clip(item.suggestedNextProblem, 160) }
            : {})
        }))
        .filter((item) => item.topic.length > 0 && item.why.length > 0)
        .slice(0, 5),
      generatedAt: new Date().toISOString()
    };
  }

  /** Generate a reference answer.
   *
   * With `criteria` the answer is built against one interview's live scope and
   * rubric; without them the behaviour (and the prompt) is exactly what it was
   * before rubrics existed, so the per-problem cache stays valid. */
  async generateReference(input: {
    title: string;
    statement: string;
    difficulty: Difficulty;
    constraints: string[];
    criteria?: RubricCriterion[];
    signatureChallenge?: string;
  }) {
    const result = await generateObject({
      model: this.openai(this.models.reference),
      schema: ReferenceSolutionSchema,
      prompt: buildReferenceSolutionPrompt(input)
    });

    const criterionCoverage = resolveCriterionCoverage(
      result.object.criterionCoverage,
      input.criteria
    );

    return {
      ...result.object,
      ...(criterionCoverage ? { criterionCoverage } : { criterionCoverage: undefined })
    };
  }

  /** Infer the role archetype for a problem generated before tracks existed.
   * Returns `null` when nothing fits — an unspecified track is a perfectly
   * valid state, so guessing would be worse than leaving it blank. */
  async inferTrack(input: {
    title: string;
    statement: string;
    difficulty: Difficulty;
    tags: string[];
  }): Promise<Track | null> {
    const TrackOnlySchema = z.object({
      track: z.string().max(60),
      confident: z.boolean()
    });
    const result = await generateObject({
      model: this.openai(this.models.backfill),
      schema: TrackOnlySchema,
      ...GRADING_OBJECT_SETTINGS,
      prompt: [
        "Classify which engineering role archetype this system design problem is written for.",
        `Allowed values: ${TrackSchema.options.join(", ")}.`,
        "- backend: shared mutable state across processes, delivery/ordering guarantees, datastore topology.",
        "- frontend: client-side conflict resolution, render/state boundaries, network chattiness, a11y.",
        "- fullstack: the seam between the UX and the data — what the client may assume vs what the server confirms.",
        "- devops: pipeline topology, deployment strategy and blast radius, signal quality and alerting.",
        "- ai-engineering: retrieval quality, model fallback, evaluation as infrastructure, cost per request.",
        "",
        'Set `confident: false` if the problem does not clearly belong to one of these. An unspecified track is a valid outcome — do NOT force a guess, since a wrong track steers future generation and grading in the wrong direction.',
        "",
        `Title: ${input.title}`,
        `Difficulty: ${input.difficulty}`,
        `Tags: ${input.tags.length > 0 ? input.tags.join(", ") : "(none)"}`,
        "Statement:",
        input.statement,
        "",
        "Return JSON: { track, confident }"
      ].join("\n")
    });

    return result.object.confident ? getTrack(result.object.track) : null;
  }

  /** Summarise what a tutor session was actually about, as up to five short
   * topic labels. Called at most once per session (the result is cached on the
   * row), and failures degrade to `[]` — a missing topic list is a cosmetic
   * loss, not a reason to fail a read. */
  async summariseTutorTopics(input: { candidateTurns: string[] }): Promise<string[]> {
    if (input.candidateTurns.length === 0) return [];
    const TopicsSchema = z.object({ topics: z.array(z.string().max(120)).max(8) });
    try {
      const result = await generateObject({
        model: this.openai(this.models.backfill),
        schema: TopicsSchema,
        ...GRADING_OBJECT_SETTINGS,
        prompt: [
          "These are the questions a candidate asked a system-design tutor during one practice session.",
          "Summarise what they were asking ABOUT, as up to 5 short topic labels (1-3 words each), most asked-about first.",
          'Use design vocabulary, e.g. "partitioning", "idempotency", "cache invalidation", "queue delivery guarantees".',
          "Do not judge, do not advise, and do not invent topics that were not asked about. Fewer accurate labels beat five padded ones.",
          "",
          "Questions:",
          ...input.candidateTurns.map((turn) => `- ${turn.slice(0, 600)}`),
          "",
          "Return JSON: { topics: string[] }"
        ].join("\n")
      });
      return result.object.topics
        .map((t) => t.trim().slice(0, 60))
        .filter((t) => t.length > 0)
        .slice(0, 5);
    } catch {
      return [];
    }
  }

  async inferTags(input: { title: string; statement: string; difficulty: Difficulty }) {
    const TagOnlySchema = z.object({ tags: z.array(z.string()).min(2).max(5) });
    const result = await generateObject({
      model: this.openai(this.models.backfill),
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
      model: this.openai(this.models.backfill),
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
        "Return JSON with intro (optional), fields (4-10), derivedHints (3-6), derivedFormulas (2-4):",
        "- fields, each:",
        ESTIMATION_FIELD_RULES,
        "- derivedHints: qualitative sanity-check bullets for magnitudes from those fields",
        ESTIMATION_DERIVED_FORMULA_RULES
      ].join("\n")
    });
    return normalizeEstimationSpec(result.object);
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
        model: this.openai(this.models.proposals),
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
      model: this.openai(this.models.backfill),
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
        "Skip or merge generic phases that do not apply (e.g. no separate API phase for purely batch/analytics if irrelevant).",
        "The LAST phase MUST be a short closing phase (3-5 minutes) where the CANDIDATE summarises their own design, says what they would change at 10x scale, and names what they would tackle next."
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
    /** Private interviewer guide generated alongside the criteria. */
    playbook?: InterviewerPlaybook;
    currentPhaseId?: string;
    /** IDs of criteria already discovered; the prompt only nudges toward
     * the complement of this set. */
    discoveredCriterionIds?: string[];
    /** Server-recorded pacing across phases, so the interviewer can reference
     * how the session was spent rather than only the current phase. */
    phaseTimeline?: PhaseTimeline;
    /** Set when a phase-transition offer is live for the candidate. */
    pendingPhaseTransition?: { toLabel: string };
    /** Problem narrative — supplies the stall ladder. */
    narrative?: ProblemNarrative | null;
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
      playbook: args.playbook,
      currentPhaseId: args.currentPhaseId,
      discoveredCriterionIds: args.discoveredCriterionIds,
      phaseTimeline: args.phaseTimeline,
      pendingPhaseTransition: args.pendingPhaseTransition,
      narrative: args.narrative
    });

    return streamText({
      model: this.openai(this.models.interviewerChat),
      system: `${systemPrompt}\nProblem:\n${args.problemStatement}${contextText}`,
      messages: [...args.history, { role: "user", content: userContent }]
    });
  }

  /**
   * Build the system instructions for a spoken interview.
   *
   * Same builder, same rubric, same playbook as `streamInterviewer` — only the
   * delivery contract differs (`modality: "voice"`), because a prompt tuned for
   * a markdown chat panel spoken aloud reads out its own asterisks.
   *
   * The transcript is folded in here rather than replayed as conversation items:
   * a realtime session takes its instructions once, at mint time, and cannot be
   * seeded with history. That also makes reconnection work — task 26 re-mints
   * mid-interview and the interviewer picks up where it left off instead of
   * reintroducing itself twenty minutes in.
   */
  buildVoiceInstructions(args: {
    interviewerLevel: InterviewerLevel;
    problemStatement: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
    workspaceContext?: WorkspaceContext;
    criteria?: RubricCriterion[];
    playbook?: InterviewerPlaybook;
    currentPhaseId?: string;
    discoveredCriterionIds?: string[];
    phaseTimeline?: PhaseTimeline;
    pendingPhaseTransition?: { toLabel: string };
    narrative?: ProblemNarrative | null;
    transcript?: string | null;
  }): string {
    const systemPrompt = buildInterviewerPrompt(
      args.interviewerLevel,
      {
        criteria: args.criteria,
        playbook: args.playbook,
        currentPhaseId: args.currentPhaseId,
        discoveredCriterionIds: args.discoveredCriterionIds,
        phaseTimeline: args.phaseTimeline,
        pendingPhaseTransition: args.pendingPhaseTransition,
        narrative: args.narrative
      },
      { modality: "voice" }
    );

    // No board image: the realtime model's value here is conversation, and the
    // scene arrives as text both at mint time and as deltas during the session.
    const contextText = args.workspaceContext
      ? formatWorkspaceContextText(args.workspaceContext, /* includeScene */ true, false)
      : "";

    const opening = args.history.length === 0 && args.narrative?.framingScript
      ? `\n\nOPEN THE INTERVIEW by saying this, in your own voice and at a natural pace. Do not read it as a script and do not add a UI tour:\n${args.narrative.framingScript}`
      : "";

    const resumed = args.transcript
      ? `\n\nCONVERSATION SO FAR (this interview is already in progress — do NOT reintroduce yourself, restate the problem, or start over; continue from where this leaves off):\n${args.transcript}`
      : "";

    return `${systemPrompt}\nProblem:\n${args.problemStatement}${contextText}${resumed}${opening}`;
  }

  /**
   * Exchange the server's API key for a short-lived credential the browser can
   * hold, with the session config — instructions included — already baked in.
   *
   * This asymmetry is the whole security model. `buildInterviewerPrompt` embeds
   * every undiscovered hidden expectation verbatim along with its progressive
   * nudges, so a browser that assembled its own session config could read the
   * entire hidden rubric out of devtools and `detectDiscoveries` would be
   * measuring nothing. The prompt goes into the credential; the credential is
   * all the browser ever sees.
   */
  async mintRealtimeSession(input: {
    instructions: string;
    turnDetection: VoiceTurnDetectionConfig;
    keywords?: string[];
  }): Promise<{ clientSecret: string; expiresAt: string; model: string; voice: string }> {
    const read = (key: string) => this.configService.get<string>(key);
    const voice = resolveVoiceName(read);
    const model = this.models.interviewerVoice;

    const session = buildRealtimeSessionConfig({
      model,
      transcriptionModel: this.models.voiceTranscription,
      voice,
      sampleRate: VOICE_SAMPLE_RATE,
      instructions: input.instructions,
      turnDetection: input.turnDetection,
      keywords: input.keywords,
      languages: resolveVoiceLanguages(read),
      maxResponseTokens: resolveVoiceMaxResponseTokens(read),
      reasoningEffort: resolveVoiceReasoningEffort(read)
    });

    const response = await fetch(REALTIME_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.configService.getOrThrow<string>("OPENAI_API_KEY")}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ session })
    });

    if (!response.ok) {
      // Surface the status and a clipped body: a 400 here is almost always a
      // reshaped session object, and the body says which field.
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Realtime session mint failed (${response.status}): ${detail.slice(0, 400)}`
      );
    }

    const body = (await response.json()) as {
      value?: string;
      expires_at?: number | string;
    };
    if (typeof body.value !== "string" || body.value.length === 0) {
      throw new Error("Realtime session mint returned no client secret");
    }

    return {
      clientSecret: body.value,
      expiresAt: normalizeExpiry(body.expires_at),
      model,
      voice
    };
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

    // The tutor is the lower-stakes surface, so it stays on the cheap
    // multimodal tier (see `AI_MODEL_DEFAULTS.tutorChat`).
    return streamText({
      model: this.openai(this.models.tutorChat),
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
