import type { FlagObservation, InterviewerPlaybook } from "@sdl/shared";

/** What the model is allowed to send us. Deliberately loose — everything is
 * re-derived from the stored playbook before it is persisted. */
export type RawFlagObservation = {
  areaId?: unknown;
  kind?: unknown;
  index?: unknown;
  text?: unknown;
  fired?: unknown;
  evidence?: unknown;
};

/** Upper bound mirroring `ValidationFeedbackSchema.flagObservations`. */
const MAX_OBSERVATIONS = 60;

/**
 * Resolve model-reported flag observations against the interview's stored
 * playbook.
 *
 * The model addresses each flag by `(areaId, kind, index)`. Anything that does
 * not resolve is dropped, and `text` is always rewritten from the playbook —
 * so a hallucinated flag can never reach the candidate, and a real flag can
 * never be shown with invented wording.
 *
 * Duplicate addresses collapse to the first occurrence, which keeps the panel
 * from listing the same flag twice with contradictory verdicts.
 */
export function sanitizeFlagObservations(
  raw: unknown,
  playbook: InterviewerPlaybook | null | undefined
): FlagObservation[] | undefined {
  if (!playbook || !Array.isArray(raw) || raw.length === 0) return undefined;

  const byArea = new Map(playbook.areasToProbe.map((a) => [a.id, a] as const));
  const seen = new Set<string>();
  const out: FlagObservation[] = [];

  for (const entry of raw as RawFlagObservation[]) {
    if (!entry || typeof entry !== "object") continue;

    const areaId = typeof entry.areaId === "string" ? entry.areaId : null;
    const kind = entry.kind === "green" || entry.kind === "red" ? entry.kind : null;
    const index =
      typeof entry.index === "number" && Number.isInteger(entry.index) && entry.index >= 0
        ? entry.index
        : null;
    if (areaId === null || kind === null || index === null) continue;

    const area = byArea.get(areaId);
    if (!area) continue;

    const flags = kind === "green" ? area.greenFlags : area.redFlags;
    const text = flags[index];
    if (typeof text !== "string") continue;

    const address = `${areaId}:${kind}:${index}`;
    if (seen.has(address)) continue;
    seen.add(address);

    const fired = entry.fired === true;
    const evidence =
      fired && typeof entry.evidence === "string" && entry.evidence.trim().length > 0
        ? entry.evidence.trim().slice(0, 500)
        : undefined;

    out.push({ areaId, kind, index, text, fired, evidence });
    if (out.length >= MAX_OBSERVATIONS) break;
  }

  return out.length > 0 ? out : undefined;
}
