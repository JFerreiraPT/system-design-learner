import type { WorkspaceEstimation } from "./api";

const CAMEL_TO_SNAKE: [string, string][] = [
  ["peakRatio", "peak_ratio"],
  ["sessionsPerUserPerDay", "sessions_per_user_per_day"],
  ["payloadBytes", "payload_bytes"],
  ["retentionDays", "retention_days"],
  ["readWriteRatio", "read_write_ratio"]
];

/**
 * Normalize older localStorage shapes (camelCase) to legacy snake_case keys.
 *
 * Note on units: stored estimation values are always in the field's BASE unit
 * (bytes / seconds / plain count). Values written before `displayMultiplier`
 * existed were entered against specs that had no multiplier, which means they
 * were already base — so a spec that later gains a multiplier via backfill
 * reinterprets them correctly with no migration. There is deliberately no
 * unit conversion here; converting would double-apply the multiplier.
 */
export function migrateEstimationFromStorage(raw: WorkspaceEstimation): WorkspaceEstimation {
  const out: WorkspaceEstimation = { ...raw };
  for (const [oldK, newK] of CAMEL_TO_SNAKE) {
    if (oldK in out && !(newK in out)) {
      out[newK] = out[oldK];
      delete out[oldK];
    }
  }
  return out;
}
