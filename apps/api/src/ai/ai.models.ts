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

/**
 * Languages the transcriber should expect, as ISO 639-1 codes.
 *
 * Not optional in practice. Left unset, `gpt-live-transcribe` auto-detects per
 * utterance, and on a short or noisy one it guesses — a real session produced
 * "これ の" from an English speaker and drifted into Spanish mid-sentence for a
 * Portuguese one. Every such miss is also a criterion `detectDiscoveries` will
 * fail to match, so the candidate says the right thing and gets no credit.
 *
 * Set more than one only if the candidate genuinely code-switches; each extra
 * language widens the search and makes mis-detection likelier again.
 */
export const DEFAULT_VOICE_LANGUAGES = ["en"];

export function resolveVoiceLanguages(read: ConfigReader): string[] {
  const raw = read("AI_VOICE_LANGUAGES");
  if (typeof raw !== "string") return DEFAULT_VOICE_LANGUAGES;
  const codes = raw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    // ISO 639-1/639-3: two or three letters. Anything else is a mis-set value.
    .filter((c) => /^[a-z]{2,3}$/.test(c));
  return codes.length > 0 ? [...new Set(codes)].slice(0, 4) : DEFAULT_VOICE_LANGUAGES;
}

/** Audio sample rate for the input stream, in Hz. Not configurable — the
 * Realtime API's PCM contract is 24kHz and getting it wrong yields audio that
 * transcribes as gibberish rather than an error. */
export const VOICE_SAMPLE_RATE = 24000;

export type VoiceTurnDetectionConfig =
  | { type: "semantic_vad"; eagerness: "low" | "medium" | "high" | "auto" }
  | { type: "server_vad"; threshold: number; silence_duration_ms: number };

/**
 * Why the defaults are what they are.
 *
 * The design tension: a candidate says "so I'd put a queue here…", spends eight
 * seconds drawing it, then finishes "…and the consumers are idempotent." That is
 * ONE turn, and the API's own 500ms silence default cuts it in two.
 *
 * The first cut of this shipped `eagerness: "low"` to protect that pause, on the
 * reasoning that being interrupted mid-design is worse than a slow reply. Real
 * use said otherwise, and showed the two symptoms share a root cause: `low`
 * stretches the maximum wait, so a non-speech noise — a chair scrape — opens a
 * turn and then the session sits in it for seconds before replying. The
 * candidate gets BOTH a false "you're speaking" and a sluggish interviewer.
 *
 * So `medium` is the default: still model-scored, so a genuine trailing-off
 * still buys extra time, but without the padded ceiling. `low` remains one env
 * var away for someone who really does think in long silences.
 *
 * `server_vad` is the escape hatch, and it is the only mode with a loudness
 * `threshold` — which is the right tool if room noise, rather than pacing, is
 * the problem.
 */
export const VOICE_DEFAULT_EAGERNESS = "medium" as const;
export const VOICE_DEFAULT_SILENCE_MS = 1500;
/** Above the API's 0.5 default: a chair scrape should not open a turn. */
export const VOICE_DEFAULT_THRESHOLD = 0.65;

export function resolveVoiceTurnDetection(read: ConfigReader): VoiceTurnDetectionConfig {
  const mode = usableModelId(read("VOICE_TURN_DETECTION"))?.toLowerCase();
  if (mode === "server_vad") {
    return {
      type: "server_vad",
      threshold: readUnitFraction(read, "VOICE_VAD_THRESHOLD", VOICE_DEFAULT_THRESHOLD),
      silence_duration_ms: readPositiveInt(read, "VOICE_SILENCE_MS", VOICE_DEFAULT_SILENCE_MS)
    };
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

/** A 0..1 knob. Anything outside that range is a mis-set variable, not a
 * threshold — and a threshold of 0 would treat silence as speech. */
function readUnitFraction(read: ConfigReader, key: string, fallback: number): number {
  const raw = usableModelId(read(key));
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) return fallback;
  return parsed;
}

/**
 * Hard ceiling on one spoken reply, in output tokens (audio included).
 *
 * A backstop, not the mechanism: the prompt does the real work of keeping turns
 * short, because a token cap does not shorten a reply — it TRUNCATES it, and
 * being cut off mid-sentence is worse than being verbose. This exists to catch
 * the genuine monologue.
 *
 * Audio runs ~20 output tokens/second, so 400 is roughly twenty seconds of
 * speech — comfortably past the three-sentence budget the prompt asks for, and
 * well short of a lecture. Raise it if replies get clipped mid-word.
 */
export const VOICE_DEFAULT_MAX_RESPONSE_TOKENS = 400;

export function resolveVoiceMaxResponseTokens(read: ConfigReader): number {
  const value = readPositiveInt(
    read,
    "VOICE_MAX_RESPONSE_TOKENS",
    VOICE_DEFAULT_MAX_RESPONSE_TOKENS
  );
  // The API accepts 1..4096; anything outside that would be rejected at mint.
  return Math.min(4096, Math.max(64, value));
}

/**
 * How hard the model thinks before speaking.
 *
 * `low` on purpose. Reasoning happens before the first audio frame, so every
 * step of effort is silence the candidate sits through — and the interviewer's
 * judgement is carried by the rubric and playbook in the prompt, not by
 * deliberation at turn time. Raise it only if the questions get shallow.
 */
export const VOICE_DEFAULT_REASONING_EFFORT = "low" as const;
const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

export function resolveVoiceReasoningEffort(read: ConfigReader): string {
  const raw = usableModelId(read("VOICE_REASONING_EFFORT"))?.toLowerCase();
  return raw && REASONING_EFFORTS.includes(raw) ? raw : VOICE_DEFAULT_REASONING_EFFORT;
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
