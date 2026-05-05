import axios from "axios";
import type {
  ConstraintProposal,
  CriterionEvaluation,
  Difficulty,
  Importance,
  LiveConstraint,
  RubricCriterion,
  ScoreDimension
} from "@sdl/shared";

export type {
  ConstraintProposal,
  CriterionEvaluation,
  Importance,
  LiveConstraint,
  RubricCriterion,
  ScoreDimension
} from "@sdl/shared";

export type InterviewConstraintState = {
  constraints: LiveConstraint[];
  proposals: ConstraintProposal[];
};

/** Progress-only view of the per-interview criteria. Returned by
 * `GET /interviews/:id/criteria`. Safe to call any time — no hidden text. */
export type CriteriaProgress = {
  totals: { total: number; core: number; expected: number; stretch: number };
  hidden: { total: number; discovered: number; core: number; coreDiscovered: number };
  visible: { total: number };
  discoveredCriterionIds: string[];
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
  dimensions?: FeedbackDimensions;
  dimensionNotes?: Record<string, string>;
  /** Per-criterion outcomes — present when the validator was given criteria. */
  criteriaEvaluations?: CriterionEvaluation[];
  /** Convenience: criterion ids of importance="core" that the design covered. */
  coreCovered?: string[];
  /** Convenience: criterion ids of importance="core" that the design missed. */
  coreMissed?: string[];
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
  referenceJson?: unknown;
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

export async function streamEndpoint(
  url: string,
  payload: Record<string, unknown>,
  onToken: (token: string) => void
) {
  const response = await fetch(`${API_BASE}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    throw new Error("Failed to stream response");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (!part.startsWith("data:")) continue;
      const raw = part.replace("data:", "").trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed.token) onToken(parsed.token);
      } catch {
        // ignore malformed chunks
      }
    }
  }
}
