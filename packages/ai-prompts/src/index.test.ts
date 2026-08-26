import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCriteriaPrompt,
  buildDebriefPrompt,
  buildInterviewerPrompt,
  buildProblemPrompt,
  buildValidationPrompt,
  buildInterviewerWelcome,
  buildProblemNarrativePrompt,
  buildReferenceSolutionPrompt,
  DIFFICULTY_SLOTS,
  formatPhaseTimelineBlock,
  getCriteriaHiddenMin,
  hasEstimationPhase,
  TRACK_SLOTS,
  trackContextBlock
} from "./index.js";
import { TrackSchema } from "@sdl/shared";
import type { InterviewerPlaybook, PhaseTimeline, RubricCriterion, Track } from "@sdl/shared";

const criteria: RubricCriterion[] = [
  {
    id: "tenant_isolation",
    text: "Tenant data is isolated across every API and storage path.",
    dimension: "security",
    importance: "core",
    visibility: "hidden",
    discoveryHints: ["How should tenant boundaries be enforced?"],
    satisfiedBy: ["tenant_id scoped queries"]
  }
];

const playbook: InterviewerPlaybook = {
  areasToProbe: [
    {
      id: "auth_and_isolation",
      label: "Auth & Isolation",
      phaseRefs: ["clarify"],
      criterionRefs: ["tenant_isolation"],
      sampleQuestions: ["Walk me through the React login to API authorization flow."],
      progressiveNudges: [
        "Who can manage tenant users?",
        "Where is tenant authorization enforced?",
        "Show the exact guard against cross-tenant reads."
      ],
      greenFlags: ["Separates authentication from tenant-scoped authorization."],
      redFlags: ["Trusts tenantId from the client without server-side checks."]
    },
    {
      id: "audit_logs",
      label: "Audit Logs",
      phaseRefs: ["deep_dive"],
      criterionRefs: ["tenant_isolation"],
      sampleQuestions: ["Where do audit logs live?"],
      progressiveNudges: [
        "What must be audited?",
        "How are audit entries protected?",
        "Show the write path for tamper-resistant audit logs."
      ],
      greenFlags: ["Treats audit logs as append-only records."],
      redFlags: ["Allows hard deletes without audit history."]
    }
  ],
  scoreRubric: {
    "1": "Cannot structure the design.",
    "2": "Misses important constraints.",
    "3": "Covers core trade-offs.",
    "4": "Drives the conversation with operational depth."
  }
};

test("interviewer prompt injects only the playbook areas for the current phase", () => {
  const prompt = buildInterviewerPrompt("standard", {
    criteria,
    playbook,
    currentPhaseId: "clarify"
  });

  assert.match(prompt, /PRIVATE INTERVIEWER PLAYBOOK FOR THIS PHASE/);
  assert.match(prompt, /Auth & Isolation/);
  assert.match(prompt, /Walk me through the React login/);
  assert.doesNotMatch(prompt, /Audit Logs/);
  assert.match(prompt, /Score rubric language to keep in mind/);
});

test("interviewer prompt omits the playbook block for legacy rows", () => {
  const prompt = buildInterviewerPrompt("standard", { criteria });
  assert.doesNotMatch(prompt, /PRIVATE INTERVIEWER PLAYBOOK FOR THIS PHASE/);
});

test("guided interviewer prompt requires informative and consistent scope answers", () => {
  const prompt = buildInterviewerPrompt("guided", { criteria });

  assert.match(prompt, /direct answer → v1 decision\/assumption → impact on the design or board/);
  assert.match(prompt, /what do I need \/ what should I do next/);
  assert.match(prompt, /Treat prior interviewer answers in the chat history as binding scope/);
  assert.match(prompt, /make only the smallest scope commitment needed/);
});

const VALIDATION_SCOPE = {
  constraints: ["Support up to 10K daily active users."],
  criteria
};

test("validation prompt omits the flags block when there is no playbook", () => {
  const prompt = buildValidationPrompt("medium", "", VALIDATION_SCOPE);

  assert.doesNotMatch(prompt, /OBSERVABLE FLAGS/);
  assert.doesNotMatch(prompt, /flagObservations/);
});

test("validation prompt is byte-identical with an absent vs undefined playbook", () => {
  const withoutKey = buildValidationPrompt("medium", "", VALIDATION_SCOPE);
  const withUndefined = buildValidationPrompt("medium", "", {
    ...VALIDATION_SCOPE,
    playbook: undefined
  });

  assert.equal(withUndefined, withoutKey);
});

test("validation prompt lists every playbook flag with a resolvable address", () => {
  const prompt = buildValidationPrompt("medium", "", { ...VALIDATION_SCOPE, playbook });

  assert.match(prompt, /OBSERVABLE FLAGS/);

  for (const area of playbook.areasToProbe) {
    area.greenFlags.forEach((flag, index) => {
      assert.ok(
        prompt.includes(`areaId=${area.id} kind=green index=${index} :: ${flag}`),
        `missing green flag ${area.id}#${index}`
      );
    });
    area.redFlags.forEach((flag, index) => {
      assert.ok(
        prompt.includes(`areaId=${area.id} kind=red index=${index} :: ${flag}`),
        `missing red flag ${area.id}#${index}`
      );
    });
  }

  // The flags block is phase-independent: unlike the interviewer playbook
  // block, validation grades the whole attempt, so every area is listed.
  assert.match(prompt, /Auth & Isolation/);
  assert.match(prompt, /Audit Logs/);
});

test("validation prompt asks for flagObservations only when flags were listed", () => {
  const withFlags = buildValidationPrompt("medium", "", { ...VALIDATION_SCOPE, playbook });
  assert.match(withFlags, /- flagObservations: array of \{ areaId, kind, index, text, fired, evidence\? \}/);

  const withoutFlags = buildValidationPrompt("medium", "", VALIDATION_SCOPE);
  assert.doesNotMatch(withoutFlags, /- flagObservations: array of/);
});

test("validation prompt tells the grader flags are reported, not scored", () => {
  const prompt = buildValidationPrompt("medium", "", { ...VALIDATION_SCOPE, playbook });

  assert.match(prompt, /REPORTED to the candidate, not scored/);
  assert.match(prompt, /INDEPENDENT observations, not two ends of one axis/);
  assert.match(prompt, /Do NOT infer a red flag purely from absence/);
});

test("hasEstimationPhase matches the vocabulary plans actually use", () => {
  assert.ok(hasEstimationPhase([{ id: "estimate", label: "Estimate" }]));
  assert.ok(hasEstimationPhase([{ id: "capacity_math", label: "Capacity math" }]));
  assert.ok(hasEstimationPhase([{ id: "sizing", label: "Sizing" }]));
  assert.ok(hasEstimationPhase([{ id: "napkin", label: "Back-of-envelope" }]));
  assert.ok(
    hasEstimationPhase([
      { id: "clarify", label: "Clarify" },
      { id: "scale_math", label: "Scale math" }
    ])
  );

  assert.equal(hasEstimationPhase([]), false);
  assert.equal(
    hasEstimationPhase([
      { id: "clarify", label: "Clarify" },
      { id: "high_level", label: "High-level" },
      { id: "deep_dive", label: "Deep dive" }
    ]),
    false
  );
});

const CRITERIA_INPUT = {
  difficulty: "medium" as const,
  interviewerLevel: "standard" as const,
  title: "Design a chat backend",
  statement: "Users exchange messages in rooms.",
  seedConstraints: ["Support up to 10K daily active users."]
};

test("criteria prompt demands a capacityEstimation criterion when the plan estimates", () => {
  const prompt = buildCriteriaPrompt({
    ...CRITERIA_INPUT,
    phases: [
      { id: "clarify", label: "Clarify" },
      { id: "estimate", label: "Estimate" }
    ]
  });

  assert.match(prompt, /ESTIMATION IS IN SCOPE/);
  assert.match(prompt, /At least ONE criterion MUST target dimension "capacityEstimation"/);
});

test("criteria prompt stays silent about estimation when no phase covers it", () => {
  const prompt = buildCriteriaPrompt({
    ...CRITERIA_INPUT,
    phases: [
      { id: "clarify", label: "Clarify" },
      { id: "high_level", label: "High-level" }
    ]
  });

  assert.doesNotMatch(prompt, /ESTIMATION IS IN SCOPE/);
});

test("capacityEstimation is offered as a dimension in the criteria prompt", () => {
  const prompt = buildCriteriaPrompt({
    ...CRITERIA_INPUT,
    phases: [{ id: "clarify", label: "Clarify" }]
  });
  assert.match(prompt, /operability, capacityEstimation/);
});

const emptyTimeline: PhaseTimeline = {
  phases: [
    { phaseId: "clarify", label: "Clarify", budgetSec: 300, actualSec: 0, overBudget: false },
    { phaseId: "deep_dive", label: "Deep dive", budgetSec: 600, actualSec: 0, overBudget: false }
  ],
  totalSec: 0,
  completed: false
};

const lopsidedTimeline: PhaseTimeline = {
  phases: [
    { phaseId: "clarify", label: "Clarify", budgetSec: 300, actualSec: 1320, overBudget: true },
    { phaseId: "deep_dive", label: "Deep dive", budgetSec: 600, actualSec: 180, overBudget: false }
  ],
  totalSec: 1500,
  completed: false
};

test("the pacing block is omitted when nothing was recorded", () => {
  assert.equal(formatPhaseTimelineBlock(undefined), "");
  assert.equal(formatPhaseTimelineBlock(emptyTimeline), "");
});

test("interviewer prompt is byte-identical without a timeline or with an empty one", () => {
  const bare = buildInterviewerPrompt("standard", { criteria });
  assert.equal(buildInterviewerPrompt("standard", { criteria, phaseTimeline: undefined }), bare);
  assert.equal(buildInterviewerPrompt("standard", { criteria, phaseTimeline: emptyTimeline }), bare);
});

test("the pacing block reports per-phase spend and repeats the never-quote rule", () => {
  const block = formatPhaseTimelineBlock(lopsidedTimeline);
  assert.match(block, /Clarify: ~22m spent of ~5m suggested/);
  assert.match(block, /OVER/);
  assert.match(block, /Deep dive: ~3m spent of ~10m suggested/);
  assert.match(block, /never quote these numbers at the candidate/);
  // 22 of 25 minutes in one phase is the signal the block exists to expose.
  assert.match(block, /88% of the session so far/);
});

test("interviewer prompt carries the pacing history when one exists", () => {
  const prompt = buildInterviewerPrompt("hard", {
    criteria,
    phaseTimeline: lopsidedTimeline
  });
  assert.match(prompt, /PACING HISTORY ACROSS PHASES/);
  assert.match(prompt, /Total recorded: ~25m/);
});

test("a phase with no suggested budget is never reported as over budget", () => {
  const block = formatPhaseTimelineBlock({
    phases: [
      { phaseId: "legacy_api", label: "legacy_api", budgetSec: 0, actualSec: 240, overBudget: false }
    ],
    totalSec: 240,
    completed: false
  });
  assert.match(block, /no suggested budget/);
  assert.doesNotMatch(block, /OVER/);
});

const debriefBase = {
  problemTitle: "Multi-tenant audit log",
  problemStatement: "Design an append-only audit log for a multi-tenant SaaS.",
  difficulty: "medium" as const,
  interviewerLevel: "standard" as const,
  activeConstraints: ["Up to 500 tenants", "Audit entries are never edited"]
};

test("every generated interview plan is required to end with a closing phase", () => {
  for (const difficulty of ["beginner", "easy", "medium", "hard", "expert"] as const) {
    const prompt = buildProblemPrompt(difficulty);
    assert.match(prompt, /The LAST phase MUST be a short closing phase/);
    assert.match(prompt, /10x scale/);
  }
});

test("the debrief prompt demands traceable bullets and forbids restating the score", () => {
  const prompt = buildDebriefPrompt({
    ...debriefBase,
    criteria,
    scoring: {
      score: 62,
      designScore: 58,
      discoveryScore: 71,
      scoringMode: "rubric",
      scoreBand: { band: 2, label: "Covers basics but shallow." },
      criteriaEvaluations: [
        {
          criterionId: "tenant_isolation",
          covered: false,
          discovered: false,
          severity: "high",
          evidence: "No tenant scoping on the reads path."
        }
      ]
    },
    transcript: "[Candidate]\nWhere do audit entries live?"
  });

  assert.match(prompt, /Every bullet must be traceable to a specific observable/);
  assert.match(prompt, /Do NOT restate the numeric score/);
  // The rubric outcome is the ground truth the narrative has to agree with.
  assert.match(prompt, /tenant_isolation \(core, security\): MISSED, NEVER surfaced/);
  assert.match(prompt, /Band: 2 of 4/);
  assert.match(prompt, /TRANSCRIPT/);
});

test("the debrief prompt omits blocks whose evidence is absent", () => {
  const prompt = buildDebriefPrompt(debriefBase);

  assert.doesNotMatch(prompt, /RUBRIC OUTCOME/);
  assert.doesNotMatch(prompt, /AUTOMATED SCORING/);
  assert.doesNotMatch(prompt, /OBSERVED BEHAVIOURAL SIGNALS/);
  assert.doesNotMatch(prompt, /PACING/);
  assert.doesNotMatch(prompt, /TRANSCRIPT/);
  // Scope always survives — it is what the candidate was asked to build.
  assert.match(prompt, /Up to 500 tenants/);
});

test("the debrief prompt marks a fallback-scored attempt as coarse", () => {
  const prompt = buildDebriefPrompt({
    ...debriefBase,
    scoring: { score: 40, scoringMode: "dimensions" }
  });
  assert.match(prompt, /dimension-average FALLBACK/);
});

test("the debrief prompt reports only flags that actually fired", () => {
  const prompt = buildDebriefPrompt({
    ...debriefBase,
    scoring: {
      flagObservations: [
        {
          areaId: "auth_and_isolation",
          kind: "green",
          index: 0,
          text: "Separates authentication from tenant authorization.",
          fired: true,
          evidence: "Drew a per-tenant authorization check before the read path."
        },
        {
          areaId: "auth_and_isolation",
          kind: "red",
          index: 0,
          text: "Trusts tenantId from the client without server-side checks.",
          fired: false
        }
      ]
    }
  });

  assert.match(prompt, /GREEN: Separates authentication from tenant authorization/);
  assert.doesNotMatch(prompt, /Trusts tenantId/);
});

test("the debrief prompt calls out lopsided pacing without turning it into a score", () => {
  const prompt = buildDebriefPrompt({ ...debriefBase, phaseTimeline: lopsidedTimeline });
  assert.match(prompt, /PACING \(how the session was actually spent\)/);
  assert.match(prompt, /Clarify: ~22m spent vs ~5m suggested \(over budget\)/);
  assert.match(prompt, /never as a scored item/);
});

test("a pending transition tells the interviewer to close out, not open a thread", () => {
  const prompt = buildInterviewerPrompt("standard", {
    criteria,
    pendingPhaseTransition: { toLabel: "Deep dive" }
  });

  assert.match(prompt, /being offered the move to "Deep dive"/);
  assert.match(prompt, /Do NOT open a new line of questioning this turn/);
  assert.match(prompt, /do not advance the phase yourself/);
});

test("with no pending transition the prompt is unchanged", () => {
  assert.equal(
    buildInterviewerPrompt("standard", { criteria, pendingPhaseTransition: undefined }),
    buildInterviewerPrompt("standard", { criteria })
  );
});

const nudgedCriterion: RubricCriterion = {
  ...criteria[0]!,
  id: "audit_immutability",
  text: "Audit entries are append-only and never edited in place.",
  progressiveNudges: [
    "What happens if someone needs to correct an audit entry?",
    "Who is allowed to change history here, and how would you know?",
    "Make the append-only guarantee explicit in the storage design."
  ]
};

test("criterion-level nudges reach the prompt with an escalation rule", () => {
  const prompt = buildInterviewerPrompt("standard", { criteria: [nudgedCriterion] });

  assert.match(prompt, /nudges \(gentle -> sharp, escalate across turns\)/);
  assert.match(prompt, /1\. What happens if someone needs to correct an audit entry\?/);
  assert.match(prompt, /3\. Make the append-only guarantee explicit/);
  assert.match(prompt, /Nudge escalation rule/);
  assert.match(prompt, /never skip ahead/);
});

test("without nudges the prompt falls back to discovery hints alone", () => {
  const prompt = buildInterviewerPrompt("standard", { criteria });

  assert.match(prompt, /hints: How should tenant boundaries be enforced\?/);
  assert.doesNotMatch(prompt, /nudges \(gentle -> sharp/);
  assert.doesNotMatch(prompt, /Nudge escalation rule/);
});

const DIFFICULTIES = ["beginner", "easy", "medium", "hard", "expert"] as const;

/** The guidance block for one difficulty, sliced out of the full prompt. */
function guidanceFor(difficulty: (typeof DIFFICULTIES)[number]): string {
  const prompt = buildProblemPrompt(difficulty);
  const start = prompt.indexOf(`Difficulty guidance for ${difficulty}:`);
  assert.notEqual(start, -1, `no guidance block for ${difficulty}`);
  const end = prompt.indexOf("Topic hint:", start);
  return prompt.slice(start, end === -1 ? undefined : end);
}

test("every difficulty fills all six guidance slots", () => {
  for (const difficulty of DIFFICULTIES) {
    const guidance = guidanceFor(difficulty);
    for (const slot of DIFFICULTY_SLOTS) {
      assert.match(
        guidance,
        new RegExp(`^${slot}:`, "m"),
        `${difficulty} is missing the "${slot}" slot`
      );
    }
  }
});

test("no two difficulties produce the same guidance text", () => {
  const seen = new Map<string, string>();
  for (const difficulty of DIFFICULTIES) {
    const guidance = guidanceFor(difficulty).replace(
      `Difficulty guidance for ${difficulty}:`,
      ""
    );
    const previous = seen.get(guidance);
    assert.equal(previous, undefined, `${difficulty} duplicates ${previous ?? ""} guidance`);
    seen.set(guidance, difficulty);
  }
});

test("every level below expert excludes something, and expert excludes nothing by subject", () => {
  const ladder = {
    easy: /multi-region, sharding or partitioning strategies, consensus/,
    medium: /active-active multi-region, custom consensus protocols, regulatory\/compliance regimes/,
    hard: /compliance-driven narratives unless the domain genuinely implies them/,
    beginner: /globe-scale assumptions, geo-distributed deploys, sharding/
  } as const;

  for (const [difficulty, pattern] of Object.entries(ladder)) {
    assert.match(guidanceFor(difficulty as (typeof DIFFICULTIES)[number]), pattern);
  }

  const expert = guidanceFor("expert");
  assert.match(expert, /nothing is excluded by subject/);
  assert.match(expert, /FAKE difficulty/);
});

test("every level states expected breadth in concrete component counts", () => {
  const counts = {
    beginner: /two to four labeled boxes/,
    easy: /Four to six labeled boxes/,
    medium: /Six to nine labeled boxes/,
    hard: /Eight to twelve labeled boxes/,
    expert: /Ten to fifteen labeled boxes/
  } as const;

  for (const [difficulty, pattern] of Object.entries(counts)) {
    assert.match(
      guidanceFor(difficulty as (typeof DIFFICULTIES)[number]),
      pattern,
      `${difficulty} does not state a component count`
    );
  }
});

test("the problem prompt carries the anti-compression rule at every difficulty", () => {
  for (const difficulty of DIFFICULTIES) {
    const prompt = buildProblemPrompt(difficulty);
    assert.match(prompt, /NUMBER OF INTERACTING CONCERNS/);
    assert.match(prompt, /A hard problem is not a medium problem with more zeros/);
  }
});

test("rubric budgets are untouched by the guidance rework", () => {
  assert.equal(getCriteriaHiddenMin("beginner"), 1);
  assert.equal(getCriteriaHiddenMin("easy"), 2);
  assert.equal(getCriteriaHiddenMin("medium"), 3);
  assert.equal(getCriteriaHiddenMin("hard"), 4);
  assert.equal(getCriteriaHiddenMin("expert"), 5);
});

const narrative = {
  framingScript:
    "So, we run an internal API platform and every team keeps writing their own throttling. I'd like you to design the shared rate limiter they'd all call. Take it wherever you think matters most, and start wherever makes sense to you.",
  signatureChallenge:
    "When the shared counter store is unreachable, the limiter must choose fail-open (let traffic through, risk overload) or fail-closed (reject, risk an outage) — and defend it.",
  progressiveReveals: [
    "Let's say this now fronts about 100 services and a few million calls a minute.",
    "How would your design change if the counter store went down entirely?",
    "A customer says they're being limited but shouldn't be — how do you work out why?"
  ] as [string, string, string]
};

test("the stall ladder is private, ordered, and one-rung-per-turn", () => {
  const prompt = buildInterviewerPrompt("standard", { criteria, narrative });

  assert.match(prompt, /STALL LADDER FOR THIS PROBLEM \(private\)/);
  assert.match(prompt, /1\. \(scale\) Let's say this now fronts about 100 services/);
  assert.match(prompt, /2\. \(failure\) How would your design change/);
  assert.match(prompt, /3\. \(debug\/ops\) A customer says they're being limited/);
  assert.match(prompt, /at most ONE rung per turn; always in order; never skip ahead/);
  // Distinct from per-criterion coaching, which chases one expectation.
  assert.match(prompt, /ONLY when the candidate is stuck on the design as a whole/);
});

test("the interviewer prompt is unchanged for a problem with no narrative", () => {
  const bare = buildInterviewerPrompt("standard", { criteria });
  assert.equal(buildInterviewerPrompt("standard", { criteria, narrative: null }), bare);
  assert.equal(buildInterviewerPrompt("standard", { criteria, narrative: undefined }), bare);
});

test("the welcome opens with the framing script when there is one", () => {
  const plan = {
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope the problem before drawing. Ask about users, scale, and what v1 must actually do."
      },
      {
        id: "wrap_up",
        label: "Wrap-up",
        durationSec: 240,
        candidateGuide:
          "Summarise your design, say what you would change at 10x scale, and name what you'd tackle next."
      }
    ]
  };

  const withFraming = buildInterviewerWelcome("Shared rate limiter", plan, narrative);
  const withoutFraming = buildInterviewerWelcome("Shared rate limiter", plan);

  assert.match(withFraming, /we run an internal API platform/);
  assert.doesNotMatch(withoutFraming, /we run an internal API platform/);
  // Both branches still name the problem and keep the UI tour.
  for (const welcome of [withFraming, withoutFraming]) {
    assert.match(welcome, /\*\*Shared rate limiter\*\*/);
    assert.match(welcome, /### How I'll run this/);
  }
});

test("the signature challenge never reaches the candidate-facing welcome", () => {
  const plan = {
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope the problem before drawing. Ask about users, scale, and what v1 must actually do."
      },
      {
        id: "wrap_up",
        label: "Wrap-up",
        durationSec: 240,
        candidateGuide:
          "Summarise your design, say what you would change at 10x scale, and name what you'd tackle next."
      }
    ]
  };
  const welcome = buildInterviewerWelcome("Shared rate limiter", plan, narrative);
  assert.doesNotMatch(welcome, /fail-open/);
  assert.doesNotMatch(welcome, /fail-closed/);
});

test("the criteria prompt requires a core criterion for the signature challenge", () => {
  const withSignature = buildCriteriaPrompt({
    difficulty: "medium",
    interviewerLevel: "standard",
    title: "Shared rate limiter",
    statement: "Design a rate limiter shared across services.",
    seedConstraints: ["Per-user and per-endpoint limits"],
    phases: [{ id: "clarify", label: "Clarify" }],
    signatureChallenge: narrative.signatureChallenge
  });

  assert.match(withSignature, /SIGNATURE CHALLENGE \(interviewer-private/);
  assert.match(withSignature, /At least ONE criterion with importance="core" MUST cover this/);
  assert.match(withSignature, /fail-open/);
});

test("the criteria prompt is unchanged without a signature challenge", () => {
  const args = {
    difficulty: "medium" as const,
    interviewerLevel: "standard" as const,
    title: "Shared rate limiter",
    statement: "Design a rate limiter shared across services.",
    seedConstraints: ["Per-user and per-endpoint limits"],
    phases: [{ id: "clarify", label: "Clarify" }]
  };
  const bare = buildCriteriaPrompt(args);
  assert.equal(buildCriteriaPrompt({ ...args, signatureChallenge: undefined }), bare);
  assert.doesNotMatch(bare, /SIGNATURE CHALLENGE/);
});

test("generation and backfill hold the narrative to the same rules", () => {
  const backfill = buildProblemNarrativePrompt({
    title: "Shared rate limiter",
    statement: "Design a rate limiter shared across services.",
    difficulty: "medium",
    constraints: ["Per-user and per-endpoint limits"]
  });
  const generation = buildProblemPrompt("medium");

  for (const prompt of [backfill, generation]) {
    assert.match(prompt, /MUST name a concrete mechanism/);
    assert.match(prompt, /NOT signature challenges/);
    assert.match(prompt, /a SCALE nudge/);
    assert.match(prompt, /a FAILURE-MODE nudge/);
    assert.match(prompt, /a DEBUG \/ OPERATIONAL nudge/);
  }
  // The backfill must not invite a rewrite of what already exists.
  assert.match(backfill, /Do NOT rewrite the statement or the constraints/);
});

const referenceArgs = {
  title: "Shared rate limiter",
  statement: "Design a rate limiter shared across services.",
  difficulty: "medium" as const,
  constraints: ["Per-user and per-endpoint limits"]
};

test("the reference prompt is unchanged without a rubric", () => {
  const bare = buildReferenceSolutionPrompt(referenceArgs);

  assert.equal(buildReferenceSolutionPrompt({ ...referenceArgs, criteria: undefined }), bare);
  assert.equal(buildReferenceSolutionPrompt({ ...referenceArgs, criteria: [] }), bare);
  assert.doesNotMatch(bare, /criterionCoverage/);
  assert.doesNotMatch(bare, /THE RUBRIC THIS ATTEMPT WAS GRADED AGAINST/);
  assert.match(bare, /^Constraints:$/m);
});

test("an interview-scoped reference must address every core criterion", () => {
  const prompt = buildReferenceSolutionPrompt({
    ...referenceArgs,
    constraints: ["Limits must hold across all service instances"],
    criteria,
    signatureChallenge: narrative.signatureChallenge
  });

  assert.match(prompt, /Active scope \(the live constraint set this attempt was graded against\)/);
  assert.match(prompt, /id=tenant_isolation \(core, security\)/);
  assert.match(prompt, /satisfiedBy: tenant_id scoped queries/);
  assert.match(prompt, /Every criterion with importance="core" MUST be explicitly addressed/);
  assert.match(prompt, /criterionCoverage: one entry per core criterion/);
  assert.match(prompt, /invented ids are discarded/);
  // The signature challenge is the decision the problem bends around.
  assert.match(prompt, /SIGNATURE CHALLENGE/);
  assert.match(prompt, /'it depends' is not an answer/);
});

const TRACKS = TrackSchema.options;

test("omitting the track leaves the problem prompt byte-identical", () => {
  for (const difficulty of DIFFICULTIES) {
    const bare = buildProblemPrompt(difficulty);
    assert.equal(buildProblemPrompt(difficulty, undefined, undefined, undefined), bare);
    assert.doesNotMatch(bare, /Track guidance for/);
    assert.doesNotMatch(bare, /Shape the phases around the/);
  }
});

test("every track fills all four slots and excludes other tracks' concerns", () => {
  for (const track of TRACKS) {
    const block = trackContextBlock(track);
    for (const slot of TRACK_SLOTS) {
      assert.match(block, new RegExp(`^${slot}:`, "m"), `${track} is missing "${slot}"`);
    }
    // The Avoid slot is what keeps a frontend problem from being graded on
    // sharding, so it must never be empty.
    const avoid = block.split(/^Avoid: /m)[1] ?? "";
    assert.ok(avoid.trim().length > 20, `${track} has an empty Avoid list`);
  }
});

test("no two tracks produce the same guidance", () => {
  const seen = new Set<string>();
  for (const track of TRACKS) {
    const block = trackContextBlock(track).replace(`Track guidance for ${track}:`, "");
    assert.equal(seen.has(block), false, `${track} duplicates another track`);
    seen.add(block);
  }
});

test("track and difficulty compose without either winning outright", () => {
  const prompt = buildProblemPrompt("beginner", undefined, undefined, "frontend");

  // Beginner breadth limits survive.
  assert.match(prompt, /two to four labeled boxes/);
  assert.match(prompt, /globe-scale assumptions, geo-distributed deploys/);
  // Frontend subject matter arrives alongside them.
  assert.match(prompt, /Track guidance for frontend/);
  assert.match(prompt, /conflict resolution when two clients edit the same thing/);
  // And the tie-break is stated rather than left to the model.
  assert.match(prompt, /difficulty wins on BREADTH .*track wins on SUBJECT/s);
});

test("a frontend problem's plan is told to replace phases that do not fit", () => {
  const prompt = buildProblemPrompt("medium", undefined, undefined, "frontend");
  assert.match(prompt, /Shape the phases around the frontend track/);
  assert.match(prompt, /component\/state-model phase/);
});

test("the criteria prompt targets track concerns and is unchanged without one", () => {
  const args = {
    difficulty: "medium" as const,
    interviewerLevel: "standard" as const,
    title: "Collaborative spreadsheet",
    statement: "Design a collaborative spreadsheet editor.",
    seedConstraints: ["Up to 20 concurrent editors per sheet"],
    phases: [{ id: "clarify", label: "Clarify" }]
  };

  const bare = buildCriteriaPrompt(args);
  assert.equal(buildCriteriaPrompt({ ...args, track: undefined }), bare);
  assert.doesNotMatch(bare, /Track guidance for/);

  const scoped = buildCriteriaPrompt({ ...args, track: "frontend" as Track });
  assert.match(scoped, /Track guidance for frontend/);
  assert.match(scoped, /Criteria must target frontend concerns/);
  assert.match(scoped, /Do NOT require expertise that belongs to a different track/);
  // The frontend Avoid list is what actually rules sharding out.
  assert.match(scoped, /Avoid: database sharding and replication topology/);
});

const validationScope = {
  constraints: ["Up to 500 tenants"],
  criteria
};

test("the process block appears only when there is a transcript", () => {
  const bare = buildValidationPrompt("medium", "", validationScope);
  assert.doesNotMatch(bare, /PROCESS ASSESSMENT/);
  assert.doesNotMatch(bare, /- processAssessment:/);
  // Supplying a level without a transcript changes nothing: there is still no
  // conversation to judge.
  assert.equal(
    buildValidationPrompt("medium", "", { ...validationScope, interviewerLevel: "staff" }),
    bare
  );

  const withTranscript = buildValidationPrompt("medium", "", {
    ...validationScope,
    interviewTranscript: "[Candidate]\nDo tenants ever share audit entries?"
  });
  assert.match(withTranscript, /PROCESS ASSESSMENT/);
  assert.match(withTranscript, /- processAssessment: object with/);
});

test("the process block forbids inferring rigidity from silence", () => {
  const prompt = buildValidationPrompt("medium", "", {
    ...validationScope,
    interviewTranscript: "[Candidate]\nI'll assume single-region."
  });

  assert.match(prompt, /Use `not_tested` when the interviewer never actually challenged/);
  assert.match(prompt, /NEVER infer rigidity from silence/);
  assert.match(prompt, /A beautiful diagram is not evidence of good process/);
  assert.match(prompt, /REPORTED to the candidate, never scored/);
});

test("the drove judgement is calibrated to the interviewer level", () => {
  const guided = buildValidationPrompt("medium", "", {
    ...validationScope,
    interviewTranscript: "[Candidate]\nWhat scale are we at?",
    interviewerLevel: "guided"
  });
  const staff = buildValidationPrompt("medium", "", {
    ...validationScope,
    interviewTranscript: "[Candidate]\nWhat scale are we at?",
    interviewerLevel: "staff"
  });

  assert.match(guided, /`interviewer_led` is therefore NEUTRAL here/);
  assert.match(staff, /Anything short of `candidate_led` is the headline observation/);
  assert.notEqual(guided, staff);
});

test("without a level the drove rule still refuses to treat being led as a fault", () => {
  const prompt = buildValidationPrompt("medium", "", {
    ...validationScope,
    interviewTranscript: "[Candidate]\nWhat scale are we at?"
  });
  assert.match(prompt, /do not treat `interviewer_led` as a fault/);
});

test("the debrief promotes proactiveness when the process assessment is present", () => {
  const prompt = buildDebriefPrompt({
    ...debriefBase,
    scoring: {
      processAssessment: {
        clarifiedBeforeDesigning: "yes",
        decisiveness: "decides_and_justifies",
        surfacedOwnLimitations: true,
        adaptedWhenChallenged: "not_tested",
        drove: "candidate_led",
        observations: [
          {
            signal: "Named the hot-key risk in their own sharding scheme unprompted.",
            evidence: '"one tenant could dominate a shard here, which I\'d want to measure"'
          }
        ]
      }
    }
  });

  assert.match(prompt, /HOW THEY WORKED/);
  assert.match(prompt, /Who drove the session: candidate_led/);
  assert.match(prompt, /Proactiveness is the strongest seniority signal/);
  assert.match(prompt, /hot-key risk/);
});

test("the debrief omits the process block when there is no assessment", () => {
  assert.doesNotMatch(buildDebriefPrompt(debriefBase), /HOW THEY WORKED/);
});

test("tutor usage reaches the debrief as context, never as a deduction", () => {
  const prompt = buildDebriefPrompt({
    ...debriefBase,
    tutorUsage: {
      sessions: 1,
      candidateTurns: 4,
      firstUsedAtPhase: "Deep dive",
      topics: ["partitioning", "hot keys"]
    }
  });

  assert.match(prompt, /consulted the tutor 4 times across 1 session/);
  assert.match(prompt, /mostly about partitioning, hot keys/);
  assert.match(prompt, /First opened during Deep dive/);
  assert.match(prompt, /This is CONTEXT, not a deduction/);
  assert.match(prompt, /do not lower your recommendation for it/);
  assert.match(prompt, /do not mention it in `whereTheyStruggled` or `riskAreas`/);
  // The one place it IS useful.
  assert.match(prompt, /fold those topics into `studyPlan`/);
});

test("the debrief omits the tutor block when the tutor was never used", () => {
  assert.doesNotMatch(buildDebriefPrompt(debriefBase), /TUTOR USE DURING THE SESSION/);
  assert.doesNotMatch(
    buildDebriefPrompt({
      ...debriefBase,
      tutorUsage: { sessions: 1, candidateTurns: 0, firstUsedAtPhase: null, topics: [] }
    }),
    /TUTOR USE DURING THE SESSION/
  );
});
