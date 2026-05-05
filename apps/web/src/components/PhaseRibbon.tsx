import type { InterviewPlanPhase } from "../lib/phases";

export function formatPhaseClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

type Props = {
  phases: InterviewPlanPhase[];
  phaseIndex: number;
  elapsedInPhase: number;
  phaseRunning: boolean;
  setPhaseRunning: (r: boolean | ((p: boolean) => boolean)) => void;
  onNextPhase: () => void;
  onResetPhases: () => void;
};

function PhaseRoadmap({
  phases,
  phaseIndex
}: {
  phases: InterviewPlanPhase[];
  phaseIndex: number;
}) {
  return (
    <div className="flex flex-nowrap items-stretch gap-1.5 overflow-x-auto pb-0.5">
      {phases.map((p, i) => {
        const done = i < phaseIndex;
        const active = i === phaseIndex;
        return (
          <div
            key={p.id}
            title={p.candidateGuide}
            className={`flex min-w-0 max-w-[200px] shrink-0 flex-col rounded-lg border px-2 py-1.5 ${
              active
                ? "border-violet-400/45 bg-violet-400/[0.09] text-fg shadow-sm ring-1 ring-violet-400/25"
                : done
                  ? "border-emerald-500/25 bg-emerald-500/[0.06] text-fg-muted"
                  : "border-line bg-surface text-fg-muted"
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-fg">
                <span className="mr-1 font-normal text-fg-faint">{i + 1}.</span>
                {p.label}
              </span>
              <span className="shrink-0 text-[10px] text-fg-faint tabular-nums">
                {formatPhaseClock(p.durationSec)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PhaseRibbon({
  phases,
  phaseIndex,
  elapsedInPhase,
  phaseRunning,
  setPhaseRunning,
  onNextPhase,
  onResetPhases
}: Props) {
  const current = phases[phaseIndex] ?? phases[0];
  if (!current) return null;
  const budget = current.durationSec;
  const n = phases.length;

  return (
    <div className="surface-inset shrink-0 px-3 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-fg">{current.label}</span>
        <span className="text-fg-faint tabular-nums">
          {formatPhaseClock(elapsedInPhase)} / {formatPhaseClock(budget)}
        </span>
        <div className="h-1.5 min-w-[72px] flex-1 basis-[120px] overflow-hidden rounded-full bg-surface">
          <div
            className="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400 transition-all"
            style={{
              width: `${Math.min(100, (elapsedInPhase / Math.max(1, budget)) * 100)}%`
            }}
          />
        </div>
        <button
          type="button"
          className="btn-secondary !px-2 !py-1 !text-[11px]"
          onClick={() => setPhaseRunning((r) => !r)}
        >
          {phaseRunning ? "Pause" : "Start"}
        </button>
        <button
          type="button"
          className="btn-secondary !px-2 !py-1 !text-[11px]"
          onClick={onNextPhase}
        >
          Next
        </button>
        <button type="button" className="btn-ghost !px-2 !py-1 !text-[11px]" onClick={onResetPhases}>
          Reset
        </button>
      </div>

      <details className="group mt-1.5 border-t border-line/60 pt-1.5">
        <summary className="cursor-pointer list-none text-[10px] font-medium uppercase tracking-[0.16em] text-fg-faint marker:content-none [&::-webkit-details-marker]:hidden">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-fg-muted normal-case tracking-normal">
              Phase {phaseIndex + 1} of {n}
            </span>
            <span className="rounded border border-line/80 bg-surface px-1.5 py-px text-[9px] font-normal normal-case tracking-normal text-fg-faint group-open:hidden">
              Show all
            </span>
            <span className="hidden text-[9px] font-normal normal-case tracking-normal text-fg-faint group-open:inline">
              Hide list
            </span>
          </span>
        </summary>
        <div className="mt-2 space-y-1">
          <PhaseRoadmap phases={phases} phaseIndex={phaseIndex} />
          <p className="text-[10px] leading-snug text-fg-faint">
            Hover a card for focus hints. Times are suggested budgets.
          </p>
        </div>
      </details>
    </div>
  );
}
