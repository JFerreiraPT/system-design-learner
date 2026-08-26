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
  backfill: "gpt-4o-mini",
  /** Speech-to-speech interviewer. Billed per second of audio in BOTH
   * directions for as long as the socket is open, which is why it is the one
   * model in this table with a session ceiling attached (see VOICE_LIMITS). */
  interviewerVoice: "gpt-realtime-2.1",
  /** Streaming transcription of candidate speech. `gpt-live-transcribe` emits
   * deltas as speech arrives, which is what lets the transcript fill in while
   * the candidate is still talking; `gpt-transcribe` only returns after the
   * turn is committed. */
  voiceTranscription: "gpt-live-transcribe"
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
  backfill: "AI_MODEL_BACKFILL",
  interviewerVoice: "AI_MODEL_VOICE",
  voiceTranscription: "AI_MODEL_VOICE_TRANSCRIPTION"
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

// ---------------------------------------------------------------------------
// Voice-only knobs. A voice *name* is not a model id, and neither is a VAD
// setting, so they get their own resolvers rather than being smuggled into the
// model table. Same failure philosophy throughout: a typo in `.env` falls back
// to the documented default instead of taking the API down.
// ---------------------------------------------------------------------------

/** Voices the Realtime API ships. Validated so a typo cannot 400 every session
 * mint with a message the candidate will never see the cause of. */
export const VOICE_NAMES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse"
] as const;

export const DEFAULT_VOICE_NAME = "marin";

export function resolveVoiceName(read: ConfigReader): string {
  const raw = usableModelId(read("AI_VOICE_NAME"))?.toLowerCase();
  return raw && (VOICE_NAMES as readonly string[]).includes(raw) ? raw : DEFAULT_VOICE_NAME;
}

/** Audio sample rate for the input stream, in Hz. Not configurable — the
 * Realtime API's PCM contract is 24kHz and getting it wrong yields audio that
 * transcribes as gibberish rather than an error. */
export const VOICE_SAMPLE_RATE = 24000;

export type VoiceTurnDetectionConfig =
  | { type: "semantic_vad"; eagerness: "low" | "medium" | "high" | "auto" }
  | { type: "server_vad"; silence_duration_ms: number };

/** Why the defaults are what they are:
 *
 * A candidate says "so I'd put a queue here…", spends eight seconds drawing the
 * queue and thinking about backpressure, then finishes "…and the consumers are
 * idempotent because retries." That is ONE turn. The API's own default of 500ms
 * cuts it in two, the interviewer answers the first half, and the candidate is
 * now defending a design they had not finished describing.
 *
 * `semantic_vad` scores how finished the speech *sounds* and waits longer when
 * it trails off; `eagerness: "low"` stretches that wait further. `server_vad`
 * cannot do this at all, so when it is selected the threshold is a deliberately
 * generous 2500ms rather than the API default.
 */
export const VOICE_DEFAULT_EAGERNESS = "low" as const;
export const VOICE_DEFAULT_SILENCE_MS = 2500;

export function resolveVoiceTurnDetection(read: ConfigReader): VoiceTurnDetectionConfig {
  const mode = usableModelId(read("VOICE_TURN_DETECTION"))?.toLowerCase();
  if (mode === "server_vad") {
    return { type: "server_vad", silence_duration_ms: readPositiveInt(read, "VOICE_SILENCE_MS", VOICE_DEFAULT_SILENCE_MS) };
  }
  const eagerness = usableModelId(read("VOICE_VAD_EAGERNESS"))?.toLowerCase();
  return {
    type: "semantic_vad",
    eagerness:
      eagerness === "low" || eagerness === "medium" || eagerness === "high" || eagerness === "auto"
        ? eagerness
        : VOICE_DEFAULT_EAGERNESS
  };
}

/** Session ceilings. A voice session bills for as long as a socket is open, so
 * unlike every other AI call in this codebase it is bounded by nothing unless we
 * bound it. A tab left open over lunch keeps the mic hot and keeps charging. */
export const VOICE_DEFAULT_MAX_SESSION_MINUTES = 60;
export const VOICE_DEFAULT_IDLE_TIMEOUT_SECONDS = 300;

export type VoiceLimits = { maxSessionSeconds: number; idleTimeoutSeconds: number };

export function resolveVoiceLimits(read: ConfigReader): VoiceLimits {
  return {
    maxSessionSeconds:
      readPositiveInt(read, "VOICE_MAX_SESSION_MINUTES", VOICE_DEFAULT_MAX_SESSION_MINUTES) * 60,
    idleTimeoutSeconds: readPositiveInt(
      read,
      "VOICE_IDLE_TIMEOUT_SECONDS",
      VOICE_DEFAULT_IDLE_TIMEOUT_SECONDS
    )
  };
}

/** Shared numeric parser: anything that isn't a finite positive integer is a
 * mis-set variable, not a limit. */
function readPositiveInt(read: ConfigReader, key: string, fallback: number): number {
  const raw = usableModelId(read(key));
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
