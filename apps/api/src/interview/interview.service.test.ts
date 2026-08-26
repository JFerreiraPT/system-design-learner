import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_INTERVIEW_PLAN, getPhaseProposalState } from "@sdl/shared";
import type { InterviewDebrief, PhaseRuntimeInfo, RubricCriterion } from "@sdl/shared";
import {
  interviewMessages,
  interviewPhaseEvents,
  interviews,
  problems,
  solutions,
  tutorMessages,
  tutorSessions
} from "../db/schema.js";
import { FakeDb, fakeRedis, type FakeRow } from "./fakeDb.js";
import { InterviewService, isRubricStale, toInterviewSummary } from "./interview.service.js";

const PLAN = DEFAULT_INTERVIEW_PLAN;
const FIRST = PLAN.phases[0]!;
const LAST = PLAN.phases.at(-1)!;

const criteria: RubricCriterion[] = [
  {
    id: "tenant_isolation",
    text: "Tenant data is isolated across every API and storage path.",
    dimension: "security",
    importance: "core",
    visibility: "hidden",
    discoveryHints: ["How are tenant boundaries enforced?"]
  }
];

const playbook = {
  areasToProbe: [
    {
      id: "isolation",
      label: "Isolation",
      phaseRefs: [FIRST.id],
      criterionRefs: ["tenant_isolation"],
      sampleQuestions: ["How do you keep tenants apart?"],
      progressiveNudges: ["Who reads what?", "Where is that checked?", "Show the guard."] as [
        string,
        string,
        string
      ],
      greenFlags: ["Scopes every query by tenant."],
      redFlags: ["Trusts a client-supplied tenant id."]
    }
  ],
  scoreRubric: { "1": "No design.", "2": "Shallow.", "3": "Meets bar.", "4": "Exceeds bar." }
};

/** Records which AI methods were touched, so the post-turn path can be checked
 * for accidental new model calls. */
function makeAiStub(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const stub = {
    calls,
    async matchCriteriaDiscovery() {
      calls.push("matchCriteriaDiscovery");
      return [];
    },
    async extractConstraintProposals() {
      calls.push("extractConstraintProposals");
      return [];
    },
    async summariseTutorTopics() {
      calls.push("summariseTutorTopics");
      return ["partitioning", "idempotency"];
    },
    async generateDebrief(): Promise<InterviewDebrief> {
      calls.push("generateDebrief");
      return {
        strongestSignal: "You clarified scope before drawing.",
        recommendation: "yes",
        whatWentWell: ["Asked about tenancy first."],
        whereTheyStruggled: [],
        riskAreas: [],
        studyPlan: [],
        generatedAt: "2026-08-26T09:00:00.000Z"
      };
    },
    ...overrides
  };
  return stub;
}

type Fixture = {
  service: InterviewService;
  db: FakeDb;
  ai: ReturnType<typeof makeAiStub>;
  interview: FakeRow;
};

function makeFixture(
  interviewOverrides: FakeRow = {},
  options: {
    solutions?: FakeRow[];
    messages?: FakeRow[];
    tutorSessions?: FakeRow[];
    tutorMessages?: FakeRow[];
    phaseEvents?: FakeRow[];
  } = {}
): Fixture {
  const interview: FakeRow = {
    id: "interview-1",
    problemId: "problem-1",
    interviewerLevel: "standard",
    status: "active",
    liveConstraintsJson: [],
    pendingProposalsJson: [],
    criteriaJson: null,
    pendingPhaseProposalJson: null,
    debriefJson: null,
    startedAt: new Date("2026-08-26T08:00:00.000Z"),
    endedAt: null,
    ...interviewOverrides
  };

  const db = new FakeDb(
    new Map<object, FakeRow[]>([
      [interviews, [interview]],
      [
        problems,
        [
          {
            id: "problem-1",
            title: "Multi-tenant audit log",
            statement: "Design an append-only audit log.",
            difficulty: "medium",
            constraintsJson: ["Up to 500 tenants"],
            evaluationRubricJson: [],
            interviewPlanJson: PLAN
          }
        ]
      ],
      [interviewMessages, options.messages ? [...options.messages] : []],
      [interviewPhaseEvents, options.phaseEvents ? [...options.phaseEvents] : []],
      [solutions, options.solutions ? [...options.solutions] : []],
      [tutorSessions, options.tutorSessions ? [...options.tutorSessions] : []],
      [tutorMessages, options.tutorMessages ? [...options.tutorMessages] : []]
    ])
  );

  const ai = makeAiStub();
  const service = new InterviewService(db as never, fakeRedis as never, ai as never);
  return { service, db, ai, interview };
}

function phaseInfo(overrides: Partial<PhaseRuntimeInfo> = {}): PhaseRuntimeInfo {
  return {
    id: FIRST.id,
    label: FIRST.label,
    index: 0,
    total: PLAN.phases.length,
    elapsedSec: 0,
    durationSec: FIRST.durationSec,
    running: true,
    ...overrides
  };
}

function pendingProposal(db: FakeDb) {
  return getPhaseProposalState(db.lastWrite(interviews, "pendingPhaseProposalJson")).pending;
}

test("the post-turn path adds no new AI call for phase transitions", async () => {
  // Both pre-existing best-effort jobs need real inputs to run at all: the
  // discovery matcher needs an undiscovered hidden criterion, and the proposal
  // extractor needs a candidate turn to read.
  const { service, ai, db } = makeFixture(
    { criteriaJson: { criteria, playbook } },
    { messages: [{ role: "user", content: "Are audit entries ever edited?" }] }
  );

  await service.saveAssistantMessage(
    "interview-1",
    "Let's keep going.",
    phaseInfo({ elapsedSec: FIRST.durationSec })
  );

  // Exactly the two that already existed. Transition detection is a pure rule
  // over data we already hold; paying a model to read a clock on every single
  // turn would be indefensible.
  assert.deepEqual(ai.calls, ["matchCriteriaDiscovery", "extractConstraintProposals"]);
  // ...and it still fired, so the assertion above is not passing vacuously.
  assert.equal(pendingProposal(db)?.reason, "time");
});

test("passing 80% of the suggested budget offers the next phase", async () => {
  const { service, db } = makeFixture();

  await service.saveAssistantMessage(
    "interview-1",
    "ok",
    phaseInfo({ elapsedSec: Math.ceil(FIRST.durationSec * 0.8) })
  );

  const proposal = pendingProposal(db);
  assert.equal(proposal?.fromPhaseId, FIRST.id);
  assert.equal(proposal?.toPhaseId, PLAN.phases[1]!.id);
  assert.equal(proposal?.reason, "time");
});

test("well inside the budget, nothing is offered", async () => {
  const { service, db } = makeFixture();
  await service.saveAssistantMessage("interview-1", "ok", phaseInfo({ elapsedSec: 30 }));
  assert.equal(db.lastWrite(interviews, "pendingPhaseProposalJson"), undefined);
});

test("full coverage of a phase's expectations offers the next phase early", async () => {
  const { service, db } = makeFixture({
    criteriaJson: {
      criteria: [{ ...criteria[0]!, discoveredVia: { kind: "candidate", at: "2026-08-26T08:05:00.000Z" } }],
      playbook
    }
  });

  await service.saveAssistantMessage("interview-1", "ok", phaseInfo({ elapsedSec: 10 }));

  assert.equal(pendingProposal(db)?.reason, "coverage");
});

test("an undiscovered expectation keeps the phase open", async () => {
  const { service, db } = makeFixture({
    criteriaJson: { criteria, playbook }
  });

  await service.saveAssistantMessage("interview-1", "ok", phaseInfo({ elapsedSec: 10 }));

  assert.equal(db.lastWrite(interviews, "pendingPhaseProposalJson"), undefined);
});

test("the last phase is never offered a transition", async () => {
  const { service, db } = makeFixture();

  await service.saveAssistantMessage(
    "interview-1",
    "ok",
    phaseInfo({
      id: LAST.id,
      label: LAST.label,
      index: PLAN.phases.length - 1,
      elapsedSec: LAST.durationSec * 5,
      durationSec: LAST.durationSec
    })
  );

  assert.equal(db.lastWrite(interviews, "pendingPhaseProposalJson"), undefined);
});

test("dismissing suppresses re-proposal for that phase for the rest of the session", async () => {
  const { service, db, interview } = makeFixture();

  await service.saveAssistantMessage(
    "interview-1",
    "ok",
    phaseInfo({ elapsedSec: FIRST.durationSec })
  );
  assert.ok(pendingProposal(db));

  const resolved = await service.resolvePhaseProposal("interview-1");
  assert.equal(resolved.pending, null);
  assert.deepEqual(resolved.resolvedPhaseIds, [FIRST.id]);
  // The service must not have moved the candidate — it has no phase state to
  // move, and that is the point.
  assert.equal("phaseIndex" in interview, false);

  await service.saveAssistantMessage(
    "interview-1",
    "still here",
    phaseInfo({ elapsedSec: FIRST.durationSec * 3 })
  );
  assert.equal(pendingProposal(db), null);
});

test("a legacy interview with no rubric still gets time-based offers", async () => {
  const { service, db } = makeFixture({ criteriaJson: null });

  await service.saveAssistantMessage(
    "interview-1",
    "ok",
    phaseInfo({ elapsedSec: FIRST.durationSec })
  );

  assert.equal(pendingProposal(db)?.reason, "time");
});

test("a turn with no phase snapshot never proposes", async () => {
  const { service, db } = makeFixture();
  await service.saveAssistantMessage("interview-1", "ok");
  assert.equal(db.lastWrite(interviews, "pendingPhaseProposalJson"), undefined);
});

test("an absurd elapsedSec is stored clamped, not rejected", async () => {
  const { service, db } = makeFixture();

  await service.recordPhaseEvent("interview-1", {
    phaseId: FIRST.id,
    phaseIndex: 0,
    kind: "exit",
    elapsedSec: 1e12
  });

  assert.equal(db.lastWrite(interviewPhaseEvents, "elapsedSec"), 86_400);
});

test("a completed interview records no phase events and accepts no messages", async () => {
  const { service } = makeFixture({ status: "completed" });

  await assert.rejects(
    () =>
      service.recordPhaseEvent("interview-1", {
        phaseId: FIRST.id,
        phaseIndex: 0,
        kind: "enter",
        elapsedSec: 0
      }),
    /completed/
  );

  await assert.rejects(() => service.sendMessage("interview-1", "one more thing"), /completed/);
});

test("a rejected message writes no message row", async () => {
  const { service, db } = makeFixture({ status: "completed" });
  await assert.rejects(() => service.sendMessage("interview-1", "hello"));
  assert.equal(db.rowsFor(interviewMessages).length, 0);
});

test("the phase timeline of an interview with no events is the plan at zero", async () => {
  const { service } = makeFixture();
  const timeline = await service.getPhaseTimeline("interview-1");

  assert.equal(timeline.phases.length, PLAN.phases.length);
  assert.equal(timeline.totalSec, 0);
  assert.equal(timeline.completed, false);
});

test("ending without a graded attempt is a 400, not a debrief", async () => {
  const { service, ai } = makeFixture();

  await assert.rejects(() => service.end("interview-1"), /Validate your solution at least once/);
  assert.equal(ai.calls.includes("generateDebrief"), false);
});

test("ending an interview completes it and persists the debrief", async () => {
  const { service, db, ai } = makeFixture(
    {},
    {
      solutions: [
        {
          id: "solution-1",
          problemId: "problem-1",
          score: 62,
          feedbackJson: { score: 62, designScore: 58, discoveryScore: 71 },
          createdAt: new Date("2026-08-26T08:30:00.000Z")
        }
      ],
      messages: [{ role: "user", content: "Are audit entries ever edited?" }]
    }
  );

  const result = await service.end("interview-1");

  assert.equal(result.status, "completed");
  assert.equal(result.alreadyEnded, false);
  assert.equal(ai.calls.filter((c) => c === "generateDebrief").length, 1);
  assert.equal(db.lastWrite(interviews, "status"), "completed");
  assert.ok(db.lastWrite(interviews, "endedAt"));
  assert.equal(
    (db.lastWrite(interviews, "debriefJson") as InterviewDebrief).recommendation,
    "yes"
  );
});

test("ending twice returns the stored debrief without regenerating", async () => {
  const { service, ai } = makeFixture(
    {},
    {
      solutions: [
        {
          id: "solution-1",
          problemId: "problem-1",
          score: 62,
          feedbackJson: { score: 62 },
          createdAt: new Date("2026-08-26T08:30:00.000Z")
        }
      ]
    }
  );

  const first = await service.end("interview-1");
  const second = await service.end("interview-1");

  assert.equal(second.alreadyEnded, true);
  assert.deepEqual(second.debrief, first.debrief);
  assert.equal(ai.calls.filter((c) => c === "generateDebrief").length, 1);
});

test("a rubric of unknown provenance is never reported as stale", () => {
  // Every interview started before `criteria_level` existed reports null.
  // Nagging there would push candidates to regenerate — and lose discovery
  // progress — over a desync we cannot actually verify.
  assert.equal(isRubricStale(null, "staff"), false);
  assert.equal(isRubricStale(undefined, "staff"), false);
  assert.equal(isRubricStale("", "staff"), false);
});

test("a rubric is stale only when it was built for a different level", () => {
  assert.equal(isRubricStale("guided", "guided"), false);
  assert.equal(isRubricStale("guided", "staff"), true);
  assert.equal(isRubricStale("staff", "guided"), true);
});

test("changing the level alone leaves the rubric alone and reports the desync", () => {
  const { service, db } = makeFixture({
    criteriaJson: { criteria, playbook },
    criteriaLevel: "guided",
    interviewerLevel: "guided"
  });

  return service.updateLevel("interview-1", "staff").then((result) => {
    assert.equal(result.interviewerLevel, "staff");
    assert.equal(result.rubricStale, true);
    assert.equal(result.criteriaLevel, "guided");
    // The rubric itself was not touched.
    assert.equal(db.lastWrite(interviews, "criteriaJson"), undefined);
  });
});

test("regenerating in the same request resyncs the rubric to the new level", async () => {
  const ai = {
    async generateCriteria() {
      return { criteria, playbook };
    },
    async matchCriteriaDiscovery() {
      return [];
    },
    async extractConstraintProposals() {
      return [];
    }
  };
  const interview: FakeRow = {
    id: "interview-1",
    problemId: "problem-1",
    interviewerLevel: "guided",
    status: "active",
    liveConstraintsJson: [],
    pendingProposalsJson: [],
    criteriaJson: { criteria, playbook },
    criteriaLevel: "guided",
    pendingPhaseProposalJson: null,
    debriefJson: null,
    startedAt: new Date("2026-08-26T08:00:00.000Z"),
    endedAt: null
  };
  const db = new FakeDb(
    new Map<object, FakeRow[]>([
      [interviews, [interview]],
      [
        problems,
        [
          {
            id: "problem-1",
            title: "Multi-tenant audit log",
            statement: "Design an append-only audit log.",
            difficulty: "medium",
            constraintsJson: ["Up to 500 tenants"],
            evaluationRubricJson: [],
            interviewPlanJson: PLAN
          }
        ]
      ],
      [interviewMessages, []],
      [interviewPhaseEvents, []],
      [solutions, []]
    ])
  );
  const service = new InterviewService(db as never, fakeRedis as never, ai as never);

  const result = await service.updateLevel("interview-1", "staff", true);

  assert.equal(result.rubricStale, false);
  assert.equal(db.lastWrite(interviews, "criteriaLevel"), "staff");
  assert.ok(db.lastWrite(interviews, "criteriaJson"));
});

test("an interview with no tutor session reports zeros, not a 404", async () => {
  const { service, ai } = makeFixture();
  const usage = await service.getTutorUsage("interview-1");

  assert.deepEqual(usage, {
    sessions: 0,
    candidateTurns: 0,
    firstUsedAtPhase: null,
    topics: []
  });
  assert.equal(ai.calls.includes("summariseTutorTopics"), false);
});

test("tutor usage counts candidate turns only and caches topics after one call", async () => {
  const { service, ai, db } = makeFixture(
    {},
    {
      tutorSessions: [
        {
          id: "tutor-1",
          interviewId: "interview-1",
          topicsJson: null,
          createdAt: new Date("2026-08-26T08:10:00.000Z")
        }
      ],
      tutorMessages: [
        {
          id: "tm-1",
          sessionId: "tutor-1",
          role: "user",
          content: "How should I shard this?",
          createdAt: new Date("2026-08-26T08:11:00.000Z")
        },
        {
          id: "tm-2",
          sessionId: "tutor-1",
          role: "assistant",
          content: "Consider the access pattern first…",
          createdAt: new Date("2026-08-26T08:11:30.000Z")
        },
        {
          id: "tm-3",
          sessionId: "tutor-1",
          role: "user",
          content: "What about hot keys?",
          createdAt: new Date("2026-08-26T08:12:00.000Z")
        }
      ],
      phaseEvents: [
        {
          interviewId: "interview-1",
          phaseId: FIRST.id,
          kind: "enter",
          elapsedSec: 0,
          at: new Date("2026-08-26T08:00:00.000Z")
        },
        {
          interviewId: "interview-1",
          phaseId: PLAN.phases[1]!.id,
          kind: "enter",
          elapsedSec: 0,
          at: new Date("2026-08-26T08:09:00.000Z")
        }
      ]
    }
  );

  const first = await service.getTutorUsage("interview-1");

  assert.equal(first.sessions, 1);
  // Only the questions the candidate asked count as usage.
  assert.equal(first.candidateTurns, 2);
  assert.deepEqual(first.topics, ["partitioning", "idempotency"]);
  // Resolved from the phase-event log: the second phase was active by then.
  assert.equal(first.firstUsedAtPhase, PLAN.phases[1]!.label);
  assert.equal(ai.calls.filter((c) => c === "summariseTutorTopics").length, 1);
  assert.deepEqual(db.lastWrite(tutorSessions, "topicsJson"), [
    "partitioning",
    "idempotency"
  ]);

  const second = await service.getTutorUsage("interview-1");

  assert.deepEqual(second.topics, first.topics);
  // The whole point of caching: a second read costs no model call.
  assert.equal(ai.calls.filter((c) => c === "summariseTutorTopics").length, 1);
});

test("with no phase events recorded, the first-use phase is null rather than a guess", async () => {
  const { service } = makeFixture(
    {},
    {
      tutorSessions: [
        {
          id: "tutor-1",
          interviewId: "interview-1",
          topicsJson: ["caching"],
          createdAt: new Date("2026-08-26T08:10:00.000Z")
        }
      ],
      tutorMessages: [
        {
          id: "tm-1",
          sessionId: "tutor-1",
          role: "user",
          content: "How do I invalidate this cache?",
          createdAt: new Date("2026-08-26T08:11:00.000Z")
        }
      ]
    }
  );

  const usage = await service.getTutorUsage("interview-1");
  assert.equal(usage.firstUsedAtPhase, null);
  assert.deepEqual(usage.topics, ["caching"]);
});

// ---------------------------------------------------------------------------
// The rubric must not leak through an interview response.
//
// `criteria_json` holds the answer key: every hidden expectation in full text,
// its `satisfiedBy` answers, its `discoveryHints`, and three progressive nudges.
// A candidate who can read that from the network tab is being scored on
// expectations they were handed, and the visible/hidden split that the rest of
// this service is careful about stops meaning anything.
// ---------------------------------------------------------------------------

/** Strings that exist ONLY inside the hidden rubric, so a hit is unambiguous. */
const RUBRIC_SECRETS = {
  text: "ZZ_HIDDEN_EXPECTATION_TEXT_ZZ",
  hint: "ZZ_DISCOVERY_HINT_ZZ",
  nudge: "ZZ_PROGRESSIVE_NUDGE_ZZ",
  satisfiedBy: "ZZ_SATISFIED_BY_ZZ",
  redFlag: "ZZ_RED_FLAG_ZZ",
  band: "ZZ_SCORE_BAND_ZZ"
};

const secretCriteria: RubricCriterion[] = [
  {
    id: "secret_criterion",
    text: RUBRIC_SECRETS.text,
    dimension: "security",
    importance: "core",
    visibility: "hidden",
    satisfiedBy: [RUBRIC_SECRETS.satisfiedBy],
    discoveryHints: [RUBRIC_SECRETS.hint],
    progressiveNudges: [RUBRIC_SECRETS.nudge, "sharper", "sharpest"] as [string, string, string]
  }
];

const secretPlaybook = {
  areasToProbe: [
    {
      id: "area",
      label: "Area",
      phaseRefs: [FIRST.id],
      criterionRefs: ["secret_criterion"],
      sampleQuestions: ["How is that enforced?"],
      progressiveNudges: ["gentle probe", "firmer probe", "sharp probe"] as [
        string,
        string,
        string
      ],
      greenFlags: ["Names the mechanism."],
      redFlags: [RUBRIC_SECRETS.redFlag]
    }
  ],
  scoreRubric: {
    "1": RUBRIC_SECRETS.band,
    "2": "Shallow answer.",
    "3": "Meets the bar.",
    "4": "Exceeds the bar."
  }
};

/** Every secret that appears anywhere in a serialised response. */
function leaks(response: unknown): string[] {
  const body = JSON.stringify(response ?? null);
  return Object.entries(RUBRIC_SECRETS)
    .filter(([, secret]) => body.includes(secret))
    .map(([name]) => name);
}

function secretFixture(overrides: FakeRow = {}) {
  return makeFixture({
    criteriaJson: { criteria: secretCriteria, playbook: secretPlaybook },
    criteriaLevel: "standard",
    ...overrides
  });
}

test("starting an interview does not return the rubric", async () => {
  // `start` builds its own criteria via the AI stub, so plant the secret on the
  // problem's seeded rubric — the path a curated problem actually takes.
  const { service, db } = secretFixture();
  const problemRows = db.rowsFor(problems);
  problemRows[0].seededRubricJson = { criteria: secretCriteria, playbook: secretPlaybook };

  const response = await service.start({ problemId: "problem-1", interviewerLevel: "standard" });

  assert.deepEqual(leaks(response), [], "the rubric reached the client");
  // Still useful: the client reads `id`, and the rail reads the seeded scope.
  assert.equal(typeof (response as { id: string }).id, "string");
  assert.ok(Array.isArray((response as { liveConstraintsJson: unknown[] }).liveConstraintsJson));
});

test("changing the level does not return the rubric", async () => {
  const { service } = secretFixture();
  const response = await service.updateLevel("interview-1", "hard", false);

  assert.deepEqual(leaks(response), []);
  // The contract the client actually declares still holds.
  assert.equal(response.interviewerLevel, "hard");
  assert.equal(response.criteriaLevel, "standard");
  assert.equal(response.rubricStale, true);
});

test("regenerating criteria returns counts, not criterion texts", async () => {
  const { service, db } = secretFixture();
  db.rowsFor(problems)[0].seededRubricJson = {
    criteria: secretCriteria,
    playbook: secretPlaybook
  };

  const response = await service.regenerateCriteria("interview-1");

  assert.deepEqual(leaks(response), []);
  assert.equal(response.generated, true);
  assert.ok(response.count >= 1);
  assert.equal(response.rubricStale, false);
});

test("the progress view still withholds undiscovered hidden texts", async () => {
  const { service } = secretFixture();
  const progress = await service.getCriteriaProgress("interview-1");

  // Counts are safe and are the point of this endpoint.
  assert.deepEqual(leaks(progress), []);
  assert.equal((progress as { hidden: { total: number } }).hidden.total, 1);
});

test("a DISCOVERED hidden criterion may surface its text, but never its coaching", async () => {
  const discovered: RubricCriterion[] = [
    { ...secretCriteria[0], discoveredVia: { at: "2026-08-26T09:00:00.000Z", kind: "match" } }
  ];
  const { service } = makeFixture({
    criteriaJson: { criteria: discovered, playbook: secretPlaybook },
    criteriaLevel: "standard"
  });

  const progress = await service.getCriteriaProgress("interview-1");
  // The expectation itself is fair game once the candidate has surfaced it —
  // that is what the reveal is for. The nudges and answers are not.
  assert.deepEqual(leaks(progress).sort(), ["text"]);
});

test("the summary is an allow-list, so a new column cannot leak by default", () => {
  const summary = toInterviewSummary({
    id: "i1",
    problemId: "p1",
    interviewerLevel: "standard",
    status: "active",
    criteriaJson: { criteria: secretCriteria, playbook: secretPlaybook },
    referenceJson: { secret: RUBRIC_SECRETS.text },
    debriefJson: { secret: RUBRIC_SECRETS.text },
    // Stands in for whatever gets added to this table next.
    someFutureSensitiveColumn: RUBRIC_SECRETS.text
  });

  assert.deepEqual(leaks(summary), []);
  assert.deepEqual(Object.keys(summary).sort(), [
    "criteriaLevel",
    "endedAt",
    "hasCriteria",
    "id",
    "interviewerLevel",
    "liveConstraintsJson",
    "pendingProposalsJson",
    "problemId",
    "startedAt",
    "status",
    "voiceSeconds"
  ]);
  // It still reports *whether* a rubric exists, which the client needs.
  assert.equal(summary.hasCriteria, true);
  assert.equal(toInterviewSummary({ id: "i", criteriaJson: null }).hasCriteria, false);
});
