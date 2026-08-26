import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StreamError, streamEndpoint } from "../lib/api";
import { TranscriptView, type Msg } from "./TranscriptView";

/** How long tokens are buffered before being committed to React state.
 * Re-parsing markdown + KaTeX on every token makes long answers crawl; one
 * commit per frame-ish interval streams just as smoothly for a fraction of
 * the work. */
const FLUSH_INTERVAL_MS = 60;

type Props = {
  endpoint: string;
  payload?: Record<string, unknown>;
  /** Called right before each send. May be async so callers can do lazy work
   * such as capturing a fresh whiteboard screenshot. */
  buildPayload?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  initialMessages?: Msg[];
  onMessageComplete?: () => void | Promise<void>;
  /** Read-only mode: history stays visible, the composer does not. Used when
   * the conversation is closed (e.g. a completed interview) — hiding the input
   * is clearer than accepting a message the server will reject. */
  disabled?: boolean;
  /** Shown in place of the composer while `disabled`. */
  disabledNotice?: string;
  /** Extra turns to render after history — speech in progress from a live voice
   * session sharing this transcript. Display only; voice owns its persistence. */
  liveTurns?: React.ComponentProps<typeof TranscriptView>["live"];
  /** Rendered above the composer. The voice bar goes here. */
  toolbar?: React.ReactNode;
};

export type { Msg };

/** Cheap structural identity for a history array. Callers build
 * `initialMessages` inline (`.filter().map()`), so it is a new array on every
 * parent render — and `WorkspacePage` re-renders once a second for its phase
 * timer. Comparing content instead of reference is what stops that timer from
 * resetting the transcript (and wiping a stream in flight). */
function historySignature(messages: Msg[]): string {
  return messages.map((m) => `${m.role}:${m.content.length}`).join("|");
}

export function ChatPanel({
  endpoint,
  payload,
  buildPayload,
  initialMessages,
  onMessageComplete,
  disabled = false,
  disabledNotice,
  liveTurns,
  toolbar
}: Props) {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Msg[]>(initialMessages ?? []);
  const [loading, setLoading] = useState(false);
  /** Set once the request is in flight and the first token has yet to land —
   * drives the "thinking" indicator, which is distinct from "streaming". */
  const [waitingForFirstToken, setWaitingForFirstToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The last user message, kept so a failed send can be retried verbatim. */
  const retryContentRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Last endpoint this panel synced against — see the history effect below. */
  const endpointRef = useRef(endpoint);
  /** Tokens received since the last commit to React state, plus the timer that
   * will commit them. See FLUSH_INTERVAL_MS. */
  const pendingRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  /** True while a send is in flight. Read by the history-sync effect, which
   * must not clobber a partially streamed message with server history. */
  const streamingRef = useRef(false);
  /** Bumped whenever the view should re-engage stick-to-bottom. Passed to
   * `TranscriptView` as its reset key, which is where that state now lives.
   * Set in exactly the two places the pre-extraction code set it directly: a
   * conversation switch / history load, and sending a message. */
  const [pinToken, setPinToken] = useState(`${endpoint}|0`);
  const pinCounterRef = useRef(0);

  const bumpPin = useCallback(() => {
    pinCounterRef.current += 1;
    setPinToken(`${endpointRef.current}|${pinCounterRef.current}`);
  }, []);

  const incomingSignature = useMemo(
    () => historySignature(initialMessages ?? []),
    [initialMessages]
  );

  useEffect(() => {
    // Switching conversations cancels whatever was streaming in the old one —
    // its tokens belong to a transcript that is no longer on screen.
    if (endpointRef.current !== endpoint) {
      endpointRef.current = endpoint;
      abortRef.current?.abort();
      streamingRef.current = false;
      pendingRef.current = "";
    } else if (streamingRef.current) {
      // Never overwrite a stream in progress: the server history does not yet
      // contain the assistant turn being typed, so adopting it here would make
      // the answer disappear mid-sentence.
      return;
    }
    setMessages(initialMessages ?? []);
    setError(null);
    // A new conversation (endpoint switch) or fresh history load should land
    // the user at the bottom regardless of where they were in the previous one.
    bumpPin();
    // `incomingSignature` — not `initialMessages` — is the real dependency:
    // see historySignature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingSignature, endpoint]);

  // Abort any in-flight request and drop the pending flush on unmount so we
  // never setState against a dead component or leak a socket.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    },
    []
  );

  /** Commits buffered tokens onto the trailing assistant message. */
  const flushPending = useCallback(() => {
    flushTimerRef.current = null;
    const chunk = pendingRef.current;
    if (!chunk) return;
    pendingRef.current = "";
    setMessages((prev) => {
      const idx = prev.length - 1;
      if (idx < 0 || prev[idx].role !== "assistant") return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], content: next[idx].content + chunk };
      return next;
    });
  }, []);

  const queueToken = useCallback(
    (token: string) => {
      pendingRef.current += token;
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(flushPending, FLUSH_INTERVAL_MS);
      }
    },
    [flushPending]
  );

  function autoGrowTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  function stop() {
    abortRef.current?.abort();
  }

  const send = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (disabled || !trimmed || streamingRef.current) return;

      retryContentRef.current = trimmed;
      setError(null);
      // Sending a new message always re-engages stick-to-bottom: the user
      // expects to see what they just typed, even if they had scrolled up.
      bumpPin();
      setMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed },
        { role: "assistant", content: "" }
      ]);
      streamingRef.current = true;
      setLoading(true);
      setWaitingForFirstToken(true);

      const controller = new AbortController();
      abortRef.current = controller;

      let failed = false;
      let sawFirstToken = false;
      try {
        const currentPayload = buildPayload ? await buildPayload() : payload ?? {};
        await streamEndpoint(
          endpoint,
          { ...currentPayload, content: trimmed },
          (token) => {
            // Guarded so the buffered flush stays the only per-token work —
            // an unconditional setState here would schedule a render per token.
            if (!sawFirstToken) {
              sawFirstToken = true;
              setWaitingForFirstToken(false);
            }
            queueToken(token);
          },
          { signal: controller.signal }
        );
      } catch (err) {
        failed = true;
        setError(
          err instanceof StreamError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Something went wrong while streaming the reply."
        );
      } finally {
        // Commit any tokens still buffered before releasing the stream lock,
        // otherwise the tail of the answer is lost on a fast finish.
        if (flushTimerRef.current !== null) {
          window.clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        flushPending();
        abortRef.current = null;
        streamingRef.current = false;
        setLoading(false);
        setWaitingForFirstToken(false);
      }

      if (failed) {
        // Drop the empty placeholder — the error banner explains what happened
        // and offers a retry, which reads better than a blank bubble.
        setMessages((prev) =>
          prev.length > 0 && prev[prev.length - 1].role === "assistant" && !prev[prev.length - 1].content
            ? prev.slice(0, -1)
            : prev
        );
        return;
      }

      await onMessageComplete?.();
    },
    [bumpPin, buildPayload, disabled, endpoint, flushPending, onMessageComplete, payload, queueToken]
  );

  function submit() {
    const content = message;
    if (!content.trim() || loading) return;
    setMessage("");
    requestAnimationFrame(autoGrowTextarea);
    void send(content);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const lastIndex = messages.length - 1;
  const streamingIndex =
    loading && lastIndex >= 0 && messages[lastIndex].role === "assistant" ? lastIndex : -1;
  const thinkingIndex =
    waitingForFirstToken && lastIndex >= 0 && messages[lastIndex].role === "assistant"
      ? lastIndex
      : -1;

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2">
      <TranscriptView
        messages={messages}
        live={liveTurns}
        streamingIndex={streamingIndex}
        thinkingIndex={thinkingIndex}
        error={error}
        onRetry={() => {
          const content = retryContentRef.current;
          setError(null);
          if (content) void send(content);
        }}
        resetKey={pinToken}
        emptyState={<EmptyState />}
      />

      {toolbar}

      {disabled ? (
        <p
          role="status"
          className="rounded-2xl border border-line bg-surface px-3 py-2.5 text-xs text-fg-faint"
        >
          {disabledNotice ?? "This conversation is closed."}
        </p>
      ) : (
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-2 transition focus-within:border-violet-400/50">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              autoGrowTextarea();
            }}
            onKeyDown={onKeyDown}
            placeholder={loading ? "Waiting for the reply…" : "Type your message..."}
            rows={1}
            className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-faint"
          />
          {loading ? (
            <button
              type="button"
              onClick={stop}
              className="inline-grid h-9 w-9 place-items-center rounded-xl border border-line bg-surface text-fg-muted transition hover:border-rose-400/60 hover:text-fg"
              aria-label="Stop generating"
              title="Stop generating"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              onClick={submit}
              className="btn-primary !px-3.5 !py-2"
              disabled={!message.trim()}
              aria-label="Send"
            >
              <SendIcon />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <div className="brand-mark h-10 w-10">
        <ChatIcon />
      </div>
      <p className="text-sm text-fg-muted">Start the conversation</p>
      <p className="text-xs text-fg-faint">
        Press <kbd className="rounded bg-surface px-1.5 py-0.5 text-[10px]">Enter</kbd> to send,{" "}
        <kbd className="rounded bg-surface px-1.5 py-0.5 text-[10px]">Shift</kbd>+
        <kbd className="rounded bg-surface px-1.5 py-0.5 text-[10px]">Enter</kbd> for newline
      </p>
    </div>
  );
}

function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12c0 4.4-4 8-9 8a9.9 9.9 0 0 1-3.9-.8L3 21l1.8-4.6A8.4 8.4 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}
