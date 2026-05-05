import type { WorkspaceEstimation } from "./api";

const CAMEL_TO_SNAKE: [string, string][] = [
  ["peakRatio", "peak_ratio"],
  ["sessionsPerUserPerDay", "sessions_per_user_per_day"],
  ["payloadBytes", "payload_bytes"],
  ["retentionDays", "retention_days"],
  ["readWriteRatio", "read_write_ratio"]
];

/** Normalize older localStorage shapes (camelCase) to legacy snake_case keys. */
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
