import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_MODEL_DEFAULTS,
  AI_MODEL_ENV_KEYS,
  resolveAiModels,
  type AiModelPurpose
} from "./ai.models.js";
import {
  repairNarrative,
  resolveCriterionCoverage,
  sanitizeGeneratedPlaybook,
  sanitizeProcessAssessment
} from "./ai.service.js";
import type { RubricCriterion } from "@sdl/shared";

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

test("sanitizeGeneratedPlaybook filters invalid phase and criterion refs", () => {
  const playbook = sanitizeGeneratedPlaybook({
    criteria,
    phases: [{ id: "clarify", label: "Clarify" }],
    raw: {
      areasToProbe: [
        {
          id: "Auth & Isolation",
          label: "Auth & Isolation",
          phaseRefs: ["clarify", "made_up_phase"],
          criterionRefs: ["tenant_isolation", "missing_criterion"],
          sampleQuestions: ["Walk me through auth."],
          progressiveNudges: ["Who can access this?", "Where is it checked?", "Show the guard."],
          greenFlags: ["Names server-side tenant authorization."],
          redFlags: ["Trusts tenantId from the client."]
        }
      ],
      scoreRubric: {
        "1": "Cannot structure the design.",
        "2": "Misses important constraints.",
        "3": "Covers core trade-offs.",
        "4": "Drives the conversation with operational depth."
      }
    }
  });

  assert.equal(playbook.areasToProbe[0]?.id, "auth_isolation");
  assert.deepEqual(playbook.areasToProbe[0]?.phaseRefs, ["clarify"]);
  assert.deepEqual(playbook.areasToProbe[0]?.criterionRefs, ["tenant_isolation"]);
});

const PURPOSES = Object.keys(AI_MODEL_DEFAULTS) as AiModelPurpose[];

test("with nothing set, every purpose resolves to its documented default", () => {
  const models = resolveAiModels(() => undefined);
  assert.deepEqual(models, { ...AI_MODEL_DEFAULTS });
});

test("generation runs on the stronger tier and the per-turn matchers stay cheap", () => {
  const models = resolveAiModels(() => undefined);

  // The two artefacts everything downstream depends on.
  assert.equal(models.problemGeneration, "gpt-4o");
  assert.equal(models.criteriaGeneration, "gpt-4o");
  // Unchanged from the previous effective assignment.
  assert.equal(models.validation, "gpt-4o");
  assert.equal(models.reference, "gpt-4o");
  assert.equal(models.interviewerChat, "gpt-4o");
  assert.equal(models.tutorChat, "gpt-4o-mini");
  assert.equal(models.discoveryMatch, "gpt-4o-mini");
  assert.equal(models.proposals, "gpt-4o-mini");
  assert.equal(models.backfill, "gpt-4o-mini");
});

test("each purpose is overridable by exactly its own env var", () => {
  for (const purpose of PURPOSES) {
    const key = AI_MODEL_ENV_KEYS[purpose];
    const models = resolveAiModels((k) => (k === key ? "o4-custom" : undefined));

    assert.equal(models[purpose], "o4-custom", `${key} did not override ${purpose}`);
    for (const other of PURPOSES) {
      if (other === purpose) continue;
      assert.equal(
        models[other],
        AI_MODEL_DEFAULTS[other],
        `${key} leaked into ${other}`
      );
    }
  }
});

test("an empty or malformed override falls back instead of throwing", () => {
  for (const raw of ["", "   ", "gpt-4o # inline comment", "some model name"]) {
    const models = resolveAiModels((k) =>
      k === AI_MODEL_ENV_KEYS.validation ? raw : undefined
    );
    assert.equal(
      models.validation,
      AI_MODEL_DEFAULTS.validation,
      `"${raw}" should not have been accepted as a model id`
    );
  }
});

test("every purpose has a distinct env key", () => {
  const keys = PURPOSES.map((p) => AI_MODEL_ENV_KEYS[p]);
  assert.equal(new Set(keys).size, keys.length);
});

const goodFraming =
  "So, we run an internal API platform and every team keeps writing their own throttling. I'd like you to design the shared rate limiter they'd all call. Start wherever makes sense to you.";
const goodSignature =
  "When the shared counter store is unreachable the limiter must choose fail-open or fail-closed, and defend the call.";
const goodReveals = [
  "Let's say this now fronts about 100 services and a few million calls a minute.",
  "How would your design change if the counter store went down entirely?",
  "A customer says they're being limited but shouldn't be — how do you work out why?"
];

test("repairNarrative keeps a complete narrative and normalises the reveals tuple", () => {
  const narrative = repairNarrative({
    framingScript: `  ${goodFraming}  `,
    signatureChallenge: goodSignature,
    progressiveReveals: [...goodReveals, "a fourth reveal that should be dropped for length"]
  });

  assert.equal(narrative?.framingScript, goodFraming);
  assert.equal(narrative?.signatureChallenge, goodSignature);
  assert.deepEqual(narrative?.progressiveReveals, goodReveals);
});

test("repairNarrative drops fields independently rather than the whole narrative", () => {
  // A too-short framing script must not cost us the signature challenge.
  const partial = repairNarrative({
    framingScript: "Design a rate limiter.",
    signatureChallenge: goodSignature,
    progressiveReveals: goodReveals.slice(0, 2)
  });

  assert.equal(partial?.framingScript, undefined);
  assert.equal(partial?.progressiveReveals, undefined);
  assert.equal(partial?.signatureChallenge, goodSignature);
});

test("repairNarrative returns null when nothing usable survives", () => {
  assert.equal(repairNarrative(undefined), null);
  assert.equal(repairNarrative({}), null);
  assert.equal(
    repairNarrative({ framingScript: "too short", signatureChallenge: "also short" }),
    null
  );
});

test("repairNarrative truncates over-long fields instead of discarding them", () => {
  const narrative = repairNarrative({
    framingScript: goodFraming.padEnd(2000, " and more context"),
    signatureChallenge: goodSignature.padEnd(1500, " plus detail"),
    progressiveReveals: goodReveals.map((r) => r.padEnd(800, " extra"))
  });

  assert.ok((narrative?.framingScript?.length ?? 0) <= 900);
  assert.ok((narrative?.signatureChallenge?.length ?? 0) <= 400);
  for (const reveal of narrative?.progressiveReveals ?? []) {
    assert.ok(reveal.length <= 300);
  }
});

test("criterion coverage entries that name no real criterion are dropped", () => {
  const resolved = resolveCriterionCoverage(
    [
      { criterionId: "tenant_isolation", howAddressed: "Every query is scoped by tenant_id." },
      { criterionId: "invented_criterion", howAddressed: "Something the rubric never asked for." },
      { criterionId: "tenant_isolation", howAddressed: "A duplicate for the same criterion." },
      { criterionId: "tenant_isolation ", howAddressed: "   " }
    ],
    criteria
  );

  assert.deepEqual(resolved, [
    { criterionId: "tenant_isolation", howAddressed: "Every query is scoped by tenant_id." }
  ]);
});

test("criterion coverage is absent rather than empty when nothing resolves", () => {
  assert.equal(resolveCriterionCoverage(undefined, criteria), undefined);
  assert.equal(resolveCriterionCoverage([], criteria), undefined);
  assert.equal(
    resolveCriterionCoverage(
      [{ criterionId: "nope", howAddressed: "irrelevant" }],
      criteria
    ),
    undefined
  );
  // No rubric at all: the generic per-problem reference has nothing to map to.
  assert.equal(
    resolveCriterionCoverage(
      [{ criterionId: "tenant_isolation", howAddressed: "scoped queries" }],
      undefined
    ),
    undefined
  );
});

const rawProcess = {
  clarifiedBeforeDesigning: "yes" as const,
  decisiveness: "decides_and_justifies" as const,
  surfacedOwnLimitations: true,
  adaptedWhenChallenged: "not_tested" as const,
  drove: "candidate_led" as const,
  observations: [
    { signal: "  Clarified tenancy before drawing.  ", evidence: '  "do tenants share data?"  ' },
    { signal: "Named their own hot-key risk.", evidence: '"one tenant could dominate a shard"' }
  ]
};

test("a process assessment is dropped entirely when there was no transcript", () => {
  // A bare board validation has no process to assess; inventing one from a
  // diagram would be a fabricated behavioural verdict.
  assert.equal(sanitizeProcessAssessment(rawProcess, false), undefined);
  assert.equal(sanitizeProcessAssessment(undefined, true), undefined);
});

test("a process assessment is trimmed rather than rejected", () => {
  const process = sanitizeProcessAssessment(rawProcess, true);

  assert.equal(process?.drove, "candidate_led");
  assert.equal(process?.adaptedWhenChallenged, "not_tested");
  assert.deepEqual(process?.observations[0], {
    signal: "Clarified tenancy before drawing.",
    evidence: '"do tenants share data?"'
  });
  assert.equal(process?.observations.length, 2);
});

test("observations with no evidence are dropped, and an evidence-free assessment is discarded", () => {
  const partial = sanitizeProcessAssessment(
    {
      ...rawProcess,
      observations: [
        { signal: "A claim with no evidence", evidence: "   " },
        { signal: "A real one", evidence: '"I would shard by tenant"' }
      ]
    },
    true
  );
  assert.deepEqual(partial?.observations, [
    { signal: "A real one", evidence: '"I would shard by tenant"' }
  ]);

  assert.equal(
    sanitizeProcessAssessment({ ...rawProcess, observations: [] }, true),
    undefined
  );
  assert.equal(
    sanitizeProcessAssessment(
      { ...rawProcess, observations: [{ signal: "no pointer", evidence: "" }] },
      true
    ),
    undefined
  );
});

test("at most four observations survive", () => {
  const process = sanitizeProcessAssessment(
    {
      ...rawProcess,
      observations: Array.from({ length: 8 }, (_, i) => ({
        signal: `signal ${i}`,
        evidence: `evidence ${i}`
      }))
    },
    true
  );
  assert.equal(process?.observations.length, 4);
});
