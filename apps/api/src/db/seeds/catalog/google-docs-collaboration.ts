import { defineSeedProblem } from "../types.js";

export const googleDocsCollaboration = defineSeedProblem({
  slug: "google-docs-collaboration",
  title: "Design Google Docs: Real-Time Collaborative Editing",
  difficulty: "expert",
  track: "backend",
  tags: ["consistency", "real-time", "event-sourcing", "storage"],
  statement: [
    "Design a collaborative document editor. Several people edit the same document simultaneously, each seeing the others' cursors and characters appear as they type, and everyone ends up looking at the same document.",
    "",
    "In scope: the editing protocol, conflict resolution, persistence and snapshotting, presence and cursors, offline editing with reconnection, and version history.",
    "",
    "Out of scope: rich rendering and layout, comments, permissions beyond a simple can-edit check, and export to other formats.",
    "",
    "Most documents have one editor. A minority have two to ten simultaneously. A rare few — a shared meeting agenda, a live incident doc — have dozens of people typing at once. Clients may go offline mid-edit and reconnect with a backlog of local changes."
  ].join("\n"),
  constraints: [
    "A local keystroke must render instantly — the editor may never block on a server round trip.",
    "A remote keystroke must appear to other editors in under 200ms at p95 while all parties are connected.",
    "All clients must converge on byte-identical document state; there is no acceptable outcome where two editors permanently see different text.",
    "A client that edited offline for up to 7 days must be able to reconnect and merge without losing its local work.",
    "No edit acknowledged to a client may ever be lost, including across a server restart.",
    "Version history must allow restoring the document as of any point in the last 30 days.",
    "A document with 50 simultaneous editors must stay usable, though slightly higher latency is acceptable at that size."
  ],
  narrative: {
    framingScript:
      "We are building a collaborative editor. The demo works beautifully with two people; with eight it starts producing documents where two users see different text, and once that happens we have lost the user's trust permanently. I would like you to design the editing and synchronisation core — how edits are represented, how they are merged, and how state is persisted. Start wherever you like, but convergence is where I will spend most of my questions.",
    signatureChallenge:
      "Two editors insert at the same position at the same instant and both clients must converge on identical text without a lock. The candidate has to pick a mechanism — OT against a server-ordered log, or a CRDT with position identifiers — and defend it under the offline case, where a client arrives with hundreds of ops built on a week-old view.",
    progressiveReveals: [
      "Say we now have 50 million documents active on a weekday and the busiest of them has 60 people typing at once.",
      "A client reconnects after a week offline with 800 local operations, and the document has moved on by 40,000 operations. What does the merge do, and what does the user see?",
      "A user reports their paragraph got scrambled an hour ago. How do you determine which operations produced that state?"
    ]
  },
  estimationSpec: {
    intro:
      "The interesting quantity is not document storage — it is the operation log and the broadcast fanout, both of which scale with editors per document squared.",
    fields: [
      {
        key: "active_docs",
        label: "Concurrently active documents",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10_000,
          max: 100_000_000,
          rationale: "Millions of documents open at once at large scale"
        }
      },
      {
        key: "editors_per_doc",
        label: "Average simultaneous editors per active doc",
        type: "number",
        unitKind: "count",
        hint: "Most docs have exactly one; the mean stays low",
        expectedMagnitude: {
          min: 1,
          max: 30,
          rationale: "The overwhelming majority of open documents have a single editor"
        }
      },
      {
        key: "ops_per_editor_per_sec",
        label: "Operations / editor / second while typing",
        type: "number",
        unitKind: "ratio",
        hint: "Keystrokes, possibly batched",
        expectedMagnitude: {
          min: 0.1,
          max: 20,
          rationale: "Sustained typing is a few characters a second, and editors pause often"
        }
      },
      {
        key: "op_bytes",
        label: "Bytes per operation",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        expectedMagnitude: {
          min: 20,
          max: 2_000,
          rationale: "A position, a character, an author id, and a version stamp"
        }
      },
      {
        key: "snapshot_every_ops",
        label: "Operations between snapshots",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10,
          max: 100_000,
          rationale: "Frequent enough that replay on open is fast, rare enough to be cheap"
        }
      },
      {
        key: "doc_bytes",
        label: "Average document size",
        type: "number",
        unitKind: "bytes",
        displayUnit: "KB",
        displayMultiplier: 1024,
        expectedMagnitude: {
          min: 1_000,
          max: 10_000_000,
          rationale: "A few kilobytes of text for a typical document"
        }
      },
      {
        key: "history_retention_seconds",
        label: "Version history retention",
        type: "number",
        unitKind: "seconds",
        displayUnit: "days",
        displayMultiplier: 86_400,
        expectedMagnitude: {
          min: 86_400,
          max: 31_536_000,
          rationale: "The constraint says 30 days; longer is a storage-cost decision"
        }
      },
      {
        key: "convergence_mechanism",
        label: "Which convergence approach, and what breaks if you chose the other?",
        type: "text"
      }
    ],
    derivedHints: [
      "Broadcast events per second is ops/sec times editors per doc — the fanout is quadratic in editors, which is why a 60-editor document is qualitatively different from a 6-editor one.",
      "Compare op-log bytes per second against document bytes. The log grows without bound while the document does not; that asymmetry is the entire justification for snapshots and log compaction.",
      "Snapshot rate tells you how much replay a client faces on open. If replaying takes longer than a second, snapshot more often."
    ],
    derivedFormulas: [
      {
        id: "ops_per_sec",
        label: "Operations / sec (all docs)",
        expression: "active_docs * editors_per_doc * ops_per_editor_per_sec",
        unitKind: "count",
        displayUnit: "ops/s"
      },
      {
        id: "broadcast_events_per_sec",
        label: "Broadcast events / sec",
        expression: "active_docs * editors_per_doc * editors_per_doc * ops_per_editor_per_sec",
        unitKind: "count",
        displayUnit: "events/s"
      },
      {
        id: "oplog_bytes_per_sec",
        label: "Operation log write throughput",
        expression: "active_docs * editors_per_doc * ops_per_editor_per_sec * op_bytes",
        unitKind: "bytes",
        displayUnit: "B/s"
      },
      {
        id: "snapshots_per_sec",
        label: "Snapshots written / sec",
        expression:
          "active_docs * editors_per_doc * ops_per_editor_per_sec / snapshot_every_ops",
        unitKind: "count",
        displayUnit: "snapshots/s"
      },
      {
        id: "snapshot_bytes_per_sec",
        label: "Snapshot write throughput",
        expression:
          "active_docs * editors_per_doc * ops_per_editor_per_sec * doc_bytes / snapshot_every_ops",
        unitKind: "bytes",
        displayUnit: "B/s"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Seven phases at expert depth. Convergence is the spine: everything else — persistence, presence, offline — is judged by whether it preserves the guarantee you claim in phase four.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope before designing. **Interact with:** **Problem** tab — note the convergence constraint; it is absolute, not best-effort. **Interviewer** tab — ask me about plain text versus rich text, the realistic maximum number of simultaneous editors, and whether offline editing must merge or may conflict. The rich-text answer changes your operation model significantly."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 420,
        candidateGuide:
          "Size the log and the fanout. **Interact with:** **Estimation** tab — fill every field, then read broadcast events/sec and op-log throughput. Notice that fanout is quadratic in editors per doc and say so. **Interviewer** tab — tell me what the log growth rate means for how long you can keep raw operations."
      },
      {
        id: "edit_model",
        label: "Edit model",
        durationSec: 480,
        candidateGuide:
          "Define what an edit is. **Interact with:** **Board** — the operation type: insert and delete, how a position is addressed, and what version or causal metadata rides along. **Interviewer** tab — walk me through a single keystroke from local render to server acknowledgement. Be precise about the position representation; index-based and identifier-based lead to very different designs."
      },
      {
        id: "convergence",
        label: "Convergence",
        durationSec: 780,
        candidateGuide:
          "The decisive phase. **Interact with:** **Board** — draw two concurrent inserts at the same position and show, step by step, how both clients reach identical state. Mark whether the server is an ordering authority or just a relay. **Interviewer** tab — name your mechanism (OT or CRDT), and state the property you are relying on. Expect me to construct a three-way concurrent edit. Use **Tutor** if you want to check a definition, then come back and commit to a choice."
      },
      {
        id: "persistence",
        label: "Persistence and history",
        durationSec: 540,
        candidateGuide:
          "Make it durable. **Interact with:** **Board** — the operation log, snapshots, compaction, and how opening a document reconstructs current state. Draw how a 30-day restore is served. **Interviewer** tab — tell me the exact point at which an acknowledged edit becomes safe against a server restart, and what the client does before that point."
      },
      {
        id: "offline_and_presence",
        label: "Offline and presence",
        durationSec: 480,
        candidateGuide:
          "Handle the hard clients. **Interact with:** **Board** — the reconnection path for a client with 800 queued operations against a document 40,000 operations ahead, plus how cursors and presence are propagated (and why presence need not be durable). **Interviewer** tab — expect follow-ups on what the user sees during a large merge."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 420,
        candidateGuide:
          "Close it out. **Interact with:** **Board** — mark the costs of your convergence choice: metadata overhead, tombstones, server statefulness. **Interviewer** tab — summarise, then answer unprompted: what breaks first at 10x editors per document, and how would you detect a divergence bug in production before a user reports it? Then **Validate**, then **End interview**."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "convergence_mechanism",
        text: "A specific convergence mechanism is named — OT against a server-ordered log, or a CRDT with position identifiers — and defended.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "The mechanism named explicitly, not just 'merge the edits'",
          "A stated property that guarantees identical final state"
        ],
        discoveryHints: [
          "What guarantees both clients end up with the same text?",
          "Is there a server ordering, or is it order-independent?"
        ],
        progressiveNudges: [
          "Two clients apply edits in different orders. What makes the results identical?",
          "Are you transforming operations against a server order, or making them commutative?",
          "Pick one and name it. Then tell me the property it gives you."
        ]
      },
      {
        id: "concurrent_insert_same_position",
        text: "Two inserts at the same position at the same instant resolve deterministically without a lock.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A deterministic tie-break, such as author id or identifier ordering",
          "A traced example showing both clients reaching the same result"
        ],
        discoveryHints: [
          "Both users type a character at position 12 simultaneously. Which comes first?",
          "What breaks the tie, and is it the same on both clients?"
        ],
        progressiveNudges: [
          "Two editors insert at the same index at the same moment. Walk both clients through it.",
          "Does each client see its own edit first? Do they still converge?",
          "What deterministic tie-break do you use, and is it available to both clients without a round trip?"
        ]
      },
      {
        id: "offline_merge_bounded",
        text: "A client returning with hundreds of local operations against a far-advanced document merges without losing work or replaying everything.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Local operations rebased or transformed against the missed range",
          "A bounded path that does not require transforming against 40,000 operations one by one"
        ],
        discoveryHints: [
          "A client reconnects with 800 local ops and the doc moved 40,000 ops ahead.",
          "What does the merge actually compute, and how long does it take?"
        ],
        progressiveNudges: [
          "Client offline a week, 800 local operations, document 40,000 ahead. What happens on reconnect?",
          "Is that 800 x 40,000 transformations? What does that cost?",
          "How do you bound it — snapshots, compaction, or a different mechanism entirely?"
        ]
      },
      {
        id: "ack_durability",
        text: "An acknowledged edit survives a server restart, and the client knows which edits are not yet safe.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Operations appended durably before acknowledgement",
          "A client-side pending set retried until acknowledged"
        ],
        discoveryHints: [
          "What does the client do with an edit that has not been acknowledged?",
          "The server restarts. Which edits survive?"
        ],
        progressiveNudges: [
          "The server acks an operation then restarts. Is that operation still in the document?",
          "What had to happen before the ack for that to be true?",
          "And what does the client hold onto until the ack arrives?"
        ]
      },
      {
        id: "tombstone_metadata_cost",
        text: "The metadata cost of the chosen mechanism — tombstones or position identifiers — is acknowledged and managed.",
        dimension: "cost",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "Recognition that deleted characters or identifiers accumulate",
          "A compaction or garbage-collection strategy with its safety condition"
        ],
        discoveryHints: [
          "What happens to deleted characters in your representation?",
          "Does the document's overhead grow with edit history?"
        ],
        progressiveNudges: [
          "A document has been edited for two years. How much bigger is its representation than its text?",
          "What is accumulating — tombstones, identifiers, or both?",
          "When is it safe to collect them, given a client could still be offline holding old state?"
        ]
      },
      {
        id: "local_first_rendering",
        text: "A local keystroke renders immediately without waiting for the server.",
        dimension: "latencyPerformance",
        importance: "core",
        satisfiedBy: [
          "The edit applied to local state before being sent",
          "Server acknowledgement handled asynchronously"
        ]
      },
      {
        id: "operation_model",
        text: "The operation type and position representation are defined precisely, not left implicit.",
        dimension: "requirements",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Insert and delete with a stated addressing scheme",
          "A version or causal stamp carried with each operation"
        ],
        discoveryHints: [
          "What exactly is sent when someone types one character?",
          "How is the position addressed — by index, or by identifier?"
        ],
        progressiveNudges: [
          "Describe the payload of a single keystroke.",
          "Is the position an integer index or a stable identifier?",
          "Index-based and identifier-based lead to very different designs. Which are you choosing?"
        ]
      },
      {
        id: "op_log_and_snapshots",
        text: "Persistence is an operation log plus periodic snapshots, so opening a document does not replay all history.",
        dimension: "scalability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A snapshot cadence with a reason",
          "Document open reconstructing from the latest snapshot plus a bounded tail"
        ],
        discoveryHints: [
          "What happens when someone opens a document with a million operations?",
          "Is the current text stored anywhere, or only the operations?"
        ],
        progressiveNudges: [
          "How do you reconstruct current state on open?",
          "If that replays every operation ever, how long does it take?",
          "How often do you snapshot, and what does that cost?"
        ]
      },
      {
        id: "fanout_math",
        text: "Broadcast fanout is computed and its quadratic dependence on editors per document is noticed.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Operations/sec and broadcast events/sec both stated",
          "Recognition that fanout scales with editors squared per document"
        ],
        discoveryHints: [
          "How many broadcast events per second?",
          "What happens to that number when editors per document doubles?"
        ],
        progressiveNudges: [
          "Compute operations per second across all documents.",
          "Now multiply by editors per document, since each op goes to all of them.",
          "So what is the relationship between editor count and fanout? Say it precisely."
        ]
      },
      {
        id: "presence_ephemeral",
        text: "Cursors and presence are treated as ephemeral, on a cheaper path than document operations.",
        dimension: "operability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Presence not written to the durable operation log",
          "Lossy or throttled cursor updates"
        ],
        discoveryHints: [
          "Is a cursor move an operation in your log?",
          "Does presence need to survive a restart?"
        ],
        progressiveNudges: [
          "Someone moves their cursor thirty times a second. Does each one persist?",
          "What would that do to your operation log volume?",
          "So what guarantees does presence actually need, and how does that change its path?"
        ]
      },
      {
        id: "version_history_restore",
        text: "Restoring the document as of an arbitrary point in the retention window is supported by the persistence design.",
        dimension: "requirements",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "Snapshots plus operations sufficient to reconstruct any point in the window",
          "Restore expressed as new operations rather than mutating history"
        ],
        discoveryHints: [
          "How do you show the document as it was 12 days ago?",
          "Is a restore a rewrite, or new edits?"
        ],
        progressiveNudges: [
          "A user wants the document as of last Tuesday. What do you read?",
          "Do you have a snapshot near that point, or do you replay?",
          "And when they restore it, does the intervening history disappear?"
        ]
      },
      {
        id: "divergence_detection",
        text: "There is a way to detect two clients having diverged before a user reports it.",
        dimension: "operability",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Periodic state checksums compared across clients or against the server",
          "An alert when checksums disagree at the same version"
        ],
        discoveryHints: [
          "How would you know a convergence bug had shipped?",
          "Can two clients tell each other they agree?"
        ],
        progressiveNudges: [
          "A subtle bug makes two clients diverge on rare interleavings. How do you find out?",
          "Could clients exchange a cheap fingerprint of their state?",
          "At what version would you compare, and what do you do when they disagree?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "convergence",
          label: "Convergence guarantee",
          phaseRefs: ["convergence", "edit_model"],
          criterionRefs: [
            "convergence_mechanism",
            "concurrent_insert_same_position",
            "operation_model"
          ],
          sampleQuestions: [
            "Two editors insert a character at the same position at the same instant. Trace both clients to identical state.",
            "Is your position an integer index or a stable identifier, and what does that choice cost?"
          ],
          progressiveNudges: [
            "Describe one keystroke's payload.",
            "Two clients apply edits in different orders — what makes results identical?",
            "Name the mechanism and the deterministic tie-break."
          ],
          greenFlags: [
            "Commits to OT or CRDT and states the property it provides",
            "Has a tie-break both clients can compute without a round trip"
          ],
          redFlags: [
            "Says 'merge the changes' without a mechanism",
            "Proposes locking a region of the document"
          ]
        },
        {
          id: "durability",
          label: "Persistence and history",
          phaseRefs: ["persistence"],
          criterionRefs: ["ack_durability", "op_log_and_snapshots", "version_history_restore"],
          sampleQuestions: [
            "The server acknowledges an operation then restarts. Is that edit still in the document?",
            "Someone opens a document with a million operations. What happens?"
          ],
          progressiveNudges: [
            "What had to happen before the ack?",
            "How is current state reconstructed on open?",
            "How often do you snapshot, and how does that support a 30-day restore?"
          ],
          greenFlags: [
            "Appends durably before acknowledging",
            "Snapshot cadence justified against open latency"
          ],
          redFlags: [
            "Acks from memory and persists later",
            "Replays full history on every open"
          ]
        },
        {
          id: "offline_and_presence",
          label: "Offline merge and presence",
          phaseRefs: ["offline_and_presence"],
          criterionRefs: ["offline_merge_bounded", "presence_ephemeral", "local_first_rendering"],
          sampleQuestions: [
            "A client reconnects with 800 local operations against a document 40,000 operations ahead. What happens?",
            "Does a cursor move go into your operation log?"
          ],
          progressiveNudges: [
            "What does the merge compute, and how expensive is it?",
            "Is that a product of both counts? What bounds it?",
            "Now presence — what guarantees does it actually need?"
          ],
          greenFlags: [
            "Bounds the offline merge rather than transforming pairwise",
            "Keeps presence off the durable path"
          ],
          redFlags: [
            "Discards local work on a large divergence",
            "Persists cursor movements as operations"
          ]
        },
        {
          id: "scale_and_safety",
          label: "Fanout scale and divergence safety",
          phaseRefs: ["estimate", "wrap_up"],
          criterionRefs: ["fanout_math", "tombstone_metadata_cost", "divergence_detection"],
          sampleQuestions: [
            "How does broadcast volume change when editors per document doubles?",
            "A convergence bug makes two clients diverge on rare interleavings. How do you find out?"
          ],
          progressiveNudges: [
            "Compute operations per second, then broadcast events per second.",
            "What is the relationship to editor count? Say it precisely.",
            "And what fingerprint could clients exchange to prove they agree?"
          ],
          greenFlags: [
            "Notices fanout is quadratic in editors per document",
            "Proposes state checksums compared at a version"
          ],
          redFlags: [
            "Assumes 60 editors is just 10x harder than 6",
            "No answer for detecting divergence except user reports"
          ]
        }
      ],
      scoreRubric: {
        "1": "Proposes last-write-wins or a lock on the document, with no mechanism for concurrent edits at the same position.",
        "2": "Names OT or CRDT but cannot trace two concurrent inserts to identical state, and has no offline or persistence story.",
        "3": "Commits to a mechanism, traces concurrent inserts deterministically, persists before acking, and uses snapshots so opening a document is fast.",
        "4": "Also bounds the offline merge, keeps presence ephemeral, notices fanout is quadratic in editors, manages tombstone growth, and can detect divergence proactively."
      }
    }
  }
});
