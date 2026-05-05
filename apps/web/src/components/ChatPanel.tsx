import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { streamEndpoint } from "../lib/api";

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

type Props = {
  endpoint: string;
  payload?: Record<string, unknown>;
  /** Called right before each send. May be async so callers can do lazy work
   * such as capturing a fresh whiteboard screenshot. */
  buildPayload?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  initialMessages?: Msg[];
  onMessageComplete?: () => void | Promise<void>;
};

type Msg = { role: "user" | "assistant"; content: string };

export function ChatPanel({
  endpoint,
  payload,
  buildPayload,
  initialMessages,
  onMessageComplete
}: Props) {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Msg[]>(initialMessages ?? []);
  const [loading, setLoading] = useState(false);
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

  useEffect(() => {
    setMessages(initialMessages ?? []);
    // A new conversation (endpoint switch) or fresh history load should land
    // the user at the bottom regardless of where they were in the previous one.
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [initialMessages, endpoint]);

  /** Pin the scroll container to the bottom in a single paint. Auto-pins use
   * `instant` to avoid stuttering during token streaming; the explicit jump
   * button uses smooth elsewhere. */
  function pinToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    suppressScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    // Clear suppression on the next frame, after the scroll event has fired.
    requestAnimationFrame(() => {
      suppressScrollRef.current = false;
    });
  }

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
  }, []);

  // Initial mount / conversation switch: land at the bottom synchronously.
  useLayoutEffect(() => {
    if (stickToBottomRef.current) pinToBottom();
  }, [endpoint]);

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

  async function send() {
    if (!message.trim() || loading) return;

    const userMessage = message;
    setMessage("");
    // Sending a new message always re-engages stick-to-bottom: the user expects
    // to see what they just typed, even if they had scrolled up earlier.
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    setLoading(true);

    try {
      const currentPayload = buildPayload ? await buildPayload() : payload ?? {};
      await streamEndpoint(endpoint, { ...currentPayload, content: userMessage }, (token) => {
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.length - 1;
          if (idx >= 0 && next[idx].role === "assistant") {
            next[idx] = { ...next[idx], content: next[idx].content + token };
          }
          return next;
        });
      });
      await onMessageComplete?.();
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

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
            <div
              key={idx}
              className={`flex w-full ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div className={msg.role === "user" ? "bubble bubble-user" : "bubble bubble-assistant"}>
                <div
                  className={
                    msg.role === "user"
                      ? "prose-chat prose-chat-compact break-words whitespace-pre-wrap"
                      : "prose-chat prose-chat-compact break-words"
                  }
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                  >
                    {msg.role === "assistant"
                      ? normalizeMathDelimiters(
                          msg.content || (loading ? "..." : "")
                        )
                      : msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          ))}
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

      <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-2 transition focus-within:border-violet-400/50">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type your message..."
          rows={1}
          className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-faint"
        />
        <button
          onClick={() => void send()}
          className="btn-primary !px-3.5 !py-2"
          disabled={loading || !message.trim()}
          aria-label="Send"
        >
          {loading ? <Spinner /> : <SendIcon />}
        </button>
      </div>
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

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="animate-spin">
      <path d="M21 12a9 9 0 1 1-6.2-8.55" />
    </svg>
  );
}
