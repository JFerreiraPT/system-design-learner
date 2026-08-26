import assert from "node:assert/strict";
import test from "node:test";
import { advanceEvents, postPhaseEvent, type PhaseEventBody } from "./phaseEvents.js";

const body: PhaseEventBody = {
  phaseId: "clarify",
  phaseIndex: 0,
  kind: "enter",
  elapsedSec: 0
};

test("postPhaseEvent reports success when the POST resolves", async () => {
  const seen: PhaseEventBody[] = [];
  const ok = await postPhaseEvent(async (b) => {
    seen.push(b);
  }, body);
  assert.equal(ok, true);
  assert.deepEqual(seen, [body]);
});

test("a rejected phase-event POST is swallowed, never surfaced", async () => {
  const ok = await postPhaseEvent(async () => {
    throw new Error("Request failed with status code 500");
  }, body);
  assert.equal(ok, false);
});

test("a synchronously throwing poster is swallowed too", async () => {
  const ok = await postPhaseEvent(() => {
    throw new Error("network down");
  }, body);
  assert.equal(ok, false);
});

test("advancing a phase exits the old one before entering the new one at zero", () => {
  const events = advanceEvents({
    fromPhaseId: "clarify",
    fromPhaseIndex: 0,
    fromElapsedSec: 431,
    toPhaseId: "estimate",
    toPhaseIndex: 1
  });

  assert.deepEqual(events, [
    { phaseId: "clarify", phaseIndex: 0, kind: "exit", elapsedSec: 431 },
    { phaseId: "estimate", phaseIndex: 1, kind: "enter", elapsedSec: 0 }
  ]);
});
