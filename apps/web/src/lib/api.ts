import axios from "axios";
import type {
  ConstraintProposal,
  CriterionEvaluation,
  Difficulty,
  FlagObservation,
  Importance,
  InterviewDebrief,
  InterviewerLevel,
  LiveConstraint,
  PhaseProposalState,
  PhaseTimeline,
  ProcessAssessment,
  RubricCriterion,
  ScoreBand,
  ScoreDimension,
  Track,
  TutorUsage,
  VoiceSessionResponse,
  VoiceTurn,
  VoiceTurnsResponse
} from "@sdl/shared";

export type {
  ConstraintProposal,
  CriterionEvaluation,
  DebriefRecommendation,
  DebriefStudyItem,
  FlagObservation,
  Importance,
  InterviewDebrief,
  InterviewerLevel,
  LiveConstraint,
  PhaseEventKind,
  PhaseProposalState,
  PhaseTimeline,
  PhaseTimelineEntry,
  PhaseTransitionProposal,
  ProcessAssessment,
  RubricCriterion,
  ScoreBand,
  ScoreDimension,
  Track,
  TutorUsage,
  VoiceConnectionStatus,
  VoiceSessionResponse,
  VoiceTurn,
  VoiceTurnState,
  VoiceTurnsResponse
} from "@sdl/shared";

export type InterviewConstraintState = {
  constraints: LiveConstraint[];
  proposals: ConstraintProposal[];
};

/** Per-phase actual vs budget, reduced server-side from the append-only phase
 * event log. Returned by `GET /interviews/:id/phase-timeline`. */
export type InterviewPhaseTimeline = PhaseTimeline;

/** Live phase-transition offer plus the phases already answered for. Returned
 * by `GET /interviews/:id/phase-proposal`. */
export type InterviewPhaseProposalState = PhaseProposalState;

/** Lifecycle snapshot from `GET /interviews/:id/status`. `status` is `active`
 * until the candidate ends the interview; `debrief` is null until then (and on
 * every legacy row). */
export type InterviewStatus = {
  id: string;
  status: "active" | "completed" | string;
  interviewerLevel: InterviewerLevel;
  /** Level the stored rubric was generated FOR. Null on legacy rows. */
  criteriaLevel: InterviewerLevel | null;
  /** True only when the rubric is known to have been built for a different
   * level. Legacy rows (`criteriaLevel: null`) always report false. */
  rubricStale: boolean;
  startedAt: string;
  endedAt: string | null;
  debrief: InterviewDebrief | null;
};

/** Factual tutor consultation record. Returned by
 * `GET /interviews/:id/tutor-usage`; zeros when the tutor was never used. */
export type InterviewTutorUsage = TutorUsage;

/** `PATCH /interviews/:id` response. */
export type PatchInterviewResponse = {
  id: string;
  interviewerLevel: InterviewerLevel;
  criteriaLevel: InterviewerLevel | null;
  rubricStale: boolean;
};

/** `POST /interviews/:id/end`. Idempotent — `alreadyEnded` is true when the
 * stored debrief was returned rather than a freshly generated one. */
export type EndInterviewResponse = {
  id: string;
  status: string;
  endedAt: string | null;
  debrief: InterviewDebrief;
  alreadyEnded: boolean;
};

/** Progress-only view of the per-interview criteria. Returned by
 * `GET /interviews/:id/criteria`. Safe to call any time — no hidden text. */
export type CriteriaProgress = {
  totals: { total: number; core: number; expected: number; stretch: number };
  hidden: { total: number; discovered: number; core: number; coreDiscovered: number };
  visible: { total: number };
  discoveredCriterionIds: string[];
  /** Hidden criteria already discovered — safe to render as plain text. */
  surfacedHidden: Array<{ id: string; text: string; importance: Importance }>;
};

export type CriteriaProgressResponse = CriteriaProgress | { criteria: null };

/** Full reveal payload — only available after at least one validation has
 * been submitted. Returned by `GET /interviews/:id/criteria/reveal`. */
export type CriteriaRevealResponse = {
  criteria: RubricCriterion[] | null;
};

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

export const api = axios.create({ baseURL: API_BASE });

/** Dimension scores can be `null` when the dimension is out of scope for
 * the active rubric — the UI hides those bars instead of rendering misleading
 * middling values. */
export type FeedbackDimensions = {
  requirements?: number | null;
  scalability?: number | null;
  reliability?: number | null;
  consistency?: number | null;
  latencyPerformance?: number | null;
  cost?: number | null;
  security?: number | null;
  operability?: number | null;
  capacityEstimation?: number | null;
};

export type ValidationFeedback = {
  /** Blended overall (server-computed from designScore × w + discoveryScore × (1-w)). */
  score?: number;
  /** Score for the diagram/notes against active scope, regardless of how
   * much the candidate uncovered in dialogue. */
  designScore?: number;
  /** Score for how much of the hidden scope the candidate surfaced via
   * clarifying questions or commitments. */
  discoveryScore?: number;
  /** Which regime produced `designScore` — `rubric` (weighted criteria
   * coverage) or the `dimensions` fallback. Absent on legacy rows. */
  scoringMode?: "rubric" | "dimensions";
  /** 1-4 band for the overall score, with the interview playbook's calibrated
   * description (or a generic fallback). Absent on legacy rows. */
  scoreBand?: { band: ScoreBand; label: string };
  dimensions?: FeedbackDimensions;
  dimensionNotes?: Record<string, string>;
  /** Per-criterion outcomes — present when the validator was given criteria. */
  criteriaEvaluations?: CriterionEvaluation[];
  /** Convenience: criterion ids of importance="core" that the design covered. */
  coreCovered?: string[];
  /** Convenience: criterion ids of importance="core" that the design missed. */
  coreMissed?: string[];
  /** Playbook green/red flags judged against this attempt. Reported only —
   * these never move the score. Absent when the interview has no playbook. */
  flagObservations?: FlagObservation[];
  /** How the candidate worked, from the transcript. Present only on attempts
   * that had an interview; reported, never scored. */
  processAssessment?: ProcessAssessment;
  strengths?: string[];
  gaps?: string[];
  nextSteps?: string[];
};

export type Problem = {
  id: string;
  title: string;
  statement: string;
  difficulty: Difficulty;
  constraintsJson: string[];
  evaluationRubricJson: string[];
  tagsJson?: string[] | null;
  /** Role archetype, or null for "unspecified" (every problem generated
   * before tracks existed). */
  track?: Track | null;
  referenceJson?: unknown;
  narrativeJson?: unknown;
  estimationSpecJson?: unknown;
  interviewPlanJson?: unknown;
  createdAt: string;
};

export type ReferenceSolution = {
  summary: string;
  components: Array<{ name: string; role: string; tradeoffs: string }>;
  dataFlow: string;
  keyTradeoffs: string[];
  deepDives: string[];
  /** Present only on interview-scoped references. Ids are already resolved
   * server-side against that interview's rubric. */
  criterionCoverage?: Array<{ criterionId: string; howAddressed: string }>;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type EstimationDerived = {
  rpsAvg?: number;
  rpsPeak?: number;
  rpsRead?: number;
  rpsWrite?: number;
  storageBytes?: number;
  bandwidthBps?: number;
};

/** Values are keyed by estimation field `key` (snake_case for AI-generated or legacy specs). */
export type WorkspaceEstimation = Record<string, unknown> & {
  derived?: EstimationDerived;
};

export type ValidationRecord = {
  id: string;
  problemId: string;
  sceneJson: string;
  score: number | null;
  feedbackJson: ValidationFeedback | null;
  estimationJson?: Record<string, unknown> | null;
  createdAt: string;
};

/** Thrown when a streaming endpoint fails. `status` is 0 when the request
 * never reached the server (network/CORS). */
export class StreamError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "StreamError";
  }
}

type StreamOptions = {
  /** Aborts the request. The partial text already delivered via `onToken` is
   * kept by the caller — aborting resolves normally rather than throwing. */
  signal?: AbortSignal;
};

/** Reads a `text/event-stream` response, forwarding `{ token }` payloads.
 *
 * Parses SSE properly (per-line `field: value`, blank line terminates the
 * event) instead of assuming every frame is a single `data:` line — the
 * server also emits a terminating `event: done` frame, and a naive
 * `startsWith("data:")` check silently swallows anything else.
 */
export async function streamEndpoint(
  url: string,
  payload: Record<string, unknown>,
  onToken: (token: string) => void,
  options: StreamOptions = {}
) {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal
    });
  } catch (err) {
    if (options.signal?.aborted) return;
    throw new StreamError(
      err instanceof Error ? err.message : "Could not reach the server",
      0
    );
  }

  if (!response.ok || !response.body) {
    // Error responses are plain JSON, not SSE — surface the server's message
    // so the UI can show something better than "failed".
    let detail = `Request failed (${response.status})`;
    try {
      const text = await response.text();
      const parsed: unknown = text ? JSON.parse(text) : null;
      const message =
        parsed && typeof parsed === "object" && "message" in parsed
          ? (parsed as { message: unknown }).message
          : null;
      if (typeof message === "string" && message) detail = message;
      else if (Array.isArray(message) && typeof message[0] === "string") detail = message[0];
      else if (text && !parsed) detail = text.slice(0, 200);
    } catch {
      // keep the status-code fallback
    }
    throw new StreamError(detail, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /** Handles one complete SSE event (the text between blank lines). */
  const handleEvent = (raw: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const sep = line.indexOf(":");
      const field = sep === -1 ? line : line.slice(0, sep);
      const value = sep === -1 ? "" : line.slice(sep + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
    }
    if (event === "done" || dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (data === "done" || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed?.error === "string") throw new StreamError(parsed.error, 500);
      // Empty-string tokens are legitimate no-ops; `typeof` avoids dropping "0".
      if (typeof parsed?.token === "string" && parsed.token) onToken(parsed.token);
    } catch (err) {
      if (err instanceof StreamError) throw err;
      // Ignore malformed chunks — a truncated frame is not worth failing over.
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalise CRLF so the frame split below works against either encoding.
      buffer = buffer.replace(/\r\n/g, "\n");
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) handleEvent(part);
    }
    if (buffer.trim()) handleEvent(buffer);
  } catch (err) {
    // An abort mid-stream is a user action, not a failure: keep what arrived.
    if (options.signal?.aborted) return;
    throw err;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

/** The URL the browser POSTs its SDP offer to.
 *
 * The candidate's audio goes straight from their machine to OpenAI — it never
 * transits this app's API — which is why the transcript has to be posted back
 * separately (see `postVoiceTurns`). */
export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/** Mint a realtime credential for this interview.
 *
 * The response deliberately carries no `instructions`: the interviewer prompt
 * embeds the hidden rubric verbatim, so it is baked into the credential
 * server-side and never reaches the browser. */
export async function createVoiceSession(
  interviewId: string,
  workspaceContext?: Record<string, unknown>
): Promise<VoiceSessionResponse> {
  return (
    await api.post<VoiceSessionResponse>(`/interviews/${interviewId}/voice/session`, {
      workspaceContext
    })
  ).data;
}

/** Record completed spoken turns. Idempotent on `externalId`. */
export async function postVoiceTurns(
  interviewId: string,
  turns: VoiceTurn[],
  audioSecondsTotal?: number
): Promise<VoiceTurnsResponse> {
  return (
    await api.post<VoiceTurnsResponse>(`/interviews/${interviewId}/voice/turns`, {
      turns,
      audioSecondsTotal
    })
  ).data;
}

/**
 * Exchange an SDP offer for an answer, establishing the media path.
 *
 * `Content-Type: application/sdp` and a raw-string body, not JSON — the one
 * endpoint in this client that is not.
 */
export async function exchangeSdp(offerSdp: string, clientSecret: string): Promise<string> {
  const response = await fetch(REALTIME_CALLS_URL, {
    method: "POST",
    body: offerSdp,
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp"
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new StreamError(
      `Voice connection was refused (${response.status}). ${detail.slice(0, 200)}`.trim(),
      response.status
    );
  }
  return response.text();
}
