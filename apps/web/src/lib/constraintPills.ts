import type { Importance, LiveConstraint } from "./api";

/** What to render alongside a live constraint. `null` = no pill at all. */
export type ConstraintPill = {
  importance: Importance;
  /** True when this constraint is known to have come from a criterion the
   * candidate surfaced — the wording changes to credit the discovery. */
  discovered: boolean;
};

/**
 * Decide whether a live constraint gets an importance / discovery pill.
 *
 * Regenerating the rubric (after a mid-interview level change) replaces
 * `criteria_json` wholesale, so constraints created from earlier discoveries
 * keep a `discoveredFromCriterionId` pointing at a criterion that no longer
 * exists. Claiming "discovered core expectation" for a criterion that is gone
 * would be a lie about the candidate's progress, so a dangling reference drops
 * the pill entirely rather than rendering it — and never throws.
 *
 * When the criteria set is not known yet (progress still loading) we show the
 * importance without the discovery framing: we cannot verify the link, so we
 * do not assert it.
 */
export function resolveConstraintPill(
  constraint: Pick<LiveConstraint, "importance" | "discoveredFromCriterionId">,
  knownCriterionIds?: ReadonlySet<string>
): ConstraintPill | null {
  const { importance, discoveredFromCriterionId } = constraint;
  if (!importance) return null;
  if (!discoveredFromCriterionId) return { importance, discovered: false };
  if (!knownCriterionIds) return { importance, discovered: false };
  if (!knownCriterionIds.has(discoveredFromCriterionId)) return null;
  return { importance, discovered: true };
}
