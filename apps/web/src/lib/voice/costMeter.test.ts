import assert from "node:assert/strict";
import test from "node:test";
import { estimateVoiceCostUsd } from "@sdl/shared";
import {
  billableSeconds,
  formatDuration,
  formatUsd,
  initialMeter,
  meterCostUsd,
  tickMeter
} from "./costMeter.js";

test("audio time is attributed to the side that was actually talking", () => {
  let m = initialMeter(0, "listening");
  m = tickMeter(m, "candidateSpeaking", 5_000); // 5s of silence while listening
  m = tickMeter(m, "thinking", 35_000); // 30s of candidate speech
  m = tickMeter(m, "interviewerSpeaking", 36_000); // 1s thinking
  m = tickMeter(m, "listening", 48_000); // 12s of interviewer speech

  assert.equal(Math.round(m.heardSeconds), 30);
  assert.equal(Math.round(m.spokenSeconds), 12);
  // Silence and thinking count toward the ceiling but cost nothing.
  assert.equal(Math.round(m.elapsedSeconds), 48);
  assert.equal(Math.round(billableSeconds(m)), 42);
});

test("a held mic bills nothing", () => {
  let m = initialMeter(0, "held");
  m = tickMeter(m, "listening", 60_000);
  assert.equal(m.heardSeconds, 0);
  assert.equal(m.spokenSeconds, 0);
  // Still open, so the ceiling still advances — a held session is not free time.
  assert.equal(Math.round(m.elapsedSeconds), 60);
});

test("an idle session accumulates nothing", () => {
  const m = tickMeter(initialMeter(0, "idle"), "listening", 120_000);
  assert.equal(m.elapsedSeconds, 0);
  assert.equal(billableSeconds(m), 0);
});

test("output audio costs twice what input audio does", () => {
  const heard = estimateVoiceCostUsd({ heardSeconds: 60, spokenSeconds: 0 });
  const spoken = estimateVoiceCostUsd({ heardSeconds: 0, spokenSeconds: 60 });
  assert.ok(spoken > heard);
  // $32/1M in at ~10 tok/s vs $64/1M out at ~20 tok/s => 4x per second.
  assert.equal(Math.round((spoken / heard) * 100) / 100, 4);
});

test("a realistic 45-minute interview lands in the expected order of magnitude", () => {
  // 32 minutes of candidate, 11 of interviewer.
  const usd = estimateVoiceCostUsd({ heardSeconds: 32 * 60, spokenSeconds: 11 * 60 });
  assert.ok(usd > 0.8 && usd < 2.5, `expected roughly $1-2, got ${usd}`);
});

test("negative or absurd inputs cannot produce a negative estimate", () => {
  assert.equal(estimateVoiceCostUsd({ heardSeconds: -100, spokenSeconds: -100 }), 0);
  assert.ok(meterCostUsd(initialMeter(0)) === 0);
});

test("durations format as a person reads a clock", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(9), "0:09");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(600), "10:00");
  assert.equal(formatDuration(3_661), "1:01:01");
  assert.equal(formatDuration(-5), "0:00");
});

test("sub-cent spend still reads as live rather than broken", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(0.42), "$0.42");
  assert.equal(formatUsd(1.5), "$1.50");
});
