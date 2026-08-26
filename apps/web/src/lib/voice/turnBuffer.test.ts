import assert from "node:assert/strict";
import test from "node:test";
import { INAUDIBLE_TURN_CONTENT, VOICE_CONTEXT_ITEM_PREFIX } from "@sdl/shared";
import { TRANSCRIPT_STALL_TIMEOUT_MS, TurnBuffer } from "./turnBuffer.js";

test("a normal exchange drains in conversation order", () => {
  const buffer = new TurnBuffer();
  buffer.completeItem("u1", "user", 0, "I would shard by tenant id.");
  buffer.completeItem("a1", "assistant", 100, "Why tenant id rather than time?");

  assert.deepEqual(buffer.drain(200), [
    { externalId: "u1", role: "user", content: "I would shard by tenant id." },
    { externalId: "a1", role: "assistant", content: "Why tenant id rather than time?" }
  ]);
  assert.equal(buffer.pendingCount, 0);
});

// The reason this class exists.
test("a transcript completing AFTER the reply still persists in the right order", () => {
  const buffer = new TurnBuffer();

  // The candidate's item exists first, even though its text is not ready.
  buffer.noteItem("u1", "user", 0);
  // The interviewer answers and finishes before transcription catches up.
  buffer.completeItem("a1", "assistant", 500, "Why tenant id rather than time?");

  // Nothing may be emitted yet: doing so would store the interviewer answering
  // a question the candidate had not asked.
  assert.deepEqual(buffer.drain(600), []);

  buffer.completeItem("u1", "user", 700, "I would shard by tenant id.");
  assert.deepEqual(
    buffer.drain(800).map((t) => [t.role, t.content]),
    [
      ["user", "I would shard by tenant id."],
      ["assistant", "Why tenant id rather than time?"]
    ]
  );
});

test("deltas accumulate and the completed transcript is authoritative", () => {
  const buffer = new TurnBuffer();
  buffer.appendDelta("u1", "I would ", 0, "user");
  buffer.appendDelta("u1", "shard by ", 10, "user");
  buffer.appendDelta("u1", "tenant", 20, "user");
  buffer.completeItem("u1", "user", 30, "I would shard by tenant id.");

  assert.deepEqual(buffer.drain(40), [
    { externalId: "u1", role: "user", content: "I would shard by tenant id." }
  ]);
});

test("deltas alone are enough when no completed event arrives with text", () => {
  const buffer = new TurnBuffer();
  buffer.appendDelta("a1", "So ", 0, "assistant");
  buffer.appendDelta("a1", "why tenant id?", 5, "assistant");
  buffer.completeItem("a1", "assistant", 10);
  assert.deepEqual(buffer.drain(20), [
    { externalId: "a1", role: "assistant", content: "So why tenant id?" }
  ]);
});

test("a failed transcription becomes a gap instead of stranding later turns", () => {
  const buffer = new TurnBuffer();
  buffer.noteItem("u1", "user", 0);
  buffer.completeItem("a1", "assistant", 100, "Go on.");
  buffer.failItem("u1", "user", 200);

  assert.deepEqual(
    buffer.drain(300).map((t) => t.content),
    [INAUDIBLE_TURN_CONTENT, "Go on."]
  );
});

test("a partially transcribed failure keeps what it heard", () => {
  const buffer = new TurnBuffer();
  buffer.appendDelta("u1", "I would shard", 0, "user");
  buffer.failItem("u1", "user", 50);
  assert.deepEqual(buffer.drain(60), [
    { externalId: "u1", role: "user", content: "I would shard" }
  ]);
});

test("a transcript that never completes is released after the stall timeout", () => {
  const buffer = new TurnBuffer();
  buffer.noteItem("u1", "user", 0);
  buffer.completeItem("a1", "assistant", 10, "Go on.");

  // Still waiting, one millisecond short.
  assert.deepEqual(buffer.drain(TRANSCRIPT_STALL_TIMEOUT_MS - 1), []);

  // Past the timeout the whole tail is released rather than lost.
  assert.deepEqual(
    buffer.drain(TRANSCRIPT_STALL_TIMEOUT_MS + 1).map((t) => t.content),
    [INAUDIBLE_TURN_CONTENT, "Go on."]
  );
});

test("two rapid turns arriving interleaved keep their order", () => {
  const buffer = new TurnBuffer();
  buffer.noteItem("u1", "user", 0);
  buffer.noteItem("a1", "assistant", 100);
  buffer.noteItem("u2", "user", 200);
  buffer.noteItem("a2", "assistant", 300);

  // Completion order is scrambled relative to conversation order.
  buffer.completeItem("a2", "assistant", 400, "And hot tenants?");
  buffer.completeItem("u2", "user", 410, "Consistent hashing.");
  buffer.completeItem("a1", "assistant", 420, "Why tenant id?");
  assert.deepEqual(buffer.drain(430), [], "u1 is still open, so nothing may go");

  buffer.completeItem("u1", "user", 440, "Shard by tenant id.");
  assert.deepEqual(
    buffer.drain(450).map((t) => t.content),
    ["Shard by tenant id.", "Why tenant id?", "Consistent hashing.", "And hot tenants?"]
  );
});

test("an interrupted reply persists only what was spoken, and is marked", () => {
  const buffer = new TurnBuffer();
  buffer.appendDelta("a1", "So walk me through how the queue handles a poison message and", 0, "assistant");
  buffer.markInterrupted("a1", "So walk me through how the queue handles");

  const [turn] = buffer.drain(100);
  assert.equal(turn.content, "So walk me through how the queue handles");
  assert.equal(turn.interrupted, true);
  assert.ok(!turn.content.includes("poison message"), "words never heard must not be recorded");
});

test("injected workspace context is never persisted", () => {
  const buffer = new TurnBuffer();
  buffer.completeItem("ctx1", "user", 0, `${VOICE_CONTEXT_ITEM_PREFIX} added: Kafka topic "orders"`);
  buffer.completeItem("u1", "user", 10, "As I was saying.");

  assert.deepEqual(
    buffer.drain(20).map((t) => t.content),
    ["As I was saying."]
  );
});

test("empty turns are dropped rather than stored blank", () => {
  const buffer = new TurnBuffer();
  buffer.completeItem("u1", "user", 0, "   ");
  buffer.completeItem("u2", "user", 10, "Real content.");
  assert.deepEqual(
    buffer.drain(20).map((t) => t.content),
    ["Real content."]
  );
});

test("flushAll releases the tail on teardown", () => {
  const buffer = new TurnBuffer();
  buffer.appendDelta("u1", "half a sentence", 0, "user");
  buffer.noteItem("a1", "assistant", 10);

  const turns = buffer.flushAll(20);
  assert.deepEqual(turns.map((t) => t.content), ["half a sentence", INAUDIBLE_TURN_CONTENT]);
  assert.equal(buffer.pendingCount, 0);
});

test("a drained item is not emitted twice", () => {
  const buffer = new TurnBuffer();
  buffer.completeItem("u1", "user", 0, "Once.");
  assert.equal(buffer.drain(10).length, 1);
  assert.equal(buffer.drain(20).length, 0);
});
