import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChatPanel } from "../components/ChatPanel";
import { api, type ChatMessage } from "../lib/api";

const isChatRole = (role: ChatMessage["role"]): role is "user" | "assistant" =>
  role === "user" || role === "assistant";

export function TutorPage() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: ["tutor-sessions"],
    queryFn: async () =>
      (await api.get<Array<{ id: string; title: string }>>("/tutor/sessions")).data
  });

  const createSessionMutation = useMutation({
    mutationFn: async () =>
      (await api.post<{ id: string; title: string }>("/tutor/sessions", { title: "Tutor session" })).data,
    onSuccess: (session) => setActiveSessionId(session.id)
  });

  const sessionMessagesQuery = useQuery({
    queryKey: ["tutor-session-messages", activeSessionId],
    queryFn: async () =>
      (await api.get<ChatMessage[]>(`/tutor/sessions/${activeSessionId}/messages`)).data,
    enabled: Boolean(activeSessionId)
  });

  const sessions = sessionsQuery.data ?? [];

  return (
    <main className="mx-auto grid h-[calc(100vh-64px)] max-w-[1500px] grid-cols-1 gap-4 px-6 py-6 lg:grid-cols-[320px_1fr]">
      <aside className="panel flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between px-1">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-fg-faint">Concept tutor</p>
            <h2 className="text-sm font-semibold text-fg">Sessions</h2>
          </div>
          <span className="badge">{sessions.length}</span>
        </div>

        <p className="rounded-xl border border-dashed border-line bg-surface-inset px-3 py-2 text-[11px] leading-relaxed text-fg-muted">
          For <strong className="text-fg">general concepts</strong> and ad-hoc questions without a
          problem workspace. For solution-aware help on a design you&apos;re drawing, use the{" "}
          <strong className="text-fg">Tutor</strong> tab inside a problem workspace.
        </p>

        <button
          className="btn-primary w-full"
          onClick={() => createSessionMutation.mutate()}
          disabled={createSessionMutation.isPending}
        >
          <PlusIcon />
          {createSessionMutation.isPending ? "Creating..." : "New session"}
        </button>

        <div className="divider" />

        <div className="flex-1 space-y-1.5 overflow-auto pr-1">
          {sessions.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-fg-faint">
              No sessions yet. Create one to begin.
            </p>
          ) : (
            sessions.map((session) => {
              const active = activeSessionId === session.id;
              return (
                <button
                  key={session.id}
                  onClick={() => setActiveSessionId(session.id)}
                  className={`group flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition ${
                    active
                      ? "border-violet-400/50 bg-gradient-to-r from-violet-400/15 to-fuchsia-400/10 text-fg shadow-[0_0_0_1px_rgba(167,139,250,0.25),0_8px_24px_-12px_rgba(232,121,249,0.4)]"
                      : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      active
                        ? "bg-gradient-to-br from-violet-400 to-fuchsia-400"
                        : "bg-zinc-400 group-hover:bg-zinc-600 dark:bg-zinc-600 dark:group-hover:bg-zinc-400"
                    }`}
                  />
                  <span className="truncate">{session.title}</span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className="panel flex flex-col p-4">
        {activeSessionId ? (
          <ChatPanel
            endpoint={`/tutor/sessions/${activeSessionId}/messages`}
            payload={{}}
            onMessageComplete={async () => {
              await sessionMessagesQuery.refetch();
            }}
            initialMessages={(sessionMessagesQuery.data ?? [])
              .filter((m): m is ChatMessage & { role: "user" | "assistant" } => isChatRole(m.role))
              .map((m) => ({ role: m.role, content: m.content }))}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="brand-mark h-14 w-14">
              <BookIcon />
            </div>
            <div>
              <p className="font-semibold text-fg">No session selected</p>
              <p className="mt-1 max-w-xs text-sm text-fg-faint">
                Create a new tutor session or pick an existing one to start chatting.
              </p>
            </div>
            <button
              onClick={() => createSessionMutation.mutate()}
              className="btn-secondary"
              disabled={createSessionMutation.isPending}
            >
              <PlusIcon /> New session
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
