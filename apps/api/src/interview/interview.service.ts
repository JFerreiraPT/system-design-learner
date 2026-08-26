import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  buildInterviewerWelcome,
  getCriteriaHiddenMin,
  hasEstimationPhase
} from "@sdl/ai-prompts";
import {
  buildPhaseTimeline,
  clampPhaseElapsedSec,
  DEFAULT_INTERVIEW_PLAN,
  evaluatePhaseTransition,
  getInterviewDebrief,
  getPhaseProposalState,
  getProblemNarrative,
  getRubricCriteria,
  getRubricPlaybook,
  getSeededRubric,
  projectRubricForLevel,
  getTrack,
  EMPTY_TUTOR_USAGE,
  InterviewPlanSchema,
  LiveConstraintSchema
} from "@sdl/shared";
import type {
  ConstraintProposal,
  VoiceTurn,
  Difficulty,
  InterviewDebrief,
  InterviewPlan,
  InterviewRubric,
  InterviewerLevel,
  LiveConstraint,
  PhaseEventInput,
  PhaseProposalState,
  PhaseRuntimeInfo,
  PhaseTimeline,
  PhaseTransitionProposal,
  RubricCriterion,
  SceneSummary,
  Track,
  TutorUsage,
  ValidationFeedback
} from "@sdl/shared";
import { AiService } from "../ai/ai.service.js";
import { buildInterviewTranscript } from "../common/transcript.js";
import { DB } from "../db/db.module.js";
import {
  interviewMessages,
  interviewPhaseEvents,
  interviews,
  problems,
  solutions,
  tutorMessages,
  tutorSessions
} from "../db/schema.js";
import { REDIS } from "../redis/redis.module.js";

type WorkspaceContext = {
  problemId?: string;
  problemTitle?: string;
  problemStatement?: string;
  constraints?: string[];
  sceneSummary?: SceneSummary;
  imageBase64?: string;
  notes?: string;
  phase?: PhaseRuntimeInfo;
  estimation?: Record<string, unknown>;
  estimationChecklist?: {
    intro?: string;
    fields: Array<{ key: string; label: string; hint?: string }>;
  };
};

/** Progress view returned by `getCriteriaProgress`. Counts + **surfaced**
 * hidden texts only (safe once discovered — still no leak for undiscovered). */
type CriteriaProgressView = {
  totals: { total: number; core: number; expected: number; stretch: number };
  hidden: { total: number; discovered: number; core: number; coreDiscovered: number };
  visible: { total: number };
  /** IDs of criteria already surfaced (via seed for visible, via interviewer
   * / candidate / match for hidden). The rail uses this to mark live
   * constraints with `discoveredFromCriterionId` as "discovery" pills. */
  discoveredCriterionIds: string[];
  /** Hidden criteria already discovered this interview — text is OK to show. */
  surfacedHidden: Array<{ id: string; text: string; importance: RubricCriterion["importance"] }>;
};

const SCENE_HASH_TTL_SECONDS = 60 * 60 * 4;

/** The candidate-safe view of an interview row.
 *
 * `interviews.criteria_json` holds the rubric that this interview is *measuring*
 * — including every hidden expectation in full text, its `satisfiedBy` answers,
 * its `discoveryHints`, and its three progressive nudges, plus the playbook's
 * green and red flags. Handing that to the browser hands the candidate the
 * answer key: `detectDiscoveries` would be scoring them on expectations they
 * could read out of the network tab, and the whole visible/hidden split that
 * `getCriteriaProgress` and `revealCriteria` are so careful about becomes
 * decoration.
 *
 * So no endpoint returns a raw interview row. This is the shape they return
 * instead — deliberately an allow-list, not a `delete` of the sensitive keys,
 * because a column added later must not leak by default.
 *
 * The rubric reaches the client through exactly three doors, all narrower than
 * this one: `getCriteriaProgress` (counts, plus hidden texts only once
 * discovered), `revealCriteria` (everything, gated behind a submitted
 * validation), and the interviewer's own prompt, which never leaves the server.
 */
export type InterviewSummary = {
  id: string;
  problemId: string;
  interviewerLevel: InterviewerLevel;
  status: string;
  liveConstraintsJson: LiveConstraint[];
  pendingProposalsJson: ConstraintProposal[];
  /** Level the rubric was built for. A label, not rubric content. */
  criteriaLevel: InterviewerLevel | null;
  /** Whether a rubric exists at all — the client needs this to decide whether
   * to offer "generate criteria", and it reveals nothing about their content. */
  hasCriteria: boolean;
  voiceSeconds: number;
  startedAt: unknown;
  endedAt: unknown;
};

export function toInterviewSummary(row: Record<string, any>): InterviewSummary {
  return {
    id: row.id,
    problemId: row.problemId,
    interviewerLevel: row.interviewerLevel,
    status: row.status ?? "active",
    liveConstraintsJson: (row.liveConstraintsJson as LiveConstraint[] | null) ?? [],
    pendingProposalsJson: (row.pendingProposalsJson as ConstraintProposal[] | null) ?? [],
    criteriaLevel: (row.criteriaLevel as InterviewerLevel | null) ?? null,
    hasCriteria: getRubricCriteria(row.criteriaJson) !== null,
    voiceSeconds: Number(row.voiceSeconds ?? 0),
    startedAt: row.startedAt ?? null,
    endedAt: row.endedAt ?? null
  };
}

@Injectable()
export class InterviewService {
  constructor(
    @Inject(DB) private readonly db: any,
    @Inject(REDIS) private readonly redis: any,
    @Inject(AiService) private readonly aiService: AiService
  ) {}

  async start(input: { problemId: string; interviewerLevel: InterviewerLevel }) {
    const rows = await this.db.select().from(problems).where(eq(problems.id, input.problemId));
    if (!rows[0]) throw new NotFoundException("Problem not found");

    const problem = rows[0];
    const planRaw = problem.interviewPlanJson;
    const planParsed = InterviewPlanSchema.safeParse(planRaw);
    const plan = planParsed.success ? planParsed.data : DEFAULT_INTERVIEW_PLAN;
    const seedConstraints: LiveConstraint[] = (problem.constraintsJson ?? []).map(
      (text: string) => ({
        id: randomUUID(),
        text,
        origin: "seed" as const,
        status: "active" as const,
        addedAt: new Date().toISOString()
      })
    );

    const narrative = getProblemNarrative(problem.narrativeJson);

    // Generate the per-interview rubric synchronously. Worst case ~1-3s
    // extra latency; if the LLM call fails we degrade gracefully and keep
    // criteria=null (legacy interviews already work that way).
    const criteria = await this.generateCriteriaSafely({
      problemId: input.problemId,
      problemTitle: problem.title,
      problemStatement: problem.statement,
      difficulty: problem.difficulty as Difficulty,
      interviewerLevel: input.interviewerLevel,
      seedConstraints: problem.constraintsJson ?? [],
      phases: plan.phases.map((p) => ({ id: p.id, label: p.label })),
      signatureChallenge: narrative?.signatureChallenge,
      track: getTrack(problem.track) ?? undefined,
      seededRubric: problem.seededRubricJson
    });

    const inserted = await this.db
      .insert(interviews)
      .values({
        problemId: input.problemId,
        interviewerLevel: input.interviewerLevel,
        status: "active",
        liveConstraintsJson: seedConstraints,
        pendingProposalsJson: [],
        criteriaJson: criteria,
        // Recorded so a later level change can be detected as a desync.
        criteriaLevel: criteria ? input.interviewerLevel : null
      })
      .returning();

    const session = inserted[0];
    const welcome = buildInterviewerWelcome(problem.title, plan, narrative);
    await this.db.insert(interviewMessages).values({
      interviewId: session.id,
      role: "assistant",
      content: welcome
    });

    // Projected, never the raw row — see `toInterviewSummary`. The client only
    // reads `id` from this anyway.
    return toInterviewSummary(session);
  }

  /** Wrap criteria generation so a transient LLM failure doesn't break
   * `/interviews POST`. Returns `null` on failure — the validator and
   * interviewer prompt both already tolerate null criteria. */
  private async generateCriteriaSafely(input: {
    problemId: string;
    problemTitle: string;
    problemStatement: string;
    difficulty: Difficulty;
    interviewerLevel: InterviewerLevel;
    seedConstraints: string[];
    phases: Array<{ id: string; label: string }>;
    signatureChallenge?: string;
    track?: Track;
    /** Raw `problems.seeded_rubric_json`. Present only on curated problems. */
    seededRubric?: unknown;
  }): Promise<InterviewRubric | null> {
    // A curated problem ships its own rubric, so there is nothing to generate:
    // projecting it for this level is deterministic, costs no model call, and
    // produces the same shape the generator would. Every retry and safety net
    // below exists to correct model output, so none of it applies here.
    const seeded = getSeededRubric(input.seededRubric);
    if (seeded) {
      return projectRubricForLevel(seeded, input.interviewerLevel, new Date().toISOString());
    }

    try {
      const existingCriteria = await this.collectExistingCriteriaForProblem(input.problemId);
      const baseInput = {
        title: input.problemTitle,
        statement: input.problemStatement,
        difficulty: input.difficulty,
        interviewerLevel: input.interviewerLevel,
        seedConstraints: input.seedConstraints,
        phases: input.phases,
        existingCriteria: existingCriteria.length > 0 ? existingCriteria : undefined,
        signatureChallenge: input.signatureChallenge,
        track: input.track
      };

      const hiddenMin = getCriteriaHiddenMin(input.difficulty);
      let generated = await this.aiService.generateCriteria(baseInput);

      // Safety net: if the model under-delivered on the discovery floor,
      // retry exactly once with an explicit correction. Without this, prompt
      // wording alone is sometimes ignored under structured-output schemas.
      const hiddenCount = generated.criteria.filter((c) => c.visibility === "hidden").length;
      if (hiddenCount < hiddenMin) {
        generated = await this.aiService.generateCriteria({
          ...baseInput,
          regenerationReason: `Your previous attempt produced only ${hiddenCount} criteria with visibility="hidden", but this difficulty requires AT LEAST ${hiddenMin}. Generate a fresh rubric and ensure visibility="hidden" appears on at least ${hiddenMin} criteria.`
        });
      }

      // Same shape of safety net for estimation: if the plan sets aside a
      // phase for capacity work, the rubric has to grade it, or that phase
      // costs the candidate nothing and the Estimation tab stays decorative.
      generated = await this.ensureCapacityCriterion(baseInput, generated, input.phases);

      // Pre-mark `visible` criteria as discovered (origin=seed) so the rail's
      // discovery indicator doesn't claim the candidate needs to "find"
      // things they can already read on the Problem rail.
      const now = new Date().toISOString();
      return {
        ...generated,
        criteria: generated.criteria.map((c) =>
          c.visibility === "visible" && !c.discoveredVia
            ? { ...c, discoveredVia: { kind: "seed" as const, at: now } }
            : c
        )
      };
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error("[generateCriteriaSafely] LLM failure:", msg);
      const anyErr = err as { cause?: unknown; text?: unknown };
      if (anyErr?.cause) console.error("[generateCriteriaSafely] cause:", anyErr.cause);
      if (typeof anyErr?.text === "string") {
        console.error(
          "[generateCriteriaSafely] raw text (first 4kb):",
          anyErr.text.slice(0, 4000)
        );
      }
      return null;
    }
  }

  /** One-shot retry when the rubric skipped `capacityEstimation` on a problem
   * whose plan has an estimation phase. Mirrors the hidden-floor retry: one
   * correction attempt, then accept whatever came back rather than blocking
   * the interview on rubric perfection. */
  private async ensureCapacityCriterion(
    baseInput: Parameters<AiService["generateCriteria"]>[0],
    generated: InterviewRubric,
    phases: Array<{ id: string; label: string }>
  ): Promise<InterviewRubric> {
    if (!hasEstimationPhase(phases)) return generated;
    if (generated.criteria.some((c) => c.dimension === "capacityEstimation")) return generated;

    const retried = await this.aiService.generateCriteria({
      ...baseInput,
      regenerationReason:
        'Your previous attempt contained no criterion with dimension="capacityEstimation", but this problem\'s interview plan includes an estimation phase. Generate a fresh rubric with at least one criterion on that dimension, whose satisfiedBy bullets name the concrete quantities the candidate must estimate.'
    });

    // Only take the retry if it actually fixed the gap — otherwise the first
    // attempt is at least known to satisfy the hidden-criteria floor.
    return retried.criteria.some((c) => c.dimension === "capacityEstimation")
      ? retried
      : generated;
  }

  /** Flatten criteria from prior interviews on the same problem (dedupe by id, cap 50).
   *
   * Hidden criteria are emitted FIRST so the prompt's most important dedup
   * signal (don't repeat hidden objectives the candidate has already had a
   * chance to discover) is never truncated by the cap. */
  private async collectExistingCriteriaForProblem(
    problemId: string
  ): Promise<
    Array<{
      id: string;
      text: string;
      visibility: "visible" | "hidden";
      importance: "core" | "expected" | "stretch";
    }>
  > {
    const rows = await this.db
      .select({ criteriaJson: interviews.criteriaJson })
      .from(interviews)
      .where(and(eq(interviews.problemId, problemId), isNotNull(interviews.criteriaJson)))
      .orderBy(desc(interviews.startedAt));

    const byId = new Map<
      string,
      { text: string; visibility: "visible" | "hidden"; importance: "core" | "expected" | "stretch" }
    >();
    for (const row of rows) {
      const list = getRubricCriteria(row.criteriaJson);
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if (c?.id && c?.text && !byId.has(c.id)) {
          byId.set(c.id, {
            text: c.text,
            visibility: c.visibility,
            importance: c.importance
          });
        }
      }
    }
    const all = [...byId.entries()].map(([id, v]) => ({ id, ...v }));
    const hidden = all.filter((c) => c.visibility === "hidden");
    const visible = all.filter((c) => c.visibility === "visible");
    return [...hidden, ...visible].slice(0, 50);
  }

  /**
   * Change the interviewer level, optionally resyncing the rubric.
   *
   * The level decides the hidden/visible split, so changing it alone leaves
   * `staff`-level coaching ("do not coach toward hidden criteria") running
   * against a rubric where almost everything is already visible and pre-marked
   * discovered — a hard interview against an easy rubric, with a near-free
   * discovery score. The reverse is worse.
   *
   * Regeneration is opt-in rather than automatic because it discards every
   * `discoveredVia` mark: the candidate has to be the one to accept losing
   * their discovery progress. `rubricStale` is what lets the UI keep offering
   * the fix afterwards.
   */
  async updateLevel(
    interviewId: string,
    interviewerLevel: InterviewerLevel,
    regenerateCriteria = false
  ) {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    if (!sessionRows[0]) throw new NotFoundException("Interview not found");

    const updated = await this.db
      .update(interviews)
      .set({ interviewerLevel })
      .where(eq(interviews.id, interviewId))
      .returning();

    if (regenerateCriteria) {
      // Regenerates against the level we just wrote, and stamps
      // `criteriaLevel` with it — so the row lands in sync.
      await this.regenerateCriteria(interviewId);
    }

    const after = await this.requireInterview(interviewId);
    return {
      ...toInterviewSummary(updated[0] ?? after),
      interviewerLevel,
      criteriaLevel: after.criteriaLevel ?? null,
      rubricStale: isRubricStale(after.criteriaLevel, interviewerLevel)
    };
  }

  /**
   * Everything the interviewer prompt needs for one turn, assembled once.
   *
   * Extracted from `sendMessage` because voice (task 20) needs the identical
   * inputs to build its realtime session instructions. A second copy of this
   * assembly would drift — and the specific things it would drift on are the
   * server-authoritative constraint override and the criteria/discovery pairing,
   * which are exactly the parts that must not differ between modalities.
   *
   * Read-only: no rows are written here, so it is safe to call for a session
   * mint that may never produce a turn.
   */
  private async buildInterviewerTurnInputs(
    interviewId: string,
    workspaceContext?: WorkspaceContext
  ) {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) throw new NotFoundException("Interview not found");
    // Guard BEFORE anything is inserted: a completed interview has a debrief
    // written against a fixed transcript, so accepting one more message would
    // silently invalidate it.
    if (session.status !== "active") {
      throw new ConflictException(
        "This interview is completed. Start a new interview (or Replay) to keep practising."
      );
    }

    const problemRows = await this.db.select().from(problems).where(eq(problems.id, session.problemId));
    const problem = problemRows[0];
    if (!problem) throw new NotFoundException("Problem not found");

    const historyRows = await this.db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewId, interviewId))
      .orderBy(asc(interviewMessages.createdAt));

    // The server is the source of truth for live constraints during an
    // interview. Override whatever the client passed in workspaceContext so a
    // stale client can't make the model reason against an old scope.
    const liveConstraints =
      ((session.liveConstraintsJson as LiveConstraint[] | null) ?? [])
        .filter((c) => c.status === "active")
        .map((c) => c.text);
    const augmentedContext = workspaceContext
      ? { ...workspaceContext, constraints: liveConstraints }
      : { constraints: liveConstraints };

    // Pass per-interview criteria into the interviewer prompt so the
    // per-level coaching rules can nudge toward undiscovered hiddens.
    const criteria = getRubricCriteria(session.criteriaJson) ?? undefined;
    const playbook = getRubricPlaybook(session.criteriaJson) ?? undefined;
    const discoveredCriterionIds = criteria
      ? criteria.filter((c) => c.discoveredVia).map((c) => c.id)
      : undefined;

    // Pacing history is telemetry, so a failure to read it must never break
    // the turn — the prompt simply loses the cross-phase block.
    const phaseTimeline = await this.loadPhaseTimeline(session).catch(() => undefined);

    const pendingTransition = getPhaseProposalState(session.pendingPhaseProposalJson).pending;

    return {
      session,
      problem,
      history: historyRows.map((row: any) => ({
        role: row.role as "user" | "assistant",
        content: row.content as string
      })),
      augmentedContext,
      liveConstraints,
      criteria,
      playbook,
      discoveredCriterionIds,
      phaseTimeline,
      pendingPhaseTransition: pendingTransition
        ? { toLabel: pendingTransition.toLabel }
        : undefined,
      narrative: getProblemNarrative(problem.narrativeJson)
    };
  }

  /** Public read-only view of the same inputs, for the voice module. Named
   * separately so it is obvious at the call site that nothing is being written. */
  async getInterviewerPromptInputs(interviewId: string) {
    return this.buildInterviewerTurnInputs(interviewId);
  }

  async sendMessage(interviewId: string, content: string, workspaceContext?: WorkspaceContext) {
    const inputs = await this.buildInterviewerTurnInputs(interviewId, workspaceContext);

    await this.db.insert(interviewMessages).values({
      interviewId,
      role: "user",
      content
    });

    const sceneUnchanged = await this.markAndCompareSceneHash(
      `interview:${interviewId}:sceneHash`,
      workspaceContext?.sceneSummary
    );

    const stream = this.aiService.streamInterviewer({
      interviewerLevel: inputs.session.interviewerLevel,
      problemStatement: inputs.problem.statement,
      history: inputs.history,
      message: content,
      workspaceContext: inputs.augmentedContext,
      sceneUnchanged,
      criteria: inputs.criteria,
      playbook: inputs.playbook,
      currentPhaseId: workspaceContext?.phase?.id,
      discoveredCriterionIds: inputs.discoveredCriterionIds,
      phaseTimeline: inputs.phaseTimeline,
      pendingPhaseTransition: inputs.pendingPhaseTransition,
      narrative: inputs.narrative
    });

    return stream;
  }

  /**
   * Close out an interview: flip the lifecycle, stamp `endedAt`, and persist a
   * written debrief.
   *
   * Idempotent by design. A second call returns the stored debrief instead of
   * regenerating, because a debrief that changes each time you open it is not a
   * record of anything — and regenerating would also cost another `gpt-4o`
   * call for no new information.
   */
  async end(interviewId: string): Promise<{
    id: string;
    status: string;
    endedAt: Date | string | null;
    debrief: InterviewDebrief;
    /** True when this call returned the previously stored debrief. */
    alreadyEnded: boolean;
  }> {
    const session = await this.requireInterview(interviewId);

    if (session.status !== "active") {
      const stored = getInterviewDebrief(session.debriefJson);
      if (stored) {
        return {
          id: session.id,
          status: session.status,
          endedAt: session.endedAt,
          debrief: stored,
          alreadyEnded: true
        };
      }
      // Completed with no readable debrief (an older shape, or a crash between
      // the LLM call and the write). Fall through and generate one rather than
      // leaving the candidate with a dead end.
    }

    const problemRows = await this.db.select().from(problems).where(eq(problems.id, session.problemId));
    const problem = problemRows[0];
    if (!problem) throw new NotFoundException("Problem not found");

    const attemptRows = await this.db
      .select()
      .from(solutions)
      .where(eq(solutions.problemId, session.problemId))
      .orderBy(desc(solutions.createdAt))
      .limit(1);
    const latestAttempt = attemptRows[0];
    if (!latestAttempt) {
      throw new BadRequestException(
        "Validate your solution at least once before ending the interview — the debrief is written against a graded attempt."
      );
    }

    const messageRows = await this.db
      .select({ role: interviewMessages.role, content: interviewMessages.content })
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewId, interviewId))
      .orderBy(asc(interviewMessages.createdAt));

    const liveConstraints: LiveConstraint[] =
      (session.liveConstraintsJson as LiveConstraint[] | null) ?? [];
    const feedback = (latestAttempt.feedbackJson ?? undefined) as ValidationFeedback | undefined;
    const phaseTimeline = await this.loadPhaseTimeline(session).catch(() => undefined);
    // Context for the narrative, never a deduction — see `getTutorUsage`.
    const tutorUsage = await this.getTutorUsage(interviewId).catch(() => undefined);

    const debrief = await this.aiService.generateDebrief({
      problemTitle: problem.title,
      problemStatement: problem.statement,
      difficulty: problem.difficulty as Difficulty,
      interviewerLevel: session.interviewerLevel as InterviewerLevel,
      activeConstraints: liveConstraints.filter((c) => c.status === "active").map((c) => c.text),
      criteria: getRubricCriteria(session.criteriaJson) ?? undefined,
      playbook: getRubricPlaybook(session.criteriaJson) ?? undefined,
      scoring: feedback
        ? {
            score: feedback.score ?? latestAttempt.score ?? undefined,
            designScore: feedback.designScore,
            discoveryScore: feedback.discoveryScore,
            scoringMode: feedback.scoringMode,
            scoreBand: feedback.scoreBand,
            criteriaEvaluations: feedback.criteriaEvaluations,
            coreMissed: feedback.coreMissed,
            coreCovered: feedback.coreCovered,
            flagObservations: feedback.flagObservations,
            strengths: feedback.strengths,
            gaps: feedback.gaps,
            processAssessment: feedback.processAssessment
          }
        : undefined,
      transcript: buildInterviewTranscript(messageRows) ?? undefined,
      phaseTimeline,
      tutorUsage: tutorUsage && tutorUsage.candidateTurns > 0 ? tutorUsage : undefined
    });

    const endedAt = new Date();
    await this.db
      .update(interviews)
      .set({ status: "completed", endedAt, debriefJson: debrief })
      .where(eq(interviews.id, interviewId));

    return {
      id: session.id,
      status: "completed",
      endedAt,
      debrief,
      alreadyEnded: false
    };
  }

  /**
   * Factual tutor-usage record for this interview.
   *
   * Deliberately not a penalty and deliberately not a gate: consulting the
   * tutor is frequently the right move, and it is why the tutor exists. What
   * this fixes is that a high score with heavy tutor use means something
   * different from a high score without it, and reviewing your own session
   * weeks later you could not previously tell those apart.
   *
   * Returns zeros (never a 404) for an interview with no tutor session.
   * Topic labels are summarised at most ONCE per session and cached on the
   * row, so re-reading this costs no model calls.
   */
  async getTutorUsage(interviewId: string): Promise<TutorUsage> {
    const session = await this.requireInterview(interviewId);

    const sessionRows = await this.db
      .select()
      .from(tutorSessions)
      .where(eq(tutorSessions.interviewId, interviewId))
      .orderBy(asc(tutorSessions.createdAt));
    if (sessionRows.length === 0) return { ...EMPTY_TUTOR_USAGE };

    let candidateTurns = 0;
    let firstTurnAt: Date | null = null;
    const topics = new Set<string>();

    for (const row of sessionRows) {
      const messageRows = await this.db
        .select()
        .from(tutorMessages)
        .where(eq(tutorMessages.sessionId, row.id))
        .orderBy(asc(tutorMessages.createdAt));

      const asked = messageRows.filter(
        (m: { role: string }) => m.role === "user"
      ) as Array<{ content: string; createdAt: Date | string }>;
      candidateTurns += asked.length;

      const firstAsk = asked[0]?.createdAt;
      if (firstAsk) {
        const at = firstAsk instanceof Date ? firstAsk : new Date(firstAsk);
        if (!firstTurnAt || at < firstTurnAt) firstTurnAt = at;
      }

      const cached = Array.isArray(row.topicsJson) ? (row.topicsJson as string[]) : null;
      if (cached) {
        for (const topic of cached) topics.add(topic);
        continue;
      }
      if (asked.length === 0) continue;

      const summarised = await this.aiService.summariseTutorTopics({
        candidateTurns: asked.map((m) => m.content)
      });
      // Cache even an empty result: the point is that a second read never
      // pays for another model call.
      await this.db
        .update(tutorSessions)
        .set({ topicsJson: summarised })
        .where(eq(tutorSessions.id, row.id));
      for (const topic of summarised) topics.add(topic);
    }

    return {
      sessions: sessionRows.length,
      candidateTurns,
      firstUsedAtPhase: firstTurnAt
        ? await this.resolvePhaseLabelAt(session, firstTurnAt)
        : null,
      topics: [...topics].slice(0, 5)
    };
  }

  /** Which phase was active at `at`, from the phase-event log: the most recent
   * `enter` at or before that moment. Null when the timer was never running,
   * which is every legacy interview. */
  private async resolvePhaseLabelAt(
    session: { id: string; problemId: string },
    at: Date
  ): Promise<string | null> {
    const events = await this.db
      .select({
        phaseId: interviewPhaseEvents.phaseId,
        kind: interviewPhaseEvents.kind,
        at: interviewPhaseEvents.at
      })
      .from(interviewPhaseEvents)
      .where(eq(interviewPhaseEvents.interviewId, session.id))
      .orderBy(asc(interviewPhaseEvents.at));

    let phaseId: string | null = null;
    for (const event of events as Array<{ phaseId: string; kind: string; at: Date | string }>) {
      const eventAt = event.at instanceof Date ? event.at : new Date(event.at);
      if (eventAt > at) break;
      if (event.kind === "enter") phaseId = event.phaseId;
      else if (event.kind === "reset") phaseId = null;
    }
    if (!phaseId) return null;

    const plan = await this.loadPlanForProblem(session.problemId);
    return plan.phases.find((p) => p.id === phaseId)?.label ?? phaseId;
  }

  /** Read-only lifecycle view. The workspace polls this so a session restored
   * from `localStorage` knows whether it is still accepting messages. */
  async getStatus(interviewId: string) {
    const session = await this.requireInterview(interviewId);
    return {
      id: session.id,
      status: session.status,
      interviewerLevel: session.interviewerLevel,
      criteriaLevel: session.criteriaLevel ?? null,
      rubricStale: isRubricStale(
        session.criteriaLevel,
        session.interviewerLevel as InterviewerLevel
      ),
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      debrief: getInterviewDebrief(session.debriefJson)
    };
  }

  /** Append one phase transition to the interview's event log.
   *
   * Fire-and-forget from the client's point of view, so this must be cheap and
   * forgiving: `elapsedSec` is clamped rather than rejected, because losing a
   * pacing sample is worse than storing a capped one. */
  async recordPhaseEvent(interviewId: string, input: PhaseEventInput) {
    const session = await this.requireInterview(interviewId);
    if (session.status !== "active") {
      throw new ConflictException("This interview is completed and no longer records phase events.");
    }

    await this.db.insert(interviewPhaseEvents).values({
      interviewId,
      phaseId: input.phaseId,
      phaseIndex: input.phaseIndex,
      kind: input.kind,
      elapsedSec: clampPhaseElapsedSec(input.elapsedSec)
    });

    return { recorded: true };
  }

  /** Per-phase actual vs budget for this interview.
   *
   * Labels and budgets come from the problem's `interview_plan_json`, falling
   * back to `DEFAULT_INTERVIEW_PLAN`, so an interview with no recorded events
   * (every legacy session) still returns the full phase list at zero. */
  async getPhaseTimeline(interviewId: string): Promise<PhaseTimeline> {
    const session = await this.requireInterview(interviewId);
    return this.loadPhaseTimeline(session);
  }

  private async loadPhaseTimeline(session: {
    id: string;
    problemId: string;
    status: string;
  }): Promise<PhaseTimeline> {
    const [plan, events] = await Promise.all([
      this.loadPlanForProblem(session.problemId),
      this.db
        .select({
          phaseId: interviewPhaseEvents.phaseId,
          kind: interviewPhaseEvents.kind,
          elapsedSec: interviewPhaseEvents.elapsedSec
        })
        .from(interviewPhaseEvents)
        .where(eq(interviewPhaseEvents.interviewId, session.id))
        .orderBy(asc(interviewPhaseEvents.at))
    ]);

    return buildPhaseTimeline({
      plan,
      events: events.map((row: { phaseId: string; kind: string; elapsedSec: number }) => ({
        phaseId: row.phaseId,
        kind: row.kind === "exit" || row.kind === "reset" ? row.kind : ("enter" as const),
        elapsedSec: row.elapsedSec
      })),
      completed: session.status === "completed"
    });
  }

  private async loadPlanForProblem(problemId: string): Promise<InterviewPlan> {
    const rows = await this.db
      .select({ interviewPlanJson: problems.interviewPlanJson })
      .from(problems)
      .where(eq(problems.id, problemId));
    const parsed = InterviewPlanSchema.safeParse(rows[0]?.interviewPlanJson);
    return parsed.success ? parsed.data : DEFAULT_INTERVIEW_PLAN;
  }

  private async requireInterview(interviewId: string) {
    const rows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = rows[0];
    if (!session) throw new NotFoundException("Interview not found");
    return session;
  }

  async listMessages(interviewId: string) {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    if (!sessionRows[0]) throw new NotFoundException("Interview not found");

    return this.db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewId, interviewId))
      .orderBy(asc(interviewMessages.createdAt));
  }

  /** Read-only snapshot of the live constraint set + pending proposals. The
   * web client polls this after each chat completion so the rail stays in
   * sync with the interview row. */
  async getConstraintState(interviewId: string) {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) throw new NotFoundException("Interview not found");
    const constraints: LiveConstraint[] =
      (session.liveConstraintsJson as LiveConstraint[] | null) ?? [];
    const proposals: ConstraintProposal[] =
      (session.pendingProposalsJson as ConstraintProposal[] | null) ?? [];
    return { constraints, proposals };
  }

  /** Candidate-driven manual add. Returns the updated full state. */
  async addConstraint(interviewId: string, text: string, origin: "candidate" | "interviewer" = "candidate") {
    const { constraints, proposals } = await this.getConstraintState(interviewId);
    const trimmed = text.trim();
    const norm = trimmed.toLowerCase();
    const dupActive = constraints.some(
      (c) => c.status === "active" && c.text.toLowerCase().trim() === norm
    );
    if (dupActive) return { constraints, proposals };

    const next: LiveConstraint = {
      id: randomUUID(),
      text: trimmed,
      origin,
      status: "active",
      addedAt: new Date().toISOString()
    };
    LiveConstraintSchema.parse(next);
    const updated = [...constraints, next];
    await this.db
      .update(interviews)
      .set({ liveConstraintsJson: updated })
      .where(eq(interviews.id, interviewId));
    return { constraints: updated, proposals };
  }

  /** Soft-remove. Idempotent: removing an already-removed id is a no-op. */
  async removeConstraint(interviewId: string, constraintId: string) {
    const { constraints, proposals } = await this.getConstraintState(interviewId);
    const target = constraints.find((c) => c.id === constraintId);
    if (!target) throw new NotFoundException("Constraint not found");
    if (target.status === "removed") {
      return { constraints, proposals };
    }
    const updated = constraints.map((c) =>
      c.id === constraintId
        ? { ...c, status: "removed" as const, removedAt: new Date().toISOString() }
        : c
    );
    await this.db
      .update(interviews)
      .set({ liveConstraintsJson: updated })
      .where(eq(interviews.id, interviewId));
    return { constraints: updated, proposals };
  }

  async applyProposal(interviewId: string, proposalId: string) {
    const { constraints, proposals } = await this.getConstraintState(interviewId);
    const proposal = proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new NotFoundException("Proposal not found");

    let nextConstraints = constraints;
    if (proposal.kind === "add" && proposal.text) {
      const text = proposal.text.trim();
      const alreadyActive = constraints.some(
        (c) => c.status === "active" && c.text.toLowerCase().trim() === text.toLowerCase()
      );
      if (!alreadyActive) {
        nextConstraints = [
          ...constraints,
          {
            id: randomUUID(),
            text,
            origin: "interviewer",
            status: "active",
            addedAt: new Date().toISOString()
          }
        ];
      }
    } else if (proposal.kind === "remove" && proposal.targetConstraintId) {
      nextConstraints = constraints.map((c) =>
        c.id === proposal.targetConstraintId && c.status === "active"
          ? { ...c, status: "removed" as const, removedAt: new Date().toISOString() }
          : c
      );
    }

    const nextProposals = proposals.filter((p) => p.id !== proposalId);
    await this.db
      .update(interviews)
      .set({
        liveConstraintsJson: nextConstraints,
        pendingProposalsJson: nextProposals
      })
      .where(eq(interviews.id, interviewId));
    return { constraints: nextConstraints, proposals: nextProposals };
  }

  async dismissProposal(interviewId: string, proposalId: string) {
    const { constraints, proposals } = await this.getConstraintState(interviewId);
    const nextProposals = proposals.filter((p) => p.id !== proposalId);
    await this.db
      .update(interviews)
      .set({ pendingProposalsJson: nextProposals })
      .where(eq(interviews.id, interviewId));
    return { constraints, proposals: nextProposals };
  }

  /**
   * Persist one assistant turn and run the post-turn pipeline against it.
   *
   * `source`/`externalId` are how a voice turn arrives (task 23). When an
   * `externalId` is supplied the insert is idempotent, and the pipeline runs
   * ONLY for a genuinely new row — a replayed turn that re-ran discovery would
   * credit the same criterion twice and skew the debrief.
   *
   * Returns whether anything was inserted, so the caller can distinguish a
   * replay from a write without a second query.
   */
  async persistAssistantTurn(opts: {
    interviewId: string;
    content: string;
    /** Phase snapshot from the turn that produced this reply. The timer is
     * client-owned, so pacing has to come in with the message. */
    phase?: PhaseRuntimeInfo;
    source?: "voice";
    externalId?: string;
  }): Promise<boolean> {
    const { interviewId, content, phase, source, externalId } = opts;

    let inserted = true;
    if (externalId) {
      // ON CONFLICT DO NOTHING with no target so it satisfies the partial
      // unique index (`WHERE external_id IS NOT NULL`) without Postgres having
      // to infer the predicate. An empty `returning` means it was a replay.
      const rows = await this.db
        .insert(interviewMessages)
        .values({ interviewId, role: "assistant", content, source: source ?? null, externalId })
        .onConflictDoNothing()
        .returning({ id: interviewMessages.id });
      inserted = rows.length > 0;
    } else {
      await this.db
        .insert(interviewMessages)
        .values({ interviewId, role: "assistant", content, source: source ?? null });
    }

    if (!inserted) return false;

    // Run sequentially after the assistant row is persisted so:
    //  1. Discovery promotes criteria → live constraints before proposals run.
    //  2. The interview SSE finishes only after DB reflects discoveries, so a
    //     client refetch right after streaming sees new constraints immediately.
    //  3. The transition rule reads `discoveredVia`, so it must run last —
    //     otherwise a phase whose expectations were just surfaced would take an
    //     extra turn to be offered.
    try {
      await this.detectDiscoveries(interviewId, content);
      await this.deriveConstraintProposals(interviewId, content);
      await this.detectPhaseTransition(interviewId, phase);
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error("[persistAssistantTurn] post-turn jobs:", msg);
    }
    return true;
  }

  /** Text-path entry point. Kept so the interview controller is untouched. */
  async saveAssistantMessage(interviewId: string, content: string, phase?: PhaseRuntimeInfo) {
    await this.persistAssistantTurn({ interviewId, content, phase });
  }

  /**
   * Persist a batch of completed spoken turns.
   *
   * Voice audio never reaches the server — the browser talks to OpenAI
   * directly — so the client is the only witness to what was said and posts it
   * back. That is the same trust model the phase-event log and the scene
   * summaries already use.
   *
   * The batch is ordered by the caller in *conversation* order, not arrival
   * order: transcription completes asynchronously with respect to response
   * events, so an interviewer reply can land before the transcript of the
   * question it answered. Persisting on arrival would store the interviewer
   * answering a question the candidate had not yet asked, and the debrief is
   * graded against that.
   */
  async persistVoiceTurns(
    interviewId: string,
    turns: VoiceTurn[]
  ): Promise<{ persisted: number; duplicates: number }> {
    const session = await this.requireInterview(interviewId);
    if (session.status !== "active") {
      throw new ConflictException(
        "This interview is completed. Start a new interview (or Replay) to keep practising."
      );
    }

    let persisted = 0;
    let duplicates = 0;

    for (const turn of turns) {
      if (turn.role === "assistant") {
        const inserted = await this.persistAssistantTurn({
          interviewId,
          content: turn.content,
          phase: turn.phase,
          source: "voice",
          externalId: turn.externalId
        });
        inserted ? persisted++ : duplicates++;
        continue;
      }

      const rows = await this.db
        .insert(interviewMessages)
        .values({
          interviewId,
          role: "user",
          content: turn.content,
          source: "voice",
          externalId: turn.externalId
        })
        .onConflictDoNothing()
        .returning({ id: interviewMessages.id });
      rows.length > 0 ? persisted++ : duplicates++;
    }

    return { persisted, duplicates };
  }

  /**
   * Record this interview's total voice time, clamped to `maxSeconds`.
   *
   * Takes an absolute running total and stores `max(stored, reported)`, which
   * makes it idempotent and monotonic in one stroke: a replayed post is a no-op
   * (so a deduplicated turn is not billed twice), and a client reporting a
   * smaller number — a stale tab, a fresh session that lost its baseline, or a
   * deliberately understated one — cannot wind the meter back to buy more time.
   *
   * The ceiling is passed in rather than read here: it is configuration that
   * belongs to the voice module, and this service has no ConfigService. Reading
   * `process.env` directly would work in production and silently ignore test
   * configuration, which is the worst of both.
   */
  async addVoiceSeconds(
    interviewId: string,
    totalSeconds: number,
    maxSeconds: number
  ): Promise<{ accumulatedSeconds: number; ceilingReached: boolean }> {
    const session = await this.requireInterview(interviewId);
    const previous = Number(session.voiceSeconds ?? 0);
    const reported = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
    const accumulated = Math.min(Math.max(previous, reported), maxSeconds);

    if (accumulated !== previous) {
      await this.db
        .update(interviews)
        .set({ voiceSeconds: accumulated })
        .where(eq(interviews.id, interviewId));
    }

    return { accumulatedSeconds: accumulated, ceilingReached: accumulated >= maxSeconds };
  }

  /** Read the live transition offer (and what has already been answered for). */
  async getPhaseProposal(interviewId: string): Promise<PhaseProposalState> {
    const session = await this.requireInterview(interviewId);
    return getPhaseProposalState(session.pendingPhaseProposalJson);
  }

  /**
   * Clear the live offer and stop asking about that phase.
   *
   * Advance and "Stay here" do the same thing here on purpose: the server's
   * only job either way is to close the question. Advancing the phase itself
   * stays on the client, because the timer lives there and the server must
   * never move the candidate — the whole point of the mechanism is that the
   * candidate owns pacing.
   */
  async resolvePhaseProposal(interviewId: string): Promise<PhaseProposalState> {
    const session = await this.requireInterview(interviewId);
    const state = getPhaseProposalState(session.pendingPhaseProposalJson);
    if (!state.pending) return state;

    const next: PhaseProposalState = {
      pending: null,
      resolvedPhaseIds: state.resolvedPhaseIds.includes(state.pending.fromPhaseId)
        ? state.resolvedPhaseIds
        : [...state.resolvedPhaseIds, state.pending.fromPhaseId].slice(-64)
    };

    await this.db
      .update(interviews)
      .set({ pendingPhaseProposalJson: next })
      .where(eq(interviews.id, interviewId));
    return next;
  }

  /** Deterministic, LLM-free transition detection. Runs on every interviewer
   * turn, so it must stay cheap: one row read, one conditional write. */
  private async detectPhaseTransition(interviewId: string, phase?: PhaseRuntimeInfo) {
    if (!phase) return;

    const rows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = rows[0];
    if (!session || session.status !== "active") return;

    const state = getPhaseProposalState(session.pendingPhaseProposalJson);
    const plan = await this.loadPlanForProblem(session.problemId);

    const proposal: PhaseTransitionProposal | null = evaluatePhaseTransition({
      plan,
      phase: {
        id: phase.id ?? plan.phases[phase.index]?.id ?? "",
        index: phase.index,
        elapsedSec: clampPhaseElapsedSec(phase.elapsedSec),
        durationSec: phase.durationSec
      },
      state,
      criteria: getRubricCriteria(session.criteriaJson),
      playbook: getRubricPlaybook(session.criteriaJson),
      now: new Date().toISOString(),
      id: randomUUID()
    });
    if (!proposal) return;

    await this.db
      .update(interviews)
      .set({
        pendingPhaseProposalJson: { pending: proposal, resolvedPhaseIds: state.resolvedPhaseIds }
      })
      .where(eq(interviews.id, interviewId));
  }

  /** Progress-only view of the per-interview rubric — mostly counts.
   *
   * Includes **`surfacedHidden`**: full text of hidden criteria already
   * discovered this session (safe to show). Undiscovered hidden texts are never
   * returned. The Problem rail binds its discovery indicator here.
   *
   * Returns `null` when the interview row predates per-interview criteria
   * (criteria_json IS NULL) — the UI hides the indicator in that case. */
  async getCriteriaProgress(interviewId: string): Promise<CriteriaProgressView | { criteria: null }> {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) throw new NotFoundException("Interview not found");
    const criteria: RubricCriterion[] | null = getRubricCriteria(session.criteriaJson);
    if (!criteria) return { criteria: null };

    const totals = { total: criteria.length, core: 0, expected: 0, stretch: 0 };
    const hidden = { total: 0, discovered: 0, core: 0, coreDiscovered: 0 };
    const visible = { total: 0 };
    const discoveredIds: string[] = [];
    const surfacedHidden: CriteriaProgressView["surfacedHidden"] = [];
    for (const c of criteria) {
      totals[c.importance] += 1;
      if (c.visibility === "hidden") {
        hidden.total += 1;
        if (c.importance === "core") hidden.core += 1;
        if (c.discoveredVia) {
          hidden.discovered += 1;
          if (c.importance === "core") hidden.coreDiscovered += 1;
          discoveredIds.push(c.id);
          surfacedHidden.push({ id: c.id, text: c.text, importance: c.importance });
        }
      } else {
        visible.total += 1;
        if (c.discoveredVia) discoveredIds.push(c.id);
      }
    }
    return { totals, hidden, visible, discoveredCriterionIds: discoveredIds, surfacedHidden };
  }

  /** Full criteria payload — call only after the candidate has submitted at
   * least one validation. Mirrors the gate on `GET /problems/:id/reference`:
   * the candidate has to attempt the design before the hidden expectations
   * are revealed. The Validate panel post-mortem uses this to render the
   * covered / missed / never-asked breakdown. */
  async revealCriteria(interviewId: string) {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) throw new NotFoundException("Interview not found");

    const attemptRows = await this.db
      .select({ id: solutions.id })
      .from(solutions)
      .where(eq(solutions.problemId, session.problemId))
      .limit(1);
    if (!attemptRows.length) {
      throw new ForbiddenException(
        "Submit at least one validation attempt before revealing the hidden criteria."
      );
    }

    const criteria: RubricCriterion[] | null = getRubricCriteria(session.criteriaJson);
    return { criteria };
  }

  /** Internal helper for SolutionsService — reads the criteria column without
   * the validation-submitted gate (the validator obviously needs the full
   * set BEFORE the candidate sees it). Not exposed via HTTP. */
  async getCriteriaForValidation(interviewId: string): Promise<RubricCriterion[] | null> {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) return null;
    return getRubricCriteria(session.criteriaJson);
  }

  /** Bulk backfill: generate criteria for every active interview that
   * doesn't have any yet (criteria_json IS NULL). Mirrors the existing
   * `/problems/backfill-tags` pattern. */
  async backfillCriteria() {
    const rows = await this.db
      .select()
      .from(interviews)
      .where(isNull(interviews.criteriaJson));

    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const problemRows = await this.db.select().from(problems).where(eq(problems.id, row.problemId));
      const problem = problemRows[0];
      if (!problem) {
        skipped += 1;
        continue;
      }
      const planParsed = InterviewPlanSchema.safeParse(problem.interviewPlanJson);
      const plan = planParsed.success ? planParsed.data : DEFAULT_INTERVIEW_PLAN;
      const criteria = await this.generateCriteriaSafely({
        problemId: row.problemId,
        problemTitle: problem.title,
        problemStatement: problem.statement,
        difficulty: problem.difficulty as Difficulty,
        interviewerLevel: row.interviewerLevel as InterviewerLevel,
        seedConstraints: problem.constraintsJson ?? [],
        phases: plan.phases.map((p) => ({ id: p.id, label: p.label })),
        signatureChallenge: getProblemNarrative(problem.narrativeJson)?.signatureChallenge,
        track: getTrack(problem.track) ?? undefined
      });
      if (!criteria) {
        skipped += 1;
        continue;
      }
      await this.db
        .update(interviews)
        .set({
          criteriaJson: criteria,
          criteriaLevel: row.interviewerLevel as InterviewerLevel
        })
        .where(eq(interviews.id, row.id));
      updated += 1;
    }

    return { updated, skipped, total: rows.length };
  }

  /** Regenerate criteria from scratch — used to backfill legacy interviews
   * (criteria_json IS NULL) and as an escape hatch when the candidate
   * Replays the problem and wants a fresh hidden set. Does NOT touch live
   * constraints; it just resets criteria_json on the interview row. */
  async regenerateCriteria(interviewId: string) {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) throw new NotFoundException("Interview not found");

    const problemRows = await this.db.select().from(problems).where(eq(problems.id, session.problemId));
    const problem = problemRows[0];
    if (!problem) throw new NotFoundException("Problem not found");
    const planParsed = InterviewPlanSchema.safeParse(problem.interviewPlanJson);
    const plan = planParsed.success ? planParsed.data : DEFAULT_INTERVIEW_PLAN;

    const criteria = await this.generateCriteriaSafely({
      problemId: session.problemId,
      problemTitle: problem.title,
      problemStatement: problem.statement,
      difficulty: problem.difficulty as Difficulty,
      interviewerLevel: session.interviewerLevel as InterviewerLevel,
      seedConstraints: problem.constraintsJson ?? [],
      phases: plan.phases.map((p) => ({ id: p.id, label: p.label })),
      signatureChallenge: getProblemNarrative(problem.narrativeJson)?.signatureChallenge,
      track: getTrack(problem.track) ?? undefined,
      seededRubric: problem.seededRubricJson
    });

    const level = session.interviewerLevel as InterviewerLevel;
    await this.db
      .update(interviews)
      .set({ criteriaJson: criteria, criteriaLevel: criteria ? level : null })
      .where(eq(interviews.id, interviewId));

    // Counts, not criteria. The old shape returned the full criteria array —
    // hidden texts, nudges and all — to a caller that discards it and refetches
    // `getCriteriaProgress`, which is the endpoint designed to answer this
    // safely.
    const generated = criteria?.criteria ?? null;
    return {
      generated: generated !== null,
      count: generated?.length ?? 0,
      hiddenCount: generated?.filter((c) => c.visibility === "hidden").length ?? 0,
      criteriaLevel: criteria ? level : null,
      rubricStale: false
    };
  }

  private async detectDiscoveries(interviewId: string, lastAssistantMessage: string) {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) return;

    const criteria: RubricCriterion[] | null = getRubricCriteria(session.criteriaJson);
    if (!criteria) return;

    const undiscovered = criteria.filter(
      (c) => c.visibility === "hidden" && !c.discoveredVia
    );
    if (undiscovered.length === 0) return;

    const problemRows = await this.db.select().from(problems).where(eq(problems.id, session.problemId));
    const problem = problemRows[0];
    if (!problem) return;

    const lastUser = await this.db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewId, interviewId))
      .orderBy(asc(interviewMessages.createdAt));
    const lastUserMessage =
      [...lastUser].reverse().find((m: { role: string; content: string }) => m.role === "user")
        ?.content ?? "";
    if (!lastUserMessage) return;

    const matches = await this.aiService.matchCriteriaDiscovery({
      problemTitle: problem.title,
      problemStatement: problem.statement,
      undiscovered: undiscovered.map((c) => ({
        id: c.id,
        text: c.text,
        discoveryHints: c.discoveryHints
      })),
      lastUserMessage,
      lastAssistantMessage
    });
    if (matches.length === 0) return;

    const matchById = new Map(matches.map((m) => [m.id, m] as const));
    const now = new Date().toISOString();

    // 1. Mark criteria as discoveredVia.
    const updatedCriteria = criteria.map((c) => {
      const match = matchById.get(c.id);
      if (!match || c.discoveredVia) return c;
      return {
        ...c,
        discoveredVia: {
          kind: match.kind,
          at: now,
          rationale: match.rationale
        }
      } satisfies RubricCriterion;
    });

    // 2. Auto-promote each newly-discovered criterion into a LiveConstraint
    //    so it shows on the Problem rail with a back-link. This bypasses the
    //    Apply/Dismiss flow because the candidate already did the work of
    //    surfacing it — no additional gating needed.
    const liveConstraints: LiveConstraint[] =
      (session.liveConstraintsJson as LiveConstraint[] | null) ?? [];
    // Track texts already taken so we never insert two identical bullets in one
    // batch (e.g. duplicate rubric rows with different ids).
    const takenTexts = new Set(
      liveConstraints
        .filter((c) => c.status === "active")
        .map((c) => c.text.toLowerCase().trim())
    );
    const newConstraints: LiveConstraint[] = [];
    for (const m of matches) {
      const criterion = criteria.find((c) => c.id === m.id);
      if (!criterion) continue;
      const norm = criterion.text.toLowerCase().trim();
      if (takenTexts.has(norm)) continue;
      takenTexts.add(norm);
      newConstraints.push({
        id: randomUUID(),
        text: criterion.text,
        origin: m.kind,
        status: "active",
        addedAt: now,
        importance: criterion.importance,
        discoveredFromCriterionId: criterion.id
      });
    }

    if (newConstraints.length === 0 && updatedCriteria === criteria) return;

    await this.db
      .update(interviews)
      .set({
        criteriaJson: withUpdatedRubricCriteria(session.criteriaJson, updatedCriteria),
        liveConstraintsJson:
          newConstraints.length > 0
            ? [...liveConstraints, ...newConstraints]
            : liveConstraints
      })
      .where(eq(interviews.id, interviewId));
  }

  private async deriveConstraintProposals(interviewId: string, lastAssistantMessage: string) {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) return;

    const problemRows = await this.db.select().from(problems).where(eq(problems.id, session.problemId));
    const problem = problemRows[0];
    if (!problem) return;

    const lastUser = await this.db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewId, interviewId))
      .orderBy(asc(interviewMessages.createdAt));
    const lastUserMessage =
      [...lastUser].reverse().find((m: { role: string; content: string }) => m.role === "user")
        ?.content ?? "";
    if (!lastUserMessage) return;

    const liveRaw = (session.liveConstraintsJson as LiveConstraint[] | null) ?? [];
    const active = liveRaw.filter((c) => c.status === "active");
    const proposals = await this.aiService.extractConstraintProposals({
      problemTitle: problem.title,
      problemStatement: problem.statement,
      activeConstraints: active.map((c) => ({ id: c.id, text: c.text })),
      lastUserMessage,
      lastAssistantMessage
    });
    if (proposals.length === 0) return;

    const activeIds = new Set(active.map((c) => c.id));
    const activeTexts = new Set(active.map((c) => c.text.toLowerCase().trim()));
    const existingPending: ConstraintProposal[] =
      (session.pendingProposalsJson as ConstraintProposal[] | null) ?? [];

    const accepted: ConstraintProposal[] = [];
    for (const p of proposals) {
      if (p.kind === "add") {
        const text = p.text.trim();
        // Drop redundant proposals that just restate something already on the list.
        if (activeTexts.has(text.toLowerCase())) continue;
        accepted.push({
          id: randomUUID(),
          kind: "add",
          text,
          rationale: p.rationale,
          createdAt: new Date().toISOString()
        });
      } else {
        // Validate target id is still actually active before proposing removal.
        if (!activeIds.has(p.targetConstraintId)) continue;
        accepted.push({
          id: randomUUID(),
          kind: "remove",
          targetConstraintId: p.targetConstraintId,
          rationale: p.rationale,
          createdAt: new Date().toISOString()
        });
      }
    }
    if (accepted.length === 0) return;

    await this.db
      .update(interviews)
      .set({ pendingProposalsJson: [...existingPending, ...accepted] })
      .where(eq(interviews.id, interviewId));
  }

  /** Stores a hash of the current scene under `redisKey` and returns true iff
   * the hash matches what was last stored (i.e. the scene hasn't changed since
   * the previous turn). */
  private async markAndCompareSceneHash(
    redisKey: string,
    sceneSummary?: SceneSummary
  ): Promise<boolean> {
    if (!sceneSummary || sceneSummary.nodes.length === 0) {
      return false;
    }
    const hash = hashSceneSummary(sceneSummary);
    const previous = await this.redis.get(redisKey);
    await this.redis.set(redisKey, hash, "EX", SCENE_HASH_TTL_SECONDS);
    return previous === hash;
  }
}

function hashSceneSummary(summary: SceneSummary): string {
  const canonical = JSON.stringify({
    nodes: summary.nodes.map((n) => [n.id, n.label, n.kind ?? ""]),
    edges: summary.edges.map((e) => [e.from, e.to, e.label ?? ""])
  });
  return createHash("sha1").update(canonical).digest("hex");
}

/** True only when we KNOW the rubric was built for a different level.
 *
 * A null `criteriaLevel` means "unknown" — every interview started before the
 * column existed — and must report false. Nagging about a desync we cannot
 * verify would send candidates to regenerate (and lose discovery progress) for
 * no reason. */
export function isRubricStale(
  criteriaLevel: unknown,
  currentLevel: InterviewerLevel
): boolean {
  if (typeof criteriaLevel !== "string" || criteriaLevel.length === 0) return false;
  return criteriaLevel !== currentLevel;
}

function withUpdatedRubricCriteria(raw: unknown, criteria: RubricCriterion[]) {
  const playbook = getRubricPlaybook(raw);
  return playbook ? { criteria, playbook } : criteria;
}
