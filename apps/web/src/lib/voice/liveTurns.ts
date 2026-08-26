/**
 * The provisional transcript — speech as it is being spoken.
 *
 * Pure list operations, extracted from the session hook because the subtle bug
 * here is invisible on inspection and only reproduces under load. Appending a
 * delta must happen INSIDE the state update, against the previous list. Reading
 * the current text from a ref and appending to that looks equivalent and is not:
 * refs only refresh on render, so several deltas arriving inside one frame each
 * compute from the same stale base and only the last survives — the candidate
 * watches their own sentence get overwritten a word at a time.
 */

export type ProvisionalTurn = {
  externalId: string;
  role: "user" | "assistant";
  content: string;
  /** True while later deltas may still revise the text. */
  provisional: boolean;
  interrupted?: boolean;
};

/** Append a transcript delta, creating the turn if this is its first. */
export function applyLiveDelta(
  turns: ProvisionalTurn[],
  externalId: string,
  role: "user" | "assistant",
  delta: string
): ProvisionalTurn[] {
  if (!delta) return turns;
  const idx = turns.findIndex((t) => t.externalId === externalId);
  if (idx === -1) return [...turns, { externalId, role, content: delta, provisional: true }];
  const next = [...turns];
  next[idx] = { ...next[idx], content: next[idx].content + delta, provisional: true };
  return next;
}

/** Replace a turn outright — a `completed` event carries the authoritative
 * transcript, which wins over accumulated deltas. */
export function applyLiveSet(
  turns: ProvisionalTurn[],
  turn: ProvisionalTurn
): ProvisionalTurn[] {
  const idx = turns.findIndex((t) => t.externalId === turn.externalId);
  if (idx === -1) return [...turns, turn];
  const next = [...turns];
  next[idx] = { ...next[idx], ...turn };
  return next;
}
