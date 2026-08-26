import assert from "node:assert/strict";
import test from "node:test";
import type { EstimationProblemSpec } from "@sdl/shared";
import { buildEstimationDigest } from "./estimationDigest.js";

const SPEC: EstimationProblemSpec = {
  intro: "Size the chat backend.",
  fields: [
    {
      key: "dau",
      label: "Daily active users",
      type: "number",
      unitKind: "count",
      expectedMagnitude: { min: 10_000, max: 1_000_000 }
    },
    {
      key: "payload_bytes",
      label: "Average message size",
      type: "number",
      unitKind: "bytes",
      displayUnit: "KB",
      displayMultiplier: 1024,
      expectedMagnitude: {
        min: 200,
        max: 20_000,
        rationale: "~1KB per message is typical for text chat"
      }
    },
    { key: "notes", label: "Assumptions", type: "text" }
  ],
  derivedFormulas: [
    {
      id: "daily_bytes",
      label: "Daily bytes",
      expression: "dau * payload_bytes",
      unitKind: "bytes",
      displayUnit: "B"
    }
  ]
};

test("digest reports per-field verdicts as facts", () => {
  // 1 byte is 200x below the band's floor of 200 => several orders out.
  const digest = buildEstimationDigest({
    estimationSpecJson: SPEC,
    estimation: { dau: 500_000, payload_bytes: 1, notes: "text only" }
  });

  assert.match(digest, /treat these verdicts as FACT/);
  assert.match(digest, /Daily active users \(dau\): 500,000 \(within the expected band\)/);
  assert.match(digest, /SEVERAL ORDERS OF MAGNITUDE TOO LOW/);
  assert.match(digest, /~1KB per message is typical for text chat/);
  assert.match(digest, /Assumptions \(notes\): text only/);

  // 4 bytes is only 50x below the floor => one order, not several.
  const milder = buildEstimationDigest({
    estimationSpecJson: SPEC,
    estimation: { payload_bytes: 4 }
  });
  assert.match(milder, /AN ORDER OF MAGNITUDE TOO LOW/);
  assert.doesNotMatch(milder, /SEVERAL ORDERS OF MAGNITUDE/);
});

test("digest converts stored base values back to display units", () => {
  const digest = buildEstimationDigest({
    estimationSpecJson: SPEC,
    estimation: { payload_bytes: 2048 }
  });
  // 2048 bytes stored -> shown as 2 KB, and 2048 is inside the band
  assert.match(digest, /Average message size \(payload_bytes\): 2 KB \(within the expected band\)/);
});

test("digest lists derived values and the completeness ratio", () => {
  const digest = buildEstimationDigest({
    estimationSpecJson: SPEC,
    estimation: { dau: 100_000, payload_bytes: 1024 }
  });

  assert.match(digest, /Derived from those values:/);
  assert.match(digest, /Daily bytes: 102,400,000 B/);
  assert.match(digest, /Completeness: 2\/3 checklist fields filled/);
});

test("digest marks unfilled fields and counts them out of the ratio", () => {
  const digest = buildEstimationDigest({
    estimationSpecJson: SPEC,
    estimation: { dau: 100_000 }
  });

  assert.match(digest, /Average message size \(payload_bytes\): \(not filled\)/);
  assert.match(digest, /Completeness: 1\/3 checklist fields filled/);
  // a formula missing an input is omitted rather than shown as garbage
  assert.doesNotMatch(digest, /Daily bytes:/);
});

test("digest counts calibration failures for the model", () => {
  const digest = buildEstimationDigest({
    estimationSpecJson: SPEC,
    estimation: { dau: 100, payload_bytes: 4 } // 100 DAU is 100x low; 4 bytes is way low
  });
  assert.match(digest, /1 field\(s\) off by 100x or more, 1 off by an order of magnitude/);
});

test("digest is empty when there is nothing to say", () => {
  assert.equal(buildEstimationDigest({ estimationSpecJson: null, estimation: null }), "");
  assert.equal(buildEstimationDigest({ estimationSpecJson: null, estimation: {} }), "");
});

test("digest falls back to raw JSON when the spec will not parse", () => {
  const digest = buildEstimationDigest({
    estimationSpecJson: { nonsense: true },
    estimation: { dau: 1000 }
  });
  assert.match(digest, /no checklist spec available/);
  assert.match(digest, /"dau": 1000/);
});

test("an empty checklist still produces a gradeable digest rather than throwing", () => {
  const digest = buildEstimationDigest({ estimationSpecJson: SPEC, estimation: {} });
  assert.match(digest, /Completeness: 0\/3 checklist fields filled/);
  assert.match(digest, /\(not filled\)/);
  assert.match(digest, /Score `capacityEstimation`/);
});

test("a spec with no magnitude bands reports values without verdicts", () => {
  const bandless: EstimationProblemSpec = {
    fields: [
      { key: "dau", label: "DAU", type: "number" },
      { key: "notes", label: "Notes", type: "text" },
      { key: "payload", label: "Payload", type: "number", unit: "bytes" }
    ]
  };
  const digest = buildEstimationDigest({
    estimationSpecJson: bandless,
    estimation: { dau: 1_000_000_000, payload: 1 }
  });

  assert.match(digest, /DAU \(dau\): 1,000,000,000$/m);
  assert.doesNotMatch(digest, /ORDERS OF MAGNITUDE/);
  assert.match(digest, /0 field\(s\) off by 100x or more, 0 off by an order of magnitude/);
});
