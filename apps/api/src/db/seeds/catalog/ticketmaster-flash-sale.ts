import { defineSeedProblem } from "../types.js";

export const ticketmasterFlashSale = defineSeedProblem({
  slug: "ticketmaster-flash-sale",
  title: "Design Ticketmaster: Flash-Sale Seat Booking",
  difficulty: "hard",
  track: "backend",
  tags: ["transactional", "consistency", "rate-limiting", "caching"],
  statement: [
    "Design the booking path for a live-events ticketing platform. Users browse events, pick specific seats from a seat map, hold them while they pay, and complete a purchase.",
    "",
    "In scope: seat inventory, the hold/reserve mechanism, checkout and payment coordination, the waiting room for high-demand sales, and the seat-map read path.",
    "",
    "Out of scope: the payment processor itself (assume an external charge API that can be slow and can time out ambiguously), fraud scoring, and ticket delivery.",
    "",
    "Traffic is pathological. For 99% of the week the system is nearly idle. Then a stadium tour goes on sale at exactly 10:00 and two million people arrive in the same second for fifty thousand seats. Every one of them is refreshing the seat map."
  ].join("\n"),
  constraints: [
    "A seat must never be sold twice. This is a hard correctness requirement — overselling has legal consequences.",
    "A seat held during checkout must be released automatically if payment is not completed within 10 minutes.",
    "The payment API may time out without telling you whether the charge succeeded; a retry must not double-charge.",
    "Fifty thousand seats may face two million concurrent shoppers at the moment a sale opens.",
    "The seat map may be slightly stale when browsing, but must be authoritative at the moment of holding.",
    "Users must be admitted in a fair, defensible order — a random winner is acceptable, but a system that rewards bots is not.",
    "The rest of the catalogue must stay responsive while a single high-demand sale is saturating the system."
  ],
  narrative: {
    framingScript:
      "We sell tickets for live events. Our problem is a very specific kind of load: nothing happens all week, and then at ten o'clock on Friday two million people show up for fifty thousand seats and the site falls over. On top of that we cannot oversell a single seat, because that turns into a refund and a lawyer. I would like you to design the booking path — inventory, holds, and checkout. Start wherever makes sense.",
    signatureChallenge:
      "Forty shoppers race for one seat while the payment API can time out ambiguously, so the design needs a mutually exclusive seat hold with a TTL plus an idempotent checkout keyed on a client token. The candidate separates by handling the hold expiring while the charge is still in flight — where naive designs either oversell or take money for nothing.",
    progressiveReveals: [
      "The sale opens and two million people hit the seat map in the first ten seconds, all for the same fifty thousand seats.",
      "Your payment provider times out on a charge and you genuinely do not know whether the card was billed. The hold expires two seconds later. What now?",
      "A customer says they were charged but have no ticket. How do you find out what happened to their order?"
    ]
  },
  estimationSpec: {
    intro:
      "The load profile is the whole problem: size the sale-opening spike, not the weekly average. Contention per seat is the number that justifies the design.",
    fields: [
      {
        key: "event_seats",
        label: "Seats in the event",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 1_000,
          max: 200_000,
          rationale: "An arena is tens of thousands of seats; a stadium tour date is larger"
        }
      },
      {
        key: "peak_shoppers",
        label: "Shoppers arriving at sale open",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10_000,
          max: 10_000_000,
          rationale: "High-demand tours draw one to two orders of magnitude more shoppers than seats"
        }
      },
      {
        key: "arrival_window_seconds",
        label: "Window over which they arrive",
        type: "number",
        unitKind: "seconds",
        displayUnit: "s",
        expectedMagnitude: {
          min: 5,
          max: 3_600,
          rationale: "Everyone has been told the same start time, so arrival is extremely bursty"
        }
      },
      {
        key: "requests_per_shopper",
        label: "Requests per shopper during the sale",
        type: "number",
        unitKind: "count",
        hint: "Seat-map polls, filter changes, retries",
        expectedMagnitude: {
          min: 2,
          max: 200,
          rationale: "Frustrated users refresh aggressively; each refresh is a request"
        }
      },
      {
        key: "hold_ttl_seconds",
        label: "Seat hold TTL",
        type: "number",
        unitKind: "seconds",
        displayUnit: "minutes",
        displayMultiplier: 60,
        expectedMagnitude: {
          min: 60,
          max: 1_800,
          rationale: "The constraint says 10 minutes; shorter increases churn, longer starves demand"
        }
      },
      {
        key: "payment_seconds",
        label: "Payment API latency",
        type: "number",
        unitKind: "seconds",
        displayUnit: "s",
        expectedMagnitude: {
          min: 0.5,
          max: 60,
          rationale: "External card processing is seconds, and its tail is much worse than its median"
        }
      },
      {
        key: "seat_bytes",
        label: "Bytes of state per seat",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        expectedMagnitude: {
          min: 50,
          max: 5_000,
          rationale: "Seat id, status, hold owner, expiry, price tier"
        }
      },
      {
        key: "ambiguous_payment_policy",
        label: "What do you do when the charge result is unknown and the hold has expired?",
        type: "text"
      }
    ],
    derivedHints: [
      "Peak request rate is the number that decides whether you need a waiting room. If it is in the hundreds of thousands per second, admission control is not optional.",
      "Contention per seat — shoppers divided by seats — tells you how many racers hit each individual row of inventory. That is what rules out optimistic retry loops as the only mechanism.",
      "The whole seat map for one event is small. Notice this: it means the authoritative inventory for a sale can plausibly live in one place, which makes exclusivity much easier.",
      "Compare hold TTL against payment latency. If the TTL is not comfortably longer than the payment tail, you have designed in the overselling bug."
    ],
    derivedFormulas: [
      {
        id: "peak_requests_per_sec",
        label: "Peak request rate",
        expression: "peak_shoppers * requests_per_shopper / arrival_window_seconds",
        unitKind: "count",
        displayUnit: "req/s"
      },
      {
        id: "peak_hold_attempts_per_sec",
        label: "Peak hold attempts / sec",
        expression: "peak_shoppers / arrival_window_seconds",
        unitKind: "count",
        displayUnit: "attempts/s"
      },
      {
        id: "contention_per_seat",
        label: "Shoppers per available seat",
        expression: "peak_shoppers / event_seats",
        unitKind: "ratio",
        displayUnit: "x"
      },
      {
        id: "seat_map_bytes",
        label: "Authoritative inventory size for one event",
        expression: "event_seats * seat_bytes",
        unitKind: "bytes",
        displayUnit: "B"
      },
      {
        id: "hold_slots_per_hour",
        label: "Hold slots per seat per hour",
        expression: "3600 / hold_ttl_seconds",
        unitKind: "ratio",
        displayUnit: "turns/h"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Six phases. Two things must be nailed and neither can be waved through: mutual exclusion on a seat, and idempotency across an unreliable payment call.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope it. **Interact with:** **Problem** tab — note that the payment API is explicitly allowed to fail ambiguously. That is not a detail, it is a requirement. **Interviewer** tab — ask me about seat selection versus best-available, whether queueing must be fair or merely bounded, and what happens to abandoned carts."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 420,
        candidateGuide:
          "Quantify the spike. **Interact with:** **Estimation** tab — fill every field, then read peak requests/sec and contention per seat. Also look at total seat-map bytes and note how small it is. **Interviewer** tab — tell me what those numbers rule in and out before you draw anything."
      },
      {
        id: "inventory_model",
        label: "Inventory and holds",
        durationSec: 660,
        candidateGuide:
          "Design exclusivity. **Interact with:** **Board** — where authoritative seat state lives, what a hold record looks like, and the exact operation that transitions a seat from available to held. Mark whether that operation is a conditional update, a row lock, or a single-writer partition. **Interviewer** tab — expect me to put forty concurrent shoppers on one seat and ask you to trace it. Also tell me how expiry is enforced — a sweeper, a TTL, or lazily on read."
      },
      {
        id: "checkout",
        label: "Checkout and payment",
        durationSec: 600,
        candidateGuide:
          "Make it idempotent. **Interact with:** **Board** — the order state machine, the idempotency key and where it comes from, and the reconciliation path for a charge whose outcome is unknown. **Interviewer** tab — walk me through the timeout case explicitly: hold expired, charge status unknown. Tell me which way you fail and who eats the cost. Use **Tutor** for idempotency-key patterns if you want, then commit."
      },
      {
        id: "load_shedding",
        label: "Admission control",
        durationSec: 540,
        candidateGuide:
          "Survive the opening second. **Interact with:** **Board** — the waiting room: how users are admitted, how the queue is stored, how you keep bots from jumping it, and how the seat-map read path is cached so that browsing does not touch authoritative inventory. **Interviewer** tab — tell me how you keep an unrelated event responsive while this sale runs."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 420,
        candidateGuide:
          "Close the loop. **Interact with:** **Board** — mark where you chose to be strict and where you chose to be eventually consistent, and why that split is safe. **Interviewer** tab — summarise, then answer unprompted: what breaks first if the sale is 10x larger, and what alert would tell you overselling had begun? Then **Validate**, then **End interview**."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "mutually_exclusive_hold",
        text: "Claiming a seat is a mutually exclusive operation — a conditional write, row lock, or single-writer partition — not a read then write.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A named atomic primitive on the seat row or key",
          "Losers of the race receive an explicit failure rather than a second hold"
        ],
        discoveryHints: [
          "Forty people click the same seat in the same millisecond. What happens?",
          "What makes the transition from available to held atomic?"
        ],
        progressiveNudges: [
          "Two shoppers select seat 14F simultaneously. Trace both requests.",
          "If both read 'available' and then both write 'held', what did you sell?",
          "Name the primitive that lets exactly one of them win — and say which store provides it."
        ]
      },
      {
        id: "idempotent_checkout",
        text: "Checkout is idempotent on a client-supplied key, so a retry after a timeout cannot double-charge.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "An idempotency key recorded before the payment call",
          "A replay of the same key returning the original outcome"
        ],
        discoveryHints: [
          "The user's checkout request times out and they click again. What happens?",
          "What identifies one logical purchase attempt?"
        ],
        progressiveNudges: [
          "The client times out mid-checkout and retries. Do they get charged twice?",
          "What key ties the two requests together as one purchase?",
          "Where is that key written relative to the call to the payment provider?"
        ]
      },
      {
        id: "unknown_charge_reconciliation",
        text: "An ambiguous payment result is reconciled against the provider rather than guessed, even after the hold expires.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A pending-unknown order state plus a reconciliation job",
          "A stated policy for the seat when the charge turns out to have succeeded"
        ],
        discoveryHints: [
          "The payment API times out with no answer. Was the card charged?",
          "The hold expires while the charge is in flight — then what?"
        ],
        progressiveNudges: [
          "Your payment call times out. You do not know whether money moved. What state is the order in?",
          "Two seconds later the hold expires and someone else buys the seat. Now what?",
          "Who resolves this, when, and who absorbs the cost? Give me the actual policy."
        ]
      },
      {
        id: "hold_expiry_enforcement",
        text: "Hold expiry is enforced by a concrete mechanism — TTL, sweeper, or lazy check on read — not assumed.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "A named expiry mechanism with its timing characteristics",
          "Recognition that an expired-but-not-yet-reclaimed seat must not be double-sold"
        ],
        discoveryHints: [
          "Who actually releases an abandoned hold?",
          "Is an expired hold still visible as held?"
        ],
        progressiveNudges: [
          "A shopper holds a seat and closes their laptop. When does it come back?",
          "What runs to make that happen — a TTL, a job, or a check on the next read?",
          "Between expiry and reclamation, could two people both be told the seat is theirs?"
        ]
      },
      {
        id: "no_overselling",
        text: "The seat inventory is authoritative and a seat cannot be sold twice under any interleaving.",
        dimension: "consistency",
        importance: "core",
        satisfiedBy: [
          "A single authoritative store for seat state",
          "Browsing served from a cache that is never treated as authoritative"
        ]
      },
      {
        id: "spike_capacity_math",
        text: "The opening-second request rate and per-seat contention are computed, not hand-waved.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Peak requests/sec derived from shoppers, requests each, and the arrival window",
          "Shoppers-per-seat stated as a number"
        ],
        discoveryHints: [
          "How many requests per second in the first ten seconds?",
          "How many shoppers per available seat?"
        ],
        progressiveNudges: [
          "Two million shoppers arrive over ten seconds. What is the request rate?",
          "Each of them refreshes the seat map repeatedly. Redo it.",
          "Now divide shoppers by seats. What does that contention number rule out?"
        ]
      },
      {
        id: "admission_control",
        text: "A waiting room or admission gate bounds how much traffic reaches the booking path.",
        dimension: "scalability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A queue or token system admitting a bounded rate into checkout",
          "A stated fairness property and how bots are resisted"
        ],
        discoveryHints: [
          "Does all that traffic reach your inventory store?",
          "How are users let in, and in what order?"
        ],
        progressiveNudges: [
          "Do two million people all get to attempt a hold?",
          "What sits in front, and how many does it admit per second?",
          "What stops a script from occupying a thousand queue positions?"
        ]
      },
      {
        id: "seat_map_read_path",
        text: "Seat-map browsing is served from cache and explicitly allowed to be stale, separate from the authoritative hold.",
        dimension: "latencyPerformance",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A cached seat map with a short TTL or push updates",
          "A stated acceptance that the map is advisory until the hold succeeds"
        ],
        discoveryHints: [
          "Does every seat-map refresh hit the authoritative store?",
          "Is the map the user sees guaranteed accurate?"
        ],
        progressiveNudges: [
          "Every shopper is polling the seat map. Where does that read land?",
          "Can that read be stale? What is the user cost if it is?",
          "So what is authoritative, and at what exact moment does the truth get checked?"
        ]
      },
      {
        id: "tenant_isolation",
        text: "One saturating sale does not degrade unrelated events on the platform.",
        dimension: "reliability",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "Per-event partitioning or dedicated capacity for high-demand sales",
          "Rate limits or bulkheads keyed on event"
        ],
        discoveryHints: [
          "What happens to a small theatre's ticket sales during this stadium drop?",
          "What do the two sales share?"
        ],
        progressiveNudges: [
          "A different event is on sale at the same time. Is it affected?",
          "Which shared components do both sales pass through?",
          "How would you bulkhead them — by partition, by queue, or by dedicated capacity?"
        ]
      },
      {
        id: "oversell_detection",
        text: "There is a signal that would reveal overselling in progress, not just after customer complaints.",
        dimension: "operability",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "An invariant check comparing sold count to inventory",
          "An alert on duplicate seat assignment"
        ],
        discoveryHints: [
          "How would you find out you had oversold?",
          "What invariant should always hold?"
        ],
        progressiveNudges: [
          "Suppose a bug lets two orders claim one seat. When do you learn?",
          "What invariant could you check continuously?",
          "What is the alert, and what is the automated response — stop the sale, or page someone?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "exclusivity",
          label: "Seat exclusivity",
          phaseRefs: ["inventory_model"],
          criterionRefs: ["mutually_exclusive_hold", "no_overselling", "hold_expiry_enforcement"],
          sampleQuestions: [
            "Forty shoppers select seat 14F within the same millisecond. Trace all forty requests.",
            "Who actually releases a hold when a shopper abandons checkout?"
          ],
          progressiveNudges: [
            "What is the operation that changes a seat from available to held?",
            "If it is read-then-write, what stops two winners?",
            "Name the primitive and the store that provides it."
          ],
          greenFlags: [
            "Names a conditional write, lock, or single-writer partition explicitly",
            "Notices the whole seat map for one event is small enough to keep in one place"
          ],
          redFlags: [
            "Read the seat, check available, then write held",
            "Relies on an application-level mutex across many instances"
          ]
        },
        {
          id: "money_path",
          label: "Checkout and payment ambiguity",
          phaseRefs: ["checkout"],
          criterionRefs: ["idempotent_checkout", "unknown_charge_reconciliation"],
          sampleQuestions: [
            "The payment API times out and you cannot tell whether the card was charged. The hold expires two seconds later.",
            "A user double-clicks Pay. What stops two charges?"
          ],
          progressiveNudges: [
            "What key identifies one logical purchase?",
            "Is that key written before or after you call the provider?",
            "Now the timeout: what state, what reconciliation, and who eats the cost?"
          ],
          greenFlags: [
            "Writes the idempotency record before the external call",
            "Has an explicit pending-unknown state and a reconciliation job"
          ],
          redFlags: [
            "Assumes the payment result is always known",
            "Releases the seat and forgets the in-flight charge"
          ]
        },
        {
          id: "spike_handling",
          label: "Opening-second load",
          phaseRefs: ["estimate", "load_shedding"],
          criterionRefs: [
            "spike_capacity_math",
            "admission_control",
            "seat_map_read_path",
            "tenant_isolation"
          ],
          sampleQuestions: [
            "Two million shoppers arrive in ten seconds. What is your request rate, and where does it land?",
            "How is a small unrelated event protected while this sale runs?"
          ],
          progressiveNudges: [
            "Compute peak requests per second including refreshes.",
            "Does all of that reach your inventory store?",
            "What admits users, at what rate, and how is that resistant to scripts?"
          ],
          greenFlags: [
            "Separates cached browsing from authoritative holds",
            "Bounds admission rate and states a fairness property"
          ],
          redFlags: [
            "Scales the database to absorb the spike",
            "Treats the cached seat map as authoritative"
          ]
        },
        {
          id: "safety_net",
          label: "Detecting failure",
          phaseRefs: ["wrap_up"],
          criterionRefs: ["oversell_detection"],
          sampleQuestions: [
            "A bug lets two orders claim one seat. When and how do you find out?",
            "What invariant should hold continuously during a sale?"
          ],
          progressiveNudges: [
            "How do you learn about overselling today — customer support?",
            "What could you check continuously instead?",
            "What is the automated response when it fires?"
          ],
          greenFlags: [
            "Proposes a continuous invariant check on sold versus inventory",
            "Has an automated stop-the-sale response"
          ],
          redFlags: [
            "Relies on refunds to clean up",
            "No detection story at all"
          ]
        }
      ],
      scoreRubric: {
        "1": "Treats seat booking as an ordinary CRUD write, has no answer for concurrent claims, and does not engage with the payment timeout.",
        "2": "Adds a hold with a TTL and a queue, but exclusivity is read-then-write and payment ambiguity is assumed away.",
        "3": "Makes the hold atomic with a named primitive, makes checkout idempotent, bounds admission, and separates cached browsing from authoritative inventory.",
        "4": "Also reconciles unknown charge outcomes against the provider with a stated cost policy, isolates tenants, and can detect overselling continuously."
      }
    }
  }
});
