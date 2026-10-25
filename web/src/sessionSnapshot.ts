import type { Frame, Output, Segment, SessionData } from './types.ts';

/** Events received while the HTTP snapshot is in flight. Metadata changes trigger a fresh snapshot instead. */
export interface SnapshotChanges { segments: Segment[]; frames: Frame[]; outputs: Output[] }
export const emptySnapshotChanges = (): SnapshotChanges => ({ segments: [], frames: [], outputs: [] });

function outputProgress(o: Output): number { return o.status === 'pending' ? 0 : o.status === 'streaming' ? 1 : 2; }

/** An event queued before the server took its snapshot must not turn a completed answer back into a spinner. */
function newerOutput(current: Output | undefined, event: Output): Output {
  if (!current) return event;
  const before = outputProgress(current), after = outputProgress(event);
  if (before > after) return current;
  if (before === 2 && after === 2 && (current.completed_at ?? 0) >= (event.completed_at ?? 0)) return current;
  // Speaker staleness can be present in a newer snapshot of this same output.
  return current.stale_reason && !event.stale_reason ? { ...event, stale_reason: current.stale_reason } : event;
}

export function mergeSnapshotChanges(snapshot: SessionData, changes: SnapshotChanges): SessionData {
  let { segments, frames, outputs } = snapshot;
  if (changes.segments.length) {
    const byId = new Map(segments.map((s) => [s.id, s]));
    for (const s of changes.segments) if (s.session_id === snapshot.session.id && !byId.has(s.id)) byId.set(s.id, s);
    segments = [...byId.values()].sort((a, b) => a.t_start - b.t_start || a.id - b.id);
  }
  if (changes.frames.length) {
    const byId = new Map(frames.map((f) => [f.id, f]));
    for (const f of changes.frames) if (f.session_id === snapshot.session.id && !byId.has(f.id)) byId.set(f.id, f);
    frames = [...byId.values()].sort((a, b) => a.t - b.t || a.id - b.id);
  }
  if (changes.outputs.length) {
    const byId = new Map(outputs.map((o) => [o.id, o]));
    for (const o of changes.outputs) if (o.session_id === snapshot.session.id) byId.set(o.id, newerOutput(byId.get(o.id), o));
    outputs = [...byId.values()];
  }
  return { ...snapshot, segments, frames, outputs };
}

/** Streaming text is not in the HTTP snapshot. Keep it until that output reaches a terminal state. */
export function snapshotDeltas(data: SessionData, deltas: Record<string, string>): Record<string, string> {
  const active = new Set(data.outputs.filter((o) => o.status === 'pending' || o.status === 'streaming').map((o) => o.id));
  return Object.fromEntries(Object.entries(deltas).filter(([id]) => active.has(id)));
}
