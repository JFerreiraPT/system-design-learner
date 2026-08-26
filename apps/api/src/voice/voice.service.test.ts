import assert from "node:assert/strict";
import test from "node:test";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { DEFAULT_INTERVIEW_PLAN, VoiceSessionResponseSchema } from "@sdl/shared";
import type { RubricCriterion } from "@sdl/shared";
import { AiService } from "../ai/ai.service.js";
import { interviewMessages, interviews, problems } from "../db/schema.js";
import { FakeDb, fakeRedis, type FakeRow } from "../interview/fakeDb.js";
import { InterviewService } from "../interview/interview.service.js";
import { VoiceService } from "./voice.service.js";

/** A string that appears NOWHERE except inside a hidden criterion, so any leak
 * into the client-facing response is unambiguous. */
const SENTINEL = "ZZ_SENTINEL_HIDDEN_EXPECTATION_ZZ";

const criteria: RubricCriterion[] = [
  {
    id: "tenant_isolation",
    text: `Tenant data is isolated across every path. ${SENTINEL}`,
    dimension: "security",
    importance: "core",
    visibility: "hidden",
    discoveryHints: ["How are tenant boundaries enforced?"],
    progressiveNudges: ["Who reads what?", "Where is that checked?", "Show me the guard."]
  }
];

type Fixture = {
  voice: VoiceService;
  interviewService: InterviewService;
  db: FakeDb;
  ai: { calls: string[]; lastInstructions: string | null };
};

function makeFixture(
  interviewOverrides: FakeRow = {},
  options: { messages?: FakeRow[]; env?: Record<string, string> } = {}
): Fixture {
  const interview: FakeRow = {
    id: "interview-1",
    problemId: "problem-1",
    interviewerLevel: "standard",
    status: "active",
    liveConstraintsJson: [
      { id: "c-live", text: "SERVER_SIDE_CONSTRAINT", status: "active", origin: "interviewer" }
    ],
    pendingProposalsJson: [],
    criteriaJson: criteria,
    criteriaLevel: "standard",
    pendingPhaseProposalJson: null,
    debriefJson: null,
    voiceSeconds: 0,
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
            tags: ["audit-log", "multi-tenancy"],
            constraintsJson: ["Up to 500 tenants"],
            evaluationRubricJson: [],
            interviewPlanJson: DEFAULT_INTERVIEW_PLAN,
            narrativeJson: null
          }
        ]
      ],
      [interviewMessages, options.messages ? [...options.messages] : []]
    ])
  );

  const aiStub = {
    calls: [] as string[],
    lastInstructions: null as string | null,
    async matchCriteriaDiscovery() {
      aiStub.calls.push("matchCriteriaDiscovery");
      return [];
    },
    async extractConstraintProposals() {
      aiStub.calls.push("extractConstraintProposals");
      return [];
    }
  };

  const env: Record<string, string | undefined> = {
    OPENAI_API_KEY: "sk-test-not-a-real-key",
    ...options.env
  };
  const config = {
    get: (key: string) => env[key],
    getOrThrow: (key: string) => {
      const v = env[key];
      if (v === undefined) throw new Error(`missing ${key}`);
      return v;
    }
  };

  // A REAL AiService, so `buildVoiceInstructions` genuinely embeds the hidden
  // rubric — stubbing it would make the leak test prove nothing. Only the
  // network call is replaced.
  const aiService = new AiService(config as never);
  Object.assign(aiService, {
    matchCriteriaDiscovery: aiStub.matchCriteriaDiscovery,
    extractConstraintProposals: aiStub.extractConstraintProposals
  });
  (aiService as unknown as { mintRealtimeSession: unknown }).mintRealtimeSession = async (input: {
    instructions: string;
  }) => {
    aiStub.lastInstructions = input.instructions;
    return {
      clientSecret: "ek_test_secret",
      expiresAt: "2026-08-26T08:10:00.000Z",
      model: "gpt-realtime-2.1",
      voice: "marin"
    };
  };

  const interviewService = new InterviewService(db as never, fakeRedis as never, aiService as never);
  const voice = new VoiceService(interviewService, aiService, config as never);
  return { voice, interviewService, db, ai: aiStub };
}

// --- the security property -------------------------------------------------

test("the session response never carries the hidden rubric or the API key", async () => {
  const { voice, ai } = makeFixture();
  const response = await voice.createSession("interview-1");

  // The instructions DO contain it — that is what makes the interviewer able to
  // probe for it — and the response must not.
  assert.ok(ai.lastInstructions?.includes(SENTINEL), "instructions should embed the expectation");

  const serialised = JSON.stringify(response);
  assert.ok(!serialised.includes(SENTINEL), "hidden criterion text leaked to the client");
  assert.ok(!serialised.includes("sk-test-not-a-real-key"), "API key leaked to the client");
  assert.ok(!serialised.includes("progressiveNudges"));
  assert.ok(!serialised.includes("Show me the guard."), "a nudge leaked to the client");
  assert.ok(!("instructions" in (response as Record<string, unknown>)));

  // And the shape is exactly the declared contract — no stray extra fields,
  // since strict parsing is what keeps a future field from leaking silently.
  assert.doesNotThrow(() => VoiceSessionResponseSchema.strict().parse(response));
});

test("the voice prompt speaks, and carries the server's constraints not the client's", async () => {
  const { voice, ai } = makeFixture();
  await voice.createSession("interview-1", {
    constraints: ["CLIENT_SUPPLIED_STALE_CONSTRAINT"]
  } as never);

  assert.ok(ai.lastInstructions?.includes("SERVER_SIDE_CONSTRAINT"));
  assert.ok(
    !ai.lastInstructions?.includes("CLIENT_SUPPLIED_STALE_CONSTRAINT"),
    "a stale client must not be able to redefine the scope"
  );
  // Voice modality, not the chat-panel formatting contract.
  assert.ok(ai.lastInstructions?.includes("YOU ARE SPEAKING ALOUD"));
  assert.ok(!ai.lastInstructions?.includes("Formatting rule:"));
});

test("a resumed interview does not reintroduce itself", async () => {
  const { voice, ai } = makeFixture(
    {},
    {
      messages: [
        { role: "user", content: "I would shard by tenant id." },
        { role: "assistant", content: "Why tenant id rather than time?" }
      ]
    }
  );
  await voice.createSession("interview-1");

  assert.ok(ai.lastInstructions?.includes("CONVERSATION SO FAR"));
  assert.ok(ai.lastInstructions?.includes("I would shard by tenant id."));
  assert.ok(ai.lastInstructions?.includes("do NOT reintroduce yourself"));
  // The opening framing belongs only to a fresh session.
  assert.ok(!ai.lastInstructions?.includes("OPEN THE INTERVIEW"));
});

test("the spoken interviewer sees everything the typed one sees", async () => {
  const { voice, ai } = makeFixture();

  // Exactly what the text path attaches to every message.
  await voice.createSession("interview-1", {
    problemTitle: "Multi-tenant audit log",
    sceneSummary: {
      nodes: [{ id: "n1", label: "SENTINEL_QUEUE_ON_BOARD" }],
      edges: [],
      summaryText: "2 components, 1 connection"
    },
    notes: "SENTINEL_CANDIDATE_NOTE",
    phase: {
      id: "estimate",
      label: "SENTINEL_PHASE_LABEL",
      index: 1,
      total: 4,
      elapsedSec: 120,
      durationSec: 300,
      running: true
    },
    estimation: { writesPerSec: "SENTINEL_ESTIMATE_VALUE" },
    estimationChecklist: {
      intro: "Work these out",
      fields: [{ key: "writesPerSec", label: "SENTINEL_CHECKLIST_FIELD" }]
    }
  } as never);

  const instructions = ai.lastInstructions ?? "";

  // The regression this test exists for: the mint used to be handed the delta
  // snapshot ({ scene, constraints, phaseLabel }), whose unknown keys zod
  // strips — so the spoken interviewer ran blind and could not challenge an
  // estimate it had never seen.
  for (const sentinel of [
    "SENTINEL_QUEUE_ON_BOARD",
    "SENTINEL_CANDIDATE_NOTE",
    "SENTINEL_PHASE_LABEL",
    "SENTINEL_ESTIMATE_VALUE",
    "SENTINEL_CHECKLIST_FIELD"
  ]) {
    assert.ok(instructions.includes(sentinel), `${sentinel} never reached the voice prompt`);
  }
});

test("an unparseable workspace context does not sink the session", async () => {
  // zod strips what it does not recognise; the mint must still succeed with
  // whatever survives, because voice must never block the interview.
  const { voice, ai } = makeFixture();
  await voice.createSession("interview-1", { garbage: true, phase: "not-a-phase" } as never);
  assert.ok((ai.lastInstructions ?? "").includes("SERVER_SIDE_CONSTRAINT"));
});

// --- guards ---------------------------------------------------------------

test("a completed interview refuses a voice session", async () => {
  const { voice } = makeFixture({ status: "completed" });
  await assert.rejects(() => voice.createSession("interview-1"), ConflictException);
});

test("an unknown interview is a 404, not a mint attempt", async () => {
  const db = new FakeDb(new Map<object, FakeRow[]>([[interviews, []]]));
  const service = new InterviewService(db as never, fakeRedis as never, {} as never);
  const voice = new VoiceService(service, {} as never, { get: () => undefined } as never);
  await assert.rejects(() => voice.createSession("nope"), NotFoundException);
});

test("the accumulated ceiling refuses a further session", async () => {
  const { voice } = makeFixture(
    { voiceSeconds: 1200 },
    { env: { VOICE_MAX_SESSION_MINUTES: "20" } }
  );
  await assert.rejects(() => voice.createSession("interview-1"), ConflictException);

  // One second under the ceiling still mints.
  const ok = makeFixture({ voiceSeconds: 1199 }, { env: { VOICE_MAX_SESSION_MINUTES: "20" } });
  const response = await ok.voice.createSession("interview-1");
  assert.equal(response.maxSessionSeconds, 1200);
  assert.equal(response.accumulatedSeconds, 1199);
});

// --- persistence (task 23) ------------------------------------------------

test("voice turns land in interview_messages as ordinary turns", async () => {
  const { voice, db } = makeFixture();
  const result = await voice.recordTurns(
    "interview-1",
    [
      { externalId: "item_1", role: "user", content: "I would shard by tenant id." },
      { externalId: "item_2", role: "assistant", content: "Why tenant id rather than time?" }
    ],
    42
  );

  assert.equal(result.persisted, 2);
  assert.equal(result.duplicates, 0);

  const rows = db.rowsFor(interviewMessages);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.role, r.source, r.externalId]),
    [
      ["user", "voice", "item_1"],
      ["assistant", "voice", "item_2"]
    ]
  );
  // Ordinary turns: `listMessages` and the debrief read role + content only.
  const listed = await voice["interviewService"].listMessages("interview-1");
  assert.equal(listed.length, 2);
});

test("re-posting a turn inserts nothing and re-runs no post-turn work", async () => {
  const { voice, db, ai } = makeFixture();
  const turns = [
    { externalId: "item_1", role: "user" as const, content: "Sharding by tenant." },
    { externalId: "item_2", role: "assistant" as const, content: "What about hot tenants?" }
  ];

  const first = await voice.recordTurns("interview-1", turns, 10);
  assert.equal(first.persisted, 2);
  const callsAfterFirst = [...ai.calls];
  assert.ok(callsAfterFirst.length > 0, "the post-turn pipeline should have run once");

  const replay = await voice.recordTurns("interview-1", turns, 10);
  assert.equal(replay.persisted, 0);
  assert.equal(replay.duplicates, 2);
  assert.equal(db.rowsFor(interviewMessages).length, 2, "no duplicate rows");
  // The real assertion: discovery must not run twice, or the same criterion is
  // credited twice and the debrief is graded against inflated coverage.
  assert.deepEqual(ai.calls, callsAfterFirst, "post-turn work re-ran on a replay");
});

test("the post-turn pipeline runs in dependency order for a spoken turn", async () => {
  const { voice, ai } = makeFixture(
    {},
    { messages: [{ role: "user", content: "Are audit entries ever edited?" }] }
  );
  await voice.recordTurns("interview-1", [
    { externalId: "item_a", role: "assistant", content: "Entries are append-only." }
  ]);

  // Discovery promotes criteria to live constraints BEFORE proposals read them.
  assert.deepEqual(ai.calls, ["matchCriteriaDiscovery", "extractConstraintProposals"]);
});

test("voice seconds are an absolute total, clamped to the ceiling", async () => {
  const { voice, db } = makeFixture({ voiceSeconds: 100 }, { env: { VOICE_MAX_SESSION_MINUTES: "2" } });

  const first = await voice.recordTurns(
    "interview-1",
    [{ externalId: "i1", role: "user", content: "hello" }],
    115
  );
  assert.equal(first.accumulatedSeconds, 115);
  assert.equal(first.ceilingReached, false);
  assert.equal(db.lastWrite(interviews, "voiceSeconds"), 115);

  // Ceiling is 120s; a large total clamps rather than overshooting, and reports
  // the ceiling so the client closes the session.
  const second = await voice.recordTurns(
    "interview-1",
    [{ externalId: "i2", role: "user", content: "more" }],
    600
  );
  assert.equal(second.accumulatedSeconds, 120);
  assert.equal(second.ceilingReached, true);
});

test("the meter is idempotent: a replayed post does not bill twice", async () => {
  const { voice } = makeFixture({ voiceSeconds: 0 });
  const turn = [{ externalId: "i1", role: "user" as const, content: "spoken once" }];

  const first = await voice.recordTurns("interview-1", turn, 12);
  assert.equal(first.persisted, 1);
  assert.equal(first.accumulatedSeconds, 12);

  // Same turn, same total — a retry after a response the client never saw.
  const replay = await voice.recordTurns("interview-1", turn, 12);
  assert.equal(replay.persisted, 0, "the turn is deduped");
  assert.equal(replay.duplicates, 1);
  assert.equal(replay.accumulatedSeconds, 12, "and so is the meter");
});

test("the meter never runs backwards", async () => {
  const { voice } = makeFixture({ voiceSeconds: 0 });
  await voice.recordTurns("interview-1", [{ externalId: "a", role: "user", content: "x" }], 240);

  // A stale tab, a session that lost its baseline, or an understated report:
  // none of them may buy the candidate more voice time.
  const stale = await voice.recordTurns(
    "interview-1",
    [{ externalId: "b", role: "user", content: "y" }],
    10
  );
  assert.equal(stale.accumulatedSeconds, 240);

  const negative = await voice.recordTurns(
    "interview-1",
    [{ externalId: "c", role: "user", content: "z" }],
    0
  );
  assert.equal(negative.accumulatedSeconds, 240);
});

test("a completed interview refuses posted turns", async () => {
  const { voice } = makeFixture({ status: "completed" });
  await assert.rejects(
    () => voice.recordTurns("interview-1", [{ externalId: "x", role: "user", content: "hi" }]),
    ConflictException
  );
});
