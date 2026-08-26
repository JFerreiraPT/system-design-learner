import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NOISE_GATE,
  GATE_LOOKAHEAD_MS,
  INITIAL_GATE_STATE,
  rmsOf,
  stepGate,
  type GateState
} from "./noiseGate.js";

const LOUD = 0.2; // conversational speech
const QUIET = 0.01; // room tone

/** Feed a level for a duration, sampling every 16ms like the rAF loop. */
function hold(state: GateState, rms: number, durationMs: number, startMs: number) {
  let s = state;
  let t = startMs;
  for (; t < startMs + durationMs; t += 16) s = stepGate(s, rms, t, DEFAULT_NOISE_GATE);
  return { state: s, endMs: t };
}

// --- the whole point ------------------------------------------------------

test("a transient does not open the gate — this is the cat and the chair", () => {
  // A thud: loud, but over in 80ms. Louder than speech, and still rejected,
  // because duration is what separates a knock from a word.
  const { state } = hold(INITIAL_GATE_STATE, 0.9, 80, 0);
  assert.equal(state.open, false, "an 80ms transient must never reach the model");
});

test("sustained speech opens the gate, and quickly", () => {
  const { state, endMs } = hold(INITIAL_GATE_STATE, LOUD, 200, 0);
  assert.equal(state.open, true);
  // It must open within the lookahead window, or the delayed audio arrives
  // before the gate does and every sentence loses its first syllable.
  assert.ok(
    DEFAULT_NOISE_GATE.minOpenMs < GATE_LOOKAHEAD_MS,
    "minOpenMs must fit inside the lookahead"
  );
  assert.ok(endMs <= GATE_LOOKAHEAD_MS + 32);
});

test("repeated transients never accumulate into an open gate", () => {
  // A cat walking around: a series of separate short noises. Each one must be
  // judged on its own, not summed.
  let state = INITIAL_GATE_STATE;
  let t = 0;
  for (let i = 0; i < 12; i++) {
    ({ state, endMs: t } = hold(state, 0.8, 64, t));
    ({ state, endMs: t } = hold(state, QUIET, 300, t));
    assert.equal(state.open, false, `burst ${i} opened the gate`);
  }
});

test("the rising timer resets when the level drops back", () => {
  // 100ms up (not yet qualifying), quiet, then 100ms up again. Neither burst
  // qualifies on its own and they must not combine.
  let { state, endMs } = hold(INITIAL_GATE_STATE, LOUD, 100, 0);
  assert.equal(state.open, false);
  ({ state, endMs } = hold(state, QUIET, 50, endMs));
  assert.equal(state.risingSinceMs, null, "the burst was abandoned");
  ({ state } = hold(state, LOUD, 100, endMs));
  assert.equal(state.open, false);
});

// --- and it must not mangle real speech ----------------------------------

test("a word gap does not close the gate", () => {
  let { state, endMs } = hold(INITIAL_GATE_STATE, LOUD, 300, 0);
  assert.equal(state.open, true);

  // "so I'd put ... a queue here" — a 250ms breath, well inside the hold.
  ({ state, endMs } = hold(state, QUIET, 250, endMs));
  assert.equal(state.open, true, "speech must not be chopped at every pause");

  ({ state } = hold(state, LOUD, 100, endMs));
  assert.equal(state.open, true);
  assert.equal(state.fallingSinceMs, null, "resuming speech cancels the close");
});

test("the gate closes once the candidate genuinely stops", () => {
  let { state, endMs } = hold(INITIAL_GATE_STATE, LOUD, 300, 0);
  ({ state } = hold(state, QUIET, DEFAULT_NOISE_GATE.holdMs + 100, endMs));
  assert.equal(state.open, false);
});

test("hysteresis: a level between the two thresholds keeps the gate open", () => {
  const between = (DEFAULT_NOISE_GATE.openRms + DEFAULT_NOISE_GATE.closeRms) / 2;
  let { state, endMs } = hold(INITIAL_GATE_STATE, LOUD, 300, 0);
  ({ state } = hold(state, between, 2_000, endMs));
  assert.equal(state.open, true, "trailing-off speech must not be cut");

  // And that same level could never have opened it from closed.
  assert.equal(hold(INITIAL_GATE_STATE, between, 2_000, 0).state.open, false);
});

test("thresholds are ordered so hysteresis exists at all", () => {
  assert.ok(DEFAULT_NOISE_GATE.closeRms < DEFAULT_NOISE_GATE.openRms);
  assert.ok(DEFAULT_NOISE_GATE.openRms > 0 && DEFAULT_NOISE_GATE.openRms < 1);
});

// --- rms -----------------------------------------------------------------

test("rms reads silence as zero and a full-scale tone as high", () => {
  const silence = new Uint8Array(256).fill(128);
  assert.equal(rmsOf(silence), 0);

  const square = new Uint8Array(256);
  for (let i = 0; i < square.length; i++) square[i] = i % 2 === 0 ? 255 : 1;
  assert.ok(rmsOf(square) > 0.9);

  // Room tone: tiny wobble around centre, must sit below the open threshold.
  const room = new Uint8Array(256);
  for (let i = 0; i < room.length; i++) room[i] = 128 + (i % 3) - 1;
  assert.ok(rmsOf(room) < DEFAULT_NOISE_GATE.openRms);
});
