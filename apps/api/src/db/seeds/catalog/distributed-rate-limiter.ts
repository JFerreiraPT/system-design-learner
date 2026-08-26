import { defineSeedProblem } from "../types.js";

export const distributedRateLimiter = defineSeedProblem({
  slug: "distributed-rate-limiter",
  title: "Design a Distributed Rate Limiter",
  difficulty: "medium",
  track: "backend",
  tags: ["rate-limiting", "consistency", "caching"],
  statement: [
    "Design a rate limiter shared by every service in a company's fleet. Given a key — an API token, a user id, an IP — and a policy such as 1,000 requests per minute, it answers allow or deny.",
    "",
    "In scope: the limiting algorithm, where counters live, how policies are configured and distributed, the client integration, and behaviour when the counter store is unavailable.",
    "",
    "Out of scope: authentication (assume the key is already extracted and trusted), billing for overage, and per-endpoint authorization.",
    "",
    "The limiter sits on the hot path of every request in the company, so its own latency and availability become everyone's latency and availability. Many service instances serve the same key concurrently."
  ].join("\n"),
  constraints: [
    "The allow/deny decision must add no more than 5ms at p99 to the request it guards.",
    "Limits are enforced per key across the whole fleet, not per service instance.",
    "A key at exactly its limit may be allowed slightly over — 5% overshoot is acceptable — but 10x over is not.",
    "Policies must be updatable at runtime and take effect fleet-wide within 30 seconds, with no deploy.",
    "The counter store may become unavailable, and you must choose and defend a behaviour for that case.",
    "A single hot key receiving a large share of all traffic must not degrade decisions for other keys."
  ],
  narrative: {
    framingScript:
      "Every service we run needs to rate limit, and right now each one does it its own way in local memory. That means a customer with a thousand-per-minute limit actually gets a thousand per minute per instance, which is not what we sold them. I would like you to design a limiter the whole fleet shares. Start wherever you want, but I care about what happens on the hot path and what happens when the thing you depend on goes away.",
    signatureChallenge:
      "Counters must be shared, because a per-instance limit multiplies the real limit by the instance count — a concrete, quantifiable bug. The candidate separates by choosing an algorithm whose state can be updated atomically by many instances at once, and by naming what a request does when the shared counter store cannot be reached: allow, deny, or fall back to a local budget.",
    progressiveReveals: [
      "Say this now fronts about 100 services with a few thousand instances between them, handling millions of requests a minute.",
      "Your counter store becomes unreachable for thirty seconds. What does each in-flight request do, and who made that decision?",
      "A customer insists they are being limited when they are well under their quota. How do you find out why that request was denied?"
    ]
  },
  estimationSpec: {
    intro:
      "Two numbers matter: how many counter operations per second the store must absorb, and how far a naive per-instance limiter would overshoot.",
    fields: [
      {
        key: "services",
        label: "Services using the limiter",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 5,
          max: 1_000,
          rationale: "A microservice fleet is tens to hundreds of services"
        }
      },
      {
        key: "instances_per_service",
        label: "Instances per service",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 2,
          max: 1_000,
          rationale: "A handful for small services, hundreds for the busiest"
        }
      },
      {
        key: "requests_per_sec",
        label: "Fleet-wide guarded requests / sec",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 1_000,
          max: 10_000_000,
          rationale: "Millions of calls a minute is hundreds of thousands per second"
        }
      },
      {
        key: "unique_keys",
        label: "Distinct active keys",
        type: "number",
        unitKind: "count",
        hint: "Tokens, users, or IPs seen within one window",
        expectedMagnitude: {
          min: 1_000,
          max: 1_000_000_000,
          rationale: "One per customer token, or one per end user if you limit by user"
        }
      },
      {
        key: "window_seconds",
        label: "Limit window",
        type: "number",
        unitKind: "seconds",
        displayUnit: "s",
        expectedMagnitude: {
          min: 1,
          max: 3_600,
          rationale: "Per-second and per-minute windows are the common cases"
        }
      },
      {
        key: "counter_bytes",
        label: "Bytes of state per key",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        expectedMagnitude: {
          min: 20,
          max: 2_000,
          rationale: "A count and a timestamp, unless your algorithm keeps a log of hits"
        }
      },
      {
        key: "store_rtt_seconds",
        label: "Round trip to the counter store",
        type: "number",
        unitKind: "seconds",
        displayUnit: "ms",
        displayMultiplier: 0.001,
        expectedMagnitude: {
          min: 0.0001,
          max: 0.05,
          rationale: "A same-region in-memory store is sub-millisecond; cross-region is not"
        }
      },
      {
        key: "unavailable_behaviour",
        label: "Fail open or fail closed, and why?",
        type: "text"
      }
    ],
    derivedHints: [
      "Counter operations per second equals your guarded request rate — every request touches state. If that number is large, the algorithm has to be a single atomic operation, not a read-modify-write round trip.",
      "The overshoot factor is what makes this problem real: it is exactly how many times over their limit a customer gets if you keep counters locally. Say the number.",
      "Compare your store round trip against the 5ms p99 budget. If the RTT is a meaningful fraction of the budget, you cannot afford two round trips per decision.",
      "Total counter state is usually small enough to fit in memory. Notice that — it is why an in-memory store is the standard answer here."
    ],
    derivedFormulas: [
      {
        id: "total_instances",
        label: "Total instances enforcing limits",
        expression: "services * instances_per_service",
        unitKind: "count",
        displayUnit: "instances"
      },
      {
        id: "local_overshoot_factor",
        label: "Overshoot if counters were per-instance",
        expression: "services * instances_per_service",
        unitKind: "ratio",
        displayUnit: "x limit"
      },
      {
        id: "counter_ops_per_sec",
        label: "Counter operations / sec",
        expression: "requests_per_sec",
        unitKind: "count",
        displayUnit: "ops/s"
      },
      {
        id: "counter_state_bytes",
        label: "Total counter state",
        expression: "unique_keys * counter_bytes",
        unitKind: "bytes",
        displayUnit: "B"
      },
      {
        id: "latency_budget_fraction",
        label: "Store RTT as a fraction of a 5ms budget",
        expression: "store_rtt_seconds / 0.005",
        unitKind: "ratio",
        displayUnit: "of budget"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Five phases. The algorithm choice and the unavailability behaviour are the two things I will not let you skip.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope it. **Interact with:** **Problem** tab — note the 5% overshoot allowance; it is permission to be approximate. **Interviewer** tab — ask me whether limits are per key or per key-per-endpoint, whether bursts should be allowed, and whether the limiter is a library in each service or a separate service. That last question shapes everything."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 360,
        candidateGuide:
          "Get to the two key numbers. **Interact with:** **Estimation** tab — fill every field, then read the overshoot factor and counter ops/sec. **Interviewer** tab — say the overshoot number out loud; it is the business case for the whole project. Also tell me whether your total counter state fits in memory."
      },
      {
        id: "algorithm",
        label: "Algorithm and counters",
        durationSec: 540,
        candidateGuide:
          "Pick and defend an algorithm. **Interact with:** **Board** — sketch the counter state and the exact operation performed per request. Fixed window, sliding log, sliding window counter, token bucket — pick one and show its state. **Interviewer** tab — tell me how the update stays correct when hundreds of instances hit the same key simultaneously, and what your algorithm does at a window boundary. Use **Tutor** to check an algorithm's behaviour, then commit to one."
      },
      {
        id: "topology_and_failure",
        label: "Topology and failure",
        durationSec: 540,
        candidateGuide:
          "Lay out the system and break it. **Interact with:** **Board** — service instances, the client library or sidecar, the counter store, and the path policies travel to reach instances within 30 seconds. Then mark what happens when the store is unreachable and how a hot key is kept from hurting others. **Interviewer** tab — state fail-open or fail-closed as a decision with a reason, not a preference."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 360,
        candidateGuide:
          "Close the loop. **Interact with:** **Board** — mark the accuracy-versus-cost trade-off your algorithm makes and where the 5% allowance is being spent. **Interviewer** tab — summarise, then answer unprompted: what breaks first at 10x request volume, and what would you expose so a customer support engineer could explain a specific denial? Then **Validate**, then **End interview**."
      }
    ]
  }
});
