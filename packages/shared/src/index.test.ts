import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPhaseTimeline,
  clampPhaseElapsedSec,
  DEBRIEF_RECOMMENDATION_LABELS,
  EMPTY_PHASE_PROPOSAL_STATE,
  evaluatePhaseTransition,
  getPhaseProposalState,
  DEFAULT_INTERVIEW_PLAN,
  getInterviewDebrief,
  InterviewDebriefSchema,
  InterviewPlanSchema,
  EstimationProblemSpecSchema,
  fromBaseUnit,
  getRubricCriteria,
  getRubricPlaybook,
  getSeededRubric,
  hiddenCountAtLevel,
  INTERVIEWER_LEVEL_ORDER,
  projectRubricForLevel,
  GenerateProblemInputSchema,
  InterviewRubricSchema,
  LEGACY_ESTIMATION_SPEC,
  MAX_PHASE_ELAPSED_SEC,
  normalizeEstimationSpec,
  PhaseTimelineSchema,
  toBaseUnit,
  getTrack,
  TRACK_LABELS,
  TrackSchema,
  type EstimationFieldSpec,
  type EstimationProblemSpec,
  type InterviewPlan,
  type InterviewRubric,
  type RubricCriterion
} from "./index.js";

const criterion: RubricCriterion = {
  id: "tenant_isolation",
  text: "Tenant data is isolated across every API and storage path.",
  dimension: "security",
  importance: "core",
  visibility: "hidden",
  discoveryHints: ["How should tenant boundaries be enforced?"],
  progressiveNudges: [
    "What tenant boundary matters most here?",
    "Where could tenant A accidentally read tenant B data?",
    "Make tenant isolation explicit in the API and data model."
  ],
  satisfiedBy: ["tenant_id scoped queries", "authorization checks before reads"]
};

const rubric: InterviewRubric = {
  criteria: [criterion],
  playbook: {
    areasToProbe: [
      {
        id: "auth_and_isolation",
        label: "Auth & Isolation",
        phaseRefs: ["clarify"],
        criterionRefs: ["tenant_isolation"],
        sampleQuestions: ["Walk me through the auth flow for a tenant admin."],
        progressiveNudges: [
          "Who is allowed to manage tenant users?",
          "Where is tenant authorization enforced?",
          "Show the exact check that prevents cross-tenant access."
        ],
        greenFlags: ["Separates authentication from tenant authorization."],
        redFlags: ["Treats tenant_id as a trusted client input."]
      }
    ],
    scoreRubric: {
      "1": "Misses tenant isolation and auth.",
      "2": "Mentions auth but leaves gaps.",
      "3": "Covers tenant isolation and RBAC.",
      "4": "Covers tenant isolation, audit, operations, and trade-offs."
    }
  }
};

test("rubric schema accepts the new criteria plus playbook shape", () => {
  assert.equal(InterviewRubricSchema.parse(rubric).criteria[0]?.id, "tenant_isolation");
});

test("getRubricCriteria supports legacy array rows", () => {
  assert.deepEqual(getRubricCriteria([criterion]), [criterion]);
  assert.equal(getRubricPlaybook([criterion]), null);
});

test("rubric helpers support new object rows and reject malformed input", () => {
  assert.deepEqual(getRubricCriteria(rubric), [criterion]);
  assert.equal(getRubricPlaybook(rubric)?.areasToProbe[0]?.id, "auth_and_isolation");
  assert.equal(getRubricCriteria({ criteria: [{ id: "bad" }] }), null);
  assert.equal(getRubricPlaybook({ criteria: [{ id: "bad" }] }), null);
});

function numberField(overrides: Partial<EstimationFieldSpec> = {}): EstimationFieldSpec {
  return {
    key: "payload",
    label: "Average payload",
    type: "number",
    unitKind: "bytes",
    displayUnit: "KB",
    displayMultiplier: 1024,
    expectedMagnitude: { min: 200, max: 20_000, rationale: "~1KB is typical for text." },
    ...overrides
  };
}

test("toBaseUnit and fromBaseUnit round-trip through the display multiplier", () => {
  const field = numberField();
  assert.equal(toBaseUnit(field, 1), 1024);
  assert.equal(fromBaseUnit(field, 1024), 1);
  assert.equal(fromBaseUnit(field, toBaseUnit(field, 3.5)), 3.5);

  const ms = numberField({ unitKind: "seconds", displayUnit: "ms", displayMultiplier: 0.001 });
  assert.equal(toBaseUnit(ms, 250), 0.25);
  assert.equal(fromBaseUnit(ms, 0.25), 250);
});

test("conversion is the identity without a usable multiplier", () => {
  for (const field of [
    numberField({ displayMultiplier: undefined }),
    numberField({ displayMultiplier: 0 }),
    numberField({ displayMultiplier: -5 }),
    numberField({ displayMultiplier: Number.NaN })
  ]) {
    assert.equal(toBaseUnit(field, 42), 42);
    assert.equal(fromBaseUnit(field, 42), 42);
  }
});

test("conversion round-trips for every unit family", () => {
  const families: Array<EstimationFieldSpec["unitKind"]> = [
    "count",
    "bytes",
    "seconds",
    "ratio",
    "currency"
  ];
  for (const unitKind of families) {
    const field = numberField({ unitKind, displayMultiplier: 60 });
    assert.equal(fromBaseUnit(field, toBaseUnit(field, 7)), 7, `round-trip failed for ${unitKind}`);
  }
});

test("normalizeEstimationSpec strips unit metadata from text fields", () => {
  const spec: EstimationProblemSpec = {
    fields: [
      numberField(),
      numberField({
        key: "notes",
        label: "Assumptions",
        type: "text"
      })
    ]
  };
  const out = normalizeEstimationSpec(spec);
  const textField = out.fields[1]!;
  assert.equal(textField.unitKind, undefined);
  assert.equal(textField.displayUnit, undefined);
  assert.equal(textField.displayMultiplier, undefined);
  assert.equal(textField.expectedMagnitude, undefined);
  // the number field is untouched
  assert.deepEqual(out.fields[0], spec.fields[0]);
});

test("normalizeEstimationSpec drops bands narrower than one order of magnitude", () => {
  const tooTight = normalizeEstimationSpec({
    fields: [numberField({ expectedMagnitude: { min: 1000, max: 5000 } })]
  });
  assert.equal(tooTight.fields[0]?.expectedMagnitude, undefined);

  const exactlyTenX = normalizeEstimationSpec({
    fields: [numberField({ expectedMagnitude: { min: 1000, max: 10_000 } })]
  });
  assert.deepEqual(exactlyTenX.fields[0]?.expectedMagnitude, { min: 1000, max: 10_000 });
});

test("normalizeEstimationSpec drops inverted, zero and non-finite bands", () => {
  const cases = [
    { min: 10_000, max: 100 },
    { min: 0, max: 100_000 },
    { min: 1, max: Number.POSITIVE_INFINITY },
    { min: Number.NaN, max: 100 }
  ];
  for (const expectedMagnitude of cases) {
    const out = normalizeEstimationSpec({
      fields: [numberField({ expectedMagnitude })]
    });
    assert.equal(
      out.fields[0]?.expectedMagnitude,
      undefined,
      `expected ${JSON.stringify(expectedMagnitude)} to be dropped`
    );
  }
});

test("normalizeEstimationSpec drops non-positive display multipliers", () => {
  const out = normalizeEstimationSpec({
    fields: [numberField({ displayMultiplier: 0 })]
  });
  assert.equal(out.fields[0]?.displayMultiplier, undefined);
  // the rest of the field survives
  assert.equal(out.fields[0]?.unitKind, "bytes");
});

test("the legacy spec still parses and normalizes to itself", () => {
  assert.doesNotThrow(() => EstimationProblemSpecSchema.parse(LEGACY_ESTIMATION_SPEC));
  assert.deepEqual(normalizeEstimationSpec(LEGACY_ESTIMATION_SPEC), LEGACY_ESTIMATION_SPEC);
});

test("specs without any of the new fields parse unchanged", () => {
  const legacyShape = {
    intro: "Estimate the basics.",
    fields: [
      { key: "dau", label: "DAU", type: "number", hint: "Daily active users" },
      { key: "notes", label: "Notes", type: "text" },
      { key: "payload", label: "Payload", type: "number", unit: "bytes" }
    ],
    derivedHints: ["Sanity check the write path."]
  };
  const parsed = EstimationProblemSpecSchema.parse(legacyShape);
  assert.deepEqual(parsed, legacyShape);
  assert.deepEqual(normalizeEstimationSpec(parsed), legacyShape);
});

const twoPhasePlan: InterviewPlan = {
  phases: [
    {
      id: "clarify",
      label: "Clarify",
      durationSec: 300,
      candidateGuide:
        "Scope the problem before drawing anything. Ask about users, scale, and what v1 must do."
    },
    {
      id: "deep_dive",
      label: "Deep dive",
      durationSec: 600,
      candidateGuide:
        "Pick the single riskiest part of the design and go deep on failure modes and scaling."
    }
  ]
};

test("clampPhaseElapsedSec caps absurd values instead of rejecting them", () => {
  assert.equal(clampPhaseElapsedSec(0), 0);
  assert.equal(clampPhaseElapsedSec(431), 431);
  assert.equal(clampPhaseElapsedSec(431.6), 432);
  assert.equal(clampPhaseElapsedSec(-90), 0);
  assert.equal(clampPhaseElapsedSec(1e12), MAX_PHASE_ELAPSED_SEC);
  // Non-finite input is corrupt, not "very large": reporting 24h would be a
  // fabricated number, so it degrades to "nothing recorded" instead.
  assert.equal(clampPhaseElapsedSec(Number.POSITIVE_INFINITY), 0);
  assert.equal(clampPhaseElapsedSec(Number.NaN), 0);
  assert.equal(clampPhaseElapsedSec("nope"), 0);
});

test("an interview with zero phase events yields the full plan at zero", () => {
  const timeline = buildPhaseTimeline({
    plan: DEFAULT_INTERVIEW_PLAN,
    events: [],
    completed: false
  });

  assert.equal(PhaseTimelineSchema.safeParse(timeline).success, true);
  assert.equal(timeline.phases.length, DEFAULT_INTERVIEW_PLAN.phases.length);
  assert.equal(timeline.totalSec, 0);
  assert.equal(timeline.completed, false);
  assert.ok(timeline.phases.every((p) => p.actualSec === 0 && !p.overBudget));
});

test("actual time per phase is the largest value reported for it", () => {
  const timeline = buildPhaseTimeline({
    plan: twoPhasePlan,
    events: [
      { phaseId: "clarify", kind: "enter", elapsedSec: 0 },
      { phaseId: "clarify", kind: "exit", elapsedSec: 420 },
      { phaseId: "deep_dive", kind: "enter", elapsedSec: 0 },
      { phaseId: "deep_dive", kind: "exit", elapsedSec: 120 }
    ],
    completed: true
  });

  assert.deepEqual(
    timeline.phases.map((p) => [p.phaseId, p.actualSec, p.overBudget]),
    [
      ["clarify", 420, true],
      ["deep_dive", 120, false]
    ]
  );
  assert.equal(timeline.totalSec, 540);
  assert.equal(timeline.completed, true);
});

test("a reset discards everything recorded before it", () => {
  const timeline = buildPhaseTimeline({
    plan: twoPhasePlan,
    events: [
      { phaseId: "clarify", kind: "enter", elapsedSec: 0 },
      { phaseId: "clarify", kind: "exit", elapsedSec: 900 },
      { phaseId: "deep_dive", kind: "reset", elapsedSec: 100 },
      { phaseId: "clarify", kind: "enter", elapsedSec: 0 },
      { phaseId: "clarify", kind: "exit", elapsedSec: 60 }
    ],
    completed: false
  });

  assert.equal(timeline.phases.find((p) => p.phaseId === "clarify")?.actualSec, 60);
  assert.equal(timeline.phases.find((p) => p.phaseId === "deep_dive")?.actualSec, 0);
  assert.equal(timeline.totalSec, 60);
});

test("events for a phase the plan no longer has are kept without a budget", () => {
  const timeline = buildPhaseTimeline({
    plan: twoPhasePlan,
    events: [{ phaseId: "legacy_api", kind: "exit", elapsedSec: 240 }],
    completed: false
  });

  const stray = timeline.phases.find((p) => p.phaseId === "legacy_api");
  assert.ok(stray, "a recorded phase missing from the plan should still appear");
  assert.equal(stray?.budgetSec, 0);
  assert.equal(stray?.actualSec, 240);
  assert.equal(stray?.overBudget, false);
});

test("phase-level elapsed values are clamped inside the reducer too", () => {
  const timeline = buildPhaseTimeline({
    plan: twoPhasePlan,
    events: [{ phaseId: "clarify", kind: "exit", elapsedSec: 1e12 }],
    completed: false
  });

  assert.equal(timeline.phases[0]?.actualSec, MAX_PHASE_ELAPSED_SEC);
});

test("the default plan ends with a candidate-led wrap-up phase", () => {
  assert.equal(InterviewPlanSchema.safeParse(DEFAULT_INTERVIEW_PLAN).success, true);
  const last = DEFAULT_INTERVIEW_PLAN.phases.at(-1);
  assert.equal(last?.id, "wrap_up");
  // The wrap-up only earns its place if it tells the candidate what to close
  // out — the two questions the kit spends its last minutes on.
  assert.match(last?.candidateGuide ?? "", /10× scale/);
  assert.match(last?.candidateGuide ?? "", /tackle next/);
});

test("every recommendation value has stable UI wording", () => {
  for (const value of ["strong_yes", "yes", "no", "strong_no"] as const) {
    assert.equal(typeof DEBRIEF_RECOMMENDATION_LABELS[value], "string");
    assert.ok(DEBRIEF_RECOMMENDATION_LABELS[value].length > 0);
  }
});

test("getInterviewDebrief tolerates legacy and malformed rows", () => {
  assert.equal(getInterviewDebrief(null), null);
  assert.equal(getInterviewDebrief(undefined), null);
  assert.equal(getInterviewDebrief({ strongestSignal: "no recommendation field" }), null);

  const valid = {
    strongestSignal: "You drove the scope conversation before drawing anything.",
    recommendation: "yes" as const,
    whatWentWell: ["Asked about tenancy before choosing a data model."],
    whereTheyStruggled: [],
    riskAreas: [],
    studyPlan: [{ topic: "Sharding", why: "You deferred the hot-key question twice." }],
    generatedAt: "2026-08-26T09:00:00.000Z"
  };
  assert.equal(InterviewDebriefSchema.safeParse(valid).success, true);
  assert.deepEqual(getInterviewDebrief(valid), valid);
});

const transitionArgs = {
  plan: twoPhasePlan,
  now: "2026-08-26T09:00:00.000Z",
  id: "proposal-1"
};

test("getPhaseProposalState degrades to empty for legacy and malformed rows", () => {
  assert.deepEqual(getPhaseProposalState(null), EMPTY_PHASE_PROPOSAL_STATE);
  assert.deepEqual(getPhaseProposalState({ nonsense: true }), EMPTY_PHASE_PROPOSAL_STATE);
  assert.deepEqual(getPhaseProposalState({ pending: null, resolvedPhaseIds: ["clarify"] }), {
    pending: null,
    resolvedPhaseIds: ["clarify"]
  });
});

test("evaluatePhaseTransition fires on time and names the next phase", () => {
  const proposal = evaluatePhaseTransition({
    ...transitionArgs,
    phase: { id: "clarify", index: 0, elapsedSec: 240, durationSec: 300 },
    state: EMPTY_PHASE_PROPOSAL_STATE
  });

  assert.equal(proposal?.reason, "time");
  assert.equal(proposal?.toPhaseId, "deep_dive");
  assert.equal(proposal?.toLabel, "Deep dive");
  assert.equal(proposal?.fromPhaseIndex, 0);
  assert.equal(proposal?.toPhaseIndex, 1);
});

test("evaluatePhaseTransition stays silent below the budget ratio", () => {
  assert.equal(
    evaluatePhaseTransition({
      ...transitionArgs,
      phase: { id: "clarify", index: 0, elapsedSec: 239, durationSec: 300 },
      state: EMPTY_PHASE_PROPOSAL_STATE
    }),
    null
  );
});

test("evaluatePhaseTransition never fires on the last phase", () => {
  assert.equal(
    evaluatePhaseTransition({
      ...transitionArgs,
      phase: { id: "deep_dive", index: 1, elapsedSec: 6000, durationSec: 600 },
      state: EMPTY_PHASE_PROPOSAL_STATE
    }),
    null
  );
});

test("evaluatePhaseTransition respects pending and resolved phases", () => {
  const overBudget = { id: "clarify", index: 0, elapsedSec: 3000, durationSec: 300 };
  const pending = evaluatePhaseTransition({
    ...transitionArgs,
    phase: overBudget,
    state: EMPTY_PHASE_PROPOSAL_STATE
  })!;

  assert.equal(
    evaluatePhaseTransition({
      ...transitionArgs,
      phase: overBudget,
      state: { pending, resolvedPhaseIds: [] }
    }),
    null
  );
  assert.equal(
    evaluatePhaseTransition({
      ...transitionArgs,
      phase: overBudget,
      state: { pending: null, resolvedPhaseIds: ["clarify"] }
    }),
    null
  );
});

test("evaluatePhaseTransition ignores a stale client phase index", () => {
  assert.equal(
    evaluatePhaseTransition({
      ...transitionArgs,
      // index says phase 0 but the id says phase 1: the client is out of sync,
      // so the pacing numbers cannot be trusted either.
      phase: { id: "deep_dive", index: 0, elapsedSec: 3000, durationSec: 300 },
      state: EMPTY_PHASE_PROPOSAL_STATE
    }),
    null
  );
});

test("coverage needs at least one non-stretch criterion mapped to the phase", () => {
  const mappedPlaybook = {
    areasToProbe: [
      {
        id: "isolation",
        label: "Isolation",
        phaseRefs: ["clarify"],
        criterionRefs: ["tenant_isolation"],
        sampleQuestions: ["How are tenants kept apart?"],
        progressiveNudges: ["Who reads what?", "Where is it checked?", "Show the guard."] as [
          string,
          string,
          string
        ],
        greenFlags: ["Scopes queries by tenant."],
        redFlags: ["Trusts a client tenant id."]
      }
    ],
    scoreRubric: rubric.playbook.scoreRubric
  };
  const early = { id: "clarify", index: 0, elapsedSec: 5, durationSec: 300 };

  // Undiscovered: the phase still has work to do.
  assert.equal(
    evaluatePhaseTransition({
      ...transitionArgs,
      phase: early,
      state: EMPTY_PHASE_PROPOSAL_STATE,
      criteria: [criterion],
      playbook: mappedPlaybook
    }),
    null
  );

  // Discovered: offer the move even though barely any time has passed.
  const proposal = evaluatePhaseTransition({
    ...transitionArgs,
    phase: early,
    state: EMPTY_PHASE_PROPOSAL_STATE,
    criteria: [{ ...criterion, discoveredVia: { kind: "candidate", at: transitionArgs.now } }],
    playbook: mappedPlaybook
  });
  assert.equal(proposal?.reason, "coverage");

  // No criteria at all is "nothing known", not "everything covered".
  assert.equal(
    evaluatePhaseTransition({
      ...transitionArgs,
      phase: early,
      state: EMPTY_PHASE_PROPOSAL_STATE,
      criteria: [],
      playbook: mappedPlaybook
    }),
    null
  );
});

test("legacy criteria rows parse with or without progressiveNudges", () => {
  // Shape a real `interviews.criteria_json` row can have: no nudges at all,
  // plus a stray key from an older generation pass.
  const legacyRow = [
    {
      id: "per_user_isolation",
      text: "Tasks are scoped to their owner in the data model.",
      dimension: "security",
      importance: "core",
      visibility: "hidden",
      discoveryHints: ["Do users ever share a task list?"],
      satisfiedBy: ["user_id foreign key on tasks"],
      legacyField: "ignored"
    }
  ];

  const parsed = getRubricCriteria(legacyRow);
  assert.equal(parsed?.length, 1);
  assert.equal(parsed?.[0]?.progressiveNudges, undefined);
  // Zod strips unknown keys rather than rejecting the row.
  assert.equal("legacyField" in (parsed?.[0] ?? {}), false);

  const withNudges = getRubricCriteria([
    { ...legacyRow[0], progressiveNudges: ["a nudge", "a sharper nudge", "the sharpest nudge"] }
  ]);
  assert.deepEqual(withNudges?.[0]?.progressiveNudges, [
    "a nudge",
    "a sharper nudge",
    "the sharpest nudge"
  ]);
});

test("getTrack accepts the enum and treats everything else as unspecified", () => {
  for (const track of TrackSchema.options) {
    assert.equal(getTrack(track), track);
    assert.ok(TRACK_LABELS[track].length > 0);
  }
  // Legacy rows, typos and stale values all mean "unspecified" rather than
  // throwing — a wrong track would steer generation and grading.
  assert.equal(getTrack(null), null);
  assert.equal(getTrack(undefined), null);
  assert.equal(getTrack("ai"), null);
  assert.equal(getTrack("Backend"), null);
  assert.equal(getTrack(7), null);
});

test("track is optional on the generate input and on ProblemSchema", () => {
  assert.equal(
    GenerateProblemInputSchema.safeParse({ difficulty: "medium" }).success,
    true
  );
  const withTrack = GenerateProblemInputSchema.safeParse({
    difficulty: "medium",
    track: "frontend"
  });
  assert.equal(withTrack.success && withTrack.data.track, "frontend");
  assert.equal(
    GenerateProblemInputSchema.safeParse({ difficulty: "medium", track: "nope" }).success,
    false
  );
});

// --- hand-authored rubric projection -------------------------------------

const PLAYBOOK_FIXTURE = {
  areasToProbe: [
    {
      id: "edge_fill",
      label: "Edge cache fill",
      phaseRefs: ["delivery_path"],
      criterionRefs: ["prepositioning"],
      sampleQuestions: ["How does a title reach the edge before launch?"],
      progressiveNudges: ["What warms the cache?", "Who fills it first?", "Pre-position or lazy?"],
      greenFlags: ["Names pre-positioning explicitly"],
      redFlags: ["Assumes lazy fill is free"]
    }
  ],
  scoreRubric: { "1": "no bar", "2": "below", "3": "meets", "4": "exceeds" }
};

const seededRubricFixture = () => ({
  criteria: [
    // No hiddenFrom: a seed constraint already states it, so never hidden.
    { id: "always_visible", text: "Stated on the rail", dimension: "requirements" as const, importance: "expected" as const },
    { id: "from_guided", text: "Hidden everywhere", dimension: "scalability" as const, importance: "core" as const, hiddenFrom: "guided" as const },
    { id: "from_standard", text: "Hidden from standard up", dimension: "reliability" as const, importance: "core" as const, hiddenFrom: "standard" as const },
    { id: "from_hard", text: "Hidden from hard up", dimension: "consistency" as const, importance: "expected" as const, hiddenFrom: "hard" as const },
    { id: "from_staff", text: "Hidden only at staff", dimension: "operability" as const, importance: "stretch" as const, hiddenFrom: "staff" as const }
  ],
  playbook: PLAYBOOK_FIXTURE
});

test("seeded rubric round-trips through its tolerant reader", () => {
  const rubric = getSeededRubric(seededRubricFixture());
  assert.ok(rubric);
  assert.equal(rubric.criteria.length, 5);
  assert.equal(getSeededRubric(null), null);
  assert.equal(getSeededRubric({ criteria: [] }), null);
  assert.equal(getSeededRubric({ criteria: [{ id: "x" }], playbook: PLAYBOOK_FIXTURE }), null);
});

test("projection hides strictly more as the level rises", () => {
  const rubric = getSeededRubric(seededRubricFixture())!;
  const counts = INTERVIEWER_LEVEL_ORDER.map((level) => hiddenCountAtLevel(rubric, level));
  assert.deepEqual(counts, [1, 2, 3, 4]);

  // Monotonicity is the property the whole model rests on.
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(counts[i]! >= counts[i - 1]!, "hidden count must never shrink as level rises");
  }
});

test("projection produces exactly what generated criteria look like", () => {
  const rubric = getSeededRubric(seededRubricFixture())!;
  const now = "2026-08-26T10:00:00.000Z";
  const projected = projectRubricForLevel(rubric, "hard", now);

  // Valid as a real InterviewRubric, so every downstream consumer accepts it.
  assert.equal(InterviewRubricSchema.safeParse(projected).success, true);
  assert.equal(getRubricPlaybook(projected)?.areasToProbe.length, 1);
  assert.equal(getRubricCriteria(projected)?.length, 5);

  const byId = new Map(projected.criteria.map((c) => [c.id, c]));
  assert.equal(byId.get("always_visible")?.visibility, "visible");
  assert.equal(byId.get("from_guided")?.visibility, "hidden");
  assert.equal(byId.get("from_standard")?.visibility, "hidden");
  assert.equal(byId.get("from_hard")?.visibility, "hidden");
  assert.equal(byId.get("from_staff")?.visibility, "visible");

  // Visible criteria are pre-marked discovered; hidden ones must not be, or the
  // discovery loop would start already satisfied.
  assert.deepEqual(byId.get("always_visible")?.discoveredVia, { kind: "seed", at: now });
  assert.equal(byId.get("from_guided")?.discoveredVia, undefined);
});

test("projection never leaks hiddenFrom into the stored rubric", () => {
  const rubric = getSeededRubric(seededRubricFixture())!;
  for (const level of INTERVIEWER_LEVEL_ORDER) {
    for (const criterion of projectRubricForLevel(rubric, level, "2026-08-26T10:00:00.000Z").criteria) {
      assert.ok(!("hiddenFrom" in criterion), `${criterion.id} carried hiddenFrom into the interview row`);
    }
  }
});

test("guided still hides something, at every difficulty floor", () => {
  // An all-visible rubric would defeat the discovery loop outright, which is
  // why LEVEL_HIDDEN_GUIDANCE sets a firm minimum even for guided.
  const rubric = getSeededRubric(seededRubricFixture())!;
  assert.ok(hiddenCountAtLevel(rubric, "guided") >= 1);
});
