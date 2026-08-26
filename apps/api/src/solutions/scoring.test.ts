import assert from "node:assert/strict";
import test from "node:test";
import type {
  InterviewerPlaybook,
  RubricCriterion,
  ValidationDimensions
} from "@sdl/shared";
import { DEFAULT_SCORE_BAND_DESCRIPTIONS, scoreBandFor } from "@sdl/shared";
import {
  blendScore,
  computeDesignScore,
  computeDiscoveryScore,
  estimateScoreFromDimensions,
  resolveScoreBand,
  type CriterionEvaluationInput
} from "./scoring.js";

function criterion(
  id: string,
  importance: RubricCriterion["importance"],
  overrides: Partial<RubricCriterion> = {}
): RubricCriterion {
  return {
    id,
    text: `expectation ${id}`,
    dimension: "requirements",
    importance,
    visibility: "visible",
    ...overrides
  };
}

function covered(id: string): CriterionEvaluationInput {
  return { criterionId: id, covered: true, discovered: true };
}

function missed(
  id: string,
  severity?: "high" | "medium" | "low"
): CriterionEvaluationInput {
  return { criterionId: id, covered: false, discovered: false, severity };
}

const FLAT_DIMENSIONS: ValidationDimensions = {
  requirements: 40,
  scalability: 40,
  reliability: 40,
  consistency: 40,
  latencyPerformance: 40,
  cost: 40,
  security: 40,
  operability: 40,
  capacityEstimation: 40
};

test("all criteria covered scores 100", () => {
  const criteria = [criterion("a", "core"), criterion("b", "expected")];
  const result = computeDesignScore({
    criteria,
    evaluations: [covered("a"), covered("b")],
    dimensionEstimate: 0
  });
  assert.equal(result.designScore, 100);
  assert.equal(result.scoringMode, "rubric");
  assert.deepEqual(result.coreCovered, ["a"]);
  assert.deepEqual(result.coreMissed, []);
});

test("all criteria missed at high severity scores 0", () => {
  const criteria = [criterion("a", "core"), criterion("b", "expected")];
  const result = computeDesignScore({
    criteria,
    evaluations: [missed("a", "high"), missed("b", "high")],
    dimensionEstimate: 55
  });
  assert.equal(result.designScore, 0);
  assert.equal(result.scoringMode, "rubric");
  assert.deepEqual(result.coreMissed, ["a"]);
});

test("severity grants partial credit instead of a flat penalty", () => {
  // Two `expected` criteria (weight 2 each, total 4).
  // One covered (2), one missed at "low" (2 x 0.5 = 1) => 3/4 => 75.
  const criteria = [criterion("a", "expected"), criterion("b", "expected")];
  assert.equal(
    computeDesignScore({
      criteria,
      evaluations: [covered("a"), missed("b", "low")],
      dimensionEstimate: 0
    }).designScore,
    75
  );

  // Same shape, "medium" miss (2 x 0.25 = 0.5) => 2.5/4 => 63 (62.5 rounded).
  assert.equal(
    computeDesignScore({
      criteria,
      evaluations: [covered("a"), missed("b", "medium")],
      dimensionEstimate: 0
    }).designScore,
    63
  );
});

test("four missed cores no longer zero a mostly-covered design", () => {
  // The old flat model subtracted 25 per high-severity core miss, so four
  // misses hit 0 no matter how much else was covered.
  const criteria = [
    criterion("c1", "core"),
    criterion("c2", "core"),
    criterion("c3", "core"),
    criterion("c4", "core"),
    ...Array.from({ length: 10 }, (_, i) => criterion(`e${i}`, "expected"))
  ];
  const evaluations = [
    missed("c1", "high"),
    missed("c2", "high"),
    missed("c3", "high"),
    missed("c4", "high"),
    ...Array.from({ length: 10 }, (_, i) => covered(`e${i}`))
  ];
  // earned = 20 (the expecteds), total = 12 + 20 = 32 => 62.5 => 63.
  const result = computeDesignScore({ criteria, evaluations, dimensionEstimate: 0 });
  assert.equal(result.designScore, 63);
  assert.equal(result.coreMissed.length, 4);
});

test("missing severity defaults by importance", () => {
  // core -> "high" (0 credit), expected -> "medium" (0.25 credit).
  const criteria = [criterion("a", "core"), criterion("b", "expected")];
  const result = computeDesignScore({
    criteria,
    evaluations: [missed("a"), missed("b")],
    dimensionEstimate: 0
  });
  // earned = 0 + 2 x 0.25 = 0.5, total = 5 => 10.
  assert.equal(result.designScore, 10);
});

test("rubric size does not change the score for equal proportional coverage", () => {
  const small = Array.from({ length: 6 }, (_, i) => criterion(`s${i}`, "expected"));
  const smallEvals = small.map((c, i) =>
    i < 3 ? covered(c.id) : missed(c.id, "high")
  );
  const large = Array.from({ length: 14 }, (_, i) => criterion(`l${i}`, "expected"));
  const largeEvals = large.map((c, i) =>
    i < 7 ? covered(c.id) : missed(c.id, "high")
  );

  const smallScore = computeDesignScore({
    criteria: small,
    evaluations: smallEvals,
    dimensionEstimate: 0
  }).designScore;
  const largeScore = computeDesignScore({
    criteria: large,
    evaluations: largeEvals,
    dimensionEstimate: 0
  }).designScore;

  assert.equal(smallScore, 50);
  assert.equal(largeScore, 50);
  assert.equal(smallScore, largeScore);
});

test("covered stretch criteria add a capped bonus and missed ones cost nothing", () => {
  const base = [criterion("a", "expected"), criterion("b", "expected")];
  const baseEvals = [covered("a"), missed("b", "high")]; // => 50

  assert.equal(
    computeDesignScore({ criteria: base, evaluations: baseEvals, dimensionEstimate: 0 })
      .designScore,
    50
  );

  // Missing a stretch criterion must not move the score.
  const withMissedStretch = [...base, criterion("s1", "stretch")];
  assert.equal(
    computeDesignScore({
      criteria: withMissedStretch,
      evaluations: [...baseEvals, missed("s1", "high")],
      dimensionEstimate: 0
    }).designScore,
    50
  );

  // One covered stretch => +3.
  assert.equal(
    computeDesignScore({
      criteria: withMissedStretch,
      evaluations: [...baseEvals, covered("s1")],
      dimensionEstimate: 0
    }).designScore,
    53
  );

  // Three covered stretch => capped at +6, not +9.
  const withThree = [
    ...base,
    criterion("s1", "stretch"),
    criterion("s2", "stretch"),
    criterion("s3", "stretch")
  ];
  assert.equal(
    computeDesignScore({
      criteria: withThree,
      evaluations: [...baseEvals, covered("s1"), covered("s2"), covered("s3")],
      dimensionEstimate: 0
    }).designScore,
    56
  );
});

test("stretch bonus cannot push the score past 100", () => {
  const criteria = [criterion("a", "core"), criterion("s1", "stretch")];
  assert.equal(
    computeDesignScore({
      criteria,
      evaluations: [covered("a"), covered("s1")],
      dimensionEstimate: 0
    }).designScore,
    100
  );
});

test("an all-stretch rubric falls back instead of dividing by zero", () => {
  const criteria = [criterion("s1", "stretch"), criterion("s2", "stretch")];
  const result = computeDesignScore({
    criteria,
    evaluations: [covered("s1"), missed("s2", "high")],
    dimensionEstimate: 42
  });
  assert.equal(result.designScore, 42);
  assert.equal(result.scoringMode, "dimensions");
});

test("no criteria or no evaluations falls back to the dimension mean", () => {
  const noCriteria = computeDesignScore({
    criteria: null,
    evaluations: [covered("a")],
    dimensionEstimate: 37
  });
  assert.equal(noCriteria.designScore, 37);
  assert.equal(noCriteria.scoringMode, "dimensions");

  const noEvaluations = computeDesignScore({
    criteria: [criterion("a", "core")],
    evaluations: [],
    dimensionEstimate: 37
  });
  assert.equal(noEvaluations.designScore, 37);
  assert.equal(noEvaluations.scoringMode, "dimensions");
  assert.deepEqual(noEvaluations.coreCovered, []);
  assert.deepEqual(noEvaluations.coreMissed, []);
});

test("an unknown criterionId is ignored rather than throwing or scoring", () => {
  const criteria = [criterion("a", "expected")];
  const result = computeDesignScore({
    criteria,
    evaluations: [covered("a"), missed("hallucinated_id", "high")],
    dimensionEstimate: 0
  });
  assert.equal(result.designScore, 100);
  assert.equal(result.scoringMode, "rubric");
  assert.deepEqual(result.coreMissed, []);
});

test("every evaluation naming an unknown id falls back rather than scoring 0", () => {
  const result = computeDesignScore({
    criteria: [criterion("a", "core")],
    evaluations: [missed("ghost", "high")],
    dimensionEstimate: 61
  });
  assert.equal(result.designScore, 61);
  assert.equal(result.scoringMode, "dimensions");
});

test("designScore is never 0 while any non-stretch criterion is covered", () => {
  // Worst realistic case: one covered `expected` amongst the 40-criterion cap
  // of missed cores.
  const criteria = [
    criterion("kept", "expected"),
    ...Array.from({ length: 39 }, (_, i) => criterion(`c${i}`, "core"))
  ];
  const evaluations = [
    covered("kept"),
    ...Array.from({ length: 39 }, (_, i) => missed(`c${i}`, "high"))
  ];
  const result = computeDesignScore({ criteria, evaluations, dimensionEstimate: 0 });
  assert.ok(result.designScore > 0, `expected > 0, got ${result.designScore}`);
});

test("discovery score weights hidden criteria by importance", () => {
  // No criteria / no hiddens => nothing to discover => 100.
  assert.equal(computeDiscoveryScore(null), 100);
  assert.equal(computeDiscoveryScore([criterion("a", "core")]), 100);

  const hidden = (id: string, importance: RubricCriterion["importance"], found: boolean) =>
    criterion(id, importance, {
      visibility: "hidden",
      discoveredVia: found ? { kind: "candidate", at: "2026-01-01T00:00:00.000Z" } : null
    });

  // core (3) found, expected (2) not => 3/5 => 60.
  assert.equal(
    computeDiscoveryScore([hidden("h1", "core", true), hidden("h2", "expected", false)]),
    60
  );
  assert.equal(
    computeDiscoveryScore([hidden("h1", "core", false), hidden("h2", "expected", false)]),
    0
  );
  assert.equal(
    computeDiscoveryScore([hidden("h1", "core", true), hidden("h2", "expected", true)]),
    100
  );
});

test("dimension mean ignores null and missing dimensions", () => {
  assert.equal(estimateScoreFromDimensions(undefined), 0);
  assert.equal(estimateScoreFromDimensions(FLAT_DIMENSIONS), 40);
  assert.equal(
    estimateScoreFromDimensions({ ...FLAT_DIMENSIONS, cost: null, security: null }),
    40
  );
  assert.equal(
    estimateScoreFromDimensions({
      requirements: null,
      scalability: null,
      reliability: null,
      consistency: null,
      latencyPerformance: null,
      cost: null,
      security: null,
      operability: null,
      capacityEstimation: null
    }),
    0
  );
});

test("blend honours the configured design weight", () => {
  assert.equal(blendScore(100, 0, 0.7), 70);
  assert.equal(blendScore(0, 100, 0.7), 30);
  assert.equal(blendScore(80, 40, 0.7), 68);
  assert.equal(blendScore(80, 40, 1), 80);
  assert.equal(blendScore(80, 40, 0), 40);
});

const PLAYBOOK: InterviewerPlaybook = {
  areasToProbe: [
    {
      id: "scope",
      label: "Scope",
      phaseRefs: ["clarify"],
      criterionRefs: ["a"],
      sampleQuestions: ["Who are the users?"],
      progressiveNudges: ["Who uses this?", "How many of them?", "Name the peak."],
      greenFlags: ["Clarifies before designing."],
      redFlags: ["Draws boxes immediately."]
    }
  ],
  scoreRubric: {
    "1": "Cannot structure the rate limiter design.",
    "2": "In-memory counter only; no distributed story.",
    "3": "Correct algorithm, distributed state, failure modes covered.",
    "4": "Drives the conversation and covers client experience and ops."
  }
};

test("scoreBandFor maps every boundary value to the right band", () => {
  const cases: Array<[number, 1 | 2 | 3 | 4]> = [
    [0, 1],
    [39, 1],
    [40, 2],
    [64, 2],
    [65, 3],
    [84, 3],
    [85, 4],
    [100, 4]
  ];
  for (const [score, band] of cases) {
    assert.equal(scoreBandFor(score), band, `score ${score} should be band ${band}`);
  }
});

test("scoreBandFor clamps out-of-range and non-finite scores", () => {
  assert.equal(scoreBandFor(-10), 1);
  assert.equal(scoreBandFor(150), 4);
  assert.equal(scoreBandFor(Number.NaN), 1);
});

test("resolveScoreBand prefers the playbook wording for the matching band", () => {
  assert.deepEqual(resolveScoreBand(90, PLAYBOOK), {
    band: 4,
    label: "Drives the conversation and covers client experience and ops."
  });
  assert.deepEqual(resolveScoreBand(70, PLAYBOOK), {
    band: 3,
    label: "Correct algorithm, distributed state, failure modes covered."
  });
});

test("resolveScoreBand falls back to generic copy without a playbook", () => {
  const withoutPlaybook = resolveScoreBand(70, null);
  assert.equal(withoutPlaybook.band, 3);
  assert.equal(withoutPlaybook.label, DEFAULT_SCORE_BAND_DESCRIPTIONS[3]);
  assert.ok(withoutPlaybook.label.length > 0);

  assert.equal(resolveScoreBand(70, undefined).label, DEFAULT_SCORE_BAND_DESCRIPTIONS[3]);
});

test("resolveScoreBand ignores blank playbook wording", () => {
  const blank: InterviewerPlaybook = {
    ...PLAYBOOK,
    scoreRubric: { ...PLAYBOOK.scoreRubric, "3": "   " }
  };
  assert.equal(resolveScoreBand(70, blank).label, DEFAULT_SCORE_BAND_DESCRIPTIONS[3]);
});

test("flag observations never influence any score", () => {
  // Guards the "reported, not scored" contract: the scoring functions take no
  // flag input at all, so a fixture must score identically whether or not the
  // validator returned observations alongside it.
  const criteria = [criterion("a", "core"), criterion("b", "expected")];
  const evaluations = [covered("a"), missed("b", "medium")];

  const design = computeDesignScore({ criteria, evaluations, dimensionEstimate: 0 });
  const discovery = computeDiscoveryScore(criteria);
  const overall = blendScore(design.designScore, discovery, 0.7);

  // Same inputs, plus a full set of flag verdicts riding alongside them.
  const withFlags = {
    criteriaEvaluations: evaluations,
    flagObservations: [
      { areaId: "scope", kind: "green" as const, index: 0, text: "x", fired: true },
      { areaId: "scope", kind: "red" as const, index: 0, text: "y", fired: true }
    ]
  };
  const designAgain = computeDesignScore({
    criteria,
    evaluations: withFlags.criteriaEvaluations,
    dimensionEstimate: 0
  });

  assert.equal(designAgain.designScore, design.designScore);
  assert.equal(
    blendScore(designAgain.designScore, computeDiscoveryScore(criteria), 0.7),
    overall
  );
});
