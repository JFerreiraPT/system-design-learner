import { createHash } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { PhaseRuntimeInfo, SceneSummary } from "@sdl/shared";
import { AiService } from "../ai/ai.service.js";
import { DB } from "../db/db.module.js";
import { tutorMessages, tutorSessions } from "../db/schema.js";
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

const SCENE_HASH_TTL_SECONDS = 60 * 60 * 4;

@Injectable()
export class TutorService {
  constructor(
    @Inject(DB) private readonly db: any,
    @Inject(REDIS) private readonly redis: any,
    @Inject(AiService) private readonly aiService: AiService
  ) {}

  async createSession(input: { title?: string }) {
    const inserted = await this.db
      .insert(tutorSessions)
      .values({ title: input.title ?? "Tutor Session" })
      .returning();
    return inserted[0];
  }

  async listSessions() {
    return this.db.select().from(tutorSessions);
  }

  async sendMessage(sessionId: string, content: string, workspaceContext?: WorkspaceContext) {
    const rows = await this.db.select().from(tutorSessions).where(eq(tutorSessions.id, sessionId));
    if (!rows[0]) throw new NotFoundException("Session not found");

    const historyRows = await this.db
      .select()
      .from(tutorMessages)
      .where(eq(tutorMessages.sessionId, sessionId))
      .orderBy(asc(tutorMessages.createdAt));

    await this.db.insert(tutorMessages).values({
      sessionId,
      role: "user",
      content
    });

    const sceneUnchanged = await this.markAndCompareSceneHash(
      `tutor:${sessionId}:sceneHash`,
      workspaceContext?.sceneSummary
    );

    return this.aiService.streamTutor({
      history: historyRows.map((row: any) => ({ role: row.role, content: row.content })),
      message: content,
      workspaceContext,
      sceneUnchanged
    });
  }

  async listMessages(sessionId: string) {
    const rows = await this.db.select().from(tutorSessions).where(eq(tutorSessions.id, sessionId));
    if (!rows[0]) throw new NotFoundException("Session not found");

    return this.db
      .select()
      .from(tutorMessages)
      .where(eq(tutorMessages.sessionId, sessionId))
      .orderBy(asc(tutorMessages.createdAt));
  }

  async saveAssistantMessage(sessionId: string, content: string) {
    await this.db.insert(tutorMessages).values({
      sessionId,
      role: "assistant",
      content
    });
  }

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
