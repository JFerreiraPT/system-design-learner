import assert from "node:assert/strict";
import test from "node:test";
import { VOICE_CONTEXT_ITEM_PREFIX } from "@sdl/shared";
import type { SceneSummary } from "@sdl/shared";
import { CONTEXT_MIN_INTERVAL_MS, ContextFeed, diffContext } from "./contextFeed.js";

function scene(nodes: Array<[string, string]>, edges: Array<[string, string]> = []): SceneSummary {
  return {
    nodes: nodes.map(([id, label]) => ({ id, label })),
    edges: edges.map(([from, to]) => ({ from, to }))
  };
}

const base = { constraints: [] as string[] };

// --- the diff ------------------------------------------------------------

test("an added node is named, not the whole board re-listed", () => {
  const delta = diffContext(
    { ...base, scene: scene([["a", "API"]]) },
    { ...base, scene: scene([["a", "API"], ["b", "Kafka topic orders"]]) }
  );
  assert.ok(delta);
  assert.match(delta.text, /drew Kafka topic orders/);
  assert.ok(!delta.text.includes("API"), "an unchanged node is not part of the delta");
  assert.ok(delta.text.startsWith(VOICE_CONTEXT_ITEM_PREFIX));
  assert.equal(delta.urgent, false, "drawing is not urgent");
});

test("an unchanged board produces nothing at all", () => {
  const s = scene([["a", "API"], ["b", "DB"]], [["a", "b"]]);
  assert.equal(diffContext({ ...base, scene: s }, { ...base, scene: s }), null);
  assert.equal(diffContext(base, base), null);
});

test("removals and new connections are reported by name", () => {
  const delta = diffContext(
    { ...base, scene: scene([["a", "API"], ["b", "Cache"]]) },
    { ...base, scene: scene([["a", "API"], ["c", "Worker pool"]], [["a", "c"]]) }
  );
  assert.ok(delta);
  assert.match(delta.text, /drew Worker pool/);
  assert.match(delta.text, /removed Cache/);
  assert.match(delta.text, /connected API to Worker pool/);
});

test("scope and phase changes are urgent; drawing is not", () => {
  const scoped = diffContext(base, { constraints: ["99.9% availability"] });
  assert.equal(scoped?.urgent, true);

  const phased = diffContext({ ...base, phaseLabel: "Requirements" }, { ...base, phaseLabel: "Deep dive" });
  assert.equal(phased?.urgent, true);
  assert.match(phased.text, /now in the Deep dive phase/);

  const removed = diffContext({ constraints: ["offline mode"] }, { constraints: [] });
  assert.equal(removed?.urgent, true);
  assert.match(removed.text, /no longer includes offline mode/);
});

test("the delta tells the interviewer not to read it out", () => {
  const delta = diffContext(base, { constraints: ["x"] });
  assert.match(delta!.text, /Do not read this out/);
});

test("long lists are clipped rather than recited endlessly", () => {
  const many = Array.from({ length: 12 }, (_, i) => [`n${i}`, `Node ${i}`] as [string, string]);
  const delta = diffContext({ ...base, scene: scene([]) }, { ...base, scene: scene(many) });
  assert.match(delta!.text, /and 6 more/);
});

// --- the gating ----------------------------------------------------------

test("nothing is injected while the candidate is mid-sentence", () => {
  const feed = new ContextFeed();
  assert.equal(
    feed.offer({ ...base, scene: scene([["a", "Queue"]]) }, "candidateSpeaking", 100_000),
    null
  );
  assert.ok(feed.hasQueued, "it is queued, not discarded");

  // Flushed at the turn boundary.
  const flushed = feed.offer({ ...base, scene: scene([["a", "Queue"]]) }, "thinking", 100_100);
  assert.match(String(flushed), /drew Queue/);
});

test("fifty rapid mutations produce at most one injection per window", () => {
  const feed = new ContextFeed();
  const sent: string[] = [];
  let now = 0;

  for (let i = 0; i < 50; i++) {
    now += 100; // 5 seconds of continuous drawing
    const nodes = Array.from({ length: i + 1 }, (_, k) => [`n${k}`, `Node ${k}`] as [string, string]);
    const out = feed.offer({ ...base, scene: scene(nodes) }, "listening", now);
    if (out) sent.push(out);
  }

  assert.equal(sent.length, 1, "one injection for the whole burst");
  // And it is not lossy: everything drawn during the burst is described.
  assert.match(sent[0], /Node 0/);

  // A second window opens only after the interval.
  const later = feed.offer(
    { ...base, scene: scene([["n0", "Node 0"], ["x", "Cache"]]) },
    "listening",
    now + CONTEXT_MIN_INTERVAL_MS + 1
  );
  assert.match(String(later), /drew Cache/);
});

test("queued drawing deltas merge instead of overwriting each other", () => {
  const feed = new ContextFeed();
  feed.offer({ ...base, scene: scene([["a", "API"]]) }, "candidateSpeaking", 0);
  feed.offer({ ...base, scene: scene([["a", "API"], ["b", "Queue"]]) }, "candidateSpeaking", 500);

  const flushed = String(feed.offer({ ...base, scene: scene([["a", "API"], ["b", "Queue"]]) }, "listening", 1_000));
  assert.match(flushed, /API/);
  assert.match(flushed, /Queue/);
});

test("scope and phase bypass the rate limit", () => {
  const feed = new ContextFeed();
  assert.ok(feed.offer({ ...base, scene: scene([["a", "API"]]) }, "listening", 0));

  // Well inside the window, but a constraint apply is candidate-initiated.
  const scoped = feed.offer(
    { constraints: ["99.9% availability"], scene: scene([["a", "API"]]) },
    "listening",
    1_000
  );
  assert.match(String(scoped), /99.9% availability/);
});

test("the same state is never described twice", () => {
  const feed = new ContextFeed();
  const s = scene([["a", "API"]]);
  assert.ok(feed.offer({ ...base, scene: s }, "listening", 0));
  assert.equal(feed.offer({ ...base, scene: s }, "listening", 100_000), null);
  assert.equal(feed.offer({ ...base, scene: s }, "listening", 200_000), null);
});

test("seeding the baseline stops the mint's own context being re-sent as news", () => {
  const feed = new ContextFeed();
  const opening = { constraints: ["Up to 500 tenants"], scene: scene([["a", "API"]]) };
  // The instructions already described this at mint time.
  feed.seed(opening);
  assert.equal(feed.offer(opening, "listening", 50_000), null);

  const after = feed.offer(
    { ...opening, scene: scene([["a", "API"], ["b", "Queue"]]) },
    "listening",
    60_000
  );
  assert.match(String(after), /drew Queue/);
  assert.ok(!String(after).includes("Up to 500 tenants"));
});
