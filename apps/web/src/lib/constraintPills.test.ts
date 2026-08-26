import assert from "node:assert/strict";
import test from "node:test";
import { resolveConstraintPill } from "./constraintPills.js";

test("a constraint with no importance gets no pill", () => {
  assert.equal(resolveConstraintPill({ importance: undefined }, new Set()), null);
});

test("a plain scope constraint shows its importance without discovery framing", () => {
  assert.deepEqual(resolveConstraintPill({ importance: "core" }, new Set(["x"])), {
    importance: "core",
    discovered: false
  });
});

test("a resolvable discovery is credited as discovered", () => {
  assert.deepEqual(
    resolveConstraintPill(
      { importance: "expected", discoveredFromCriterionId: "tenant_isolation" },
      new Set(["tenant_isolation"])
    ),
    { importance: "expected", discovered: true }
  );
});

test("a dangling discovery reference drops the pill instead of throwing", () => {
  // This is the state after a mid-interview rubric regeneration: the criterion
  // the constraint was discovered from no longer exists, so claiming the
  // discovery would misreport the candidate's progress.
  assert.equal(
    resolveConstraintPill(
      { importance: "core", discoveredFromCriterionId: "criterion_that_was_regenerated_away" },
      new Set(["a_different_criterion"])
    ),
    null
  );
  assert.equal(
    resolveConstraintPill(
      { importance: "core", discoveredFromCriterionId: "gone" },
      new Set()
    ),
    null
  );
});

test("with criteria not loaded yet, importance shows but discovery is not asserted", () => {
  assert.deepEqual(
    resolveConstraintPill(
      { importance: "core", discoveredFromCriterionId: "tenant_isolation" },
      undefined
    ),
    { importance: "core", discovered: false }
  );
});
