import assert from "node:assert/strict";
import { test } from "node:test";
import { TAG_VOCABULARY_SNIPPET, getCriteriaHiddenMin, hasEstimationPhase } from "@sdl/ai-prompts";
import {
  DEFAULT_INTERVIEW_PLAN,
  INTERVIEWER_LEVEL_ORDER,
  InterviewRubricSchema,
  getProblemNarrative,
  getTrack,
  hiddenCountAtLevel,
  projectRubricForLevel
} from "@sdl/shared";
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

// --- authored rubrics ------------------------------------------------------

test("every seed ships an authored rubric", () => {
  // Not required by the schema (a seed without one still works), but the point
  // of the catalogue is that starting an interview on it costs no model call.
  for (const seed of SEED_PROBLEMS) {
    assert.ok(seed.rubric, `${seed.slug}: no authored rubric, would fall back to generation`);
  }
});

test("each rubric projects to a legal InterviewRubric at every level", () => {
  for (const seed of SEED_PROBLEMS) {
    if (!seed.rubric) continue;
    for (const level of INTERVIEWER_LEVEL_ORDER) {
      const projected = projectRubricForLevel(seed.rubric, level, "2026-08-26T00:00:00.000Z");
      const parsed = InterviewRubricSchema.safeParse(projected);
      assert.ok(
        parsed.success,
        `${seed.slug} at ${level}: ${parsed.success ? "" : parsed.error.issues[0]?.message}`
      );
    }
  }
});

test("hidden counts rise with level and never fall below the difficulty floor", () => {
  for (const seed of SEED_PROBLEMS) {
    if (!seed.rubric) continue;
    const floor = getCriteriaHiddenMin(seed.difficulty);
    let previous = -1;
    for (const level of INTERVIEWER_LEVEL_ORDER) {
      const hidden = hiddenCountAtLevel(seed.rubric, level);
      assert.ok(hidden >= floor, `${seed.slug} at ${level}: ${hidden} hidden, floor is ${floor}`);
      assert.ok(hidden >= previous, `${seed.slug} at ${level}: hidden count fell as level rose`);
      previous = hidden;
    }
  }
});

test("guided and staff differ, or the projection is pointless", () => {
  for (const seed of SEED_PROBLEMS) {
    if (!seed.rubric) continue;
    assert.ok(
      hiddenCountAtLevel(seed.rubric, "staff") > hiddenCountAtLevel(seed.rubric, "guided"),
      `${seed.slug}: guided and staff hide the same amount — level has no effect`
    );
  }
});

test("every rubric grades the estimation phase it sets aside", () => {
  for (const seed of SEED_PROBLEMS) {
    if (!seed.rubric) continue;
    if (!hasEstimationPhase(seed.interviewPlan.phases)) continue;
    assert.ok(
      seed.rubric.criteria.some((c) => c.dimension === "capacityEstimation"),
      `${seed.slug}: has an estimation phase but nothing grades it`
    );
  }
});

test("playbook references resolve to real criteria and real phases", () => {
  for (const seed of SEED_PROBLEMS) {
    if (!seed.rubric) continue;
    const ids = new Set(seed.rubric.criteria.map((c) => c.id));
    const phases = new Set(seed.interviewPlan.phases.map((p) => p.id));
    for (const area of seed.rubric.playbook.areasToProbe) {
      for (const ref of area.criterionRefs) {
        assert.ok(ids.has(ref), `${seed.slug}/${area.id}: dangling criterionRef "${ref}"`);
      }
      for (const ref of area.phaseRefs) {
        assert.ok(phases.has(ref), `${seed.slug}/${area.id}: dangling phaseRef "${ref}"`);
      }
    }
  }
});

test("hidden criteria carry the coaching material the interviewer needs", () => {
  // An undiscovered hidden criterion with no hints and no nudges gives the
  // interviewer nothing to probe with at exactly the moment it matters.
  for (const seed of SEED_PROBLEMS) {
    if (!seed.rubric) continue;
    for (const criterion of seed.rubric.criteria) {
      if (!criterion.hiddenFrom) continue;
      assert.ok(
        (criterion.discoveryHints ?? []).length > 0,
        `${seed.slug}/${criterion.id}: hidden with no discoveryHints`
      );
      assert.equal(
        criterion.progressiveNudges?.length,
        3,
        `${seed.slug}/${criterion.id}: hidden without three progressive nudges`
      );
    }
  }
});
