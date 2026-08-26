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
  }
});
