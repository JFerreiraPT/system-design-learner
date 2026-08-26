import {
  PROCESS_READINGS,
  SURFACED_OWN_LIMITATIONS_READING,
  type ProcessAssessment
} from "@sdl/shared";
import type { ValidationFeedback } from "../lib/api";

/**
 * How the candidate WORKED, read back in plain English.
 *
 * Deliberately framed as observations rather than points: this is a new,
 * uncalibrated signal and it moves no score. The enums are rendered through
 * fixed copy (`PROCESS_READINGS`) so the wording is ours, not the model's —
 * the model supplies the judgement and the evidence, never the phrasing.
 */
export function ProcessPanel({ feedback }: { feedback?: ValidationFeedback | null }) {
  const process = feedback?.processAssessment;
  if (!process) return null;

  const chips = readChips(process);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <span
            key={chip.text}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${TONE_CLASS[chip.tone]}`}
          >
            {chip.text}
          </span>
        ))}
      </div>

      <ul className="space-y-1.5">
        {process.observations.map((observation, index) => (
          <li key={`${observation.signal}-${index}`} className="text-[12px] leading-snug">
            <p className="text-fg">{observation.signal}</p>
            <p className="mt-0.5 text-[11px] text-fg-faint">{observation.evidence}</p>
          </li>
        ))}
      </ul>

      <p className="text-[10px] text-fg-faint">
        Reported only — these observations do not affect your score.
      </p>
    </div>
  );
}

type Tone = "good" | "mixed" | "poor" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  good: "border-emerald-400/40 bg-emerald-400/[0.07] text-emerald-700 dark:text-emerald-300",
  mixed: "border-amber-400/40 bg-amber-400/[0.07] text-amber-700 dark:text-amber-300",
  poor: "border-rose-400/40 bg-rose-400/[0.07] text-rose-700 dark:text-rose-300",
  neutral: "border-line bg-surface text-fg-muted"
};

function readChips(process: ProcessAssessment): Array<{ text: string; tone: Tone }> {
  return [
    {
      text: PROCESS_READINGS.clarifiedBeforeDesigning[process.clarifiedBeforeDesigning],
      tone:
        process.clarifiedBeforeDesigning === "yes"
          ? "good"
          : process.clarifiedBeforeDesigning === "partially"
            ? "mixed"
            : "poor"
    },
    {
      text: PROCESS_READINGS.decisiveness[process.decisiveness],
      tone:
        process.decisiveness === "decides_and_justifies"
          ? "good"
          : process.decisiveness === "lists_without_choosing"
            ? "mixed"
            : "poor"
    },
    {
      text: SURFACED_OWN_LIMITATIONS_READING[process.surfacedOwnLimitations ? "true" : "false"],
      tone: process.surfacedOwnLimitations ? "good" : "mixed"
    },
    {
      text: PROCESS_READINGS.adaptedWhenChallenged[process.adaptedWhenChallenged],
      // "never challenged" is a fact about the session, not about the
      // candidate — it must not read as a mark against them.
      tone:
        process.adaptedWhenChallenged === "yes"
          ? "good"
          : process.adaptedWhenChallenged === "not_tested"
            ? "neutral"
            : process.adaptedWhenChallenged === "partially"
              ? "mixed"
              : "poor"
    },
    {
      // `drove` is level-relative — being led is expected at Guided — so it is
      // never coloured as a failure here.
      text: PROCESS_READINGS.drove[process.drove],
      tone: process.drove === "candidate_led" ? "good" : "neutral"
    }
  ];
}
