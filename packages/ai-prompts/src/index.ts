import type {
  Difficulty,
  InterviewerPlaybook,
  InterviewerLevel,
  InterviewPlan,
  RubricCriterion
} from "@sdl/shared";

const DIFFICULTY_CONTEXT_SNIPPETS: Record<Difficulty, string> = {
  beginner: `Tone: absolute beginner warmup; no prior system design jargon required.
Problem choice: Tiny, familiar domains (todo list, simple blog, contact book, single-page notes, tiny file bucket for thumbnails, classroom attendance, one-office room booking).
Avoid altogether: globe-scale assumptions, geo-distributed deploys, sharding/partition strategies, realtime/presence/streaming motifs, CDN/caching fleets, eventual-consistency dramas, HA across many regions.
Expected answer breadth: Roughly two to four labeled boxes suffice (typically web/mobile client, one API/backend layer, one database, optionally one blob store or trivial cache)—do not implicitly expect microservices fleets.
constraints: Produce 3-4 concise bullets grounded in weekly homework scale (small team or school project), never five-nines SLO wording.
tags: Exactly two strings from the vocabulary below; strongly prefer pairing from {api-design, storage, transactional} when they fit.`,
  easy: `Standard junior-friendly single-region product sketch; include clear users and main flows without enterprise-only complexity.`,
  medium: `Realistic midsize SaaS breadth; multiple services or datastores may appear with coherent trade-offs and scale.`,
  hard: `Large-scale assumptions, sharper constraints, and probing failure/scaling angles without hand-holding.`,
  expert: `Cutting-edge or multi-region mission-critical narratives (compliance when natural), principal-level ambiguity.`
};

function difficultyContextBlock(difficulty: Difficulty): string {
  return `Difficulty guidance for ${difficulty}:\n${DIFFICULTY_CONTEXT_SNIPPETS[difficulty]}`;
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

export const buildProblemPrompt = (
  difficulty: Difficulty,
  topic?: string,
  existingProblems?: Array<{ title: string; tags: string[]; gist: string }>
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

  return `
Generate one system design interview problem.
Difficulty: ${difficulty}
${difficultyContextBlock(difficulty)}
${topicLine}
${existingBlock}
${TAG_VOCABULARY_SNIPPET}

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
- interviewPlan: object for this problem only:
  - intro (optional): one sentence on how YOU structured the flow for THIS prompt (e.g. data-heavy vs API-heavy)
  - phases:${phasesBullet} Each:
    - id: lowercase_snake_case (stable slug)
    - label: short UI title (2-4 words)
    - durationSec: suggested timer budget (integer seconds). ${phaseBudgetNote}
    - candidateGuide: 2-5 sentences in markdown-lite. Say what the candidate should accomplish in THIS phase and exactly which parts of the app to use: **Problem**, **Interviewer**, **Tutor**, **Estimation**, **Board**, **Validate**, **phase bar** (Start / Next phase / Reset). Omit or merge phases that do not fit the problem (e.g. skip a dedicated API phase for offline batch systems; replace with "ingest & storage contracts" or similar).
`;
};

export function getCriteriaHiddenMin(difficulty: Difficulty): number {
  return CRITERIA_BUDGET_BY_DIFFICULTY[difficulty].hiddenMin;
}

const CRITERIA_BUDGET_BY_DIFFICULTY: Record<
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

  return [
    "You are a senior system design reviewer.",
    `Evaluate the candidate whiteboard solution for ${difficulty} level.`,
    "",
    constraintsBlock,
    criteriaBlock,
    estimationBlock,
    transcriptBlock,
    flagsBlock,
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
      : [])
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

export function buildReferenceSolutionPrompt(input: {
  title: string;
  statement: string;
  difficulty: Difficulty;
  constraints: string[];
}): string {
  const constraintsBlock = input.constraints.map((c) => "- " + c).join("\n");
  return [
    "You are a principal engineer. Produce a concise reference answer for this system design problem.",
    `Difficulty: ${input.difficulty}`,
    `Title: ${input.title}`,
    "Statement:",
    input.statement,
    "",
    "Constraints:",
    constraintsBlock,
    "",
    "Return JSON with:",
    "- summary (2-4 sentences)",
    "- components: array of { name, role, tradeoffs } for the main building blocks",
    "- dataFlow: short narrative of read/write paths",
    "- keyTradeoffs: array of bullet-grade trade-off statements",
    "- deepDives: array of 3-5 follow-up angles if the interviewer probes deeper"
  ].join("\n");
}

export function buildInterviewerWelcome(problemTitle: string, plan: InterviewPlan): string {
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

  return [
    "## Interview workspace",
    "",
    `We're working on: **${problemTitle}**.${planIntro}`,
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
  }
) => {
  const drill =
    level === "hard" || level === "staff"
      ? `
Hard/Staff drilling rule: Parse sceneJson. Identify ONE component the candidate has visibly drawn that carries the richest trade-offs (e.g. queue, DB, cache, broker, search index). Before broadening, drill that component for at least three consecutive follow-ups covering: consistency model, failure modes, and scaling/operational characteristics. Only then may you change topics.
`
      : "";

  const criteria = scope?.criteria ?? [];
  const discoveredIds = new Set(scope?.discoveredCriterionIds ?? []);
  const undiscoveredHidden = criteria.filter(
    (c) => c.visibility === "hidden" && !discoveredIds.has(c.id)
  );

  const undiscoveredBlock =
    undiscoveredHidden.length > 0
      ? "\n\nUndiscovered HIDDEN expectations (do not paste these texts at the candidate; use them to shape probes per the coaching rule):\n" +
        undiscoveredHidden
          .map((c) => {
            const hints =
              c.discoveryHints && c.discoveryHints.length > 0
                ? `\n    hints: ${c.discoveryHints.join(" | ")}`
                : "";
            return `- id=${c.id} (${c.importance}, ${c.dimension})\n    expectation: ${c.text}${hints}`;
          })
          .join("\n")
      : criteria.length > 0
        ? "\n\nAll hidden expectations have already been surfaced. Do not invent new ones; probe the design itself."
        : "";

  const playbookBlock = formatPlaybookBlock(scope?.playbook, scope?.currentPhaseId);

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

Formatting rule:
- Prefer plain prose with inline code (\`like this\`) for simple arithmetic and units (e.g. \`295 bytes × 100K = ~29.5 MB\`).
- If you must use math notation, ALWAYS delimit it: \`$...$\` for inline math and \`$$...$$\` for display blocks. Never emit raw LaTeX commands (\\text, \\times, \\frac, \\[ \\]) outside of those delimiters — the chat will render the source as text.

${STYLE_BY_LEVEL[level]}

${COACHING_RULES_BY_LEVEL[level]}${undiscoveredBlock}${playbookBlock}

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
