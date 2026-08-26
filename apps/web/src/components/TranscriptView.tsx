import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

/**
 * Renders a conversation and owns its scroll behaviour. Nothing else.
 *
 * Extracted from `ChatPanel` so the voice surface can reuse it. The mechanics
 * here took real work to get right — the `ResizeObserver` auto-pin that survives
 * per-token markdown reflow, the memoised bubble that stops a streaming answer
 * re-parsing the whole transcript's KaTeX, the provisional fence-closing that
 * keeps half-written markdown from reflowing violently — and a second copy of
 * them for voice would drift.
 *
 * Deliberately has no idea where messages come from: `ChatPanel` streams them
 * over SSE from a typed request, `VoicePanel` receives them as speech.
 */

/** LaTeX-ish commands the model tends to emit. Used to detect "bare-bracket"
 * math like `[ 295 \text{ bytes} \times 100,000 ]` (no `$$` delimiters and
 * no `\[ \]` escapes) so we can wrap it for KaTeX. */
const LATEX_COMMAND_PATTERN =
  /\\(?:text|times|div|approx|frac|sum|int|sqrt|cdot|to|leq|geq|neq|le|ge|ne|pm|infty|alpha|beta|gamma|delta|theta|lambda|mu|sigma|pi|log|ln|max|min|left|right)\b/;

/** Normalizes the various ways an LLM tends to emit math so that
 * `remark-math` + `rehype-katex` actually render it. We:
 *  - convert proper LaTeX `\[ \]` / `\( \)` to `$$...$$` / `$...$`
 *  - wrap bare `[ ... ]` blocks that clearly contain LaTeX commands
 *  - leave fenced code blocks and inline code untouched
 */
export function normalizeMathDelimiters(text: string): string {
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
export function closeOpenMarkdown(text: string): string {
  let out = text;
  const fences = (out.match(/```/g) ?? []).length;
  if (fences % 2 === 1) out += "\n```";
  const inlineTicks = (out.replace(/```/g, "").match(/`/g) ?? []).length;
  if (inlineTicks % 2 === 1) out += "`";
  const blockMath = (out.match(/\$\$/g) ?? []).length;
  if (blockMath % 2 === 1) out += "$$";
  return out;
}

export type Msg = { role: "user" | "assistant"; content: string };

/** A turn still being produced — a streaming reply, or speech in progress.
 * Rendered after `messages` and visually de-emphasised while `provisional`,
 * because its text will be revised. */
export type LiveTurn = {
  key: string;
  role: "user" | "assistant";
  content: string;
  provisional?: boolean;
  interrupted?: boolean;
};

type Props = {
  messages: Msg[];
  live?: LiveTurn[];
  /** Index into `messages` of an assistant bubble currently streaming. */
  streamingIndex?: number;
  /** Index into `messages` of an assistant bubble awaiting its first token. */
  thinkingIndex?: number;
  error?: string | null;
  onRetry?: () => void;
  emptyState?: React.ReactNode;
  /** Changing this lands the view at the bottom — a conversation switch. */
  resetKey?: string;
};

export function TranscriptView({
  messages,
  live,
  streamingIndex = -1,
  thinkingIndex = -1,
  error,
  onRetry,
  emptyState,
  resetKey
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** True when the user is pinned at (or near) the bottom of the chat. We only
   * auto-scroll while this is true, so that scrolling up to re-read history
   * isn't yanked back down on every streamed token. Tracked in a ref so the
   * ResizeObserver below can read the latest value without re-binding. */
  const stickToBottomRef = useRef(true);
  /** Suppresses the next user-driven scroll event so programmatic scrolls
   * (auto-pin to bottom) don't accidentally flip stickToBottomRef off. */
  const suppressScrollRef = useRef(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

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
  }, [pinToBottom, resetKey]);

  useEffect(() => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [resetKey]);

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

  const isEmpty = messages.length === 0 && (live?.length ?? 0) === 0;

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="surface-inset flex-1 overflow-y-auto overscroll-contain p-3"
      >
        <div ref={contentRef} className="flex min-h-full flex-col gap-2">
          {isEmpty ? emptyState ?? null : null}

          {messages.map((msg, idx) => (
            <MessageBubble
              key={idx}
              role={msg.role}
              content={msg.content}
              streaming={idx === streamingIndex}
              thinking={idx === thinkingIndex}
            />
          ))}

          {(live ?? []).map((turn) => (
            <MessageBubble
              key={turn.key}
              role={turn.role}
              content={turn.content}
              streaming={turn.provisional === true}
              thinking={false}
              provisional={turn.provisional === true}
              interrupted={turn.interrupted === true}
            />
          ))}

          {error ? (
            <div
              role="alert"
              className="mr-auto flex max-w-[92%] flex-wrap items-center gap-2 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-fg"
            >
              <WarningIcon />
              <span className="text-fg-muted">{error}</span>
              {onRetry ? (
                <button
                  type="button"
                  onClick={onRetry}
                  className="rounded-lg border border-line bg-surface px-2 py-0.5 font-medium transition hover:border-violet-400/50"
                >
                  Retry
                </button>
              ) : null}
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
    </>
  );
}

/** Memoized so a streaming answer only re-renders its own bubble. Without
 * this, every buffered flush re-parses the markdown + KaTeX of the entire
 * transcript, which is what makes long conversations stutter. */
export const MessageBubble = memo(function MessageBubble({
  role,
  content,
  streaming,
  thinking,
  provisional = false,
  interrupted = false
}: {
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
  thinking: boolean;
  provisional?: boolean;
  interrupted?: boolean;
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
      <div
        className={[
          role === "user" ? "bubble bubble-user" : "bubble bubble-assistant",
          // Speech still being transcribed will be revised, so it reads as
          // tentative rather than as something the candidate actually committed
          // to saying.
          provisional ? "opacity-70" : ""
        ]
          .filter(Boolean)
          .join(" ")}
      >
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
        {interrupted ? (
          <p className="mt-1 text-[10px] uppercase tracking-wide text-fg-faint">
            interrupted
          </p>
        ) : null}
      </div>
    </div>
  );
});

export function TypingDots() {
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

function WarningIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-rose-500">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </svg>
  );
}
