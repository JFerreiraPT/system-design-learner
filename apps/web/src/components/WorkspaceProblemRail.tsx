import { useEffect, useState } from "react";
import type {
  ConstraintProposal,
  CriteriaProgress,
  Importance,
  LiveConstraint
} from "../lib/api";

type Props = {
  problemId: string;
  title?: string;
  difficulty?: string;
  statement?: string;
  /** Seed (problem-level) constraints. Used as a read-only fallback before an
   * interview has started, when there is no live set yet. */
  constraints: string[];
  /** Live constraint set for the active interview. When provided, replaces
   * the seed list and unlocks +/× actions and AI-proposal pills. */
  liveConstraints?: LiveConstraint[];
  pendingProposals?: ConstraintProposal[];
  /** Progress-only view of the per-interview rubric. When present and the
   * interview has hidden criteria, the rail shows a "discovery" indicator
   * without revealing the hidden text. */
  criteriaProgress?: CriteriaProgress;
  /** Render only when an interview is active — without these the rail is
   * read-only. */
  onAddConstraint?: (text: string) => void;
  onRemoveConstraint?: (constraintId: string) => void;
  onApplyProposal?: (proposalId: string) => void;
  onDismissProposal?: (proposalId: string) => void;
  difficultyBadgeClass: (level?: string) => string;
};

const ORIGIN_LABEL: Record<LiveConstraint["origin"], string> = {
  seed: "from problem",
  interviewer: "from interviewer",
  candidate: "you added"
};

const ORIGIN_BADGE_CLASS: Record<LiveConstraint["origin"], string> = {
  seed: "bg-violet-400/15 text-violet-700 dark:text-violet-300",
  interviewer: "bg-cyan-400/20 text-cyan-700 dark:text-cyan-300",
  candidate: "bg-emerald-400/20 text-emerald-700 dark:text-emerald-300"
};

const IMPORTANCE_LABEL: Record<Importance, string> = {
  core: "core",
  expected: "expected",
  stretch: "stretch"
};

const IMPORTANCE_BADGE_CLASS: Record<Importance, string> = {
  core: "bg-rose-400/20 text-rose-700 dark:text-rose-300",
  expected: "bg-amber-400/20 text-amber-700 dark:text-amber-300",
  stretch: "bg-sky-400/15 text-sky-700 dark:text-sky-300"
};

export function WorkspaceProblemRail({
  problemId,
  title,
  difficulty,
  statement,
  constraints,
  liveConstraints,
  pendingProposals,
  criteriaProgress,
  onAddConstraint,
  onRemoveConstraint,
  onApplyProposal,
  onDismissProposal,
  difficultyBadgeClass
}: Props) {
  const storageKey = `workspace:${problemId}:problemRailOpen:v3`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v === null) return true;
      return v === "1";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [open, storageKey]);

  const [draft, setDraft] = useState("");

  const editable = Boolean(onAddConstraint && onRemoveConstraint);
  const activeLive = (liveConstraints ?? []).filter((c) => c.status === "active");
  const removedLive = (liveConstraints ?? []).filter((c) => c.status === "removed");
  const showLive = liveConstraints !== undefined;
  const proposals = pendingProposals ?? [];

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || !onAddConstraint) return;
    onAddConstraint(text);
    setDraft("");
  };

  return (
    <div className="flex min-h-0 shrink-0 flex-col rounded-xl border border-line bg-surface/80">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-line/80 px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-fg-faint">Problem</p>
            {difficulty ? (
              <span className={difficultyBadgeClass(difficulty)}>{difficulty}</span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-sm font-semibold leading-tight text-fg" title={title}>
            {title ?? "Loading…"}
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost shrink-0 !px-2 !py-1 !text-[11px]"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? "Collapse" : "Expand"}
        </button>
      </div>
      {open ? (
        <div className="max-h-[min(40vh,260px)] min-h-0 space-y-2 overflow-auto px-3 py-1.5">
          <p className="text-[12px] leading-snug text-fg-muted">{statement}</p>

          {criteriaProgress && criteriaProgress.hidden.total > 0 ? (
            <div
              className="flex items-center gap-2 rounded-md border border-violet-400/30 bg-violet-400/5 px-2 py-1 text-[11px] text-fg-muted"
              title="Some expectations are hidden — ask clarifying questions to discover them. They're revealed in full after you Validate."
            >
              <span className="text-[10px] uppercase tracking-wider text-violet-600 dark:text-violet-400">
                Discovery
              </span>
              <span className="tabular-nums">
                {criteriaProgress.hidden.discovered} / {criteriaProgress.hidden.total} explored
                {criteriaProgress.hidden.core > 0 ? (
                  <span className="ml-1 text-fg-faint">
                    ({criteriaProgress.hidden.coreDiscovered}/{criteriaProgress.hidden.core} core)
                  </span>
                ) : null}
              </span>
              <div className="ml-auto h-1 w-16 overflow-hidden rounded-full bg-surface-inset">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400"
                  style={{
                    width: `${
                      criteriaProgress.hidden.total === 0
                        ? 0
                        : Math.round(
                            (criteriaProgress.hidden.discovered /
                              criteriaProgress.hidden.total) *
                              100
                          )
                    }%`
                  }}
                />
              </div>
            </div>
          ) : null}

          {proposals.length > 0 ? (
            <div className="rounded-md border border-violet-400/40 bg-violet-400/5 p-2">
              <p className="text-[10px] uppercase tracking-wider text-violet-700 dark:text-violet-300">
                Interviewer proposed {proposals.length === 1 ? "an update" : "updates"}
              </p>
              <ul className="mt-1 space-y-1">
                {proposals.map((p) => {
                  const targetText =
                    p.kind === "remove"
                      ? activeLive.find((c) => c.id === p.targetConstraintId)?.text ??
                        "(unknown)"
                      : null;
                  return (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-start gap-2 text-[11px] leading-snug text-fg"
                    >
                      <span className="rounded-full bg-violet-400/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-violet-700 dark:text-violet-300">
                        {p.kind === "add" ? "+ Add" : "− Remove"}
                      </span>
                      <span className="flex-1 break-words">
                        {p.kind === "add" ? p.text : targetText}
                        {p.rationale ? (
                          <span className="block text-[10px] text-fg-faint">
                            {p.rationale}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => onApplyProposal?.(p.id)}
                          className="rounded border border-violet-400/60 bg-violet-400/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 hover:bg-violet-400/20 dark:text-violet-200"
                        >
                          Apply
                        </button>
                        <button
                          type="button"
                          onClick={() => onDismissProposal?.(p.id)}
                          className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-muted hover:bg-surface"
                        >
                          Dismiss
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {showLive ? (
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[10px] uppercase tracking-wider text-violet-600 dark:text-violet-400">
                  Constraints ({activeLive.length})
                </p>
                {removedLive.length > 0 ? (
                  <p className="text-[10px] text-fg-faint">
                    {removedLive.length} scoped out
                  </p>
                ) : null}
              </div>
              {activeLive.length === 0 ? (
                <p className="mt-1 text-[11px] italic text-fg-faint">
                  No active constraints — add one below or wait for the interviewer to commit a decision.
                </p>
              ) : (
                <ul className="mt-1 space-y-1 border-l-2 border-violet-400/40 pl-2 text-[11px] leading-snug text-fg-muted">
                  {activeLive.map((c) => (
                    <li key={c.id} className="group flex items-start gap-2">
                      <span className="flex-1 break-words">{c.text}</span>
                      {c.importance ? (
                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0 text-[9px] font-semibold ${IMPORTANCE_BADGE_CLASS[c.importance]}`}
                          title={
                            c.discoveredFromCriterionId
                              ? `Discovered ${IMPORTANCE_LABEL[c.importance]} expectation`
                              : IMPORTANCE_LABEL[c.importance]
                          }
                        >
                          {IMPORTANCE_LABEL[c.importance]}
                        </span>
                      ) : null}
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-0 text-[9px] font-medium ${ORIGIN_BADGE_CLASS[c.origin]}`}
                        title={ORIGIN_LABEL[c.origin]}
                      >
                        {c.origin}
                      </span>
                      {editable ? (
                        <button
                          type="button"
                          onClick={() => onRemoveConstraint?.(c.id)}
                          className="shrink-0 rounded px-1 text-[12px] text-fg-faint opacity-0 transition hover:bg-surface hover:text-rose-500 group-hover:opacity-100"
                          aria-label="Remove constraint"
                          title="Soft-remove (kept in history)"
                        >
                          ×
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {editable ? (
                <div className="mt-2 flex items-center gap-1">
                  <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        submitDraft();
                      }
                    }}
                    placeholder="+ Add a constraint or assumption…"
                    className="field min-w-0 flex-1 !py-1 !text-[11px]"
                  />
                  <button
                    type="button"
                    onClick={submitDraft}
                    disabled={!draft.trim()}
                    className="rounded border border-line bg-surface px-2 py-1 text-[11px] text-fg-muted disabled:opacity-50 hover:enabled:bg-surface-inset"
                  >
                    Add
                  </button>
                </div>
              ) : null}
            </div>
          ) : constraints.length > 0 ? (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-violet-600 dark:text-violet-400">
                Constraints ({constraints.length})
              </p>
              <ul className="mt-1 space-y-0.5 border-l-2 border-violet-400/40 pl-2 text-[11px] leading-snug text-fg-muted">
                {constraints.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
