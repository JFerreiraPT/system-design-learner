/**
 * One place where every OpenAI model id is decided.
 *
 * The assignment used to be inverted relative to leverage: the two artefacts
 * everything downstream depends on — the problem and the rubric — ran on the
 * cheapest model, while the most expensive one was spent judging `covered` /
 * `discovered` booleans against a rubric someone else had already written. A
 * bad rubric poisons the interviewer's coaching, the discovery loop, the
 * validation and the debrief; a slightly worse `covered` judgement costs one
 * criterion. So generation now runs on the stronger tier.
 *
 * Every entry is overridable by env var so recalibrating never needs a code
 * change, and an unset or garbage value falls back to the documented default
 * rather than throwing — a typo in `.env` must not take the API down.
 */

export const AI_MODEL_DEFAULTS = {
  /** Statement, constraints, tags, estimation spec AND the interview plan.
   * Runs once per problem, then cached on the row forever. */
  problemGeneration: "gpt-4o",
  /** The rubric + interviewer playbook — the spine of scoring, coaching and
   * discovery. Runs once per interview start. */
  criteriaGeneration: "gpt-4o",
  /** Per-criterion judgement against an already-written rubric. */
  validation: "gpt-4o",
  reference: "gpt-4o",
  /** End-of-interview narrative. Once per interview, at most. */
  debrief: "gpt-4o",
  interviewerChat: "gpt-4o",
  /** The lower-stakes teaching surface. */
  tutorChat: "gpt-4o-mini",
  /** Per-turn conservative matcher — correctly cheap. */
  discoveryMatch: "gpt-4o-mini",
  /** Per-turn conservative extraction — correctly cheap. */
  proposals: "gpt-4o-mini",
  /** One-off column backfills (tags, estimation specs, plans, narrative,
   * track, tutor topics). */
  backfill: "gpt-4o-mini"
} as const;

export type AiModelPurpose = keyof typeof AI_MODEL_DEFAULTS;
export type AiModels = Record<AiModelPurpose, string>;

/** Env var per purpose. Documented in `.env.example`. */
export const AI_MODEL_ENV_KEYS: Record<AiModelPurpose, string> = {
  problemGeneration: "AI_MODEL_PROBLEM",
  criteriaGeneration: "AI_MODEL_CRITERIA",
  validation: "AI_MODEL_VALIDATION",
  reference: "AI_MODEL_REFERENCE",
  debrief: "AI_MODEL_DEBRIEF",
  interviewerChat: "AI_MODEL_INTERVIEWER",
  tutorChat: "AI_MODEL_TUTOR",
  discoveryMatch: "AI_MODEL_DISCOVERY",
  proposals: "AI_MODEL_PROPOSALS",
  backfill: "AI_MODEL_BACKFILL"
};

/** Reads one config value. Kept as a parameter so this resolves without Nest. */
export type ConfigReader = (key: string) => string | undefined;

/** A model id has to be a non-empty single token — anything with whitespace is
 * a mis-set variable (a quoted comment, a pasted sentence), not a model. */
function usableModelId(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (/\s/.test(trimmed)) return undefined;
  return trimmed;
}

export function resolveAiModels(read: ConfigReader): AiModels {
  const resolved = {} as AiModels;
  for (const purpose of Object.keys(AI_MODEL_DEFAULTS) as AiModelPurpose[]) {
    resolved[purpose] =
      usableModelId(read(AI_MODEL_ENV_KEYS[purpose])) ?? AI_MODEL_DEFAULTS[purpose];
  }
  return resolved;
}
