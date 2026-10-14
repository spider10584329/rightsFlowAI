/**
 * Pure track-list operations for the release editor. The array order within
 * a disc is the source of truth; track numbers are always renumbered
 * 1..n per disc so positions stay unique (backend `_unique_positions`).
 */

export interface TrackRow {
  key: string;
  recording_id: string;
  title: string;
  version_title: string | null;
  artist: string | null;
  isrc: string | null;
  duration_seconds: number | null;
  disc_number: number;
  track_number: number;
}

export const MAX_DISC = 99;
export const MAX_TRACK = 999;

/** Sorts by disc (stable within a disc) and renumbers tracks per disc. */
export function normalizeTracks(rows: readonly TrackRow[]): TrackRow[] {
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.disc_number - b.row.disc_number || a.index - b.index)
    .map(({ row }) => row);
  const counters = new Map<number, number>();
  return ordered.map((row) => {
    const next = (counters.get(row.disc_number) ?? 0) + 1;
    counters.set(row.disc_number, next);
    return row.track_number === next ? row : { ...row, track_number: next };
  });
}

/** Builds rows from the backend track list (already ordered by position). */
export function tracksFromRelease(
  tracks: readonly {
    id: string;
    recording_id: string;
    recording_title: string | null;
    version_title: string | null;
    artist: string | null;
    isrc: string | null;
    duration_seconds: number | null;
    disc_number: number;
    track_number: number;
  }[],
): TrackRow[] {
  const sorted = [...tracks].sort((a, b) => a.disc_number - b.disc_number || a.track_number - b.track_number);
  return sorted.map((track) => ({
    key: track.id,
    recording_id: track.recording_id,
    title: track.recording_title ?? "Untitled recording",
    version_title: track.version_title,
    artist: track.artist,
    isrc: track.isrc,
    duration_seconds: track.duration_seconds,
    disc_number: track.disc_number,
    track_number: track.track_number,
  }));
}

export function lastDisc(rows: readonly TrackRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.disc_number), 1);
}

/** Appends a recording at the end of `disc` (default: the last disc). */
export function addTrack(rows: readonly TrackRow[], track: Omit<TrackRow, "disc_number" | "track_number">, disc = lastDisc(rows)): TrackRow[] {
  return normalizeTracks([...rows, { ...track, disc_number: clampDisc(disc), track_number: 0 }]);
}

export function removeTrack(rows: readonly TrackRow[], key: string): TrackRow[] {
  return normalizeTracks(rows.filter((row) => row.key !== key));
}

/**
 * Moves a track one position up (-1) or down (+1). At a disc boundary it
 * moves to the end of the previous disc / start of the next disc.
 */
export function moveTrack(rows: readonly TrackRow[], key: string, direction: -1 | 1): TrackRow[] {
  const list = normalizeTracks(rows);
  const index = list.findIndex((row) => row.key === key);
  if (index < 0) return list;
  const current = list[index];
  const neighbourIndex = index + direction;
  const neighbour = list[neighbourIndex];
  if (neighbour && neighbour.disc_number === current.disc_number) {
    const next = [...list];
    next[index] = neighbour;
    next[neighbourIndex] = current;
    return normalizeTracks(next);
  }
  // Disc boundary: hop to the adjacent disc if it exists.
  if (direction === -1 && current.disc_number > 1) {
    const disc = current.disc_number - 1;
    const without = list.filter((row) => row.key !== key);
    const lastIndexOfDisc = without.reduce((at, row, i) => (row.disc_number <= disc ? i : at), -1);
    const next = [...without];
    next.splice(lastIndexOfDisc + 1, 0, { ...current, disc_number: disc });
    return normalizeTracks(next);
  }
  if (direction === 1 && neighbour) {
    const disc = neighbour.disc_number;
    const without = list.filter((row) => row.key !== key);
    const firstIndexOfDisc = without.findIndex((row) => row.disc_number === disc);
    const next = [...without];
    next.splice(firstIndexOfDisc, 0, { ...current, disc_number: disc });
    return normalizeTracks(next);
  }
  return list;
}

function clampDisc(disc: number): number {
  if (!Number.isFinite(disc)) return 1;
  return Math.min(MAX_DISC, Math.max(1, Math.round(disc)));
}

/** Moves a track to the end of another disc. */
export function setTrackDisc(rows: readonly TrackRow[], key: string, disc: number): TrackRow[] {
  const target = clampDisc(disc);
  const row = rows.find((candidate) => candidate.key === key);
  if (!row || row.disc_number === target) return normalizeTracks(rows);
  return normalizeTracks([...rows.filter((candidate) => candidate.key !== key), { ...row, disc_number: target }]);
}

/** Problems the backend would reject (positions, limits) plus repeated recordings (warning). */
export function trackListProblems(rows: readonly TrackRow[]): { errors: string[]; repeatedRecordingKeys: Set<string> } {
  const errors: string[] = [];
  const positions = new Set<string>();
  const byRecording = new Map<string, string[]>();
  for (const row of rows) {
    const position = `${row.disc_number}-${row.track_number}`;
    if (positions.has(position)) errors.push(`Duplicate track position disc ${row.disc_number} track ${row.track_number}`);
    positions.add(position);
    if (row.track_number > MAX_TRACK) errors.push(`Track numbers must be at most ${MAX_TRACK}`);
    byRecording.set(row.recording_id, [...(byRecording.get(row.recording_id) ?? []), row.key]);
  }
  if (rows.length > 500) errors.push("A release can have at most 500 tracks");
  const repeatedRecordingKeys = new Set<string>();
  for (const keys of byRecording.values()) if (keys.length > 1) keys.forEach((key) => repeatedRecordingKeys.add(key));
  return { errors, repeatedRecordingKeys };
}

export function toTrackPayload(rows: readonly TrackRow[]): { recording_id: string; disc_number: number; track_number: number }[] {
  return normalizeTracks(rows).map((row) => ({ recording_id: row.recording_id, disc_number: row.disc_number, track_number: row.track_number }));
}

/** Total running time in seconds, or null when any track lacks a duration. */
export function totalDuration(rows: readonly TrackRow[]): number | null {
  let total = 0;
  for (const row of rows) {
    if (row.duration_seconds === null) return null;
    total += row.duration_seconds;
  }
  return total;
}
