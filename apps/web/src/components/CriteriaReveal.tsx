import { useMemo, useState } from "react";
import type { Importance, RubricCriterion, ValidationFeedback } from "../lib/api";
import {
  compareCriterionRows,
  CriterionRow,
  DIM_LABELS,
  joinCriteriaWithEvaluations
} from "../lib/workspaceValidationUi";

const IMPORTANCE_BADGE_CLASS: Record<Importance, string> = {
  core: "bg-rose-400/20 text-rose-700 dark:text-rose-300",
  expected: "bg-amber-400/20 text-amber-700 dark:text-amber-300",
  stretch: "bg-sky-400/15 text-sky-700 dark:text-sky-300"
};

type Props = {
  /** Full criteria payload (only fetched after a validation submit — see
   * `GET /interviews/:id/criteria/reveal`). When null, the rubric never got
   * generated for this interview (legacy session) and we render nothing. */
  criteria: RubricCriterion[] | null;
  /** Latest validation feedback so we can attach `covered` / `discovered`
   * outcomes to each criterion row. Optional — without it the reveal still
   * shows the rubric, just with no per-criterion verdict. */
  feedback?: ValidationFeedback | null;
  /** From the interview-scoped reference answer. Shown ONLY under criteria the
   * candidate missed: "here is what you missed" next to "here is what covering
   * it looks like" is the highest-value pairing in the whole panel. */
  criterionCoverage?: Array<{ criterionId: string; howAddressed: string }>;
};

/** Post-validate reveal of the per-interview rubric.
 *
 * What gets shown:
 *   - Missed core criteria first (these are "you should have caught this").
 *   - Missed expected next.
 *   - Covered cores and expecteds afterwards (positive reinforcement).
 *   - Stretch items at the bottom.
 *
 * Hidden criteria the candidate never surfaced are flagged with a "never
 * asked" pill — the reveal is the moment the candidate sees what they
 * didn't think to ask about, which is the whole point of the hidden tier. */
export function CriteriaReveal({ criteria, feedback, criterionCoverage }: Props) {
  const [showStretch, setShowStretch] = useState(false);

  const rows = useMemo(() => {
    return joinCriteriaWithEvaluations(criteria, feedback?.criteriaEvaluations).sort(
      compareCriterionRows
    );
  }, [criteria, feedback?.criteriaEvaluations]);

  const coverageById = useMemo(
    () => new Map((criterionCoverage ?? []).map((c) => [c.criterionId, c.howAddressed] as const)),
    [criterionCoverage]
  );

  if (rows.length === 0) {
    return (
      <p className="text-xs text-fg-faint">
        No structured rubric was generated for this interview — older sessions don't
        have one. Start a new interview (or click Replay) to get the new criteria flow.
      </p>
    );
  }

  const visibleRows = showStretch
    ? rows
    : rows.filter((r) => r.criterion.importance !== "stretch");
  const stretchHidden = rows.length - visibleRows.length;

  const summary = summarize(rows);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
        <span className="rounded-full bg-rose-400/15 px-2 py-0.5 text-rose-700 dark:text-rose-300">
          {summary.coreMissed} / {summary.coreTotal} core missed
        </span>
        <span className="rounded-full bg-violet-400/15 px-2 py-0.5 text-violet-700 dark:text-violet-300">
          {summary.discoveredHidden} / {summary.totalHidden} hidden surfaced
        </span>
        <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-fg-muted">
          {summary.coveredAll} / {rows.length} covered overall
        </span>
      </div>

      <ul className="space-y-1.5">
        {visibleRows.map((row) => (
          <CriterionItem
            key={row.criterion.id}
            row={row}
            coverage={coverageById.get(row.criterion.id)}
          />
        ))}
      </ul>

      {stretchHidden > 0 ? (
        <button
          type="button"
          onClick={() => setShowStretch(true)}
          className="text-[11px] text-fg-faint underline-offset-2 hover:text-fg-muted hover:underline"
        >
          + show {stretchHidden} stretch {stretchHidden === 1 ? "criterion" : "criteria"}
        </button>
      ) : null}
    </div>
  );
}

function CriterionItem({ row, coverage }: { row: CriterionRow; coverage?: string }) {
  const { criterion: c, evaluation: ev, neverDiscovered } = row;
  const covered = ev?.covered ?? false;
  // The gentle nudge is written as an opening question, so it reads better as a
  // study prompt than a bare discovery hint. Hints stay the fallback.
  const studyPrompt = c.progressiveNudges?.[0] ?? c.discoveryHints?.[0];
  const isMissedCore = c.importance === "core" && !covered;
  const containerClass = isMissedCore
    ? "border-rose-400/40 bg-rose-400/5"
    : covered
      ? "border-emerald-400/30 bg-emerald-400/5"
      : "border-amber-400/30 bg-amber-400/5";

  return (
    <li
      className={`rounded-md border px-2.5 py-1.5 text-[12px] leading-snug ${containerClass}`}
    >
      <div className="flex flex-wrap items-start gap-1.5">
        <span className="flex-1 break-words text-fg">{c.text}</span>
        <span
          className={`rounded-full px-1.5 py-0 text-[9px] font-semibold ${IMPORTANCE_BADGE_CLASS[c.importance]}`}
          title={`Importance: ${c.importance}`}
        >
          {c.importance}
        </span>
        <span
          className="rounded-full border border-line bg-surface px-1.5 py-0 text-[9px] font-medium text-fg-muted"
          title={`Dimension: ${c.dimension}`}
        >
          {DIM_LABELS[c.dimension] ?? c.dimension}
        </span>
        {c.visibility === "hidden" ? (
          <span
            className={`rounded-full px-1.5 py-0 text-[9px] font-medium ${
              neverDiscovered
                ? "bg-rose-400/20 text-rose-700 dark:text-rose-300"
                : "bg-violet-400/15 text-violet-700 dark:text-violet-300"
            }`}
            title={
              neverDiscovered
                ? "Hidden expectation — you never surfaced this in conversation"
                : `Discovered via ${c.discoveredVia?.kind ?? "match"}`
            }
          >
            {neverDiscovered ? "never asked" : "discovered"}
          </span>
        ) : null}
        <span
          className={`rounded-full px-1.5 py-0 text-[9px] font-medium ${
            covered
              ? "bg-emerald-400/20 text-emerald-700 dark:text-emerald-300"
              : "bg-rose-400/20 text-rose-700 dark:text-rose-300"
          }`}
        >
          {covered ? "covered" : "missed"}
        </span>
      </div>
      {ev?.evidence ? (
        <p className="mt-1 text-[11px] text-fg-faint">{ev.evidence}</p>
      ) : null}
      {!covered && coverage ? (
        <p className="mt-1 rounded border border-emerald-400/30 bg-emerald-400/[0.06] px-1.5 py-1 text-[11px] text-fg-muted">
          <span className="font-medium text-emerald-700 dark:text-emerald-300">
            What covering this looks like:
          </span>{" "}
          {coverage}
        </p>
      ) : null}
      {!covered && studyPrompt ? (
        <p className="mt-1 text-[11px] italic text-fg-faint">Try asking: {studyPrompt}</p>
      ) : null}
    </li>
  );
}

function summarize(rows: CriterionRow[]) {
  let coreTotal = 0;
  let coreMissed = 0;
  let totalHidden = 0;
  let discoveredHidden = 0;
  let coveredAll = 0;
  for (const row of rows) {
    if (row.criterion.importance === "core") {
      coreTotal += 1;
      if (!(row.evaluation?.covered ?? false)) coreMissed += 1;
    }
    if (row.criterion.visibility === "hidden") {
      totalHidden += 1;
      if (row.criterion.discoveredVia) discoveredHidden += 1;
    }
    if (row.evaluation?.covered) coveredAll += 1;
  }
  return { coreTotal, coreMissed, totalHidden, discoveredHidden, coveredAll };
}
