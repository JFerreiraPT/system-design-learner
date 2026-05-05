import type { ConstraintProposal, LiveConstraint, RubricCriterion } from "@sdl/shared";
import { pgTable, text, timestamp, uuid, boolean, jsonb, integer } from "drizzle-orm/pg-core";

export const problems = pgTable("problems", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  statement: text("statement").notNull(),
  difficulty: text("difficulty").notNull(),
  constraintsJson: jsonb("constraints_json").$type<string[]>().notNull(),
  /** Legacy free-text rubric. New problems leave this empty and rely on the
   * structured criteria persisted on each interview row instead. Kept
   * non-null for back-compat with rows that predate per-interview criteria. */
  evaluationRubricJson: jsonb("evaluation_rubric_json").$type<string[]>().notNull(),
  tagsJson: jsonb("tags_json").$type<string[] | null>().default(null),
  referenceJson: jsonb("reference_json").$type<Record<string, unknown> | null>().default(null),
  estimationSpecJson: jsonb("estimation_spec_json").$type<Record<string, unknown> | null>().default(null),
  interviewPlanJson: jsonb("interview_plan_json").$type<Record<string, unknown> | null>().default(null),
  generatedByAi: boolean("generated_by_ai").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const solutions = pgTable("solutions", {
  id: uuid("id").defaultRandom().primaryKey(),
  problemId: uuid("problem_id").notNull().references(() => problems.id),
  sceneJson: text("scene_json").notNull(),
  notes: text("notes"),
  score: integer("score"),
  feedbackJson: jsonb("feedback_json").$type<Record<string, unknown> | null>(),
  estimationJson: jsonb("estimation_json").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const interviews = pgTable("interviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  problemId: uuid("problem_id").notNull().references(() => problems.id),
  interviewerLevel: text("interviewer_level").notNull(),
  status: text("status").default("active").notNull(),
  /** Live constraint set for this interview. Seeded from `problems.constraints_json`
   * at start; mutated as the conversation evolves (interviewer commits decisions,
   * candidate adds assumptions, removals are soft). Null on legacy rows that
   * predate this column — services treat null as "fall back to seed". */
  liveConstraintsJson: jsonb("live_constraints_json").$type<LiveConstraint[] | null>().default(null),
  /** AI-generated pending proposals to mutate the constraint set, awaiting
   * candidate Apply / Dismiss. Cleared as proposals are resolved. */
  pendingProposalsJson: jsonb("pending_proposals_json").$type<ConstraintProposal[] | null>().default(null),
  /** Structured rubric criteria for this interview. Generated at start time
   * from problem + difficulty + interviewerLevel; mixes `visible` criteria
   * (overlapping seed bullets the candidate can already see) and `hidden`
   * latent expectations the candidate must DISCOVER. The matcher updates
   * `discoveredVia` as the conversation progresses. Null on legacy rows
   * that started before this column existed — services treat null as
   * "no per-interview criteria; fall back to legacy rubric strings". */
  criteriaJson: jsonb("criteria_json").$type<RubricCriterion[] | null>().default(null),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true })
});

export const interviewMessages = pgTable("interview_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  interviewId: uuid("interview_id").notNull().references(() => interviews.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const tutorSessions = pgTable("tutor_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull().default("Tutor Session"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const tutorMessages = pgTable("tutor_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => tutorSessions.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});
