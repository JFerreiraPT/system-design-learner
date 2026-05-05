import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ValidationFeedback } from "../lib/api";
import { DIM_KEYS, DIM_LABELS, markdownFromFeedback } from "../lib/workspaceValidationUi";

export function DimensionBreakdown({
  feedback,
  small,
  className = ""
}: {
  feedback?: ValidationFeedback | null;
  small?: boolean;
  className?: string;
}) {
  const d = feedback?.dimensions;
  if (!d) return null;
  // Filter out null/undefined dimensions: a null score is the validator's
  // explicit "out of scope for this rubric" signal — surfacing a fake bar
  // here would mislead the candidate into thinking they were graded on it.
  const renderable = DIM_KEYS.filter((k) => typeof d[k] === "number");
  if (renderable.length === 0) return null;
  const notes = feedback?.dimensionNotes ?? {};
  return (
    <div className={`space-y-1.5 ${className}`}>
      {renderable.map((k) => {
        const v = d[k] as number;
        const note = notes[k];
        return (
          <div key={k}>
            <div className="flex justify-between text-[10px] text-fg-faint">
              <span>{DIM_LABELS[k] ?? k}</span>
              <span>{v}</span>
            </div>
            <div
              className={`overflow-hidden rounded-full bg-surface-inset ${small ? "h-1" : "h-1.5"}`}
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400"
                style={{ width: `${v}%` }}
              />
            </div>
            {note && !small ? (
              <p className="mt-0.5 text-[10px] leading-snug text-fg-faint">{note}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function FeedbackMarkdownBody({ feedback }: { feedback?: ValidationFeedback | null }) {
  return (
    <div className="prose-chat text-sm text-fg-muted">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdownFromFeedback(feedback)}</ReactMarkdown>
    </div>
  );
}

/** Two-up subscore display: design quality vs scope discovery. Renders only
 * when at least one of the subscores is present (legacy validations don't
 * have them — we fall back to the existing single-score pill). */
export function DesignDiscoverySubscores({
  feedback,
  className = ""
}: {
  feedback?: ValidationFeedback | null;
  className?: string;
}) {
  if (!feedback) return null;
  const design = feedback.designScore;
  const discovery = feedback.discoveryScore;
  if (typeof design !== "number" && typeof discovery !== "number") return null;
  return (
    <div className={`grid grid-cols-2 gap-2 ${className}`}>
      <SubscoreBlock
        label="Design"
        score={design}
        hint="How well the diagram + notes address the active scope."
      />
      <SubscoreBlock
        label="Discovery"
        score={discovery}
        hint="How much of the hidden scope you surfaced through clarifying questions."
      />
    </div>
  );
}

function SubscoreBlock({
  label,
  score,
  hint
}: {
  label: string;
  score: number | undefined;
  hint: string;
}) {
  if (typeof score !== "number") {
    return (
      <div className="surface-inset px-3 py-2" title={hint}>
        <p className="text-[9px] uppercase tracking-[0.18em] text-fg-faint">{label}</p>
        <p className="mt-0.5 text-sm font-semibold text-fg-faint">—</p>
      </div>
    );
  }
  return (
    <div className="surface-inset px-3 py-2" title={hint}>
      <p className="text-[9px] uppercase tracking-[0.18em] text-fg-faint">{label}</p>
      <p className="mt-0.5 text-base font-semibold tabular-nums text-fg">{score}</p>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface">
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400"
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}
