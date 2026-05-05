import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type { Difficulty } from "@sdl/shared";
import { desc, eq, isNull, or, sql } from "drizzle-orm";
import { AiService } from "../ai/ai.service.js";
import { DB } from "../db/db.module.js";
import { problems, solutions } from "../db/schema.js";
import { REDIS } from "../redis/redis.module.js";

@Injectable()
export class ProblemsService {
  constructor(
    @Inject(DB) private readonly db: any,
    @Inject(REDIS) private readonly redis: any,
    @Inject(AiService) private readonly aiService: AiService
  ) {}

  async generate(input: { difficulty: Difficulty; topic?: string }) {
    const normalizedTopic = input.topic?.trim().toLowerCase();
    const cacheKey = normalizedTopic
      ? `problem:${input.difficulty}:${normalizedTopic}`
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
        estimationSpecJson: generated.estimationSpec as Record<string, unknown>,
        interviewPlanJson: generated.interviewPlan as Record<string, unknown>,
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

  async getReference(problemId: string) {
    const problem = await this.getById(problemId);
    if (!problem) throw new NotFoundException("Problem not found");

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

  async backfillEstimationSpecs() {
    const rows = await this.db
      .select()
      .from(problems)
      .where(isNull(problems.estimationSpecJson));

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
