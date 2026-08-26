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
  }
});
