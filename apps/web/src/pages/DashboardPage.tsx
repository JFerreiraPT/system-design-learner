import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { TRACK_LABELS, TrackSchema } from "@sdl/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TrackBadge } from "../components/TrackBadge";
import { api, type FeedbackDimensions, type Problem, type Track, type ValidationRecord } from "../lib/api";
import { clearWorkspaceLocalState } from "../lib/store";
import { DIM_KEYS, DIM_LABELS } from "../lib/workspaceValidationUi";

const DIFFICULTIES = ["beginner", "easy", "medium", "hard", "expert"] as const;
type Difficulty = (typeof DIFFICULTIES)[number];

const TRACKS = TrackSchema.options;
/** "Any" is the default on both the generator and the filter: track is an
 * additive axis, so not choosing one has to stay a first-class option. */
const ANY_TRACK = "any" as const;

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

const SORTS = {
  newest: "Newest first",
  oldest: "Oldest first",
  title: "Title A–Z",
  difficulty: "Hardest first"
} as const;
type Sort = keyof typeof SORTS;

/** Difficulty rank, used by the "Hardest first" sort. */
const DIFFICULTY_RANK: Record<string, number> = {
  beginner: 0,
  easy: 1,
  medium: 2,
  hard: 3,
  expert: 4
};

/** Short, scannable age. Three problems can share a title, so the card needs
 * something that tells them apart at a glance. */
function formatAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 35) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
  const [track, setTrack] = useState<Track | typeof ANY_TRACK>(ANY_TRACK);
  const [topic, setTopic] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [trackFilter, setTrackFilter] = useState<Track | typeof ANY_TRACK>(ANY_TRACK);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
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
      const payload: { difficulty: Difficulty; topic?: string; track?: Track } = { difficulty };
      if (trimmed.length >= 2) payload.topic = trimmed;
      // Omitted entirely when "Any" — the server leaves the prompt untouched.
      if (track !== ANY_TRACK) payload.track = track;
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

  /** Attempt history per problem, so a card can say whether it has been tried
   * and how it went. Three problems can share a generated title — the score is
   * usually the only thing that distinguishes them. */
  const attemptsByProblem = useMemo(() => {
    const out = new Map<string, { count: number; best: number | null }>();
    for (const row of solutionsQuery.data ?? []) {
      const prev = out.get(row.problemId) ?? { count: 0, best: null };
      out.set(row.problemId, {
        count: prev.count + 1,
        best:
          row.score == null ? prev.best : prev.best == null ? row.score : Math.max(prev.best, row.score)
      });
    }
    return out;
  }, [solutionsQuery.data]);

  const hasActiveFilters =
    filter !== "all" || trackFilter !== ANY_TRACK || selectedTags.length > 0 || search.trim() !== "";

  const clearFilters = () => {
    setFilter("all");
    setTrackFilter(ANY_TRACK);
    setSelectedTags([]);
    setSearch("");
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = (problemsQuery.data ?? []).filter((p) => {
      if (filter !== "all" && p.difficulty !== filter) return false;
      // "Any" includes problems with no track — they are unspecified, not excluded.
      if (trackFilter !== ANY_TRACK && p.track !== trackFilter) return false;
      const tags = p.tagsJson ?? [];
      if (selectedTags.length > 0 && !selectedTags.every((t) => tags.includes(t))) return false;
      if (needle) {
        const haystack = `${p.title} ${tags.join(" ")}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    const byNewest = (a: Problem, b: Problem) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return [...rows].sort((a, b) => {
      switch (sort) {
        case "oldest":
          return -byNewest(a, b);
        case "title":
          return a.title.localeCompare(b.title) || byNewest(a, b);
        case "difficulty":
          return (
            (DIFFICULTY_RANK[b.difficulty] ?? 0) - (DIFFICULTY_RANK[a.difficulty] ?? 0) ||
            byNewest(a, b)
          );
        default:
          return byNewest(a, b);
      }
    });
  }, [filter, problemsQuery.data, search, selectedTags, sort, trackFilter]);

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

        <div className="mt-6 grid gap-3 md:grid-cols-[160px_180px_1fr_auto]">
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
          <select
            className="field"
            value={track}
            onChange={(e) => setTrack(e.target.value as Track | typeof ANY_TRACK)}
            title="Role archetype. Difficulty sets breadth; track sets subject."
            aria-label="Track"
          >
            <option value={ANY_TRACK}>Any track</option>
            {TRACKS.map((t) => (
              <option key={t} value={t}>
                {TRACK_LABELS[t]}
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
        <div className="mb-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-fg">Problem library</h2>
              <p className="text-xs text-fg-faint">
                {filtered.length} of {total} {total === 1 ? "problem" : "problems"}
                {hasActiveFilters ? " match your filters" : " you've generated"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative">
                <span className="sr-only">Search problems</span>
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint">
                  <SearchIcon />
                </span>
                <input
                  className="field w-56 !py-2 !pl-9 !pr-8 text-xs"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search title or tag"
                />
                {search ? (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-faint transition hover:text-fg"
                  >
                    <CloseIcon />
                  </button>
                ) : null}
              </label>
              <select
                className="field w-auto !py-2 text-xs"
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                aria-label="Sort problems"
              >
                {Object.entries(SORTS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              {hasActiveFilters ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded-xl border border-line bg-surface px-3 py-2 text-xs text-fg-muted transition hover:border-line-strong hover:text-fg"
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-2 lg:grid-cols-2">
            <FilterRow label="Difficulty">
              {(["all", ...DIFFICULTIES] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setFilter(opt)}
                  className={`pill-tab flex-none whitespace-nowrap ${
                    filter === opt ? "pill-tab-active" : "pill-tab-idle"
                  }`}
                >
                  {opt}
                  {opt !== "all" && (counts[opt] ?? 0) > 0 ? (
                    <span className="ml-1.5 opacity-60">{counts[opt]}</span>
                  ) : null}
                </button>
              ))}
            </FilterRow>
            <FilterRow label="Track">
              {([ANY_TRACK, ...TRACKS] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setTrackFilter(opt)}
                  className={`pill-tab flex-none whitespace-nowrap ${
                    trackFilter === opt ? "pill-tab-active" : "pill-tab-idle"
                  }`}
                >
                  {opt === ANY_TRACK ? "any" : TRACK_LABELS[opt]}
                </button>
              ))}
            </FilterRow>
          </div>

          {allTags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[10px] uppercase tracking-[0.18em] text-fg-faint">Tags</span>
              {allTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={selectedTags.includes(t)}
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

        {problemsQuery.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton h-[170px]" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          hasActiveFilters ? (
            <NoMatchesState onClear={clearFilters} />
          ) : (
            <EmptyState onGenerate={() => generateMutation.mutate()} />
          )
        ) : (
          <div className="grid items-stretch gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((problem) => (
              <ProblemCard
                key={problem.id}
                problem={problem}
                attempts={attemptsByProblem.get(problem.id)}
                onReplay={() => setReplayId(problem.id)}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

/** One labelled row of pill filters. The label is what makes the two bars
 * readable as separate axes rather than one long strip of chips. */
function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-[0.18em] text-fg-faint">
        {label}
      </span>
      <div className="tab-bar flex-1 flex-wrap">{children}</div>
    </div>
  );
}

function ProblemCard({
  problem,
  attempts,
  onReplay
}: {
  problem: Problem;
  attempts: { count: number; best: number | null } | undefined;
  onReplay: () => void;
}) {
  const tags = problem.tagsJson ?? [];
  return (
    <div className="card-hover surface-inset group relative flex h-full flex-col overflow-hidden p-5 transition hover:border-line-strong">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br from-violet-400 via-fuchsia-400 to-pink-400 opacity-0 blur-3xl transition group-hover:opacity-30"
      />
      <Link
        to={`/problems/${problem.id}`}
        className="absolute inset-0 z-10"
        aria-label={`Open ${problem.title}`}
      />
      <div className="relative z-20 mb-3 flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={difficultyBadgeClass(problem.difficulty)}>{problem.difficulty}</span>
          <TrackBadge track={problem.track} />
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onReplay();
            }}
            title="Replay from scratch (history is kept)"
            aria-label="Replay from scratch"
            className="btn-icon-sm opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
          >
            <ReplayIcon />
          </button>
          <ArrowIcon />
        </div>
      </div>

      {/* Fixed two-line title box: generated titles vary from one line to three,
          and letting them size the card leaves the grid visibly ragged. */}
      <p className="pointer-events-none relative z-20 line-clamp-2 min-h-[2.6em] font-semibold leading-tight text-fg group-hover:text-gradient">
        {problem.title}
      </p>

      <div className="pointer-events-none relative z-20 mt-2 min-h-[1.25rem] flex flex-wrap gap-1">
        {tags.slice(0, 3).map((t) => (
          <span
            key={t}
            className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-fg-faint"
          >
            {t}
          </span>
        ))}
        {tags.length > 3 ? (
          <span className="self-center text-[9px] text-fg-faint">+{tags.length - 3}</span>
        ) : null}
      </div>

      {/* Footer is pushed to the bottom by mt-auto, so every card in a row ends
          on the same line no matter how long its title or tag list is. */}
      <div className="pointer-events-none relative z-20 mt-auto flex items-center justify-between gap-2 pt-3 text-[10px] text-fg-faint">
        <span>{formatAge(problem.createdAt)}</span>
        {attempts ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 font-medium text-fg-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {attempts.count} {attempts.count === 1 ? "attempt" : "attempts"}
            {attempts.best != null ? ` · best ${Math.round(attempts.best)}` : ""}
          </span>
        ) : (
          <span className="text-fg-faint/80">Not attempted</span>
        )}
      </div>
    </div>
  );
}

function NoMatchesState({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line py-14 text-center">
      <div className="brand-mark h-12 w-12">
        <SearchIcon size={20} />
      </div>
      <div>
        <p className="font-semibold text-fg">No problems match</p>
        <p className="mt-1 text-sm text-fg-faint">
          Try a different difficulty, track, or tag combination.
        </p>
      </div>
      <button type="button" onClick={onClear} className="btn-primary">
        Clear filters
      </button>
    </div>
  );
}

function SearchIcon({ size = 14 }: { size?: number }) {
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
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    >
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
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
