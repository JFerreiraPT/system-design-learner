import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { getProblemNarrative, getRubricCriteria } from "@sdl/shared";
import type { Difficulty, RubricCriterion, Track } from "@sdl/shared";
import { desc, eq, isNull, or, sql } from "drizzle-orm";
import { AiService } from "../ai/ai.service.js";
import { DB } from "../db/db.module.js";
import { interviews, problems, solutions } from "../db/schema.js";
import { REDIS } from "../redis/redis.module.js";

@Injectable()
export class ProblemsService {
  constructor(
    @Inject(DB) private readonly db: any,
    @Inject(REDIS) private readonly redis: any,
    @Inject(AiService) private readonly aiService: AiService
  ) {}

  async generate(input: { difficulty: Difficulty; topic?: string; track?: Track }) {
    const normalizedTopic = input.topic?.trim().toLowerCase();
    // Track is part of the cache identity: the same topic at the same
    // difficulty is a genuinely different problem per track.
    const cacheKey = normalizedTopic
      ? `problem:${input.difficulty}:${input.track ?? "any"}:${normalizedTopic}`
      : null;

    if (cacheKey) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    const existingRows = await this.db
      .select({
        title: problems.title,
        tags: problems.tagsJson,
        statement: problems.statement
      })
      .from(problems)
      .where(eq(problems.difficulty, input.difficulty))
      .orderBy(desc(problems.createdAt))
      .limit(30);

    const existingForPrompt = existingRows.map(
      (r: { title: string; tags: unknown; statement: string }) => {
        const tags = Array.isArray(r.tags) ? r.tags : [];
        const firstSentence = (r.statement.split(/[.!?]/)[0] ?? "").trim();
        return {
          title: r.title,
          tags,
          gist: firstSentence.slice(0, 140)
        };
      }
    );

    const generated = await this.aiService.generateProblem({
      ...input,
      existingProblems: existingForPrompt
    });
    const inserted = await this.db
      .insert(problems)
      .values({
        title: generated.title,
        statement: generated.statement,
        difficulty: input.difficulty,
        constraintsJson: generated.constraints,
        // Free-text rubric is no longer generated — structured criteria live
        // on the interview row. Keep the column non-null with an empty array
        // so the legacy validator path stays well-typed for old problems.
        evaluationRubricJson: [],
        tagsJson: generated.tags,
        track: input.track ?? null,
        estimationSpecJson: generated.estimationSpec as Record<string, unknown>,
        interviewPlanJson: generated.interviewPlan as Record<string, unknown>,
        narrativeJson: generated.narrative,
        generatedByAi: true
      })
      .returning();

    const row = inserted[0];
    if (cacheKey) {
      await this.redis.set(cacheKey, JSON.stringify(row), "EX", 900);
    }
    return row;
  }

  list() {
    return this.db.select().from(problems).orderBy(sql`${problems.createdAt} desc`);
  }

  async getById(id: string) {
    const rows = await this.db.select().from(problems).where(eq(problems.id, id));
    return rows[0] ?? null;
  }

  /**
   * Reference answer for a problem, optionally scoped to one interview.
   *
   * Two caches, deliberately. Rubrics are per-interview and differ by
   * interviewer level, so a single per-problem cache cannot serve them —
   * and an interview-scoped answer must never overwrite the generic one.
   * Without `interviewId`, or when that interview has no rubric, this is
   * byte-for-byte the pre-rubric behaviour.
   */
  async getReference(problemId: string, interviewId?: string) {
    const problem = await this.getById(problemId);
    if (!problem) throw new NotFoundException("Problem not found");

    // The reveal gate is unchanged: the candidate has to attempt the design
    // before seeing a model answer.
    const attemptRows = await this.db
      .select({ id: solutions.id })
      .from(solutions)
      .where(eq(solutions.problemId, problemId))
      .limit(1);

    if (!attemptRows.length) {
      throw new ForbiddenException(
        "Submit at least one validation attempt before viewing the reference solution."
      );
    }

    const scoped = interviewId ? await this.loadInterviewScope(problemId, interviewId) : null;

    if (scoped) {
      if (scoped.interview.referenceJson) return scoped.interview.referenceJson;

      const reference = await this.aiService.generateReference({
        title: problem.title,
        statement: problem.statement,
        difficulty: problem.difficulty as Difficulty,
        constraints: scoped.activeConstraints,
        criteria: scoped.criteria,
        signatureChallenge: getProblemNarrative(problem.narrativeJson)?.signatureChallenge
      });

      await this.db
        .update(interviews)
        .set({ referenceJson: reference as Record<string, unknown> })
        .where(eq(interviews.id, interviewId!));

      return reference;
    }

    if (problem.referenceJson) {
      return problem.referenceJson;
    }

    const reference = await this.aiService.generateReference({
      title: problem.title,
      statement: problem.statement,
      difficulty: problem.difficulty as Difficulty,
      constraints: problem.constraintsJson
    });

    await this.db
      .update(problems)
      .set({ referenceJson: reference as Record<string, unknown> })
      .where(eq(problems.id, problemId));

    return reference;
  }

  /** Live scope + rubric for an interview, or `null` when the interview does
   * not exist, belongs to another problem, or has no rubric to build against
   * (in which case the per-problem path is the right answer anyway). */
  private async loadInterviewScope(
    problemId: string,
    interviewId: string
  ): Promise<{
    interview: { referenceJson: Record<string, unknown> | null };
    activeConstraints: string[];
    criteria: RubricCriterion[];
  } | null> {
    const rows = await this.db.select().from(interviews).where(eq(interviews.id, interviewId));
    const interview = rows[0];
    if (!interview || interview.problemId !== problemId) return null;

    const criteria = getRubricCriteria(interview.criteriaJson);
    if (!criteria || criteria.length === 0) return null;

    const live = (interview.liveConstraintsJson ?? []) as Array<{
      text: string;
      status: string;
    }>;
    const activeConstraints = live.filter((c) => c.status === "active").map((c) => c.text);

    return { interview, activeConstraints, criteria };
  }

  async backfillTags() {
    const rows = await this.db
      .select()
      .from(problems)
      .where(
        or(
          isNull(problems.tagsJson),
          sql`coalesce(jsonb_typeof(${problems.tagsJson}), 'null') = 'null'`,
          sql`jsonb_array_length(coalesce(${problems.tagsJson}, '[]'::jsonb)) = 0`
        )
      );

    let updated = 0;
    for (const row of rows) {
      const tags = await this.aiService.inferTags({
        title: row.title,
        statement: row.statement,
        difficulty: row.difficulty as Difficulty
      });
      await this.db.update(problems).set({ tagsJson: tags }).where(eq(problems.id, row.id));
      updated += 1;
    }

    return { updated };
  }

  async backfillEstimationSpecs(options: { force?: boolean } = {}) {
    const baseQuery = this.db.select().from(problems);
    const rows = options.force
      ? await baseQuery
      : await baseQuery.where(isNull(problems.estimationSpecJson));

    let updated = 0;
    for (const row of rows) {
      const spec = await this.aiService.inferEstimationSpec({
        title: row.title,
        statement: row.statement,
        difficulty: row.difficulty as Difficulty,
        constraints: row.constraintsJson
      });
      await this.db
        .update(problems)
        .set({ estimationSpecJson: spec as Record<string, unknown> })
        .where(eq(problems.id, row.id));
      updated += 1;
    }

    return { updated };
  }

  /** Infer `track` for problems generated before the axis existed. Problems
   * the classifier is unsure about stay NULL — "unspecified" is a valid state,
   * and a wrong track would steer future generation and grading. */
  async backfillTracks() {
    const rows = await this.db.select().from(problems).where(isNull(problems.track));

    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const track = await this.aiService.inferTrack({
        title: row.title,
        statement: row.statement,
        difficulty: row.difficulty as Difficulty,
        tags: Array.isArray(row.tagsJson) ? row.tagsJson : []
      });
      if (!track) {
        skipped += 1;
        continue;
      }
      await this.db.update(problems).set({ track }).where(eq(problems.id, row.id));
      updated += 1;
    }

    return { updated, skipped, total: rows.length };
  }

  /** Populate `narrative_json` for problems that predate it. Not auto-run:
   * it is one model call per problem, and every consumer already falls back
   * cleanly when the column is null. */
  async backfillNarrative(options: { force?: boolean } = {}) {
    const baseQuery = this.db.select().from(problems);
    const rows = options.force
      ? await baseQuery
      : await baseQuery.where(isNull(problems.narrativeJson));

    let updated = 0;
    let skipped = 0;
    for (const row of rows) {
      const narrative = await this.aiService.inferProblemNarrative({
        title: row.title,
        statement: row.statement,
        difficulty: row.difficulty as Difficulty,
        constraints: row.constraintsJson ?? []
      });
      if (!narrative) {
        skipped += 1;
        continue;
      }
      await this.db
        .update(problems)
        .set({ narrativeJson: narrative })
        .where(eq(problems.id, row.id));
      updated += 1;
    }

    return { updated, skipped, total: rows.length };
  }

  async backfillInterviewPlans() {
    const rows = await this.db
      .select()
      .from(problems)
      .where(isNull(problems.interviewPlanJson));

    let updated = 0;
    for (const row of rows) {
      const plan = await this.aiService.inferInterviewPlan({
        title: row.title,
        statement: row.statement,
        difficulty: row.difficulty as Difficulty,
        constraints: row.constraintsJson
      });
      await this.db
        .update(problems)
        .set({ interviewPlanJson: plan as Record<string, unknown> })
        .where(eq(problems.id, row.id));
      updated += 1;
    }

    return { updated };
  }
}
