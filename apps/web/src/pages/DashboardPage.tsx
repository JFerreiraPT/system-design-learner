import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { api, type FeedbackDimensions, type Problem, type ValidationRecord } from "../lib/api";
import { clearWorkspaceLocalState } from "../lib/store";
import { DIM_KEYS, DIM_LABELS } from "../lib/workspaceValidationUi";

const DIFFICULTIES = ["beginner", "easy", "medium", "hard", "expert"] as const;
type Difficulty = (typeof DIFFICULTIES)[number];

function difficultyBadgeClass(level: string) {
  switch (level) {
    case "beginner":
      return "badge badge-beginner";
    case "easy":
      return "badge badge-easy";
    case "medium":
      return "badge badge-medium";
    case "hard":
      return "badge badge-hard";
    case "expert":
      return "badge badge-expert";
    default:
      return "badge";
  }
}

function lowestDimensionScore(dims: FeedbackDimensions | undefined | null): number | null {
  if (!dims) return null;
  let min = Infinity;
  for (const k of DIM_KEYS) {
    const v = dims[k];
    if (typeof v === "number") min = Math.min(min, v);
  }
  return min === Infinity ? null : min;
}

function aggregateGlobalWeakDimensions(solutions: ValidationRecord[], topN = 5) {
  const sums: Partial<Record<string, { sum: number; n: number }>> = {};
  for (const row of solutions) {
    const d = row.feedbackJson?.dimensions;
    if (!d) continue;
    for (const k of DIM_KEYS) {
      const v = d[k];
      if (typeof v !== "number") continue;
      if (!sums[k]) sums[k] = { sum: 0, n: 0 };
      sums[k]!.sum += v;
      sums[k]!.n += 1;
    }
  }
  const out: { key: string; avg: number }[] = [];
  for (const [key, agg] of Object.entries(sums)) {
    if (!agg || agg.n === 0) continue;
    out.push({ key, avg: agg.sum / agg.n });
  }
  return out.sort((a, b) => a.avg - b.avg).slice(0, topN);
}

export function DashboardPage() {
  const [difficulty, setDifficulty] = useState<Difficulty>("beginner");
  const [topic, setTopic] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [replayId, setReplayId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const problemsQuery = useQuery({
    queryKey: ["problems"],
    queryFn: async () => (await api.get<Problem[]>("/problems")).data
  });

  const solutionsQuery = useQuery({
    queryKey: ["solutions-all"],
    queryFn: async () => (await api.get<ValidationRecord[]>("/solutions", { params: { limit: 500 } })).data
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const trimmed = topic.trim();
      const payload: { difficulty: Difficulty; topic?: string } = { difficulty };
      if (trimmed.length >= 2) payload.topic = trimmed;
      return (await api.post<Problem>("/problems/generate", payload)).data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["problems"] })
  });

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const p of problemsQuery.data ?? []) {
      for (const t of p.tagsJson ?? []) s.add(t);
    }
    return [...s].sort();
  }, [problemsQuery.data]);

  const filtered = (problemsQuery.data ?? []).filter((p) => {
    if (filter !== "all" && p.difficulty !== filter) return false;
    const tags = p.tagsJson ?? [];
    if (selectedTags.length === 0) return true;
    return selectedTags.every((t) => tags.includes(t));
  });

  const skillStats = useMemo(() => {
    const problems = problemsQuery.data ?? [];
    const solutions = solutionsQuery.data ?? [];
    const attemptedIds = new Set(solutions.map((s) => s.problemId));
    const byTag: Record<
      string,
      { problems: number; attempted: number; scores: number[]; lowestDimScores: number[] }
    > = {};
    for (const p of problems) {
      for (const t of p.tagsJson ?? []) {
        if (!byTag[t])
          byTag[t] = { problems: 0, attempted: 0, scores: [], lowestDimScores: [] };
        byTag[t].problems += 1;
        if (attemptedIds.has(p.id)) byTag[t].attempted += 1;
      }
    }
    for (const sol of solutions) {
      const score = sol.score;
      const low = lowestDimensionScore(sol.feedbackJson?.dimensions ?? null);
      const prob = problems.find((x) => x.id === sol.problemId);
      for (const t of prob?.tagsJson ?? []) {
        if (score != null) byTag[t]?.scores.push(score);
        if (low != null) byTag[t]?.lowestDimScores.push(low);
      }
    }
    return { byTag, attemptedIds, globalWeak: aggregateGlobalWeakDimensions(solutions) };
  }, [problemsQuery.data, solutionsQuery.data]);

  const total = problemsQuery.data?.length ?? 0;
  const counts = (problemsQuery.data ?? []).reduce<Record<string, number>>(
    (acc, p) => ({ ...acc, [p.difficulty]: (acc[p.difficulty] ?? 0) + 1 }),
    {}
  );

  const toggleTag = (t: string) => {
    setSelectedTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  const handleReplay = (problemId: string) => {
    clearWorkspaceLocalState(problemId);
    navigate(`/problems/${problemId}`);
    setReplayId(null);
  };

  return (
    <main className="mx-auto grid max-w-[1500px] gap-6 px-6 py-10">
      <ConfirmDialog
        open={replayId !== null}
        title="Replay from scratch?"
        description="Your canvas and active interview/tutor pointers for this problem will reset. Validations and chat history stay saved."
        confirmLabel="Continue"
        onCancel={() => setReplayId(null)}
        onConfirm={() => replayId && handleReplay(replayId)}
      />

      <section className="panel-strong overflow-hidden p-6 md:p-8">
        <div className="grid items-end gap-6 md:grid-cols-[1fr_auto]">
          <div>
            <span className="badge mb-3">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-500 animate-pulse-soft" />
              AI generator
            </span>
            <h2 className="text-2xl font-semibold tracking-tight text-fg md:text-3xl">
              Generate a <span className="text-gradient">new problem</span>
            </h2>
            <p className="mt-2 max-w-xl text-sm text-fg-muted">
              Pick a difficulty and (optionally) hint at a topic. Leave the topic blank to let the AI
              surprise you with a fresh, realistic system to design.
            </p>
          </div>
          <div className="hidden gap-2 md:flex">
            <Stat label="Total" value={total} />
            <Stat label="Beginner" value={counts.beginner ?? 0} accent="sky" />
            <Stat label="Easy" value={counts.easy ?? 0} accent="emerald" />
            <Stat label="Medium" value={counts.medium ?? 0} accent="amber" />
            <Stat label="Hard" value={counts.hard ?? 0} accent="orange" />
          </div>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-[160px_1fr_auto]">
          <select
            className="field"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as Difficulty)}
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {d.charAt(0).toUpperCase() + d.slice(1)}
              </option>
            ))}
          </select>
          <input
            className="field"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic (optional) — e.g. Realtime chat with presence"
          />
          <button
            type="button"
            className="btn-primary min-w-[140px]"
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
          >
            {generateMutation.isPending ? (
              <>
                <Spinner /> Generating
              </>
            ) : (
              <>
                <Sparkles /> Generate
              </>
            )}
          </button>
        </div>
      </section>

      <section className="panel p-6">
        <h2 className="text-lg font-semibold tracking-tight text-fg">Skill coverage</h2>
        <p className="mt-1 text-xs text-fg-faint">
          Based on your problem tags and validation scores (importance: use filters below to focus
          practice).
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="surface-inset p-4">
            <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-fg-faint">By tag</p>
            <div className="max-h-48 space-y-2 overflow-auto text-xs">
              {Object.keys(skillStats.byTag).length === 0 ? (
                <p className="text-fg-faint">Generate problems to see tag coverage.</p>
              ) : (
                Object.entries(skillStats.byTag)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([tag, st]) => {
                    const avg =
                      st.scores.length > 0
                        ? (st.scores.reduce((a, b) => a + b, 0) / st.scores.length).toFixed(0)
                        : "—";
                    const lows = st.lowestDimScores;
                    const avgLow =
                      lows.length > 0
                        ? (lows.reduce((a, b) => a + b, 0) / lows.length).toFixed(0)
                        : "—";
                    return (
                      <div
                        key={tag}
                        className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-1.5 last:border-0"
                      >
                        <span className="font-medium text-fg">{tag}</span>
                        <span className="text-fg-muted">
                          {st.problems} prob · {st.attempted} w/ validation · avg {avg} · avg min dim{" "}
                          {avgLow}
                        </span>
                      </div>
                    );
                  })
              )}
            </div>
          </div>
          <div className="surface-inset p-4">
            <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-fg-faint">
              Weakest dimensions (all time)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {skillStats.globalWeak.length === 0 ? (
                <p className="text-xs text-fg-faint">Validate more solutions to see patterns.</p>
              ) : (
                skillStats.globalWeak.map(({ key, avg }) => (
                  <span
                    key={key}
                    className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] text-fg-muted"
                  >
                    {DIM_LABELS[key] ?? key}: {avg.toFixed(0)}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="panel p-6">
        <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-fg">Problem library</h2>
            <p className="text-xs text-fg-faint">
              History of problems you've generated · {filtered.length}{" "}
              {filtered.length === 1 ? "problem" : "problems"}
              {filter !== "all" ? ` · ${filter}` : ""}
              {selectedTags.length > 0 ? ` · tags: ${selectedTags.join(", ")}` : ""}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <div className="tab-bar flex-wrap">
              {(["all", ...DIFFICULTIES] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setFilter(opt)}
                  className={`pill-tab ${filter === opt ? "pill-tab-active" : "pill-tab-idle"}`}
                >
                  {opt}
                </button>
              ))}
            </div>
            {allTags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {allTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleTag(t)}
                    className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition ${
                      selectedTags.includes(t)
                        ? "border-violet-400/60 bg-violet-400/15 text-fg"
                        : "border-line bg-surface text-fg-muted hover:border-line-strong"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {problemsQuery.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton h-[100px]" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState onGenerate={() => generateMutation.mutate()} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((problem) => (
              <div
                key={problem.id}
                className="card-hover surface-inset group relative overflow-hidden p-5 transition hover:border-line-strong"
              >
                <div
                  aria-hidden
                  className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br from-violet-400 via-fuchsia-400 to-pink-400 opacity-0 blur-3xl transition group-hover:opacity-30"
                />
                <Link
                  to={`/problems/${problem.id}`}
                  className="absolute inset-0 z-10"
                  aria-label={`Open ${problem.title}`}
                />
                <div className="relative z-20 mb-3 flex items-center justify-between">
                  <span className={difficultyBadgeClass(problem.difficulty)}>{problem.difficulty}</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setReplayId(problem.id);
                      }}
                      title="Replay from scratch (history is kept)"
                      aria-label="Replay from scratch"
                      className="btn-icon-sm"
                    >
                      <ReplayIcon />
                    </button>
                    <ArrowIcon />
                  </div>
                </div>
                <p className="relative z-20 font-semibold leading-tight text-fg pointer-events-none group-hover:text-gradient">
                  {problem.title}
                </p>
                {(problem.tagsJson?.length ?? 0) > 0 ? (
                  <div className="relative z-20 mt-2 flex flex-wrap gap-1 pointer-events-none">
                    {(problem.tagsJson ?? []).slice(0, 3).map((t) => (
                      <span
                        key={t}
                        className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-fg-faint"
                      >
                        {t}
                      </span>
                    ))}
                    {(problem.tagsJson ?? []).length > 3 ? (
                      <span className="text-[9px] text-fg-faint">
                        +{(problem.tagsJson ?? []).length - 3}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  accent
}: {
  label: string;
  value: number;
  accent?: "sky" | "emerald" | "amber" | "orange";
}) {
  const dot =
    accent === "sky"
      ? "bg-sky-500"
      : accent === "emerald"
        ? "bg-emerald-500"
        : accent === "amber"
          ? "bg-amber-500"
          : accent === "orange"
            ? "bg-orange-500"
            : "bg-violet-500";
  return (
    <div className="surface-inset min-w-[88px] px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-faint">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {label}
      </div>
      <div className="text-lg font-semibold text-fg">{value}</div>
    </div>
  );
}

function EmptyState({ onGenerate }: { onGenerate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line py-14 text-center">
      <div className="brand-mark h-12 w-12">
        <Sparkles size={20} />
      </div>
      <div>
        <p className="font-semibold text-fg">No problems yet</p>
        <p className="mt-1 text-sm text-fg-faint">
          Generate your first system design problem to get started.
        </p>
      </div>
      <button type="button" onClick={onGenerate} className="btn-primary">
        <Sparkles /> Generate problem
      </button>
    </div>
  );
}

function Sparkles({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <path d="M5.6 5.6l2.8 2.8" />
      <path d="M15.6 15.6l2.8 2.8" />
      <path d="M5.6 18.4l2.8-2.8" />
      <path d="M15.6 8.4l2.8-2.8" />
    </svg>
  );
}

function ReplayIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-fg-faint transition group-hover:translate-x-0.5 group-hover:text-fg"
    >
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.55" />
    </svg>
  );
}
