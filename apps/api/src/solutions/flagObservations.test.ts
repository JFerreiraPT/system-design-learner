import assert from "node:assert/strict";
import test from "node:test";
import type { InterviewerPlaybook } from "@sdl/shared";
import { sanitizeFlagObservations } from "./flagObservations.js";

const PLAYBOOK: InterviewerPlaybook = {
  areasToProbe: [
    {
      id: "scope",
      label: "Scope",
      phaseRefs: ["clarify"],
      criterionRefs: ["a"],
      sampleQuestions: ["Who are the users?"],
      progressiveNudges: ["Who uses this?", "How many?", "Name the peak."],
      greenFlags: ["Clarifies scope before designing.", "States assumptions aloud."],
      redFlags: ["Draws components before gathering requirements."]
    },
    {
      id: "failure",
      label: "Failure modes",
      phaseRefs: ["deep_dive"],
      criterionRefs: ["a"],
      sampleQuestions: ["What happens when the cache dies?"],
      progressiveNudges: ["What can fail?", "What is the blast radius?", "Fail open or closed?"],
      greenFlags: ["Names a fail-open vs fail-closed decision."],
      redFlags: ["Assumes the datastore never goes down."]
    }
  ],
  scoreRubric: { "1": "one", "2": "two", "3": "three", "4": "four" }
};

test("resolves valid observations and rewrites text from the playbook", () => {
  const out = sanitizeFlagObservations(
    [
      {
        areaId: "scope",
        kind: "green",
        index: 0,
        text: "TOTALLY DIFFERENT TEXT THE MODEL MADE UP",
        fired: true,
        evidence: "Asked about tenant count before drawing."
      },
      { areaId: "failure", kind: "red", index: 0, fired: false }
    ],
    PLAYBOOK
  );

  assert.equal(out?.length, 2);
  // text always comes from the stored playbook, never the model
  assert.equal(out?.[0]?.text, "Clarifies scope before designing.");
  assert.equal(out?.[0]?.fired, true);
  assert.equal(out?.[0]?.evidence, "Asked about tenant count before drawing.");
  assert.equal(out?.[1]?.text, "Assumes the datastore never goes down.");
  assert.equal(out?.[1]?.fired, false);
});

test("drops observations that do not resolve against the playbook", () => {
  const out = sanitizeFlagObservations(
    [
      { areaId: "does_not_exist", kind: "green", index: 0, fired: true },
      { areaId: "scope", kind: "green", index: 99, fired: true },
      { areaId: "scope", kind: "red", index: 1, fired: true },
      { areaId: "scope", kind: "green", index: 1, fired: true }
    ],
    PLAYBOOK
  );

  assert.equal(out?.length, 1);
  assert.equal(out?.[0]?.text, "States assumptions aloud.");
});

test("drops malformed entries without throwing", () => {
  const out = sanitizeFlagObservations(
    [
      null,
      "not an object",
      {},
      { areaId: "scope", kind: "purple", index: 0, fired: true },
      { areaId: "scope", kind: "green", index: -1, fired: true },
      { areaId: "scope", kind: "green", index: 1.5, fired: true },
      { areaId: 42, kind: "green", index: 0, fired: true },
      { areaId: "scope", kind: "green", index: 0, fired: true }
    ],
    PLAYBOOK
  );

  assert.equal(out?.length, 1);
  assert.equal(out?.[0]?.areaId, "scope");
});

test("collapses duplicate addresses to the first verdict", () => {
  const out = sanitizeFlagObservations(
    [
      { areaId: "scope", kind: "green", index: 0, fired: true, evidence: "first" },
      { areaId: "scope", kind: "green", index: 0, fired: false, evidence: "second" }
    ],
    PLAYBOOK
  );

  assert.equal(out?.length, 1);
  assert.equal(out?.[0]?.fired, true);
  assert.equal(out?.[0]?.evidence, "first");
});

test("evidence is kept only for fired flags and is trimmed", () => {
  const out = sanitizeFlagObservations(
    [
      { areaId: "scope", kind: "green", index: 0, fired: false, evidence: "irrelevant" },
      { areaId: "failure", kind: "green", index: 0, fired: true, evidence: "  spaced  " }
    ],
    PLAYBOOK
  );

  assert.equal(out?.[0]?.evidence, undefined);
  assert.equal(out?.[1]?.evidence, "spaced");
});

test("returns undefined when there is no playbook or nothing survives", () => {
  assert.equal(
    sanitizeFlagObservations([{ areaId: "scope", kind: "green", index: 0, fired: true }], null),
    undefined
  );
  assert.equal(sanitizeFlagObservations([], PLAYBOOK), undefined);
  assert.equal(sanitizeFlagObservations("nonsense", PLAYBOOK), undefined);
  assert.equal(
    sanitizeFlagObservations([{ areaId: "ghost", kind: "red", index: 0, fired: true }], PLAYBOOK),
    undefined
  );
});

test("fired is strictly boolean-true, not truthy", () => {
  const out = sanitizeFlagObservations(
    [{ areaId: "scope", kind: "green", index: 0, fired: "yes" }],
    PLAYBOOK
  );
  assert.equal(out?.[0]?.fired, false);
});
