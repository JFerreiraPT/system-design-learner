import { estimateVoiceCostUsd } from "@sdl/shared";
import type { VoiceTurnState } from "@sdl/shared";

/**
 * Elapsed time and estimated spend for a live voice session.
 *
 * Every other AI call in this product is bounded by a request. A voice session
 * bills for as long as its socket is open, so the candidate needs to be able to
 * see the meter running — that visibility is the point, not accounting
 * accuracy. The numbers are labelled as estimates in the UI.
 *
 * Heard and spoken time are tracked separately because they are priced
 * differently: output audio costs twice what input audio does.
 */

export type MeterState = {
  /** Seconds of candidate audio the model has heard. */
  heardSeconds: number;
  /** Seconds of interviewer audio spoken. */
  spokenSeconds: number;
  /** Wall-clock seconds the session has been open, including silence. */
  elapsedSeconds: number;
  /** Turn state the current accumulation is attributed to. */
  attributedTo: VoiceTurnState;
  /** When the current attribution began. */
  sinceMs: number;
};

export function initialMeter(nowMs: number, state: VoiceTurnState = "idle"): MeterState {
  return {
    heardSeconds: 0,
    spokenSeconds: 0,
    elapsedSeconds: 0,
    attributedTo: state,
    sinceMs: nowMs
  };
}

/**
 * Attribute the time since the last tick, then switch attribution.
 *
 * Called on every turn-state change and on a periodic tick, so a long silence
 * still advances `elapsedSeconds` (which is what the session ceiling counts)
 * without inflating either audio total.
 */
export function tickMeter(meter: MeterState, state: VoiceTurnState, nowMs: number): MeterState {
  const deltaSec = Math.max(0, (nowMs - meter.sinceMs) / 1000);

  // `held` is deliberately not counted as heard: the mic track is disabled, so
  // no audio is reaching the model and no audio is being billed.
  const heard = meter.attributedTo === "candidateSpeaking" ? deltaSec : 0;
  const spoken = meter.attributedTo === "interviewerSpeaking" ? deltaSec : 0;
  const openSession = meter.attributedTo !== "idle";

  return {
    heardSeconds: meter.heardSeconds + heard,
    spokenSeconds: meter.spokenSeconds + spoken,
    elapsedSeconds: meter.elapsedSeconds + (openSession ? deltaSec : 0),
    attributedTo: state,
    sinceMs: nowMs
  };
}

/** Audio seconds not yet reported to the server, for the persisted ceiling. */
export function billableSeconds(meter: MeterState): number {
  return meter.heardSeconds + meter.spokenSeconds;
}

export function meterCostUsd(meter: MeterState): number {
  return estimateVoiceCostUsd({
    heardSeconds: meter.heardSeconds,
    spokenSeconds: meter.spokenSeconds
  });
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Sub-cent spend still reads as a number rather than "$0.00", so the candidate
 * can tell the meter is live rather than broken. */
export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
