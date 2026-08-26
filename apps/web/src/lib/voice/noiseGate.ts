/**
 * A noise gate on the candidate's microphone.
 *
 * Why this exists: `semantic_vad` has no loudness threshold. It decides *when a
 * turn ends*, not *whether a sound was speech* — so a chair scrape, a door, or a
 * cat opens a turn, the turn commits, `create_response` fires, and the
 * interviewer answers a noise. Raising `eagerness` makes it answer noise faster;
 * `server_vad` has a `threshold` but throws away the semantic pause tolerance
 * that lets a candidate think mid-sentence. Neither knob is the right tool.
 *
 * So the audio is gated before it ever reaches the model: below the gate, the
 * model hears digital silence and no turn can open at all.
 *
 * Three things make it work on real noise rather than just quiet noise:
 *
 *  - **Minimum duration.** A scrape or a thud is a transient, usually well under
 *    100ms. Requiring the level to *stay* up for `minOpenMs` rejects most
 *    impulsive noise regardless of how loud it was, which pure thresholding
 *    cannot do.
 *  - **Hysteresis + hold.** Once open it closes at a lower level, and only after
 *    `holdMs` of quiet, so word gaps and breaths do not chop speech into pieces.
 *  - **Lookahead.** The signal sent to the model is delayed by `lookaheadMs`
 *    while the decision is made on the live signal, so the gate is already open
 *    by the time the first syllable arrives. Without this every sentence loses
 *    its opening consonant — which reads as much worse transcription, not as a
 *    working gate.
 */

export type NoiseGateOptions = {
  /** RMS (0..1) the signal must exceed to be considered for opening. */
  openRms: number;
  /** Lower RMS it must fall below to start closing. Hysteresis. */
  closeRms: number;
  /** How long the level must stay above `openRms` before the gate opens. This
   * is the transient rejector. */
  minOpenMs: number;
  /** How long to stay open after dropping below `closeRms`. */
  holdMs: number;
};

export const DEFAULT_NOISE_GATE: NoiseGateOptions = {
  // Conversational speech at a normal distance sits well above this; room tone,
  // fan noise and distant movement sit below it.
  openRms: 0.055,
  closeRms: 0.035,
  // Long enough to reject a knock or a scrape, short enough that it costs no
  // perceptible latency once lookahead covers it.
  minOpenMs: 140,
  holdMs: 500
};

/** Delay applied to the transmitted signal so the gate opens ahead of speech.
 * Must exceed `minOpenMs` or the decision arrives after the audio it gates. */
export const GATE_LOOKAHEAD_MS = 200;

export type GateState = {
  open: boolean;
  /** When the level first rose above `openRms` in the current candidate burst,
   * or null when it is below. Drives the minimum-duration test. */
  risingSinceMs: number | null;
  /** When the level last fell below `closeRms` while open. Drives the hold. */
  fallingSinceMs: number | null;
};

export const INITIAL_GATE_STATE: GateState = {
  open: false,
  risingSinceMs: null,
  fallingSinceMs: null
};

/**
 * One gate decision. Pure, so the behaviour that matters — a transient must not
 * open it, a word gap must not close it — is testable without Web Audio.
 */
export function stepGate(
  state: GateState,
  rms: number,
  nowMs: number,
  options: NoiseGateOptions = DEFAULT_NOISE_GATE
): GateState {
  if (!state.open) {
    if (rms < options.openRms) {
      // Dropped back down before qualifying: whatever it was, it was a
      // transient, and the candidate burst it might have started is abandoned.
      return state.risingSinceMs === null ? state : { ...state, risingSinceMs: null };
    }
    const risingSinceMs = state.risingSinceMs ?? nowMs;
    if (nowMs - risingSinceMs < options.minOpenMs) {
      return { ...state, risingSinceMs };
    }
    return { open: true, risingSinceMs, fallingSinceMs: null };
  }

  // Open.
  if (rms >= options.closeRms) {
    return state.fallingSinceMs === null ? state : { ...state, fallingSinceMs: null };
  }
  const fallingSinceMs = state.fallingSinceMs ?? nowMs;
  if (nowMs - fallingSinceMs < options.holdMs) {
    return { ...state, fallingSinceMs };
  }
  return { open: false, risingSinceMs: null, fallingSinceMs: null };
}

/** RMS of a time-domain buffer, normalised to 0..1. */
export function rmsOf(samples: Uint8Array): number {
  let sum = 0;
  for (const sample of samples) {
    const centred = (sample - 128) / 128;
    sum += centred * centred;
  }
  return Math.sqrt(sum / samples.length);
}

export type NoiseGate = {
  /** The gated stream to send to the peer connection. */
  stream: MediaStream;
  /** Whether audio is currently passing. */
  isOpen: () => boolean;
  /** Live input level (0..1, scaled for display), taken pre-gate so the meter
   * still moves when the gate is shut — otherwise a candidate whose voice is
   * being gated out sees a dead meter and no explanation. */
  level: () => number;
  setEnabled: (enabled: boolean) => void;
  dispose: () => Promise<void>;
};

/**
 * Build the gate. Returns null when Web Audio is unavailable, so the caller can
 * fall back to the raw microphone — an ungated session is worse, not broken.
 */
export function createNoiseGate(
  source: MediaStream,
  options: NoiseGateOptions = DEFAULT_NOISE_GATE
): NoiseGate | null {
  try {
    const ctx = new AudioContext();
    const input = ctx.createMediaStreamSource(source);

    // Decision is made on the live signal; transmission is delayed, so the gain
    // ramp lands before the audio it applies to.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    input.connect(analyser);

    const delay = ctx.createDelay(1);
    delay.delayTime.value = GATE_LOOKAHEAD_MS / 1000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const destination = ctx.createMediaStreamDestination();
    input.connect(delay);
    delay.connect(gain);
    gain.connect(destination);

    const buffer = new Uint8Array(analyser.frequencyBinCount);
    let state = INITIAL_GATE_STATE;
    let enabled = true;
    let lastLevel = 0;
    let raf: number | null = null;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      analyser.getByteTimeDomainData(buffer);
      const rms = rmsOf(buffer);
      lastLevel = Math.min(1, rms * 4);

      const next = enabled ? stepGate(state, rms, now, options) : INITIAL_GATE_STATE;
      if (next.open !== state.open) {
        // Short ramps rather than a hard switch: an instantaneous gain step is
        // an audible click, and a click is exactly the kind of transient the
        // model might treat as speech.
        const target = next.open ? 1 : 0;
        gain.gain.cancelScheduledValues(ctx.currentTime);
        gain.gain.setTargetAtTime(target, ctx.currentTime, next.open ? 0.01 : 0.05);
      }
      state = next;
    };
    raf = requestAnimationFrame(tick);

    return {
      stream: destination.stream,
      isOpen: () => state.open,
      level: () => lastLevel,
      setEnabled: (value: boolean) => {
        enabled = value;
        if (!value) {
          // Bypassed: pass everything through untouched.
          gain.gain.cancelScheduledValues(ctx.currentTime);
          gain.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
          state = { ...INITIAL_GATE_STATE, open: true };
        }
      },
      dispose: async () => {
        if (raf !== null) cancelAnimationFrame(raf);
        try {
          input.disconnect();
          delay.disconnect();
          gain.disconnect();
        } catch {
          /* already torn down */
        }
        await ctx.close().catch(() => {});
      }
    };
  } catch {
    return null;
  }
}
