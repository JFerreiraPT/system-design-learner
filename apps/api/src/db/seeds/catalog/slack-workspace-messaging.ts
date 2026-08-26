import { defineSeedProblem } from "../types.js";

export const slackWorkspaceMessaging = defineSeedProblem({
  slug: "slack-workspace-messaging",
  title: "Design Slack: Workspace Channels and Live Sync",
  difficulty: "hard",
  track: "fullstack",
  tags: ["messaging", "real-time", "search", "caching"],
  statement: [
    "Design a team chat product end to end — the client and the server. Users belong to a workspace, read and post in channels, and see messages arrive live. Opening a channel with years of history must feel instant.",
    "",
    "In scope: the channel data model, the live sync protocol between client and server, what the client caches locally, reconnection and gap recovery, unread counts, and message search.",
    "",
    "Out of scope: calls and huddles, file storage internals (treat an upload as a blob id), and workspace billing.",
    "",
    "The client is a long-lived application: a desktop app open for weeks, suspended and resumed with the laptop lid, holding a local cache that may be far behind. Workspaces range from five people to a hundred thousand."
  ].join("\n"),
  constraints: [
    "Switching to a channel the user has open must render from local state in under 100ms, with no network round trip on the critical path.",
    "A message posted by a teammate must appear in under 500ms at p95 while the client is connected.",
    "After a reconnect, the client must detect and fill any gap in its history — silently missing messages is unacceptable.",
    "Unread counts must be consistent across a user's devices within a few seconds.",
    "A client resuming after two weeks suspended must not have to re-download entire channel histories.",
    "Search must cover the whole workspace history and respect channel membership — a user must never see a result from a private channel they are not in.",
    "A workspace of 100,000 users with a busy all-hands channel must not degrade other workspaces."
  ],
  narrative: {
    framingScript:
      "We are building a team chat app, and I want to talk about both halves — the server and the client — because the interesting problems here live in between them. The desktop app stays open for weeks, goes to sleep with the laptop, and wakes up convinced it knows the state of the world when it does not. Design the channel model, the sync protocol, and what the client keeps locally. Start wherever you want.",
    signatureChallenge:
      "A client resuming from suspend cannot distinguish 'nothing happened' from 'I missed 400 messages', so the protocol needs a per-channel monotonic sequence and an explicit gap-detection step on reconnect. The candidate separates by making catch-up bounded — a gap summary rather than a history replay — and by saying what the UI shows while it fills.",
    progressiveReveals: [
      "Assume 20 million daily users across two million workspaces, and the largest workspace has 150,000 people in one announcements channel.",
      "A client wakes from suspend after two weeks with a stale local cache and an expired connection. Walk me through exactly what it does before it renders anything.",
      "A user says a message from yesterday is missing from their sidebar but their colleague can see it. How do you work out where it was lost?"
    ]
  },
  estimationSpec: {
    intro:
      "Size both sides. Server-side, the fanout and connection count; client-side, how much local cache a channel switch depends on.",
    fields: [
      {
        key: "workspaces",
        label: "Active workspaces",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 1_000,
          max: 10_000_000,
          rationale: "Millions of small workspaces plus a long tail of large ones"
        }
      },
      {
        key: "users_per_workspace",
        label: "Average users per workspace",
        type: "number",
        unitKind: "count",
        hint: "The mean is small; the maximum is not",
        expectedMagnitude: {
          min: 3,
          max: 5_000,
          rationale: "Most workspaces are a single team of a few dozen people"
        }
      },
      {
        key: "messages_per_user_per_day",
        label: "Messages posted / user / day",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 1,
          max: 300,
          rationale: "Work chat is bursty but a few dozen a day is typical"
        }
      },
      {
        key: "members_per_channel",
        label: "Average channel membership",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 2,
          max: 5_000,
          rationale: "Most conversation happens in small channels and DMs"
        }
      },
      {
        key: "online_fraction",
        label: "Fraction of users connected at peak",
        type: "number",
        unitKind: "ratio",
        expectedMagnitude: {
          min: 0.02,
          max: 0.8,
          rationale: "A work tool holds connections for most of the business day"
        }
      },
      {
        key: "message_bytes",
        label: "Stored bytes per message",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        expectedMagnitude: {
          min: 100,
          max: 10_000,
          rationale: "Text plus reactions, threading, and formatting metadata"
        }
      },
      {
        key: "client_cached_messages",
        label: "Messages cached locally per client",
        type: "number",
        unitKind: "count",
        hint: "Across all channels the user has open",
        expectedMagnitude: {
          min: 100,
          max: 500_000,
          rationale: "Enough recent history per channel to render instantly, not everything"
        }
      },
      {
        key: "retention_seconds",
        label: "Server-side message retention",
        type: "number",
        unitKind: "seconds",
        displayUnit: "days",
        displayMultiplier: 86_400,
        expectedMagnitude: {
          min: 2_592_000,
          max: 315_360_000,
          rationale: "Work history is kept for years unless a policy trims it"
        }
      },
      {
        key: "gap_recovery",
        label: "How does a resuming client detect it missed messages?",
        type: "text"
      }
    ],
    derivedHints: [
      "Concurrent connections is the server-side headline. Compare it against how many long-lived connections one node can hold to get your gateway fleet size.",
      "Fanout events per second is messages times channel membership. Notice how much larger it is than the post rate — that gap is what the sync layer must carry.",
      "Client cache size tells you whether local storage is viable. If it comes out in the gigabytes, you are caching too much per channel.",
      "Retained bytes over years is what makes search a separate system rather than a query against the message store."
    ],
    derivedFormulas: [
      {
        id: "total_users",
        label: "Total users",
        expression: "workspaces * users_per_workspace",
        unitKind: "count",
        displayUnit: "users"
      },
      {
        id: "messages_per_sec",
        label: "Messages posted / sec",
        expression: "workspaces * users_per_workspace * messages_per_user_per_day / 86400",
        unitKind: "count",
        displayUnit: "msg/s"
      },
      {
        id: "fanout_events_per_sec",
        label: "Fanout events / sec",
        expression:
          "workspaces * users_per_workspace * messages_per_user_per_day * members_per_channel / 86400",
        unitKind: "count",
        displayUnit: "events/s"
      },
      {
        id: "concurrent_connections",
        label: "Concurrent connections at peak",
        expression: "workspaces * users_per_workspace * online_fraction",
        unitKind: "count",
        displayUnit: "conns"
      },
      {
        id: "client_cache_bytes",
        label: "Local cache per client",
        expression: "client_cached_messages * message_bytes",
        unitKind: "bytes",
        displayUnit: "B"
      },
      {
        id: "retained_bytes",
        label: "Retained message bytes",
        expression:
          "workspaces * users_per_workspace * messages_per_user_per_day * message_bytes * retention_seconds / 86400",
        unitKind: "bytes",
        displayUnit: "B"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Seven phases, deliberately split across client and server. The sync protocol phase is the one that decides this interview.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope both halves. **Interact with:** **Problem** tab — note that the client is explicitly in scope, including its local cache. **Interviewer** tab — ask me about the largest workspace, whether threads are in scope, how far back history must be instantly available, and whether the client is web or native. The last one changes what local storage you can assume."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 420,
        candidateGuide:
          "Size server and client. **Interact with:** **Estimation** tab — fill every field, then read concurrent connections, fanout events/sec, and local cache bytes. **Interviewer** tab — tell me both the server-side and client-side headline numbers, and whether the local cache figure is realistic for a desktop app."
      },
      {
        id: "data_model",
        label: "Data model",
        durationSec: 480,
        candidateGuide:
          "Define the entities. **Interact with:** **Board** — workspaces, channels, memberships, messages, and the per-channel sequence that makes ordering and gap detection possible. Mark your partition key. **Interviewer** tab — walk me through where unread state lives and why it is per user rather than per message."
      },
      {
        id: "sync_protocol",
        label: "Sync protocol",
        durationSec: 780,
        candidateGuide:
          "The decisive phase. **Interact with:** **Board** — the connection, the subscribe step, how live messages are pushed, and the resume handshake: what the client sends, what the server compares it against, and how a gap is filled without replaying everything. **Interviewer** tab — trace a client resuming after two weeks. Be explicit about what renders while the gap is filling. Use **Tutor** for cursor or watermark terminology if needed."
      },
      {
        id: "client_state",
        label: "Client state and rendering",
        durationSec: 600,
        candidateGuide:
          "Design the client half. **Interact with:** **Board** — the local store, how a channel switch reads from it with no network call, how optimistic sends are reconciled with server-assigned ids, and how the message list stays virtualised for a channel with a million messages. **Interviewer** tab — tell me what the user sees when their own message fails to send."
      },
      {
        id: "search_and_isolation",
        label: "Search and isolation",
        durationSec: 540,
        candidateGuide:
          "Go deep on the last two constraints. **Interact with:** **Board** — the search index, how it is kept current, and how membership filtering is applied so a private channel never leaks. Then mark how one huge workspace is isolated from others. **Interviewer** tab — expect follow-ups on whether you filter before or after ranking, and what that costs."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 420,
        candidateGuide:
          "Close it out. **Interact with:** **Board** — mark the client-versus-server split you chose: what state the client owns, what the server owns, and who wins a conflict. **Interviewer** tab — summarise, then answer unprompted: what breaks first in a 500,000-user workspace, and how would you detect that clients were silently missing messages? Then **Validate**, then **End interview**."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "gap_detection_on_resume",
        text: "A resuming client detects whether it missed messages, rather than assuming its cache is current.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A per-channel monotonic sequence the client compares on reconnect",
          "An explicit resume handshake before anything is rendered"
        ],
        discoveryHints: [
          "A laptop wakes after two weeks. How does it know what it missed?",
          "What does the client send the server on reconnect?"
        ],
        progressiveNudges: [
          "The client reconnects. Its cache says the last message is from two weeks ago. Is it current?",
          "How can it tell 'nothing happened' apart from 'I missed 400 messages'?",
          "What monotonic value does it compare against, and who assigns that value?"
        ]
      },
      {
        id: "bounded_catchup",
        text: "Filling a gap is bounded — a summary or ranged fetch — not a replay of full channel history.",
        dimension: "scalability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A gap response that can say 'too much, refetch from here' rather than streaming everything",
          "Per-channel ranged fetch with a cap"
        ],
        discoveryHints: [
          "The gap is 40,000 messages across 200 channels. What do you send?",
          "Is there an upper bound on catch-up size?"
        ],
        progressiveNudges: [
          "Client is two weeks behind across 200 channels. How much data does catch-up transfer?",
          "Is that bounded, or does it grow with how long they were away?",
          "What does the server return when the gap is too large to stream?"
        ]
      },
      {
        id: "optimistic_send_reconciliation",
        text: "A locally sent message renders immediately and is reconciled with the server-assigned id and sequence.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A client-side temporary id replaced or matched on server ack",
          "A defined UI state for a send that failed"
        ],
        discoveryHints: [
          "What does the user see the instant they hit enter?",
          "How does that placeholder become the real message?"
        ],
        progressiveNudges: [
          "The user sends a message. Does it wait for the server before appearing?",
          "If it appears immediately, what identifies it before the server responds?",
          "The send then fails. What does the user see, and can they retry without duplicating?"
        ]
      },
      {
        id: "search_permission_filtering",
        text: "Search results are filtered by channel membership so private channels never leak.",
        dimension: "security",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "Membership applied as a filter on the query, not on the rendered results",
          "A stated position on filtering before versus after ranking"
        ],
        discoveryHints: [
          "Can a search surface a message from a private channel the user is not in?",
          "Where is membership applied in the query path?"
        ],
        progressiveNudges: [
          "A user searches a term that appears in a private channel they cannot see. What comes back?",
          "Is membership checked in the index query, or on the results?",
          "If you filter after ranking, what leaks — and what does filtering before cost you?"
        ]
      },
      {
        id: "instant_channel_switch",
        text: "Switching to an open channel renders from local state with no network call on the critical path.",
        dimension: "latencyPerformance",
        importance: "core",
        satisfiedBy: [
          "A local store holding recent messages per open channel",
          "Network fetches treated as background refresh, not as the render path"
        ]
      },
      {
        id: "connection_and_fanout_math",
        text: "Concurrent connections and fanout events per second are both computed, and the gap between them noted.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Connections derived from users times online fraction",
          "Fanout derived from message rate times channel membership"
        ],
        discoveryHints: [
          "How many connections at peak, and how many events per second?",
          "What multiplies your post rate into delivery volume?"
        ],
        progressiveNudges: [
          "Give me peak concurrent connections.",
          "Now messages per second, then multiply by channel membership.",
          "Why is the second number so much larger, and what has to carry it?"
        ]
      },
      {
        id: "per_channel_sequence_model",
        text: "The data model carries a per-channel monotonic sequence that makes ordering and gaps expressible.",
        dimension: "consistency",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A sequence or cursor column scoped to channel, not global",
          "A partition key chosen so that sequence is cheap to assign"
        ],
        discoveryHints: [
          "What orders messages within a channel?",
          "Is that sequence global or per channel, and why does it matter?"
        ],
        progressiveNudges: [
          "How do you order two messages in the same channel?",
          "Would a global sequence work? What does it cost you at this write rate?",
          "Scope it per channel — what does that imply for your partition key?"
        ]
      },
      {
        id: "unread_state_convergence",
        text: "Unread counts are derived from a per-user read cursor and converge across that user's devices.",
        dimension: "consistency",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A read watermark per user per channel rather than per-message flags",
          "Cursor updates propagated to the user's other devices"
        ],
        discoveryHints: [
          "How is an unread count computed?",
          "A user reads on their phone. When does the laptop badge clear?"
        ],
        progressiveNudges: [
          "Do you store a read flag per message per user?",
          "What does that cost at your message volume? What is cheaper?",
          "With a watermark, how do the user's other devices learn it moved?"
        ]
      },
      {
        id: "workspace_isolation",
        text: "A very large workspace with a busy all-hands channel does not degrade other workspaces.",
        dimension: "reliability",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "Partitioning keyed on workspace or channel",
          "Rate limits or dedicated capacity for outsized workspaces"
        ],
        discoveryHints: [
          "A 150,000-person announcement channel gets a message. Who else is affected?",
          "What is your partition key, and does one workspace fit in one partition?"
        ],
        progressiveNudges: [
          "One workspace has 150,000 people in a single channel. What does one post there cost?",
          "Does that traffic share infrastructure with small workspaces?",
          "What bulkheads them — partitioning, quotas, or dedicated capacity?"
        ]
      },
      {
        id: "client_cache_eviction",
        text: "The client's local cache is bounded with an eviction policy, not allowed to grow without limit.",
        dimension: "cost",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A cap on cached messages per channel or overall",
          "An eviction rule tied to recency of channel use"
        ],
        discoveryHints: [
          "How large can the local store get after a year of use?",
          "What gets evicted first?"
        ],
        progressiveNudges: [
          "The app has been open for a year. How big is the local database?",
          "Is there a cap, or does it grow with usage?",
          "What do you evict, and what happens when the user scrolls into evicted history?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "sync_correctness",
          label: "Sync protocol correctness",
          phaseRefs: ["sync_protocol"],
          criterionRefs: ["gap_detection_on_resume", "bounded_catchup", "per_channel_sequence_model"],
          sampleQuestions: [
            "A desktop client wakes from two weeks of suspend. Walk me through everything before it renders.",
            "The gap turns out to be 40,000 messages across 200 channels. What does the server send?"
          ],
          progressiveNudges: [
            "What does the client send on reconnect?",
            "How does it distinguish 'nothing new' from 'I missed a lot'?",
            "And what bounds the size of the catch-up response?"
          ],
          greenFlags: [
            "Per-channel monotonic sequence compared explicitly on resume",
            "Server can refuse to stream an oversized gap and hand back a restart point"
          ],
          redFlags: [
            "Assumes the websocket buffer covers reconnects",
            "Unbounded history replay on resume"
          ]
        },
        {
          id: "client_architecture",
          label: "Client state and rendering",
          phaseRefs: ["client_state"],
          criterionRefs: [
            "instant_channel_switch",
            "optimistic_send_reconciliation",
            "client_cache_eviction"
          ],
          sampleQuestions: [
            "Switching channels must render in under 100ms with no network call. What makes that possible?",
            "A message the user sent fails to send. What do they see?"
          ],
          progressiveNudges: [
            "Where does the rendered message list come from?",
            "Is the network on that path at all?",
            "Now the optimistic send — what id does the placeholder carry before the server answers?"
          ],
          greenFlags: [
            "Local store is the render source, network is background refresh",
            "Temporary client id reconciled with the server-assigned one"
          ],
          redFlags: [
            "Fetches the channel on every switch",
            "No failed-send state in the UI"
          ]
        },
        {
          id: "state_derivation",
          label: "Unread state and scale",
          phaseRefs: ["data_model", "estimate"],
          criterionRefs: ["unread_state_convergence", "connection_and_fanout_math"],
          sampleQuestions: [
            "How is an unread count computed, and what does it cost per user?",
            "How many fanout events per second, and how does that compare to your post rate?"
          ],
          progressiveNudges: [
            "Do you store per-message read flags?",
            "What does that cost at your volume? What is the cheaper representation?",
            "Now compute fanout and connections, and tell me which one sizes the gateway fleet."
          ],
          greenFlags: [
            "Read watermark per user per channel rather than per-message flags",
            "Notices fanout dwarfs post rate and designs for it"
          ],
          redFlags: [
            "Per-message per-user read rows",
            "Sizes connections from workspace count"
          ]
        },
        {
          id: "search_and_tenancy",
          label: "Search safety and isolation",
          phaseRefs: ["search_and_isolation"],
          criterionRefs: ["search_permission_filtering", "workspace_isolation"],
          sampleQuestions: [
            "A user searches a term that appears only in a private channel they are not in. What comes back?",
            "A 150,000-person workspace is very busy. How are small workspaces protected?"
          ],
          progressiveNudges: [
            "Where in the query path is channel membership applied?",
            "Before or after ranking? What leaks if it is after?",
            "Now isolation: what is your partition key, and does one workspace fit one partition?"
          ],
          greenFlags: [
            "Applies membership inside the index query",
            "Names a bulkhead for outsized workspaces"
          ],
          redFlags: [
            "Filters results after ranking and calls it safe",
            "One shared index with no tenancy dimension"
          ]
        }
      ],
      scoreRubric: {
        "1": "Designs a chat server with a websocket and a message table, with no client cache, no resume protocol, and no notion of a gap.",
        "2": "Has live delivery and some local caching, but resume is best-effort, ordering relies on timestamps, and search ignores permissions.",
        "3": "Uses a per-channel sequence, detects and bounds gaps on resume, renders channel switches from local state, and filters search by membership.",
        "4": "Also reconciles optimistic sends, derives unread state from watermarks that converge across devices, isolates large workspaces, and bounds the client cache."
      }
    }
  }
});
