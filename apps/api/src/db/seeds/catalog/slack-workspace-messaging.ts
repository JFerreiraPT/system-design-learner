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
  }
});
