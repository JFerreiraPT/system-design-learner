import { z } from "zod";
import { evaluateExpression } from "./estimationCalibration.js";

export const DifficultySchema = z.enum(["beginner", "easy", "medium", "hard", "expert"]);
export type Difficulty = z.infer<typeof DifficultySchema>;

export const InterviewerLevelSchema = z.enum(["guided", "standard", "hard", "staff"]);
export type InterviewerLevel = z.infer<typeof InterviewerLevelSchema>;

/** Role archetype a problem is written for.
 *
 * Difficulty says how hard; track says what KIND of design. The two compose:
 * difficulty owns breadth, track owns subject. Entirely optional — `null`
 * means "unspecified" and reproduces the pre-track behaviour exactly. */
export const TrackSchema = z.enum([
  "backend",
  "frontend",
  "fullstack",
  "devops",
  "ai-engineering"
]);
export type Track = z.infer<typeof TrackSchema>;

/** Stable UI wording per track. Never model-generated. */
export const TRACK_LABELS: Record<Track, string> = {
  backend: "Backend",
  frontend: "Frontend",
  fullstack: "Fullstack",
  devops: "DevOps",
  "ai-engineering": "AI engineering"
};

/** Tolerant read of `problems.track`. Anything unrecognised (including the
 * `NULL` on every problem that predates the column) is "unspecified". */
export function getTrack(value: unknown): Track | null {
  const parsed = TrackSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Interviewer-facing narrative layer for a problem.
 *
 * `statement` is the terse written spec on the Problem rail and serves that
 * role well; it makes a poor opening line and says nothing about where the
 * problem is actually hard. These three fields split those jobs apart.
 *
 * Persisted whole in `problems.narrative_json` rather than as three scalar
 * columns, matching `reference_json` / `estimation_spec_json`. */
export const ProblemNarrativeSchema = z.object({
  /** Verbatim framing the interviewer opens with — conversational, second
   *  person, ends by handing control to the candidate. Distinct from
   *  `statement`, which stays the terse written spec on the Problem rail. */
  framingScript: z.string().min(80).max(900).optional(),
  /** The one thing that makes THIS problem hard — the place a strong candidate
   *  visibly separates. One or two sentences, names a concrete mechanism.
   *
   *  INTERVIEWER-PRIVATE. It is the answer to "what is this problem really
   *  testing", so showing it to the candidate would defeat the hidden-criteria
   *  loop the same way pasting the playbook would. */
  signatureChallenge: z.string().min(40).max(400).optional(),
  /** Problem-level escalation ladder, always in this order:
   *  [0] scale nudge, [1] failure-mode nudge, [2] debug/operational nudge. */
  progressiveReveals: z
    .tuple([
      z.string().min(20).max(300),
      z.string().min(20).max(300),
      z.string().min(20).max(300)
    ])
    .optional()
});
export type ProblemNarrative = z.infer<typeof ProblemNarrativeSchema>;

/** Tolerant read of `problems.narrative_json`. Null / malformed / legacy rows
 * all yield `null`, and every consumer treats that as "behave as before". */
export function getProblemNarrative(value: unknown): ProblemNarrative | null {
  if (value === null || value === undefined) return null;
  const parsed = ProblemNarrativeSchema.safeParse(value);
  if (!parsed.success) return null;
  const narrative = parsed.data;
  const empty =
    !narrative.framingScript && !narrative.signatureChallenge && !narrative.progressiveReveals;
  return empty ? null : narrative;
}

export const ProblemSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string(),
  statement: z.string(),
  difficulty: DifficultySchema,
  constraints: z.array(z.string()),
  /** Optional role archetype. Absent means unspecified. */
  track: TrackSchema.optional(),
  /** Interviewer-facing framing / difficulty core / stall ladder. Optional:
   * every problem generated before this existed has none. */
  narrative: ProblemNarrativeSchema.optional(),
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
  /** Optional role archetype. Omitting it generates exactly as before. */
  track: TrackSchema.optional(),
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

/** How the reference answer addresses one rubric criterion.
 *
 * This is what turns the reference from "a model answer" into "here is what
 * covering the thing you missed looks like". Optional so references cached
 * before it existed keep parsing. */
export const ReferenceCriterionCoverageSchema = z.object({
  criterionId: z.string().max(80),
  howAddressed: z.string().max(300)
});
export type ReferenceCriterionCoverage = z.infer<typeof ReferenceCriterionCoverageSchema>;

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
  deepDives: z.array(z.string()),
  /** Present only on interview-scoped references (`?interviewId=`), where a
   * rubric exists to map against. Ids are resolved server-side; anything
   * unresolvable is dropped rather than rendered. */
  criterionCoverage: z.array(ReferenceCriterionCoverageSchema).max(40).optional()
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

/** How the candidate WORKED, judged from the transcript alone.
 *
 * The eight design dimensions are all properties of the artefact, so two
 * candidates who produce an identical diagram score identically — even if one
 * clarified scope for four minutes and named their own design's weak point
 * unprompted, and the other silently drew boxes and answered when spoken to.
 * The playbook is explicit that proactiveness is the strongest seniority
 * signal, and the transcript to judge it from is already in hand.
 *
 * Reported, never scored. It is a new, uncalibrated signal, and folding it
 * into `score` before its distribution is visible would silently re-baseline
 * every past attempt. It does feed the debrief narrative, where a qualitative
 * signal belongs. */
export const ProcessAssessmentSchema = z.object({
  /** Did they clarify before designing, or draw first and ask later? */
  clarifiedBeforeDesigning: z.enum(["yes", "partially", "no"]),
  /** Decided and justified, vs. listed options and moved on. The playbook's
   *  named red flag: "we could use SQL or NoSQL, each has pros and cons…" */
  decisiveness: z.enum([
    "decides_and_justifies",
    "lists_without_choosing",
    "avoids_committing"
  ]),
  /** Named a weakness of their OWN design without being asked. */
  surfacedOwnLimitations: z.boolean(),
  /** Adjusted the design when challenged, vs. defended or ignored.
   *  `not_tested` is the honest answer when the interviewer never challenged
   *  an assumption — silence is not evidence of rigidity. */
  adaptedWhenChallenged: z.enum(["yes", "partially", "not_tested", "no"]),
  /** Who set the agenda across the session. */
  drove: z.enum(["candidate_led", "balanced", "interviewer_led"]),
  /** 2-4 short observations, each grounded in a quoted or paraphrased line. */
  observations: z
    .array(
      z.object({
        signal: z.string().max(240),
        evidence: z.string().max(400)
      })
    )
    .min(1)
    .max(4)
});
export type ProcessAssessment = z.infer<typeof ProcessAssessmentSchema>;

/** Plain-English reading of each enum value. Stable UI wording, written to the
 * candidate in the second person — never model-generated. */
export const PROCESS_READINGS = {
  clarifiedBeforeDesigning: {
    yes: "You clarified scope before designing",
    partially: "You clarified some scope, but started designing early",
    no: "You started designing before clarifying scope"
  },
  decisiveness: {
    decides_and_justifies: "You made calls and justified them",
    lists_without_choosing: "You listed options without choosing",
    avoids_committing: "You avoided committing to decisions"
  },
  adaptedWhenChallenged: {
    yes: "You adjusted the design when challenged",
    partially: "You partly adjusted when challenged",
    not_tested: "Your assumptions were never challenged",
    no: "You defended rather than adjusted when challenged"
  },
  drove: {
    candidate_led: "You drove the conversation",
    balanced: "You and the interviewer shared the lead",
    interviewer_led: "The interviewer led the conversation"
  }
} as const satisfies {
  [K in Exclude<keyof ProcessAssessment, "surfacedOwnLimitations" | "observations">]: Record<
    ProcessAssessment[K] & string,
    string
  >;
};

export const SURFACED_OWN_LIMITATIONS_READING = {
  true: "You named a weakness of your own design unprompted",
  false: "You did not surface limitations of your own design"
} as const;

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
  /** How the candidate worked, from the transcript. Present only when this
   * attempt had an interview transcript to read; never folded into any score. */
  processAssessment: ProcessAssessmentSchema.optional(),
  strengths: z.array(z.string()).optional(),
  gaps: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional()
});
export type ValidationFeedback = z.infer<typeof ValidationFeedbackSchema>;

/** Hire-style recommendation on the attempt. Mirrors the interview kit's
 * four-way call rather than a numeric verdict, because a narrative debrief
 * that ends in a number is just the score again. */
export const DebriefRecommendationSchema = z.enum([
  "strong_yes",
  "yes",
  "no",
  "strong_no"
]);
export type DebriefRecommendation = z.infer<typeof DebriefRecommendationSchema>;

/** Stable UI wording per recommendation. Never model-generated. */
export const DEBRIEF_RECOMMENDATION_LABELS: Record<DebriefRecommendation, string> = {
  strong_yes: "Strong pass",
  yes: "Pass",
  no: "Not yet",
  strong_no: "Well below bar"
};

/** One thing to go practise, and why. */
export const DebriefStudyItemSchema = z.object({
  topic: z.string().max(120),
  why: z.string().max(300),
  suggestedNextProblem: z.string().max(160).optional()
});
export type DebriefStudyItem = z.infer<typeof DebriefStudyItemSchema>;

/** The written close-out for a finished interview.
 *
 * Shaped like a real interviewer's written debrief — one headline signal, then
 * narrative, then what to do about it. Every bullet is required by the prompt
 * to be traceable to something observable (a diagram element, a quoted line, a
 * criterion id), which is the whole difference between a debrief and a vibe.
 *
 * Persisted once on `interviews.debrief_json`; ending an already-completed
 * interview returns the stored copy rather than paying for a new one. */
export const InterviewDebriefSchema = z.object({
  /** The kit's "STRONGEST SIGNAL (one sentence)". */
  strongestSignal: z.string().max(300),
  recommendation: DebriefRecommendationSchema,
  whatWentWell: z.array(z.string().max(400)).min(1).max(6),
  whereTheyStruggled: z.array(z.string().max(400)).max(6),
  riskAreas: z.array(z.string().max(400)).max(4),
  /** Ordered, concrete practice suggestions — this is a learning tool, so the
   *  debrief ends with what to do next, not with a verdict. */
  studyPlan: z.array(DebriefStudyItemSchema).max(5),
  generatedAt: z.string()
});
export type InterviewDebrief = z.infer<typeof InterviewDebriefSchema>;

/** Tolerant read of `interviews.debrief_json`. Returns null for legacy rows
 * and for anything that no longer matches the schema, so a shape change can
 * never break the Validate tab. */
export function getInterviewDebrief(value: unknown): InterviewDebrief | null {
  if (value === null || value === undefined) return null;
  const parsed = InterviewDebriefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

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
    },
    {
      id: "wrap_up",
      label: "Wrap-up",
      durationSec: 4 * 60,
      candidateGuide:
        "Close the loop yourself. **Interact with:** **Interviewer** tab — summarise your design in a few sentences, then answer two questions unprompted: what would you change at **10× scale**, and what would you **tackle next** if this were the real system? **Validate** for the score, then **End interview** to get your written debrief."
    }
  ]
};

/** @deprecated use `timerPhasesFromPlan(DEFAULT_INTERVIEW_PLAN)` or the problem's plan */
export const WORKSPACE_PHASES: PhaseDefinition[] = timerPhasesFromPlan(DEFAULT_INTERVIEW_PLAN);

/** Fraction of a phase's suggested budget after which the interviewer offers
 * to move on. Deliberately below 1: the useful moment to ask "ready?" is
 * shortly BEFORE the budget runs out, not after it already has. */
export const PHASE_TRANSITION_BUDGET_RATIO = 0.8;

/** A candidate-confirmed offer to advance to the next phase.
 *
 * Modelled on `ConstraintProposalSchema`: the system proposes, the candidate
 * decides. Phase order is the candidate's to own — auto-advancing would take
 * away the one pacing decision the exercise is trying to teach. */
export const PhaseTransitionProposalSchema = z.object({
  id: z.string().min(1).max(120),
  fromPhaseId: z.string().min(1).max(40),
  fromPhaseIndex: z.number().int().nonnegative(),
  toPhaseId: z.string().min(1).max(40),
  toPhaseIndex: z.number().int().nonnegative(),
  /** Label of the phase being offered, so the banner needs no plan lookup. */
  toLabel: z.string().min(1).max(80),
  /** Which rule fired. `time` = past `PHASE_TRANSITION_BUDGET_RATIO` of the
   * suggested budget; `coverage` = everything this phase probes has already
   * been surfaced. */
  reason: z.enum(["time", "coverage"]),
  createdAt: z.string()
});
export type PhaseTransitionProposal = z.infer<typeof PhaseTransitionProposalSchema>;

/** Contents of `interviews.pending_phase_proposal_json`.
 *
 * Holds the single live proposal plus the phases the candidate has already
 * answered for. Both belong together: without the resolved set, "Stay here"
 * would be re-asked on the very next turn, which is exactly the nagging the
 * one-per-phase rule exists to prevent. */
export const PhaseProposalStateSchema = z.object({
  /** At most one live proposal — the candidate can only advance one phase at a
   * time, and two competing banners would just be noise. */
  pending: PhaseTransitionProposalSchema.nullable(),
  resolvedPhaseIds: z.array(z.string().min(1).max(40)).max(64)
});
export type PhaseProposalState = z.infer<typeof PhaseProposalStateSchema>;

export const EMPTY_PHASE_PROPOSAL_STATE: PhaseProposalState = {
  pending: null,
  resolvedPhaseIds: []
};

/** Tolerant read of the column. Legacy rows are `null`; anything unparseable
 * degrades to "no proposal, nothing resolved" rather than throwing. */
export function getPhaseProposalState(value: unknown): PhaseProposalState {
  if (value === null || value === undefined) return EMPTY_PHASE_PROPOSAL_STATE;
  const parsed = PhaseProposalStateSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_PHASE_PROPOSAL_STATE;
}

/**
 * Decide whether to offer a phase transition. Deterministic and LLM-free —
 * this runs after every interviewer turn, and paying for a model call to
 * answer "has the clock passed 80%?" would be absurd.
 *
 * Returns `null` (no proposal) unless ALL of these hold:
 *   1. the candidate is past `PHASE_TRANSITION_BUDGET_RATIO` of this phase's
 *      suggested budget, OR every non-stretch criterion this phase probes has
 *      already been surfaced;
 *   2. the current phase is not the last one;
 *   3. nothing is pending, and this phase has not already been answered for.
 *
 * The coverage arm needs at least one matching criterion to fire, so a legacy
 * interview with no rubric falls back to the time rule instead of proposing on
 * the first turn.
 */
export function evaluatePhaseTransition(input: {
  plan: InterviewPlan;
  phase: { id: string; index: number; elapsedSec: number; durationSec: number };
  state: PhaseProposalState;
  criteria?: RubricCriterion[] | null;
  playbook?: InterviewerPlaybook | null;
  /** ISO timestamp for the created proposal. */
  now: string;
  /** Stable id for the created proposal. */
  id: string;
}): PhaseTransitionProposal | null {
  const { plan, phase, state } = input;

  if (state.pending) return null;
  if (state.resolvedPhaseIds.includes(phase.id)) return null;

  const next = plan.phases[phase.index + 1];
  if (!next) return null;
  // A stale client index pointing at a different phase means we cannot trust
  // the pacing numbers either — say nothing rather than offer the wrong move.
  const current = plan.phases[phase.index];
  if (!current || current.id !== phase.id) return null;

  const budget = phase.durationSec > 0 ? phase.durationSec : current.durationSec;
  const pastBudget =
    budget > 0 && phase.elapsedSec >= Math.floor(budget * PHASE_TRANSITION_BUDGET_RATIO);

  const reason: PhaseTransitionProposal["reason"] | null = pastBudget
    ? "time"
    : phaseCoverageComplete(phase.id, input.criteria, input.playbook)
      ? "coverage"
      : null;
  if (!reason) return null;

  return {
    id: input.id,
    fromPhaseId: phase.id,
    fromPhaseIndex: phase.index,
    toPhaseId: next.id,
    toPhaseIndex: phase.index + 1,
    toLabel: next.label,
    reason,
    createdAt: input.now
  };
}

/** True when every non-stretch criterion the playbook maps to this phase has
 * been surfaced. False when the mapping yields nothing — "no expectations" is
 * not the same as "all expectations met". */
function phaseCoverageComplete(
  phaseId: string,
  criteria: RubricCriterion[] | null | undefined,
  playbook: InterviewerPlaybook | null | undefined
): boolean {
  if (!criteria?.length || !playbook) return false;

  const wanted = new Set<string>();
  for (const area of playbook.areasToProbe) {
    if (!area.phaseRefs.includes(phaseId)) continue;
    for (const id of area.criterionRefs) wanted.add(id);
  }
  if (wanted.size === 0) return false;

  const relevant = criteria.filter((c) => wanted.has(c.id) && c.importance !== "stretch");
  if (relevant.length === 0) return false;

  return relevant.every((c) => Boolean(c.discoveredVia));
}

/** Kind of a recorded phase transition.
 *
 * `enter` / `exit` bracket the time spent in a phase; `reset` marks the point
 * where the candidate cleared the timer, so anything recorded before it is no
 * longer part of the live timeline. */
export const PhaseEventKindSchema = z.enum(["enter", "exit", "reset"]);
export type PhaseEventKind = z.infer<typeof PhaseEventKindSchema>;

/** Upper bound the server clamps a client-reported `elapsedSec` to (24h).
 * The timer is pausable and lives in the browser, so the value is advisory
 * telemetry — clamping keeps one absurd report from distorting the timeline. */
export const MAX_PHASE_ELAPSED_SEC = 86_400;

/** Body of `POST /interviews/:id/phase-events`.
 *
 * `elapsedSec` is deliberately unbounded here: the server clamps it (see
 * `clampPhaseElapsedSec`) rather than rejecting the request, because dropping
 * telemetry is worse than storing a capped number. */
export const PhaseEventInputSchema = z.object({
  phaseId: z.string().min(1).max(40),
  phaseIndex: z.number().int().nonnegative().max(1000),
  kind: PhaseEventKindSchema,
  elapsedSec: z.number().default(0)
});
export type PhaseEventInput = z.infer<typeof PhaseEventInputSchema>;

/** Clamp a client-reported elapsed value into `[0, MAX_PHASE_ELAPSED_SEC]`.
 * Non-finite input becomes 0 so a corrupt payload can never poison the sum. */
export function clampPhaseElapsedSec(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_PHASE_ELAPSED_SEC, Math.max(0, Math.round(n)));
}

export const PhaseTimelineEntrySchema = z.object({
  phaseId: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
  /** Suggested budget from the interview plan. 0 for a phase that appears in
   * the event log but not in the plan (the plan changed since the session). */
  budgetSec: z.number().int().nonnegative(),
  actualSec: z.number().int().nonnegative(),
  overBudget: z.boolean()
});
export type PhaseTimelineEntry = z.infer<typeof PhaseTimelineEntrySchema>;

export const PhaseTimelineSchema = z.object({
  phases: z.array(PhaseTimelineEntrySchema),
  totalSec: z.number().int().nonnegative(),
  completed: z.boolean()
});
export type PhaseTimeline = z.infer<typeof PhaseTimelineSchema>;

/**
 * Reduce an append-only phase-event log into per-phase actual vs budget.
 *
 * Every event carries the client's accumulated seconds for that phase at the
 * moment it fired, so the time actually spent in a phase is the LARGEST value
 * ever reported for it — `enter` reports 0, `exit` reports the total. Taking
 * the max (rather than differencing timestamps) is what makes a pausable,
 * browser-owned timer reducible at all.
 *
 * A `reset` discards everything recorded before it: the candidate explicitly
 * cleared the clock, so pre-reset numbers no longer describe the session.
 *
 * Pure and plan-driven: every plan phase is emitted, so an interview with zero
 * events yields the full phase list at `actualSec: 0`.
 */
export function buildPhaseTimeline(input: {
  plan: InterviewPlan;
  /** Chronological (oldest first). */
  events: Array<{ phaseId: string; kind: PhaseEventKind; elapsedSec: number }>;
  completed: boolean;
}): PhaseTimeline {
  const lastReset = input.events.reduce(
    (acc, event, index) => (event.kind === "reset" ? index : acc),
    -1
  );
  const live = input.events.slice(lastReset + 1);

  const maxByPhase = new Map<string, number>();
  for (const event of live) {
    const seconds = clampPhaseElapsedSec(event.elapsedSec);
    const previous = maxByPhase.get(event.phaseId) ?? 0;
    if (seconds > previous) maxByPhase.set(event.phaseId, seconds);
    else if (!maxByPhase.has(event.phaseId)) maxByPhase.set(event.phaseId, previous);
  }

  const planIds = new Set(input.plan.phases.map((p) => p.id));
  const entries: PhaseTimelineEntry[] = input.plan.phases.map((phase) => {
    const actualSec = maxByPhase.get(phase.id) ?? 0;
    return {
      phaseId: phase.id,
      label: phase.label,
      budgetSec: phase.durationSec,
      actualSec,
      overBudget: actualSec > phase.durationSec
    };
  });

  // Phases recorded against a plan that has since changed still happened, so
  // they stay in the timeline (budget unknown -> 0, never "over budget").
  for (const [phaseId, actualSec] of maxByPhase) {
    if (planIds.has(phaseId)) continue;
    entries.push({
      phaseId,
      label: phaseId,
      budgetSec: 0,
      actualSec,
      overBudget: false
    });
  }

  return {
    phases: entries,
    totalSec: entries.reduce((sum, entry) => sum + entry.actualSec, 0),
    completed: input.completed
  };
}

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

/** Interviewer levels from most forgiving to most demanding.
 *
 * The order is load-bearing for rubric projection: a criterion hidden at one
 * level must stay hidden at every level above it, so hidden counts grow
 * monotonically with level. */
export const INTERVIEWER_LEVEL_ORDER = ["guided", "standard", "hard", "staff"] as const;

function levelRank(level: InterviewerLevel): number {
  return INTERVIEWER_LEVEL_ORDER.indexOf(level);
}

/**
 * One criterion in a hand-authored rubric, before it is bound to a level.
 *
 * Identical to `RubricCriterionSchema` except that `visibility` is replaced by
 * `hiddenFrom`. That swap is the whole idea: interviewer level changes exactly
 * one thing about a rubric — which expectations the candidate must DISCOVER
 * rather than read off the Problem rail (see `LEVEL_HIDDEN_GUIDANCE` in
 * @sdl/ai-prompts, the only place level enters rubric generation). So instead
 * of storing four near-duplicate rubrics per problem and letting them drift, we
 * store one and record, per criterion, the level at which it goes hidden.
 */
export const SeededRubricCriterionSchema = RubricCriterionSchema.omit({
  visibility: true,
  discoveredVia: true
}).extend({
  /** Earliest level at which this criterion is hidden; it stays hidden at every
   * level above. Omitted means always visible — appropriate when a seed
   * constraint already spells the expectation out, so there is nothing to
   * discover at any level. */
  hiddenFrom: InterviewerLevelSchema.optional()
});
export type SeededRubricCriterion = z.infer<typeof SeededRubricCriterionSchema>;

/** A hand-authored rubric: one canonical criteria set plus the playbook,
 * projected to a concrete `InterviewRubric` per level at interview start. */
export const SeededRubricSchema = z.object({
  criteria: z.array(SeededRubricCriterionSchema).min(1).max(40),
  playbook: InterviewerPlaybookSchema
});
export type SeededRubric = z.infer<typeof SeededRubricSchema>;

/** Tolerant read of `problems.seeded_rubric_json`. Null / malformed / absent
 * all yield `null`, and callers fall back to generating a rubric — so a shape
 * change can never block an interview from starting. */
export function getSeededRubric(value: unknown): SeededRubric | null {
  if (value === null || value === undefined) return null;
  const parsed = SeededRubricSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether a canonical criterion is hidden at `level`. */
export function isHiddenAtLevel(criterion: SeededRubricCriterion, level: InterviewerLevel): boolean {
  return criterion.hiddenFrom !== undefined && levelRank(level) >= levelRank(criterion.hiddenFrom);
}

/**
 * Bind a hand-authored rubric to one interviewer level.
 *
 * Produces exactly what `AiService.generateCriteria` would have, so every
 * downstream consumer — validator, interviewer prompt, discovery matcher,
 * the Problem rail indicator — cannot tell the difference. That includes
 * pre-marking `visible` criteria as discovered via `seed`, which is what stops
 * the rail claiming the candidate must "find" a bullet they can already read.
 *
 * `now` is passed in rather than read from the clock so callers stay testable.
 */
export function projectRubricForLevel(
  rubric: SeededRubric,
  level: InterviewerLevel,
  now: string
): InterviewRubric {
  return {
    playbook: rubric.playbook,
    criteria: rubric.criteria.map(({ hiddenFrom: _hiddenFrom, ...rest }) => {
      const hidden = isHiddenAtLevel({ ...rest, hiddenFrom: _hiddenFrom }, level);
      return {
        ...rest,
        visibility: hidden ? ("hidden" as const) : ("visible" as const),
        ...(hidden ? {} : { discoveredVia: { kind: "seed" as const, at: now } })
      };
    })
  };
}

/** Hidden-criteria count a projection yields at `level`. Used by seed
 * validation to check every level against the difficulty's discovery floor. */
export function hiddenCountAtLevel(rubric: SeededRubric, level: InterviewerLevel): number {
  return rubric.criteria.filter((c) => isHiddenAtLevel(c, level)).length;
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
  interviewerLevel: InterviewerLevelSchema,
  /** Regenerate the rubric for the new level in the same request.
   *
   * The level determines the hidden/visible split, so changing it without
   * regenerating leaves the interviewer coaching at one level against a rubric
   * built for another. Absent / false keeps today's behaviour — the candidate
   * decides, because regenerating resets discovery progress. */
  regenerateCriteria: z.boolean().optional()
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
  title: z.string().min(1).max(100).optional(),
  /** Interview this tutor session belongs to, when it was opened from a
   * workspace with a live interview. Absent for standalone tutor use from the
   * Tutor page, which is unrelated to any interview. */
  interviewId: z.string().uuid().optional()
});

/** Factual record of tutor consultation during one interview.
 *
 * Using the tutor is often the RIGHT move — it is why the tutor exists — so
 * this is never a penalty and never gates anything. The problem it solves is
 * that a high score with heavy tutor use means something different from a high
 * score without it, and reviewing your own progress weeks later you cannot
 * currently tell those apart. */
export const TutorUsageSchema = z.object({
  sessions: z.number().int().nonnegative(),
  /** Candidate turns only — the tutor's own replies are not "usage". */
  candidateTurns: z.number().int().nonnegative(),
  /** Phase label the tutor was first opened in, resolved from the phase-event
   * log. Null when the timer was never running, or on legacy interviews. */
  firstUsedAtPhase: z.string().max(80).nullable(),
  /** Up to five short topic labels, summarised once per session and cached. */
  topics: z.array(z.string().max(60)).max(5)
});
export type TutorUsage = z.infer<typeof TutorUsageSchema>;

export const EMPTY_TUTOR_USAGE: TutorUsage = {
  sessions: 0,
  candidateTurns: 0,
  firstUsedAtPhase: null,
  topics: []
};

export const TutorMessageSchema = z.object({
  content: z.string().min(1),
  workspaceContext: workspaceContextSchema
});

// ---------------------------------------------------------------------------
// Voice (tasks 20-26) — spoken interviews over the OpenAI Realtime API.
//
// The browser holds a WebRTC connection straight to OpenAI; the server only
// mints credentials and records what was said. Everything in this block is the
// contract between those two halves.
// ---------------------------------------------------------------------------

/** Turn-detection modes we expose. `semantic_vad` runs a model over the audio
 * and sets the end-of-turn timeout from how *finished* the speech sounds, which
 * is the only one of the two that survives a candidate thinking mid-sentence.
 * `server_vad` is a fixed silence threshold, kept as an escape hatch. */
export const VoiceTurnDetectionModeSchema = z.enum(["semantic_vad", "server_vad"]);
export type VoiceTurnDetectionMode = z.infer<typeof VoiceTurnDetectionModeSchema>;

/** How eager the model is to take the floor. `low` lets the candidate speak
 * uninterrupted — the right default for someone reasoning out loud over a
 * whiteboard. Only meaningful for `semantic_vad`. */
export const VoiceEagernessSchema = z.enum(["low", "medium", "high", "auto"]);
export type VoiceEagerness = z.infer<typeof VoiceEagernessSchema>;

/** Non-secret turn-detection snapshot handed to the client so its UI can
 * explain what it is doing. Deliberately not the authority: the real config was
 * baked into the ephemeral credential server-side. */
export const VoiceTurnDetectionSchema = z.object({
  type: VoiceTurnDetectionModeSchema,
  eagerness: VoiceEagernessSchema.optional(),
  /** Only set for `server_vad`. */
  silenceDurationMs: z.number().int().positive().optional()
});
export type VoiceTurnDetection = z.infer<typeof VoiceTurnDetectionSchema>;

/**
 * What `POST /interviews/:id/voice/session` returns.
 *
 * Note what is NOT here: `instructions`. The interviewer prompt embeds every
 * undiscovered hidden expectation verbatim, with its progressive nudges, so
 * shipping it to the browser would let a candidate read the entire hidden rubric
 * out of devtools and make `detectDiscoveries` meaningless. The prompt is baked
 * into the ephemeral credential by the server and never leaves it.
 */
export const VoiceSessionResponseSchema = z.object({
  /** Short-lived credential. Authorises exactly one realtime call. */
  clientSecret: z.string().min(1),
  /** ISO timestamp. The client re-mints *before* this, rather than waiting for
   * a dead connection — an expired session has no request to fail. */
  expiresAt: z.string(),
  model: z.string().min(1),
  voice: z.string().min(1),
  sampleRate: z.number().int().positive(),
  turnDetection: VoiceTurnDetectionSchema,
  /** Seconds of voice already spent on this interview, and the ceiling. Drives
   * the countdown and the spend meter (task 26). */
  accumulatedSeconds: z.number().int().nonnegative(),
  maxSessionSeconds: z.number().int().positive()
});
export type VoiceSessionResponse = z.infer<typeof VoiceSessionResponseSchema>;

/** Where the interviewer's attention is, derived from data-channel events.
 *
 * `speech_stopped` deliberately does NOT map to `thinking`: under semantic VAD
 * speech can stop and resume inside a single turn, and a UI that flickers to
 * "thinking" during every pause tells the candidate they are being cut off even
 * when they are not. */
export const VoiceTurnStateSchema = z.enum([
  "idle",
  "listening",
  "candidateSpeaking",
  "thinking",
  "interviewerSpeaking",
  "held"
]);
export type VoiceTurnState = z.infer<typeof VoiceTurnStateSchema>;

export const VoiceConnectionStatusSchema = z.enum([
  "idle",
  "connecting",
  "live",
  "reconnecting",
  "closed",
  "failed"
]);
export type VoiceConnectionStatus = z.infer<typeof VoiceConnectionStatusSchema>;

/** One completed spoken turn, posted back for persistence.
 *
 * `externalId` is the realtime conversation item id and doubles as the
 * idempotency key: reconnects, retries and React strict-mode double-effects all
 * re-post the same turn, and a duplicated candidate answer skews the debrief
 * and double-counts discoveries. */
export const VoiceTurnSchema = z.object({
  externalId: z.string().min(1).max(200),
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20000),
  /** Phase snapshot from the turn that produced this. The timer is
   * client-owned, so pacing has to travel with the turn — same as the text
   * path. */
  phase: PhaseRuntimeInfoSchema.optional(),
  /** True when the candidate talked over the interviewer and the item was
   * truncated to what was actually heard. */
  interrupted: z.boolean().optional()
});
export type VoiceTurn = z.infer<typeof VoiceTurnSchema>;

/** Body for a session mint. The workspace snapshot is optional and advisory —
 * it only seeds the opening context, and the constraint set inside it is
 * overwritten server-side from `interviews.live_constraints_json` exactly as the
 * text path does. Nothing here is trusted. */
export const VoiceSessionRequestSchema = z.object({
  workspaceContext: workspaceContextSchema.optional()
});
export type VoiceSessionRequest = z.infer<typeof VoiceSessionRequestSchema>;

export const VoiceTurnsRequestSchema = z.object({
  turns: z.array(VoiceTurnSchema).min(1).max(20),
  /** Audio seconds consumed since the last post, for the per-interview
   * ceiling. Client-reported, like phase events. */
  audioSecondsDelta: z.number().nonnegative().max(3600).optional()
});
export type VoiceTurnsRequest = z.infer<typeof VoiceTurnsRequestSchema>;

export const VoiceTurnsResponseSchema = z.object({
  /** Turns actually inserted. A replay reports 0 and runs no post-turn work. */
  persisted: z.number().int().nonnegative(),
  /** Turns skipped because their `externalId` was already recorded. */
  duplicates: z.number().int().nonnegative(),
  accumulatedSeconds: z.number().int().nonnegative(),
  /** True once the ceiling is reached; the client must close the session. */
  ceilingReached: z.boolean()
});
export type VoiceTurnsResponse = z.infer<typeof VoiceTurnsResponseSchema>;

/** Placeholder for a candidate turn whose transcription never completed.
 *
 * A gap is far better than a dropped turn: `detectDiscoveries` reads the
 * assistant reply, and without the question it answered the transcript reads as
 * the interviewer asking something out of nowhere. */
export const INAUDIBLE_TURN_CONTENT = "[inaudible]";

/** Marker prefix on context items injected into a live session (task 24).
 *
 * These exist in the model's conversation but are not interview turns: they must
 * not be persisted, must not render in the transcript, and must not reach the
 * debrief. One prefix, checked in one place. */
export const VOICE_CONTEXT_ITEM_PREFIX = "[workspace]";

/** Realtime audio pricing, used only for the client-side spend estimate.
 * Documented at developers.openai.com/api/docs/pricing (August 2026). */
export const VOICE_RATE_USD_PER_MILLION_INPUT_TOKENS = 32;
export const VOICE_RATE_USD_PER_MILLION_OUTPUT_TOKENS = 64;
/** Rough token-per-second rates for audio, from OpenAI's own worked example:
 * ~600 tokens per minute heard, ~1200 per minute spoken. */
export const VOICE_INPUT_TOKENS_PER_SECOND = 10;
export const VOICE_OUTPUT_TOKENS_PER_SECOND = 20;

/**
 * Estimated spend for a voice session. Deliberately approximate — the point is
 * that the candidate can see the meter running, not accounting accuracy.
 */
export function estimateVoiceCostUsd(input: {
  heardSeconds: number;
  spokenSeconds: number;
}): number {
  const heard = Math.max(0, input.heardSeconds);
  const spoken = Math.max(0, input.spokenSeconds);
  const inputUsd =
    (heard * VOICE_INPUT_TOKENS_PER_SECOND * VOICE_RATE_USD_PER_MILLION_INPUT_TOKENS) / 1_000_000;
  const outputUsd =
    (spoken * VOICE_OUTPUT_TOKENS_PER_SECOND * VOICE_RATE_USD_PER_MILLION_OUTPUT_TOKENS) / 1_000_000;
  return inputUsd + outputUsd;
}
