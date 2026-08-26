import { useEffect, useRef } from "react";
import { turnStateLabel } from "../lib/voice/turnState";
import { formatDuration, formatUsd } from "../lib/voice/costMeter";
import type { VoiceSessionView } from "../lib/voice/useRealtimeVoice";

/**
 * Controls and state for a live spoken interview.
 *
 * Two things this has to get right, both invisible in a screenshot:
 *
 *  - **Reserved height.** The workspace is a dense resizable-panel layout, and a
 *    bar that appears (or whose status text changes length) must not shift the
 *    board or the transcript under the candidate's cursor.
 *  - **Announced state.** A colour-changing pill tells a screen-reader user
 *    nothing, so the turn state also lives in a polite live region — that is the
 *    only channel through which "you're speaking" reaches them.
 */

type Props = {
  session: VoiceSessionView;
  /** Leaving voice entirely, back to the text composer. */
  onExit: () => void;
};

export function VoiceBar({ session, onExit }: Props) {
  const {
    status,
    turnState,
    micLevel,
    muted,
    held,
    error,
    transcriptWarning,
    elapsedSeconds,
    estimatedUsd,
    maxSessionSeconds,
    ceilingWarning,
    start,
    stop,
    setMuted,
    setHeld,
    goAhead
  } = session;

  const live = status === "live";
  const remaining = Math.max(0, maxSessionSeconds - elapsedSeconds);

  // Space holds the mic, the way push-to-talk works everywhere else — but only
  // when the candidate is not typing, or it would swallow spaces in the
  // composer and in the board's own text tools.
  const heldByKeyRef = useRef(false);
  useEffect(() => {
    if (!live) return;
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || typing(e.target)) return;
      e.preventDefault();
      heldByKeyRef.current = true;
      setHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !heldByKeyRef.current) return;
      e.preventDefault();
      heldByKeyRef.current = false;
      setHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [live, setHeld]);

  return (
    // min-h reserves the bar's height so nothing below it moves when the status
    // text changes length or a warning appears.
    <div className="flex min-h-[6.5rem] flex-col gap-2 rounded-2xl border border-line bg-surface p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={status} turnState={turnState} />

        {/* The state also has to be readable, not just visible. */}
        <p aria-live="polite" className="sr-only">
          {live ? turnStateLabel(held ? "held" : turnState) : voiceStatusLabel(status)}
        </p>

        {live ? <MicMeter level={muted || held ? 0 : micLevel} muted={muted || held} /> : null}

        <div className="ml-auto flex items-center gap-2 text-[11px] text-fg-faint">
          {live ? (
            <span title="Estimated — based on published audio rates, not a bill.">
              {formatDuration(elapsedSeconds)} · ~{formatUsd(estimatedUsd)}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {live ? (
          <>
            <button
              type="button"
              aria-pressed={held}
              onPointerDown={() => setHeld(true)}
              onPointerUp={() => setHeld(false)}
              onPointerLeave={() => {
                if (held) setHeld(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setHeld(!held);
                }
              }}
              title="Hold to think without the interviewer jumping in (or hold Space)"
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                held
                  ? "border-amber-400/60 bg-amber-400/15 text-fg"
                  : "border-line bg-surface text-fg-muted hover:border-violet-400/50"
              }`}
            >
              {held ? "Holding…" : "Hold to think"}
            </button>

            <button
              type="button"
              onClick={goAhead}
              disabled={turnState !== "candidateSpeaking"}
              title="You've finished — hand it back to the interviewer"
              className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg-muted transition hover:border-violet-400/50 disabled:opacity-40"
            >
              Go ahead
            </button>

            <button
              type="button"
              aria-pressed={muted}
              onClick={() => setMuted(!muted)}
              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                muted
                  ? "border-rose-400/60 bg-rose-400/15 text-fg"
                  : "border-line bg-surface text-fg-muted hover:border-violet-400/50"
              }`}
            >
              {muted ? "Unmute" : "Mute"}
            </button>

            <button
              type="button"
              onClick={stop}
              className="ml-auto rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg-muted transition hover:border-rose-400/60 hover:text-fg"
            >
              End voice
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={start}
              disabled={status === "connecting" || status === "reconnecting"}
              className="btn-primary !px-3 !py-1 !text-xs disabled:opacity-60"
            >
              {status === "connecting"
                ? "Connecting…"
                : status === "reconnecting"
                  ? "Reconnecting…"
                  : "Start voice"}
            </button>
            <button
              type="button"
              onClick={onExit}
              className="rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-fg-muted transition hover:border-violet-400/50"
            >
              Back to typing
            </button>
            {/* The one failure browser echo cancellation cannot win: on
                speakers, the interviewer's own voice returns through the mic,
                turn detection reads it as the candidate, and it interrupts
                itself in a loop. Stated once, before starting, rather than
                nagged about during the session. */}
            <span className="text-[11px] text-fg-faint">
              Use headphones — on speakers the interviewer hears itself.
            </span>
          </>
        )}
      </div>

      {ceilingWarning && live ? (
        <p role="status" className="text-[11px] text-amber-500">
          {formatDuration(remaining)} of voice time left on this interview.
        </p>
      ) : null}

      {transcriptWarning ? (
        <p role="alert" className="text-[11px] text-rose-500">
          {transcriptWarning}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[11px] text-rose-500">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function StatusPill({
  status,
  turnState
}: {
  status: VoiceSessionView["status"];
  turnState: VoiceSessionView["turnState"];
}) {
  const label = status === "live" ? turnStateLabel(turnState) : voiceStatusLabel(status);
  const tone =
    status !== "live"
      ? "border-line text-fg-faint"
      : turnState === "candidateSpeaking"
        ? "border-emerald-400/60 text-emerald-500"
        : turnState === "interviewerSpeaking"
          ? "border-violet-400/60 text-violet-400"
          : turnState === "held"
            ? "border-amber-400/60 text-amber-500"
            : "border-line text-fg-muted";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${tone}`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full bg-current ${
          status === "live" && turnState !== "held" ? "animate-pulse" : ""
        }`}
      />
      {label}
    </span>
  );
}

/** The only honest answer to "is this thing hearing me?". */
function MicMeter({ level, muted }: { level: number; muted: boolean }) {
  const bars = 8;
  const lit = Math.round(level * bars);
  return (
    <span className="flex items-end gap-[2px]" aria-hidden title={muted ? "Mic off" : "Mic level"}>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-sm transition-[height,background-color] duration-75 ${
            i < lit ? "bg-emerald-400" : "bg-line"
          }`}
          style={{ height: `${5 + i * 1.6}px` }}
        />
      ))}
    </span>
  );
}

function voiceStatusLabel(status: VoiceSessionView["status"]): string {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "failed":
      return "Voice unavailable";
    case "closed":
      return "Voice ended";
    default:
      return "Voice off";
  }
}
