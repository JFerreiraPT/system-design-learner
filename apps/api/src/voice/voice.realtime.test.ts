import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VOICE_NAME,
  resolveVoiceLimits,
  resolveVoiceLanguages,
  resolveVoiceMaxResponseTokens,
  resolveVoiceName,
  resolveVoiceReasoningEffort,
  resolveVoiceTurnDetection,
  VOICE_DEFAULT_IDLE_TIMEOUT_SECONDS,
  VOICE_DEFAULT_MAX_SESSION_MINUTES,
  VOICE_DEFAULT_MAX_RESPONSE_TOKENS,
  VOICE_DEFAULT_SILENCE_MS,
  VOICE_DEFAULT_THRESHOLD,
  VOICE_SAMPLE_RATE
} from "../ai/ai.models.js";
import { buildRealtimeSessionConfig, VOICE_BASE_KEYWORDS } from "./voice.realtime.js";

const reader = (env: Record<string, string | undefined>) => (key: string) => env[key];

function config(overrides: Partial<Parameters<typeof buildRealtimeSessionConfig>[0]> = {}) {
  return buildRealtimeSessionConfig({
    model: "gpt-realtime-2.1",
    transcriptionModel: "gpt-live-transcribe",
    voice: "marin",
    sampleRate: VOICE_SAMPLE_RATE,
    instructions: "INSTRUCTIONS",
    turnDetection: { type: "semantic_vad", eagerness: "medium" },
    maxResponseTokens: 400,
    reasoningEffort: "low",
    ...overrides
  });
}

// --- session config -------------------------------------------------------

test("the session config nests turn detection and transcription under audio.input", () => {
  const c = config();
  // The flat shape (session.turn_detection / session.input_audio_transcription)
  // is the OLD API and is silently ignored, which presents as a VAD setting
  // that appears to have no effect.
  assert.equal(c.type, "realtime");
  assert.equal(c.audio.input.turn_detection.type, "semantic_vad");
  assert.equal(c.audio.input.transcription.model, "gpt-live-transcribe");
  assert.deepEqual(c.audio.input.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(c.audio.output.voice, "marin");
  assert.ok(!("turn_detection" in (c as Record<string, unknown>)));
});

test("barge-in is enabled: the candidate may talk over the interviewer", () => {
  const c = config();
  assert.equal(c.audio.input.turn_detection.create_response, true);
  assert.equal(c.audio.input.turn_detection.interrupt_response, true);
});

test("server_vad carries a wider silence window and a noise gate", () => {
  const c = config({
    turnDetection: { type: "server_vad", threshold: 0.65, silence_duration_ms: 1500 }
  });
  const td = c.audio.input.turn_detection as { silence_duration_ms: number; threshold: number };
  // 500ms — the API default — cuts a candidate in half mid-design.
  assert.equal(td.silence_duration_ms, 1500);
  assert.notEqual(td.silence_duration_ms, 500);
  // And above 0.5, so a chair scrape does not open a turn.
  assert.equal(td.threshold, 0.65);
});

test("a reply is capped and reasoning is kept cheap", () => {
  const c = config();
  // A backstop only: it truncates rather than shortens, so the prompt carries
  // the real three-sentence budget.
  assert.equal(c.max_output_tokens, 400);
  // Reasoning runs before the first audio frame, so effort is silence the
  // candidate sits through.
  assert.deepEqual(c.reasoning, { effort: "low" });
});

test("response cap and reasoning effort fall back on nonsense", () => {
  assert.equal(resolveVoiceMaxResponseTokens(reader({})), VOICE_DEFAULT_MAX_RESPONSE_TOKENS);
  assert.equal(resolveVoiceMaxResponseTokens(reader({ VOICE_MAX_RESPONSE_TOKENS: "800" })), 800);
  // Clamped into the API's own 1..4096 window, and away from values so small
  // they would clip every reply mid-word.
  assert.equal(resolveVoiceMaxResponseTokens(reader({ VOICE_MAX_RESPONSE_TOKENS: "9999" })), 4096);
  assert.equal(resolveVoiceMaxResponseTokens(reader({ VOICE_MAX_RESPONSE_TOKENS: "5" })), 64);
  for (const bad of ["", "lots", "-10", "1.5"]) {
    assert.equal(
      resolveVoiceMaxResponseTokens(reader({ VOICE_MAX_RESPONSE_TOKENS: bad })),
      VOICE_DEFAULT_MAX_RESPONSE_TOKENS,
      bad
    );
  }

  assert.equal(resolveVoiceReasoningEffort(reader({})), "low");
  assert.equal(resolveVoiceReasoningEffort(reader({ VOICE_REASONING_EFFORT: "high" })), "high");
  assert.equal(resolveVoiceReasoningEffort(reader({ VOICE_REASONING_EFFORT: "turbo" })), "low");
});

test("instructions live in the session config, which is exactly why it stays server-side", () => {
  assert.equal(config({ instructions: "HIDDEN RUBRIC HERE" }).instructions, "HIDDEN RUBRIC HERE");
});

test("problem keywords are merged ahead of the base vocabulary and deduped", () => {
  const c = config({ keywords: ["Audit Log", "idempotency", "IDEMPOTENCY", "  "] });
  const kw = c.audio.input.transcription.keywords ?? [];

  assert.equal(kw[0], "Audit Log", "problem-specific terms should come first");
  // Case-insensitive dedupe: the transcriber rejects duplicates.
  assert.equal(kw.filter((k) => k.toLowerCase() === "idempotency").length, 1);
  assert.ok(!kw.includes("  "));
  assert.ok(kw.includes("consistent hashing"), "base vocabulary is still present");
  assert.ok(kw.length <= 60);
});

test("the base vocabulary covers the terms a mis-transcription would cost a criterion", () => {
  for (const term of ["idempotency", "quorum", "consistent hashing", "backpressure"]) {
    assert.ok(VOICE_BASE_KEYWORDS.includes(term), `${term} should be a transcription hint`);
  }
});

// --- config resolution ----------------------------------------------------

test("a bad voice name falls back to the default instead of throwing", () => {
  assert.equal(resolveVoiceName(reader({ AI_VOICE_NAME: "cedar" })), "cedar");
  assert.equal(resolveVoiceName(reader({ AI_VOICE_NAME: "CEDAR" })), "cedar");
  // A typo in .env must not take every voice session down.
  assert.equal(resolveVoiceName(reader({ AI_VOICE_NAME: "nonexistent" })), DEFAULT_VOICE_NAME);
  assert.equal(resolveVoiceName(reader({ AI_VOICE_NAME: "" })), DEFAULT_VOICE_NAME);
  assert.equal(resolveVoiceName(reader({ AI_VOICE_NAME: "a quoted comment" })), DEFAULT_VOICE_NAME);
  assert.equal(resolveVoiceName(reader({})), DEFAULT_VOICE_NAME);
});

test("turn detection defaults to semantic_vad at medium eagerness", () => {
  // `low` shipped first and was wrong in use: it pads the maximum wait, so a
  // chair scrape opens a turn and the session then sits in it for seconds.
  assert.deepEqual(resolveVoiceTurnDetection(reader({})), {
    type: "semantic_vad",
    eagerness: "medium"
  });
  for (const e of ["low", "high", "auto"]) {
    assert.deepEqual(resolveVoiceTurnDetection(reader({ VOICE_VAD_EAGERNESS: e })), {
      type: "semantic_vad",
      eagerness: e
    });
  }
  // Garbage keeps the deliberate default rather than the API's own "auto".
  assert.deepEqual(resolveVoiceTurnDetection(reader({ VOICE_VAD_EAGERNESS: "nope" })), {
    type: "semantic_vad",
    eagerness: "medium"
  });
});

test("server_vad is reachable as an escape hatch and tunable", () => {
  assert.deepEqual(resolveVoiceTurnDetection(reader({ VOICE_TURN_DETECTION: "server_vad" })), {
    type: "server_vad",
    threshold: VOICE_DEFAULT_THRESHOLD,
    silence_duration_ms: VOICE_DEFAULT_SILENCE_MS
  });
  assert.deepEqual(
    resolveVoiceTurnDetection(
      reader({ VOICE_TURN_DETECTION: "server_vad", VOICE_SILENCE_MS: "1800", VOICE_VAD_THRESHOLD: "0.8" })
    ),
    { type: "server_vad", threshold: 0.8, silence_duration_ms: 1800 }
  );
  // Malformed values must not become NaN and disable detection entirely.
  for (const bad of ["soon", "0", "-1", ""]) {
    const td = resolveVoiceTurnDetection(
      reader({ VOICE_TURN_DETECTION: "server_vad", VOICE_SILENCE_MS: bad, VOICE_VAD_THRESHOLD: bad })
    );
    assert.deepEqual(td, {
      type: "server_vad",
      threshold: VOICE_DEFAULT_THRESHOLD,
      silence_duration_ms: VOICE_DEFAULT_SILENCE_MS
    }, `"${bad}" should fall back`);
  }
  // A threshold of 1 would never open a turn; 0 would treat silence as speech.
  for (const bad of ["1", "1.5"]) {
    assert.equal(
      (resolveVoiceTurnDetection(reader({ VOICE_TURN_DETECTION: "server_vad", VOICE_VAD_THRESHOLD: bad })) as { threshold: number }).threshold,
      VOICE_DEFAULT_THRESHOLD
    );
  }
  // An unknown mode is not a reason to lose semantic VAD.
  assert.equal(resolveVoiceTurnDetection(reader({ VOICE_TURN_DETECTION: "magic" })).type, "semantic_vad");
});

test("transcription language is pinned, not auto-detected", () => {
  // Unset, gpt-live-transcribe guesses per utterance: a real session produced
  // Japanese from an English speaker and drifted into Spanish for a Portuguese
  // one, and every miss is a criterion the matcher then fails to match.
  assert.deepEqual(resolveVoiceLanguages(reader({})), ["en"]);
  assert.deepEqual(resolveVoiceLanguages(reader({ AI_VOICE_LANGUAGES: "en,pt" })), ["en", "pt"]);
  assert.deepEqual(resolveVoiceLanguages(reader({ AI_VOICE_LANGUAGES: " EN , PT " })), ["en", "pt"]);
  assert.deepEqual(resolveVoiceLanguages(reader({ AI_VOICE_LANGUAGES: "en,en,pt" })), ["en", "pt"]);
  // Junk falls back rather than shipping an invalid `languages` array.
  for (const bad of ["", "english,portuguese", "!!,??", ","]) {
    assert.deepEqual(resolveVoiceLanguages(reader({ AI_VOICE_LANGUAGES: bad })), ["en"], bad);
  }
});

test("the session config carries the pinned languages", () => {
  assert.deepEqual(config({ languages: ["en", "pt"] }).audio.input.transcription.languages, [
    "en",
    "pt"
  ]);
});

test("session limits parse minutes and reject nonsense", () => {
  assert.deepEqual(resolveVoiceLimits(reader({})), {
    maxSessionSeconds: VOICE_DEFAULT_MAX_SESSION_MINUTES * 60,
    idleTimeoutSeconds: VOICE_DEFAULT_IDLE_TIMEOUT_SECONDS
  });
  assert.equal(
    resolveVoiceLimits(reader({ VOICE_MAX_SESSION_MINUTES: "20" })).maxSessionSeconds,
    1200
  );
  for (const bad of ["0", "-5", "12.5", "lots", ""]) {
    assert.equal(
      resolveVoiceLimits(reader({ VOICE_MAX_SESSION_MINUTES: bad })).maxSessionSeconds,
      VOICE_DEFAULT_MAX_SESSION_MINUTES * 60,
      `"${bad}" should fall back`
    );
  }
});
