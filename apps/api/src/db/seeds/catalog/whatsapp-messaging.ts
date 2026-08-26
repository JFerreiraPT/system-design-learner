import { defineSeedProblem } from "../types.js";

export const whatsappMessaging = defineSeedProblem({
  slug: "whatsapp-messaging",
  title: "Design WhatsApp Messaging",
  difficulty: "hard",
  track: "backend",
  tags: ["messaging", "real-time", "consistency", "mobile"],
  statement: [
    "Design a mobile-first chat service. Users exchange one-to-one and group messages, see delivery and read receipts, and use the same account from several devices at once.",
    "",
    "In scope: connection management, message delivery and ordering, offline delivery, receipts, multi-device sync, and group fanout.",
    "",
    "Out of scope: voice and video calls, media transcoding (assume an attachment is an opaque blob id), and end-to-end encryption key exchange — though you should say where encryption sits in your design.",
    "",
    "Clients are phones: they lose connectivity constantly, sit in the background for days, and reconnect on cellular networks with high latency. Assume most messages are small text."
  ].join("\n"),
  constraints: [
    "A message sent while both parties are online must arrive in under 500ms at p95.",
    "Messages within a single conversation must be displayed in the same order by every participant.",
    "A message must never be lost once the sender has seen a single tick, even if the server that accepted it dies immediately after.",
    "A message must never be shown twice, even though the network layer may deliver it more than once.",
    "A device that has been offline for up to 30 days must receive everything it missed, in order, on reconnect.",
    "An account may have up to 4 active devices, and all of them must converge on the same conversation state.",
    "Group messages must work for groups up to 1,000 members without the sender waiting on fanout."
  ],
  narrative: {
    framingScript:
      "We are building a chat app and the hard part has turned out to be phones, not scale. People go through tunnels, their battery dies, they reinstall on a new device and expect three years of history. I would like you to design message delivery end to end — sending, ordering, receipts, and what happens when a device wakes up after a week offline. Take it from wherever feels natural.",
    signatureChallenge:
      "Exactly-once delivery over a mobile network is unachievable, so the design needs at-least-once transport plus client dedup on a sender-assigned id, with a server-assigned per-conversation sequence for ordering. The candidate separates by getting that ordering authority right — not client clocks — and by explaining how a 30-day-offline device catches up without replaying twice.",
    progressiveReveals: [
      "Assume 2 billion accounts and roughly 100 billion messages a day, with four devices per account.",
      "The server that accepted a message crashes after acknowledging it to the sender but before it reached the recipient. What did the sender see, and what happens next?",
      "A user swears a message they received on their phone never appeared on their laptop. How do you work out where it stopped?"
    ]
  },
  estimationSpec: {
    intro:
      "Size the connection fleet and the delivery fanout. Note that device count, not user count, drives both.",
    fields: [
      {
        key: "dau",
        label: "Daily active accounts",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10_000_000,
          max: 3_000_000_000,
          rationale: "The largest messaging apps are in the billions of accounts"
        }
      },
      {
        key: "messages_per_user_per_day",
        label: "Messages sent / active account / day",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 1,
          max: 500,
          rationale: "Chat is high-frequency: tens of messages a day per active user"
        }
      },
      {
        key: "avg_message_bytes",
        label: "Average message size",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        hint: "Text plus envelope, not attachments",
        expectedMagnitude: {
          min: 50,
          max: 5_000,
          rationale: "Text chat is a couple of hundred bytes per message including metadata"
        }
      },
      {
        key: "devices_per_account",
        label: "Active devices / account",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 1,
          max: 10,
          rationale: "A phone plus one or two companions"
        }
      },
      {
        key: "online_fraction",
        label: "Fraction of devices connected at peak",
        type: "number",
        unitKind: "ratio",
        expectedMagnitude: {
          min: 0.01,
          max: 0.6,
          rationale: "Chat apps hold persistent connections for a large share of active devices"
        }
      },
      {
        key: "avg_group_size",
        label: "Average recipients per message",
        type: "number",
        unitKind: "count",
        hint: "One-to-one chats pull this toward 1",
        expectedMagnitude: {
          min: 1,
          max: 50,
          rationale: "Mostly 1:1 with a minority of groups"
        }
      },
      {
        key: "offline_retention_seconds",
        label: "Undelivered message retention",
        type: "number",
        unitKind: "seconds",
        displayUnit: "days",
        displayMultiplier: 86_400,
        expectedMagnitude: {
          min: 86_400,
          max: 7_776_000,
          rationale: "The constraint says 30 days; anything from a day to a few months is defensible"
        }
      },
      {
        key: "dedup_key",
        label: "What identifies a message for deduplication, and who assigns it?",
        type: "text"
      }
    ],
    derivedHints: [
      "Concurrent connections is the number that sizes your edge fleet. Remember it is devices, not accounts — multiply before you conclude.",
      "Delivery events per second is messages times recipients times devices. It will be far larger than your send rate; that gap is the fanout you have to build for.",
      "Compare storage per day against the retention window. If you are storing every message forever server-side, say so deliberately — it is a product decision, not an accident."
    ],
    derivedFormulas: [
      {
        id: "messages_per_sec",
        label: "Messages sent / sec",
        expression: "dau * messages_per_user_per_day / 86400",
        unitKind: "count",
        displayUnit: "msg/s"
      },
      {
        id: "delivery_events_per_sec",
        label: "Delivery events / sec (recipients x devices)",
        expression:
          "dau * messages_per_user_per_day * avg_group_size * devices_per_account / 86400",
        unitKind: "count",
        displayUnit: "events/s"
      },
      {
        id: "concurrent_connections",
        label: "Concurrent connections at peak",
        expression: "dau * devices_per_account * online_fraction",
        unitKind: "count",
        displayUnit: "conns"
      },
      {
        id: "message_bytes_per_day",
        label: "Message bytes stored / day",
        expression: "dau * messages_per_user_per_day * avg_message_bytes",
        unitKind: "bytes",
        displayUnit: "B/day"
      },
      {
        id: "queued_bytes_at_retention",
        label: "Worst-case queued bytes over the retention window",
        expression:
          "dau * messages_per_user_per_day * avg_message_bytes * offline_retention_seconds / 86400",
        unitKind: "bytes",
        displayUnit: "B"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Seven phases. The deep dive belongs to delivery semantics — ordering, dedup, and the offline catch-up path. That is where this problem separates candidates.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope it first. **Interact with:** **Problem** tab — note the four constraints about loss, duplication, ordering, and offline. **Interviewer** tab — ask me about group size limits, history on a new device, and whether receipts are per-device or per-account. That last one changes your data model."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 420,
        candidateGuide:
          "Size connections and fanout. **Interact with:** **Estimation** tab — fill every field, then read concurrent connections and delivery events/sec. **Interviewer** tab — tell me how many connections one edge node can hold and therefore how many nodes you need. That is the number that makes this concrete."
      },
      {
        id: "connection_layer",
        label: "Connection layer",
        durationSec: 480,
        candidateGuide:
          "Design the edge. **Interact with:** **Board** — clients, load balancing for long-lived connections, the gateway fleet, and the registry that knows which device is on which node. **Interviewer** tab — tell me what happens to 50 million connections when one gateway node dies, and how you avoid a reconnect storm."
      },
      {
        id: "delivery_semantics",
        label: "Delivery semantics",
        durationSec: 720,
        candidateGuide:
          "The heart of the problem. **Interact with:** **Board** — the path a message takes from send to acknowledged, including where it is durably persisted before the sender sees a tick. **Interviewer** tab — state your ordering authority and your dedup key explicitly. If you say exactly-once, expect me to push; describe the mechanism instead. Use **Tutor** for terms like idempotency key or Lamport clock if you need them."
      },
      {
        id: "offline_and_multidevice",
        label: "Offline and multi-device",
        durationSec: 600,
        candidateGuide:
          "Handle the hard clients. **Interact with:** **Board** — per-device cursors, the pending queue, and how a device offline for 30 days catches up without re-reading everything. Draw how two devices on the same account converge, including read receipts. **Interviewer** tab — expect follow-ups on what you delete and when."
      },
      {
        id: "group_fanout",
        label: "Group fanout",
        durationSec: 420,
        candidateGuide:
          "Scale the recipients. **Interact with:** **Board** — how a message to a 1,000-member group is fanned out without the sender waiting, and where per-recipient state lives. **Interviewer** tab — tell me whether fanout happens on write or on read here, and why your answer differs from (or matches) what you would do for a social feed."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 360,
        candidateGuide:
          "Close the loop. **Interact with:** **Board** — mark where encryption sits and what it costs you (server-side search, for instance). **Interviewer** tab — summarise, then answer unprompted: what breaks first at 10x, and what would you instrument to detect a delivery regression? Then **Validate**, then **End interview**."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "at_least_once_plus_dedup",
        text: "Transport is at-least-once with client-side deduplication on a sender-assigned message id.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A client-generated message id carried end to end",
          "Recipients discarding an id they have already applied"
        ],
        discoveryHints: [
          "What happens when the network redelivers a message?",
          "Who assigns the id that identifies a message?"
        ],
        progressiveNudges: [
          "Your delivery layer delivers the same message twice. What does the recipient show?",
          "What identifies that message such that the second copy is recognisable?",
          "If the server assigns the id, what happens to a send the client retried before hearing back?"
        ]
      },
      {
        id: "per_conversation_ordering",
        text: "Ordering within a conversation comes from a server-assigned monotonic sequence, not client clocks.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A per-conversation sequence number assigned on accept",
          "Clients ordering by that sequence rather than by timestamp"
        ],
        discoveryHints: [
          "Two participants send at the same instant. Who decides the order?",
          "What do clients sort messages by?"
        ],
        progressiveNudges: [
          "Two people send simultaneously from different continents. What order does each see?",
          "If you sort by client timestamp, what happens when a phone's clock is wrong?",
          "Where is the single point that can assign a monotonic order for this conversation?"
        ]
      },
      {
        id: "durable_before_ack",
        text: "A message is durably persisted before the sender is acknowledged, so a server crash cannot lose it.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Write to a replicated store precedes the ack to the sender",
          "A stated meaning for the first tick tied to that write"
        ],
        discoveryHints: [
          "What exactly does the first tick mean?",
          "What if the accepting server dies right after acknowledging?"
        ],
        progressiveNudges: [
          "The server acks the sender then immediately crashes. Is the message lost?",
          "At what point in your flow does it become safe?",
          "Tie the tick to that point — does the client see a tick before or after durability?"
        ]
      },
      {
        id: "multi_device_convergence",
        text: "All of an account's devices converge on the same conversation state, including read receipts.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "Per-device delivery cursors under one account",
          "Read state propagated to sibling devices, not just to the sender"
        ],
        discoveryHints: [
          "A user reads on their phone. What does their laptop show?",
          "Is delivery tracked per account or per device?"
        ],
        progressiveNudges: [
          "The same account is open on a phone and a laptop. Does each get its own copy?",
          "What state is per-device and what is per-account?",
          "When one device marks a chat read, how do the others learn — and can they disagree?"
        ]
      },
      {
        id: "offline_delivery_queue",
        text: "Messages for an offline device are queued durably for the stated retention and delivered in order on reconnect.",
        dimension: "reliability",
        importance: "core",
        satisfiedBy: [
          "A per-device pending queue or cursor into a durable log",
          "Ordered catch-up on reconnect rather than best-effort replay"
        ]
      },
      {
        id: "connection_fleet_sizing",
        text: "Concurrent connection count is computed from devices, not accounts, and sized against per-node limits.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Connections derived as accounts times devices times online fraction",
          "A per-node connection ceiling used to derive fleet size"
        ],
        discoveryHints: [
          "How many simultaneous connections are you holding?",
          "How many can one node hold?"
        ],
        progressiveNudges: [
          "Roughly how many devices are connected at peak?",
          "Remember it is devices, not users. Redo it.",
          "Divide by what one node can hold. How many gateway nodes is that?"
        ]
      },
      {
        id: "device_routing_registry",
        text: "There is a registry mapping a connected device to the gateway node holding its connection.",
        dimension: "scalability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A session or presence store keyed by device",
          "A routing step that finds the right gateway before pushing"
        ],
        discoveryHints: [
          "How does a message find the node holding the recipient's socket?",
          "Where is that mapping stored?"
        ],
        progressiveNudges: [
          "The recipient is connected to one of a thousand gateway nodes. Which one?",
          "Who knows that, and how fresh is it?",
          "What happens to that mapping when the node dies?"
        ]
      },
      {
        id: "reconnect_storm_control",
        text: "Losing a gateway node does not produce a reconnect storm that takes down the rest of the fleet.",
        dimension: "reliability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Client backoff with jitter on reconnect",
          "Admission control or staggered re-registration at the edge"
        ],
        discoveryHints: [
          "A node holding millions of connections dies. What do those clients do?",
          "Do they all reconnect at once?"
        ],
        progressiveNudges: [
          "One gateway drops fifty million connections. What happens in the next second?",
          "If every client retries immediately, where does that load land?",
          "What on the client and what on the server keeps that from cascading?"
        ]
      },
      {
        id: "group_fanout_async",
        text: "Group fanout happens asynchronously so the sender does not wait on 1,000 per-recipient writes.",
        dimension: "scalability",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "Sender acked after one durable write, fanout done by workers",
          "Per-recipient delivery state written off the send path"
        ],
        discoveryHints: [
          "How long does sending to a 1,000-member group take?",
          "What does the sender wait for?"
        ],
        progressiveNudges: [
          "Send to a 1,000-person group. What is on the sender's critical path?",
          "Is fanout inside that path or after it?",
          "If fanout is async, what has the sender's tick actually promised?"
        ]
      },
      {
        id: "encryption_placement",
        text: "Where encryption sits is stated, along with what it costs the server-side design.",
        dimension: "security",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Ciphertext treated as opaque by the server",
          "A named consequence, such as no server-side search or content moderation"
        ],
        discoveryHints: [
          "Can your servers read message content?",
          "What does that prevent you from building?"
        ],
        progressiveNudges: [
          "Is the message body readable by your infrastructure?",
          "If not, which features you might want become impossible?",
          "How does group membership change interact with per-device keys?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "delivery_guarantees",
          label: "Delivery guarantees",
          phaseRefs: ["delivery_semantics"],
          criterionRefs: [
            "at_least_once_plus_dedup",
            "per_conversation_ordering",
            "durable_before_ack"
          ],
          sampleQuestions: [
            "The server acks the sender then crashes before the recipient gets anything. What happened?",
            "Two participants send at the same instant. Who decides the order, and what do they each see?"
          ],
          progressiveNudges: [
            "What does the first tick promise?",
            "At what point is the message safe against a crash?",
            "Now ordering: server sequence or client clock? Defend it."
          ],
          greenFlags: [
            "Says exactly-once is unachievable and builds at-least-once plus dedup",
            "Assigns ordering server-side per conversation"
          ],
          redFlags: [
            "Claims exactly-once delivery",
            "Orders messages by client timestamp"
          ]
        },
        {
          id: "edge_fleet",
          label: "Connection layer",
          phaseRefs: ["connection_layer", "estimate"],
          criterionRefs: [
            "connection_fleet_sizing",
            "device_routing_registry",
            "reconnect_storm_control"
          ],
          sampleQuestions: [
            "How many concurrent connections at peak, and how many nodes does that need?",
            "A gateway holding fifty million connections dies. Trace the next ten seconds."
          ],
          progressiveNudges: [
            "Is your connection count based on users or devices?",
            "How does a message find the node holding a given socket?",
            "And when that node dies, what stops every client retrying at once?"
          ],
          greenFlags: [
            "Multiplies by devices per account",
            "Names backoff with jitter and a session registry"
          ],
          redFlags: [
            "Sizes connections from user count",
            "Has no registry, or assumes sticky routing is free"
          ]
        },
        {
          id: "offline_and_devices",
          label: "Offline catch-up and multi-device",
          phaseRefs: ["offline_and_multidevice"],
          criterionRefs: ["offline_delivery_queue", "multi_device_convergence"],
          sampleQuestions: [
            "A device has been offline 30 days. Walk me through its reconnect.",
            "A user reads a chat on their phone. What does their laptop show, and when?"
          ],
          progressiveNudges: [
            "What does the device tell the server on reconnect?",
            "Does it replay everything, or resume from a cursor?",
            "Now read state — is that per device or per account, and who reconciles it?"
          ],
          greenFlags: [
            "Per-device cursors into a durable log",
            "Propagates read state to sibling devices explicitly"
          ],
          redFlags: [
            "Full history replay on every reconnect",
            "Treats delivery as per-account and cannot explain laptop state"
          ]
        },
        {
          id: "groups_and_privacy",
          label: "Group fanout and encryption",
          phaseRefs: ["group_fanout", "wrap_up"],
          criterionRefs: ["group_fanout_async", "encryption_placement"],
          sampleQuestions: [
            "Sending to a 1,000-member group — what is on the sender's critical path?",
            "Can your servers read message content, and what does that cost you?"
          ],
          progressiveNudges: [
            "What does the sender wait for before seeing a tick?",
            "Is fanout inside or outside that wait?",
            "And with end-to-end encryption, which server-side features become impossible?"
          ],
          greenFlags: [
            "Acks after one durable write and fans out asynchronously",
            "Names a concrete consequence of encryption, such as no server-side search"
          ],
          redFlags: [
            "Sender blocks on all recipient writes",
            "Mentions encryption without any design consequence"
          ]
        }
      ],
      scoreRubric: {
        "1": "Draws clients talking to a server and a message table, with no delivery guarantee, no ordering authority, and no offline story.",
        "2": "Uses persistent connections and stores messages, but claims exactly-once, orders by timestamp, or has no answer for a long-offline device.",
        "3": "Builds at-least-once plus dedup with a server-assigned per-conversation sequence, persists before acking, and handles offline catch-up with per-device cursors.",
        "4": "Also converges multiple devices including read state, sizes the connection fleet from devices, controls reconnect storms, and states what encryption costs the design."
      }
    }
  }
});
