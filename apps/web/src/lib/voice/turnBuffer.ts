import { INAUDIBLE_TURN_CONTENT, VOICE_CONTEXT_ITEM_PREFIX } from "@sdl/shared";
import type { VoiceTurn } from "@sdl/shared";

/**
 * Orders and pairs spoken turns before they are persisted.
 *
 * The problem this solves is not obvious from the event names. Transcription of
 * the candidate's audio runs **asynchronously with respect to response
 * generation** — the API documents that
 * `conversation.item.input_audio_transcription.completed` "can come before or
 * after the response events". So the interviewer's reply routinely arrives
 * before the transcript of the question it answered.
 *
 * Persisting on arrival would store the interviewer answering a question the
 * candidate had not yet asked. That transcript is what the debrief is graded
 * against and what the export shows, so it has to be right.
 *
 * The rule: emit the longest **complete prefix** in conversation order. Order is
 * assigned when an item is first seen, not when its text finishes.
 */

type PendingItem = {
  externalId: string;
  role: "user" | "assistant";
  content: string;
  complete: boolean;
  /** Conversation order, from the sequence items were created in. */
  order: number;
  /** When the item was first seen, for the stall timeout. */
  seenAtMs: number;
  interrupted?: boolean;
};

/**
 * How long to wait for a transcript before giving up on it.
 *
 * A gap is much better than a dropped turn: the criterion matcher reads the
 * assistant's reply, and without the question it answered the transcript reads
 * as the interviewer asking something out of nowhere — which then also blocks
 * every later turn behind it.
 */
export const TRANSCRIPT_STALL_TIMEOUT_MS = 15_000;

export class TurnBuffer {
  private items = new Map<string, PendingItem>();
  private nextOrder = 0;

  /** Register an item the moment it exists, which is what fixes the ordering.
   * Idempotent: the same item is announced by more than one event. */
  noteItem(externalId: string, role: "user" | "assistant", seenAtMs: number): void {
    if (!externalId || this.items.has(externalId)) return;
    this.items.set(externalId, {
      externalId,
      role,
      content: "",
      complete: false,
      order: this.nextOrder++,
      seenAtMs
    });
  }

  appendDelta(externalId: string, delta: string, seenAtMs: number, role: "user" | "assistant"): void {
    if (!externalId || !delta) return;
    this.noteItem(externalId, role, seenAtMs);
    const item = this.items.get(externalId);
    if (!item || item.complete) return;
    item.content += delta;
  }

  /** Final text wins over accumulated deltas — deltas can be lossy, and the
   * completed event carries the authoritative transcript. */
  completeItem(
    externalId: string,
    role: "user" | "assistant",
    seenAtMs: number,
    finalText?: string
  ): void {
    if (!externalId) return;
    this.noteItem(externalId, role, seenAtMs);
    const item = this.items.get(externalId);
    if (!item) return;
    const text = (finalText ?? item.content).trim();
    item.content = text;
    item.complete = true;
  }

  /** Transcription failed outright. Complete it as a gap so the turns queued
   * behind it are not stranded. */
  failItem(externalId: string, role: "user" | "assistant", seenAtMs: number): void {
    this.noteItem(externalId, role, seenAtMs);
    const item = this.items.get(externalId);
    if (!item || item.complete) return;
    item.content = item.content.trim() || INAUDIBLE_TURN_CONTENT;
    item.complete = true;
  }

  /** Mark an assistant item as cut short. The transcript must show only what
   * was actually heard — a post-mortem against words the candidate never heard
   * is worse than no post-mortem. */
  markInterrupted(externalId: string, spokenText?: string): void {
    const item = this.items.get(externalId);
    if (!item) return;
    item.interrupted = true;
    if (typeof spokenText === "string") item.content = spokenText.trim();
    item.complete = true;
  }

  /**
   * Take everything ready to persist, in conversation order.
   *
   * Stops at the first incomplete item so ordering is never violated, except
   * where that item has been waiting past the stall timeout — in which case it
   * is recorded as inaudible rather than blocking the session's whole tail.
   */
  drain(nowMs: number): VoiceTurn[] {
    const ordered = [...this.items.values()].sort((a, b) => a.order - b.order);
    const ready: VoiceTurn[] = [];

    for (const item of ordered) {
      if (!item.complete) {
        if (nowMs - item.seenAtMs < TRANSCRIPT_STALL_TIMEOUT_MS) break;
        item.content = item.content.trim() || INAUDIBLE_TURN_CONTENT;
        item.complete = true;
      }

      this.items.delete(item.externalId);

      // Injected workspace context lives in the model's conversation but is not
      // an interview turn: it must never reach `interview_messages`, the chat
      // panel, or the debrief. Checked here, in one place.
      const content = item.content.trim();
      if (!content || content.startsWith(VOICE_CONTEXT_ITEM_PREFIX)) continue;

      ready.push({
        externalId: item.externalId,
        role: item.role,
        content,
        ...(item.interrupted ? { interrupted: true } : {})
      });
    }

    return ready;
  }

  /** Force-complete everything, for session teardown. Losing the tail of a
   * transcript is the one failure mode here worth being aggressive about. */
  flushAll(nowMs: number): VoiceTurn[] {
    for (const item of this.items.values()) {
      if (!item.complete) {
        item.content = item.content.trim() || INAUDIBLE_TURN_CONTENT;
        item.complete = true;
      }
    }
    return this.drain(nowMs);
  }

  get pendingCount(): number {
    return this.items.size;
  }
}
