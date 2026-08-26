import type { VoiceTurnState } from "@sdl/shared";

/**
 * Realtime data-channel events, narrowed to the ones this client acts on.
 *
 * Everything else is ignored rather than rejected: the API adds events, and a
 * client that throws on an unrecognised `type` breaks on a Tuesday for reasons
 * nobody can reproduce.
 *
 * Transport note that matters for turn state: over **WebRTC** the interviewer's
 * audio arrives on the media track, not as `response.output_audio.delta` frames
 * — those only appear on the WebSocket transport. So "the interviewer started
 * speaking" has to be inferred from whichever of several signals shows up
 * first, which is why `isSpeakingSignal` accepts more than one.
 */
export type RealtimeServerEvent = {
  type: string;
  event_id?: string;
  item_id?: string;
  response_id?: string;
  content_index?: number;
  delta?: string;
  transcript?: string;
  error?: { message?: string; code?: string; type?: string };
  item?: {
    id?: string;
    role?: string;
    type?: string;
    content?: Array<{ type?: string; text?: string; transcript?: string }>;
  };
  response?: { id?: string; status?: string };
};

/** A parsed event plus the moment it was observed. Time is injected rather than
 * read inside the reducer so the whole state machine stays pure and testable
 * against a fake clock. */
export type TimedEvent = { event: RealtimeServerEvent; atMs: number };

export type { VoiceTurnState };

/** Events that mean the interviewer has begun speaking aloud.
 *
 * `response.output_audio.delta` is the WebSocket signal, `output_audio_buffer.started`
 * the WebRTC one, and the transcript delta is the belt-and-braces fallback that
 * works on both — the first spoken word always produces one. */
export function isSpeakingSignal(type: string): boolean {
  return (
    type === "response.output_audio.delta" ||
    type === "output_audio_buffer.started" ||
    type === "response.output_audio_transcript.delta" ||
    // Pre-rename aliases, kept because a silent turn-state regression is much
    // harder to notice than a crash.
    type === "response.audio.delta" ||
    type === "response.audio_transcript.delta"
  );
}

export function isAssistantTranscriptDelta(type: string): boolean {
  return type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta";
}

export function isAssistantTranscriptDone(type: string): boolean {
  return type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done";
}

export function isCandidateTranscriptDelta(type: string): boolean {
  return type === "conversation.item.input_audio_transcription.delta";
}

export function isCandidateTranscriptDone(type: string): boolean {
  return type === "conversation.item.input_audio_transcription.completed";
}

export function isCandidateTranscriptFailed(type: string): boolean {
  return type === "conversation.item.input_audio_transcription.failed";
}
