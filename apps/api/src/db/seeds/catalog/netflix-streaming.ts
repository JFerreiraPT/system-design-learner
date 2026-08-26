import { defineSeedProblem } from "../types.js";

export const netflixStreaming = defineSeedProblem({
  slug: "netflix-streaming",
  title: "Design Netflix's Video Streaming Platform",
  difficulty: "hard",
  track: "backend",
  tags: ["cdn", "storage", "caching", "geo-distributed"],
  statement: [
    "Design the playback path for a global subscription video service: a subscriber opens the app, picks a title, and watches it start-to-finish without buffering.",
    "",
    "In scope: the video delivery path (manifest, segments, edge caching), the encoding pipeline that turns one mezzanine master into a multi-bitrate ladder, playback authorization, and resume-where-I-left-off across devices.",
    "",
    "Out of scope: the recommendation model itself (assume a service returns a ranked row of title ids), billing, and the content-acquisition business.",
    "",
    "Assume subscribers are spread across every continent, that a popular new release drives a large share of all viewing in its first 48 hours, and that a meaningful fraction of subscribers watch on networks that cannot sustain the highest bitrate."
  ].join("\n"),
  constraints: [
    "Playback must start in under 2 seconds at p95 from tapping Play, measured client-side.",
    "Rebuffer ratio must stay under 0.2% of total watch time — this is the single metric the business cares about.",
    "The encoding ladder is fixed at 4 rungs minimum; clients switch rungs mid-stream as bandwidth changes.",
    "You may not assume the origin can serve peak traffic: origin egress capacity is roughly 1% of peak subscriber demand.",
    "A whole CDN region can be lost with no warning, and playback in that region must degrade rather than stop.",
    "Resume position must survive a device switch within 5 seconds, but losing a few seconds of position is acceptable.",
    "Licensing forbids serving a title into a country where it is not licensed, and this check must not be bypassable by the client."
  ],
  narrative: {
    framingScript:
      "We run a subscription streaming service and we are about to launch in a dozen new countries at once. My worry is not the catalogue, it is playback: I have seen the projections and our origin cannot carry that traffic, not even close. I want you to design the path from a subscriber pressing Play to bytes arriving on their screen, and I want it to hold up when a new season drops and everyone shows up in the same hour. Start wherever makes sense to you.",
    signatureChallenge:
      "Origin capacity is ~1% of peak demand, so the design only works if the edge absorbs nearly everything — which turns this into a cache-fill and eviction problem. The strong candidate pre-positions popular titles at the edge before launch instead of relying on lazy fill, and can say what happens to the origin on a cold cache after a region fails over.",
    progressiveReveals: [
      "Let's say a new season lands and 8 million people start episode one within the same hour, most of them in three countries.",
      "One of your CDN regions just went dark — every client that was streaming from it reconnects at once. What do those clients see, and what does your origin see?",
      "A subscriber says playback stalls every few minutes but only in the evening, and only on one title. How do you find out why?"
    ]
  },
  estimationSpec: {
    intro:
      "Size the delivery path. The goal is to show that origin egress is the binding constraint and that the edge hit ratio is what makes the design possible.",
    fields: [
      {
        key: "subscribers",
        label: "Subscribers",
        type: "number",
        unitKind: "count",
        hint: "Total paying subscribers worldwide",
        expectedMagnitude: {
          min: 10_000_000,
          max: 500_000_000,
          rationale: "A global streaming service sits in the hundreds of millions, not billions"
        }
      },
      {
        key: "peak_concurrent_fraction",
        label: "Fraction of subscribers streaming at peak",
        type: "number",
        unitKind: "ratio",
        placeholder: "e.g. 0.1",
        expectedMagnitude: {
          min: 0.01,
          max: 0.3,
          rationale: "Evening peak concentrates viewing but most subscribers are still not watching"
        }
      },
      {
        key: "watch_seconds_per_sub_per_day",
        label: "Watch time / subscriber / day",
        type: "number",
        unitKind: "seconds",
        displayUnit: "hours",
        displayMultiplier: 3600,
        expectedMagnitude: {
          min: 600,
          max: 36_000,
          rationale: "Averages land around an hour or two a day across the whole base"
        }
      },
      {
        key: "avg_stream_bytes_per_sec",
        label: "Average stream bitrate",
        type: "number",
        unitKind: "bytes",
        displayUnit: "MB/s",
        displayMultiplier: 1_048_576,
        hint: "Averaged across the ladder — most sessions are not on the top rung",
        expectedMagnitude: {
          min: 250_000,
          max: 4_000_000,
          rationale: "HD streaming is a few megabits per second, i.e. well under a megabyte per second"
        }
      },
      {
        key: "cdn_cache_hit_ratio",
        label: "Edge cache hit ratio",
        type: "number",
        unitKind: "ratio",
        placeholder: "e.g. 0.95",
        expectedMagnitude: {
          min: 0.05,
          max: 0.999,
          rationale: "Video is the most cacheable payload there is; a working design is far above 0.9"
        }
      },
      {
        key: "catalog_seconds",
        label: "Catalogue runtime",
        type: "number",
        unitKind: "seconds",
        displayUnit: "hours",
        displayMultiplier: 3600,
        expectedMagnitude: {
          min: 36_000,
          max: 36_000_000,
          rationale: "Tens of thousands of hours of licensed content"
        }
      },
      {
        key: "ladder_rungs",
        label: "Encoding ladder rungs (all codecs)",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 4,
          max: 60,
          rationale: "Several resolutions across a few codecs multiplies quickly"
        }
      },
      {
        key: "degradation_choice",
        label: "What degrades first when the edge cannot serve a rung?",
        type: "text",
        hint: "Name the mechanism, not the goal"
      }
    ],
    derivedHints: [
      "Compare peak egress against the stated origin capacity of ~1% of demand. If the two are within an order of magnitude of each other, re-check the hit ratio.",
      "Storage is dominated by the ladder, not by the catalogue: every rung is a full re-encode of the whole title.",
      "Peak concurrency, not total subscribers, sizes the edge fleet. Total subscribers only sizes storage and control-plane load."
    ],
    derivedFormulas: [
      {
        id: "peak_concurrent_streams",
        label: "Peak concurrent streams",
        expression: "subscribers * peak_concurrent_fraction",
        unitKind: "count",
        displayUnit: "streams"
      },
      {
        id: "peak_egress",
        label: "Peak delivery egress",
        expression: "subscribers * peak_concurrent_fraction * avg_stream_bytes_per_sec",
        unitKind: "bytes",
        displayUnit: "B/s"
      },
      {
        id: "peak_origin_egress",
        label: "Peak origin egress (cache misses only)",
        expression:
          "subscribers * peak_concurrent_fraction * avg_stream_bytes_per_sec * (1 - cdn_cache_hit_ratio)",
        unitKind: "bytes",
        displayUnit: "B/s"
      },
      {
        id: "encoded_storage",
        label: "Encoded catalogue storage",
        expression: "catalog_seconds * ladder_rungs * avg_stream_bytes_per_sec",
        unitKind: "bytes",
        displayUnit: "B"
      },
      {
        id: "daily_delivered_bytes",
        label: "Bytes delivered / day",
        expression: "subscribers * watch_seconds_per_sub_per_day * avg_stream_bytes_per_sec",
        unitKind: "bytes",
        displayUnit: "B/day"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Seven phases. The centre of gravity is the delivery path and the cache-fill strategy — get there with numbers in hand, because the origin capacity constraint is what forces every interesting decision.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Pin down scope before designing. **Interact with:** **Problem** tab — re-read the constraints, especially origin capacity and the rebuffer target. **Interviewer** tab — ask me about device mix, live vs on-demand, offline downloads, and whether the recommendation row is yours to build. Do not start drawing until you know whether live streaming is in scope."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 480,
        candidateGuide:
          "Establish that the edge is load-bearing. **Interact with:** **Estimation** tab — fill every field, then read the derived rows. The number that matters is peak origin egress: state out loud how it compares to the ~1% origin capacity in the constraints. **Interviewer** tab — tell me your assumed bitrate and hit ratio and why."
      },
      {
        id: "api",
        label: "Playback contract",
        durationSec: 420,
        candidateGuide:
          "Shape the client-server contract. **Interact with:** **Board** — sketch the calls a client makes between tapping Play and the first segment arriving: authorize, fetch manifest, fetch segments, report progress. **Interviewer** tab — walk me through what the manifest contains and where the licensing check happens. Be explicit about which of these calls hit your origin and which hit the edge."
      },
      {
        id: "delivery_path",
        label: "Delivery path",
        durationSec: 720,
        candidateGuide:
          "Lay out the full delivery topology. **Interact with:** **Board** — clients, edge caches, regional tiers, origin storage, and the control plane that hands out manifests. Draw the read path for a cache hit and, separately, for a miss. **Interviewer** tab — narrate as you go. Use **Tutor** if you need to check a term like ABR or mezzanine, then come back."
      },
      {
        id: "encoding_pipeline",
        label: "Encoding pipeline",
        durationSec: 420,
        candidateGuide:
          "Design the write path. **Interact with:** **Board** — how one uploaded master becomes a full ladder: chunking, parallel transcode workers, per-rung packaging, and publishing. **Interviewer** tab — tell me how long a title takes to become playable and what you do when one rung fails to encode. Keep your storage estimate in view; the ladder is what makes it large."
      },
      {
        id: "failure_deep_dive",
        label: "Failure deep dive",
        durationSec: 600,
        candidateGuide:
          "Go deep on losing a region. **Interact with:** **Board** — mark what happens when an entire CDN region disappears: where clients are steered, what the cold cache does to origin load, and how you avoid a thundering herd. **Interviewer** tab — expect pointed follow-ups here. Name the degradation you accept (lower rung, longer startup) rather than claiming nothing changes."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 420,
        candidateGuide:
          "Close the loop yourself. **Interact with:** **Board** — mark the two or three decisions you would revisit, e.g. pre-positioning versus lazy fill, or per-title versus per-rung caching. **Interviewer** tab — summarise the design in a few sentences, then answer unprompted: what breaks first at 10x, and what would you instrument on day one? Then **Validate** for a score and **End interview** for the written debrief."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "edge_prepositioning",
        text: "Popular titles are placed at the edge before demand arrives, rather than filled lazily on first miss.",
        dimension: "scalability",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A pre-position or pre-warm step in the publish pipeline",
          "Board shows content pushed to edge caches independently of viewer requests"
        ],
        discoveryHints: [
          "How does the first viewer in a region get a fast start?",
          "What is in the edge cache the moment a sale or launch begins?"
        ],
        progressiveNudges: [
          "Walk me through the very first request for a brand new title in a region.",
          "If that request is a miss, what is it a miss against, and what does the origin see?",
          "Given origin capacity is about 1% of peak, can you afford to learn what is popular from misses?"
        ]
      },
      {
        id: "region_failover_degradation",
        text: "Losing a whole CDN region degrades playback to a named lesser experience instead of stopping it.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Clients steered to a neighbouring region or a lower rung",
          "An explicit statement of what the viewer loses (higher startup, lower quality)"
        ],
        discoveryHints: [
          "What happens if an entire edge region disappears?",
          "Is there an experience you are willing to degrade to?"
        ],
        progressiveNudges: [
          "Suppose one of your edge regions goes dark. What do its viewers see?",
          "Where do those clients go next, and is that destination warm?",
          "Name the specific degradation you accept — quality, startup time, or availability. Pick one."
        ]
      },
      {
        id: "origin_shield_stampede",
        text: "A cold cache after failover does not stampede the origin; misses are collapsed or shielded.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A mid-tier or shield layer between edge and origin",
          "Request coalescing so N concurrent misses for one segment become one origin fetch"
        ],
        discoveryHints: [
          "How many origin requests does one popular segment generate on a cold cache?",
          "Is there anything between the edge and the origin?"
        ],
        progressiveNudges: [
          "A million clients fail over to a cold region at the same second. What does your origin receive?",
          "Do those requests reach the origin independently, or does something merge them?",
          "Compare that request count against the 1% origin capacity in the constraints. What has to change?"
        ]
      },
      {
        id: "abr_rung_switching",
        text: "The client selects and switches bitrate rungs mid-stream based on measured throughput.",
        dimension: "latencyPerformance",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "Manifest lists multiple rungs and the client picks per segment",
          "A stated rule for when to step down versus step up"
        ],
        discoveryHints: [
          "What happens when a viewer's bandwidth halves mid-episode?",
          "Who decides which quality is being served?"
        ],
        progressiveNudges: [
          "A viewer's connection degrades halfway through. What does your design do?",
          "Is that decision made on the server or the client, and why does it matter here?",
          "Stepping down is easy — what stops it oscillating between rungs every segment?"
        ]
      },
      {
        id: "licensing_enforcement",
        text: "Territory licensing is enforced server-side at playback authorization, not by the client.",
        dimension: "security",
        importance: "core",
        satisfiedBy: [
          "An authorization call that resolves territory before a manifest is issued",
          "Segment URLs that cannot be replayed outside an authorized session"
        ]
      },
      {
        id: "startup_latency_budget",
        text: "The critical path to first frame is enumerated and fits the 2-second p95 startup budget.",
        dimension: "latencyPerformance",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Auth, manifest, and first-segment fetch named as sequential steps",
          "A statement of which steps can be parallelised or cached"
        ],
        discoveryHints: [
          "What has to happen between tapping Play and the first frame?",
          "Which of those steps are sequential?"
        ],
        progressiveNudges: [
          "List the round trips between Play and pixels.",
          "Which of those are on the critical path, and which can overlap?",
          "Your budget is 2 seconds at p95. Which single step worries you most?"
        ]
      },
      {
        id: "rebuffer_budget_design",
        text: "Segment size and client buffering are chosen against the 0.2% rebuffer target, not left implicit.",
        dimension: "reliability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A stated segment duration with a reason",
          "A client buffer depth that trades startup latency against rebuffer risk"
        ],
        discoveryHints: [
          "How much video does the client hold ahead of the playhead?",
          "What segment length did you pick, and why that one?"
        ],
        progressiveNudges: [
          "How far ahead is the client buffering?",
          "A bigger buffer means fewer rebuffers — what does it cost you?",
          "Tie it to the numbers: 0.2% of watch time is your budget. Does your buffer depth earn that?"
        ]
      },
      {
        id: "egress_capacity_math",
        text: "Peak egress and origin egress are computed and compared against the stated origin capacity.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Peak concurrent streams times average bitrate stated as a number",
          "Origin egress derived from the cache miss ratio and compared to the ~1% limit"
        ],
        discoveryHints: [
          "How much bandwidth does peak actually need?",
          "What share of that reaches the origin?"
        ],
        progressiveNudges: [
          "Give me a rough number for peak delivery bandwidth.",
          "Now what fraction of that misses the edge and hits the origin?",
          "Compare that to origin capacity of about 1% of demand. Does your hit ratio hold up?"
        ]
      },
      {
        id: "ladder_storage_cost",
        text: "The encoding ladder is treated as a storage and cost decision, not produced uniformly for every title.",
        dimension: "cost",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "Storage sized as catalogue times rungs, not catalogue alone",
          "A policy for producing fewer rungs for low-demand titles"
        ],
        discoveryHints: [
          "Does every title need every rung?",
          "What dominates your storage bill?"
        ],
        progressiveNudges: [
          "How much storage does the ladder add over the source masters?",
          "Is a title nobody watches worth eight encodes?",
          "If you skip rungs, what triggers a backfill when that title suddenly gets popular?"
        ]
      },
      {
        id: "multi_cdn_steering",
        text: "Traffic is steered across more than one delivery provider, with a stated basis for the decision.",
        dimension: "operability",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A steering service that assigns clients to a provider",
          "Measured performance or cost named as the input to steering"
        ],
        discoveryHints: [
          "Is there exactly one CDN in this design?",
          "How would you move traffic off a provider having a bad day?"
        ],
        progressiveNudges: [
          "What is your plan if a delivery provider degrades in one country?",
          "How would you notice, and how fast could you shift traffic?",
          "What signal would you steer on — cost, measured throughput, or error rate?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "cache_economics",
          label: "Edge economics and cache fill",
          phaseRefs: ["estimate", "delivery_path"],
          criterionRefs: ["edge_prepositioning", "egress_capacity_math"],
          sampleQuestions: [
            "Given the origin can serve roughly 1% of peak demand, what has to be true of your edge tier?",
            "Walk me through the first ever request for a new title in a new region."
          ],
          progressiveNudges: [
            "How does content get into the edge cache?",
            "Is that pull-on-miss or push-before-launch?",
            "Compute origin egress at your hit ratio and compare it to the 1% ceiling."
          ],
          greenFlags: [
            "Computes origin egress and notices it exceeds capacity at a plausible hit ratio",
            "Proposes pre-positioning tied to a popularity prediction"
          ],
          redFlags: [
            "Says 'the CDN handles it' without naming fill behaviour",
            "Assumes a 99% hit ratio without justifying it"
          ]
        },
        {
          id: "playback_startup",
          label: "Startup latency and adaptive bitrate",
          phaseRefs: ["api", "delivery_path"],
          criterionRefs: ["startup_latency_budget", "abr_rung_switching", "rebuffer_budget_design"],
          sampleQuestions: [
            "Enumerate the round trips between the viewer tapping Play and the first frame rendering.",
            "A viewer's bandwidth halves mid-episode. What does your design do?"
          ],
          progressiveNudges: [
            "What is on the critical path to first frame?",
            "Which of those steps could be cached or parallelised?",
            "Now defend it against the 2-second p95 budget."
          ],
          greenFlags: [
            "Separates control-plane calls from segment fetches",
            "Names a concrete segment duration and buffer depth"
          ],
          redFlags: [
            "Puts authorization on the segment path for every segment",
            "Treats quality selection as a server-side decision with no client input"
          ]
        },
        {
          id: "encoding_cost",
          label: "Encoding ladder and storage cost",
          phaseRefs: ["encoding_pipeline"],
          criterionRefs: ["ladder_storage_cost"],
          sampleQuestions: [
            "How much storage does your ladder add on top of the source masters?",
            "Does a title nobody watches deserve the full ladder?"
          ],
          progressiveNudges: [
            "What multiplies your storage footprint here?",
            "Could you produce fewer rungs for some titles?",
            "If you defer rungs, what triggers the backfill when demand spikes?"
          ],
          greenFlags: [
            "Sizes storage as catalogue times rungs",
            "Proposes demand-driven rung production with a backfill trigger"
          ],
          redFlags: [
            "Sizes storage from the catalogue alone",
            "Treats transcode as free because it is offline"
          ]
        },
        {
          id: "regional_failure",
          label: "Regional failure and origin protection",
          phaseRefs: ["failure_deep_dive"],
          criterionRefs: [
            "region_failover_degradation",
            "origin_shield_stampede",
            "multi_cdn_steering"
          ],
          sampleQuestions: [
            "An entire edge region goes dark mid-evening. Trace what happens to its viewers and to your origin.",
            "How many origin fetches does one popular segment generate on a cold cache?"
          ],
          progressiveNudges: [
            "Where do the orphaned clients go?",
            "Is that destination warm for this content?",
            "What collapses a million concurrent misses into something the origin survives?"
          ],
          greenFlags: [
            "Names request coalescing or a shield tier explicitly",
            "States the degradation accepted rather than claiming none"
          ],
          redFlags: [
            "Assumes failover is transparent to viewers",
            "Sends all failover traffic straight to origin"
          ]
        },
        {
          id: "rights_enforcement",
          label: "Licensing and playback authorization",
          phaseRefs: ["clarify", "api"],
          criterionRefs: ["licensing_enforcement"],
          sampleQuestions: [
            "Where is the territory licensing check performed, and what stops a client bypassing it?",
            "Can a segment URL be replayed from another country?"
          ],
          progressiveNudges: [
            "Who decides whether this viewer may watch this title?",
            "Is that decision made before or after the manifest is issued?",
            "What makes the segment URLs themselves non-transferable?"
          ],
          greenFlags: [
            "Authorizes before issuing a manifest",
            "Uses signed, expiring, session-scoped segment URLs"
          ],
          redFlags: [
            "Relies on the client to enforce territory",
            "Issues long-lived unsigned segment URLs"
          ]
        }
      ],
      scoreRubric: {
        "1": "Draws a generic client-CDN-origin diagram with no engagement with the origin capacity constraint, and cannot say what happens on a cache miss.",
        "2": "Uses a CDN and lazy fill, sizes bandwidth roughly, but treats cache hit ratio as an assumption and has no answer for losing a region.",
        "3": "Computes egress and origin load, justifies the hit ratio, pre-positions popular content, and names a concrete degradation for regional failure.",
        "4": "Also protects the origin explicitly (shield or coalescing), treats the ladder as a cost decision with demand-driven rungs, and reasons about steering and startup budget with numbers."
      }
    }
  }
});
