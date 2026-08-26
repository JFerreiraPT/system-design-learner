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
  }
});
