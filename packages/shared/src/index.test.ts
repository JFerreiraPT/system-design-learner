import assert from "node:assert/strict";
import test from "node:test";
import {
  EstimationProblemSpecSchema,
  fromBaseUnit,
  getRubricCriteria,
  getRubricPlaybook,
  InterviewRubricSchema,
  LEGACY_ESTIMATION_SPEC,
  normalizeEstimationSpec,
  toBaseUnit,
  type EstimationFieldSpec,
  type EstimationProblemSpec,
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
