import type {
  CriterionEvaluation,
  Difficulty,
  ProblemNarrative,
  ProcessAssessment,
  Track,
  TutorUsage,
  FlagObservation,
  InterviewerPlaybook,
  InterviewerLevel,
  InterviewPlan,
  PhaseTimeline,
  RubricCriterion,
  ScoreBand
} from "@sdl/shared";

/** The six slots every difficulty must fill.
 *
 * `beginner` originally got this treatment because it was failing loudly, and
 * the four levels actually used in practice got one sentence each — which is
 * why `medium` and `hard` problems came out looking alike. The generator needs
 * something concrete to differentiate on, and the slot that does most of that
 * work is **Avoid altogether**: each level is defined partly by what belongs to
 * the level above it. */
export const DIFFICULTY_SLOTS = [
  "Tone",
  "Problem choice",
  "Avoid altogether",
  "Expected answer breadth",
  "constraints",
  "tags"
] as const;

const DIFFICULTY_CONTEXT_SNIPPETS: Record<Difficulty, string> = {
  beginner: `Tone: absolute beginner warmup; no prior system design jargon required.
Problem choice: Tiny, familiar domains (todo list, simple blog, contact book, single-page notes, tiny file bucket for thumbnails, classroom attendance, one-office room booking).
Avoid altogether: globe-scale assumptions, geo-distributed deploys, sharding/partition strategies, realtime/presence/streaming motifs, CDN/caching fleets, eventual-consistency dramas, HA across many regions.
Expected answer breadth: Roughly two to four labeled boxes suffice (typically web/mobile client, one API/backend layer, one database, optionally one blob store or trivial cache)—do not implicitly expect microservices fleets.
constraints: Produce 3-4 concise bullets grounded in weekly homework scale (small team or school project), never five-nines SLO wording.
tags: Exactly two strings from the vocabulary below; strongly prefer pairing from {api-design, storage, transactional} when they fit.`,

  easy: `Tone: junior engineer who has shipped a CRUD product but never owned scale; assumes HTTP, a relational database, and a cache exist, nothing more.
Problem choice: A single-region product with clear users and two or three real flows (URL-preview service, team expense tracker, appointment booking for a clinic chain, image thumbnailer, a small job board with search).
Avoid altogether: multi-region, sharding or partitioning strategies, consensus/leader election, event sourcing, CDN fleets, stream processing, exactly-once semantics, compliance regimes. Those are the level above.
Expected answer breadth: Four to six labeled boxes — client, API/service layer, one primary datastore, one cache OR one queue (not both), plus object storage if media is involved. One clear read path and one write path.
constraints: 3-5 bullets at product altitude (who the users are, the must-have flows, one hard product limit such as "single company, up to 5k employees"). At most one number, and it should be a modest one.
tags: 2-3 tags, biased toward {api-design, storage, transactional, caching, search}.`,

  medium: `Tone: mid-level engineer who has operated a service in production; expects to be asked about caching, failure, and a data-model trade-off, and to justify choices rather than list them.
Problem choice: A realistic midsize system where two or three concerns genuinely interact. Calibrated against the reference standard: "an API rate limiter shared across microservices with per-user and per-endpoint limits, burst allowances, and three plan tiers". Similar breadth: notification fan-out with user preferences, a collaborative document's presence and sync, a marketplace search-and-ranking path, a metering/billing pipeline.
Avoid altogether: active-active multi-region, custom consensus protocols, regulatory/compliance regimes (GDPR/HIPAA/PCI narratives), exotic or purpose-built storage engines. Those are the level above.
Expected answer breadth: Six to nine labeled boxes — client, gateway or LB, two or three services with distinct responsibilities, a primary store plus one specialised store (cache, search index, or queue), and at least one asynchronous path. The candidate should be able to name where state lives and what happens when one component is slow.
constraints: 4-6 bullets that pin down the interacting concerns, including one concrete scale figure and one behavioural requirement that creates real tension (e.g. "limits must hold across all service instances", "preferences apply within a minute of being changed").
tags: 3-4 tags; the combination should reflect the interacting concerns rather than one theme (e.g. {rate-limiting, caching, consistency}).`,

  hard: `Tone: senior engineer expected to drive; the interviewer supplies facts, not structure. Assumes fluency in partial failure, coordination cost, and operational blast radius.
Problem choice: Take a medium-shaped system and add the concern that makes it genuinely hard — a decision with no safe default. Calibrated against the reference standard: the same shared rate limiter, but "~100 microservices and millions of API calls per minute", where the Redis cluster can be lost and the candidate must choose fail-open or fail-closed and defend it. Similar shape: ordered event delivery with a slow consumer, a cache whose invalidation is correctness-critical, a write path that must survive a datastore failover.
Avoid altogether: compliance-driven narratives unless the domain genuinely implies them (payments, health records), and research-grade novelty — the problem must be answerable by a strong senior engineer in half an hour, not require a paper.
Expected answer breadth: Eight to twelve labeled boxes, and more importantly TWO areas the candidate can go deep on: one about state (partitioning, replication, ordering, or consistency boundary) and one about failure (what degrades, what it degrades to, and how you find out). Expect explicit trade-off statements, not a component list.
constraints: 5-7 bullets. Include the sharp one — the constraint that removes the easy answer (a hard latency budget, a correctness guarantee under partition, a dependency that is allowed to disappear). State it plainly and do not soften it.
tags: 3-5 tags, at least one from {consistency, replication, sharding, leader-election, streaming} to reflect where the difficulty actually lives.`,

  expert: `Tone: principal-level. The candidate is expected to define the problem, not just solve it: choose which requirement to sacrifice, and say what they would need to know before committing.
Problem choice: Genuine principal-level ambiguity — a system where two legitimate architectures lead to different products, and the right call depends on a judgement the statement deliberately leaves open. Multi-region mission-critical narratives and compliance-shaped domains are fair game here. Examples: a global ledger where regional data residency conflicts with a single ordering guarantee; a control plane that must keep working while its own configuration store is being migrated; a multi-tenant platform where one tenant's traffic pattern threatens everyone else's SLO.
Avoid altogether: nothing is excluded by subject. The one thing to avoid is FAKE difficulty — a medium problem with bigger numbers. Difficulty here must come from irreducible tension between requirements, not from scale inflation.
Expected answer breadth: Ten to fifteen labeled boxes, plus an explicit statement of what is deliberately NOT built and why. Expect three deep areas, at least one of which is organisational or operational (migration path, blast radius, rollback, cost per tenant) rather than purely architectural.
constraints: 5-8 bullets, including at least two that are in genuine tension with each other. Do not resolve the tension in the statement — that is the exercise.
tags: 3-5 tags spanning at least two families (e.g. {geo-distributed, consistency, compliance, cost-optimization}).`
};

function difficultyContextBlock(difficulty: Difficulty): string {
  return `Difficulty guidance for ${difficulty}:\n${DIFFICULTY_CONTEXT_SNIPPETS[difficulty]}`;
}

/** The four slots every track must fill. Structured like
 * `DIFFICULTY_SLOTS` so the two axes are directly comparable. */
export const TRACK_SLOTS = [
  "Domain examples",
  "What the design is about",
  "Component vocabulary",
  "Avoid"
] as const;

/**
 * Per-track generation guidance.
 *
 * `tags` already exist, but they are an OUTPUT used for grouping and dedup —
 * they never steer the archetype, which is why generation drifts toward
 * generic backend-ish problems and a frontend practitioner cannot practise the
 * design work they actually do.
 *
 * Composes with difficulty rather than replacing it: **difficulty owns
 * breadth, track owns subject**. The `Component vocabulary` slot does the
 * heaviest lifting — it is what stops a frontend problem being answered with
 * three microservices and a Postgres.
 */
const TRACK_CONTEXT_SNIPPETS: Record<Track, string> = {
  backend: `Domain examples: a distributed rate limiter shared across services, notification fan-out with per-user preferences, a distributed cache with an invalidation contract, an idempotent payment intake, a job scheduler with at-least-once delivery.
What the design is about: shared mutable state across processes; delivery and ordering guarantees; where the source of truth lives; what happens to in-flight work when a node dies; consistent hashing and rebalancing.
Component vocabulary: services, API gateways, queues and topics, primary datastores, replicas, caches, schedulers, workers, coordination stores. Data paths and their guarantees are the substance of the answer.
Avoid: browser rendering, component state management, and CSS/a11y concerns (frontend); pipeline and deployment topology (devops); model serving and prompt/eval design (ai-engineering).`,

  frontend: `Domain examples: a collaborative rich-text or spreadsheet editor, a design-system component library consumed by many teams, a typeahead search box over a large catalogue, a realtime dashboard with thousands of updating cells, an offline-capable mobile web client.
What the design is about: conflict resolution when two clients edit the same thing (CRDT vs OT vs last-write-wins, and what that means for the user); the render/state boundary and what re-renders; network chattiness — debouncing, batching, optimistic updates and rollback; connection lifecycle (reconnect, resume, backfill); accessibility and keyboard semantics as design constraints, not polish.
Component vocabulary: client stores and caches, normalised local state, service workers, IndexedDB / local persistence, sync channels (WebSocket / SSE / long-poll), a BFF or API layer, CDN-served assets, virtualised lists, render boundaries. A frontend design has stores, workers, caches and sync channels — NOT three microservices and a Postgres.
Avoid: database sharding and replication topology, consensus, queue delivery semantics (backend); CI/CD and deployment topology (devops); model training or serving (ai-engineering).`,

  fullstack: `Domain examples: an end-to-end e-commerce checkout, a multi-tenant SaaS dashboard with per-tenant configuration, a booking product where availability must look live, a content platform with drafts, preview and publish.
What the design is about: the SEAM between the UX and the data — what the client is allowed to assume, what must be confirmed server-side, and what the user sees while the two disagree. Optimistic UI versus authoritative state; where validation lives (and why it lives in both places); the shape of the API as a product decision; per-tenant configuration reaching the client.
Component vocabulary: client stores, a BFF or API layer, domain services, a primary datastore, a cache, background jobs for anything the user should not wait on, plus the explicit contract between client and server.
Avoid: deep single-tier rabbit holes — a fullstack answer that never crosses the seam is a backend or frontend answer wearing a different label. Also avoid pipeline topology (devops) and model serving (ai-engineering).`,

  devops: `Domain examples: a CI/CD pipeline for a few dozen services with independent deploys, monitoring and alerting for a system nobody fully understands, a secrets and configuration distribution story, a multi-environment infrastructure promotion path, a disaster-recovery plan with a stated RTO.
What the design is about: pipeline topology and what can run in parallel; deployment strategy and its blast radius (rolling, blue-green, canary — and how you decide to stop); rollback as a first-class path rather than an afterthought; signal quality across the three pillars (metrics, logs, traces) and alert fatigue as a real failure mode; who gets paged and on what evidence.
Component vocabulary: source triggers, build and test stages, artifact registries, environments, deployment controllers, feature flags, metric and log pipelines, trace collectors, alert routing and on-call rotations, runbooks.
Avoid: application-level data modelling and API design (backend/fullstack); UI concerns (frontend); model architecture (ai-engineering).`,

  "ai-engineering": `Domain examples: a retrieval-augmented answering service over a private corpus, an LLM-backed classification pipeline with a human review loop, a multi-step agent with tool access and a cost ceiling, an evaluation harness that decides whether a new prompt or model ships.
What the design is about: what happens when the model is wrong — detection, fallback, and the human in the loop; retrieval quality and freshness (chunking, embedding refresh, index staleness); evaluation as infrastructure, not a spreadsheet; cost and latency per request as hard design constraints; prompt and model versioning, and how you roll one back.
Component vocabulary: ingestion and chunking jobs, embedding stores and vector indexes, retrievers and rerankers, an inference gateway with routing and fallback, prompt/version registries, caches keyed on semantic identity, eval datasets and offline scoring jobs, feedback capture.
Avoid: training-from-scratch narratives and model architecture research (this is engineering AROUND models, not building them); UI-only concerns (frontend); pipeline/deployment topology as the main subject (devops).`
};

export function trackContextBlock(track: Track): string {
  return [
    `Track guidance for ${track}:`,
    TRACK_CONTEXT_SNIPPETS[track],
    "Where difficulty guidance and track guidance appear to conflict: difficulty wins on BREADTH (how many components, how sharp the trade-offs), track wins on SUBJECT (what the design is about and what belongs on the board)."
  ].join("\n");
}

export const TAG_VOCABULARY_SNIPPET = `
Pick 2-5 tags from this vocabulary only (exact lowercase spelling):
caching, geo-distributed, real-time, search, transactional, streaming, rate-limiting,
messaging, storage, consistency, replication, sharding, observability, security,
cost-optimization, mobile, api-design, data-pipeline, batch, leader-election, cdn,
event-sourcing, multi-tenant, compliance`;

/** Field-level rules for estimation checklists.
 *
 * Shared verbatim by problem generation and the standalone estimation-spec
 * backfill so the two paths cannot drift — a spec produced by one must be
 * calibratable by exactly the same code as a spec produced by the other. */
export const ESTIMATION_FIELD_RULES = [
  "  - key: lowercase_snake_case, unique, only letters/digits/underscore, starting with a letter",
  '  - type: "number" for quantities/ratios/size OR "text" for qualitative assumptions',
  "  - Tailor labels to the problem (e.g. messages/sec for chat, daily orders for e-commerce; or simple counts for beginner)",
  "  - EVERY number field MUST also carry `unitKind` and `expectedMagnitude`. Text fields MUST carry NEITHER.",
  '  - unitKind: one of "count" | "bytes" | "seconds" | "ratio" | "currency".',
  '  - displayUnit (optional): the unit shown to the candidate, e.g. "KB", "ms", "req/s".',
  "  - displayMultiplier (optional): what to multiply a displayed value by to reach the BASE unit of the family (bytes / seconds / plain count). KB -> 1024, MB -> 1048576, ms -> 0.001. Omit when the display unit IS the base unit.",
  "  - expectedMagnitude: { min, max, rationale } giving the order-of-magnitude band a sensible answer falls in, expressed in BASE units.",
  "      * `max` MUST be at least 10x `min`. This is an order-of-magnitude check, not an arithmetic check — a tight band is wrong.",
  "      * Anchor the band to THIS problem's stated scale and difficulty, never to generic web-scale defaults.",
  "      * rationale: one short clause justifying the band (\"~1KB per message is typical for text chat\"). It is shown only after the candidate answers out of range, so it must not give the number away."
].join("\n");

/** Spec-level rules for the quantitative derived checks.
 *
 * Formulas are evaluated by a hand-written parser (no `eval`), so the grammar
 * is deliberately tiny and stated explicitly — anything outside it is dropped
 * at generation time. */
export const ESTIMATION_DERIVED_FORMULA_RULES = [
  "- derivedFormulas: 2-4 quantitative checks computed from the fields above. Each:",
  "  - id: lowercase_snake_case, unique",
  '  - label: short UI title, e.g. "Peak RPS"',
  '  - expression: arithmetic over the field KEYS above. ONLY these are allowed: field keys, numeric literals, `+`, `-`, `*`, `/`, parentheses, and a leading minus. NO functions, NO exponents, NO `%`, NO uppercase names, NO units inside the expression.',
  "  - Every identifier MUST be the `key` of a NUMBER field you emitted. Referencing a text field or a key that does not exist makes the formula unusable and it will be discarded.",
  "  - Work in BASE units throughout (bytes, seconds, plain counts) — the same units `expectedMagnitude` uses. Convert with literals where needed, e.g. per-day to per-second is `/ 86400`.",
  '  - unitKind: the family of the RESULT. displayUnit (optional): how to label it, e.g. "req/s", "GB".'
].join("\n");

/** Rules for the interviewer-facing narrative layer.
 *
 * Shared verbatim by problem generation and the narrative backfill, so a
 * backfilled problem is held to the same bar as a generated one. */
export const PROBLEM_NARRATIVE_RULES = [
  '- framingScript: the paragraph you would SAY to open the interview. Second person, conversational, 3-5 sentences. Set the scene, name the system, and end by handing control over ("start wherever makes sense to you"). This is spoken framing, NOT a restatement of the statement — if it reads like a spec, rewrite it.',
  '- signatureChallenge: the ONE thing that makes this problem hard — the place a strong candidate visibly separates from a mediocre one. One or two sentences, and it MUST name a concrete mechanism: a race, a partial failure, an ordering guarantee, a hot key, a consistency boundary, a fail-open/fail-closed call. "Must be scalable", "needs good architecture" and "handle lots of users" are NOT signature challenges — they name no mechanism and could be pasted onto any problem. It must also be REACHABLE at this difficulty: a beginner problem\'s signature challenge is something like "two people editing the same row at once", never sharding.',
  "- progressiveReveals: exactly THREE interviewer lines, always in this order and usable verbatim as spoken sentences:",
  '    [0] a SCALE nudge ("let\'s say this now serves ~100 services and millions of calls a minute")',
  '    [1] a FAILURE-MODE nudge ("how would this change if the store you rely on went down?")',
  '    [2] a DEBUG / OPERATIONAL nudge ("a user says they are being limited but shouldn\'t be — how do you find out why?")',
  "    Each must be specific to THIS system, and each must be answerable without having already been given the answer."
].join("\n");

export const buildProblemPrompt = (
  difficulty: Difficulty,
  topic?: string,
  existingProblems?: Array<{ title: string; tags: string[]; gist: string }>,
  /** Optional role archetype. Omitted leaves the prompt byte-identical to the
   * pre-track version. */
  track?: Track
) => {
  const phaseBudgetNote =
    difficulty === "beginner"
      ? "Typical TOTAL interview stays light — sum durationSec roughly 540-1260 seconds (~9-21 minutes) across three forgiving phases."
      : "Harder problems → longer deep-dive; beginner/easy stay concise. Typical range per phase: 180-1200 seconds unless the problem demands otherwise. Sum tends ~30-55 minutes for medium; shrink or stretch for easier/harder levels.";

  const estimationFieldsLine =
    difficulty === "beginner"
      ? "  - fields: exactly 3 items for beginner difficulty, each { key, label, type, unitKind, expectedMagnitude, optional placeholder, hint, displayUnit, displayMultiplier } with everyday labels (expected users, items per user, average item size, or qualitative notes)."
      : "  - fields: 3-10 items, each { key, label, type, unitKind, expectedMagnitude, optional placeholder, hint, displayUnit, displayMultiplier }";

  const derivedHintsLine =
    difficulty === "beginner"
      ? "  - derivedHints: exactly 3 very short sanity-check strings grounded in those three fields."
      : "  - derivedHints: 3-6 short strings suggesting sanity checks (order-of-magnitude) from the fields";

  const phasesBullet =
    difficulty === "beginner"
      ? " exactly three phases covering clarify → estimation → sketch in plain words; keep each candidateGuide succinct."
      : " 3-8 items in recommended interview order.";

  const topicLine =
    topic ?
      `Topic hint: ${topic}`
    : difficulty === "beginner" ?
      "Topic hint: pick a wholesome tiny system aligned with the beginner guidance above."
    : "Topic hint: pick any realistic, modern system that fits the chosen difficulty. Vary it from common defaults (avoid URL shorteners and pastebins unless explicitly relevant).";

  const existingBlock =
    existingProblems && existingProblems.length > 0
      ? [
          "",
          `Avoid near-duplicates of these existing problems already generated at difficulty="${difficulty}" (adjacent topics or small twists are OK; do NOT repeat the same title, tag combo, or gist-level scope):`,
          ...existingProblems.map(
            (p) =>
              `- "${p.title}" :: tags=[${p.tags.join(", ")}] :: ${p.gist || "(no gist)"}`
          ),
          ""
        ].join("\n")
      : "";

  const trackBlock = track ? `Track: ${track}\n${trackContextBlock(track)}\n` : "";
  const trackPlanLine = track
    ? `\n  - Shape the phases around the ${track} track: replace phases that do not fit with ones that do (a frontend interview wants a component/state-model phase, a devops interview a pipeline-topology phase, an ai-engineering interview a retrieval-and-evaluation phase).`
    : "";

  return `
Generate one system design interview problem.
Difficulty: ${difficulty}
${difficultyContextBlock(difficulty)}
${trackBlock}${topicLine}
${existingBlock}
${TAG_VOCABULARY_SNIPPET}

Difficulty is expressed through the NUMBER OF INTERACTING CONCERNS and the SHARPNESS OF THE TRADE-OFFS, never through inflating the user count. A hard problem is not a medium problem with more zeros: if you can raise a problem's difficulty by editing one number in the statement, it was not really harder. Adding a requirement that removes the easy answer is what raises difficulty.

Return:
- title
- statement (clear and concise)
- constraints (array): the VISIBLE seed bullets the candidate reads on the Problem rail at the start of the interview. Keep these to the broad "what we're building" facts (target users, must-have features, hard product constraints). Do NOT list implementation-detail expectations here — those belong to the per-interview rubric, generated separately.
- tags (array of 2-5 strings from the vocabulary above — for beginner use exactly two tags following the beginner tag rule)
- estimationSpec: object with:
  - intro (optional): one short sentence on what to estimate for THIS system
${estimationFieldsLine}
${ESTIMATION_FIELD_RULES}
${derivedHintsLine}
${ESTIMATION_DERIVED_FORMULA_RULES}
${PROBLEM_NARRATIVE_RULES}
- interviewPlan: object for this problem only:
  - intro (optional): one sentence on how YOU structured the flow for THIS prompt (e.g. data-heavy vs API-heavy)
  - phases:${phasesBullet} Each:
    - id: lowercase_snake_case (stable slug)
    - label: short UI title (2-4 words)
    - durationSec: suggested timer budget (integer seconds). ${phaseBudgetNote}
    - candidateGuide: 2-5 sentences in markdown-lite. Say what the candidate should accomplish in THIS phase and exactly which parts of the app to use: **Problem**, **Interviewer**, **Tutor**, **Estimation**, **Board**, **Validate**, **phase bar** (Start / Next phase / Reset). Omit or merge phases that do not fit the problem (e.g. skip a dedicated API phase for offline batch systems; replace with "ingest & storage contracts" or similar).
  - The LAST phase MUST be a short closing phase (3-5 minutes) in which the CANDIDATE does the summarising: restate the design, say what they would change at 10x scale, and name what they would tackle next. Give it whatever id and label fits the problem (\`wrap_up\`, \`closing\`, \`review\`). Without it the interview has no ending and the candidate never has to defend their own design as a whole.${trackPlanLine}
`;
};

/** Backfill prompt for the narrative layer on a problem that predates it.
 *
 * Shares its rules with `buildProblemPrompt` verbatim (see
 * `PROBLEM_NARRATIVE_RULES`) so a backfilled problem is indistinguishable from
 * a freshly generated one — two divergent sets of rules here would produce two
 * classes of problem. */
export function buildProblemNarrativePrompt(input: {
  title: string;
  statement: string;
  difficulty: Difficulty;
  constraints: string[];
}): string {
  return [
    "You add the interviewer-facing narrative layer to an existing system design problem.",
    "Do NOT rewrite the statement or the constraints — they are fixed. Work from what is already there.",
    `Difficulty: ${input.difficulty}`,
    difficultyContextBlock(input.difficulty),
    `Title: ${input.title}`,
    "Statement:",
    input.statement,
    "",
    "Constraints:",
    input.constraints.length > 0 ? input.constraints.map((c) => `- ${c}`).join("\n") : "(none)",
    "",
    "Return JSON with:",
    PROBLEM_NARRATIVE_RULES
  ].join("\n");
}

export function getCriteriaHiddenMin(difficulty: Difficulty): number {
  return CRITERIA_BUDGET_BY_DIFFICULTY[difficulty].hiddenMin;
}

/** Rubric size budget per difficulty.
 *
 * Exported so hand-authored (seeded) rubrics can be validated against exactly
 * the same budget the generator is instructed to respect — otherwise a curated
 * rubric could be looser than a generated one and nothing would catch it. */
export const CRITERIA_BUDGET_BY_DIFFICULTY: Record<
  Difficulty,
  {
    total: [number, number];
    coreMax: number;
    hiddenMin: number;
    hiddenCoreMax: number;
    stretchMax: number;
  }
> = {
  beginner: { total: [4, 6], coreMax: 2, hiddenMin: 1, hiddenCoreMax: 1, stretchMax: 1 },
  easy: { total: [5, 8], coreMax: 3, hiddenMin: 2, hiddenCoreMax: 2, stretchMax: 1 },
  medium: { total: [6, 10], coreMax: 4, hiddenMin: 3, hiddenCoreMax: 3, stretchMax: 2 },
  hard: { total: [7, 12], coreMax: 5, hiddenMin: 4, hiddenCoreMax: 4, stretchMax: 2 },
  expert: { total: [8, 14], coreMax: 6, hiddenMin: 5, hiddenCoreMax: 5, stretchMax: 3 }
};

/** Per-level guidance MUST set firm minimums (no "0-1" wording). The
 * candidate-facing UX depends on at least some hidden objectives existing
 * for them to discover; an empty hidden set defeats the discovery loop. */
const LEVEL_HIDDEN_GUIDANCE: Record<InterviewerLevel, string> = {
  guided:
    "Guided level: forgiving rubric. Bias toward `visibility: visible` for most criteria, but you MUST include at least the difficulty's hiddenMin floor of `hidden` criteria so the discovery loop has something to surface. Hidden cores are allowed at this level (up to hiddenCoreMax) when the difficulty supports it.",
  standard:
    "Standard level: a balanced split. About a third of criteria are hidden (never below the difficulty's hiddenMin floor). At most one of those may be `core`.",
  hard:
    "Hard level: most non-trivial expectations are hidden. About half of `core` items should be hidden, and total hiddens stay above the difficulty's hiddenMin floor.",
  staff:
    "Staff level: aggressive hiding. Treat seed constraints as a thin starting point — the bulk of `core` criteria should be hidden, including failure-mode and operational concerns. Hidden count must stay above the difficulty's hiddenMin floor."
};

/** Generates a tight, structured rubric for a single interview session.
 *
 * Why per-interview (not per-problem): each session can probe a different
 * angle — the same problem grades differently for `guided` vs `staff`, and
 * we want the hidden vs visible split to scale to the level the candidate
 * picked. Keeping criteria on the interview row also lets us regenerate them
 * cheaply if the candidate restarts the session.
 *
 * The output drives THREE downstream behaviors:
 *   1. The interviewer prompt (per-level coaching toward undiscovered hiddens).
 *   2. The validator (importance-weighted scoring + discovery score).
 *   3. The Problem rail discovery indicator (X / Y expectations explored).
 */
/** Whether an interview plan contains an estimation-style phase.
 *
 * Plans are model-generated per problem, so phase ids vary ("estimate",
 * "capacity_math", "sizing"). Matching on a small vocabulary is deliberately
 * loose — a false positive costs one extra rubric criterion, a false negative
 * silently drops estimation from grading. */
export function hasEstimationPhase(
  phases: Array<{ id: string; label: string }>
): boolean {
  const vocabulary = ["estimat", "capacit", "sizing", "back-of", "back of", "napkin", "scale math"];
  return phases.some((phase) => {
    const haystack = `${phase.id} ${phase.label}`.toLowerCase();
    return vocabulary.some((word) => haystack.includes(word));
  });
}

export function buildCriteriaPrompt(input: {
  difficulty: Difficulty;
  interviewerLevel: InterviewerLevel;
  title: string;
  statement: string;
  seedConstraints: string[];
  phases: Array<{ id: string; label: string }>;
  existingCriteria?: Array<{
    id: string;
    text: string;
    visibility?: "visible" | "hidden";
    importance?: "core" | "expected" | "stretch";
  }>;
  /** The problem's signature difficulty, when it has one. This is the single
   * mechanism that stops rubrics drifting into generic best-practice lists. */
  signatureChallenge?: string;
  /** Role archetype. Keeps criteria on the right concerns — a frontend
   * problem must not be graded on sharding. */
  track?: Track;
  regenerationReason?: string;
}): string {
  const budget = CRITERIA_BUDGET_BY_DIFFICULTY[input.difficulty];
  const regenerationBlock = input.regenerationReason
    ? [
        "REGENERATION REQUIRED — your previous attempt was rejected:",
        input.regenerationReason,
        "Fix the issue and emit a fresh, fully-compliant rubric.",
        ""
      ].join("\n")
    : "";
  const hiddenGuidance = LEVEL_HIDDEN_GUIDANCE[input.interviewerLevel];
  const seedBlock =
    input.seedConstraints.length > 0
      ? input.seedConstraints.map((c) => `- ${c}`).join("\n")
      : "(none)";
  const phaseBlock =
    input.phases.length > 0
      ? input.phases.map((p) => `- ${p.id}: ${p.label}`).join("\n")
      : "- clarify: Clarify\n- estimate: Estimate\n- high_level: High-level\n- deep_dive: Deep dive";
  const existingCriteriaBlock =
    input.existingCriteria && input.existingCriteria.length > 0
      ? [
          "",
          "Criteria already used in past sessions on this exact problem (prefer fresh angles; similar emphasis on a different facet is OK — avoid copying the same wording or id themes). The (visibility, importance) tag tells you what category each was; bias your divergence ESPECIALLY on hidden ones, since repeating a hidden objective the candidate has already had a chance to discover is the worst kind of duplicate:",
          ...input.existingCriteria.map((c) => {
            const tag =
              c.visibility || c.importance
                ? ` [${c.visibility ?? "?"}, ${c.importance ?? "?"}]`
                : "";
            return `- ${c.id}${tag} :: ${c.text}`;
          }),
          ""
        ].join("\n")
      : "";
  const signatureBlock = input.signatureChallenge?.trim()
    ? [
        "",
        "THIS PROBLEM'S SIGNATURE CHALLENGE (interviewer-private — never restate it to the candidate):",
        input.signatureChallenge.trim(),
        '- At least ONE criterion with importance="core" MUST cover this. It is the place a strong candidate separates from a mediocre one, so a rubric that does not grade it is grading the wrong problem.',
        "- Its `satisfiedBy` bullets must name what addressing the mechanism looks like on the board or in the notes, not merely that it was mentioned.",
        "- Prefer visibility=\"hidden\" for it unless a seed constraint already spells the mechanism out."
      ].join("\n")
    : "";
  const trackBlock = input.track
    ? [
        "",
        trackContextBlock(input.track),
        `- Criteria must target ${input.track} concerns. Do NOT require expertise that belongs to a different track — the "Avoid" list above says which those are.`
      ].join("\n")
    : "";
  const capacityRule = hasEstimationPhase(input.phases)
    ? [
        "",
        "ESTIMATION IS IN SCOPE for this problem (the interview plan has an estimation phase):",
        '- At least ONE criterion MUST target dimension "capacityEstimation".',
        "- Its `satisfiedBy` bullets must name the actual estimation field keys or quantities the candidate is asked for, so the validator can check the numbers rather than the vibe.",
        "- Grade the estimate as a REASONING artefact: are the magnitudes plausible, and does the design match the numbers the candidate committed to? Never require an exact figure."
      ].join("\n")
    : "";

  return [
    regenerationBlock,
    "You design grading rubrics for system-design mock interviews.",
    "Produce a structured rubric of evaluation criteria for THIS interview.",
    "",
    `Difficulty: ${input.difficulty}`,
    `Interviewer level: ${input.interviewerLevel}`,
    `Title: ${input.title}`,
    "Statement:",
    input.statement,
    "",
    "Seed constraints already shown to the candidate on the Problem rail:",
    seedBlock,
    "",
    "Interview phases available for playbook phaseRefs:",
    phaseBlock,
    existingCriteriaBlock,
    trackBlock,
    signatureBlock,
    "",
    "Rubric shape:",
    `- Total criteria: ${budget.total[0]}-${budget.total[1]}.`,
    `- At LEAST ${budget.hiddenMin} criteria MUST have visibility="hidden" (this is the discovery floor — without it the candidate has nothing to surface).`,
    `- At most ${budget.coreMax} of them may be importance="core". Of those cores, at most ${budget.hiddenCoreMax} may be visibility="hidden".`,
    `- At most ${budget.stretchMax} criteria may be importance="stretch" (bonus only).`,
    "- The remaining criteria should be importance=\"expected\" (should appear at this difficulty).",
    capacityRule,
    "- Every criterion targets exactly ONE dimension from: requirements, scalability, reliability, consistency, latencyPerformance, cost, security, operability, capacityEstimation.",
    "",
    "AXIS DISTINCTION (do NOT confuse these — they are independent fields):",
    "- `importance` is HOW MUCH IT MATTERS. Allowed values: \"core\", \"expected\", \"stretch\". NEVER \"hidden\", NEVER \"critical\", NEVER \"required\", NEVER \"bonus\".",
    "- `visibility` is WHETHER THE CANDIDATE SEES IT UPFRONT. Allowed values: \"visible\", \"hidden\". NEVER \"core\", NEVER \"expected\".",
    "- These ARE NOT exclusive. A criterion has BOTH an importance AND a visibility. Examples of valid combinations:",
    "    importance=\"core\",     visibility=\"visible\"  → required and shown on the Problem rail",
    "    importance=\"core\",     visibility=\"hidden\"   → required and the candidate must DISCOVER it",
    "    importance=\"expected\", visibility=\"hidden\"   → moderate, must be discovered",
    "    importance=\"stretch\",  visibility=\"visible\"  → nice-to-have, shown",
    "  Mixing them up (e.g. importance=\"hidden\") will fail validation and the rubric will be rejected.",
    "",
    "Visibility split:",
    `- ${hiddenGuidance}`,
    "- A `visible` criterion should overlap a seed constraint above (e.g. seed says 'support up to 100 users' → visible criterion in `requirements` for that user scope). The candidate already sees the bullet so they don't need to ASK about it; we still grade whether their design addresses it.",
    "- A `hidden` criterion is a latent expectation not on the Problem rail. The candidate must DISCOVER it by asking the interviewer about it, by committing to it on the board, or by explicitly stating an assumption. If they never surface it, they take a discovery penalty AND an addressed/covered penalty if the design also misses it.",
    "",
    "Quality bars (REJECT yourself and start over if any of these are violated):",
    `- The rubric MUST contain at least ${budget.hiddenMin} criteria with visibility="hidden". Zero hidden criteria is NEVER acceptable.`,
    "- Each criterion `text` is one specific, verifiable expectation (\"Per-user task isolation in the data model\", NOT \"good data model\").",
    "- Hidden criteria must be discoverable through reasonable clarifying questions a candidate at this difficulty could plausibly think to ask. Do not hide things that require knowing the answer in advance.",
    "- Match the difficulty's surface area. Do NOT introduce multi-region, sharding, or compliance criteria for beginner/easy unless the statement explicitly invites them.",
    "- Avoid pure best-practice platitudes (\"have monitoring\") unless the system genuinely depends on them at this scale.",
    "",
    "For each criterion, return:",
    "- id: short snake_case slug, unique within the rubric (e.g. `per_user_isolation`).",
    "- text: 1 sentence describing the expectation.",
    "- dimension: one of the eight strings above.",
    "- importance: 'core' | 'expected' | 'stretch'.",
    "- visibility: 'visible' | 'hidden'.",
    "- discoveryHints: 1-3 short clarifying-question phrasings the interviewer could use to nudge the candidate toward this. Required when visibility='hidden'; optional otherwise.",
    "- progressiveNudges (optional): exactly 3 short nudges ordered easy -> medium -> sharp. They should help the interviewer escalate without revealing the answer immediately.",
    "- satisfiedBy: 1-3 short bullets describing what would visibly satisfy the criterion in the diagram or notes (e.g. 'user_id foreign key on tasks', 'per-user index'). Used by the validator.",
    "- scaleNote (optional): difficulty/scale anchor (e.g. 'beginner: <100 users'). Use only when scale is the point of the criterion.",
    "",
    "Interviewer playbook shape:",
    "- Return `playbook` alongside `criteria`. It is PRIVATE to the AI interviewer and must read like a real interviewer guide for only the System Design section.",
    "- The playbook should help the interviewer be consistent and useful. For each area, include what a good candidate should DO next (ask, estimate, draw, or compare), not only what the interviewer can ask.",
    "- For beginner/easy interviews, sampleQuestions and progressiveNudges should be plain-language and should teach the expected design move after answering. Avoid terse one-word probes.",
    "- areasToProbe: 3-8 areas. Each area:",
    "    id: short snake_case slug.",
    "    label: concise title, e.g. 'Auth & Tenant Isolation'.",
    "    phaseRefs: 1-4 ids from the phase list above. Do not invent phase ids.",
    "    criterionRefs: 1-6 ids from the criteria you emitted. Do not reference missing ids.",
    "    sampleQuestions: 2-4 ready-to-use interviewer questions. Prefer questions that naturally include context, e.g. 'Given v1 has personal tasks only, how would you model task ownership?'",
    "    progressiveNudges: exactly 3 prompts ordered gentle -> direct -> sharp. These are used only when the candidate needs nudges; include the next expected action without giving away a full solution.",
    "    greenFlags: concrete observable signals, not generic praise.",
    "    redFlags: concrete observable risks or misses.",
    "- scoreRubric: strings for keys \"1\", \"2\", \"3\", \"4\" using the same meanings as a senior system design interview: 1 does not meet bar, 2 below expectations, 3 meets bar, 4 exceeds bar.",
    "",
    "Return strict JSON with top-level keys: { criteria, playbook }."
  ].join("\n");
}

/** Prompt for the per-turn discovery matcher. Runs on a small structured
 * model (gpt-4o-mini) after each interview exchange to detect which
 * undiscovered hidden criteria were just surfaced. Conservative on purpose
 * — false positives create constraint pills the candidate didn't really
 * earn; false negatives are caught later by validation's full-transcript
 * re-evaluation. */
export function buildDiscoveryMatchPrompt(input: {
  problemTitle: string;
  problemStatement: string;
  undiscovered: Array<Pick<RubricCriterion, "id" | "text" | "discoveryHints">>;
  lastUserMessage: string;
  lastAssistantMessage: string;
}): string {
  const undiscoveredBlock = input.undiscovered
    .map((c) => {
      const hints = c.discoveryHints && c.discoveryHints.length > 0
        ? ` :: hints=${c.discoveryHints.join(" | ")}`
        : "";
      return `- id=${c.id} :: ${c.text}${hints}`;
    })
    .join("\n");
  return [
    "You watch a system-design interview and detect which undiscovered hidden expectations were surfaced in the latest exchange.",
    "Be CONSERVATIVE — empty `discoveries` is the right answer most of the time.",
    "",
    "Mark a criterion as discovered ONLY when the latest user OR assistant turn explicitly addressed the criterion's topic — not just used a related word in passing.",
    "- The candidate asks about it ('do users share tasks?' → discovers per_user_isolation if that is in the list).",
    "- The interviewer commits the v1 product decision that maps to it ('yes, single-user, no sharing in v1').",
    "- The candidate states an assumption that maps to it ('I'll assume tasks are private per user').",
    "",
    "Pick `kind`:",
    "- 'candidate' if the latest user turn surfaced it (asking or asserting).",
    "- 'interviewer' if the latest assistant turn was the one that committed.",
    "",
    "DO NOT mark as discovered:",
    "- Generic vocabulary mentions without the actual question/decision.",
    "- Criteria not in the undiscovered list below.",
    "- Anything that was only implied two messages ago.",
    "",
    `Problem: ${input.problemTitle}`,
    `Statement: ${input.problemStatement}`,
    "",
    "Undiscovered hidden criteria:",
    undiscoveredBlock,
    "",
    "Latest candidate turn:",
    input.lastUserMessage,
    "",
    "Latest interviewer turn:",
    input.lastAssistantMessage,
    "",
    "Return JSON: { discoveries: Array<{ id, kind: 'candidate' | 'interviewer', rationale }> }",
    "Rationale: one short phrase quoting/paraphrasing the line that triggered the match."
  ].join("\n");
}

/** Validation prompt for the structured grader.
 *
 * Two big shifts vs the old free-text-rubric prompt:
 *   1. Criteria are tiered: core gaps cost real points, expected gaps cost
 *      moderate points, stretch is bonus-only.
 *   2. Dimensions with no active criterion or constraint must return `null`,
 *      not a fake middling 60. The UI hides null bars instead of showing
 *      misleading scores. */
export function buildValidationPrompt(
  difficulty: Difficulty,
  estimationBlock: string,
  scope: {
    constraints: string[];
    criteria?: RubricCriterion[];
    /** Free-text legacy rubric for problems that predate criteria. */
    legacyRubric?: string[];
    /** Full interviewer ↔ candidate chat for this attempt (when present). */
    interviewTranscript?: string;
    /** Interview playbook, when this attempt belongs to an interview that has
     * one. Supplies the green/red flags for the observation pass. */
    playbook?: InterviewerPlaybook;
    /** Interviewer level in play. Needed to calibrate `drove`: at `guided` the
     * interviewer is SUPPOSED to lead, so `interviewer_led` is not a negative
     * there. Only used alongside a transcript. */
    interviewerLevel?: InterviewerLevel;
  }
): string {
  const constraintsBlock =
    scope.constraints.length > 0
      ? "Active constraints (live scope shown to the candidate):\n" +
        scope.constraints.map((c) => `- ${c}`).join("\n")
      : "Active constraints: (none specified — grade against the difficulty defaults).";

  const criteria = scope.criteria ?? [];
  const visibleCriteria = criteria.filter((c) => c.visibility === "visible");
  const hiddenCriteria = criteria.filter((c) => c.visibility === "hidden");
  const undiscoveredHidden = hiddenCriteria.filter((c) => !c.discoveredVia);

  const formatCriterion = (c: RubricCriterion) => {
    const satisfied =
      c.satisfiedBy && c.satisfiedBy.length > 0
        ? `\n    satisfiedBy: ${c.satisfiedBy.join(" | ")}`
        : "";
    const scale = c.scaleNote ? `\n    scaleNote: ${c.scaleNote}` : "";
    return `  - id=${c.id} (${c.dimension}, ${c.importance}, ${c.visibility})\n    text: ${c.text}${satisfied}${scale}`;
  };

  const groupByImportance = (set: RubricCriterion[]) => {
    const core = set.filter((c) => c.importance === "core").map(formatCriterion).join("\n");
    const expected = set
      .filter((c) => c.importance === "expected")
      .map(formatCriterion)
      .join("\n");
    const stretch = set.filter((c) => c.importance === "stretch").map(formatCriterion).join("\n");
    return [
      core ? `Core (high penalty if missing):\n${core}` : "",
      expected ? `Expected (moderate penalty if missing):\n${expected}` : "",
      stretch ? `Stretch (bonus only — never penalize for missing these):\n${stretch}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  };

  const dimensionsInScope = new Set<string>();
  for (const c of criteria) dimensionsInScope.add(c.dimension);
  const allDims = [
    "requirements",
    "scalability",
    "reliability",
    "consistency",
    "latencyPerformance",
    "cost",
    "security",
    "operability",
    "capacityEstimation"
  ];
  const outOfScopeDims = allDims.filter((d) => !dimensionsInScope.has(d));

  const criteriaBlock =
    criteria.length > 0
      ? [
          "Per-interview rubric criteria (THIS is the scope to grade against):",
          groupByImportance(criteria),
          "",
          undiscoveredHidden.length > 0
            ? "Hidden criteria the candidate FAILED to surface in the conversation are listed below. Judge whether the design still addresses them (`covered`). Discovery credit for hiddens is computed **on the server** from each criterion's `discoveredVia` field (whether the interview surfaced that expectation) — do not invent numeric discovery scores.\n" +
              undiscoveredHidden.map(formatCriterion).join("\n")
            : "All hidden criteria were surfaced in the conversation (per `discoveredVia`). Discovery scoring is computed on the server.",
          "",
          visibleCriteria.length > 0
            ? "Visible criteria are pre-marked as `discovered` in rubric data since the candidate saw them on the Problem rail; still judge `covered` from the diagram/notes."
            : "",
          outOfScopeDims.length > 0
            ? `Out-of-scope dimensions for this rubric: ${outOfScopeDims.join(", ")}. Set these to null in the dimensions object — DO NOT invent a score and DO NOT generate gaps for them.`
            : ""
        ]
          .filter(Boolean)
          .join("\n")
      : scope.legacyRubric && scope.legacyRubric.length > 0
        ? "Legacy free-text rubric (no structured criteria available — use as a soft guide):\n" +
          scope.legacyRubric.map((r) => `- ${r}`).join("\n")
        : "";

  const transcriptBlock =
    scope.interviewTranscript?.trim().length ?
      [
        "Interview transcript (chronological — candidate ↔ interviewer):",
        "Treat this as binding scope context alongside the diagram and notes: interviewer commitments, candidate assumptions stated aloud, and agreed trade-offs count even when not drawn.",
        "",
        scope.interviewTranscript.trim(),
        ""
      ].join("\n")
    : "";

  const flagsBlock = formatFlagsForObservation(scope.playbook);
  const processBlock = formatProcessAssessmentBlock(
    scope.interviewTranscript,
    scope.interviewerLevel
  );

  return [
    "You are a senior system design reviewer.",
    `Evaluate the candidate whiteboard solution for ${difficulty} level.`,
    "",
    constraintsBlock,
    criteriaBlock,
    estimationBlock,
    transcriptBlock,
    flagsBlock,
    processBlock,
    "",
    "Scoring rules:",
    "- **Do not compute numeric scores.** The server derives `score`, `designScore`, `discoveryScore`, `coreCovered`, and `coreMissed` deterministically from your per-criterion judgments.",
    "- For EACH criterion, decide:",
    "    covered: did the diagram, notes, estimation, **or interview transcript** actually address it? Use satisfiedBy as guidance — verbal commitments in chat can satisfy scope when they are specific.",
    "    discovered: did the candidate surface it in dialogue? For `visible` criteria this must be true. For `hidden`, use true only when the rubric already marks it discovered (`discoveredVia` set) OR the candidate clearly committed to it in the interview transcript, on the board, or in notes — align with how interview discovery is recorded.",
    "    severity: 'high' for missing core, 'medium' for missing expected, 'low' for missing stretch. Only set when covered=false.",
    "- Dimensions object: for each axis, score 0-100 based on how the design fared on the criteria targeting that axis. If no criterion targets a dimension AND no active constraint hints at it, return null for that dimension — DO NOT guess and DO NOT generate gaps for them.",
    "- gaps: each gap MUST cite a criterion id in parentheses (e.g. \"(per_user_isolation) Tasks table has no user_id foreign key\"). For legacy rubric mode, cite the constraint or rubric bullet text.",
    "- strengths and nextSteps: short bullets; specific to the diagram.",
    "",
    "Return strict JSON with:",
    "- dimensions: object with the 8 dimension keys; each value is integer 0-100 OR null",
    "- dimensionNotes (optional): map from dimension key to one-line rationale",
    "- criteriaEvaluations: array of { criterionId, covered, discovered, severity?, evidence? } — **exactly one entry per rubric criterion id**, omit only when no structured criteria were provided (legacy rubric mode)",
    "- strengths (array of strings)",
    "- gaps (array of strings, each citing a criterion id or constraint phrase in parens)",
    "- nextSteps (array of strings)",
    ...(flagsBlock
      ? [
          "- flagObservations: array of { areaId, kind, index, text, fired, evidence? } — one entry per flag listed in the OBSERVABLE FLAGS block, echoing its exact areaId / kind / index"
        ]
      : []),
    ...(processBlock
      ? [
          "- processAssessment: object with { clarifiedBeforeDesigning, decisiveness, surfacedOwnLimitations, adaptedWhenChallenged, drove, observations } exactly as specified in the PROCESS ASSESSMENT block"
        ]
      : [])
  ].join("\n");
}

/** Per-level calibration for `drove`. Without this the assessment would punish
 * a guided candidate for being guided, which is the interviewer's job at that
 * level, not the candidate's failing. */
const DROVE_CALIBRATION_BY_LEVEL: Record<InterviewerLevel, string> = {
  guided:
    'At GUIDED the interviewer is supposed to lead — answering decisively and volunteering the next question. `interviewer_led` is therefore NEUTRAL here, not a negative, and `candidate_led` is exceptional.',
  standard:
    "At STANDARD a good session reads as `balanced`: the interviewer answers and asks one follow-up, the candidate carries the design forward between turns.",
  hard:
    "At HARD the interviewer deliberately withholds structure, so `interviewer_led` is a real finding — it means the candidate needed structure that was not being offered.",
  staff:
    "At STAFF driving the conversation is the expectation, not a bonus. Anything short of `candidate_led` is the headline observation about this attempt."
};

/**
 * Process-assessment block for the validator.
 *
 * Emitted ONLY when a transcript exists. A bare board validation has no
 * process to assess, and inventing one from an empty transcript is strictly
 * worse than omitting the field — it would manufacture a behavioural verdict
 * out of a diagram.
 */
function formatProcessAssessmentBlock(
  transcript?: string,
  interviewerLevel?: InterviewerLevel
): string {
  if (!transcript?.trim()) return "";

  return [
    "",
    "PROCESS ASSESSMENT — judge HOW the candidate worked, from the TRANSCRIPT ONLY:",
    "- The diagram is scored elsewhere. A beautiful diagram is not evidence of good process, and a messy one is not evidence of bad process. If the transcript does not show it, you did not observe it.",
    "- This assessment is REPORTED to the candidate, never scored. Do not let it influence your dimension scores or criterion judgments, and do not let those influence it.",
    "- clarifiedBeforeDesigning: 'yes' | 'partially' | 'no' — did scope questions come before design commitments, in that order in the transcript?",
    "- decisiveness: 'decides_and_justifies' | 'lists_without_choosing' | 'avoids_committing'. Listing alternatives and moving on without picking one is `lists_without_choosing`, even when the alternatives are correct.",
    "- surfacedOwnLimitations: true only if the candidate named a weakness of THEIR OWN design without being asked. Answering a question about a weakness does not count.",
    "- adaptedWhenChallenged: 'yes' | 'partially' | 'not_tested' | 'no'. Use `not_tested` when the interviewer never actually challenged an assumption — that is the correct answer, not a hedge. NEVER infer rigidity from silence.",
    "- drove: 'candidate_led' | 'balanced' | 'interviewer_led' — who set the agenda across the session as a whole.",
    interviewerLevel
      ? `  ${DROVE_CALIBRATION_BY_LEVEL[interviewerLevel]}`
      : "  No interviewer level was supplied; judge `drove` descriptively and do not treat `interviewer_led` as a fault.",
    "- observations: 1-4 items of { signal, evidence }. `evidence` MUST quote or closely paraphrase a specific line from the transcript. An observation you cannot point at is a guess — drop it.",
    ""
  ].join("\n");
}

/** Formats the playbook's green/red flags into an addressable checklist for
 * the validator.
 *
 * Flags are the interview-kit's core evaluation instrument — concrete
 * observable behaviours rather than qualities. We ask the model only to say
 * which fired and why; the score is untouched, so a false positive costs the
 * candidate nothing but a misleading bullet. Returns "" when there is no
 * playbook, which keeps the prompt byte-identical for legacy interviews. */
function formatFlagsForObservation(playbook?: InterviewerPlaybook): string {
  if (!playbook || playbook.areasToProbe.length === 0) return "";

  const lines: string[] = [];
  for (const area of playbook.areasToProbe) {
    lines.push(`  Area ${area.id} (${area.label}):`);
    area.greenFlags.forEach((flag, index) => {
      lines.push(`    - areaId=${area.id} kind=green index=${index} :: ${flag}`);
    });
    area.redFlags.forEach((flag, index) => {
      lines.push(`    - areaId=${area.id} kind=red index=${index} :: ${flag}`);
    });
  }

  return [
    "OBSERVABLE FLAGS — judge which of these fired during this attempt:",
    "- Mark `fired: true` ONLY on direct evidence in the diagram, the notes, or the transcript. Quote or closely paraphrase that evidence.",
    "- Green and red flags are INDEPENDENT observations, not two ends of one axis. An unfired green flag is not a red flag, and an unfired red flag is not a green one.",
    "- Do NOT infer a red flag purely from absence, unless the flag is itself phrased as an absence (e.g. \"Never mentions monitoring\").",
    "- Be conservative: `fired: false` is the right answer whenever the evidence is thin.",
    "- Echo `areaId`, `kind` and `index` exactly as given. Do not invent flags that are not listed here.",
    "- These observations are REPORTED to the candidate, not scored. Do not let them influence your dimension scores or criterion judgments.",
    "",
    ...lines,
    ""
  ].join("\n");
}

/**
 * Reference answer prompt.
 *
 * The interview-scoped form exists to fix a real contradiction: the candidate
 * is penalised for missing `per_user_isolation`, then unlocks a "here is what
 * good looks like" answer that never mentions isolation. A reference built
 * without the rubric it is being compared against actively undermines the
 * score. When `criteria` are supplied the answer must address them, and must
 * say HOW — that mapping is the part the UI pairs with each missed criterion.
 *
 * Without `criteria` / `signatureChallenge` the prompt is byte-identical to the
 * pre-rubric version, so the cached per-problem references stay valid.
 */
export function buildReferenceSolutionPrompt(input: {
  title: string;
  statement: string;
  difficulty: Difficulty;
  constraints: string[];
  /** Full rubric for one interview (visible AND hidden). When present the
   * reference is graded against the same scope the candidate was. */
  criteria?: RubricCriterion[];
  signatureChallenge?: string;
}): string {
  const constraintsBlock = input.constraints.map((c) => "- " + c).join("\n");
  const criteria = input.criteria ?? [];

  const criteriaBlock =
    criteria.length > 0
      ? [
          "",
          "THE RUBRIC THIS ATTEMPT WAS GRADED AGAINST. Your answer is the candidate's model of what 'good' means here, so it must not contradict the grade:",
          ...criteria.map((c) => {
            const satisfied =
              c.satisfiedBy && c.satisfiedBy.length > 0
                ? ` :: satisfiedBy: ${c.satisfiedBy.join(" | ")}`
                : "";
            return `- id=${c.id} (${c.importance}, ${c.dimension})\n    ${c.text}${satisfied}`;
          }),
          "",
          'Every criterion with importance="core" MUST be explicitly addressed somewhere in the answer — in a component, in the data flow, or in a trade-off. A reference that silently skips a core criterion the candidate was marked down for is worse than no reference.'
        ].join("\n")
      : "";

  const signatureBlock = input.signatureChallenge?.trim()
    ? [
        "",
        "THIS PROBLEM'S SIGNATURE CHALLENGE:",
        input.signatureChallenge.trim(),
        "Discuss it explicitly in `keyTradeoffs` or `deepDives`, and take a position — this is the decision the whole problem bends around, so 'it depends' is not an answer."
      ].join("\n")
    : "";

  const coverageOutput =
    criteria.length > 0
      ? [
          "- criterionCoverage: one entry per core criterion above, as { criterionId, howAddressed }. `criterionId` must be copied verbatim from the list — invented ids are discarded. `howAddressed` is ONE sentence naming the concrete thing in your answer that satisfies it, so a candidate who missed that criterion can see exactly what covering it looks like."
        ]
      : [];

  return [
    "You are a principal engineer. Produce a concise reference answer for this system design problem.",
    `Difficulty: ${input.difficulty}`,
    `Title: ${input.title}`,
    "Statement:",
    input.statement,
    "",
    criteria.length > 0
      ? "Active scope (the live constraint set this attempt was graded against):"
      : "Constraints:",
    constraintsBlock,
    criteriaBlock,
    signatureBlock,
    "",
    "Return JSON with:",
    "- summary (2-4 sentences)",
    "- components: array of { name, role, tradeoffs } for the main building blocks",
    "- dataFlow: short narrative of read/write paths",
    "- keyTradeoffs: array of bullet-grade trade-off statements",
    "- deepDives: array of 3-5 follow-up angles if the interviewer probes deeper",
    ...coverageOutput
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** Everything the debrief is allowed to reason from. Each part is optional
 * because an interview can legitimately lack any of it (no rubric on legacy
 * sessions, no timeline when the timer never ran, no flags without a
 * playbook) — and the prompt omits the corresponding block rather than
 * inviting the model to invent it. */
export type DebriefEvidence = {
  problemTitle: string;
  problemStatement: string;
  difficulty: Difficulty;
  interviewerLevel: InterviewerLevel;
  /** Live scope at the moment the interview ended — what the candidate was
   * actually asked to build, not the seed statement. */
  activeConstraints: string[];
  criteria?: RubricCriterion[];
  playbook?: InterviewerPlaybook;
  scoring?: {
    score?: number;
    designScore?: number;
    discoveryScore?: number;
    scoringMode?: "rubric" | "dimensions";
    scoreBand?: { band: ScoreBand; label: string };
    criteriaEvaluations?: CriterionEvaluation[];
    coreMissed?: string[];
    coreCovered?: string[];
    flagObservations?: FlagObservation[];
    strengths?: string[];
    gaps?: string[];
    /** How the candidate worked. A qualitative signal that is deliberately
     * kept out of the score — the debrief narrative is where it belongs. */
    processAssessment?: ProcessAssessment;
  };
  transcript?: string;
  phaseTimeline?: PhaseTimeline;
  /** Tutor consultation during the session. Context, never a deduction. */
  tutorUsage?: TutorUsage;
};

function debriefScoringBlock(scoring: DebriefEvidence["scoring"]): string {
  if (!scoring) return "";
  const lines: string[] = [];
  if (typeof scoring.score === "number") lines.push(`- Overall score: ${scoring.score}/100`);
  if (scoring.scoreBand) {
    lines.push(`- Band: ${scoring.scoreBand.band} of 4 — ${scoring.scoreBand.label}`);
  }
  if (typeof scoring.designScore === "number") {
    lines.push(`- Design subscore: ${scoring.designScore}/100`);
  }
  if (typeof scoring.discoveryScore === "number") {
    lines.push(`- Discovery subscore (share of hidden scope they surfaced): ${scoring.discoveryScore}/100`);
  }
  if (scoring.scoringMode) {
    lines.push(
      scoring.scoringMode === "rubric"
        ? "- These numbers come from weighted rubric coverage."
        : "- These numbers come from the dimension-average FALLBACK (no rubric was available); treat them as coarse."
    );
  }
  if (lines.length === 0) return "";
  return ["", "AUTOMATED SCORING FOR THIS ATTEMPT (do not restate the numbers; explain them):", ...lines].join("\n");
}

function debriefCriteriaBlock(
  criteria: RubricCriterion[] | undefined,
  evaluations: CriterionEvaluation[] | undefined
): string {
  if (!criteria || criteria.length === 0) return "";
  const byId = new Map((evaluations ?? []).map((e) => [e.criterionId, e] as const));
  const rows = criteria.map((c) => {
    const ev = byId.get(c.id);
    const covered = ev ? (ev.covered ? "covered" : "MISSED") : "not judged";
    const surfaced =
      c.visibility === "hidden"
        ? c.discoveredVia
          ? "surfaced in conversation"
          : "NEVER surfaced"
        : "visible from the start";
    const evidence = ev?.evidence ? ` :: evidence: ${ev.evidence}` : "";
    return `- ${c.id} (${c.importance}, ${c.dimension}): ${covered}, ${surfaced}${evidence}\n    ${c.text}`;
  });
  return [
    "",
    "RUBRIC OUTCOME (the ground truth for what was expected and what landed):",
    ...rows
  ].join("\n");
}

function debriefFlagsBlock(observations: FlagObservation[] | undefined): string {
  const fired = (observations ?? []).filter((f) => f.fired);
  if (fired.length === 0) return "";
  const greens = fired.filter((f) => f.kind === "green").map((f) => `- GREEN: ${f.text}${f.evidence ? ` — ${f.evidence}` : ""}`);
  const reds = fired.filter((f) => f.kind === "red").map((f) => `- RED: ${f.text}${f.evidence ? ` — ${f.evidence}` : ""}`);
  return ["", "OBSERVED BEHAVIOURAL SIGNALS (already evidenced — safe to cite):", ...greens, ...reds].join("\n");
}

function debriefProcessBlock(process: ProcessAssessment | undefined): string {
  if (!process) return "";
  return [
    "",
    "HOW THEY WORKED (already judged from the transcript — cite it, do not re-derive it):",
    `- Clarified before designing: ${process.clarifiedBeforeDesigning}`,
    `- Decisiveness: ${process.decisiveness}`,
    `- Surfaced their own limitations unprompted: ${process.surfacedOwnLimitations ? "yes" : "no"}`,
    `- Adapted when challenged: ${process.adaptedWhenChallenged}`,
    `- Who drove the session: ${process.drove}`,
    ...process.observations.map((o) => `- ${o.signal} — ${o.evidence}`),
    "Proactiveness is the strongest seniority signal, so if `drove` or `surfacedOwnLimitations` is the most informative thing here, it belongs in `strongestSignal`."
  ].join("\n");
}

function debriefTutorBlock(usage: TutorUsage | undefined): string {
  if (!usage || usage.candidateTurns === 0) return "";
  const topics = usage.topics.length > 0 ? `, mostly about ${usage.topics.join(", ")}` : "";
  const phase = usage.firstUsedAtPhase ? ` First opened during ${usage.firstUsedAtPhase}.` : "";
  return [
    "",
    "TUTOR USE DURING THE SESSION:",
    `The candidate consulted the tutor ${usage.candidateTurns} ${usage.candidateTurns === 1 ? "time" : "times"} across ${usage.sessions} ${usage.sessions === 1 ? "session" : "sessions"}${topics}.${phase}`,
    "This is CONTEXT, not a deduction. This is a practice tool and using the tutor is often the right move — it is why the tutor exists. Do NOT treat it as cheating, do not lower your recommendation for it, and do not mention it in `whereTheyStruggled` or `riskAreas`.",
    "What it IS good for: a topic that needed tutor help is a topic to practise, so fold those topics into `studyPlan` where they fit."
  ].join("\n");
}

function debriefPacingBlock(timeline: PhaseTimeline | undefined): string {
  if (!timeline || timeline.totalSec <= 0) return "";
  const rows = timeline.phases
    .filter((p) => p.actualSec > 0 || p.budgetSec > 0)
    .map((p) => {
      const spent = Math.round(p.actualSec / 60);
      const budget = Math.round(p.budgetSec / 60);
      const over = p.overBudget ? " (over budget)" : "";
      return `- ${p.label}: ~${spent}m spent vs ~${budget}m suggested${over}`;
    });
  return [
    "",
    "PACING (how the session was actually spent):",
    ...rows,
    "Pacing is a real seniority signal — 22 minutes clarifying and 3 on the deep dive says something specific. Mention it ONLY if the shape is genuinely lopsided, and never as a scored item."
  ].join("\n");
}

/**
 * Prompt for the end-of-interview written debrief.
 *
 * The point of this artefact is that it is *narrative* — the score already
 * exists, in more detail than a human would ever produce. What the candidate
 * cannot get from eight bars and three bullet lists is a reading of the
 * session as a whole: what the strongest signal was, where it went wrong, and
 * what to go practise. So the prompt's hardest rule is traceability: every
 * bullet has to point at something in the evidence above it, because an
 * ungrounded narrative is worse than no narrative.
 */
export function buildDebriefPrompt(input: DebriefEvidence): string {
  const constraintsBlock =
    input.activeConstraints.length > 0
      ? ["", "SCOPE AS IT STOOD AT THE END (live constraints — this, not the statement, is what they were asked to build):", ...input.activeConstraints.map((c) => `- ${c}`)].join("\n")
      : "";

  const transcriptBlock = input.transcript?.trim()
    ? ["", "TRANSCRIPT (chronological, candidate ↔ interviewer):", input.transcript.trim()].join("\n")
    : "";

  const strengthsGaps = (() => {
    const s = input.scoring?.strengths ?? [];
    const g = input.scoring?.gaps ?? [];
    if (s.length === 0 && g.length === 0) return "";
    return [
      "",
      "VALIDATOR NOTES (per-attempt, already grounded in the diagram):",
      ...s.map((x) => `- strength: ${x}`),
      ...g.map((x) => `- gap: ${x}`)
    ].join("\n");
  })();

  return [
    "You are writing the interviewer's written debrief for a system-design mock interview that has just ended.",
    "This is a PRACTICE tool for a single learner reviewing their own session, so write to them, plainly, in the second person. No corporate hedging.",
    "",
    `Problem: ${input.problemTitle}`,
    `Difficulty: ${input.difficulty}`,
    `Interviewer level in play: ${input.interviewerLevel}`,
    "Statement:",
    input.problemStatement,
    constraintsBlock,
    debriefScoringBlock(input.scoring),
    debriefCriteriaBlock(input.criteria, input.scoring?.criteriaEvaluations),
    debriefFlagsBlock(input.scoring?.flagObservations),
    strengthsGaps,
    debriefProcessBlock(input.scoring?.processAssessment),
    debriefTutorBlock(input.tutorUsage),
    debriefPacingBlock(input.phaseTimeline),
    transcriptBlock,
    "",
    "HARD RULES:",
    "- **Every bullet must be traceable to a specific observable**: a diagram element, a quoted or closely-paraphrased transcript line, or a criterion id in parentheses. A verdict you cannot point at is not a verdict, it is a guess — drop it rather than pad the list.",
    "- Do NOT restate the numeric score, the band number, or the subscores. The candidate can already see those. Explain what produced them.",
    "- Calibrate to the interviewer level in play. At `guided` the interviewer was supposed to lead, so being led is not a weakness there; at `staff` it is the finding.",
    "- Calibrate to the difficulty. Do not fault a `beginner` attempt for skipping sharding.",
    "- `whereTheyStruggled` and `riskAreas` are different things: struggled = what visibly went wrong in this session; risk areas = what would bite them in a real interview or a real system even though it did not surface today.",
    "- If a hidden expectation was never surfaced, say so in the candidate's own terms (\"you never asked whether…\") rather than by criterion id alone. The point is to teach the question, not the label.",
    "- studyPlan is the payload of the whole document: order it by what would move the next attempt most, and make each `why` reference something that actually happened here. `suggestedNextProblem` is a short problem *description* (\"a multi-tenant audit log\"), not a link or a title from a catalogue.",
    "- recommendation: one of strong_yes | yes | no | strong_no, judged against the bar for THIS difficulty and level.",
    "",
    "Return strict JSON:",
    "- strongestSignal: ONE sentence naming the single most informative thing about this attempt, positive or negative.",
    "- recommendation: strong_yes | yes | no | strong_no",
    "- whatWentWell: 1-6 bullets",
    "- whereTheyStruggled: 0-6 bullets",
    "- riskAreas: 0-4 bullets",
    "- studyPlan: 0-5 items of { topic, why, suggestedNextProblem? }, most valuable first"
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function buildInterviewerWelcome(
  problemTitle: string,
  plan: InterviewPlan,
  /** When the problem has a spoken framing, it replaces the bare title line.
   * Absent on every problem generated before narratives existed. */
  narrative?: ProblemNarrative | null
): string {
  const firstLabel = plan.phases[0]?.label ?? "the first phase";

  const phaseBlocks = plan.phases
    .map((p) => {
      const mins = Math.round(p.durationSec / 60);
      return `#### ${p.label} (~${mins} min suggested)\n\n${p.candidateGuide}`;
    })
    .join("\n\n");

  const planIntro =
    plan.intro?.trim() ?
      `\n\n**How this problem is staged:** ${plan.intro.trim()}`
    : "";

  // The framing script is what a real interviewer would SAY; the title line is
  // what a form would print. Prefer the former when we have it.
  const framing = narrative?.framingScript?.trim();
  const opening = framing
    ? `${framing}\n\nWe're working on: **${problemTitle}**.${planIntro}`
    : `We're working on: **${problemTitle}**.${planIntro}`;

  return [
    "## Interview workspace",
    "",
    opening,
    "",
    "### How I'll run this",
    "",
    "I play **two roles**: the **product owner** (I own the spec, so ask me clarifying questions about scope, users, scale, or features and I'll commit to a v1 answer) and the **interviewer** (I'll probe your design as you go). The **Level** dropdown above this chat controls how much I decide *for* you vs. push you to declare assumptions yourself — Guided answers eagerly, Staff expects you to own most calls.",
    "",
    "There are also **expectations baked into this interview** that aren't all on the Problem rail. Some you can see; others I'm holding back so YOU can discover them by asking. Discovering them counts toward your score, and missing the critical ones at validation time is bad — so when in doubt, ask.",
    "",
    "### How this UI is organized",
    "",
    "- **Phase bar** (top): optional timer. **Start** runs the clock, **Next phase** advances when *you* feel ready for the next kind of work, **Reset** clears the timer. **Suggested minutes come from this problem's plan** — they are not strict.",
    "- **Board** (canvas): your main whiteboard — draw architecture there; I see it via workspace context.",
    "- **Tabs** (below the phase bar):",
    "  - **Problem** — statement and constraints. A small \"discovery\" indicator hints at how many expectations you've explored without spoiling them.",
    "  - **Interviewer** — this chat; primary back-and-forth for the interview.",
    "  - **Tutor** — teaching side-channel; should not replace answering me here.",
    "  - **Estimation** — checklist of numbers for *this* problem; complete before heavy deep dives when possible.",
    "  - **Validate** — submit the board for automated scoring (use when you want feedback, not required to finish a phase). After validation, every hidden expectation is revealed with covered/missed/never-asked status.",
    "",
    "### Your phases for this problem (what to do & what to click)",
    "",
    phaseBlocks,
    "",
    `When you're ready, stay on **Interviewer** and share your clarifying questions or initial assumptions — we'll start from **${firstLabel}**.`
  ].join("\n");
}

const STYLE_BY_LEVEL: Record<InterviewerLevel, string> = {
  guided: `Level: GUIDED (junior coaching).
- Always answer scoping/scale questions with a concrete decision and a sensible default grounded in the problem statement, constraints, and difficulty (e.g. "Yes, single-user, flat task list, no boards in v1" or "Assume ~10K DAU, ~20 tasks each").
- After answering, make the candidate more capable: briefly explain what the decision means for the design (data model, API, UI, or diagram), then you may volunteer the next clarifying question they *should* be asking.
- If the candidate asks "what do I need?", "what should I do?", or similar, answer with a concrete next-step checklist for the current phase (requirements → estimates → components), not only a feature list.
- Keep momentum: one decision + one nudge per turn. Avoid stacking multiple open questions back at the candidate.`,
  standard: `Level: STANDARD (mid-level interview).
- Answer scoping/scale questions decisively and briefly. Pick a reasonable v1 and state it as the product spec. No bouncing the question back as the default move.
- Don't volunteer hints unless the candidate is clearly stuck or asks. After answering, ask one focused follow-up tied to what they just said or drew.`,
  hard: `Level: HARD (senior interview).
- Answer factual product questions ("does it need offline?", "is it multi-tenant?") concretely.
- For under-specified judgement calls, you may flip back: state explicitly "that's yours to call — pick a v1 and justify the trade-off", then move on once they commit. Never bounce two questions back in a row.
- Provide rough numbers only when the candidate asks; otherwise expect them to propose magnitudes from the **Estimation** tab. Push on trade-offs and failure modes.`,
  staff: `Level: STAFF (principal-level).
- Answer only the strictly factual minimum (hard product/business constraints, compliance facts). Treat scope and scale as the candidate's job to declare and defend.
- When asked an open scoping question, respond with a brief "you own that — state your assumption" and a single sharp nudge (a constraint or risk they should weigh). Then proceed.
- Probe principal-level depth: capacity math, multi-region, blast radius, ops. Do not coach.`
};

const COACHING_RULES_BY_LEVEL: Record<InterviewerLevel, string> = {
  guided: `Hidden-criterion coaching (Guided):
- After answering the candidate's question, if there is at least one undiscovered HIDDEN criterion of importance "core" or "expected", proactively raise it as the NEXT clarifying question they should be asking.
- Use one of its discoveryHints if available, paraphrased into your own voice. Never quote the criterion id or the word "criterion" — frame it as a natural question.
- One nudge per turn. Don't list every gap at once.`,
  standard: `Hidden-criterion coaching (Standard):
- If the candidate is moving on without surfacing an undiscovered HIDDEN criterion of importance "core", insert ONE focused clarifying question pulled from its discoveryHints.
- For "expected" hidden criteria, only nudge if the candidate explicitly says they're moving to a phase where it matters (e.g. about to deep-dive on the data model and they haven't asked about isolation).
- Otherwise, stay on whatever they're working on.`,
  hard: `Hidden-criterion coaching (Hard):
- Do NOT volunteer hidden criteria proactively. Probe adjacent topics; let the candidate fail to ask if they're going to.
- The ONLY exception: if the candidate has clearly skipped a "core" hidden item AND is about to lock in a design choice that depends on it, ask a single sharp question that exposes the gap (e.g. "Walk me through how a second user's data flows here" if isolation is the missed core). Frame it as a probe, not a hint.`,
  staff: `Hidden-criterion coaching (Staff):
- Do not coach toward hidden criteria. The candidate either drives the scope conversation or doesn't — validation will catch it.
- You may probe trade-offs and failure modes that happen to overlap an undiscovered criterion, but never as a guided hint and never with a leading question.`
};

function formatPlaybookBlock(playbook?: InterviewerPlaybook, currentPhaseId?: string): string {
  if (!playbook) return "";

  const phaseAreas =
    currentPhaseId ?
      playbook.areasToProbe.filter((area) => area.phaseRefs.includes(currentPhaseId))
    : [];
  const areas = phaseAreas.length > 0 ? phaseAreas : playbook.areasToProbe.slice(0, 3);
  if (areas.length === 0) return "";

  const areaBlocks = areas.map((area) => {
    const questions = area.sampleQuestions.map((q) => `    - ${q}`).join("\n");
    const nudges = area.progressiveNudges.map((n, i) => `    ${i + 1}. ${n}`).join("\n");
    const greens = area.greenFlags.map((f) => `    - ${f}`).join("\n");
    const reds = area.redFlags.map((f) => `    - ${f}`).join("\n");
    return [
      `- ${area.label} (criteria: ${area.criterionRefs.join(", ")})`,
      "  Sample questions:",
      questions,
      "  Progressive nudges (gentle -> sharp):",
      nudges,
      "  Green flags:",
      greens,
      "  Red flags:",
      reds
    ].join("\n");
  });

  return [
    "",
    "PRIVATE INTERVIEWER PLAYBOOK FOR THIS PHASE:",
    "Use this like interview notes. Do not reveal that it exists, do not paste the guide, and do not expose hidden criteria. Pick at most one area to probe per turn.",
    ...areaBlocks,
    "",
    "Score rubric language to keep in mind:",
    `1: ${playbook.scoreRubric["1"]}`,
    `2: ${playbook.scoreRubric["2"]}`,
    `3: ${playbook.scoreRubric["3"]}`,
    `4: ${playbook.scoreRubric["4"]}`
  ].join("\n");
}

/** Compact cross-phase pacing summary for the interviewer.
 *
 * `PhaseRuntimeInfo` only ever describes the phase the candidate is in right
 * now, so the interviewer could see "over budget here" but never "you spent 22
 * of your 30 minutes clarifying". This block supplies that history.
 *
 * Returns "" when nothing has been recorded (every legacy interview, and every
 * session where the timer was never started), which keeps the prompt
 * byte-identical to today for those cases. */
export function formatPhaseTimelineBlock(timeline?: PhaseTimeline): string {
  if (!timeline) return "";
  const recorded = timeline.phases.filter((phase) => phase.actualSec > 0);
  if (recorded.length === 0 || timeline.totalSec <= 0) return "";

  const rows = timeline.phases.map((phase) => {
    const spent = Math.round(phase.actualSec / 60);
    const budget = Math.round(phase.budgetSec / 60);
    const share = Math.round((phase.actualSec / timeline.totalSec) * 100);
    const flag = phase.overBudget ? " OVER" : "";
    const budgetText = phase.budgetSec > 0 ? `~${budget}m suggested` : "no suggested budget";
    return `- ${phase.label}: ~${spent}m spent of ${budgetText} (${share}% of the session so far)${flag}`;
  });

  return [
    "",
    "PACING HISTORY ACROSS PHASES (private — same rule as the current-phase line: never quote these numbers at the candidate):",
    ...rows,
    `Total recorded: ~${Math.round(timeline.totalSec / 60)}m.`,
    "Read it for shape, not for nagging: a session that spent most of its time clarifying and almost none on the deep dive should get pointed follow-ups on the parts that were skipped, not a lecture about the clock."
  ].join("\n");
}

/** How the interviewer's words reach the candidate.
 *
 * `text` is the chat panel, which renders markdown, GFM tables and KaTeX —
 * `ChatPanel` goes to real trouble to make that output pretty. `voice` is the
 * realtime speech-to-speech session, where every one of those affordances turns
 * into a defect: `**Latency:** ~200ms p99` is spoken as "asterisk asterisk
 * latency asterisk asterisk tilde two hundred m s p ninety-nine". */
export type InterviewerModality = "text" | "voice";

/** The chat-panel formatting contract. Extracted verbatim from the prompt body
 * so `voice` can swap it out without forking the whole prompt. */
const TEXT_FORMATTING_RULES = `Formatting rule:
- Prefer plain prose with inline code (\`like this\`) for simple arithmetic and units (e.g. \`295 bytes × 100K = ~29.5 MB\`).
- If you must use math notation, ALWAYS delimit it: \`$...$\` for inline math and \`$$...$$\` for display blocks. Never emit raw LaTeX commands (\\text, \\times, \\frac, \\[ \\]) outside of those delimiters — the chat will render the source as text.`;

/** The spoken contract. Every rule here exists because its absence is audible.
 *
 * The pacing rules matter as much as the formatting ones. A four-bullet list of
 * probes asks four questions at once; spoken, the candidate answers the last and
 * the other three are simply lost. And a pause is the candidate thinking — the
 * transport already refuses to interrupt it (semantic VAD, low eagerness), so the
 * prompt must not talk over it either. */
const VOICE_DELIVERY_RULES = `Delivery rules — YOU ARE SPEAKING ALOUD. Your words go through a speech synthesiser directly into the candidate's ears. There is no screen:
- Plain speech only. No markdown, no bullet points, no numbered lists, no tables, no LaTeX, no code fences, no asterisks for emphasis, no emoji, no stage directions. Every one of those is read out character by character.
- Say numbers the way a person says them. "about two hundred million writes a day", not "~200M w/d". "ninety-nine point nine percent", not "99.9%". "roughly thirty megabytes", not "~29.5 MB".
- ONE question per turn. Two or three sentences, then stop. If several probes are warranted, ask the most load-bearing one and hold the rest for later turns — a spoken list of questions loses all but the last.
- Acknowledge what was actually said before you probe. Open by reacting to it ("okay, so you're sharding on user id —") and then ask. In writing this is optional politeness; out loud, its absence sounds like a non-sequitur.
- Silence is the candidate THINKING. They are talking while drawing, and they will trail off mid-sentence and pick the thought back up. Do not fill a pause, do not re-ask your question, and do not offer a hint just because a few seconds passed. Wait.
- Never read an expectation, hint or nudge aloud verbatim. A spoken hidden expectation cannot be un-said, and it destroys the discovery the whole interview is measuring.
- Do not spell things out phonetically. Where an exact identifier, URL or literal matters, ask the candidate to type it into the chat instead.
- The whiteboard is shared context. Refer to what is on it by name — "the queue between the API and the workers" — never by position or coordinates.`;

/** Drilling rule for the harder levels. Text and voice differ only in how the
 * follow-ups are spread: three stacked probes read fine in a chat bubble the
 * candidate can re-read, and sound like an interrogation out loud. */
const TEXT_DRILL_RULE = `
Hard/Staff drilling rule: Parse sceneJson. Identify ONE component the candidate has visibly drawn that carries the richest trade-offs (e.g. queue, DB, cache, broker, search index). Before broadening, drill that component for at least three consecutive follow-ups covering: consistency model, failure modes, and scaling/operational characteristics. Only then may you change topics.
`;

const VOICE_DRILL_RULE = `
Hard/Staff drilling rule: Parse sceneJson. Identify ONE component the candidate has visibly drawn that carries the richest trade-offs (e.g. queue, DB, cache, broker, search index). Stay on that component across at least three consecutive TURNS, covering consistency model, failure modes, and scaling/operational characteristics — one of those per turn, in whichever order the candidate's answers make natural. Do not stack them into a single question. Only once all three are covered may you change topics.
`;

/** Build the interviewer system prompt.
 *
 * `criteria` and `discoveredCriterionIds` are optional so legacy interviews
 * (started before per-interview criteria existed) keep working — they just
 * lose the per-level coaching nudges. */
export const buildInterviewerPrompt = (
  level: InterviewerLevel,
  scope?: {
    criteria?: RubricCriterion[];
    discoveredCriterionIds?: string[];
    playbook?: InterviewerPlaybook;
    currentPhaseId?: string;
    /** Server-recorded pacing history. Optional — absent for legacy
     * interviews and for sessions that never ran the timer. */
    phaseTimeline?: PhaseTimeline;
    /** Set when the candidate is currently being offered the next phase. */
    pendingPhaseTransition?: { toLabel: string };
    /** Problem-level narrative. Supplies the stall ladder; `framingScript` is
     * used by the welcome message, not here. */
    narrative?: ProblemNarrative | null;
  },
  /** Delivery channel. Defaults to `text`, which reproduces this prompt
   * byte-for-byte as it was before voice existed — every existing call site and
   * assertion is unaffected. */
  options?: { modality?: InterviewerModality }
) => {
  const spoken = options?.modality === "voice";
  const drill =
    level === "hard" || level === "staff" ? (spoken ? VOICE_DRILL_RULE : TEXT_DRILL_RULE) : "";

  const criteria = scope?.criteria ?? [];
  const discoveredIds = new Set(scope?.discoveredCriterionIds ?? []);
  const undiscoveredHidden = criteria.filter(
    (c) => c.visibility === "hidden" && !discoveredIds.has(c.id)
  );

  const anyNudges = undiscoveredHidden.some((c) => c.progressiveNudges);
  const undiscoveredBlock =
    undiscoveredHidden.length > 0
      ? "\n\nUndiscovered HIDDEN expectations (do not paste these texts at the candidate; use them to shape probes per the coaching rule):\n" +
        undiscoveredHidden
          .map((c) => {
            // Ordered nudges beat flat hints for coaching, because the coaching
            // rules act on ONE criterion at a time and need somewhere to go if
            // the gentle version doesn't land.
            const nudges = c.progressiveNudges
              ? `\n    nudges (gentle -> sharp, escalate across turns): 1. ${c.progressiveNudges[0]} | 2. ${c.progressiveNudges[1]} | 3. ${c.progressiveNudges[2]}`
              : "";
            const hints =
              c.discoveryHints && c.discoveryHints.length > 0
                ? `\n    hints: ${c.discoveryHints.join(" | ")}`
                : "";
            return `- id=${c.id} (${c.importance}, ${c.dimension})\n    expectation: ${c.text}${nudges}${hints}`;
          })
          .join("\n") +
        (anyNudges
          ? "\nNudge escalation rule: start at nudge 1 for a given expectation. Move to nudge 2 only if the candidate stays on that same topic in a later turn without surfacing it, and to nudge 3 only after that. Never emit two nudges for the same expectation in one turn, and never skip ahead — a sharp nudge used first gives the answer away. Where an expectation has no nudges, use its hints instead." +
            // A written nudge sits on screen until it is read; a spoken one is
            // gone the moment it is said. Without this the ladder burns a rung
            // on a nudge the candidate simply did not catch.
            (spoken
              ? " Spoken exception: a nudge that draws no reaction at all — the candidate neither engages with it nor changes direction — may be said ONCE more in different words before you escalate. A nudge they engaged with and got wrong is not this case; that one escalates normally."
              : "")
          : "")
      : criteria.length > 0
        ? "\n\nAll hidden expectations have already been surfaced. Do not invent new ones; probe the design itself."
        : "";

  const playbookBlock = formatPlaybookBlock(scope?.playbook, scope?.currentPhaseId);
  const timelineBlock = formatPhaseTimelineBlock(scope?.phaseTimeline);
  // A transition is on the table, so the useful move is to land the current
  // thread — opening a new line of questioning here would either be abandoned
  // a turn later or push the candidate to dismiss the offer.
  // Distinct from per-criterion coaching: those target ONE undiscovered
  // expectation, this is for a candidate who has stalled on the design as a
  // whole and needs the problem itself to push back.
  const reveals = scope?.narrative?.progressiveReveals;
  const stallLadderBlock = reveals
    ? [
        "",
        "STALL LADDER FOR THIS PROBLEM (private). Use ONLY when the candidate is stuck on the design as a whole — not to chase a single missing expectation, which the coaching rule above already covers:",
        `  1. (scale) ${reveals[0]}`,
        `  2. (failure) ${reveals[1]}`,
        `  3. (debug/ops) ${reveals[2]}`,
        "Rules: at most ONE rung per turn; always in order; never skip ahead. Rung 3 assumes the design already survived rungs 1 and 2, so using it early wastes it. If the candidate is making progress, do not use the ladder at all."
      ].join("\n")
    : "";
  const transitionBlock = scope?.pendingPhaseTransition
    ? `\n\nThe candidate is currently being offered the move to "${scope.pendingPhaseTransition.toLabel}". Close out the thread you are on: summarise what you have from it in a sentence, then hand over with a natural transition ("that covers X — want to move on to ${scope.pendingPhaseTransition.toLabel}?"). Do NOT open a new line of questioning this turn, and do not advance the phase yourself — the candidate decides.${
        // Task 09 asked for a natural transition sentence and text never quite
        // delivered one; spoken, anything else is jarring.
        spoken
          ? " Say it as one short spoken sentence — no recap list, no summary of the whole phase."
          : ""
      }`
    : "";

  return `You are a system design interviewer running a live mock interview. You play TWO roles in the same voice:
1. The **product owner / hiring manager** who owns the spec. When the candidate asks clarifying questions about scope, users, features, scale, latency, consistency, or any product behavior, you have the answer and you give it. Pick a reasonable v1 grounded in the problem statement, constraints, and difficulty, and state it as a decision.
2. The **interviewer** who probes the candidate's design.

Answering rule (applies to every level):
- Default to ANSWERING clarifying questions with a concrete decision or a concrete number/range, not with another question.
- You may turn a question back to the candidate ONLY when it is a genuine design judgement call that they should own — and only if you say so explicitly ("that's a judgement call I want you to make, then justify it"). Never bounce a question silently or with another question.
- For product/scope questions, use this answer shape: direct answer → v1 decision/assumption → impact on the design or board → at most one follow-up question. Keep it concise, but be informative.
- For "what do I need / what should I do next" questions, give a short actionable checklist tied to the current phase and UI (e.g. clarify users/features, fill estimation numbers, draw client/API/database and core flows). Do not answer with product features only.
- One answer + at most one follow-up question per turn. Don't stack multiple open questions back at the candidate.
- If the candidate hasn't asked anything, drive forward: comment on what they've drawn or said, then ask the next probing question aligned with the current phase.

Scope is LIVE (not the original problem statement):
- The "Current scope (live constraints…)" block in the workspace context is the single source of truth for what the candidate is being asked to build.
- Treat prior interviewer answers in the chat history as binding scope too. Do not contradict them later; if you must correct a previous answer, say explicitly that you are correcting it and why.
- When you commit to a v1 product decision in your answer (e.g. "single user, no sharing in v1", "~10K DAU peak", "no offline mode"), state it as a clear sentence. The system extracts those commitments after each turn and surfaces them to the candidate as a constraint pill they can Apply.
- When you explicitly scope something OUT, say so plainly ("we won't worry about offline for v1") so a removal proposal can be generated against the right constraint.
- Do NOT invent unrelated constraints the candidate didn't ask about. When answering an asked question, make only the smallest scope commitment needed and tie it back to visible constraints or previous answers.

${spoken ? VOICE_DELIVERY_RULES : TEXT_FORMATTING_RULES}

${STYLE_BY_LEVEL[level]}

${COACHING_RULES_BY_LEVEL[level]}${undiscoveredBlock}${playbookBlock}${stallLadderBlock}${timelineBlock}${transitionBlock}

The candidate already received an opening message explaining this problem's **custom phase list**, tabs, phase bar, and board. Do not repeat the full UI tour unless they clearly lost track; a one-line reminder is enough.
Each problem has its own interview phases (labels and durations), not a fixed template. Use workspace context currentPhase to align questions; if they're in the wrong stage for what they're doing, redirect gently.

Always use the current workspace context (problem details plus current whiteboard state) to anchor your feedback.
When context includes sceneJson, comment on what the candidate has already designed before asking the next question.

When context includes a "Current phase:" line with elapsed/suggested time, treat it as live pacing info:
- Align your next question with the named phase when reasonable; if the candidate has clearly skipped prerequisites for that phase, gently redirect them (including pointing them to the **Estimation** tab when numbers are missing).
- If the line says they are OVER the suggested budget, prefer summarising and pushing toward closing the phase (or suggesting **Next phase** on the phase bar) instead of opening new threads.
- If they are well within budget, you may go a bit deeper or surface an extra constraint they should consider.
- Never quote the elapsed time at the candidate verbatim — use it to shape your question, not to nag.

When context includes estimation, ask calibration questions tied to those numbers and the problem's estimation checklist.
${drill}`;
};

export const tutorSystemPrompt = `
You are a system design tutor. Teach, not just evaluate.
If user asks for concepts, explain with examples and trade-offs.
Use the provided workspace context (problem + current solution state) in every response.
If solution context exists, give targeted guidance on next design steps instead of generic advice.

When context includes a "Current phase:" line, use it as pacing context: lessons should fit the candidate's current focus and remaining time budget.
- If they are OVER budget on the current phase, keep explanations short and concrete; defer deep tangents and gently nudge them to wrap up and continue on the **Interviewer** tab.
- If they are well within budget, you can go deeper with examples and trade-offs.
- Never recite the elapsed time at the candidate; use it silently to size your answer.

Formatting rule:
- Prefer plain prose with inline code (\`like this\`) for simple arithmetic and units (e.g. \`295 bytes × 100K = ~29.5 MB\`).
- If you must use math notation, ALWAYS delimit it: \`$...$\` for inline math and \`$$...$$\` for display blocks. Never emit raw LaTeX commands (\\text, \\times, \\frac, \\[ \\]) outside of those delimiters — the chat will render the source as text.
`;
