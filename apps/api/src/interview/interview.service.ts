import { createHash, randomUUID } from "node:crypto";
import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { buildInterviewerWelcome, getCriteriaHiddenMin } from "@sdl/ai-prompts";
import {
  DEFAULT_INTERVIEW_PLAN,
  InterviewPlanSchema,
  LiveConstraintSchema
} from "@sdl/shared";
import type {
  ConstraintProposal,
  Difficulty,
  InterviewerLevel,
  LiveConstraint,
  PhaseRuntimeInfo,
  RubricCriterion,
  SceneSummary
} from "@sdl/shared";
import { AiService } from "../ai/ai.service.js";
import { DB } from "../db/db.module.js";
import { interviewMessages, interviews, problems, solutions } from "../db/schema.js";
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

/** Progress view returned by `getCriteriaProgress`. Counts only — no text or
 * hint leak. The Problem rail's discovery indicator binds to this. */
type CriteriaProgressView = {
  totals: { total: number; core: number; expected: number; stretch: number };
  hidden: { total: number; discovered: number; core: number; coreDiscovered: number };
  visible: { total: number };
  /** IDs of criteria already surfaced (via seed for visible, via interviewer
   * / candidate / match for hidden). The rail uses this to mark live
   * constraints with `discoveredFromCriterionId` as "discovery" pills. */
  discoveredCriterionIds: string[];
};

const SCENE_HASH_TTL_SECONDS = 60 * 60 * 4;

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
    const seedConstraints: LiveConstraint[] = (problem.constraintsJson ?? []).map(
      (text: string) => ({
        id: randomUUID(),
        text,
        origin: "seed" as const,
        status: "active" as const,
        addedAt: new Date().toISOString()
      })
    );

    // Generate the per-interview rubric synchronously. Worst case ~1-3s
    // extra latency; if the LLM call fails we degrade gracefully and keep
    // criteria=null (legacy interviews already work that way).
    const criteria = await this.generateCriteriaSafely({
      problemId: input.problemId,
      problemTitle: problem.title,
      problemStatement: problem.statement,
      difficulty: problem.difficulty as Difficulty,
      interviewerLevel: input.interviewerLevel,
      seedConstraints: problem.constraintsJson ?? []
    });

    const inserted = await this.db
      .insert(interviews)
      .values({
        problemId: input.problemId,
        interviewerLevel: input.interviewerLevel,
        status: "active",
        liveConstraintsJson: seedConstraints,
        pendingProposalsJson: [],
        criteriaJson: criteria
      })
      .returning();

    const session = inserted[0];
    const planRaw = problem.interviewPlanJson;
    const planParsed = InterviewPlanSchema.safeParse(planRaw);
    const plan = planParsed.success ? planParsed.data : DEFAULT_INTERVIEW_PLAN;
    const welcome = buildInterviewerWelcome(problem.title, plan);
    await this.db.insert(interviewMessages).values({
      interviewId: session.id,
      role: "assistant",
      content: welcome
    });

    return session;
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
  }): Promise<RubricCriterion[] | null> {
    try {
      const existingCriteria = await this.collectExistingCriteriaForProblem(input.problemId);
      const baseInput = {
        title: input.problemTitle,
        statement: input.problemStatement,
        difficulty: input.difficulty,
        interviewerLevel: input.interviewerLevel,
        seedConstraints: input.seedConstraints,
        existingCriteria: existingCriteria.length > 0 ? existingCriteria : undefined
      };

      const hiddenMin = getCriteriaHiddenMin(input.difficulty);
      let generated = await this.aiService.generateCriteria(baseInput);

      // Safety net: if the model under-delivered on the discovery floor,
      // retry exactly once with an explicit correction. Without this, prompt
      // wording alone is sometimes ignored under structured-output schemas.
      const hiddenCount = generated.filter((c) => c.visibility === "hidden").length;
      if (hiddenCount < hiddenMin) {
        generated = await this.aiService.generateCriteria({
          ...baseInput,
          regenerationReason: `Your previous attempt produced only ${hiddenCount} criteria with visibility="hidden", but this difficulty requires AT LEAST ${hiddenMin}. Generate a fresh rubric and ensure visibility="hidden" appears on at least ${hiddenMin} criteria.`
        });
      }

      // Pre-mark `visible` criteria as discovered (origin=seed) so the rail's
      // discovery indicator doesn't claim the candidate needs to "find"
      // things they can already read on the Problem rail.
      const now = new Date().toISOString();
      return generated.map((c) =>
        c.visibility === "visible" && !c.discoveredVia
          ? { ...c, discoveredVia: { kind: "seed" as const, at: now } }
          : c
      );
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
      const list = row.criteriaJson as RubricCriterion[] | null;
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

  async updateLevel(interviewId: string, interviewerLevel: InterviewerLevel) {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    if (!sessionRows[0]) throw new NotFoundException("Interview not found");

    const updated = await this.db
      .update(interviews)
      .set({ interviewerLevel })
      .where(eq(interviews.id, interviewId))
      .returning();

    return updated[0];
  }

  async sendMessage(interviewId: string, content: string, workspaceContext?: WorkspaceContext) {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) throw new NotFoundException("Interview not found");

    const problemRows = await this.db.select().from(problems).where(eq(problems.id, session.problemId));
    const problem = problemRows[0];
    if (!problem) throw new NotFoundException("Problem not found");

    const historyRows = await this.db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewId, interviewId))
      .orderBy(asc(interviewMessages.createdAt));

    await this.db.insert(interviewMessages).values({
      interviewId,
      role: "user",
      content
    });

    const sceneUnchanged = await this.markAndCompareSceneHash(
      `interview:${interviewId}:sceneHash`,
      workspaceContext?.sceneSummary
    );

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
    const criteria = (session.criteriaJson as RubricCriterion[] | null) ?? undefined;
    const discoveredCriterionIds = criteria
      ? criteria.filter((c) => c.discoveredVia).map((c) => c.id)
      : undefined;

    const stream = this.aiService.streamInterviewer({
      interviewerLevel: session.interviewerLevel,
      problemStatement: problem.statement,
      history: historyRows.map((row: any) => ({ role: row.role, content: row.content })),
      message: content,
      workspaceContext: augmentedContext,
      sceneUnchanged,
      criteria,
      discoveredCriterionIds
    });

    return stream;
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
    const next: LiveConstraint = {
      id: randomUUID(),
      text: text.trim(),
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

  async saveAssistantMessage(interviewId: string, content: string) {
    await this.db.insert(interviewMessages).values({
      interviewId,
      role: "assistant",
      content
    });
    // Two best-effort post-turn jobs run in parallel; both must NOT break
    // the chat turn if they fail.
    //  1. Free-text proposal extraction (Apply/Dismiss workflow for
    //     commitments that don't map to any pre-defined criterion).
    //  2. Criterion discovery match (auto-promotes hidden criteria to
    //     LiveConstraint rows when surfaced — no Apply step needed since
    //     discovery is pre-defined work, not new scope).
    void this.deriveConstraintProposals(interviewId, content).catch(() => {});
    void this.detectDiscoveries(interviewId, content).catch(() => {});
  }

  /** Progress-only view of the per-interview rubric — safe to call any time.
   *
   * The Problem rail uses this to render "X / Y expectations explored"
   * without leaking the hidden criterion texts. Discovered criteria are
   * already exposed via the live constraints rail (with `discoveredFromCriterionId`),
   * so callers don't need full criterion bodies for normal UI rendering.
   *
   * Returns `null` when the interview row predates per-interview criteria
   * (criteria_json IS NULL) — the UI hides the indicator in that case. */
  async getCriteriaProgress(interviewId: string): Promise<CriteriaProgressView | { criteria: null }> {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) throw new NotFoundException("Interview not found");
    const criteria: RubricCriterion[] | null =
      (session.criteriaJson as RubricCriterion[] | null) ?? null;
    if (!criteria) return { criteria: null };

    const totals = { total: criteria.length, core: 0, expected: 0, stretch: 0 };
    const hidden = { total: 0, discovered: 0, core: 0, coreDiscovered: 0 };
    const visible = { total: 0 };
    const discoveredIds: string[] = [];
    for (const c of criteria) {
      totals[c.importance] += 1;
      if (c.visibility === "hidden") {
        hidden.total += 1;
        if (c.importance === "core") hidden.core += 1;
        if (c.discoveredVia) {
          hidden.discovered += 1;
          if (c.importance === "core") hidden.coreDiscovered += 1;
          discoveredIds.push(c.id);
        }
      } else {
        visible.total += 1;
        if (c.discoveredVia) discoveredIds.push(c.id);
      }
    }
    return { totals, hidden, visible, discoveredCriterionIds: discoveredIds };
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

    const criteria: RubricCriterion[] | null =
      (session.criteriaJson as RubricCriterion[] | null) ?? null;
    return { criteria };
  }

  /** Internal helper for SolutionsService — reads the criteria column without
   * the validation-submitted gate (the validator obviously needs the full
   * set BEFORE the candidate sees it). Not exposed via HTTP. */
  async getCriteriaForValidation(interviewId: string): Promise<RubricCriterion[] | null> {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) return null;
    return (session.criteriaJson as RubricCriterion[] | null) ?? null;
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
      const criteria = await this.generateCriteriaSafely({
        problemId: row.problemId,
        problemTitle: problem.title,
        problemStatement: problem.statement,
        difficulty: problem.difficulty as Difficulty,
        interviewerLevel: row.interviewerLevel as InterviewerLevel,
        seedConstraints: problem.constraintsJson ?? []
      });
      if (!criteria) {
        skipped += 1;
        continue;
      }
      await this.db
        .update(interviews)
        .set({ criteriaJson: criteria })
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

    const criteria = await this.generateCriteriaSafely({
      problemId: session.problemId,
      problemTitle: problem.title,
      problemStatement: problem.statement,
      difficulty: problem.difficulty as Difficulty,
      interviewerLevel: session.interviewerLevel as InterviewerLevel,
      seedConstraints: problem.constraintsJson ?? []
    });

    await this.db
      .update(interviews)
      .set({ criteriaJson: criteria })
      .where(eq(interviews.id, interviewId));

    return { criteria };
  }

  private async detectDiscoveries(interviewId: string, lastAssistantMessage: string) {
    const sessionRows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const session = sessionRows[0];
    if (!session) return;

    const criteria: RubricCriterion[] | null =
      (session.criteriaJson as RubricCriterion[] | null) ?? null;
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
    const activeTexts = new Set(
      liveConstraints
        .filter((c) => c.status === "active")
        .map((c) => c.text.toLowerCase().trim())
    );
    const newConstraints: LiveConstraint[] = [];
    for (const m of matches) {
      const criterion = criteria.find((c) => c.id === m.id);
      if (!criterion) continue;
      if (activeTexts.has(criterion.text.toLowerCase().trim())) continue;
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
        criteriaJson: updatedCriteria,
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
