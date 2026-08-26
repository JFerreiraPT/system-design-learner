import { useMemo } from "react";
import type {
  EstimationFieldSpec,
  EstimationProblemSpec,
  FieldCalibration
} from "@sdl/shared";
import {
  calibrateAll,
  evaluateDerivedFormulas,
  fromBaseUnit,
  isLegacyDerivedEstimationSpec,
  toBaseUnit
} from "@sdl/shared";
import type { EstimationDerived, WorkspaceEstimation } from "../lib/api";

type Props = {
  spec: EstimationProblemSpec;
  estimation: WorkspaceEstimation;
  setEstimation: React.Dispatch<React.SetStateAction<WorkspaceEstimation>>;
  legacyDerived: EstimationDerived | undefined;
  className?: string;
  variant?: "tab" | "dock";
};

/** Unit shown beside the label. Prefers the structured `displayUnit`; falls
 * back to the legacy free-text `unit` for specs generated before units carried
 * conversion information. */
function unitSuffix(field: EstimationFieldSpec): string {
  const unit = field.displayUnit ?? field.unit;
  return unit ? ` (${unit})` : "";
}

/** Converting base -> display can introduce float dust (1024 bytes / 1024 is
 * exact, 1500 / 1024 is not). Trim it so the input does not show 1.46484375. */
function roundForDisplay(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1e6) / 1e6;
}

const CALIBRATION_CLASS = {
  "off-by-one-order": "text-amber-600 dark:text-amber-400",
  "way-off": "text-rose-600 dark:text-rose-400"
} as const;

/**
 * Inline magnitude feedback.
 *
 * Shows direction and the band's rationale, never the band's numbers — the
 * point is to make the candidate re-derive the estimate, not to hand them the
 * answer. Renders nothing until they have entered something, and nothing at
 * all for fields with no generated band.
 */
function CalibrationNote({ calibration }: { calibration?: FieldCalibration }) {
  if (!calibration || calibration.verdict === "ok" || calibration.verdict === "unknown") {
    return null;
  }
  const headline =
    calibration.verdict === "way-off"
      ? "Several orders of magnitude "
      : "An order of magnitude ";
  const direction = calibration.direction === "low" ? "too low" : "too high";
  return (
    <p className={`mt-1 text-[11px] leading-snug ${CALIBRATION_CLASS[calibration.verdict]}`}>
      {headline}
      {direction}
      {calibration.rationale ? ` — ${calibration.rationale}` : "."}
    </p>
  );
}

/** Compact rendering across the huge dynamic range these values span. */
function formatDerived(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 0.01 || magnitude >= 1e9)) {
    return value.toExponential(2);
  }
  if (magnitude >= 100) return Math.round(value).toLocaleString();
  return Number(value.toPrecision(3)).toString();
}

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

  // Deterministic and local: no network call, no debounce needed, and it
  // never gates input — an out-of-band value is feedback, not an error.
  const calibration = useMemo(() => calibrateAll(spec, estimation), [spec, estimation]);
  const derived = useMemo(
    () => evaluateDerivedFormulas(spec, estimation),
    [spec, estimation]
  );

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
              {unitSuffix(field)}
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
                    if (typeof v === "number" && !Number.isNaN(v)) {
                      return roundForDisplay(fromBaseUnit(field, v));
                    }
                    return "";
                  })()
                }
                onChange={(e) =>
                  setEstimation((s) => ({
                    ...s,
                    [field.key]:
                      e.target.value === ""
                        ? undefined
                        : toBaseUnit(field, Number(e.target.value))
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
            <CalibrationNote calibration={calibration.perField[field.key]} />
          </label>
        ))}
      </div>
      {derived.length > 0 ? (
        <div className="surface-inset p-3 text-xs text-fg-muted">
          <p className="mb-1 font-medium text-fg">Derived</p>
          <ul className="space-y-1">
            {derived.map((d) => (
              <li key={d.id} className="flex justify-between gap-2">
                <span>{d.label}</span>
                <span className="tabular-nums text-fg">
                  {d.value === undefined ? "—" : formatDerived(d.value)}
                  {d.value !== undefined && d.displayUnit ? ` ${d.displayUnit}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {derived.some((d) => d.value === undefined) ? (
            <p className="mt-1.5 text-[11px] text-fg-faint">
              Fill the remaining number fields to complete these.
            </p>
          ) : null}
        </div>
      ) : null}
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
