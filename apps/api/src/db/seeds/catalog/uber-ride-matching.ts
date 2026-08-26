import { defineSeedProblem } from "../types.js";

export const uberRideMatching = defineSeedProblem({
  slug: "uber-ride-matching",
  title: "Design Uber's Ride Matching System",
  difficulty: "expert",
  track: "backend",
  tags: ["geo-distributed", "real-time", "consistency", "leader-election"],
  statement: [
    "Design the dispatch core of a ride-hailing service: drivers stream their location continuously, riders request a ride from a pickup point, and the system assigns exactly one nearby driver to each request.",
    "",
    "In scope: driver location ingestion, proximity search, the matching decision, the offer/accept handshake, and trip state through to completion.",
    "",
    "Out of scope: pricing and surge computation (assume a service returns a price), payments, maps and routing (assume an ETA service), and the driver/rider mobile apps beyond their API calls.",
    "",
    "The workload is intensely geographic: a driver in Lisbon is irrelevant to a rider in Berlin, but a single stadium letting out can put thousands of requests inside one square kilometre within minutes. Location updates arrive constantly, so any index of driver positions is stale the moment you read it."
  ].join("\n"),
  constraints: [
    "A rider must receive a match or an explicit no-drivers-available answer within 5 seconds of requesting.",
    "A driver must never be offered to two riders at the same time — this is a correctness requirement, not a preference.",
    "Driver locations arrive every 4 seconds per active driver and must be queryable within a second of arrival.",
    "A driver who accepts an offer must be committed to that trip even if the matching service crashes immediately after the accept.",
    "An offer that is not accepted within 15 seconds must be withdrawn and the driver returned to the available pool.",
    "The system must remain operational in a city even if the region hosting the global control plane is unreachable.",
    "Trip state transitions must be auditable after the fact — disputes are settled from this log."
  ],
  narrative: {
    framingScript:
      "You are designing the dispatch core for a ride-hailing service. Drivers are streaming location to us every few seconds, riders tap a button and expect a car within seconds, and the one thing we absolutely cannot do is promise the same driver to two different people. I would like you to design location ingestion, proximity search, and the matching decision itself. Start wherever you want, but I will keep pulling you toward the matching decision.",
    signatureChallenge:
      "The proximity index is always stale, so a match built on a read of it is a race — two matchers can offer the same driver to different riders. The candidate separates by making assignment a serialised single-writer decision per driver, a conditional write or short lease, and treating the geo index as a candidate generator rather than truth.",
    progressiveReveals: [
      "Assume 5 million active drivers worldwide and 25 million ride requests a day, with a peak that is five times the daily average.",
      "A concert ends and 4,000 riders request within the same square kilometre in two minutes. What does your proximity search do, and what does your matcher do?",
      "A driver complains they were shown a trip that instantly vanished, and the rider says they waited two minutes for nothing. How do you reconstruct what happened?"
    ]
  },
  estimationSpec: {
    intro:
      "Two very different workloads share this system: a firehose of location writes and a much smaller stream of matching decisions. Size them separately.",
    fields: [
      {
        key: "active_drivers",
        label: "Concurrently active drivers",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10_000,
          max: 10_000_000,
          rationale: "Millions of drivers globally, but only a fraction are online at once"
        }
      },
      {
        key: "location_period_seconds",
        label: "Location update period per driver",
        type: "number",
        unitKind: "seconds",
        displayUnit: "s",
        expectedMagnitude: {
          min: 1,
          max: 60,
          rationale: "The constraint says 4 seconds; anything from 1 to 30 is a real product choice"
        }
      },
      {
        key: "requests_per_day",
        label: "Ride requests / day",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 100_000,
          max: 1_000_000_000,
          rationale: "Tens of millions of trips a day at global scale"
        }
      },
      {
        key: "peak_multiplier",
        label: "Peak / average request ratio",
        type: "number",
        unitKind: "ratio",
        expectedMagnitude: {
          min: 1.5,
          max: 30,
          rationale: "Commute and event peaks are sharp but not unbounded"
        }
      },
      {
        key: "candidates_per_search",
        label: "Candidate drivers evaluated per request",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 3,
          max: 300,
          rationale: "You need more than one candidate but scoring hundreds is wasted work"
        }
      },
      {
        key: "location_bytes",
        label: "Bytes per location update",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        expectedMagnitude: {
          min: 20,
          max: 2_000,
          rationale: "Driver id, lat/lon, heading, timestamp — small, but multiplied enormously"
        }
      },
      {
        key: "location_retention_seconds",
        label: "Location history retention",
        type: "number",
        unitKind: "seconds",
        displayUnit: "days",
        displayMultiplier: 86_400,
        expectedMagnitude: {
          min: 86_400,
          max: 31_536_000,
          rationale: "Disputes and audits need history; the live index needs only seconds of it"
        }
      },
      {
        key: "assignment_mechanism",
        label: "What makes a driver assignment mutually exclusive?",
        type: "text",
        hint: "Name the primitive, not the goal"
      }
    ],
    derivedHints: [
      "Location writes per second will dwarf everything else. That asymmetry is the argument for keeping the live position index separate from the durable trip store.",
      "Peak matches per second is small by comparison — often a few thousand. That is what makes a serialised per-driver assignment affordable.",
      "Multiply peak matches by candidates per search to get index read volume. If that number is uncomfortable, the fix is a tighter candidate set, not a bigger index.",
      "Retained location bytes grows fast. Decide out loud whether the audit trail lives in the same store as the live index; it should not."
    ],
    derivedFormulas: [
      {
        id: "location_writes_per_sec",
        label: "Location updates / sec",
        expression: "active_drivers / location_period_seconds",
        unitKind: "count",
        displayUnit: "writes/s"
      },
      {
        id: "peak_matches_per_sec",
        label: "Peak matching decisions / sec",
        expression: "requests_per_day * peak_multiplier / 86400",
        unitKind: "count",
        displayUnit: "matches/s"
      },
      {
        id: "peak_index_reads_per_sec",
        label: "Peak candidate lookups / sec",
        expression: "requests_per_day * peak_multiplier * candidates_per_search / 86400",
        unitKind: "count",
        displayUnit: "reads/s"
      },
      {
        id: "location_ingest_bytes_per_sec",
        label: "Location ingest throughput",
        expression: "active_drivers * location_bytes / location_period_seconds",
        unitKind: "bytes",
        displayUnit: "B/s"
      },
      {
        id: "retained_location_bytes",
        label: "Retained location history",
        expression:
          "active_drivers * location_bytes * location_retention_seconds / location_period_seconds",
        unitKind: "bytes",
        displayUnit: "B"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Seven phases at expert depth. Two deep dives are expected: one on geospatial indexing under constant churn, one on the exclusivity of the assignment. Do not let the second one stay hand-wavy.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope sharply. **Interact with:** **Problem** tab — note that pricing, routing, and payments are out of scope, so the matching decision is the whole job. **Interviewer** tab — ask me about matching objective (nearest? best ETA? driver fairness?), whether pooled rides exist, and how strict the no-double-offer rule is. Ask about the rule; it is the crux."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 420,
        candidateGuide:
          "Separate the two workloads. **Interact with:** **Estimation** tab — fill every field and compare location writes/sec against peak matches/sec. Say both numbers out loud. **Interviewer** tab — tell me what that ratio implies about where driver positions should live versus where trips should live."
      },
      {
        id: "api",
        label: "API and trip state",
        durationSec: 420,
        candidateGuide:
          "Define the handshake. **Interact with:** **Board** — the calls for location update, request ride, offer, accept, decline, and trip completion, plus the trip state machine with its legal transitions. **Interviewer** tab — walk me through the 15-second offer timeout: who owns that timer and what fires when it expires."
      },
      {
        id: "geo_index",
        label: "Geospatial index",
        durationSec: 600,
        candidateGuide:
          "Design proximity search. **Interact with:** **Board** — how you partition space (grid, geohash, H3, quadtree) and how a query for nearby drivers is served. Draw the ingest path for location updates separately from the query path. **Interviewer** tab — tell me what happens to your partitioning when 4,000 drivers are in one cell, and what you do at cell boundaries. Use **Tutor** for a term like geohash if needed."
      },
      {
        id: "matching_core",
        label: "Matching and exclusivity",
        durationSec: 720,
        candidateGuide:
          "The decisive phase. **Interact with:** **Board** — the matcher: candidate generation, scoring, and the step that actually claims the driver. Mark exactly where mutual exclusion is enforced and what store provides it. **Interviewer** tab — expect me to construct a race and ask you to walk through it. A stale-read-then-write design will not survive; name your conditional write, lease, or single-writer partition explicitly."
      },
      {
        id: "failure_deep_dive",
        label: "Failure and isolation",
        durationSec: 600,
        candidateGuide:
          "Go deep on partial failure. **Interact with:** **Board** — what happens when the matcher dies between offer and accept, when a driver's app loses connectivity mid-trip, and when the global control plane is unreachable but a city must keep dispatching. **Interviewer** tab — for each case, tell me what is lost, what is retried, and who resolves the ambiguity."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 420,
        candidateGuide:
          "Close it properly. **Interact with:** **Board** — mark the trade-offs you chose: match latency against match quality, index freshness against read cost, strict exclusivity against throughput. **Interviewer** tab — summarise, then answer unprompted: what breaks first at 10x, and how would you prove to a regulator what happened on a specific disputed trip? Then **Validate**, then **End interview**."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "serialized_driver_assignment",
        text: "Assigning a driver is a serialised single-writer decision per driver — a conditional write or short lease — not a read of the geo index followed by a write.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A named atomic primitive keyed on driver id",
          "The geo index treated as a candidate generator, with the claim happening elsewhere"
        ],
        discoveryHints: [
          "Two matchers each read the same available driver. What happens?",
          "What makes an assignment exclusive to one rider?"
        ],
        progressiveNudges: [
          "Two ride requests arrive simultaneously and your index returns the same nearest driver to both. Trace both.",
          "If both read 'available' and both send an offer, what did you just promise?",
          "Name the primitive that serialises the claim per driver, and say which store provides it."
        ]
      },
      {
        id: "offer_timeout_ownership",
        text: "The 15-second offer timeout has a named owner and a defined effect when it fires.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A server-side timer or lease expiry, not a client-side countdown",
          "Driver returned to the pool and the rider re-matched on expiry"
        ],
        discoveryHints: [
          "Who is counting the 15 seconds?",
          "What happens to the rider while the offer sits unanswered?"
        ],
        progressiveNudges: [
          "An offer goes out and the driver never responds. What ends it?",
          "Is that timer on the driver's phone or on your server? Why does the difference matter?",
          "When it fires, what happens to the driver's claim and to the rider's request?"
        ]
      },
      {
        id: "accept_durability",
        text: "An accepted trip survives the matching service crashing immediately after the accept.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "The accept durably committed before the driver is told it succeeded",
          "Recovery that reconstructs in-flight trips from persisted state"
        ],
        discoveryHints: [
          "The matcher dies one millisecond after the driver accepts. Is the trip real?",
          "Where is the accept written?"
        ],
        progressiveNudges: [
          "Driver taps accept, your matcher acknowledges, then the matcher dies. What does the rider see?",
          "Was the accept durable before that acknowledgement?",
          "How does a replacement matcher learn this trip exists?"
        ]
      },
      {
        id: "hotspot_cell_handling",
        text: "A single geographic cell holding thousands of drivers or requests does not break partitioning or search.",
        dimension: "scalability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Adaptive cell size or subdivision under density",
          "A bounded candidate set rather than scanning the whole cell"
        ],
        discoveryHints: [
          "A concert ends and 4,000 drivers are in one cell. What does your search return?",
          "Are cells fixed size?"
        ],
        progressiveNudges: [
          "Four thousand requests land in one square kilometre in two minutes. What does that do to your index?",
          "Does your query scan the whole cell?",
          "How do you keep cell size appropriate at both stadium density and rural sparsity?"
        ]
      },
      {
        id: "city_level_independence",
        text: "A city keeps dispatching when the global control plane is unreachable.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "Per-region matching that does not require a global coordinator on the request path",
          "A named degradation for what global services provide"
        ],
        discoveryHints: [
          "The region holding your global services is unreachable. Can Lisbon still dispatch?",
          "What is on the matching critical path that lives globally?"
        ],
        progressiveNudges: [
          "Your global control plane is cut off. What still works in an individual city?",
          "Which of your components are global, and are any of them on the match path?",
          "What do you lose while partitioned, and how does state reconcile afterwards?"
        ]
      },
      {
        id: "auditable_trip_log",
        text: "Trip state transitions are recorded immutably so a disputed trip can be reconstructed after the fact.",
        dimension: "security",
        importance: "core",
        satisfiedBy: [
          "An append-only event log per trip",
          "Enough detail to settle a rider or driver dispute"
        ]
      },
      {
        id: "location_ingest_separation",
        text: "The live position index is a separate system from the durable trip store, justified by the write-rate asymmetry.",
        dimension: "scalability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "An in-memory or purpose-built store for current positions",
          "Trips and audit data in a durable store with different guarantees"
        ],
        discoveryHints: [
          "Do driver positions and trip records live in the same database?",
          "What are the write rates for each?"
        ],
        progressiveNudges: [
          "How many location writes per second versus trip writes per second?",
          "Would you put both in the same store?",
          "What guarantees does each actually need — durability, or freshness?"
        ]
      },
      {
        id: "geo_partitioning_scheme",
        text: "A concrete spatial partitioning scheme is chosen and its boundary behaviour addressed.",
        dimension: "scalability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A named scheme: grid, geohash, H3, or quadtree",
          "A stated approach for a rider near a cell edge"
        ],
        discoveryHints: [
          "How is space divided?",
          "What about a rider standing on a cell boundary?"
        ],
        progressiveNudges: [
          "How do you find drivers near a point without scanning everyone?",
          "Name the partitioning scheme.",
          "The nearest driver is just across a cell boundary. Does your query find them?"
        ]
      },
      {
        id: "workload_asymmetry_math",
        text: "Location write rate and matching decision rate are computed separately and the ratio drives the design.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Location updates/sec from drivers divided by update period",
          "Peak matches/sec derived from request volume and peak multiplier"
        ],
        discoveryHints: [
          "How many location updates per second?",
          "How many matching decisions per second?"
        ],
        progressiveNudges: [
          "Compute location writes per second from active drivers and update period.",
          "Now compute peak matches per second.",
          "Those differ by orders of magnitude. What does that let you afford on the match path?"
        ]
      },
      {
        id: "match_latency_budget",
        text: "The 5-second answer budget is broken down across candidate generation, scoring, and the offer round trip.",
        dimension: "latencyPerformance",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Per-stage latency estimates within the budget",
          "A defined behaviour when the budget is about to be exceeded"
        ],
        discoveryHints: [
          "Where does the 5 seconds go?",
          "What do you return if you run out of time?"
        ],
        progressiveNudges: [
          "Break the 5 seconds into stages.",
          "Which stage is least predictable?",
          "If you are about to blow the budget, do you return no-drivers or a worse match?"
        ]
      },
      {
        id: "location_retention_tiering",
        text: "Location history retention is tiered: the live index keeps seconds, the audit trail keeps much longer.",
        dimension: "cost",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "Different retention for the live index and the historical store",
          "Storage sized from ingest rate times retention"
        ],
        discoveryHints: [
          "How long do you keep every driver's position?",
          "Does the live index need history at all?"
        ],
        progressiveNudges: [
          "Size the storage for a year of location updates.",
          "Does the matching path ever read data older than a minute?",
          "So what belongs in the hot index, and what belongs in cold storage?"
        ]
      },
      {
        id: "match_quality_tradeoff",
        text: "The matching objective is stated explicitly and its trade-offs acknowledged.",
        dimension: "operability",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A named objective: nearest, best ETA, or a utilisation-aware score",
          "Recognition that waiting for a better match costs rider latency"
        ],
        discoveryHints: [
          "What makes one driver a better match than another?",
          "Would you ever wait to get a better match?"
        ],
        progressiveNudges: [
          "Are you optimising distance, ETA, or something else?",
          "Would batching requests for two seconds produce better matches overall?",
          "What does that batching cost, and who pays it?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "assignment_exclusivity",
          label: "Assignment exclusivity",
          phaseRefs: ["matching_core"],
          criterionRefs: ["serialized_driver_assignment", "offer_timeout_ownership", "accept_durability"],
          sampleQuestions: [
            "Two matchers read the same nearest driver simultaneously. Trace both requests to completion.",
            "The matcher dies one millisecond after the driver accepts. What does the rider see?"
          ],
          progressiveNudges: [
            "What operation makes a driver yours rather than someone else's?",
            "If that is read-then-write against a stale index, what stops two winners?",
            "Name the primitive and the store, then tell me who owns the 15-second timeout."
          ],
          greenFlags: [
            "Treats the geo index as candidate generation only",
            "Names a conditional write or lease keyed on driver id"
          ],
          redFlags: [
            "Relies on the geo index being accurate at claim time",
            "Puts the offer timeout on the driver's device"
          ]
        },
        {
          id: "spatial_index",
          label: "Geospatial index under churn",
          phaseRefs: ["geo_index", "estimate"],
          criterionRefs: [
            "geo_partitioning_scheme",
            "hotspot_cell_handling",
            "location_ingest_separation",
            "workload_asymmetry_math"
          ],
          sampleQuestions: [
            "A concert ends and 4,000 drivers are inside one cell. What does your proximity query do?",
            "How many location writes per second versus matching decisions per second?"
          ],
          progressiveNudges: [
            "How is space partitioned, and what happens at cell boundaries?",
            "Compute location write rate, then match rate.",
            "Given that gap, should positions and trips live in the same store?"
          ],
          greenFlags: [
            "Separates the live position index from the durable trip store on rate grounds",
            "Adapts cell size or subdivides under density"
          ],
          redFlags: [
            "Fixed-size cells with no hotspot answer",
            "Writes every location update to the primary transactional database"
          ]
        },
        {
          id: "partial_failure",
          label: "Partial failure and isolation",
          phaseRefs: ["failure_deep_dive"],
          criterionRefs: ["city_level_independence", "auditable_trip_log"],
          sampleQuestions: [
            "The region hosting your global control plane is unreachable. Can an individual city still dispatch?",
            "A rider and driver dispute what happened on a trip last month. What can you show?"
          ],
          progressiveNudges: [
            "Which of your components are global?",
            "Are any of them on the matching critical path?",
            "And what is persisted per trip such that a dispute has a definitive answer?"
          ],
          greenFlags: [
            "Keeps the match path free of global dependencies",
            "Append-only per-trip event log"
          ],
          redFlags: [
            "A global coordinator required to assign any driver",
            "Trip state stored as a mutable current-status row only"
          ]
        },
        {
          id: "budget_and_objective",
          label: "Latency budget and match quality",
          phaseRefs: ["api", "wrap_up"],
          criterionRefs: ["match_latency_budget", "match_quality_tradeoff", "location_retention_tiering"],
          sampleQuestions: [
            "Break the 5-second budget into stages. What do you return if you are about to exceed it?",
            "Are you optimising distance, ETA, or fleet utilisation?"
          ],
          progressiveNudges: [
            "Where does the 5 seconds actually go?",
            "Would batching requests briefly produce better matches?",
            "What does that batching cost the rider, and is the trade worth it?"
          ],
          greenFlags: [
            "Has a defined answer for running out of budget",
            "States the matching objective rather than assuming nearest"
          ],
          redFlags: [
            "No latency breakdown",
            "Keeps every location update hot forever"
          ]
        }
      ],
      scoreRubric: {
        "1": "Draws drivers writing locations to a database and a matcher querying nearest, with no awareness that the index is stale or that assignment can race.",
        "2": "Uses a spatial index and a matching service, but the claim is read-then-write, the offer timeout is undefined, and hotspots are not addressed.",
        "3": "Separates the live index from durable state on rate grounds, serialises the per-driver claim with a named primitive, and handles offer timeout and accept durability.",
        "4": "Also handles hotspot density, keeps cities dispatching under control-plane partition, breaks down the latency budget, and states the matching objective and its trade-offs."
      }
    }
  }
});
