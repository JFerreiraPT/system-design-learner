/** Interview transcript formatting, shared by validation and the debrief.
 *
 * Both the validator and the end-of-interview debrief grade the same
 * conversation, so they must see it in exactly the same shape — two copies of
 * this formatting would silently drift and make the two artefacts disagree
 * about what was said.
 */

/** Hard cap keeps transcript-bearing prompts inside practical context limits. */
export const MAX_INTERVIEW_TRANSCRIPT_CHARS = 120_000;

export type TranscriptRow = { role: string; content: string };

/** Render chronological message rows as a labelled candidate ↔ interviewer
 * transcript. `system` rows (and anything else) are dropped: they are UI
 * scaffolding, not part of the conversation being graded. */
export function formatInterviewTranscript(rows: TranscriptRow[]): string {
  const parts: string[] = [];
  for (const m of rows) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const label = m.role === "user" ? "Candidate" : "Interviewer";
    parts.push(`[${label}]\n${m.content.trim()}`);
  }
  return parts.join("\n\n---\n\n");
}

/** Keep the tail of an over-long transcript, with an explicit marker so the
 * model knows context was dropped rather than inferring the interview began
 * mid-sentence. The tail is the right half to keep: later turns carry the
 * design the candidate actually committed to. */
export function truncateInterviewTranscript(text: string): string {
  const t = text.trim();
  if (t.length === 0) return "";
  if (t.length <= MAX_INTERVIEW_TRANSCRIPT_CHARS) return t;
  const omitted = t.length - MAX_INTERVIEW_TRANSCRIPT_CHARS;
  return (
    `[Earlier transcript truncated (~${omitted} characters omitted)]\n\n` +
    t.slice(-MAX_INTERVIEW_TRANSCRIPT_CHARS)
  );
}

/** Format + clip in one step, returning `null` when there is nothing to show.
 * Callers pass the result straight into a prompt, where `null` means "omit the
 * transcript block entirely". */
export function buildInterviewTranscript(rows: TranscriptRow[]): string | null {
  const clipped = truncateInterviewTranscript(formatInterviewTranscript(rows));
  return clipped.length > 0 ? clipped : null;
}
