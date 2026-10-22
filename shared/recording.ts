/**
 * A session's audio recording plays as one file. Long gaps in session time (pauses, a resume the next day)
 * shrink to a short break, so each region maps a stretch of session time to its place in the file.
 */
export interface PlaybackRegion { packed_ms: number; start_ms: number; end_ms: number }
export interface PlaybackInfo { version: string; duration_ms: number; regions: PlaybackRegion[] }

/** Session time → position in the playback file; a time between regions plays from the next one. */
export function toPlayback(regions: PlaybackRegion[], t: number): number {
  for (const r of regions) {
    if (t < r.start_ms) return r.packed_ms;
    if (t <= r.end_ms) return r.packed_ms + t - r.start_ms;
  }
  const last = regions.at(-1);
  return last ? last.packed_ms + last.end_ms - last.start_ms : 0;
}

/** Position in the playback file → session time; the break after a region maps to that region's end. */
export function toSession(regions: PlaybackRegion[], p: number): number {
  let t = regions[0]?.start_ms ?? 0;
  for (const r of regions) {
    if (p < r.packed_ms) break;
    t = Math.min(r.end_ms, r.start_ms + p - r.packed_ms);
  }
  return t;
}
