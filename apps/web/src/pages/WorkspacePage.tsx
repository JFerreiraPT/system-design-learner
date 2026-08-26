import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Board } from "../components/Board";
import { ChatPanel } from "../components/ChatPanel";
import { VoicePanel } from "../components/VoicePanel";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CriteriaReveal } from "../components/CriteriaReveal";
import { FlagsPanel } from "../components/FlagsPanel";
import { InterviewDebriefPanel } from "../components/InterviewDebrief";
import { ProcessPanel } from "../components/ProcessPanel";
import {
  DesignDiscoverySubscores,
  DimensionBreakdown,
  FeedbackMarkdownBody,
  ScoreBandCallout
} from "../components/DimensionBreakdown";
import {
  computeLegacyDerivedEstimation,
  EstimationPanel
} from "../components/EstimationPanel";
import { PhaseRibbon } from "../components/PhaseRibbon";
import { WorkspaceProblemRail } from "../components/WorkspaceProblemRail";
import {
  DEFAULT_INTERVIEW_PLAN,
  EstimationProblemSpecSchema,
  InterviewPlanSchema,
  isLegacyDerivedEstimationSpec,
  LEGACY_ESTIMATION_SPEC
} from "@sdl/shared";
import {
  api,
  type ChatMessage,
  type CriteriaProgress,
  type CriteriaProgressResponse,
  type CriteriaRevealResponse,
  type EndInterviewResponse,
  type InterviewConstraintState,
  type InterviewPhaseProposalState,
  type InterviewPhaseTimeline,
  type InterviewStatus,
  type InterviewTutorUsage,
  type PatchInterviewResponse,
  type Problem,
  type ReferenceSolution,
  type ValidationRecord,
  type WorkspaceEstimation
} from "../lib/api";
import { migrateEstimationFromStorage } from "../lib/estimationMigrate";
import { buildAttemptMarkdownReport, downloadMarkdown, reportFilename } from "../lib/exportReport";
import { advanceEvents, postPhaseEvent, type PhaseEventBody } from "../lib/phaseEvents";
import type { PhasePersistState } from "../lib/phases";
import { projectSceneJson } from "../lib/sceneProjection";
import { clearWorkspaceLocalState, useWorkspaceStore } from "../lib/store";
import {
  aggregateWeakDimensions,
  DIM_LABELS,
  markdownFromReference
} from "../lib/workspaceValidationUi";

type Tab = "interviewer" | "tutor" | "estimation" | "validate";
const TABS: Tab[] = ["interviewer", "tutor", "estimation", "validate"];

const TAB_LABEL: Record<Tab, string> = {
  interviewer: "Interviewer",
  tutor: "Tutor",
  estimation: "Numbers",
  validate: "Validate"
};

const isChatRole = (role: ChatMessage["role"]): role is "user" | "assistant" =>
  role === "user" || role === "assistant";

function difficultyBadgeClass(level?: string) {
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

export function WorkspacePage() {
  const { id = "" } = useParams();
  const [tab, setTab] = useState<Tab>("interviewer");
  const [interviewerLevel, setInterviewerLevel] = useState<
    "guided" | "standard" | "hard" | "staff"
  >("guided");
  const [interviewId, setInterviewId] = useState<string | null>(null);
  const [tutorSessionId, setTutorSessionId] = useState<string | null>(null);
  const [restoredProblemId, setRestoredProblemId] = useState<string | null>(null);
  const [restoredSceneProblemId, setRestoredSceneProblemId] = useState<string | null>(null);
  const [restoredEstimationId, setRestoredEstimationId] = useState<string | null>(null);
  const [restoredPhaseId, setRestoredPhaseId] = useState<string | null>(null);
  const [boardKey, setBoardKey] = useState(0);
  const [replayOpen, setReplayOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  /** Level the candidate picked mid-interview, held until they choose whether
   * to regenerate the rubric for it. */
  const [pendingLevel, setPendingLevel] = useState<
    "guided" | "standard" | "hard" | "staff" | null
  >(null);
  const [loadedHint, setLoadedHint] = useState<string | null>(null);
  const [estimation, setEstimation] = useState<WorkspaceEstimation>({});
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [elapsedInPhase, setElapsedInPhase] = useState(0);
  const [phaseRunning, setPhaseRunning] = useState(false);

  const queryClient = useQueryClient();
  const sceneJson = useWorkspaceStore((s) => s.sceneJson);
  const setScene = useWorkspaceStore((s) => s.setScene);
  const captureSceneImage = useWorkspaceStore((s) => s.captureSceneImage);
  const [lastValidatedSceneJson, setLastValidatedSceneJson] = useState<string | null>(null);

  const sceneSummary = useMemo(() => projectSceneJson(sceneJson), [sceneJson]);
  const sceneIsEmpty = sceneSummary.nodes.length === 0;
  const sceneUnchangedSinceValidation =
    lastValidatedSceneJson !== null && lastValidatedSceneJson === sceneJson;

  const problemQuery = useQuery({
    queryKey: ["problem", id],
    queryFn: async () => (await api.get<Problem>(`/problems/${id}`)).data,
    enabled: Boolean(id)
  });

  const interviewPlan = useMemo(() => {
    const raw = problemQuery.data?.interviewPlanJson;
    if (raw == null) return DEFAULT_INTERVIEW_PLAN;
    const p = InterviewPlanSchema.safeParse(raw);
    return p.success ? p.data : DEFAULT_INTERVIEW_PLAN;
  }, [problemQuery.data?.interviewPlanJson]);

  const estimationSpec = useMemo(() => {
    const raw = problemQuery.data?.estimationSpecJson;
    if (raw == null) return LEGACY_ESTIMATION_SPEC;
    const parsed = EstimationProblemSpecSchema.safeParse(raw);
    return parsed.success ? parsed.data : LEGACY_ESTIMATION_SPEC;
  }, [problemQuery.data?.estimationSpecJson]);

  const legacyDerived = useMemo(() => {
    if (!isLegacyDerivedEstimationSpec(estimationSpec)) return undefined;
    return computeLegacyDerivedEstimation(estimation);
  }, [estimation, estimationSpec]);

  const validationsQuery = useQuery({
    queryKey: ["validations", id],
    queryFn: async () =>
      (await api.get<ValidationRecord[]>("/solutions", { params: { problemId: id } })).data,
    enabled: Boolean(id)
  });

  const hasValidationAttempt = (validationsQuery.data?.length ?? 0) > 0;

  // Keyed on the interview too: an interview-scoped reference is built against
  // that interview's rubric, so it must not be served from the generic cache.
  const referenceQuery = useQuery({
    queryKey: ["reference", id, interviewId],
    queryFn: async () =>
      (
        await api.get<ReferenceSolution>(`/problems/${id}/reference`, {
          params: interviewId ? { interviewId } : undefined
        })
      ).data,
    enabled: Boolean(id) && hasValidationAttempt,
    retry: false
  });

  /** Append-only pacing telemetry. Deliberately fire-and-forget: the live
   * timer is client-owned, so a failed POST must never block a button or
   * surface an error. Takes the interview id explicitly because the very first
   * event fires from `startInterview`'s `onSuccess`, before state has settled. */
  const emitPhaseEvents = (targetInterviewId: string | null, events: PhaseEventBody[]) => {
    if (!targetInterviewId) return;
    for (const body of events) {
      void postPhaseEvent(
        (payload) => api.post(`/interviews/${targetInterviewId}/phase-events`, payload),
        body
      );
    }
  };

  /** The one place a phase actually advances. Both the ribbon's Next button and
   * the interviewer's transition banner route through here so they cannot drift
   * on which events get recorded. */
  const advancePhase = () => {
    if (phaseIndex >= planPhases.length - 1) return;
    const next = planPhases[phaseIndex + 1]!;
    emitPhaseEvents(
      interviewId,
      advanceEvents({
        fromPhaseId: currentPhaseDef.id,
        fromPhaseIndex: phaseIndex,
        fromElapsedSec: elapsedInPhase,
        toPhaseId: next.id,
        toPhaseIndex: phaseIndex + 1
      })
    );
    setPhaseIndex((i) => i + 1);
    setElapsedInPhase(0);
  };

  const startInterviewMutation = useMutation({
    mutationFn: async () =>
      (await api.post<{ id: string }>("/interviews", { problemId: id, interviewerLevel })).data,
    onSuccess: (data) => {
      setInterviewId(data.id);
      // Start the clock with the interview. Without this the timer defaults to
      // stopped, elapsed stays 0 for the whole session, and every piece of
      // pacing guidance downstream (transition offers, the debrief's pacing
      // block) is silently inert. Pause and Reset stay manual.
      setPhaseRunning(true);
      emitPhaseEvents(data.id, [
        {
          phaseId: currentPhaseDef.id,
          phaseIndex,
          kind: "enter",
          elapsedSec: elapsedInPhase
        }
      ]);
    }
  });

  const patchInterviewMutation = useMutation({
    mutationFn: async (input: {
      level: typeof interviewerLevel;
      regenerateCriteria: boolean;
    }) =>
      (
        await api.patch<PatchInterviewResponse>(`/interviews/${interviewId}`, {
          interviewerLevel: input.level,
          regenerateCriteria: input.regenerateCriteria
        })
      ).data,
    onSuccess: (data) => {
      setInterviewerLevel(data.interviewerLevel);
      setPendingLevel(null);
      queryClient.invalidateQueries({ queryKey: ["interview-messages", interviewId] });
      // Regeneration replaces the rubric wholesale, so every criteria-derived
      // view has to be refetched — including the constraint rail, whose
      // discovery pills may now point at criteria that no longer exist.
      queryClient.invalidateQueries({ queryKey: ["interview-status", interviewId] });
      queryClient.invalidateQueries({
        queryKey: ["interview-criteria-progress", interviewId]
      });
      queryClient.invalidateQueries({
        queryKey: ["interview-criteria-reveal", interviewId]
      });
      queryClient.invalidateQueries({ queryKey: ["interview-constraints", interviewId] });
    },
    onError: () => setPendingLevel(null)
  });

  const regenerateCriteriaMutation = useMutation({
    mutationFn: async () => api.post(`/interviews/${interviewId}/criteria/regenerate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["interview-status", interviewId] });
      queryClient.invalidateQueries({
        queryKey: ["interview-criteria-progress", interviewId]
      });
      queryClient.invalidateQueries({
        queryKey: ["interview-criteria-reveal", interviewId]
      });
      queryClient.invalidateQueries({ queryKey: ["interview-constraints", interviewId] });
    }
  });

  const startTutorMutation = useMutation({
    mutationFn: async () =>
      (
        await api.post<{ id: string }>("/tutor/sessions", {
          title: "Workspace Tutor",
          // Linked so the debrief can report tutor usage. Never gates or
          // changes anything about the tutor itself.
          ...(interviewId ? { interviewId } : {})
        })
      ).data,
    onSuccess: (data) => setTutorSessionId(data.id)
  });

  const estimationPayload = useMemo(() => {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(estimation)) {
      if (v !== undefined && v !== "" && !(typeof v === "number" && Number.isNaN(v))) {
        cleaned[k] = v;
      }
    }
    if (legacyDerived && isLegacyDerivedEstimationSpec(estimationSpec)) {
      const has = Object.values(legacyDerived).some((v) => v != null);
      if (has) cleaned.derived = legacyDerived;
    }
    return cleaned;
  }, [estimation, legacyDerived, estimationSpec]);

  const planPhases = interviewPlan.phases;
  const currentPhaseDef = planPhases[phaseIndex] ?? planPhases[0]!;

  const estimationCompletion = useMemo(() => {
    const total = estimationSpec.fields.length;
    let filled = 0;
    for (const f of estimationSpec.fields) {
      const v = estimation[f.key];
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      if (typeof v === "number" && Number.isNaN(v)) continue;
      filled += 1;
    }
    return { filled, total };
  }, [estimation, estimationSpec]);

  const validateMutation = useMutation({
    mutationFn: async () => {
      const result = (
        await api.post("/solutions", {
          problemId: id,
          sceneJson,
          notes: "Candidate whiteboard solution",
          estimation:
            Object.keys(estimationPayload).length > 0 ? estimationPayload : undefined,
          // When an interview is active, the server scores against the live
          // (conversation-amended) constraint set instead of the seed problem.
          interviewId: interviewId ?? undefined
        })
      ).data;
      setLastValidatedSceneJson(sceneJson);
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["validations", id] });
      queryClient.invalidateQueries({ queryKey: ["reference", id] });
      queryClient.invalidateQueries({ queryKey: ["reference", id, interviewId] });
      // First validation unlocks the criteria reveal endpoint. Force a refetch
      // so the Validate panel's reveal block populates without a manual reload.
      queryClient.invalidateQueries({
        queryKey: ["interview-criteria-reveal", interviewId]
      });
      queryClient.invalidateQueries({ queryKey: ["interview-tutor-usage", interviewId] });
      queryClient.invalidateQueries({ queryKey: ["interview-phase-timeline", interviewId] });
    }
  });

  const interviewMessagesQuery = useQuery({
    queryKey: ["interview-messages", interviewId],
    queryFn: async () =>
      (await api.get<ChatMessage[]>(`/interviews/${interviewId}/messages`)).data,
    enabled: Boolean(interviewId)
  });

  const constraintsQuery = useQuery({
    queryKey: ["interview-constraints", interviewId],
    queryFn: async () =>
      (await api.get<InterviewConstraintState>(`/interviews/${interviewId}/constraints`)).data,
    enabled: Boolean(interviewId)
  });

  /** Progress-only criteria view — drives the Problem rail's discovery
   * indicator without ever fetching hidden criterion text. */
  const criteriaProgressQuery = useQuery({
    queryKey: ["interview-criteria-progress", interviewId],
    queryFn: async () =>
      (await api.get<CriteriaProgressResponse>(`/interviews/${interviewId}/criteria`)).data,
    enabled: Boolean(interviewId)
  });

  /** Full reveal — only enabled after at least one validation has been
   * submitted (server enforces the gate too; this avoids needless 403s). */
  const criteriaRevealQuery = useQuery({
    queryKey: ["interview-criteria-reveal", interviewId],
    queryFn: async () =>
      (await api.get<CriteriaRevealResponse>(`/interviews/${interviewId}/criteria/reveal`)).data,
    enabled: Boolean(interviewId) && (validationsQuery.data?.length ?? 0) > 0,
    retry: false
  });

  /** Lifecycle of the active interview. A workspace restored from
   * `localStorage` has no idea whether its interview is still open, so the
   * composer's enabled state has to come from the server. */
  const interviewStatusQuery = useQuery({
    queryKey: ["interview-status", interviewId],
    queryFn: async () =>
      (await api.get<InterviewStatus>(`/interviews/${interviewId}/status`)).data,
    enabled: Boolean(interviewId)
  });

  const interviewCompleted = interviewStatusQuery.data?.status === "completed";
  const debrief = interviewStatusQuery.data?.debrief ?? null;

  /** Live transition offer. Polled after each interviewer turn, since the
   * deterministic rule runs server-side once the assistant reply is persisted. */
  const phaseProposalQuery = useQuery({
    queryKey: ["interview-phase-proposal", interviewId],
    queryFn: async () =>
      (await api.get<InterviewPhaseProposalState>(`/interviews/${interviewId}/phase-proposal`))
        .data,
    enabled: Boolean(interviewId)
  });

  const transitionProposal =
    interviewCompleted ? null : (phaseProposalQuery.data?.pending ?? null);

  const resolvePhaseProposalMutation = useMutation({
    mutationFn: async (outcome: "apply" | "dismiss") =>
      (
        await api.post<InterviewPhaseProposalState>(
          `/interviews/${interviewId}/phase-proposal/${outcome}`
        )
      ).data,
    onSuccess: (data) => {
      queryClient.setQueryData(["interview-phase-proposal", interviewId], data);
    }
  });

  /** Per-phase actual vs budget. Read for the exported report's pacing
   * section — the live ribbon still renders from `localStorage`. */
  const phaseTimelineQuery = useQuery({
    queryKey: ["interview-phase-timeline", interviewId],
    queryFn: async () =>
      (await api.get<InterviewPhaseTimeline>(`/interviews/${interviewId}/phase-timeline`)).data,
    enabled: Boolean(interviewId)
  });

  /** Factual tutor consultation record. Refetched after a validation so the
   * chip is current when the candidate reads their score. */
  const tutorUsageQuery = useQuery({
    queryKey: ["interview-tutor-usage", interviewId],
    queryFn: async () =>
      (await api.get<InterviewTutorUsage>(`/interviews/${interviewId}/tutor-usage`)).data,
    enabled: Boolean(interviewId)
  });

  const endInterviewMutation = useMutation({
    mutationFn: async () =>
      (await api.post<EndInterviewResponse>(`/interviews/${interviewId}/end`)).data,
    onSuccess: (data) => {
      setEndError(null);
      setEndOpen(false);
      queryClient.setQueryData<InterviewStatus | undefined>(
        ["interview-status", interviewId],
        (previous) =>
          previous
            ? { ...previous, status: data.status, endedAt: data.endedAt, debrief: data.debrief }
            : previous
      );
      void interviewStatusQuery.refetch();
    },
    onError: (error: unknown) => {
      setEndOpen(false);
      const message =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Could not end the interview. Try again in a moment.";
      setEndError(message);
    }
  });

  const addConstraintMutation = useMutation({
    mutationFn: async (text: string) =>
      (
        await api.post<InterviewConstraintState>(`/interviews/${interviewId}/constraints`, {
          text
        })
      ).data,
    onSuccess: (data) => {
      queryClient.setQueryData(["interview-constraints", interviewId], data);
    }
  });

  const removeConstraintMutation = useMutation({
    mutationFn: async (constraintId: string) =>
      (
        await api.delete<InterviewConstraintState>(
          `/interviews/${interviewId}/constraints/${constraintId}`
        )
      ).data,
    onSuccess: (data) => {
      queryClient.setQueryData(["interview-constraints", interviewId], data);
    }
  });

  const applyProposalMutation = useMutation({
    mutationFn: async (proposalId: string) =>
      (
        await api.post<InterviewConstraintState>(
          `/interviews/${interviewId}/proposals/${proposalId}/apply`
        )
      ).data,
    onSuccess: (data) => {
      queryClient.setQueryData(["interview-constraints", interviewId], data);
    }
  });

  const dismissProposalMutation = useMutation({
    mutationFn: async (proposalId: string) =>
      (
        await api.post<InterviewConstraintState>(
          `/interviews/${interviewId}/proposals/${proposalId}/dismiss`
        )
      ).data,
    onSuccess: (data) => {
      queryClient.setQueryData(["interview-constraints", interviewId], data);
    }
  });

  const tutorMessagesQuery = useQuery({
    queryKey: ["workspace-tutor-messages", tutorSessionId],
    queryFn: async () =>
      (await api.get<ChatMessage[]>(`/tutor/sessions/${tutorSessionId}/messages`)).data,
    enabled: Boolean(tutorSessionId)
  });

  useEffect(() => {
    if (!phaseRunning) return;
    const t = window.setInterval(() => setElapsedInPhase((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [phaseRunning]);

  useEffect(() => {
    if (!id) return;
    setRestoredProblemId(null);
    setInterviewId(localStorage.getItem(`workspace:${id}:interviewId`));
    setTutorSessionId(localStorage.getItem(`workspace:${id}:tutorSessionId`));
    setRestoredProblemId(id);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    setRestoredSceneProblemId(null);
    setLastValidatedSceneJson(null);
    const raw = localStorage.getItem(`workspace:${id}:scene`);
    if (!raw) {
      setScene("{}");
      setRestoredSceneProblemId(id);
      return;
    }
    try {
      // Older entries stored `{ sceneJson, imageBase64 }`. We now only persist
      // sceneJson; the legacy field is ignored on read.
      const parsed = JSON.parse(raw) as { sceneJson?: string };
      setScene(parsed.sceneJson ?? "{}");
    } catch {
      localStorage.removeItem(`workspace:${id}:scene`);
      setScene("{}");
    }
    setRestoredSceneProblemId(id);
  }, [id, setScene]);

  useEffect(() => {
    if (!id) return;
    setRestoredEstimationId(null);
    const raw = localStorage.getItem(`workspace:${id}:estimation`);
    if (!raw) {
      setEstimation({});
      setRestoredEstimationId(id);
      return;
    }
    try {
      setEstimation(migrateEstimationFromStorage(JSON.parse(raw) as WorkspaceEstimation));
    } catch {
      localStorage.removeItem(`workspace:${id}:estimation`);
      setEstimation({});
    }
    setRestoredEstimationId(id);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    setRestoredPhaseId(null);
    const raw = localStorage.getItem(`workspace:${id}:phase`);
    if (!raw) {
      setPhaseIndex(0);
      setElapsedInPhase(0);
      setPhaseRunning(false);
      setRestoredPhaseId(id);
      return;
    }
    try {
      const p = JSON.parse(raw) as PhasePersistState;
      setPhaseIndex(Math.min(p.phaseIndex ?? 0, Math.max(0, planPhases.length - 1)));
      setElapsedInPhase(p.elapsedSecInPhase ?? 0);
      setPhaseRunning(Boolean(p.running));
    } catch {
      localStorage.removeItem(`workspace:${id}:phase`);
      setPhaseIndex(0);
      setElapsedInPhase(0);
      setPhaseRunning(false);
    }
    setRestoredPhaseId(id);
  }, [id, planPhases.length]);

  useEffect(() => {
    if (!id || restoredProblemId !== id) return;
    if (interviewId) localStorage.setItem(`workspace:${id}:interviewId`, interviewId);
    else localStorage.removeItem(`workspace:${id}:interviewId`);
  }, [id, interviewId, restoredProblemId]);

  useEffect(() => {
    if (!id || restoredProblemId !== id) return;
    if (tutorSessionId) localStorage.setItem(`workspace:${id}:tutorSessionId`, tutorSessionId);
    else localStorage.removeItem(`workspace:${id}:tutorSessionId`);
  }, [id, tutorSessionId, restoredProblemId]);

  useEffect(() => {
    if (!id || restoredSceneProblemId !== id) return;
    localStorage.setItem(`workspace:${id}:scene`, JSON.stringify({ sceneJson }));
  }, [id, sceneJson, restoredSceneProblemId]);

  useEffect(() => {
    if (!id || restoredEstimationId !== id) return;
    localStorage.setItem(`workspace:${id}:estimation`, JSON.stringify(estimation));
  }, [id, estimation, restoredEstimationId]);

  useEffect(() => {
    if (!id || restoredPhaseId !== id) return;
    const persist: PhasePersistState = {
      phaseIndex,
      elapsedSecInPhase: elapsedInPhase,
      running: phaseRunning
    };
    localStorage.setItem(`workspace:${id}:phase`, JSON.stringify(persist));
  }, [id, phaseIndex, elapsedInPhase, phaseRunning, restoredPhaseId]);

  /** Post-turn refresh, shared by the text stream and by persisted voice
   * turns. Chat history first so the reply is visible, then the state the
   * server's proposal extractor and criterion matcher wrote after the turn. */
  const refreshAfterInterviewerTurn = async () => {
    await interviewMessagesQuery.refetch();
    await Promise.all([
      constraintsQuery.refetch(),
      criteriaProgressQuery.refetch(),
      phaseProposalQuery.refetch()
    ]);
  };

  /** Active live constraints, for the voice context feed. */
  const liveConstraintTexts =
    constraintsQuery.data?.constraints.filter((c) => c.status === "active").map((c) => c.text) ?? [];

  const buildWorkspaceContext = async (options?: { includeImage?: boolean }) => {
    // Capture the screenshot lazily, only when actually sending. Skipped when
    // the board is empty so we don't waste a multimodal slot — and skipped
    // entirely for a voice session, which has no multimodal slot to waste: the
    // realtime model reads the board as text.
    const includeImage = options?.includeImage !== false;
    const imageBase64 =
      includeImage && !sceneIsEmpty && captureSceneImage ? await captureSceneImage() : undefined;
    // Prefer the live (active) constraint set when an interview is active so
    // the tutor sees the same scope the interviewer is working against. The
    // interviewer endpoint will also override server-side as the source of truth.
    const liveActive =
      constraintsQuery.data?.constraints
        .filter((c) => c.status === "active")
        .map((c) => c.text) ?? null;
    const constraintsForContext =
      liveActive && liveActive.length > 0
        ? liveActive
        : problemQuery.data?.constraintsJson;
    return {
      workspaceContext: {
        problemId: id,
        problemTitle: problemQuery.data?.title,
        problemStatement: problemQuery.data?.statement,
        constraints: constraintsForContext,
        sceneSummary,
        imageBase64,
        notes: "Live whiteboard state from workspace",
        phase: {
          id: currentPhaseDef.id,
          label: currentPhaseDef.label,
          index: phaseIndex,
          total: planPhases.length,
          elapsedSec: elapsedInPhase,
          durationSec: currentPhaseDef.durationSec,
          running: phaseRunning
        },
        estimation: estimationPayload,
        estimationChecklist: {
          intro: estimationSpec.intro,
          fields: estimationSpec.fields.map((f) => ({
            key: f.key,
            label: f.label,
            hint: f.hint
          }))
        }
      }
    };
  };

  const validationHistory = [...(validationsQuery.data ?? [])].reverse();
  const latestValidation = validateMutation.data ?? validationHistory[0];
  const weakDims = aggregateWeakDimensions(validationsQuery.data ?? []);

  const doReplay = () => {
    if (!id) return;
    clearWorkspaceLocalState(id);
    setInterviewId(null);
    setTutorSessionId(null);
    setEstimation({});
    setPhaseIndex(0);
    setElapsedInPhase(0);
    setPhaseRunning(false);
    setScene("{}");
    setLastValidatedSceneJson(null);
    setTab("interviewer");
    setBoardKey((k) => k + 1);
    setRestoredEstimationId(id);
    setRestoredPhaseId(id);
    setReplayOpen(false);
  };

  const loadSceneFromEntry = (entry: ValidationRecord) => {
    setScene(entry.sceneJson);
    setLastValidatedSceneJson(null);
    setBoardKey((k) => k + 1);
    setLoadedHint(`Loaded diagram from ${new Date(entry.createdAt).toLocaleString()}`);
    window.setTimeout(() => setLoadedHint(null), 4000);
  };

  const exportMarkdown = async () => {
    const p = problemQuery.data;
    if (!p) return;
    const imageBase64 =
      !sceneIsEmpty && captureSceneImage ? await captureSceneImage() : undefined;

    // Every optional input is passed as-is; the report omits whatever section
    // has no data rather than printing an empty heading.
    const status = interviewStatusQuery.data;
    downloadMarkdown(
      reportFilename(p.title),
      buildAttemptMarkdownReport({
        problem: p,
        validations: validationsQuery.data ?? [],
        liveConstraints: interviewId ? constraintsQuery.data?.constraints : undefined,
        interview:
          interviewId && status
            ? {
                interviewerLevel: status.interviewerLevel,
                startedAt: status.startedAt,
                endedAt: status.endedAt,
                status: status.status
              }
            : undefined,
        debrief,
        criteria: criteriaRevealQuery.data?.criteria ?? undefined,
        estimationSpec,
        estimation: estimationPayload as WorkspaceEstimation,
        phaseTimeline: interviewId ? phaseTimelineQuery.data : undefined,
        reference: referenceQuery.data,
        transcript: interviewId ? interviewMessagesQuery.data : undefined,
        tutorUsage: interviewId ? tutorUsageQuery.data : undefined,
        imageBase64
      })
    );
  };

  return (
    <main className="mx-auto grid max-w-[1680px] grid-cols-1 gap-4 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(380px,36vw)] xl:grid-cols-[minmax(0,1fr)_540px]">
      <ConfirmDialog
        open={replayOpen}
        title="Replay from scratch?"
        description="Your canvas, active interview and tutor session will reset. Previous validations and chat history remain saved in the database."
        confirmLabel="Replay"
        onCancel={() => setReplayOpen(false)}
        onConfirm={doReplay}
      />

      <LevelChangeDialog
        open={pendingLevel !== null}
        fromLevel={interviewerLevel}
        toLevel={pendingLevel}
        busy={patchInterviewMutation.isPending}
        onCancel={() => setPendingLevel(null)}
        onChangeOnly={() =>
          pendingLevel &&
          patchInterviewMutation.mutate({ level: pendingLevel, regenerateCriteria: false })
        }
        onChangeAndRegenerate={() =>
          pendingLevel &&
          patchInterviewMutation.mutate({ level: pendingLevel, regenerateCriteria: true })
        }
      />

      <ConfirmDialog
        open={endOpen}
        title="End this interview?"
        description="This closes the conversation for good — the interviewer stops accepting messages — and writes your debrief from the transcript, the rubric and your latest validation. The board, Tutor and Export stay available."
        confirmLabel="End interview"
        onCancel={() => setEndOpen(false)}
        onConfirm={() => endInterviewMutation.mutate()}
      />

      {restoredSceneProblemId === id ? (
        <div className="panel overflow-hidden">
          <div className="excalidraw-wrapper">
            <Board key={`${id}-${boardKey}`} initialSceneJson={sceneJson} />
          </div>
        </div>
      ) : (
        <div className="panel flex h-[calc(100vh-112px)] items-center justify-center text-fg-muted">
          <div className="flex items-center gap-2">
            <Spinner /> Loading board...
          </div>
        </div>
      )}

      <section className="panel flex h-[calc(100vh-112px)] min-h-0 flex-col gap-2 overflow-hidden p-2 sm:p-3">
        {restoredPhaseId === id ? (
          <PhaseRibbon
            phases={planPhases}
            phaseIndex={phaseIndex}
            elapsedInPhase={elapsedInPhase}
            phaseRunning={phaseRunning}
            setPhaseRunning={setPhaseRunning}
            onNextPhase={advancePhase}
            transitionProposal={transitionProposal}
            onAcceptTransition={() => {
              advancePhase();
              resolvePhaseProposalMutation.mutate("apply");
            }}
            onDismissTransition={() => resolvePhaseProposalMutation.mutate("dismiss")}
            onResetPhases={() => {
              emitPhaseEvents(interviewId, [
                {
                  phaseId: currentPhaseDef.id,
                  phaseIndex,
                  kind: "reset",
                  elapsedSec: elapsedInPhase
                }
              ]);
              setPhaseIndex(0);
              setElapsedInPhase(0);
              setPhaseRunning(false);
            }}
          />
        ) : null}

        <WorkspaceProblemRail
          problemId={id}
          title={problemQuery.data?.title}
          difficulty={problemQuery.data?.difficulty}
          track={problemQuery.data?.track}
          statement={problemQuery.data?.statement}
          constraints={problemQuery.data?.constraintsJson ?? []}
          liveConstraints={
            interviewId ? constraintsQuery.data?.constraints : undefined
          }
          pendingProposals={
            interviewId ? constraintsQuery.data?.proposals : undefined
          }
          criteriaProgress={
            interviewId
              ? (criteriaProgressQuery.data && "totals" in criteriaProgressQuery.data
                  ? (criteriaProgressQuery.data as CriteriaProgress)
                  : undefined)
              : undefined
          }
          onAddConstraint={
            interviewId
              ? (text: string) => addConstraintMutation.mutate(text)
              : undefined
          }
          onRemoveConstraint={
            interviewId
              ? (constraintId: string) => removeConstraintMutation.mutate(constraintId)
              : undefined
          }
          onApplyProposal={
            interviewId
              ? (proposalId: string) => applyProposalMutation.mutate(proposalId)
              : undefined
          }
          onDismissProposal={
            interviewId
              ? (proposalId: string) => dismissProposalMutation.mutate(proposalId)
              : undefined
          }
          difficultyBadgeClass={difficultyBadgeClass}
        />

        <div className="flex shrink-0 items-center gap-2">
          <div className="tab-bar flex-1 flex-wrap">
            {TABS.map((t) => {
              const isActive = tab === t;
              const showCount =
                t === "estimation" && estimationCompletion.total > 0;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`pill-tab ${isActive ? "pill-tab-active" : "pill-tab-idle"} inline-flex items-center justify-center gap-1`}
                  title={t === "estimation" ? "Back-of-envelope checklist" : undefined}
                >
                  <span>{TAB_LABEL[t]}</span>
                  {showCount ? (
                    <span
                      className={`rounded-full px-1.5 text-[9px] font-semibold tabular-nums ${
                        isActive
                          ? "bg-white/25 text-white"
                          : "bg-violet-400/15 text-violet-600 dark:text-violet-300"
                      }`}
                    >
                      {estimationCompletion.filled}/{estimationCompletion.total}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setReplayOpen(true)}
            className="btn-icon-sm"
            title="Replay this problem from scratch (history is kept)"
            aria-label="Replay this problem from scratch"
          >
            <ReplayIcon />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "interviewer" && (
            <div className="flex h-full min-h-0 flex-col gap-2">
              {!interviewId ? (
                <div className="surface-inset flex flex-col gap-3 p-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-fg-faint">
                    Pick a difficulty
                  </p>
                  <select
                    value={interviewerLevel}
                    onChange={(e) => setInterviewerLevel(e.target.value as typeof interviewerLevel)}
                    className="field"
                  >
                    <option value="guided">Guided</option>
                    <option value="standard">Standard</option>
                    <option value="hard">Hard</option>
                    <option value="staff">Staff</option>
                  </select>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => startInterviewMutation.mutate()}
                    disabled={startInterviewMutation.isPending}
                  >
                    {startInterviewMutation.isPending ? (
                      <>
                        <Spinner /> Starting...
                      </>
                    ) : (
                      <>
                        <PlayIcon /> Start interview
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="flex h-full min-h-0 flex-col gap-2">
                  <label className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    <span className="shrink-0">Level (next message)</span>
                    <select
                      value={interviewerLevel}
                      disabled={patchInterviewMutation.isPending || interviewCompleted}
                      onChange={(e) => {
                        // Never applied silently: the level sets the
                        // hidden/visible split, so the candidate has to choose
                        // whether the rubric follows it.
                        setPendingLevel(e.target.value as typeof interviewerLevel);
                      }}
                      className="field min-w-[140px] !py-1.5 !text-xs"
                    >
                      <option value="guided">Guided</option>
                      <option value="standard">Standard</option>
                      <option value="hard">Hard</option>
                      <option value="staff">Staff</option>
                    </select>
                  </label>
                  {interviewStatusQuery.data?.rubricStale ? (
                    <p className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-400/[0.07] px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                      <span>
                        Grading still uses the rubric built for{" "}
                        <strong>{interviewStatusQuery.data.criteriaLevel}</strong>.
                      </span>
                      <button
                        type="button"
                        className="btn-secondary !px-2 !py-0.5 !text-[10px]"
                        onClick={() => regenerateCriteriaMutation.mutate()}
                        disabled={regenerateCriteriaMutation.isPending}
                      >
                        {regenerateCriteriaMutation.isPending
                          ? "Regenerating…"
                          : "Regenerate rubric"}
                      </button>
                    </p>
                  ) : null}
                  <div className="min-h-0 flex-1">
                    <VoicePanel
                      interviewId={interviewId}
                      endpoint={`/interviews/${interviewId}/messages`}
                      disabled={interviewCompleted}
                      disabledNotice="This interview is finished. Your debrief is on the Validate tab; the board and Tutor stay open, and Replay starts a fresh session."
                      buildPayload={buildWorkspaceContext}
                      onMessageComplete={refreshAfterInterviewerTurn}
                      // Spoken turns run the same server-side post-turn
                      // pipeline as typed ones, so they need the same refresh.
                      onVoiceTurnsPersisted={() => void refreshAfterInterviewerTurn()}
                      scene={sceneSummary}
                      constraints={liveConstraintTexts}
                      phaseLabel={currentPhaseDef.label}
                      estimation={estimationPayload}
                      // The mint needs everything the text path attaches to a
                      // message — board, estimation, checklist, phase — or the
                      // spoken interviewer cannot challenge a number it has
                      // never seen. No screenshot: realtime reads text only.
                      buildMintContext={async () =>
                        (await buildWorkspaceContext({ includeImage: false })).workspaceContext
                      }
                      initialMessages={(interviewMessagesQuery.data ?? [])
                        .filter((m): m is ChatMessage & { role: "user" | "assistant" } =>
                          isChatRole(m.role)
                        )
                        .map((m) => ({ role: m.role, content: m.content }))}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "tutor" && (
            <div className="h-full">
              {!tutorSessionId ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <div className="brand-mark h-12 w-12">
                    <BookIcon />
                  </div>
                  <p className="text-sm text-fg-muted">No tutor session yet for this problem.</p>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => startTutorMutation.mutate()}
                    disabled={startTutorMutation.isPending}
                  >
                    {startTutorMutation.isPending ? (
                      <>
                        <Spinner /> Starting
                      </>
                    ) : (
                      <>
                        <PlusIcon /> Start tutor session
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <ChatPanel
                  endpoint={`/tutor/sessions/${tutorSessionId}/messages`}
                  buildPayload={buildWorkspaceContext}
                  onMessageComplete={async () => {
                    await tutorMessagesQuery.refetch();
                  }}
                  initialMessages={(tutorMessagesQuery.data ?? [])
                    .filter((m): m is ChatMessage & { role: "user" | "assistant" } =>
                      isChatRole(m.role)
                    )
                    .map((m) => ({ role: m.role, content: m.content }))}
                />
              )}
            </div>
          )}

          {tab === "estimation" && (
            <div className="flex h-full min-h-0 flex-col">
              <EstimationPanel
                spec={estimationSpec}
                estimation={estimation}
                setEstimation={setEstimation}
                legacyDerived={legacyDerived}
                variant="tab"
              />
            </div>
          )}

          {tab === "validate" && (
            <div className="flex h-full flex-col gap-3 overflow-hidden">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => validateMutation.mutate()}
                  disabled={
                    validateMutation.isPending || sceneUnchangedSinceValidation
                  }
                  title={
                    sceneUnchangedSinceValidation
                      ? "Diagram unchanged since the last validation. Edit the board to re-validate."
                      : undefined
                  }
                >
                  {validateMutation.isPending ? (
                    <>
                      <Spinner /> Validating
                    </>
                  ) : (
                    <>
                      <CheckIcon /> Validate solution
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void exportMarkdown()}
                >
                  Export report
                </button>
                {interviewId && !interviewCompleted ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setEndOpen(true)}
                    disabled={!hasValidationAttempt || endInterviewMutation.isPending}
                    title={
                      hasValidationAttempt
                        ? "Close the interview and generate your debrief"
                        : "Validate at least once — the debrief is written against a graded attempt."
                    }
                  >
                    {endInterviewMutation.isPending ? (
                      <>
                        <Spinner /> Writing debrief
                      </>
                    ) : (
                      "End interview"
                    )}
                  </button>
                ) : null}
              </div>
              {endError ? (
                <p className="text-xs text-orange-600 dark:text-orange-400">{endError}</p>
              ) : null}
              {sceneUnchangedSinceValidation ? (
                <p className="text-xs text-fg-faint">
                  Diagram unchanged since last validation — edit the board to re-validate.
                </p>
              ) : null}
              {loadedHint ? (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">{loadedHint}</p>
              ) : null}

              <div className="flex-1 space-y-3 overflow-auto pr-1">
                {debrief ? (
                  <div className="surface-inset p-4">
                    <p className="mb-3 text-[10px] uppercase tracking-[0.18em] text-fg-faint">
                      Interview debrief
                    </p>
                    <InterviewDebriefPanel debrief={debrief} />
                  </div>
                ) : null}

                {weakDims.length > 0 ? (
                  <div className="surface-inset p-3">
                    <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-fg-faint">
                      Weakest dimensions (this problem)
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {weakDims.map(({ key, avg }) => (
                        <span
                          key={key}
                          className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] text-fg-muted"
                        >
                          {DIM_LABELS[key] ?? key}: {avg.toFixed(0)}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {latestValidation ? (
                  <div className="surface-inset p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-fg-faint">
                        Latest validation
                      </p>
                      <ScorePill score={latestValidation.score} />
                    </div>
                    <ScoreBandCallout
                      feedback={latestValidation.feedbackJson}
                      className="mb-3"
                    />
                    <TutorUsageChip usage={tutorUsageQuery.data} className="mb-3" />
                    <DesignDiscoverySubscores
                      feedback={latestValidation.feedbackJson}
                      className="mb-3"
                    />
                    <DimensionBreakdown feedback={latestValidation.feedbackJson} />
                    <div className="mt-3">
                      <FeedbackMarkdownBody feedback={latestValidation.feedbackJson} />
                    </div>
                    {interviewId &&
                    criteriaRevealQuery.data?.criteria &&
                    criteriaRevealQuery.data.criteria.length > 0 ? (
                      <div className="mt-4 border-t border-line/60 pt-3">
                        <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-fg-faint">
                          Rubric reveal — what was being graded
                        </p>
                        <CriteriaReveal
                          criteria={criteriaRevealQuery.data.criteria}
                          feedback={latestValidation.feedbackJson}
                          criterionCoverage={referenceQuery.data?.criterionCoverage}
                        />
                      </div>
                    ) : null}
                    {(latestValidation.feedbackJson?.flagObservations ?? []).length > 0 ? (
                      <div className="mt-4 border-t border-line/60 pt-3">
                        <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-fg-faint">
                          Observed signals
                        </p>
                        <FlagsPanel feedback={latestValidation.feedbackJson} />
                      </div>
                    ) : null}
                    {latestValidation.feedbackJson?.processAssessment ? (
                      <div className="mt-4 border-t border-line/60 pt-3">
                        <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-fg-faint">
                          How you worked
                        </p>
                        <ProcessPanel feedback={latestValidation.feedbackJson} />
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {hasValidationAttempt ? (
                  <div className="surface-inset p-4">
                    <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-fg-faint">
                      Reference solution
                    </p>
                    {referenceQuery.isLoading ? (
                      <p className="text-sm text-fg-muted">Loading reference…</p>
                    ) : referenceQuery.isError ? (
                      <p className="text-sm text-orange-600 dark:text-orange-400">
                        Could not load reference. Try again in a moment.
                      </p>
                    ) : referenceQuery.data ? (
                      <div className="prose-chat text-sm text-fg-muted">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {markdownFromReference(referenceQuery.data)}
                        </ReactMarkdown>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="surface-inset p-4 text-sm text-fg-faint">
                    Validate at least once to unlock a reference solution.
                  </div>
                )}

                <div className="surface-inset p-4">
                  <p className="mb-2 text-[10px] uppercase tracking-[0.18em] text-fg-faint">
                    Validation history
                  </p>
                  <div className="space-y-2">
                    {validationHistory.length === 0 ? (
                      <p className="text-sm text-fg-faint">No validation history yet.</p>
                    ) : (
                      validationHistory.map((entry) => (
                        <div
                          key={entry.id}
                          className="rounded-xl border border-line bg-surface p-3 text-sm"
                        >
                          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs text-fg-faint">
                              {new Date(entry.createdAt).toLocaleString()}
                            </p>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className="btn-secondary !px-2 !py-1 !text-[11px]"
                                onClick={() => loadSceneFromEntry(entry)}
                              >
                                Load diagram
                              </button>
                              <ScorePill score={entry.score} small />
                            </div>
                          </div>
                          <DimensionBreakdown
                            small
                            feedback={entry.feedbackJson}
                            className="mb-2"
                          />
                          <FeedbackMarkdownBody feedback={entry.feedbackJson} />
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

/**
 * Three-way choice for a mid-interview level change.
 *
 * Not a plain confirm, because there are two legitimate outcomes and both have
 * a real cost. Regenerating resyncs grading but discards every hidden
 * expectation the candidate already surfaced; changing only the level keeps
 * that progress but grades against a rubric written for the old level. The
 * copy has to say so plainly — this is exactly the trade-off the candidate is
 * being asked to make.
 */
function LevelChangeDialog({
  open,
  fromLevel,
  toLevel,
  busy,
  onCancel,
  onChangeOnly,
  onChangeAndRegenerate
}: {
  open: boolean;
  fromLevel: string;
  toLevel: string | null;
  busy: boolean;
  onCancel: () => void;
  onChangeOnly: () => void;
  onChangeAndRegenerate: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open || !toLevel) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="level-change-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        aria-label="Close"
        onClick={onCancel}
      />
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-line bg-surface-strong p-6 shadow-2xl">
        <h2 id="level-change-title" className="text-lg font-semibold text-fg">
          Switch from {fromLevel} to {toLevel}?
        </h2>
        <p className="mt-2 text-sm text-fg-muted">
          The level decides how much of the rubric is hidden from you. Your current rubric
          was built for <strong>{fromLevel}</strong>, so you can either rebuild it for{" "}
          <strong>{toLevel}</strong> or keep it as it is.
        </p>
        <ul className="mt-3 space-y-2 text-xs text-fg-muted">
          <li>
            <strong className="text-fg">Regenerate</strong> — grading matches the new level, but{" "}
            <strong>your discovery progress resets</strong>: every hidden expectation you already
            surfaced goes back to hidden, and constraints you earned lose their discovery pill.
          </li>
          <li>
            <strong className="text-fg">Change level only</strong> — the interviewer behaves at the
            new level, but grading still uses the rubric built for {fromLevel}.
          </li>
        </ul>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-secondary" onClick={onChangeOnly} disabled={busy}>
            Change level only
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={onChangeAndRegenerate}
            disabled={busy}
          >
            {busy ? "Working…" : "Change and regenerate"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Factual one-liner on tutor consultation.
 *
 * Neutral by design: no warning colour, no comparison, no advice. It exists so
 * that when you re-read this attempt in a month you can tell a score reached
 * with help apart from one reached without it. Renders nothing when the tutor
 * was never used. */
function TutorUsageChip({
  usage,
  className = ""
}: {
  usage?: InterviewTutorUsage;
  className?: string;
}) {
  if (!usage || usage.candidateTurns === 0) return null;
  const topics = usage.topics.length > 0 ? ` · ${usage.topics.join(", ")}` : "";
  const phase = usage.firstUsedAtPhase ? ` · from ${usage.firstUsedAtPhase}` : "";
  return (
    <p
      className={`rounded-lg border border-line bg-surface px-2 py-1 text-[11px] text-fg-muted ${className}`}
      title="Recorded for your own reference — it does not affect your score."
    >
      Tutor consulted {usage.candidateTurns}{" "}
      {usage.candidateTurns === 1 ? "time" : "times"}
      {phase}
      {topics}
    </p>
  );
}

function ScorePill({ score, small }: { score?: number | null; small?: boolean }) {
  const display = score ?? "N/A";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-gradient-to-r from-violet-400/15 to-fuchsia-400/10 ${
        small ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"
      } font-semibold text-fg`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-br from-violet-400 to-fuchsia-400" />
      Score {display}
    </span>
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

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
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

function BookIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
