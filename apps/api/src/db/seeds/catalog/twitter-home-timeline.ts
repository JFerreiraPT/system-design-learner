import { defineSeedProblem } from "../types.js";

export const twitterHomeTimeline = defineSeedProblem({
  slug: "twitter-home-timeline",
  title: "Design the X (Twitter) Home Timeline",
  difficulty: "hard",
  track: "backend",
  tags: ["caching", "sharding", "real-time", "messaging"],
  statement: [
    "Design the home timeline for a microblogging service: a reverse-chronological feed of posts from the accounts a user follows, refreshed when they open the app and updated while they are looking at it.",
    "",
    "In scope: posting, the follow graph, timeline construction and delivery, and how new posts reach a session that is already open.",
    "",
    "Out of scope: the ranking model (assume reverse-chronological, or a scoring service you call), search, direct messages, and media transcoding.",
    "",
    "The follow graph is extremely skewed. A typical account has a few hundred followers; the largest accounts have hundreds of millions. Read volume is roughly two orders of magnitude larger than write volume."
  ].join("\n"),
  constraints: [
    "Opening the app must return the first page of timeline in under 200ms at p95, server-side.",
    "A post from an account you follow should appear in your timeline within a few seconds — but a few seconds of delay is acceptable.",
    "Some accounts have over 100 million followers, and posting must not take minutes to complete for them.",
    "The timeline must be correct after an unfollow: within a minute, posts from that account stop appearing.",
    "Deletes must propagate — a deleted post must disappear from already-materialised timelines.",
    "You cannot keep every user's full timeline history in memory; assume the cache holds a bounded window per user.",
    "The system must stay readable when the post-fanout pipeline is backed up; a stale timeline beats an error."
  ],
  narrative: {
    framingScript:
      "You are joining the team that owns the home timeline. It works today, but we just signed a handful of accounts with enormous followings and the posting path has started timing out for them. I want you to design timeline construction and delivery from scratch, and I want the answer to hold for both a user with 300 followers and a user with 300 million. Start wherever you like.",
    signatureChallenge:
      "Push-on-write gives fast reads but a single celebrity post becomes hundreds of millions of writes; pull-on-read is cheap to write but too slow at p95. The separation happens when the candidate proposes a hybrid and can then say precisely where the boundary sits, how a timeline read merges the two paths, and what the ordering looks like at the seam.",
    progressiveReveals: [
      "One of these accounts has 200 million followers and posts eight times an hour. What does your write path do?",
      "The fanout pipeline is backed up by twenty minutes. What does a user opening the app see, and how do they find out it is stale?",
      "A user says a post from someone they follow never showed up. How would you determine whether it was dropped, delayed, or filtered?"
    ]
  },
  estimationSpec: {
    intro:
      "Size read and write paths separately, then compute fanout. The gap between those three numbers is the whole argument for a hybrid design.",
    fields: [
      {
        key: "dau",
        label: "Daily active users",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10_000_000,
          max: 1_000_000_000,
          rationale: "A major social network is in the hundreds of millions of DAU"
        }
      },
      {
        key: "posts_per_user_per_day",
        label: "Posts / active user / day",
        type: "number",
        unitKind: "ratio",
        hint: "Most users read far more than they write",
        expectedMagnitude: {
          min: 0.05,
          max: 5,
          rationale: "The large majority of active users post rarely or never"
        }
      },
      {
        key: "timeline_opens_per_user_per_day",
        label: "Timeline loads / active user / day",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 1,
          max: 100,
          rationale: "Engaged users refresh many times a day"
        }
      },
      {
        key: "avg_followers",
        label: "Average followers per account",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10,
          max: 10_000,
          rationale: "The mean is dragged up by large accounts but stays in the hundreds"
        }
      },
      {
        key: "max_followers",
        label: "Largest follower count",
        type: "number",
        unitKind: "count",
        hint: "This is the number that breaks naive fanout",
        expectedMagnitude: {
          min: 1_000_000,
          max: 500_000_000,
          rationale: "The biggest accounts reach hundreds of millions"
        }
      },
      {
        key: "post_bytes",
        label: "Stored bytes per post (text plus metadata)",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        expectedMagnitude: {
          min: 100,
          max: 10_000,
          rationale: "A few hundred bytes of text plus ids, timestamps, and counters"
        }
      },
      {
        key: "cached_entries_per_user",
        label: "Timeline entries cached per user",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10,
          max: 2_000,
          rationale: "A bounded window — the first few pages, not full history"
        }
      },
      {
        key: "hybrid_boundary",
        label: "Where do you switch from push to pull, and what triggers it?",
        type: "text"
      }
    ],
    derivedHints: [
      "Compare timeline reads/sec to posts/sec. A ratio of 100:1 or more is what justifies paying write-time cost to make reads cheap.",
      "Fanout writes/sec is the number that decides the design. If it is 100x your post rate, ask whether every one of those writes is worth doing.",
      "Now multiply your largest follower count by one post. That single number — not the average — is what makes pure push-on-write unworkable.",
      "Cache footprint assumes an id-only timeline would be far smaller. If your number looks alarming, consider what you actually need to store per entry."
    ],
    derivedFormulas: [
      {
        id: "posts_per_sec",
        label: "Posts / sec",
        expression: "dau * posts_per_user_per_day / 86400",
        unitKind: "count",
        displayUnit: "posts/s"
      },
      {
        id: "timeline_reads_per_sec",
        label: "Timeline reads / sec",
        expression: "dau * timeline_opens_per_user_per_day / 86400",
        unitKind: "count",
        displayUnit: "reads/s"
      },
      {
        id: "fanout_writes_per_sec",
        label: "Fanout writes / sec (pure push)",
        expression: "dau * posts_per_user_per_day * avg_followers / 86400",
        unitKind: "count",
        displayUnit: "writes/s"
      },
      {
        id: "celebrity_fanout",
        label: "Writes for one post by the largest account",
        expression: "max_followers",
        unitKind: "count",
        displayUnit: "writes"
      },
      {
        id: "timeline_cache_bytes",
        label: "Timeline cache footprint",
        expression: "dau * cached_entries_per_user * post_bytes",
        unitKind: "bytes",
        displayUnit: "B"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Six phases. The estimate phase is load-bearing here: the hybrid design is only defensible once you have the fanout numbers in front of you.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope before designing. **Interact with:** **Problem** tab — note that ranking is out of scope, which means ordering is yours to define. **Interviewer** tab — ask me about acceptable staleness, whether the feed is strictly chronological, and how large the biggest accounts really are. That last question matters more than it looks."
        },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 480,
        candidateGuide:
          "Build the case with numbers. **Interact with:** **Estimation** tab — fill every field, then compare posts/sec, reads/sec, and fanout writes/sec. Say the celebrity-fanout number out loud. **Interviewer** tab — tell me what those three numbers together imply before you draw anything."
      },
      {
        id: "api",
        label: "API and data model",
        durationSec: 420,
        candidateGuide:
          "Shape the contract. **Interact with:** **Board** — sketch the post, follow, and timeline-read calls plus the core entities (users, posts, edges, timeline entries). **Interviewer** tab — walk me through pagination: what the cursor is, and why it survives new posts arriving mid-scroll."
      },
      {
        id: "high_level",
        label: "Timeline construction",
        durationSec: 720,
        candidateGuide:
          "Lay out the full system. **Interact with:** **Board** — write path, fanout workers, timeline cache, post store, follow-graph store, and the read path that assembles a page. Draw the push path and the pull path as distinct flows. **Interviewer** tab — narrate the hybrid boundary as you draw it, do not leave it implicit."
      },
      {
        id: "deep_dive",
        label: "Deep dive",
        durationSec: 600,
        candidateGuide:
          "Go deep on the seam. **Interact with:** **Board** — how a read merges materialised entries with pulled-at-read entries, how you order the merge, and what happens on unfollow and delete. **Interviewer** tab — expect several consecutive follow-ups here. If you claim eventual consistency, tell me what the user actually sees during the window."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 420,
        candidateGuide:
          "Stress-test and close. **Interact with:** **Board** — mark what degrades when the fanout pipeline lags, and how a stale timeline is surfaced rather than hidden. **Interviewer** tab — summarise, then answer unprompted: what breaks first at 10x, and what would you change if the feed had to become ranked instead of chronological? Then **Validate** and **End interview**."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "hybrid_fanout_boundary",
        text: "Fanout is hybrid, with an explicit rule for which accounts are pushed on write and which are pulled at read time.",
        dimension: "scalability",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A follower-count threshold or similar rule naming the boundary",
          "Board shows both a materialised path and a read-time merge path"
        ],
        discoveryHints: [
          "What does your write path do for an account with 200 million followers?",
          "Is every timeline built the same way?"
        ],
        progressiveNudges: [
          "Trace one post by an account with 200 million followers through your write path.",
          "If that is 200 million writes, how long does the post call take?",
          "So some accounts cannot be pushed. Where exactly is the line, and what reads the other side?"
        ]
      },
      {
        id: "read_time_merge_ordering",
        text: "A timeline read merges materialised and pulled entries into one correctly ordered page.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A merge step combining the cached timeline with pulled celebrity posts",
          "An ordering key both sources share"
        ],
        discoveryHints: [
          "How does one page contain posts from both paths, in the right order?",
          "What do you sort by across the two sources?"
        ],
        progressiveNudges: [
          "Your reader follows ordinary accounts and a celebrity. What does one page look like?",
          "Those come from two places. Who merges them, and when?",
          "What is the sort key, and does it order consistently across both sources?"
        ]
      },
      {
        id: "pipeline_lag_degradation",
        text: "When fanout is backed up, reads still succeed and staleness is surfaced rather than hidden.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Reads served from whatever is materialised, never blocking on the pipeline",
          "A freshness signal or fallback to read-time assembly"
        ],
        discoveryHints: [
          "What does a user see if fanout is twenty minutes behind?",
          "Does a read ever wait on the write pipeline?"
        ],
        progressiveNudges: [
          "Fanout workers are twenty minutes behind. What does opening the app return?",
          "Is that an error, an empty feed, or a stale feed?",
          "How does the user or your on-call tell stale from quiet?"
        ]
      },
      {
        id: "delete_and_unfollow_propagation",
        text: "Deletes and unfollows take effect in already-materialised timelines within the stated window.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "Read-time filtering against post and edge state, or targeted invalidation",
          "An approach that does not require rewriting millions of timelines"
        ],
        discoveryHints: [
          "You already wrote that post into a million timelines. Now it is deleted.",
          "What happens to materialised entries after an unfollow?"
        ],
        progressiveNudges: [
          "A post is deleted after fanout completed. How does it stop appearing?",
          "Do you go and rewrite every timeline containing it?",
          "If you filter at read time, what does that cost per page — and is it cheaper than the rewrite?"
        ]
      },
      {
        id: "timeline_read_latency",
        text: "The first page is served from precomputed state, not a fan-in query across followed accounts.",
        dimension: "latencyPerformance",
        importance: "core",
        satisfiedBy: [
          "A timeline cache read on the request path",
          "Post content hydrated from a separate store or cache"
        ]
      },
      {
        id: "read_write_asymmetry",
        text: "Read and write rates are computed separately and the ratio justifies paying write-time cost.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Posts/sec and timeline reads/sec both stated as numbers",
          "Fanout writes/sec derived from average follower count"
        ],
        discoveryHints: [
          "How many posts per second versus timeline reads per second?",
          "What does average fanout multiply your write rate by?"
        ],
        progressiveNudges: [
          "Give me posts per second and reads per second.",
          "Now multiply posts by average followers. What is fanout write volume?",
          "Is that ratio what justifies precomputing timelines? Say it explicitly."
        ]
      },
      {
        id: "timeline_cache_bounding",
        text: "The materialised timeline per user is bounded, with defined behaviour for reading past the window.",
        dimension: "cost",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A fixed number of entries retained per user",
          "A fallback path for deep pagination beyond the cached window"
        ],
        discoveryHints: [
          "How many entries do you keep per user?",
          "What happens when someone scrolls past them?"
        ],
        progressiveNudges: [
          "You cannot hold every user's full history. How much do you keep?",
          "What happens on the page after that?",
          "Does it change for an inactive user returning after a month?"
        ]
      },
      {
        id: "timeline_storage_shape",
        text: "Timeline entries store references rather than full post content, hydrated on read.",
        dimension: "scalability",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Post ids in the timeline, content fetched from a post store",
          "A stated reason: one edit should not touch millions of copies"
        ],
        discoveryHints: [
          "What exactly is written into each follower's timeline?",
          "If a post is edited, how many places hold a copy?"
        ],
        progressiveNudges: [
          "Is the post text copied into every follower's timeline?",
          "What does that cost in memory, and what happens on an edit?",
          "If you store ids instead, where does content come from at read time?"
        ]
      },
      {
        id: "follow_graph_partitioning",
        text: "The follow graph is partitioned with a stated key, acknowledging skew from very large accounts.",
        dimension: "scalability",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "A partition key for followers and followees",
          "Recognition that one account's followers cannot fit one partition"
        ],
        discoveryHints: [
          "How do you enumerate 200 million followers of one account?",
          "What is the partition key on the edge store?"
        ],
        progressiveNudges: [
          "Where does the follower list for one account live?",
          "Can that list fit on one node?",
          "If you shard it, how does fanout iterate without hammering one partition?"
        ]
      },
      {
        id: "ranking_readiness",
        text: "The design accommodates a future ranked feed without discarding the timeline architecture.",
        dimension: "operability",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "A candidate-generation then scoring split",
          "A stated insertion point for a scoring service"
        ],
        discoveryHints: [
          "What changes if the feed becomes ranked instead of chronological?",
          "Where would a scoring service plug in?"
        ],
        progressiveNudges: [
          "Suppose product wants ranking next quarter. What survives?",
          "Would your timeline become a candidate set rather than the final order?",
          "What breaks about cursor pagination once order is no longer time?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "fanout_strategy",
          label: "Fanout strategy and the celebrity case",
          phaseRefs: ["estimate", "high_level"],
          criterionRefs: ["hybrid_fanout_boundary", "read_write_asymmetry", "follow_graph_partitioning"],
          sampleQuestions: [
            "Trace a single post by an account with 200 million followers through your write path.",
            "What read-to-write ratio are you designing for, and what does it buy you?"
          ],
          progressiveNudges: [
            "How many writes does one post generate?",
            "Now do it for the largest account. How long does the post call take?",
            "So where is the push/pull line, and what reads the other side?"
          ],
          greenFlags: [
            "Computes celebrity fanout and rejects pure push on that basis",
            "Names a concrete threshold rather than just saying 'hybrid'"
          ],
          redFlags: [
            "Pushes to all followers with no ceiling",
            "Pulls at read time for everyone and ignores the 200ms budget"
          ]
        },
        {
          id: "read_assembly",
          label: "Read path assembly",
          phaseRefs: ["api", "deep_dive"],
          criterionRefs: [
            "read_time_merge_ordering",
            "timeline_read_latency",
            "timeline_storage_shape",
            "timeline_cache_bounding"
          ],
          sampleQuestions: [
            "A reader follows ordinary accounts and one celebrity. Walk me through assembling their first page.",
            "How many entries do you keep per user, and what happens when they scroll past?"
          ],
          progressiveNudges: [
            "Where does the first page come from?",
            "Those entries came from two paths — who merges them, on what key?",
            "Is the post content in the timeline entry, or fetched?"
          ],
          greenFlags: [
            "Stores ids and hydrates content separately",
            "Names the shared sort key used across both fanout paths"
          ],
          redFlags: [
            "Copies full post bodies into every follower timeline",
            "No answer for pagination past the cached window"
          ]
        },
        {
          id: "correctness_after_the_fact",
          label: "Deletes, unfollows, and staleness",
          phaseRefs: ["deep_dive", "wrap_up"],
          criterionRefs: ["delete_and_unfollow_propagation", "pipeline_lag_degradation"],
          sampleQuestions: [
            "A post already fanned out to a million timelines is deleted. How does it stop appearing?",
            "Fanout is twenty minutes behind. What does a user see, and how do you know?"
          ],
          progressiveNudges: [
            "Do you rewrite every timeline that holds it?",
            "If you filter at read time, what does that cost per page?",
            "Now the lag case — is a stale feed better or worse than an error here?"
          ],
          greenFlags: [
            "Filters at read time rather than rewriting millions of rows",
            "Chooses stale-but-served and says how staleness is surfaced"
          ],
          redFlags: [
            "Proposes rewriting all affected timelines synchronously",
            "Blocks the read path on pipeline health"
          ]
        },
        {
          id: "evolution",
          label: "Evolution to ranking",
          phaseRefs: ["wrap_up"],
          criterionRefs: ["ranking_readiness"],
          sampleQuestions: [
            "Product wants a ranked feed next quarter. What in your design survives?",
            "Where would a scoring service attach?"
          ],
          progressiveNudges: [
            "Does your timeline become the final order, or a candidate set?",
            "What happens to cursor pagination when order is not chronological?",
            "What would you store to make ranking reproducible for a given request?"
          ],
          greenFlags: [
            "Separates candidate generation from ordering",
            "Notices cursor semantics break under ranking"
          ],
          redFlags: [
            "Assumes ranking is a drop-in change",
            "Has hardcoded chronological order into every layer"
          ]
        }
      ],
      scoreRubric: {
        "1": "Proposes a single fanout strategy with no awareness of follower skew, and cannot say what one celebrity post costs.",
        "2": "Picks push or pull and precomputes timelines, but has no answer for the largest accounts and no story for deletes or pipeline lag.",
        "3": "Computes fanout volume, adopts a hybrid with a stated boundary, merges both paths in order, and bounds the timeline cache.",
        "4": "Also handles deletes and unfollows without rewriting timelines, surfaces staleness deliberately when fanout lags, and reasons about partition skew on the follow graph."
      }
    }
  }
});
