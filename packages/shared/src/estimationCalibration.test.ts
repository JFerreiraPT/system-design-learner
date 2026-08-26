import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrateAll,
  calibrateField,
  evaluateDerivedFormulas,
  evaluateExpression,
  normalizeEstimationSpec,
  type EstimationFieldSpec,
  type EstimationProblemSpec
} from "./index.js";

/* -------------------------------------------------------------- *
 * Expression evaluator
 * -------------------------------------------------------------- */

const SCOPE = { a: 10, b: 4, dau: 100_000, sessions: 3, payload: 1024 };

test("evaluator respects operator precedence", () => {
  assert.equal(evaluateExpression("a + b * 2", SCOPE), 18);
  assert.equal(evaluateExpression("a * 2 + b", SCOPE), 24);
  assert.equal(evaluateExpression("a - b - 2", SCOPE), 4); // left-associative
  assert.equal(evaluateExpression("a / b / 5", SCOPE), 0.5);
});

test("evaluator honours parentheses", () => {
  assert.equal(evaluateExpression("(a + b) * 2", SCOPE), 28);
  assert.equal(evaluateExpression("a * (b - 2)", SCOPE), 20);
  assert.equal(evaluateExpression("((a))", SCOPE), 10);
});

test("evaluator supports unary minus", () => {
  assert.equal(evaluateExpression("-a", SCOPE), -10);
  assert.equal(evaluateExpression("-a + b", SCOPE), -6);
  assert.equal(evaluateExpression("b * -2", SCOPE), -8);
  assert.equal(evaluateExpression("-(a + b)", SCOPE), -14);
});

test("evaluator handles numeric literals including decimals", () => {
  assert.equal(evaluateExpression("2.5 * 4", SCOPE), 10);
  assert.equal(evaluateExpression("86400", SCOPE), 86400);
  assert.equal(evaluateExpression("dau * sessions / 86400", SCOPE), 300_000 / 86400);
});

test("evaluator returns undefined for an unknown identifier", () => {
  assert.equal(evaluateExpression("ghost * 2", SCOPE), undefined);
  assert.equal(evaluateExpression("a + missing_field", SCOPE), undefined);
});

test("evaluator returns undefined for a blank or non-finite field value", () => {
  assert.equal(evaluateExpression("a * 2", { a: Number.NaN }), undefined);
  assert.equal(evaluateExpression("a * 2", { a: Number.POSITIVE_INFINITY }), undefined);
  assert.equal(evaluateExpression("a * 2", {}), undefined);
});

test("evaluator returns undefined for division by zero", () => {
  assert.equal(evaluateExpression("a / 0", SCOPE), undefined);
  assert.equal(evaluateExpression("a / (b - 4)", SCOPE), undefined);
});

test("evaluator returns undefined for malformed input", () => {
  const malformed = [
    "",
    "   ",
    "a +",
    "* a",
    "a b",
    "(a + b",
    "a + b)",
    "()",
    "a ^ 2",
    "a % 2",
    "a, b",
    "DAU * 2",
    "a; drop table",
    "require('fs')",
    "1 + (2 * 3"
  ];
  for (const expression of malformed) {
    assert.equal(
      evaluateExpression(expression, SCOPE),
      undefined,
      `expected "${expression}" to be rejected`
    );
  }
});

test("evaluator handles nested parentheses without stack overflow", () => {
  // Parsing is iterative (shunting-yard), so depth costs heap, not stack.
  const depth = 100;
  const deep = "(".repeat(depth) + "a" + ")".repeat(depth);
  assert.equal(evaluateExpression(deep, SCOPE), 10);

  const unbalanced = "(".repeat(depth) + "a";
  assert.equal(evaluateExpression(unbalanced, SCOPE), undefined);
});

test("pathological nesting is rejected by the token cap, not by crashing", () => {
  // The schema caps expressions at 200 chars, so this can only arrive from a
  // hand-edited row. It must return undefined rather than throw or hang.
  const depth = 5000;
  for (const expression of [
    "(".repeat(depth) + "a" + ")".repeat(depth),
    "(".repeat(depth) + "a"
  ]) {
    assert.doesNotThrow(() => evaluateExpression(expression, SCOPE));
    assert.equal(evaluateExpression(expression, SCOPE), undefined);
  }
});

test("evaluator rejects absurdly long token streams", () => {
  const huge = Array.from({ length: 500 }, () => "a").join(" + ");
  assert.equal(evaluateExpression(huge, SCOPE), undefined);
});

test("evaluator returns undefined when a result overflows", () => {
  assert.equal(evaluateExpression("1e400", SCOPE), undefined); // 'e' is not in the grammar
  const big = { big: Number.MAX_VALUE };
  assert.equal(evaluateExpression("big * big", big), undefined);
});

/* -------------------------------------------------------------- *
 * Field calibration
 * -------------------------------------------------------------- */

function field(overrides: Partial<EstimationFieldSpec> = {}): EstimationFieldSpec {
  return {
    key: "payload",
    label: "Average payload",
    type: "number",
    unitKind: "bytes",
    expectedMagnitude: { min: 200, max: 20_000, rationale: "~1KB is typical for text." },
    ...overrides
  };
}

test("calibrateField is quiet inside the band", () => {
  assert.deepEqual(calibrateField(field(), 1024), { verdict: "ok" });
  assert.deepEqual(calibrateField(field(), 200), { verdict: "ok" });
  assert.deepEqual(calibrateField(field(), 20_000), { verdict: "ok" });
});

test("calibrateField reports direction and rationale outside the band", () => {
  const low = calibrateField(field(), 20);
  assert.equal(low.verdict, "off-by-one-order");
  assert.equal(low.direction, "low");
  assert.equal(low.rationale, "~1KB is typical for text.");

  const high = calibrateField(field(), 200_000);
  assert.equal(high.verdict, "off-by-one-order");
  assert.equal(high.direction, "high");
});

test("calibrateField escalates to way-off beyond 100x", () => {
  assert.equal(calibrateField(field(), 2).verdict, "way-off"); // 100x below min
  assert.equal(calibrateField(field(), 2_000_000).verdict, "way-off"); // 100x above max
  assert.equal(calibrateField(field(), 2.01).verdict, "off-by-one-order");
});

test("calibrateField treats zero and negatives as way-off rather than dividing", () => {
  assert.equal(calibrateField(field(), 0).verdict, "way-off");
  assert.equal(calibrateField(field(), -5).verdict, "way-off");
  assert.equal(calibrateField(field(), 0).direction, "low");
});

test("calibrateField says unknown for text fields, missing bands, and blanks", () => {
  assert.equal(calibrateField(field({ type: "text" }), 5).verdict, "unknown");
  assert.equal(calibrateField(field({ expectedMagnitude: undefined }), 5).verdict, "unknown");
  assert.equal(calibrateField(field(), undefined).verdict, "unknown");
  assert.equal(calibrateField(field(), Number.NaN).verdict, "unknown");
});

test("calibrateAll summarises the checklist", () => {
  const spec: EstimationProblemSpec = {
    fields: [
      field({ key: "in_band" }),
      field({ key: "one_order" }),
      field({ key: "far_off" }),
      field({ key: "no_band", expectedMagnitude: undefined }),
      field({ key: "notes", type: "text", expectedMagnitude: undefined })
    ]
  };
  const result = calibrateAll(spec, {
    in_band: 1024,
    one_order: 20,
    far_off: 1,
    no_band: 7,
    notes: "assuming text only"
  });

  assert.equal(result.perField.in_band?.verdict, "ok");
  assert.equal(result.perField.one_order?.verdict, "off-by-one-order");
  assert.equal(result.perField.far_off?.verdict, "way-off");
  assert.equal(result.perField.no_band?.verdict, "unknown");
  assert.equal(result.perField.notes?.verdict, "unknown");
  assert.equal(result.offByOne, 1);
  assert.equal(result.wayOff, 1);
  assert.equal(result.filled, 5);
  assert.equal(result.total, 5);
});

test("calibrateAll counts blanks as unfilled and never flags them", () => {
  const spec: EstimationProblemSpec = {
    fields: [field({ key: "a" }), field({ key: "b" }), field({ key: "c" })]
  };
  const result = calibrateAll(spec, { a: 1024, b: undefined, c: "" });
  assert.equal(result.filled, 1);
  assert.equal(result.total, 3);
  assert.equal(result.offByOne, 0);
  assert.equal(result.wayOff, 0);
});

test("a spec with no bands produces unknown everywhere", () => {
  const spec: EstimationProblemSpec = {
    fields: [
      { key: "dau", label: "DAU", type: "number" },
      { key: "notes", label: "Notes", type: "text" },
      { key: "payload", label: "Payload", type: "number", unit: "bytes" }
    ]
  };
  const result = calibrateAll(spec, { dau: 1_000_000_000, payload: 1 });
  assert.equal(result.offByOne, 0);
  assert.equal(result.wayOff, 0);
  for (const verdict of Object.values(result.perField)) {
    assert.equal(verdict.verdict, "unknown");
  }
});

/* -------------------------------------------------------------- *
 * Derived formulas
 * -------------------------------------------------------------- */

const FORMULA_SPEC: EstimationProblemSpec = {
  fields: [
    { key: "dau", label: "DAU", type: "number", unitKind: "count" },
    { key: "sessions", label: "Sessions/user/day", type: "number", unitKind: "count" },
    { key: "payload", label: "Payload", type: "number", unitKind: "bytes" }
  ],
  derivedFormulas: [
    {
      id: "avg_rps",
      label: "Average RPS",
      expression: "dau * sessions / 86400",
      unitKind: "count",
      displayUnit: "req/s"
    },
    {
      id: "daily_bytes",
      label: "Daily bytes",
      expression: "dau * sessions * payload",
      unitKind: "bytes"
    }
  ]
};

test("evaluateDerivedFormulas computes from base-unit values", () => {
  const out = evaluateDerivedFormulas(FORMULA_SPEC, {
    dau: 86_400,
    sessions: 2,
    payload: 1024
  });
  assert.equal(out.length, 2);
  assert.equal(out[0]?.id, "avg_rps");
  assert.equal(out[0]?.value, 2);
  assert.equal(out[0]?.displayUnit, "req/s");
  assert.equal(out[1]?.value, 86_400 * 2 * 1024);
});

test("evaluateDerivedFormulas yields undefined for incomplete input", () => {
  const out = evaluateDerivedFormulas(FORMULA_SPEC, { dau: 86_400 });
  assert.equal(out.length, 2);
  assert.equal(out[0]?.value, undefined);
  assert.equal(out[1]?.value, undefined);
  // labels survive so the panel can still show the row
  assert.equal(out[0]?.label, "Average RPS");
});

test("evaluateDerivedFormulas returns nothing when the spec has no formulas", () => {
  assert.deepEqual(evaluateDerivedFormulas({ fields: FORMULA_SPEC.fields }, { dau: 1 }), []);
});

test("normalizeEstimationSpec drops unevaluable formulas", () => {
  const out = normalizeEstimationSpec({
    fields: [
      { key: "dau", label: "DAU", type: "number", unitKind: "count" },
      { key: "n", label: "N", type: "number", unitKind: "count" },
      { key: "notes", label: "Notes", type: "text" }
    ],
    derivedFormulas: [
      { id: "good", label: "Good", expression: "dau * n / 86400", unitKind: "count" },
      { id: "unknown_ref", label: "Bad ref", expression: "ghost * 2", unitKind: "count" },
      { id: "bad_syntax", label: "Bad syntax", expression: "dau *", unitKind: "count" },
      { id: "text_ref", label: "Text ref", expression: "notes + 1", unitKind: "count" }
    ]
  });

  assert.deepEqual(
    out.derivedFormulas?.map((f) => f.id),
    ["good"]
  );
});

test("normalizeEstimationSpec leaves specs without formulas alone", () => {
  const spec: EstimationProblemSpec = {
    fields: [
      { key: "dau", label: "DAU", type: "number" },
      { key: "n", label: "N", type: "number" },
      { key: "notes", label: "Notes", type: "text" }
    ]
  };
  assert.deepEqual(normalizeEstimationSpec(spec), spec);
  assert.ok(!("derivedFormulas" in normalizeEstimationSpec(spec)));
});
