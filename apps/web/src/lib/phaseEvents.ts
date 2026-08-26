import type { PhaseEventKind, PhaseTimeline } from "@sdl/shared";

export type { PhaseEventKind, PhaseTimeline };

/** Body of `POST /interviews/:id/phase-events`. */
export type PhaseEventBody = {
  phaseId: string;
  phaseIndex: number;
  kind: PhaseEventKind;
  /** Client-accumulated seconds in the phase. The server clamps this. */
  elapsedSec: number;
};

export type PhaseEventPoster = (body: PhaseEventBody) => Promise<unknown>;

/**
 * Post one phase event, swallowing every failure.
 *
 * This is telemetry sitting directly behind the Start / Next / Reset buttons,
 * so it must be impossible for it to interfere with them: a dead network, a
 * 409 on a completed interview, or a server 500 all resolve to `false` and
 * nothing else. `localStorage` remains the source of truth for the live timer,
 * which is why dropping an event is a survivable outcome.
 *
 * Never throws and never rejects — callers can `void` it safely.
 */
export async function postPhaseEvent(
  post: PhaseEventPoster,
  body: PhaseEventBody
): Promise<boolean> {
  try {
    await post(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `exit` + `enter` pair emitted when the candidate advances a phase.
 *
 * Kept as a pure function so the ordering contract (leave the old phase before
 * joining the new one, and the new phase always starts at zero) is testable
 * without mounting the workspace.
 */
export function advanceEvents(input: {
  fromPhaseId: string;
  fromPhaseIndex: number;
  fromElapsedSec: number;
  toPhaseId: string;
  toPhaseIndex: number;
}): PhaseEventBody[] {
  return [
    {
      phaseId: input.fromPhaseId,
      phaseIndex: input.fromPhaseIndex,
      kind: "exit",
      elapsedSec: input.fromElapsedSec
    },
    {
      phaseId: input.toPhaseId,
      phaseIndex: input.toPhaseIndex,
      kind: "enter",
      elapsedSec: 0
    }
  ];
}
