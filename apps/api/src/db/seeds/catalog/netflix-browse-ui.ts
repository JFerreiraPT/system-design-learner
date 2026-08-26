import { defineSeedProblem } from "../types.js";

export const netflixBrowseUi = defineSeedProblem({
  slug: "netflix-browse-ui",
  title: "Design the Netflix Browse UI (Frontend)",
  difficulty: "medium",
  track: "frontend",
  tags: ["caching", "cdn", "mobile", "api-design"],
  statement: [
    "Design the client-side architecture of a streaming service's browse page: a vertical list of horizontally scrolling rows of cover art, on TVs, phones, and desktop browsers.",
    "",
    "In scope: the component and data architecture, what the client fetches and when, image loading strategy, virtualisation of rows and tiles, keyboard and remote-control navigation, accessibility, and how the UI behaves on a slow or flaky connection.",
    "",
    "Out of scope: the recommendation service (assume an API returns ordered rows of title ids), video playback internals, and authentication.",
    "",
    "The page is enormous relative to what is visible: dozens of rows of dozens of titles each, but only a handful of tiles are on screen at once. Users scroll fast, and cover art is by far the heaviest payload."
  ].join("\n"),
  constraints: [
    "The first row of artwork must be visible in under 1.5 seconds on a mid-range phone on 4G.",
    "Scrolling must stay at 60fps while images are loading — no jank when a row enters the viewport.",
    "Total image bytes downloaded must stay proportional to what the user actually looked at, not to the size of the page.",
    "The UI must be fully operable with a TV remote — directional keys only, no pointer — and must be screen-reader navigable.",
    "On a flaky connection, a failed image or row fetch must degrade gracefully and retry without breaking layout.",
    "Returning to browse from playback must restore the exact scroll position and focused tile."
  ],
  narrative: {
    framingScript:
      "I want to talk about the browse screen — the wall of cover art you see when you open a streaming app. It looks like a simple grid, but we keep shipping versions that either take five seconds to show anything or stutter the moment you scroll. Design the client architecture for it: components, data fetching, images, and navigation. Assume an API hands you ordered rows of title ids. Start wherever you like.",
    signatureChallenge:
      "The user scrolls faster than images load, so in-flight requests for rows that are now offscreen compete with the row the user is actually looking at and starve it. The candidate separates by treating fetches as cancellable and prioritised by viewport proximity, rather than by firing everything and hoping — and by explaining how virtualisation keeps the DOM small without losing scroll position.",
    progressiveReveals: [
      "Say the page now has 60 rows of 75 titles each, and the user flings the scroll from the top to the bottom in one gesture.",
      "The metadata API starts returning errors for one row out of ten. What does the user see, and what does your component tree do?",
      "A user reports the app feels sluggish only after browsing for a few minutes. How would you work out what is degrading?"
    ]
  },
  estimationSpec: {
    intro:
      "The numbers here are about bytes and DOM nodes, not servers. The goal is to show why loading the whole page eagerly is not an option.",
    fields: [
      {
        key: "rows_on_page",
        label: "Rows on the browse page",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 5,
          max: 200,
          rationale: "Dozens of curated rows on a mature product"
        }
      },
      {
        key: "titles_per_row",
        label: "Titles per row",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 10,
          max: 500,
          rationale: "Rows scroll far past the viewport"
        }
      },
      {
        key: "visible_tiles",
        label: "Tiles visible at once",
        type: "number",
        unitKind: "count",
        hint: "Across all rows in the viewport",
        expectedMagnitude: {
          min: 3,
          max: 100,
          rationale: "A phone shows a handful; a desktop shows a few dozen"
        }
      },
      {
        key: "artwork_bytes",
        label: "Bytes per cover image",
        type: "number",
        unitKind: "bytes",
        displayUnit: "KB",
        displayMultiplier: 1024,
        expectedMagnitude: {
          min: 5_000,
          max: 2_000_000,
          rationale: "A compressed cover is tens of kilobytes; an uncompressed hero image is far more"
        }
      },
      {
        key: "metadata_bytes_per_title",
        label: "Metadata bytes per title",
        type: "number",
        unitKind: "bytes",
        displayUnit: "B",
        expectedMagnitude: {
          min: 100,
          max: 20_000,
          rationale: "Title, ids, badges, and artwork URLs"
        }
      },
      {
        key: "concurrent_image_requests",
        label: "Concurrent image requests the client allows",
        type: "number",
        unitKind: "count",
        expectedMagnitude: {
          min: 2,
          max: 60,
          rationale: "Browsers cap per-origin connections; more is not always faster"
        }
      },
      {
        key: "connection_bytes_per_sec",
        label: "Available bandwidth",
        type: "number",
        unitKind: "bytes",
        displayUnit: "KB/s",
        displayMultiplier: 1024,
        expectedMagnitude: {
          min: 50_000,
          max: 10_000_000,
          rationale: "Mid-range 4G is a few hundred kilobytes per second in practice"
        }
      },
      {
        key: "prioritisation_rule",
        label: "How are competing image loads prioritised and cancelled?",
        type: "text"
      }
    ],
    derivedHints: [
      "Compare full-page artwork bytes against visible artwork bytes. The ratio between them is the entire argument for lazy loading and virtualisation.",
      "Divide visible artwork bytes by your bandwidth figure to get time-to-first-meaningful-paint. Check it against the 1.5 second constraint.",
      "Now do the same for the whole page. If eager loading takes minutes, that is your answer about eager loading.",
      "Total tiles tells you how many DOM nodes an unvirtualised implementation would create. Compare it to visible tiles."
    ],
    derivedFormulas: [
      {
        id: "total_tiles",
        label: "Total tiles on the page",
        expression: "rows_on_page * titles_per_row",
        unitKind: "count",
        displayUnit: "tiles"
      },
      {
        id: "full_page_artwork_bytes",
        label: "Artwork bytes if loaded eagerly",
        expression: "rows_on_page * titles_per_row * artwork_bytes",
        unitKind: "bytes",
        displayUnit: "B"
      },
      {
        id: "visible_artwork_bytes",
        label: "Artwork bytes for the first viewport",
        expression: "visible_tiles * artwork_bytes",
        unitKind: "bytes",
        displayUnit: "B"
      },
      {
        id: "first_paint_seconds",
        label: "Time to fill the first viewport",
        expression: "visible_tiles * artwork_bytes / connection_bytes_per_sec",
        unitKind: "seconds",
        displayUnit: "s"
      },
      {
        id: "eager_load_seconds",
        label: "Time to load the whole page eagerly",
        expression:
          "rows_on_page * titles_per_row * artwork_bytes / connection_bytes_per_sec",
        unitKind: "seconds",
        displayUnit: "s"
      },
      {
        id: "metadata_payload_bytes",
        label: "Metadata payload for the full page",
        expression: "rows_on_page * titles_per_row * metadata_bytes_per_title",
        unitKind: "bytes",
        displayUnit: "B"
      }
    ]
  },
  interviewPlan: {
    intro:
      "Six phases, client-side throughout. The board is for component trees and data flow, not servers — draw the client architecture.",
    phases: [
      {
        id: "clarify",
        label: "Clarify",
        durationSec: 300,
        candidateGuide:
          "Scope it. **Interact with:** **Problem** tab — note that TV remote navigation and accessibility are constraints, not nice-to-haves. **Interviewer** tab — ask me about supported platforms, whether the row contents are personalised per request, whether server-side rendering is available, and how fresh the rows must be."
      },
      {
        id: "estimate",
        label: "Estimate",
        durationSec: 360,
        candidateGuide:
          "Quantify the payload problem. **Interact with:** **Estimation** tab — fill every field, then compare first-viewport load time against full-page eager load time. **Interviewer** tab — say both numbers out loud. They are the justification for every decision you make next."
      },
      {
        id: "component_architecture",
        label: "Component and data architecture",
        durationSec: 540,
        candidateGuide:
          "Design the client. **Interact with:** **Board** — the component tree (page, row, tile), where data is cached, and what owns which piece of state: scroll position, focus, fetched rows, image status. **Interviewer** tab — tell me which state is local, which is shared, and why you did not put everything in one global store."
      },
      {
        id: "loading_strategy",
        label: "Loading and virtualisation",
        durationSec: 600,
        candidateGuide:
          "The core phase. **Interact with:** **Board** — how rows and tiles enter and leave the DOM, how image requests are triggered, prioritised, and cancelled, and what placeholder occupies the space before an image arrives. **Interviewer** tab — trace a fast fling from top to bottom and tell me what happens to the requests you already started. Use **Tutor** for terms like intersection observer or LQIP if you want."
      },
      {
        id: "navigation_and_a11y",
        label: "Navigation and accessibility",
        durationSec: 480,
        candidateGuide:
          "Make it operable. **Interact with:** **Board** — the focus model for directional navigation, how focus survives rows being virtualised out, and the semantics a screen reader gets from a horizontally scrolling row. **Interviewer** tab — tell me how returning from playback restores both scroll position and focus, given that the DOM was torn down."
      },
      {
        id: "wrap_up",
        label: "Trade-offs and wrap-up",
        durationSec: 360,
        candidateGuide:
          "Close it out. **Interact with:** **Board** — mark the trade-offs: prefetch aggressiveness against data usage, virtualisation against scroll smoothness, image quality against time to first paint. **Interviewer** tab — summarise, then answer unprompted: what would you change for a low-end TV with 512MB of memory, and what would you measure in the field to know the page is fast? Then **Validate**, then **End interview**."
      }
    ]
  },
  rubric: {
    criteria: [
      {
        id: "request_prioritisation_cancellation",
        text: "Image and metadata requests are prioritised by viewport proximity and cancelled when their row leaves view.",
        dimension: "latencyPerformance",
        importance: "core",
        hiddenFrom: "guided",
        satisfiedBy: [
          "In-flight requests aborted or deprioritised on scroll away",
          "A concurrency limit so the visible row is not starved"
        ],
        discoveryHints: [
          "The user flings the scroll from top to bottom. What happens to requests already started?",
          "What competes with the row the user is actually looking at?"
        ],
        progressiveNudges: [
          "User scrolls fast past twenty rows. How many image requests did you start?",
          "Those rows are offscreen now, but the requests are still in flight. What are they competing with?",
          "How do you cancel or deprioritise them so the visible row wins?"
        ]
      },
      {
        id: "virtualisation_with_focus",
        text: "Rows and tiles are virtualised so the DOM stays small, without losing focus or scroll position.",
        dimension: "scalability",
        importance: "core",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Only near-viewport tiles mounted, with sized placeholders holding layout",
          "Focus preserved when the focused element's row is recycled"
        ],
        discoveryHints: [
          "How many DOM nodes does a page of 60 rows by 75 titles create?",
          "What happens to focus when a row unmounts?"
        ],
        progressiveNudges: [
          "Compute total tiles on the page, then how many are visible.",
          "If you mount all of them, what does that cost in memory and layout?",
          "Now virtualise — but what happens to the focused tile when its row is recycled?"
        ]
      },
      {
        id: "state_restoration",
        text: "Returning from playback restores the exact scroll position and focused tile despite the DOM having been torn down.",
        dimension: "requirements",
        importance: "core",
        hiddenFrom: "staff",
        satisfiedBy: [
          "Scroll offset and focused id persisted outside the component tree",
          "Restoration that does not require the same tiles to still be mounted"
        ],
        discoveryHints: [
          "The user watches something and comes back. Where are they?",
          "Was the row they were on still mounted?"
        ],
        progressiveNudges: [
          "User plays a title and returns to browse. What do they see?",
          "Your virtualised rows unmounted while they were away. How do you get back to the same tile?",
          "Where is that position stored, and is it enough to reconstruct focus as well as scroll?"
        ]
      },
      {
        id: "accessibility_and_remote_nav",
        text: "The page is fully operable with directional keys only and exposes sensible semantics to a screen reader.",
        dimension: "requirements",
        importance: "core",
        satisfiedBy: [
          "A focus model driven by directional input with no pointer dependency",
          "Row and tile semantics that a screen reader can announce and traverse"
        ]
      },
      {
        id: "payload_math",
        text: "First-viewport bytes and full-page bytes are both computed and compared against available bandwidth.",
        dimension: "capacityEstimation",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "Time to fill the first viewport derived from tile count, image size, and bandwidth",
          "The same computation for the whole page, showing eager loading is untenable"
        ],
        discoveryHints: [
          "How long to fill the first screen on 4G?",
          "And how long to load the whole page?"
        ],
        progressiveNudges: [
          "Multiply visible tiles by image size, divide by bandwidth.",
          "Now do it for every tile on the page.",
          "Compare both against the 1.5-second constraint. What does that decide for you?"
        ]
      },
      {
        id: "lazy_image_loading",
        text: "Images load only as their tiles approach the viewport, keeping bytes proportional to what was actually viewed.",
        dimension: "cost",
        importance: "expected",
        hiddenFrom: "guided",
        satisfiedBy: [
          "A viewport-proximity trigger for image loading",
          "A prefetch margin chosen with a stated trade-off"
        ],
        discoveryHints: [
          "When does a tile's image start downloading?",
          "How far ahead do you load?"
        ],
        progressiveNudges: [
          "Are all images requested on page load?",
          "What triggers a load instead?",
          "How much margin ahead of the viewport, and what does a larger margin cost on cellular?"
        ]
      },
      {
        id: "graceful_degradation",
        text: "A failed image or row fetch degrades without breaking layout, and retries without a visible jump.",
        dimension: "reliability",
        importance: "expected",
        hiddenFrom: "standard",
        satisfiedBy: [
          "Reserved dimensions so a missing image does not reflow the page",
          "A bounded retry with a fallback visual"
        ],
        discoveryHints: [
          "One row in ten fails to fetch. What does the user see?",
          "Does the layout move when an image fails?"
        ],
        progressiveNudges: [
          "The metadata call for one row errors. Does the page still render?",
          "Does that row collapse, shifting everything below it?",
          "How do you reserve its space, and how many times do you retry?"
        ]
      },
      {
        id: "perceived_performance",
        text: "Perceived speed is addressed with placeholders or low-quality previews, avoiding layout shift.",
        dimension: "latencyPerformance",
        importance: "stretch",
        hiddenFrom: "hard",
        satisfiedBy: [
          "Skeletons or blurred previews occupying final dimensions",
          "A stated approach to avoiding cumulative layout shift"
        ],
        discoveryHints: [
          "What occupies a tile's space before its image arrives?",
          "Does anything move once it does?"
        ],
        progressiveNudges: [
          "Before an image loads, what is in its place?",
          "When it arrives, does the layout shift?",
          "What would you show instead — a skeleton, a dominant colour, or a tiny blurred preview?"
        ]
      }
    ],
    playbook: {
      areasToProbe: [
        {
          id: "loading_discipline",
          label: "Loading discipline",
          phaseRefs: ["loading_strategy", "estimate"],
          criterionRefs: ["request_prioritisation_cancellation", "lazy_image_loading", "payload_math"],
          sampleQuestions: [
            "The user flings the scroll from top to bottom in one gesture. What happens to the requests you already started?",
            "How long would eager loading the whole page take on 4G?"
          ],
          progressiveNudges: [
            "When does a tile's image start downloading?",
            "After a fast scroll, what are the offscreen requests competing with?",
            "How do you cancel or reprioritise so the visible row wins?"
          ],
          greenFlags: [
            "Treats requests as cancellable and prioritised by viewport distance",
            "Computes both first-viewport and full-page load times"
          ],
          redFlags: [
            "Fires all image requests and relies on the browser queue",
            "No concurrency limit or cancellation story"
          ]
        },
        {
          id: "dom_management",
          label: "Virtualisation and state ownership",
          phaseRefs: ["component_architecture", "loading_strategy"],
          criterionRefs: ["virtualisation_with_focus", "state_restoration"],
          sampleQuestions: [
            "How many tiles exist on the page versus how many are visible? What does mounting all of them cost?",
            "The user returns from playback. How do you restore scroll and focus when the rows unmounted?"
          ],
          progressiveNudges: [
            "Compute total tiles, then visible tiles.",
            "If you virtualise, what happens to the focused element when its row recycles?",
            "Where does scroll and focus state live so it survives unmounting?"
          ],
          greenFlags: [
            "State that must survive unmounting kept outside the component tree",
            "Sized placeholders holding layout for unmounted tiles"
          ],
          redFlags: [
            "Renders every tile",
            "Keeps scroll position only in component state"
          ]
        },
        {
          id: "input_and_a11y",
          label: "Directional navigation and accessibility",
          phaseRefs: ["navigation_and_a11y"],
          criterionRefs: ["accessibility_and_remote_nav"],
          sampleQuestions: [
            "Describe the focus model for a TV remote with only directional keys.",
            "What does a screen reader announce when it reaches a horizontally scrolling row?"
          ],
          progressiveNudges: [
            "How does focus move right past the last rendered tile in a row?",
            "What is announced when entering a row?",
            "Is any of this dependent on a pointer or hover?"
          ],
          greenFlags: [
            "Focus model independent of pointer input",
            "Meaningful row and tile semantics for assistive tech"
          ],
          redFlags: [
            "Relies on hover to reveal information",
            "Treats accessibility as a later pass"
          ]
        },
        {
          id: "resilience",
          label: "Failure and perceived speed",
          phaseRefs: ["navigation_and_a11y", "wrap_up"],
          criterionRefs: ["graceful_degradation", "perceived_performance"],
          sampleQuestions: [
            "One row in ten fails to fetch. What does the user see, and does the layout move?",
            "What occupies a tile before its image arrives?"
          ],
          progressiveNudges: [
            "Does a failed row collapse and shift everything below it?",
            "How do you reserve its space?",
            "And what do you render in a tile before the image lands?"
          ],
          greenFlags: [
            "Reserves dimensions to prevent layout shift",
            "Uses skeletons or low-quality previews deliberately"
          ],
          redFlags: [
            "Failed rows disappear and reflow the page",
            "Blank tiles until images load"
          ]
        }
      ],
      scoreRubric: {
        "1": "Describes a grid of components fetching images with no lazy loading, no virtualisation, and no awareness of payload size.",
        "2": "Lazy-loads images and virtualises rows, but has no request cancellation, no state restoration, and treats accessibility as an afterthought.",
        "3": "Computes payload against bandwidth, prioritises and cancels requests by viewport proximity, virtualises without losing focus, and has a real directional focus model.",
        "4": "Also restores scroll and focus across unmounting, reserves layout to prevent shift, degrades failed fetches gracefully, and reasons about perceived performance."
      }
    }
  }
});
