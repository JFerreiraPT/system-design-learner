import { defineSeedProblem } from "../types.js";

export const stripeIdempotentPayments = defineSeedProblem({
  slug: "stripe-idempotent-payments",
  title: "Design Stripe's Payment Intake and Ledger",
  difficulty: "hard",
  track: "backend",
  tags: ["transactional", "consistency", "api-design", "compliance"],
  statement: [
    "Design the payment intake path for a payments platform. Merchants call an API to charge a customer's card; the platform talks to card networks and records the money movement in a ledger merchants can reconcile against.",
    "",
    "In scope: the charge API and its idempotency semantics, the state machine of a payment, coordination with an unreliable external network, the double-entry ledger, and webhooks notifying merchants of outcomes.",
    "",
    "Out of scope: fraud scoring, the card network protocols themselves (assume an authorize/capture API), payouts to merchant bank accounts, and the merchant dashboard UI.",
    "",
    "Merchants retry aggressively and often badly: the same logical charge may arrive several times because a client timed out, a load balancer retried, or a queue redelivered. The card network can accept a charge and then fail to tell you."
  ].join("\n"),
  constraints: [
    "A customer must never be charged twice for one logical payment, no matter how many times the request is retried.",
    "The card network call may time out with the charge's true outcome unknown, and the system must converge to the correct state without human intervention.",
    "Every money movement must be recorded in a double-entry ledger where debits and credits always balance.",
    "Ledger entries are immutable once written; corrections are new compensating entries, never edits.",
    "Merchants must receive a webhook for every terminal state change, at least once, with retries until acknowledged.",
    "The full history of a payment must be reconstructable for audit for at least seven years.",
    "A merchant sending a huge volume of charges must not delay another merchant's payments."
  ],
  narrative: {
    framingScript:
      "You are designing the intake path for a payments API. Merchants POST us a charge, we talk to the card networks, and we record what happened. The reason this is hard is not throughput — it is that our clients retry constantly and the card network sometimes takes money without telling us. I want a design where a customer is never double-charged and where we can always say exactly what happened to a given payment. Start wherever you like.",
    signatureChallenge:
      "A client retries a charge while the first attempt is still in flight at the card network, so the design needs an idempotency record written durably before the external call, plus a defined answer for a duplicate arriving while the original is pending. The candidate separates by reconciling the unknown outcome against the network rather than guessing.",
    progressiveReveals: [
      "Assume 500 million charges a day at peak season, with a peak hour several times the daily average.",
      "You call the network, it times out, and you have no idea whether the card was charged. A retry with the same idempotency key arrives one second later. What do both requests do?",
      "A merchant says their ledger is off by one charge for last Tuesday. How would you find where the discrepancy came from?"
    ]
  },
  estimationSpec: {
    intro:
      "Size the idempotency store and the ledger, not just the request rate. Both are dominated by retention rather than throughput.",
    fields: [
      {
        key: "charges_per_day",
        label: "Charges / day",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 100_000,
          max: 1_000_000_000,
          rationale: "A large platform processes hundreds of millions of charges a day at peak"
        }
      },
      {
        key: "peak_multiplier",
        label: "Peak / average ratio",
        type: "number",
        unitKind: "ratio",
        hint: "Retail seasonality is extreme",
        expectedMagnitude: {
          min: 1.5,
          max: 50,
          rationale: "Black Friday is far above an ordinary Tuesday"
        }
      },
      {
        key: "retry_fraction",
        label: "Fraction of requests that are retries",
        type: "number",
        unitKind: "ratio",
        expectedMagnitude: {
          min: 0.001,
          max: 0.5,
          rationale: "Client retries are common but should not dominate normal traffic"
        }
      },
      {
        key: "processor_seconds",
        label: "Card network call latency",
        type: "number",
        unitKind: "seconds",
        displayUnit: "s",
        expectedMagnitude: {
          min: 0.2,
          max: 60,
          rationale: "Authorization is seconds, and the tail is much worse than the median"
        }
      },
      {
        key: "idempotency_retention_seconds",
        label: "Idempotency key retention",
        type: "number",
        unitKind: "seconds",
        displayUnit: "days",
        displayMultiplier: 86_400,
        expectedMagnitude: {
          min: 3_600,
          max: 7_776_000,
          rationale: "Long enough to cover any realistic client retry, not forever"
        }
      },
      {
        key: "idempotency_record_bytes",
        label: "Bytes per idempotency record",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        hint: "Key, request fingerprint, state, and the cached response",
        expectedMagnitude: {
          min: 200,
          max: 50_000,
          rationale: "Storing the full response to replay makes these records non-trivial"
        }
      },
      {
        key: "ledger_entries_per_charge",
        label: "Ledger entries per charge",
        type: "number",
        unitKind: "count",
        hint: "Double entry means at least two, and fees and refunds add more",
        expectedMagnitude: {
          min: 2,
          max: 40,
          rationale: "Authorize, capture, fee, and payout legs add up quickly"
        }
      },
      {
        key: "ledger_entry_bytes",
        label: "Bytes per ledger entry",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        expectedMagnitude: {
          min: 100,
          max: 10_000,
          rationale: "Accounts, amount, currency, references, and timestamps"
        }
      },
      {
        key: "unknown_outcome_policy",
        label: "What happens when the network outcome is unknown?",
        type: "text"
      }
    ],
    derivedHints: [
      "In-flight charges at peak is the number that sizes your pending-state store, and it is driven by network latency, not request rate. A slow tail multiplies it.",
      "Idempotency store size grows with retention, so the retention window is a storage decision as much as a correctness one. State the window you chose and why.",
      "Ledger write rate is a multiple of charge rate. If your multiplier is 2, ask yourself where fees and refunds are recorded.",
      "Seven years of ledger at your write rate is the number that decides whether hot and cold ledger storage need to be different systems."
    ],
    derivedFormulas: [
      {
        id: "peak_charges_per_sec",
        label: "Peak charges / sec",
        expression: "charges_per_day * peak_multiplier / 86400",
        unitKind: "count",
        displayUnit: "charges/s"
      },
      {
        id: "in_flight_charges",
        label: "In-flight charges at peak",
        expression: "charges_per_day * peak_multiplier * processor_seconds / 86400",
        unitKind: "count",
        displayUnit: "pending"
      },
      {
        id: "idempotency_store_bytes",
        label: "Idempotency store size",
        expression:
          "charges_per_day * (1 + retry_fraction) * idempotency_record_bytes * idempotency_retention_seconds / 86400",
        unitKind: "bytes",
        displayUnit: "B"
      },
      {
        id: "ledger_writes_per_sec",
        label: "Peak ledger writes / sec",
        expression:
          "charges_per_day * peak_multiplier * ledger_entries_per_charge / 86400",
        unitKind: "count",
        displayUnit: "writes/s"
      },
      {
        id: "ledger_bytes_per_year",
        label: "Ledger bytes / year",
        expression:
          "charges_per_day * ledger_entries_per_charge * ledger_entry_bytes * 365",
        unitKind: "bytes",
        displayUnit: "B/yr"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Six phases. Idempotency and the unknown-outcome path are the spine — a design that only works when the network answers cleanly does not pass here.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope it. **Interact with:** **Problem** tab — note that ambiguous network timeouts are a stated requirement, not an edge case. **Interviewer** tab — ask me about authorize-versus-capture, refunds and partial captures, multi-currency, and who supplies the idempotency key. That last one is the design's foundation."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 420,
        candidateGuide:
          "Size the stores. **Interact with:** **Estimation** tab — fill every field, then read in-flight charges and idempotency store size. **Interviewer** tab — tell me why in-flight count depends on network latency rather than throughput, and what retention you picked for idempotency keys."
      },
      {
        id: "api_contract",
        label: "API and idempotency",
        durationSec: 660,
        candidateGuide:
          "Define the contract precisely. **Interact with:** **Board** — the charge request, the idempotency key, the record you write before calling out, and the responses for the three cases: first attempt, replay of a completed attempt, and duplicate arriving while the original is pending. **Interviewer** tab — tell me what you do when the same key arrives with a different request body. Expect me to push on the concurrent-duplicate case."
      },
      {
        id: "state_machine",
        label: "Payment state machine",
        durationSec: 600,
        candidateGuide:
          "Model the lifecycle. **Interact with:** **Board** — the payment states and legal transitions, including the pending-unknown state and how it is resolved. Draw the reconciliation job that queries the network for stuck payments. **Interviewer** tab — walk me through a payment that times out, is retried, and turns out to have succeeded the first time. Nothing may be double-charged in that trace."
      },
      {
        id: "ledger",
        label: "Ledger and webhooks",
        durationSec: 600,
        candidateGuide:
          "Record and notify. **Interact with:** **Board** — the double-entry ledger schema, how a charge becomes balanced entries, how immutability is enforced, and how a correction is represented. Then the webhook delivery path with retries and merchant acknowledgement. **Interviewer** tab — tell me how a merchant reconciles their own books against yours, and how one noisy merchant is isolated from another. Use **Tutor** for double-entry terminology if you need it."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 420,
        candidateGuide:
          "Close it out. **Interact with:** **Board** — mark where you chose strong consistency and where you allowed eventual consistency, and why the money path is on the strict side of that line. **Interviewer** tab — summarise, then answer unprompted: what breaks first at 10x peak volume, and what alarm would tell you double-charging had started? Then **Validate**, then **End interview**."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "idempotency_record_before_call",
        text: "The idempotency record is durably written before the card network is called, so a retry can find the first attempt.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A record keyed on the idempotency key persisted pre-call",
          "A stored request fingerprint so a key reused with a different body is rejected"
        ],
        discoveryHints: [
          "When is the idempotency key first written down?",
          "What does a retry look up, and does it exist yet?"
        ],
        progressiveNudges: [
          "A merchant retries a charge. What does your service look up first?",
          "If you write the record after the network call, what does the retry find during the call?",
          "So order it: what is written, when, and what does a concurrent duplicate see?"
        ]
      },
      {
        id: "concurrent_duplicate_handling",
        text: "A duplicate arriving while the original is still pending gets a defined answer rather than a second charge.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A unique constraint or lock on the key that the second request loses",
          "A stated response for the loser: wait, or return in-progress"
        ],
        discoveryHints: [
          "Two identical requests arrive one second apart, the first still in flight.",
          "What does the second request return?"
        ],
        progressiveNudges: [
          "Duplicate arrives while attempt one is still at the network. What happens?",
          "Does it wait, error, or proceed? Pick one and say why.",
          "What database primitive guarantees only one of them proceeds?"
        ]
      },
      {
        id: "unknown_outcome_reconciliation",
        text: "An ambiguous network result becomes a pending state resolved by querying the provider, never a guess.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A pending-unknown state on the payment",
          "A reconciliation job that queries the network for stuck payments"
        ],
        discoveryHints: [
          "The network times out. Was the card charged?",
          "Who resolves that, and when?"
        ],
        progressiveNudges: [
          "You called the network and got a timeout. What do you record?",
          "Do you assume success or failure? Both are wrong — what is the third option?",
          "What process later converts that unknown into a terminal state?"
        ]
      },
      {
        id: "append_only_ledger",
        text: "The ledger is append-only double entry: corrections are compensating entries, never edits.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "Balanced debit and credit entries per money movement",
          "A reversal represented as new entries referencing the original"
        ],
        discoveryHints: [
          "How is a refund represented in the ledger?",
          "Can a ledger entry ever be updated?"
        ],
        progressiveNudges: [
          "A charge was recorded wrongly. How do you fix the ledger?",
          "Do you update the row, or write something new?",
          "If entries are immutable, what makes debits and credits still balance after a correction?"
        ]
      },
      {
        id: "payment_state_machine",
        text: "Payments move through an explicit state machine with legal transitions, not ad-hoc status flags.",
        dimension: "consistency",
        importance: "core",
        satisfiedBy: [
          "Named states and the transitions allowed between them",
          "Terminal states distinguished from in-flight ones"
        ]
      },
      {
        id: "in_flight_capacity_math",
        text: "In-flight payment count is derived from network latency rather than from throughput alone.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Peak rate times provider latency stated as a concurrency figure",
          "Recognition that a latency tail multiplies pending state"
        ],
        discoveryHints: [
          "How many payments are mid-flight at peak?",
          "What drives that number?"
        ],
        progressiveNudges: [
          "At peak, how many charges are simultaneously waiting on the network?",
          "That depends on latency, not just rate. Multiply them.",
          "Now use the p99 latency instead of the median. How much bigger is it?"
        ]
      },
      {
        id: "idempotency_retention_policy",
        text: "Idempotency keys have a deliberate retention window, sized against realistic client retry behaviour.",
        dimension: "cost",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A stated retention period with a reason",
          "Storage sized from rate times retention"
        ],
        discoveryHints: [
          "How long do you keep idempotency records?",
          "What happens if a client retries after that window?"
        ],
        progressiveNudges: [
          "Do you keep idempotency keys forever?",
          "What is the longest realistic gap before a client retries?",
          "Size the store from your rate and that window. Is it affordable?"
        ]
      },
      {
        id: "webhook_at_least_once",
        text: "Webhooks are at-least-once with retries until acknowledged, and merchants are told to expect duplicates.",
        dimension: "reliability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A delivery queue with retry and backoff per endpoint",
          "An event id merchants can deduplicate on"
        ],
        discoveryHints: [
          "What happens when a merchant's endpoint is down for an hour?",
          "Can a merchant receive the same event twice?"
        ],
        progressiveNudges: [
          "The merchant's webhook endpoint returns 500 for an hour. Then what?",
          "How many times do you retry, and with what spacing?",
          "If they might get duplicates, what do you give them to deduplicate on?"
        ]
      },
      {
        id: "merchant_isolation",
        text: "One high-volume or failing merchant does not delay another merchant's payments or webhooks.",
        dimension: "reliability",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "Per-merchant queues, partitions, or rate limits",
          "A failing endpoint that cannot block a shared delivery worker pool"
        ],
        discoveryHints: [
          "One merchant sends ten times everyone else combined. Who notices?",
          "One merchant's webhook endpoint hangs. What else stalls?"
        ],
        progressiveNudges: [
          "A single merchant floods you. Whose payments slow down?",
          "Which queue or partition do they share with others?",
          "What is the bulkhead — per-merchant queues, quotas, or dedicated workers?"
        ]
      },
      {
        id: "audit_reconstruction",
        text: "A specific payment's full history can be reconstructed years later for audit or dispute.",
        dimension: "security",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "An immutable event log per payment retained for the stated period",
          "Hot and cold storage tiers with the same audit guarantees"
        ],
        discoveryHints: [
          "A merchant disputes a charge from three years ago. What can you show them?",
          "Where does seven-year-old data live?"
        ],
        progressiveNudges: [
          "Reconstruct what happened to one payment two years ago. What do you read?",
          "Is that in the same store you serve live traffic from?",
          "If it moved to cold storage, is the audit guarantee still the same?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "idempotency",
          label: "Idempotency semantics",
          phaseRefs: ["api_contract"],
          criterionRefs: [
            "idempotency_record_before_call",
            "concurrent_duplicate_handling",
            "idempotency_retention_policy"
          ],
          sampleQuestions: [
            "A duplicate request arrives while the first is still at the card network. What does it return?",
            "The same key arrives with a different request body. What do you do?"
          ],
          progressiveNudges: [
            "What is written down first when a charge arrives?",
            "Is that before or after the network call?",
            "What primitive stops two requests with one key both proceeding?"
          ],
          greenFlags: [
            "Persists the record pre-call and stores a request fingerprint",
            "Has a defined answer for the in-flight duplicate, not just the completed replay"
          ],
          redFlags: [
            "Only handles the replay-after-completion case",
            "Caches the response without a durable pre-call record"
          ]
        },
        {
          id: "ambiguity",
          label: "Unknown outcomes",
          phaseRefs: ["state_machine"],
          criterionRefs: ["unknown_outcome_reconciliation", "payment_state_machine", "in_flight_capacity_math"],
          sampleQuestions: [
            "The network times out and you do not know whether money moved. Walk me through the next hour.",
            "How many payments are in flight at peak, and what drives that number?"
          ],
          progressiveNudges: [
            "What state do you record on a timeout?",
            "Assuming success or failure are both wrong. What is the third option?",
            "What later turns that unknown into a terminal state, and how does it know?"
          ],
          greenFlags: [
            "Explicit pending-unknown state plus a reconciliation job",
            "Derives in-flight count from latency rather than rate"
          ],
          redFlags: [
            "Treats a timeout as a failure and retries blindly",
            "Has only success and failure states"
          ]
        },
        {
          id: "ledger_integrity",
          label: "Ledger integrity",
          phaseRefs: ["ledger"],
          criterionRefs: ["append_only_ledger", "audit_reconstruction"],
          sampleQuestions: [
            "A charge was recorded wrongly. How does the ledger get corrected?",
            "A merchant disputes a charge from three years ago. What can you show?"
          ],
          progressiveNudges: [
            "Do you update the entry, or write a new one?",
            "If entries are immutable, how do debits and credits still balance?",
            "And where does three-year-old data live — same store as live traffic?"
          ],
          greenFlags: [
            "Corrections as compensating entries referencing the original",
            "Distinguishes hot from cold ledger storage without weakening audit"
          ],
          redFlags: [
            "Mutates ledger rows to fix mistakes",
            "Single-entry accounting with a balance column"
          ]
        },
        {
          id: "notification_and_isolation",
          label: "Webhooks and merchant isolation",
          phaseRefs: ["ledger", "wrap_up"],
          criterionRefs: ["webhook_at_least_once", "merchant_isolation"],
          sampleQuestions: [
            "A merchant's webhook endpoint returns errors for an hour. What happens to their events, and to everyone else's?",
            "One merchant sends ten times the volume of all others. Who feels it?"
          ],
          progressiveNudges: [
            "How many retries, and with what backoff?",
            "Which worker pool or queue is doing that retrying?",
            "Is that shared with other merchants? What is your bulkhead?"
          ],
          greenFlags: [
            "Per-merchant queues or quotas named explicitly",
            "Gives merchants an event id for deduplication"
          ],
          redFlags: [
            "One shared webhook worker pool with synchronous retries",
            "Assumes merchant endpoints are reliable"
          ]
        }
      ],
      scoreRubric: {
        "1": "Designs a charge endpoint that calls the provider and writes a row, with no idempotency and no handling of an unknown result.",
        "2": "Adds an idempotency key and caches responses, but only handles retries after completion and treats timeouts as failures.",
        "3": "Persists the idempotency record before the external call, handles the concurrent duplicate, reconciles unknown outcomes, and keeps an append-only double-entry ledger.",
        "4": "Also sizes in-flight state from latency, justifies key retention, delivers webhooks at-least-once with per-merchant isolation, and can reconstruct a payment for audit years later."
      }
    }
  }
});
