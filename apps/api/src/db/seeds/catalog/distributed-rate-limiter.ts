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
  },
  rubric: {
    criteria: [
      {
        id: "shared_counter_state",
        text: "Counters are shared across the fleet, because per-instance counters multiply the effective limit by the instance count.",
        dimension: "scalability",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A single shared store holding per-key counters",
          "The overshoot factor stated as a number to justify it"
        ],
        discoveryHints: [
          "Where does the count for a key actually live?",
          "What limit does a customer really get if each instance counts locally?"
        ],
        progressiveNudges: [
          "Each service instance keeps its own counter. What limit does a customer actually experience?",
          "Multiply your limit by the number of instances. Is that what you sold them?",
          "So the counter has to be shared. What store holds it, and what does that cost on the hot path?"
        ]
      },
      {
        id: "unavailable_behaviour",
        text: "The behaviour when the counter store is unreachable is chosen deliberately and defended as fail-open or fail-closed.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "An explicit choice with a reason tied to what the limiter protects",
          "A fallback such as a local budget during the outage"
        ],
        discoveryHints: [
          "The counter store is unreachable for thirty seconds. What does each request do?",
          "Who made that decision, and is it configurable?"
        ],
        progressiveNudges: [
          "Your shared counter store goes away. What happens to in-flight requests?",
          "Allowing everything risks overload; denying everything is an outage you caused. Pick one.",
          "Justify it: what is this limiter protecting, and which failure is worse for that thing?"
        ]
      },
      {
        id: "hot_key_isolation",
        text: "A single hot key does not degrade decisions for other keys.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "Key-space partitioning so one key's traffic lands on bounded capacity",
          "Local aggregation or batching for very hot keys"
        ],
        discoveryHints: [
          "One key takes a large share of all traffic. Who else is affected?",
          "Where does that key's counter live?"
        ],
        progressiveNudges: [
          "One customer sends half your total traffic. What happens to the shard holding their key?",
          "Do other customers on that shard get slower?",
          "How would you handle it — partition differently, or aggregate locally before touching the store?"
        ]
      },
      {
        id: "fleet_wide_enforcement",
        text: "The limit is enforced per key across the whole fleet rather than per service or per instance.",
        dimension: "requirements",
        importance: "core",
        satisfiedBy: [
          "A key-scoped policy applied identically wherever the request lands",
          "No dependence on which instance received the request"
        ]
      },
      {
        id: "atomic_single_operation",
        text: "The per-request state update is a single atomic operation, not a read followed by a write.",
        dimension: "consistency",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "An atomic increment, script, or compare-and-set in one round trip",
          "Recognition that read-modify-write races between instances"
        ],
        discoveryHints: [
          "How many round trips does one decision take?",
          "What happens if two instances read the same count simultaneously?"
        ],
        progressiveNudges: [
          "Walk through the store operations for one allow/deny decision.",
          "If it is read then write, what do two concurrent instances both see?",
          "Make it one atomic operation. What primitive does your store give you?"
        ]
      },
      {
        id: "overshoot_math",
        text: "The overshoot factor of local counting and the counter operation rate are both computed.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Total instances stated as services times instances",
          "Counter operations per second equal to the guarded request rate"
        ],
        discoveryHints: [
          "How many instances are enforcing limits?",
          "How many counter operations per second is that?"
        ],
        progressiveNudges: [
          "How many instances total across the fleet?",
          "That is your overshoot multiplier if counters are local. Say the number.",
          "Now how many counter operations per second must the store absorb?"
        ]
      },
      {
        id: "policy_distribution",
        text: "Policies are updatable at runtime and reach every instance within the stated window without a deploy.",
        dimension: "operability",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "A config store with push or short-interval polling",
          "A stated propagation time consistent with the 30-second requirement"
        ],
        discoveryHints: [
          "How does a limit change reach a thousand instances?",
          "How long does that take?"
        ],
        progressiveNudges: [
          "Someone raises a customer's limit. How does your fleet find out?",
          "Is that a deploy, a poll, or a push?",
          "What is the worst-case propagation delay, and does it meet the 30-second requirement?"
        ]
      },
      {
        id: "denial_explainability",
        text: "A specific denial can be explained after the fact to a customer who believes they were under quota.",
        dimension: "operability",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Response headers or logs carrying the limit, remaining, and reset",
          "Enough recorded context to reconstruct one decision"
        ],
        discoveryHints: [
          "A customer says they were limited unfairly. How do you check?",
          "What does a denied response tell the caller?"
        ],
        progressiveNudges: [
          "A customer insists they were well under quota when denied. What do you look at?",
          "Does the denial response itself carry anything useful?",
          "What would you record or return so this is a one-minute answer rather than an investigation?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "why_shared",
          label: "Why counters must be shared",
          phaseRefs: ["estimate", "algorithm"],
          criterionRefs: ["shared_counter_state", "overshoot_math", "fleet_wide_enforcement"],
          sampleQuestions: [
            "If each instance keeps its own counter, what limit does a customer actually get?",
            "How many instances are enforcing limits across the fleet?"
          ],
          progressiveNudges: [
            "Where does the count for one key live?",
            "Multiply the limit by the instance count. Is that the product you sold?",
            "So it has to be shared — what store, and what does it cost per request?"
          ],
          greenFlags: [
            "States the overshoot multiplier as a concrete number",
            "Notices total counter state is small enough for memory"
          ],
          redFlags: [
            "Keeps counters in process memory",
            "Treats per-service limits as equivalent to per-key limits"
          ]
        },
        {
          id: "algorithm_choice",
          label: "Algorithm and atomicity",
          phaseRefs: ["algorithm"],
          criterionRefs: ["atomic_single_operation"],
          sampleQuestions: [
            "Walk me through the exact store operations for one allow/deny decision.",
            "What does your algorithm do at a window boundary?"
          ],
          progressiveNudges: [
            "How many round trips per decision?",
            "If it is read then write, what do two concurrent instances see?",
            "Which primitive makes it one atomic operation, and what does that rule out?"
          ],
          greenFlags: [
            "One atomic operation per decision",
            "Names a specific algorithm and its boundary behaviour"
          ],
          redFlags: [
            "Read, compare, then write as separate calls",
            "Fixed window with no acknowledgement of the boundary burst"
          ]
        },
        {
          id: "failure_and_skew",
          label: "Failure behaviour and hot keys",
          phaseRefs: ["topology_and_failure"],
          criterionRefs: ["unavailable_behaviour", "hot_key_isolation"],
          sampleQuestions: [
            "The counter store is unreachable for thirty seconds. What does each in-flight request do?",
            "One key takes half of all traffic. Who else notices?"
          ],
          progressiveNudges: [
            "Allow everything, deny everything, or something else?",
            "What is this limiter protecting, and which failure hurts that more?",
            "Now the hot key — what lands on one shard, and how do you bound it?"
          ],
          greenFlags: [
            "Chooses fail-open or fail-closed with a reason grounded in what is protected",
            "Proposes local aggregation for very hot keys"
          ],
          redFlags: [
            "No answer for store unavailability",
            "Assumes uniform key distribution"
          ]
        },
        {
          id: "operability",
          label: "Policy updates and explainability",
          phaseRefs: ["topology_and_failure", "wrap_up"],
          criterionRefs: ["policy_distribution", "denial_explainability"],
          sampleQuestions: [
            "Someone raises a customer's limit. How does the whole fleet find out, and how fast?",
            "A customer says they were denied while under quota. How do you check?"
          ],
          progressiveNudges: [
            "Is a limit change a deploy?",
            "Push or poll, and what is the worst-case delay?",
            "And what does a denied response carry back to the caller?"
          ],
          greenFlags: [
            "Runtime config with a propagation time that meets the requirement",
            "Returns limit, remaining, and reset on denial"
          ],
          redFlags: [
            "Limits baked into config files requiring a deploy",
            "Denials are opaque with nothing logged"
          ]
        }
      ],
      scoreRubric: {
        "1": "Describes counting requests in memory per instance without noticing that this multiplies the limit, and has no answer for store failure.",
        "2": "Uses a shared store and a named algorithm, but the update is read-then-write and unavailability behaviour is undefined.",
        "3": "Shares counters, quantifies the overshoot that justifies it, uses one atomic operation per decision, and picks fail-open or fail-closed with a reason.",
        "4": "Also isolates hot keys, distributes policy at runtime within the stated window, and makes an individual denial explainable to a customer."
      }
    }
  }
});
