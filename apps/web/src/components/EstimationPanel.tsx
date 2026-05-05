import type { EstimationProblemSpec } from "@sdl/shared";
import { isLegacyDerivedEstimationSpec } from "@sdl/shared";
import type { EstimationDerived, WorkspaceEstimation } from "../lib/api";

type Props = {
  spec: EstimationProblemSpec;
  estimation: WorkspaceEstimation;
  setEstimation: React.Dispatch<React.SetStateAction<WorkspaceEstimation>>;
  legacyDerived: EstimationDerived | undefined;
  className?: string;
  variant?: "tab" | "dock";
};

function pickNum(e: WorkspaceEstimation, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = e[k];
    if (typeof v === "number" && !Number.isNaN(v)) return v;
  }
  return undefined;
}

export function EstimationPanel({
  spec,
  estimation,
  setEstimation,
  legacyDerived,
  className = "",
  variant = "tab"
}: Props) {
  const showLegacyNumeric =
    isLegacyDerivedEstimationSpec(spec) &&
    legacyDerived &&
    Object.values(legacyDerived).some((v) => v != null);

  const pad = variant === "dock" ? "space-y-2" : "space-y-3";
  return (
    <div className={`h-full ${pad} overflow-auto pr-1 text-sm ${className}`}>
      {variant === "dock" ? (
        <p className="text-[11px] leading-snug text-fg-faint">
          Back-of-envelope checklist — included when you validate and in workspace context for chat.
        </p>
      ) : (
        <p className="text-fg-muted">
          Problem-specific back-of-envelope checklist. Values are sent with validation and to the
          interviewer/tutor.
        </p>
      )}
      {spec.intro ? <p className="text-xs text-fg-muted">{spec.intro}</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {spec.fields.map((field) => (
          <label key={field.key} className="block sm:col-span-2 sm:[&:not(:has(textarea))]:col-span-1">
            <span className="text-[10px] uppercase tracking-wider text-fg-faint">
              {field.label}
              {field.unit ? ` (${field.unit})` : ""}
            </span>
            {field.hint ? <p className="mt-0.5 text-[11px] text-fg-faint">{field.hint}</p> : null}
            {field.type === "number" ? (
              <input
                type="number"
                className="field mt-1"
                placeholder={field.placeholder}
                value={
                  (() => {
                    const v = estimation[field.key];
                    if (v === undefined || v === "") return "";
                    if (typeof v === "number" && !Number.isNaN(v)) return v;
                    return "";
                  })()
                }
                onChange={(e) =>
                  setEstimation((s) => ({
                    ...s,
                    [field.key]:
                      e.target.value === "" ? undefined : Number(e.target.value)
                  }))
                }
              />
            ) : (
              <textarea
                className="field mt-1 min-h-[56px]"
                placeholder={field.placeholder}
                value={(estimation[field.key] as string | undefined) ?? ""}
                onChange={(e) =>
                  setEstimation((s) => ({
                    ...s,
                    [field.key]: e.target.value || undefined
                  }))
                }
              />
            )}
          </label>
        ))}
      </div>
      {showLegacyNumeric ? (
        <div className="surface-inset p-3 text-xs text-fg-muted">
          <p className="mb-1 font-medium text-fg">Derived (approximate)</p>
          <ul className="space-y-1">
            <li>RPS avg: {legacyDerived?.rpsAvg != null ? legacyDerived.rpsAvg.toFixed(2) : "—"}</li>
            <li>RPS peak: {legacyDerived?.rpsPeak != null ? legacyDerived.rpsPeak.toFixed(2) : "—"}</li>
            <li>
              RPS read / write:{" "}
              {legacyDerived?.rpsRead != null && legacyDerived?.rpsWrite != null
                ? `${legacyDerived.rpsRead.toFixed(2)} / ${legacyDerived.rpsWrite.toFixed(2)}`
                : "—"}
            </li>
            <li>
              Storage (bytes, crude):{" "}
              {legacyDerived?.storageBytes != null ? legacyDerived.storageBytes.toExponential(2) : "—"}
            </li>
            <li>
              Bandwidth (bits/s, crude):{" "}
              {legacyDerived?.bandwidthBps != null ? legacyDerived.bandwidthBps.toExponential(2) : "—"}
            </li>
          </ul>
        </div>
      ) : spec.derivedHints && spec.derivedHints.length > 0 ? (
        <div className="surface-inset p-3 text-xs text-fg-muted">
          <p className="mb-1 font-medium text-fg">Sanity checks</p>
          <ul className="list-inside list-disc space-y-1">
            {spec.derivedHints.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Legacy template only: RPS / storage from DAU-style inputs (supports migrated keys). */
export function computeLegacyDerivedEstimation(e: WorkspaceEstimation): EstimationDerived {
  const dau = pickNum(e, "dau");
  const spu = pickNum(e, "sessions_per_user_per_day", "sessionsPerUserPerDay");
  const peak = pickNum(e, "peak_ratio", "peakRatio") ?? 1;
  const payload = pickNum(e, "payload_bytes", "payloadBytes");
  const retention = pickNum(e, "retention_days", "retentionDays");
  const rw = pickNum(e, "read_write_ratio", "readWriteRatio");

  let rpsAvg: number | undefined;
  if (dau != null && spu != null) {
    rpsAvg = (dau * spu) / 86400;
  }
  const rpsPeak = rpsAvg != null ? rpsAvg * peak : undefined;

  let rpsRead: number | undefined;
  let rpsWrite: number | undefined;
  if (rpsPeak != null && rw != null && rw >= 0) {
    const readPart = rw / (1 + rw);
    rpsRead = rpsPeak * readPart;
    rpsWrite = rpsPeak * (1 - readPart);
  }

  let storageBytes: number | undefined;
  if (dau != null && spu != null && payload != null && retention != null) {
    storageBytes = dau * spu * payload * retention;
  }

  let bandwidthBps: number | undefined;
  if (rpsPeak != null && payload != null) {
    bandwidthBps = rpsPeak * payload * 8;
  }

  return { rpsAvg, rpsPeak, rpsRead, rpsWrite, storageBytes, bandwidthBps };
}
