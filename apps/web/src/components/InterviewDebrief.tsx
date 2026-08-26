import { DEBRIEF_RECOMMENDATION_LABELS, type DebriefRecommendation } from "@sdl/shared";
import type { InterviewDebrief as Debrief } from "../lib/api";

/** Warm for below-bar, cool for at-or-above. Same palette as the score band
 * callout so the Validate tab reads as one document. */
const RECOMMENDATION_CLASS: Record<DebriefRecommendation, string> = {
  strong_yes: "border-emerald-400/40 bg-emerald-400/[0.07] text-emerald-700 dark:text-emerald-300",
  yes: "border-violet-400/40 bg-violet-400/[0.07] text-violet-700 dark:text-violet-300",
  no: "border-amber-400/40 bg-amber-400/[0.07] text-amber-700 dark:text-amber-300",
  strong_no: "border-rose-400/40 bg-rose-400/[0.07] text-rose-700 dark:text-rose-300"
};

/**
 * The written close-out for a finished interview.
 *
 * Deliberately ordered so the document ends on the study plan rather than the
 * verdict: this is a practice tool, and "what to go work on" is the part worth
 * re-reading a week later.
 */
export function InterviewDebriefPanel({
  debrief,
  className = ""
}: {
  debrief?: Debrief | null;
  className?: string;
}) {
  if (!debrief) return null;

  return (
    <section className={`space-y-3 ${className}`} aria-label="Interview debrief">
      <div
        className={`rounded-xl border px-3 py-2.5 ${
          RECOMMENDATION_CLASS[debrief.recommendation] ?? RECOMMENDATION_CLASS.no
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-[0.16em] opacity-70">
            Strongest signal
          </span>
          <span className="text-sm font-medium">
            {DEBRIEF_RECOMMENDATION_LABELS[debrief.recommendation] ?? debrief.recommendation}
          </span>
        </div>
        <p className="mt-1.5 text-[13px] leading-snug text-fg">{debrief.strongestSignal}</p>
      </div>

      <BulletBlock title="What went well" tone="green" items={debrief.whatWentWell} />
      <BulletBlock title="Where you struggled" tone="amber" items={debrief.whereTheyStruggled} />
      <BulletBlock title="Risk areas" tone="rose" items={debrief.riskAreas} />

      {debrief.studyPlan.length > 0 ? (
        <div className="surface-inset p-3">
          <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-fg-faint">
            Study plan — most valuable first
          </p>
          <ol className="space-y-2">
            {debrief.studyPlan.map((item, index) => (
              <li key={`${item.topic}-${index}`} className="text-[12px] leading-snug">
                <div className="flex gap-1.5">
                  <span className="shrink-0 tabular-nums text-fg-faint">{index + 1}.</span>
                  <div className="min-w-0">
                    <p className="font-medium text-fg">{item.topic}</p>
                    <p className="text-fg-muted">{item.why}</p>
                    {item.suggestedNextProblem ? (
                      <p className="mt-0.5 text-[11px] italic text-fg-faint">
                        Try next: {item.suggestedNextProblem}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <p className="text-[10px] text-fg-faint">
        Debrief generated {new Date(debrief.generatedAt).toLocaleString()}.
      </p>
    </section>
  );
}

function BulletBlock({
  title,
  tone,
  items
}: {
  title: string;
  tone: "green" | "amber" | "rose";
  items: string[];
}) {
  if (items.length === 0) return null;
  const markClass =
    tone === "green"
      ? "text-emerald-700 dark:text-emerald-300"
      : tone === "amber"
        ? "text-amber-700 dark:text-amber-300"
        : "text-rose-700 dark:text-rose-300";

  return (
    <div className="surface-inset p-3">
      <p className="mb-1.5 text-[10px] uppercase tracking-[0.18em] text-fg-faint">{title}</p>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li key={`${title}-${index}`} className="flex gap-1.5 text-[12px] leading-snug">
            <span className={`shrink-0 ${markClass}`} aria-hidden="true">
              •
            </span>
            <span className="break-words text-fg-muted">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
