import assert from "node:assert/strict";
import { test } from "node:test";
import { TAG_VOCABULARY_SNIPPET } from "@sdl/ai-prompts";
import { DEFAULT_INTERVIEW_PLAN, getProblemNarrative, getTrack } from "@sdl/shared";
import { SEED_PROBLEMS, validateAllSeeds } from "./index.js";
import { SEED_TAG_VOCABULARY } from "./types.js";

test("every seed problem is valid", () => {
  const errors = validateAllSeeds();
  assert.deepEqual(errors, [], `seed validation failed:\n${errors.join("\n")}`);
});

test("the catalogue is non-trivial and uniquely identified", () => {
  assert.ok(SEED_PROBLEMS.length >= 10, "expected a real catalogue, not a sample");
  assert.equal(new Set(SEED_PROBLEMS.map((p) => p.slug)).size, SEED_PROBLEMS.length);
  assert.equal(new Set(SEED_PROBLEMS.map((p) => p.title)).size, SEED_PROBLEMS.length);
});

test("seed tag vocabulary matches the one the generator is held to", () => {
  for (const tag of SEED_TAG_VOCABULARY) {
    assert.ok(
      TAG_VOCABULARY_SNIPPET.includes(tag),
      `"${tag}" is not in TAG_VOCABULARY_SNIPPET — the two lists have drifted`
    );
  }
});

test("narratives survive the tolerant reader every consumer uses", () => {
  // A seed whose narrative fails `getProblemNarrative` would silently lose its
  // framing script and stall ladder at runtime, with no error anywhere.
  for (const seed of SEED_PROBLEMS) {
    const narrative = getProblemNarrative(seed.narrative);
    assert.ok(narrative, `${seed.slug}: narrative did not round-trip`);
    assert.ok(narrative.framingScript, `${seed.slug}: framingScript lost`);
    assert.ok(narrative.signatureChallenge, `${seed.slug}: signatureChallenge lost`);
    assert.equal(narrative.progressiveReveals?.length, 3, `${seed.slug}: reveals lost`);
  }
});

test("tracks round-trip through the tolerant reader", () => {
  for (const seed of SEED_PROBLEMS) {
    assert.equal(getTrack(seed.track), seed.track, `${seed.slug}: track did not round-trip`);
  }
});

test("interview plans are plausible interviews, not templates", () => {
  const defaultIds = DEFAULT_INTERVIEW_PLAN.phases.map((p) => p.id).join(",");

  for (const seed of SEED_PROBLEMS) {
    const phases = seed.interviewPlan.phases;
    const totalMinutes = phases.reduce((sum, p) => sum + p.durationSec, 0) / 60;

    // The whole point of a per-problem plan is that it is not the fallback.
    assert.notEqual(
      phases.map((p) => p.id).join(","),
      defaultIds,
      `${seed.slug}: plan is identical to DEFAULT_INTERVIEW_PLAN`
    );

    assert.ok(
      totalMinutes >= 15 && totalMinutes <= 90,
      `${seed.slug}: total plan length ${Math.round(totalMinutes)}min is outside a realistic interview`
    );
  }
});

test("every problem states a mechanism-bearing signature challenge", () => {
  // Guards against the failure mode the generator prompt calls out: a
  // signature challenge that could be pasted onto any problem.
  const banned = ["must be scalable", "good architecture", "handle lots of users"];
  for (const seed of SEED_PROBLEMS) {
    const text = seed.narrative.signatureChallenge.toLowerCase();
    for (const phrase of banned) {
      assert.ok(!text.includes(phrase), `${seed.slug}: signature challenge is generic ("${phrase}")`);
    }
  }
});
