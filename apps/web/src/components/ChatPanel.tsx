import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { StreamError, streamEndpoint } from "../lib/api";

/** LaTeX-ish commands the model tends to emit. Used to detect "bare-bracket"
 * math like `[ 295 \text{ bytes} \times 100,000 ]` (no `$$` delimiters and
 * no `\[ \]` escapes) so we can wrap it for KaTeX. */
const LATEX_COMMAND_PATTERN =
  /\\(?:text|times|div|approx|frac|sum|int|sqrt|cdot|to|leq|geq|neq|le|ge|ne|pm|infty|alpha|beta|gamma|delta|theta|lambda|mu|sigma|pi|log|ln|max|min|left|right)\b/;

/** How long tokens are buffered before being committed to React state.
 * Re-parsing markdown + KaTeX on every token makes long answers crawl; one
 * commit per frame-ish interval streams just as smoothly for a fraction of
 * the work. */
const FLUSH_INTERVAL_MS = 60;

/** Normalizes the various ways an LLM tends to emit math so that
 * `remark-math` + `rehype-katex` actually render it. We:
 *  - convert proper LaTeX `\[ \]` / `\( \)` to `$$...$$` / `$...$`
 *  - wrap bare `[ ... ]` blocks that clearly contain LaTeX commands
 *  - leave fenced code blocks and inline code untouched
 */
function normalizeMathDelimiters(text: string): string {
  // Split out fenced (```...```) and inline (`...`) code so we don't touch
  // brackets the user actually wants verbatim.
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments
    .map((segment, idx) => {
      if (idx % 2 === 1) return segment; // code block / inline code, leave alone
      return segment
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, inner) => `$$${inner}$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_match, inner) => `$${inner}$`)
        .replace(/\[\s*([^\[\]\n]*?)\s*\](?!\()/g, (match, inner: string) => {
          // Only treat as math if it contains a LaTeX command — otherwise the
          // user probably meant literal brackets (e.g. "[note]").
          return LATEX_COMMAND_PATTERN.test(inner) ? `$$${inner}$$` : match;
        });
    })
    .join("");
}

/** Half-written markdown reflows violently mid-stream: an unclosed ``` fence
 * makes the rest of the answer render as one giant code block until the
 * closing fence arrives, and a lone `$` swallows a paragraph into KaTeX.
 * Provisionally closing them keeps the streaming view stable. */
function closeOpenMarkdown(text: string): string {
  let out = text;
  const fences = (out.match(/```/g) ?? []).length;
  if (fences % 2 === 1) out += "\n```";
  const inlineTicks = (out.replace(/```/g, "").match(/`/g) ?? []).length;
  if (inlineTicks % 2 === 1) out += "`";
  const blockMath = (out.match(/\$\$/g) ?? []).length;
  if (blockMath % 2 === 1) out += "$$";
  return out;
}

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
};

type Msg = { role: "user" | "assistant"; content: string };

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
  disabledNotice
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
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
  /** True when the user is pinned at (or near) the bottom of the chat. We only
   * auto-scroll while this is true, so that scrolling up to re-read history
   * isn't yanked back down on every streamed token. Tracked in a ref so the
   * ResizeObserver below can read the latest value without re-binding. */
  const stickToBottomRef = useRef(true);
  /** Suppresses the next user-driven scroll event so programmatic scrolls
   * (auto-pin to bottom) don't accidentally flip stickToBottomRef off. */
  const suppressScrollRef = useRef(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

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
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
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

  /** Pin the scroll container to the bottom in a single paint. Auto-pins use
   * `instant` to avoid stuttering during token streaming; the explicit jump
   * button uses smooth elsewhere. */
  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    suppressScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    // Clear suppression on the next frame, after the scroll event has fired.
    requestAnimationFrame(() => {
      suppressScrollRef.current = false;
    });
  }, []);

  // Re-pin to bottom whenever the chat content height changes (token streaming,
  // markdown reflow, image loads, etc.). Driving auto-scroll off the actual DOM
  // size — instead of React state — avoids the per-token jitter where
  // `scrollTop = scrollHeight` lands on a stale height.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) pinToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [pinToBottom]);

  // Initial mount / conversation switch: land at the bottom synchronously.
  useLayoutEffect(() => {
    if (stickToBottomRef.current) pinToBottom();
  }, [endpoint, pinToBottom]);

  function handleScroll() {
    if (suppressScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 80;
    stickToBottomRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
  }

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
      stickToBottomRef.current = true;
      setShowJumpToBottom(false);
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
    [buildPayload, disabled, endpoint, flushPending, onMessageComplete, payload, queueToken]
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

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="surface-inset flex-1 overflow-y-auto overscroll-contain p-3"
      >
        <div ref={contentRef} className="flex min-h-full flex-col gap-2">
          {messages.length === 0 ? (
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
          ) : null}

          {messages.map((msg, idx) => (
            <MessageBubble
              key={idx}
              role={msg.role}
              content={msg.content}
              streaming={loading && idx === lastIndex && msg.role === "assistant"}
              thinking={waitingForFirstToken && idx === lastIndex && msg.role === "assistant"}
            />
          ))}

          {error ? (
            <div
              role="alert"
              className="mr-auto flex max-w-[92%] flex-wrap items-center gap-2 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-fg"
            >
              <WarningIcon />
              <span className="text-fg-muted">{error}</span>
              <button
                type="button"
                onClick={() => {
                  const content = retryContentRef.current;
                  setError(null);
                  if (content) void send(content);
                }}
                className="rounded-lg border border-line bg-surface px-2 py-0.5 font-medium transition hover:border-violet-400/50"
              >
                Retry
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {showJumpToBottom ? (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-20 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-fg shadow-md transition hover:border-violet-400/50"
          aria-label="Jump to latest message"
        >
          ↓ New messages
        </button>
      ) : null}

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

/** Memoized so a streaming answer only re-renders its own bubble. Without
 * this, every buffered flush re-parses the markdown + KaTeX of the entire
 * transcript, which is what makes long conversations stutter. */
const MessageBubble = memo(function MessageBubble({
  role,
  content,
  streaming,
  thinking
}: {
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
  thinking: boolean;
}) {
  const rendered = useMemo(() => {
    if (role === "user") return content;
    const normalized = normalizeMathDelimiters(content);
    return streaming ? closeOpenMarkdown(normalized) : normalized;
  }, [content, role, streaming]);

  if (role === "assistant" && thinking) {
    return (
      <div className="flex w-full justify-start">
        <div className="bubble bubble-assistant" role="status" aria-label="Assistant is replying">
          <TypingDots />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex w-full ${role === "user" ? "justify-end" : "justify-start"}`}>
      <div className={role === "user" ? "bubble bubble-user" : "bubble bubble-assistant"}>
        <div
          className={[
            "prose-chat prose-chat-compact break-words",
            role === "user" ? "whitespace-pre-wrap" : "",
            streaming ? "prose-chat-streaming" : ""
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
            {rendered}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
});

function TypingDots() {
  return (
    <span className="flex items-center gap-1 py-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-current opacity-40 animate-typing-dot"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
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

function WarningIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-rose-500">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  );
}
