import { useCallback, useMemo, useRef, useState } from "react";
import type { SceneSummary } from "@sdl/shared";
import { ChatPanel, type Msg } from "./ChatPanel";
import { VoiceBar } from "./VoiceBar";
import { useRealtimeVoice } from "../lib/voice/useRealtimeVoice";
import type { ContextSnapshot } from "../lib/voice/contextFeed";

/**
 * The Interview tab's conversation surface, in either modality.
 *
 * Voice and text share ONE transcript and one panel rather than living in
 * separate tabs, for a reason that only shows up in use: candidates say "the id
 * looks like this" and then type it. Mixed input is the realistic mode, not a
 * fallback — so the composer stays live throughout a voice session and a typed
 * message lands in the same transcript through the existing text path.
 *
 * The realtime session is opened here rather than in `WorkspacePage` so the
 * page does not grow a WebRTC lifecycle on top of everything else it owns.
 */

type Props = {
  interviewId: string;
  endpoint: string;
  initialMessages: Msg[];
  buildPayload: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  onMessageComplete: () => void | Promise<void>;
  disabled?: boolean;
  disabledNotice?: string;
  /** Live workspace state for the context feed. Read on a timer while a voice
   * session is open, so it must stay cheap. */
  scene?: SceneSummary;
  constraints: string[];
  phaseLabel?: string;
  /** Candidate estimation figures. Changes are pushed into a live session, so a
   * number typed mid-interview can actually be challenged. */
  estimation?: Record<string, unknown>;
  /** Full workspace context for the session mint — see `buildMintContext` on
   * the hook for why this is separate from the delta snapshot. */
  buildMintContext: () => Promise<Record<string, unknown>>;
  /** Called after spoken turns are persisted, so the page can refetch history,
   * constraints, criteria and the phase proposal — the same post-turn refresh
   * the text path performs. */
  onVoiceTurnsPersisted: () => void;
};

export function VoicePanel({
  interviewId,
  endpoint,
  initialMessages,
  buildPayload,
  onMessageComplete,
  disabled = false,
  disabledNotice,
  scene,
  constraints,
  phaseLabel,
  estimation,
  buildMintContext,
  onVoiceTurnsPersisted
}: Props) {
  const [mode, setMode] = useState<"text" | "voice">("text");

  // The hook polls this on a timer; a ref keeps it current without making the
  // whole session depend on a new callback identity every render.
  const snapshotRef = useRef<ContextSnapshot>({ constraints });
  snapshotRef.current = { scene, constraints, phaseLabel, estimation };
  const snapshot = useCallback(() => snapshotRef.current, []);

  // Same trick for the mint builder: the page rebuilds it every render.
  const mintRef = useRef(buildMintContext);
  mintRef.current = buildMintContext;

  const session = useRealtimeVoice({
    interviewId,
    snapshot,
    buildMintContext: useCallback(() => mintRef.current(), []),
    onTurnsPersisted: onVoiceTurnsPersisted,
    onClosed: onVoiceTurnsPersisted
  });

  const liveTurns = useMemo(
    () =>
      session.liveTurns.map((turn) => ({
        key: turn.externalId,
        role: turn.role,
        content: turn.content,
        provisional: turn.provisional,
        interrupted: turn.interrupted
      })),
    [session.liveTurns]
  );

  const showVoice = mode === "voice" && !disabled;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {!disabled ? (
        <div className="flex items-center gap-1 self-start rounded-xl border border-line bg-surface p-0.5">
          {(["text", "voice"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              onClick={() => {
                if (option === "text" && session.status === "live") session.stop();
                setMode(option);
              }}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                mode === option
                  ? "bg-violet-500/15 text-fg"
                  : "text-fg-faint hover:text-fg-muted"
              }`}
            >
              {option === "text" ? "Text" : "Voice"}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <ChatPanel
          endpoint={endpoint}
          initialMessages={initialMessages}
          buildPayload={buildPayload}
          onMessageComplete={onMessageComplete}
          disabled={disabled}
          disabledNotice={disabledNotice}
          // Speech in progress renders in the shared transcript. Persistence is
          // the hook's job, off its own buffered turns — never off what is on
          // screen.
          liveTurns={showVoice ? liveTurns : undefined}
          toolbar={
            showVoice ? (
              <VoiceBar
                session={session}
                onExit={() => {
                  session.stop();
                  setMode("text");
                }}
              />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
