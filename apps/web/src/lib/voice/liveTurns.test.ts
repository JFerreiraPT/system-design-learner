import assert from "node:assert/strict";
import test from "node:test";
import { applyLiveDelta, applyLiveSet, type ProvisionalTurn } from "./liveTurns.js";

// The regression this file exists for.
test("deltas arriving inside one frame all survive", () => {
  // Every call reads the PREVIOUS list, exactly as a functional setState does.
  // An implementation that appended onto a ref-held snapshot would end up with
  // only "id." here, and the candidate would watch their sentence be overwritten.
  const words = ["I ", "would ", "shard ", "by ", "tenant ", "id."];
  const turns = words.reduce<ProvisionalTurn[]>(
    (acc, word) => applyLiveDelta(acc, "u1", "user", word),
    []
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0].content, "I would shard by tenant id.");
  assert.equal(turns[0].provisional, true);
});

test("the first delta creates the turn", () => {
  const turns = applyLiveDelta([], "a1", "assistant", "So ");
  assert.deepEqual(turns, [
    { externalId: "a1", role: "assistant", content: "So ", provisional: true }
  ]);
});

test("an empty delta is a no-op and preserves identity", () => {
  const before = applyLiveDelta([], "u1", "user", "hello");
  assert.equal(applyLiveDelta(before, "u1", "user", ""), before);
});

test("two speakers interleave without corrupting each other", () => {
  let turns: ProvisionalTurn[] = [];
  turns = applyLiveDelta(turns, "u1", "user", "So the queue");
  turns = applyLiveDelta(turns, "a1", "assistant", "Why a queue");
  turns = applyLiveDelta(turns, "u1", "user", " is idempotent");
  turns = applyLiveDelta(turns, "a1", "assistant", " and not a stream?");

  assert.deepEqual(
    turns.map((t) => [t.role, t.content]),
    [
      ["user", "So the queue is idempotent"],
      ["assistant", "Why a queue and not a stream?"]
    ]
  );
});

test("the authoritative transcript replaces accumulated deltas", () => {
  let turns = applyLiveDelta([], "u1", "user", "I wud shard by tenent");
  turns = applyLiveSet(turns, {
    externalId: "u1",
    role: "user",
    content: "I would shard by tenant id.",
    provisional: false
  });

  assert.equal(turns.length, 1, "it replaces rather than appending a second bubble");
  assert.equal(turns[0].content, "I would shard by tenant id.");
  assert.equal(turns[0].provisional, false);
});

test("marking a turn interrupted keeps only what was spoken", () => {
  let turns = applyLiveDelta([], "a1", "assistant", "walk me through the poison message path");
  turns = applyLiveSet(turns, {
    externalId: "a1",
    role: "assistant",
    content: "walk me through the",
    provisional: false,
    interrupted: true
  });

  assert.equal(turns[0].content, "walk me through the");
  assert.equal(turns[0].interrupted, true);
  assert.ok(!turns[0].content.includes("poison"));
});

test("order of first appearance is preserved", () => {
  let turns: ProvisionalTurn[] = [];
  for (const id of ["u1", "a1", "u2", "a2"]) {
    turns = applyLiveDelta(turns, id, id.startsWith("u") ? "user" : "assistant", id);
  }
  // A later update to an early turn must not move it to the end.
  turns = applyLiveDelta(turns, "u1", "user", "!");
  assert.deepEqual(turns.map((t) => t.externalId), ["u1", "a1", "u2", "a2"]);
});

test("every operation returns a new array rather than mutating", () => {
  const original: ProvisionalTurn[] = [
    { externalId: "u1", role: "user", content: "a", provisional: true }
  ];
  const appended = applyLiveDelta(original, "u1", "user", "b");
  assert.equal(original[0].content, "a", "the input list must not be mutated");
  assert.equal(appended[0].content, "ab");
  assert.notEqual(appended, original);
});
