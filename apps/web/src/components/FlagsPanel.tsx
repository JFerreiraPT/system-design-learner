import { useMemo, useState } from "react";
import type { FlagObservation, ValidationFeedback } from "../lib/api";

/**
 * Post-validate view of the interview playbook's observable flags.
 *
 * These are behaviours, not design properties — the interview-kit's Green /
 * Red Flag checkboxes ("Adapts design when challenged", "In-memory counter —
 * breaks on multi-node"). They are reported, never scored, so the panel is
 * framed as observations rather than as points won or lost.
 */
export function FlagsPanel({ feedback }: { feedback?: ValidationFeedback | null }) {
  const [showUnobserved, setShowUnobserved] = useState(false);

  const { firedGreens, firedReds, unobserved } = useMemo(() => {
    const all = feedback?.flagObservations ?? [];
    return {
      firedGreens: all.filter((f) => f.fired && f.kind === "green"),
      firedReds: all.filter((f) => f.fired && f.kind === "red"),
      unobserved: all.filter((f) => !f.fired)
    };
  }, [feedback?.flagObservations]);

  if ((feedback?.flagObservations ?? []).length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <FlagColumn
          title="What went well"
          empty="No positive signals were observed this attempt."
          tone="green"
          flags={firedGreens}
        />
        <FlagColumn
          title="Watch out"
          empty="No risk signals were observed this attempt."
          tone="red"
          flags={firedReds}
        />
      </div>

      {unobserved.length > 0 ? (
        showUnobserved ? (
          <div className="surface-inset p-2.5">
            <p className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-fg-faint">
              Not observed
            </p>
            <ul className="space-y-1">
              {unobserved.map((flag) => (
                <li key={flagKey(flag)} className="flex gap-1.5 text-[11px] text-fg-faint">
                  <span aria-hidden="true">{flag.kind === "green" ? "○" : "·"}</span>
                  <span className="break-words">{flag.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowUnobserved(true)}
            className="text-[11px] text-fg-faint underline-offset-2 hover:text-fg-muted hover:underline"
          >
            + show {unobserved.length} not observed
          </button>
        )
      ) : null}
    </div>
  );
}

function FlagColumn({
  title,
  empty,
  tone,
  flags
}: {
  title: string;
  empty: string;
  tone: "green" | "red";
  flags: FlagObservation[];
}) {
  const containerClass =
    tone === "green"
      ? "border-emerald-400/30 bg-emerald-400/5"
      : "border-rose-400/30 bg-rose-400/5";
  const markClass =
    tone === "green"
      ? "text-emerald-700 dark:text-emerald-300"
      : "text-rose-700 dark:text-rose-300";

  return (
    <div className={`rounded-md border px-2.5 py-2 ${containerClass}`}>
      <p className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-fg-faint">{title}</p>
      {flags.length === 0 ? (
        <p className="text-[11px] text-fg-faint">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {flags.map((flag) => (
            <li key={flagKey(flag)} className="text-[12px] leading-snug">
              <div className="flex gap-1.5">
                <span className={`shrink-0 ${markClass}`} aria-hidden="true">
                  {tone === "green" ? "✓" : "!"}
                </span>
                <span className="break-words text-fg">{flag.text}</span>
              </div>
              {flag.evidence ? (
                <p className="ml-4 mt-0.5 text-[11px] text-fg-faint">{flag.evidence}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function flagKey(flag: FlagObservation) {
  return `${flag.areaId}:${flag.kind}:${flag.index}`;
}
