import { defineSeedProblem } from "../types.js";

export const urlShortener = defineSeedProblem({
  slug: "url-shortener",
  title: "Design a URL Shortener (bit.ly)",
  difficulty: "easy",
  track: "backend",
  tags: ["caching", "sharding", "api-design"],
  statement: [
    "Design a link-shortening service. A user submits a long URL and gets back a short one; anyone who visits the short URL is redirected to the original.",
    "",
    "In scope: creating a short link, redirecting, optional custom aliases, optional expiry, and a click count per link.",
    "",
    "Out of scope: user accounts and billing, detailed analytics dashboards, and link preview generation.",
    "",
    "The workload is very read-heavy: links are created once and then followed many times. A small number of links account for most of the traffic."
  ].join("\n"),
  constraints: [
    "A redirect must complete in under 50ms at p95, measured server-side.",
    "Short codes must be short — 7 characters or fewer — and must not be guessable in sequence.",
    "The same long URL submitted twice by different users may produce different short codes; that is acceptable.",
    "Two simultaneous create requests must never be assigned the same short code.",
    "Click counts may be approximate and lag by up to a minute, but must never decrease.",
    "Redirects must keep working even if the link-creation path is entirely down."
  ],
  narrative: {
    framingScript:
      "We want to build a link shortener. Someone pastes in a long URL, we hand back something short, and when anyone clicks it we send them to the original page. It sounds simple, and mostly it is, but I am interested in how you handle the read volume and how you generate the codes. Start wherever you like and think out loud as you go.",
    signatureChallenge:
      "Two create requests arriving at the same moment must not be handed the same short code, so the candidate has to name a mechanism that makes code assignment unique — a pre-allocated key range, a database uniqueness constraint with retry, or a counter encoded per node — rather than assuming random generation is collision-free.",
    progressiveReveals: [
      "Let's say we are now serving about 100,000 redirects a second, and one link is a quarter of that on its own.",
      "The database holding the code-to-URL mapping becomes unavailable for five minutes. What happens to redirects during that window?",
      "A user says their link sends them to the wrong page. How would you check what that code is actually mapped to and when it changed?"
    ]
  },
  estimationSpec: {
    intro:
      "The point of this exercise is to see how lopsided reads and writes are, and how much of the read volume the cache absorbs.",
    fields: [
      {
        key: "links_created_per_day",
        label: "Links created / day",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10_000,
          max: 100_000_000,
          rationale: "Millions of new links a day at a well-known service"
        }
      },
      {
        key: "redirects_per_day",
        label: "Redirects / day",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 1_000_000,
          max: 10_000_000_000,
          rationale: "Reads outnumber writes by a hundred to one or more"
        }
      },
      {
        key: "stored_bytes_per_link",
        label: "Stored bytes per link",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        hint: "Long URL, short code, owner, timestamps",
        expectedMagnitude: {
          min: 100,
          max: 5_000,
          rationale: "URLs are a few hundred bytes; metadata adds a little"
        }
      },
      {
        key: "cache_hit_ratio",
        label: "Cache hit ratio on redirect",
        type: "number",
        unitKind: "ratio",
        placeholder: "e.g. 0.9",
        expectedMagnitude: {
          min: 0.05,
          max: 0.999,
          rationale: "Traffic is concentrated on a small set of links, so a small cache goes far"
        }
      },
      {
        key: "retention_seconds",
        label: "How long links are kept",
        type: "number",
        unitKind: "seconds",
        displayUnit: "days",
        displayMultiplier: 86_400,
        expectedMagnitude: {
          min: 2_592_000,
          max: 315_360_000,
          rationale: "Links are expected to work for years unless explicitly expired"
        }
      },
      {
        key: "code_uniqueness",
        label: "How is a short code guaranteed unique?",
        type: "text"
      }
    ],
    derivedHints: [
      "Look at the ratio of redirects to creates. That single number is the justification for everything you cache.",
      "Now look at database reads per second after the cache. If it is still large, the answer is a bigger cache or a read replica, not a faster database.",
      "Total storage over the retention window is probably smaller than you expect. Say the number out loud — it tells you whether sharding is actually needed yet."
    ],
    derivedFormulas: [
      {
        id: "creates_per_sec",
        label: "Creates / sec",
        expression: "links_created_per_day / 86400",
        unitKind: "count",
        displayUnit: "writes/s"
      },
      {
        id: "redirects_per_sec",
        label: "Redirects / sec",
        expression: "redirects_per_day / 86400",
        unitKind: "count",
        displayUnit: "reads/s"
      },
      {
        id: "db_reads_per_sec",
        label: "Database reads / sec after cache",
        expression: "redirects_per_day * (1 - cache_hit_ratio) / 86400",
        unitKind: "count",
        displayUnit: "reads/s"
      },
      {
        id: "total_storage_bytes",
        label: "Storage over the retention window",
        expression: "links_created_per_day * stored_bytes_per_link * retention_seconds / 86400",
        unitKind: "bytes",
        displayUnit: "B"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Five phases, kept deliberately light. Get the read path and code generation right; you do not need to invent a distributed database here.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 240,
        candidateGuide:
          "Start by scoping. **Interact with:** **Problem** tab — re-read the statement and constraints. **Interviewer** tab — ask me about custom aliases, expiry, whether the same long URL should always map to the same code, and how accurate click counts need to be. A couple of good questions here is enough."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 300,
        candidateGuide:
          "Get rough magnitudes. **Interact with:** **Estimation** tab — fill in every field, then read the derived rows. The one to notice is the read/write ratio. **Interviewer** tab — tell me the numbers you landed on and whether total storage surprises you."
      },
      {
        id: "api_and_codes",
        label: "API and code generation",
        durationSec: 420,
        candidateGuide:
          "Define the contract and the codes. **Interact with:** **Board** — sketch the create and redirect endpoints, the stored record, and how a short code is produced. **Interviewer** tab — tell me how you guarantee two simultaneous creates cannot collide, and why your codes are not sequentially guessable. Use **Tutor** if you want to check base62 or hashing, then come back."
      },
      {
        id: "read_path",
        label: "Read path",
        durationSec: 480,
        candidateGuide:
          "Make redirects fast and resilient. **Interact with:** **Board** — client, load balancer, redirect service, cache, and the datastore behind it. Draw a cache hit and a cache miss. **Interviewer** tab — explain how redirects keep working while the create path is down, and where click counting happens so it does not slow the redirect."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 300,
        candidateGuide:
          "Close it out. **Interact with:** **Board** — mark one or two decisions you would revisit, such as counting clicks synchronously versus asynchronously. **Interviewer** tab — summarise your design in a few sentences, then tell me unprompted what you would change if traffic grew ten times. Then use **Validate** for a score and **End interview** for the written debrief."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "unique_code_generation",
        text: "Two simultaneous create requests cannot be assigned the same short code, via a named mechanism.",
        dimension: "consistency",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A uniqueness constraint with retry, a pre-allocated key range, or a per-node counter",
          "A stated reason why random generation alone is not sufficient"
        ],
        discoveryHints: [
          "Two people create a link at exactly the same moment. Could they get the same code?",
          "What guarantees a code has not been used before?"
        ],
        progressiveNudges: [
          "Two create requests arrive at the same instant on different servers. What code does each get?",
          "If you generate randomly and check, what happens between the check and the write?",
          "Name the mechanism that makes the code assignment unique — a constraint, a range, or a counter."
        ]
      },
      {
        id: "redirect_availability",
        text: "Redirects keep working when the link-creation path is entirely down.",
        dimension: "reliability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Read and write paths that do not share a single point of failure",
          "Redirects served from cache or replicas independent of the create service"
        ],
        discoveryHints: [
          "The create service is down. Do existing links still work?",
          "What do the read and write paths share?"
        ],
        progressiveNudges: [
          "Your link creation service is completely offline. Can people still follow existing links?",
          "Which components do creating and redirecting have in common?",
          "How would you separate them so a create outage never becomes a redirect outage?"
        ]
      },
      {
        id: "cache_backed_read_path",
        text: "Redirects are served from a cache in front of the datastore to meet the 50ms p95 budget.",
        dimension: "latencyPerformance",
        importance: "core",
        satisfiedBy: [
          "A cache checked before the datastore on the redirect path",
          "A stated hit ratio and what a miss costs"
        ]
      },
      {
        id: "read_write_ratio_math",
        text: "Creates per second and redirects per second are both computed, and the ratio justifies the caching design.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Both rates stated as numbers",
          "Database reads after cache derived from the hit ratio"
        ],
        discoveryHints: [
          "How many redirects per second versus creates per second?",
          "How many of those redirects reach the database?"
        ],
        progressiveNudges: [
          "Roughly how many links are created per day, and how many redirects?",
          "Divide both by 86,400. What is the ratio?",
          "Now apply your cache hit ratio. How many reads actually hit the database?"
        ]
      },
      {
        id: "non_sequential_codes",
        text: "Short codes are not sequentially guessable, so links cannot be enumerated.",
        dimension: "security",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "Randomised or scrambled codes rather than an encoded incrementing id",
          "Recognition that a plain base62 counter is walkable"
        ],
        discoveryHints: [
          "If I have one code, can I guess the next one?",
          "What does your code encode?"
        ],
        progressiveNudges: [
          "Suppose your codes are a counter in base62. What can I do with one code?",
          "Why might enumerating everyone's links be a problem?",
          "How would you keep codes short but not walkable?"
        ]
      },
      {
        id: "async_click_counting",
        text: "Click counting is off the redirect critical path and never decreases.",
        dimension: "operability",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Events buffered, batched, or streamed rather than a synchronous increment",
          "Aggregation that tolerates retries without going backwards"
        ],
        discoveryHints: [
          "Does counting a click slow down the redirect?",
          "What stops a count going backwards?"
        ],
        progressiveNudges: [
          "When someone follows a link, when is the click counted?",
          "If that is a synchronous database write, what does it add to your 50ms budget?",
          "Move it off the path — and then what keeps the count from dipping when the aggregator restarts?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "code_assignment",
          label: "Short code generation",
          phaseRefs: ["api_and_codes"],
          criterionRefs: ["unique_code_generation", "non_sequential_codes"],
          sampleQuestions: [
            "Two create requests arrive at the same instant on different servers. What code does each get, and how do you know they differ?",
            "If I have one of your short codes, can I guess another valid one?"
          ],
          progressiveNudges: [
            "How is a code produced — random, hashed, or counted?",
            "If you generate then check, what happens between the check and the write?",
            "Name the mechanism that makes uniqueness guaranteed rather than likely."
          ],
          greenFlags: [
            "Names a uniqueness constraint with retry, a key range, or a per-node counter",
            "Keeps codes short without making them sequential"
          ],
          redFlags: [
            "Random generation with a read-then-write check and no constraint",
            "Base62 of an auto-increment id with no scrambling"
          ]
        },
        {
          id: "read_path",
          label: "Redirect path",
          phaseRefs: ["read_path", "estimate"],
          criterionRefs: ["cache_backed_read_path", "read_write_ratio_math", "redirect_availability"],
          sampleQuestions: [
            "How many redirects per second versus creates, and how many reach the database?",
            "The create service is completely down. Do existing links still resolve?"
          ],
          progressiveNudges: [
            "Compute both rates and take the ratio.",
            "Apply your cache hit ratio — how many database reads remain?",
            "Now what do the read and write paths share, and can you separate them?"
          ],
          greenFlags: [
            "States the read/write ratio and uses it to justify caching",
            "Separates read and write paths so a create outage does not break redirects"
          ],
          redFlags: [
            "Every redirect queries the primary database",
            "Read and write share one service and one datastore instance"
          ]
        },
        {
          id: "counting",
          label: "Click counting",
          phaseRefs: ["read_path", "wrap_up"],
          criterionRefs: ["async_click_counting"],
          sampleQuestions: [
            "When is a click counted, and does that add to redirect latency?",
            "What stops the count going backwards if your aggregator restarts?"
          ],
          progressiveNudges: [
            "Is counting a synchronous write on the redirect path?",
            "What does that add to your 50ms budget?",
            "Move it off the path — then how do you keep the total monotonic?"
          ],
          greenFlags: [
            "Buffers or batches click events off the critical path",
            "Handles aggregator restarts without dipping the count"
          ],
          redFlags: [
            "Synchronous counter increment inside the redirect",
            "No thought given to double counting on retry"
          ]
        }
      ],
      scoreRubric: {
        "1": "Stores a mapping and looks it up, with no cache, no uniqueness guarantee, and no sense of how lopsided reads and writes are.",
        "2": "Adds a cache and computes rough rates, but code uniqueness relies on generate-and-check and the read path shares fate with creates.",
        "3": "Names a real uniqueness mechanism, computes the read/write ratio, serves redirects from cache, and keeps redirects working when creates are down.",
        "4": "Also keeps codes non-enumerable, moves click counting off the critical path, and keeps that count monotonic across aggregator restarts."
      }
    }
  }
});
