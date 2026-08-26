import { VOICE_CONTEXT_ITEM_PREFIX } from "@sdl/shared";
import type { SceneSummary } from "@sdl/shared";
import type { VoiceTurnState } from "@sdl/shared";

/**
 * Keeps a live voice session aware of the whiteboard.
 *
 * A realtime session receives its instructions **once**, at mint time. Ten
 * minutes in, the candidate has drawn the whole architecture and the interviewer
 * is still reasoning about an empty canvas — so the single most distinctive
 * thing about this product stops working exactly when the conversation gets
 * good. The text path never had this problem: it re-attaches a fresh
 * `workspaceContext` to every message.
 *
 * The fix is a delta pushed over the data channel. The care is all in *when*:
 *
 *  - Drawing produces a continuous stream of scene mutations. One injection per
 *    stroke would cost a fortune and drown the conversation, so changes are
 *    diffed against the last **sent** snapshot and rate-limited.
 *  - Never mid-sentence. An item created while the candidate is speaking is a
 *    context switch the model may read as a new user turn, so deltas queue and
 *    flush at the turn boundary.
 *  - Phase changes and constraint edits are discrete, candidate-initiated and
 *    worth interrupting for, so they bypass the rate limit.
 */

export const CONTEXT_MIN_INTERVAL_MS = 10_000;

export type ContextSnapshot = {
  scene?: SceneSummary;
  /** Server-authoritative live constraints. Never the client's own copy — a
   * stale client must not be able to redefine the scope, which is the rule the
   * text path already enforces server-side. */
  constraints: string[];
  phaseLabel?: string;
  /** The candidate's estimation figures, keyed by field. Changes here are
   * exactly the moment the interviewer should push back on a number, so they
   * must not wait for the next mint. */
  estimation?: Record<string, unknown>;
};

export type ContextDelta = { text: string; urgent: boolean };

const EMPTY: ContextSnapshot = { constraints: [] };

/** Human-readable diff of two board states.
 *
 * A diff, not a resend: naming the one node that appeared is a sentence the
 * model can act on, where the whole board re-listed every ten seconds is noise
 * it learns to ignore.
 */
export function diffContext(previous: ContextSnapshot, next: ContextSnapshot): ContextDelta | null {
  const parts: string[] = [];

  const prevNodes = nodeLabels(previous.scene);
  const nextNodes = nodeLabels(next.scene);
  const addedNodes = difference(nextNodes, prevNodes);
  const removedNodes = difference(prevNodes, nextNodes);

  const prevEdges = edgeLabels(previous.scene);
  const nextEdges = edgeLabels(next.scene);
  const addedEdges = difference(nextEdges, prevEdges);

  if (addedNodes.length > 0) parts.push(`drew ${list(addedNodes)}`);
  if (removedNodes.length > 0) parts.push(`removed ${list(removedNodes)}`);
  if (addedEdges.length > 0) parts.push(`connected ${list(addedEdges)}`);

  const addedConstraints = difference(next.constraints, previous.constraints);
  const removedConstraints = difference(previous.constraints, next.constraints);
  const scopeChanged = addedConstraints.length > 0 || removedConstraints.length > 0;
  if (addedConstraints.length > 0) parts.push(`scope now includes ${list(addedConstraints)}`);
  if (removedConstraints.length > 0) parts.push(`scope no longer includes ${list(removedConstraints)}`);

  // Estimation is reported as named field changes, not as a JSON blob: the
  // interviewer has to say the number out loud to challenge it.
  const estimationChanges = diffEstimation(previous.estimation, next.estimation);
  if (estimationChanges.length > 0) {
    parts.push(`filled in ${list(estimationChanges)}`);
  }

  const phaseChanged = Boolean(next.phaseLabel) && next.phaseLabel !== previous.phaseLabel;
  if (phaseChanged) parts.push(`now in the ${next.phaseLabel} phase`);

  if (parts.length === 0) return null;

  return {
    // The prefix is what keeps these out of the transcript and out of the
    // debrief — see `TurnBuffer.drain`.
    text: `${VOICE_CONTEXT_ITEM_PREFIX} Since you last looked, the candidate ${parts.join("; ")}. Do not read this out or thank them for it; just take it into account.`,
    // Scope, phase and a committed number are candidate-initiated decisions,
    // not drawing noise.
    urgent: scopeChanged || phaseChanged || estimationChanges.length > 0
  };
}

/**
 * Rate-limits and gates deltas. Pure apart from the clock, which is passed in.
 */
export class ContextFeed {
  private sent: ContextSnapshot = EMPTY;
  private queued: ContextDelta | null = null;
  private lastSentAtMs = Number.NEGATIVE_INFINITY;

  /**
   * Offer the current workspace state.
   *
   * Returns the text to inject, or null to send nothing. A null covers three
   * distinct cases on purpose — nothing changed, too soon, or the candidate is
   * mid-sentence — because the caller does the same thing in all three.
   */
  offer(next: ContextSnapshot, turnState: VoiceTurnState, nowMs: number): string | null {
    const delta = diffContext(this.sent, next);
    if (delta) {
      // Merge rather than replace: two ten-second windows of drawing must not
      // lose the first window's nodes.
      this.queued = this.queued
        ? { text: `${this.queued.text}\n${delta.text}`, urgent: this.queued.urgent || delta.urgent }
        : delta;
      // Record the snapshot as sent the moment it is queued, so the next diff is
      // against what we are about to say, not what we last said.
      this.sent = cloneSnapshot(next);
    }

    if (!this.queued) return null;

    // Never interrupt a sentence in progress. `thinking` and
    // `interviewerSpeaking` are fine: the model is between candidate turns.
    if (turnState === "candidateSpeaking") return null;

    if (!this.queued.urgent && nowMs - this.lastSentAtMs < CONTEXT_MIN_INTERVAL_MS) return null;

    const text = this.queued.text;
    this.queued = null;
    this.lastSentAtMs = nowMs;
    return text;
  }

  /** Seed the baseline at connect time: the mint already carried this state in
   * the instructions, so it must not be re-sent as a delta. */
  seed(snapshot: ContextSnapshot): void {
    this.sent = cloneSnapshot(snapshot);
    this.queued = null;
  }

  get hasQueued(): boolean {
    return this.queued !== null;
  }
}

function nodeLabels(scene?: SceneSummary): string[] {
  return (scene?.nodes ?? [])
    .map((n) => (n.kind ? `${n.label} (${n.kind})` : n.label))
    .filter((label) => label.trim().length > 0);
}

function edgeLabels(scene?: SceneSummary): string[] {
  const byId = new Map((scene?.nodes ?? []).map((n) => [n.id, n.label]));
  return (scene?.edges ?? []).map((e) => {
    const from = byId.get(e.from) ?? e.from;
    const to = byId.get(e.to) ?? e.to;
    return e.label ? `${from} to ${to} (${e.label})` : `${from} to ${to}`;
  });
}

/** Field-level estimation diff, rendered as "label = value" so the interviewer
 * can quote the figure back. Only changed and newly-filled fields appear. */
function diffEstimation(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined
): string[] {
  if (!next) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined || value === "") continue;
    const before = previous?.[key];
    if (before === value) continue;
    if (JSON.stringify(before) === JSON.stringify(value)) continue;
    out.push(`${key} = ${formatValue(value)}`);
  }
  return out;
}

function formatValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // A nested object is a derived block; naming it is more useful than dumping it.
  return "(set)";
}

function difference(a: string[], b: string[]): string[] {
  const seen = new Set(b);
  const out: string[] = [];
  for (const item of a) {
    if (seen.has(item) || out.includes(item)) continue;
    out.push(item);
  }
  return out;
}

/** Spoken-language list. The interviewer reads this, and "a, b and c" is what a
 * person would say where "a, b, c" is what a spreadsheet would. */
function list(items: string[]): string {
  const clipped = items.slice(0, 6);
  const more = items.length - clipped.length;
  const joined =
    clipped.length <= 1
      ? (clipped[0] ?? "")
      : `${clipped.slice(0, -1).join(", ")} and ${clipped[clipped.length - 1]}`;
  return more > 0 ? `${joined} and ${more} more` : joined;
}

function cloneSnapshot(snapshot: ContextSnapshot): ContextSnapshot {
  return {
    scene: snapshot.scene
      ? {
          nodes: snapshot.scene.nodes.map((n) => ({ ...n })),
          edges: snapshot.scene.edges.map((e) => ({ ...e })),
          summaryText: snapshot.scene.summaryText
        }
      : undefined,
    constraints: [...snapshot.constraints],
    phaseLabel: snapshot.phaseLabel,
    estimation: snapshot.estimation ? { ...snapshot.estimation } : undefined
  };
}
