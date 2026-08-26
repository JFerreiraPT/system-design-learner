import { getTrack, TRACK_LABELS } from "@sdl/shared";

/** Track pill. Renders nothing when the track is unspecified, which is the
 * correct state for every problem generated before the axis existed — an
 * "Unspecified" badge would be noise on most of the library. */
export function TrackBadge({
  track,
  className = ""
}: {
  track?: unknown;
  className?: string;
}) {
  const resolved = getTrack(track);
  if (!resolved) return null;
  return (
    <span
      className={`rounded-md border border-cyan-400/40 bg-cyan-400/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-cyan-700 dark:text-cyan-300 ${className}`}
      title={`Track: ${TRACK_LABELS[resolved]}`}
    >
      {TRACK_LABELS[resolved]}
    </span>
  );
}
