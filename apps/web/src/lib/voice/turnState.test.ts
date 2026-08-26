import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCommand,
  INITIAL_TURN_MACHINE,
  reduceTurn,
  truncationTarget,
  turnStateLabel,
  type TurnMachine
} from "./turnState.js";

/** Feed a sequence of `[type, atMs, extra?]` triples through the reducer. */
function run(
  events: Array<[string, number] | [string, number, Record<string, unknown>]>,
  start: TurnMachine = applyCommand(INITIAL_TURN_MACHINE, { kind: "connected" })
): TurnMachine {
  return events.reduce(
    (machine, [type, atMs, extra]) =>
      reduceTurn(machine, { event: { type, ...(extra ?? {}) }, atMs }),
    start
  );
}

test("a connected session is listening, not idle", () => {
  assert.equal(applyCommand(INITIAL_TURN_MACHINE, { kind: "connected" }).state, "listening");
  assert.equal(INITIAL_TURN_MACHINE.state, "idle");
});

// This is the test the whole feature rests on.
test("speech that stops and resumes is ONE turn and never shows 'thinking'", () => {
  // "so I'd put a queue here…" [8s drawing] "…and the consumers are idempotent."
  const seen: string[] = [];
  let machine = applyCommand(INITIAL_TURN_MACHINE, { kind: "connected" });
  for (const [type, atMs] of [
    ["input_audio_buffer.speech_started", 0],
    ["input_audio_buffer.speech_stopped", 3_000],
    ["input_audio_buffer.speech_started", 11_000],
    ["input_audio_buffer.speech_stopped", 14_000],
    ["input_audio_buffer.committed", 16_500]
  ] as Array<[string, number]>) {
    machine = reduceTurn(machine, { event: { type }, atMs });
    seen.push(machine.state);
  }

  assert.deepEqual(seen, [
    "candidateSpeaking",
    "candidateSpeaking", // stopped is NOT the end of a turn
    "candidateSpeaking",
    "candidateSpeaking",
    "thinking" // only `committed` — the server's own decision — ends it
  ]);
  assert.ok(!seen.slice(0, 4).includes("thinking"), "never flickered to thinking mid-turn");
});

test("the interviewer speaking is detected on either transport's signal", () => {
  // WebRTC: audio rides the media track, so the transcript delta arrives first.
  assert.equal(
    run([["response.output_audio_transcript.delta", 100, { item_id: "item_a" }]]).state,
    "interviewerSpeaking"
  );
  // WebSocket: raw audio frames on the data channel.
  assert.equal(run([["response.output_audio.delta", 100, { item_id: "item_a" }]]).state, "interviewerSpeaking");
  // WebRTC's own buffer event.
  assert.equal(run([["output_audio_buffer.started", 100, { item_id: "item_a" }]]).state, "interviewerSpeaking");
  // And the pre-rename aliases, so a docs change is not a silent regression.
  assert.equal(run([["response.audio_transcript.delta", 100, { item_id: "item_a" }]]).state, "interviewerSpeaking");
});

test("a full clean turn returns to listening", () => {
  const machine = run([
    ["input_audio_buffer.speech_started", 0],
    ["input_audio_buffer.committed", 4_000],
    ["response.created", 4_100],
    ["response.output_audio_transcript.delta", 4_600, { item_id: "item_x" }],
    ["response.done", 12_000]
  ]);
  assert.equal(machine.state, "listening");
  assert.equal(machine.speakingItemId, null);
});

test("a response created while the candidate talks does not blank the indicator", () => {
  const machine = run([
    ["input_audio_buffer.speech_started", 0],
    ["response.created", 500]
  ]);
  assert.equal(machine.state, "candidateSpeaking");
});

// --- barge-in and truncation ---------------------------------------------

test("interrupting the interviewer yields a truncation target with real elapsed audio", () => {
  const speaking = run([
    ["input_audio_buffer.committed", 0],
    ["response.output_audio_transcript.delta", 1_000, { item_id: "item_reply" }]
  ]);
  assert.equal(speaking.state, "interviewerSpeaking");

  // Candidate cuts in 2.4s into the reply.
  const target = truncationTarget(speaking, 3_400);
  assert.deepEqual(target, { itemId: "item_reply", audioEndMs: 2_400 });

  // Without this the model's context claims it delivered the whole sentence.
  const after = reduceTurn(speaking, {
    event: { type: "input_audio_buffer.speech_started" },
    atMs: 3_400
  });
  assert.equal(after.state, "candidateSpeaking");
  assert.equal(after.playedMs, 2_400);
});

test("there is nothing to truncate when the interviewer is not speaking", () => {
  const listening = applyCommand(INITIAL_TURN_MACHINE, { kind: "connected" });
  assert.equal(truncationTarget(listening, 5_000), null);
  assert.equal(truncationTarget(run([["input_audio_buffer.speech_started", 0]]), 5_000), null);
  // Speaking but with no item id — nothing addressable to truncate.
  const noItem = run([["response.output_audio_transcript.delta", 100]]);
  assert.equal(truncationTarget(noItem, 900), null);
});

test("a mid-reply item id is not overwritten by later deltas", () => {
  const machine = run([
    ["response.output_audio_transcript.delta", 100, { item_id: "item_first" }],
    ["response.output_audio_transcript.delta", 200, { item_id: "item_first" }],
    ["response.output_audio_transcript.delta", 300]
  ]);
  assert.equal(machine.speakingItemId, "item_first");
  assert.equal(machine.speakingSinceMs, 100, "the clock starts at the FIRST spoken word");
});

// --- hold ----------------------------------------------------------------

test("hold silences the mic and swallows stray speech frames", () => {
  const held = applyCommand(run([["input_audio_buffer.committed", 0]]), { kind: "hold" });
  assert.equal(held.state, "held");

  // A frame queued before the track was disabled must not knock us out of hold.
  const stray = reduceTurn(held, { event: { type: "input_audio_buffer.speech_started" }, atMs: 50 });
  assert.equal(stray.state, "held");

  assert.equal(applyCommand(stray, { kind: "release" }).state, "listening");
});

test("holding during the interviewer's turn is a barge-in, not a hold", () => {
  const speaking = run([["response.output_audio_transcript.delta", 0, { item_id: "i" }]]);
  // Left as interviewerSpeaking so the caller still sees a truncation target.
  const held = applyCommand(speaking, { kind: "hold" });
  assert.equal(held.state, "interviewerSpeaking");
  assert.ok(truncationTarget(held, 1_500));
});

test("closing resets everything", () => {
  const machine = applyCommand(run([["response.output_audio_transcript.delta", 0, { item_id: "i" }]]), {
    kind: "closed"
  });
  assert.equal(machine.state, "idle");
  assert.equal(machine.speakingItemId, null);
  assert.equal(machine.speakingSinceMs, null);
});

test("unknown events are ignored, not fatal", () => {
  const machine = run([
    ["some.future.event.nobody.has.shipped.yet", 10],
    ["input_audio_buffer.speech_started", 20]
  ]);
  assert.equal(machine.state, "candidateSpeaking");
});

test("every state has a label that stands alone without colour", () => {
  for (const state of ["idle", "listening", "candidateSpeaking", "thinking", "interviewerSpeaking", "held"] as const) {
    const label = turnStateLabel(state);
    assert.ok(label.length > 0);
    assert.notEqual(label, state, "the raw enum name is not a human label");
  }
});
