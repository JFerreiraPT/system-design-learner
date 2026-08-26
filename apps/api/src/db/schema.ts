import type {
  ConstraintProposal,
  InterviewDebrief,
  InterviewerLevel,
  LiveConstraint,
  PhaseProposalState,
  ProblemNarrative,
  SeededRubric,
  StoredInterviewRubric,
  Track
} from "@sdl/shared";
import { index, pgTable, text, timestamp, uuid, boolean, jsonb, integer } from "drizzle-orm/pg-core";

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
  /** Role archetype (`TrackSchema`). Null = unspecified, which is every
   * problem generated before this column and the default for new ones. */
  track: text("track").$type<Track | null>().default(null),
  referenceJson: jsonb("reference_json").$type<Record<string, unknown> | null>().default(null),
  estimationSpecJson: jsonb("estimation_spec_json").$type<Record<string, unknown> | null>().default(null),
  interviewPlanJson: jsonb("interview_plan_json").$type<Record<string, unknown> | null>().default(null),
  /** Interviewer-facing narrative: opening framing, the problem's signature
   * difficulty, and the three-step stall ladder. Null on every problem
   * generated before this column — all consumers fall back to today's
   * behaviour. `signatureChallenge` inside it is interviewer-private and must
   * never reach the candidate-facing UI. */
  narrativeJson: jsonb("narrative_json").$type<ProblemNarrative | null>().default(null),
  /** Hand-authored rubric for a curated problem: one canonical criteria set
   * (each criterion tagged with the level at which it goes hidden) plus the
   * interviewer playbook. Projected per interviewer level at interview start
   * by `projectRubricForLevel`, which is why one row can serve all four
   * levels where `interviews.criteria_json` cannot.
   *
   * Null on every AI-generated problem — those still generate a rubric per
   * interview, so this column only ever removes a model call, never adds a
   * requirement. */
  seededRubricJson: jsonb("seeded_rubric_json").$type<SeededRubric | null>().default(null),
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
  /** Canonical hash of validation inputs for idempotent cache hits. */
  inputHash: text("input_hash"),
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
  criteriaJson: jsonb("criteria_json").$type<StoredInterviewRubric>().default(null),
  /** Interviewer level the rubric in `criteria_json` was generated FOR.
   *
   * Needed to detect a desync after a mid-interview level change. Null means
   * "unknown" (every row written before this column), which must report
   * `rubricStale: false` — never nag about something we cannot verify. */
  criteriaLevel: text("criteria_level").$type<InterviewerLevel | null>().default(null),
  /** Single live phase-transition offer plus the phases the candidate has
   * already answered for. Null on legacy rows and until the first proposal —
   * `getPhaseProposalState` treats null as "nothing pending, nothing
   * resolved". */
  pendingPhaseProposalJson: jsonb("pending_phase_proposal_json")
    .$type<PhaseProposalState | null>()
    .default(null),
  /** Interview-scoped reference answer, built from this interview's live
   * constraints and full rubric. Kept separate from `problems.reference_json`
   * because rubrics differ per interviewer level, so one per-problem cache
   * cannot serve them all. */
  referenceJson: jsonb("reference_json").$type<Record<string, unknown> | null>().default(null),
  /** Written close-out generated once by `POST /interviews/:id/end`. Null while
   * the interview is still active and on every legacy row — the Validate tab
   * simply renders no debrief block in that case. */
  debriefJson: jsonb("debrief_json").$type<InterviewDebrief | null>().default(null),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true })
});

/** Append-only log of phase transitions for one interview.
 *
 * Telemetry, not state: the live timer stays client-owned (it is pausable and
 * lives in `localStorage`), so this table exists to make pacing *observable*
 * after the fact — which phase the candidate actually spent their time in is a
 * seniority signal we could previously neither see nor report. Reduce it with
 * `buildPhaseTimeline` from `@sdl/shared`. */
export const interviewPhaseEvents = pgTable(
  "interview_phase_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    interviewId: uuid("interview_id")
      .notNull()
      .references(() => interviews.id),
    phaseId: text("phase_id").notNull(),
    phaseIndex: integer("phase_index").notNull(),
    /** "enter" | "exit" | "reset" — see `PhaseEventKindSchema`. */
    kind: text("kind").notNull(),
    /** Client-accumulated seconds in the phase at the moment of the event.
     * Client-reported by necessity — the timer is pausable and lives in the
     * browser. Server clamps to a sane range; never trusted for billing. */
    elapsedSec: integer("elapsed_sec").notNull().default(0),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    interviewAtIdx: index("interview_phase_events_interview_at_idx").on(
      table.interviewId,
      table.at
    )
  })
);

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
  /** Interview this session was opened from, when there was one. Null for
   * standalone tutor use from the Tutor page — and for every session that
   * predates this column. */
  interviewId: uuid("interview_id").references(() => interviews.id),
  /** Cached topic labels for this session. Summarised at most once (the read
   * endpoint fills it in), so re-reading tutor usage costs no model calls. */
  topicsJson: jsonb("topics_json").$type<string[] | null>().default(null),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const tutorMessages = pgTable("tutor_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => tutorSessions.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});
