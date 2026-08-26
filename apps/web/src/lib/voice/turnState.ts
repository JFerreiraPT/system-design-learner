import type { VoiceTurnState } from "@sdl/shared";
import { isSpeakingSignal, type TimedEvent } from "./types.js";

/**
 * Whose turn it is, derived from data-channel events.
 *
 * A pure reducer, deliberately: this is the piece most likely to be wrong in a
 * way that only shows up as "the interviewer keeps cutting me off", and that
 * class of bug is untestable through a live WebRTC connection.
 *
 * The load-bearing rule is that `input_audio_buffer.speech_stopped` does NOT
 * end the candidate's turn. Under semantic VAD, speech stops and resumes inside
 * a single turn all the time — the candidate is drawing, or thinking, or
 * trailing off before picking the thought back up. Only `committed` (the
 * server's own decision that the turn is over) moves us on. A UI that flickers
 * to "thinking" on every pause tells the candidate they are being interrupted
 * even when they are not, which is worse than showing nothing.
 */
export type TurnMachine = {
  state: VoiceTurnState;
  /** Set while the interviewer is speaking, so an interruption can truncate the
   * right conversation item. Without this the model believes it delivered a
   * sentence the candidate never heard, and refers back to it. */
  speakingItemId: string | null;
  /** When the interviewer started speaking. The truncation point is derived
   * from elapsed wall-clock, which is the only measure available over WebRTC
   * where audio bypasses the data channel entirely. */
  speakingSinceMs: number | null;
  /** Audio the candidate actually heard from the current item, in ms. */
  playedMs: number;
  /** Last event that changed anything, for debugging a live session. */
  lastEventType: string | null;
};

export const INITIAL_TURN_MACHINE: TurnMachine = {
  state: "idle",
  speakingItemId: null,
  speakingSinceMs: null,
  playedMs: 0,
  lastEventType: null
};

/** Local (non-server) transitions: connection lifecycle and the hold control. */
export type TurnCommand =
  | { kind: "connected" }
  | { kind: "closed" }
  | { kind: "hold" }
  | { kind: "release" };

export function applyCommand(machine: TurnMachine, command: TurnCommand): TurnMachine {
  switch (command.kind) {
    case "connected":
      return machine.state === "idle" ? { ...machine, state: "listening" } : machine;
    case "closed":
      return { ...INITIAL_TURN_MACHINE, lastEventType: machine.lastEventType };
    case "hold":
      // Holding while the interviewer is mid-sentence is not a hold, it is a
      // barge-in; leave the state alone so the caller still truncates.
      return machine.state === "interviewerSpeaking" ? machine : { ...machine, state: "held" };
    case "release":
      return machine.state === "held" ? { ...machine, state: "listening" } : machine;
    default:
      return machine;
  }
}

export function reduceTurn(machine: TurnMachine, timed: TimedEvent): TurnMachine {
  const { event, atMs } = timed;
  const type = event.type;
  const tagged = { ...machine, lastEventType: type };

  // Held means the mic track is disabled, so no speech events should arrive at
  // all — but a queued frame can land just after. Ignoring them keeps the hold
  // honest rather than flickering out of it.
  if (machine.state === "held" && type.startsWith("input_audio_buffer.")) return tagged;

  switch (true) {
    case type === "session.created" || type === "session.updated":
      return machine.state === "idle" ? { ...tagged, state: "listening" } : tagged;

    case type === "input_audio_buffer.speech_started":
      // Speech during the interviewer's turn is a barge-in. The caller reads
      // `speakingItemId` / `playedMs` off the PREVIOUS state to truncate, so
      // those are cleared only here, after they have been observed.
      return {
        ...tagged,
        state: "candidateSpeaking",
        speakingItemId: null,
        speakingSinceMs: null,
        playedMs:
          machine.state === "interviewerSpeaking" && machine.speakingSinceMs !== null
            ? Math.max(0, atMs - machine.speakingSinceMs)
            : machine.playedMs
      };

    // Deliberately NOT a transition. See the note above.
    case type === "input_audio_buffer.speech_stopped":
      return tagged;

    case type === "input_audio_buffer.committed":
      return { ...tagged, state: "thinking" };

    case type === "response.created":
      // Only from a settled state: a response created while the candidate is
      // still talking (the model deciding to interject) must not blank the
      // "you're speaking" indicator.
      return machine.state === "candidateSpeaking" ? tagged : { ...tagged, state: "thinking" };

    case isSpeakingSignal(type):
      if (machine.state === "interviewerSpeaking") {
        return { ...tagged, speakingItemId: machine.speakingItemId ?? event.item_id ?? null };
      }
      return {
        ...tagged,
        state: "interviewerSpeaking",
        speakingItemId: event.item_id ?? null,
        speakingSinceMs: atMs,
        playedMs: 0
      };

    case type === "response.done" ||
      type === "output_audio_buffer.stopped" ||
      type === "response.output_audio.done" ||
      type === "response.audio.done":
      return {
        ...tagged,
        state: "listening",
        speakingItemId: null,
        speakingSinceMs: null,
        playedMs:
          machine.speakingSinceMs !== null
            ? Math.max(0, atMs - machine.speakingSinceMs)
            : machine.playedMs
      };

    default:
      return tagged;
  }
}

/**
 * Truncation target for a barge-in, or null when there is nothing to truncate.
 *
 * Read against the state BEFORE the interrupting event is reduced. The number
 * is elapsed playback time: over WebRTC the audio never touches the data
 * channel, so wall-clock since the first spoken word is the only measure of
 * what the candidate actually heard.
 */
export function truncationTarget(
  machine: TurnMachine,
  atMs: number
): { itemId: string; audioEndMs: number } | null {
  if (machine.state !== "interviewerSpeaking") return null;
  if (!machine.speakingItemId || machine.speakingSinceMs === null) return null;
  return {
    itemId: machine.speakingItemId,
    audioEndMs: Math.max(0, Math.round(atMs - machine.speakingSinceMs))
  };
}

/** Plain-language label for the voice bar. Screen readers get this string in a
 * live region, so it has to stand alone without the surrounding colour. */
export function turnStateLabel(state: VoiceTurnState): string {
  switch (state) {
    case "listening":
      return "Listening";
    case "candidateSpeaking":
      return "You're speaking";
    case "thinking":
      return "Thinking";
    case "interviewerSpeaking":
      return "Interviewer speaking";
    case "held":
      return "Held — mic off";
    default:
      return "Not connected";
  }
}
