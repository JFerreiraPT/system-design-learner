/**
 * The Realtime API wire format, in one file.
 *
 * Kept separate from the Nest service because it is pure data-shaping with no
 * dependencies, which makes the one property that actually matters testable in
 * isolation: that a minted session config carries the interviewer instructions
 * and the response handed to the browser does not.
 *
 * Field paths verified against developers.openai.com (August 2026):
 *   - guides/realtime, guides/realtime-webrtc
 *   - guides/realtime-vad, guides/realtime-transcription
 *
 * That surface has been reshaped once already — `turn_detection` and
 * `input_audio_transcription` used to sit flat on the session object and now
 * live under `session.audio.input.*` — so treat a 400 from the mint call as a
 * signal to re-read those pages before debugging anything else.
 */

import type { VoiceTurnDetectionConfig } from "../ai/ai.models.js";

export const REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

/** Vocabulary hints for the transcriber.
 *
 * This matters more than it looks. Untuned, "idempotency" comes back as "eye
 * dempotency" and "quorum" as "core um" — and every such miss is a criterion
 * `detectDiscoveries` then fails to match, so the candidate says the right thing
 * and gets no credit for it. Seeded per-problem from tags and rubric vocabulary
 * on top of this base list.
 */
export const VOICE_BASE_KEYWORDS = [
  "idempotency",
  "idempotent",
  "sharding",
  "consistent hashing",
  "quorum",
  "CQRS",
  "write-ahead log",
  "CDN",
  "Kafka",
  "read replica",
  "backpressure",
  "eventual consistency",
  "leader election",
  "rate limiter",
  "bloom filter",
  "cache invalidation",
  "fan-out",
  "p99 latency"
];

export type RealtimeSessionConfig = {
  type: "realtime";
  model: string;
  instructions: string;
  audio: {
    input: {
      format: { type: "audio/pcm"; rate: number };
      transcription: { model: string; prompt?: string; keywords?: string[] };
      turn_detection: VoiceTurnDetectionConfig & {
        create_response: true;
        interrupt_response: true;
      };
    };
    output: { voice: string };
  };
};

export function buildRealtimeSessionConfig(input: {
  model: string;
  transcriptionModel: string;
  voice: string;
  sampleRate: number;
  instructions: string;
  turnDetection: VoiceTurnDetectionConfig;
  keywords?: string[];
}): RealtimeSessionConfig {
  return {
    type: "realtime",
    model: input.model,
    instructions: input.instructions,
    audio: {
      input: {
        format: { type: "audio/pcm", rate: input.sampleRate },
        transcription: {
          model: input.transcriptionModel,
          prompt:
            "A spoken system-design interview. The speaker is a software engineer reasoning aloud about distributed systems architecture while drawing on a whiteboard.",
          keywords: dedupeKeywords([...(input.keywords ?? []), ...VOICE_BASE_KEYWORDS])
        },
        turn_detection: {
          ...input.turnDetection,
          // The candidate interrupting the interviewer is normal conversation,
          // not an error state — see task 22 for the truncation that has to
          // accompany it, or the model believes it said a sentence nobody heard.
          create_response: true,
          interrupt_response: true
        }
      },
      output: { voice: input.voice }
    }
  };
}

/** The API rejects duplicates and caps the list; keep it short and stable. */
function dedupeKeywords(all: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of all) {
    const k = raw.trim();
    if (!k || k.length > 60) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= 60) break;
  }
  return out;
}
