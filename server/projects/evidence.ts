/**
 * Agent-readable meeting evidence (used by the MCP server and the app's own API).
 * Every item names its project, meeting, source kind and source id; transcript text is the original ASR
 * output; AI-generated content is labelled as generated. Reads need an explicit project or meeting.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { searchTerms, speakerFields, type ProjectRow, type SessionRow, type Store } from '../db.ts';
import { DATA_DIR, FRAMES_DIR } from '../paths.ts';
import { fmtT, parseT } from '../util.ts';
import { handoffForAgent, SOURCE_NOTICE, type LinkFn } from './handoff-model.ts';
import { sessionTypeName } from '../../shared/session-types.ts';

export class EvidenceError extends Error {
  code: 'not_found' | 'out_of_scope' | 'bad_request' | 'unavailable';
  constructor(code: EvidenceError['code'], message: string) { super(message); this.code = code; }
}

/** Where the running app serves its UI (written by the server at startup), for "open in Chumi" links. */
export const SERVER_INFO = join(DATA_DIR, 'server.json');
export function chumiLink(): LinkFn {
  let base: string | null = null;
  try { base = (JSON.parse(readFileSync(SERVER_INFO, 'utf8')) as { url?: string }).url ?? null; } catch { /* app not started yet */ }
  return (sessionId, o = {}) => {
    if (!base) return null;
    const q = new URLSearchParams({ session: sessionId });
    if (o.t != null) q.set('t', String(Math.round(o.t)));
    if (o.t2 != null && o.t2 !== o.t) q.set('t2', String(Math.round(o.t2)));
    if (o.frame != null) q.set('frame', String(o.frame));
    return `${base}/?${q}`;
  };
}

const MAX_LIMIT = 50;
const lim = (n: unknown, def: number) => Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : def));
const cursorOf = (c: unknown) => { const n = Number(c); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
/** Accepts milliseconds or "m:ss" / "h:mm:ss". */
export function toMs(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  return parseT(s);
}

/** Resolve existing ancestors too, so a new subfolder still matches a symlinked workspace. */
function workspacePath(input: string): string {
  let path = resolve(input);
  const tail: string[] = [];
  for (;;) {
    try { path = join(realpathSync.native(path), ...tail); break; } catch { /* try the parent */ }
    const parent = dirname(path);
    if (parent === path) { path = resolve(input); break; }
    tail.unshift(basename(path)); path = parent;
  }
  // realpath recovers on-disk case without conflating distinct folders on case-sensitive volumes.
  return process.platform === 'win32' ? path.replace(/^[A-Z]:/, (drive) => drive.toLowerCase()) : path;
}

export function workspaceExists(p: ProjectRow): boolean {
  try { return statSync(p.workspace).isDirectory(); } catch { return false; }
}

export class Evidence {
  private store: Store;
  private link: LinkFn;
  constructor(store: Store, link: LinkFn = chumiLink()) { this.store = store; this.link = link; }

  private projectRef(id: string | null) {
    const p = id ? this.store.getProject(id) : null;
    return p ? { id: p.id, name: p.name, workspace: p.workspace } : null;
  }
  private meetingRef(s: SessionRow) {
    return {
      meeting_id: s.id, title: s.title, type: s.type, type_name: sessionTypeName(this.store.getSettings().sessionTypes, s.type), date: new Date(s.started_at ?? s.created_at).toISOString(),
      state: s.status, revision: s.revision, duration: fmtT(s.duration_ms), project: this.projectRef(s.project_id), open_in_chumi: this.link(s.id),
    };
  }
  /** A meeting the caller named explicitly; if a project scope is given it must match. */
  private meeting(meetingId: string, projectId?: string | null): SessionRow {
    const s = meetingId ? this.store.getSession(meetingId) : undefined;
    if (!s) throw new EvidenceError('not_found', `Meeting ${meetingId} is not available (it may have been deleted).`);
    if (projectId && s.project_id !== projectId) throw new EvidenceError('out_of_scope', `Meeting ${meetingId} does not belong to project ${projectId}${s.project_id ? '' : ' (it is not assigned to any project)'}.`);
    return s;
  }

  listProjects(cwd?: string) {
    const projects = this.store.listProjects().map((p) => ({ project_id: p.id, name: p.name, workspace: p.workspace, workspace_exists: workspaceExists(p), meetings: p.meeting_count }));
    const match = cwd ? this.projectForPath(cwd) : null;
    return { projects, ...(cwd ? { project_for_cwd: match ? match.id : null } : {}), notice: 'Pass project_id to chumi_search_meetings. A meeting belongs to a project only if the user assigned it.' };
  }

  /** The project whose workspace contains `path` (longest match). */
  projectForPath(path: string): ProjectRow | null {
    const target = workspacePath(path);
    let best: ProjectRow | null = null, bestLength = -1;
    for (const p of this.store.listProjects()) {
      const w = workspacePath(p.workspace);
      if ((target === w || target.startsWith(w.endsWith(sep) ? w : w + sep)) && w.length > bestLength) { best = p; bestLength = w.length; }
    }
    return best;
  }

  searchMeetings(o: { project_id: string; query?: string; limit?: number; cursor?: string | number }) {
    if (!o.project_id) throw new EvidenceError('bad_request', 'project_id is required. Call chumi_list_projects to find it.');
    const project = this.store.getProject(o.project_id);
    if (!project) throw new EvidenceError('not_found', `Project ${o.project_id} does not exist.`);
    const limit = lim(o.limit, 10), offset = cursorOf(o.cursor);
    const all = this.store.listSessions(o.query?.trim() || undefined, project.id);
    const page = all.slice(offset, offset + limit);
    const q = o.query?.trim();
    return {
      project: this.projectRef(project.id),
      query: q ?? null,
      total: all.length,
      meetings: page.map((s) => {
        const h = this.store.handoffForSession(s.id);
        const matches = q ? this.store.searchSegments(s.id, searchTerms(q), 3).map((g) => ({ source: 'transcript', segment_id: g.id, time: `${fmtT(g.t_start)}–${fmtT(g.t_end)}`, from_ms: g.t_start, to_ms: g.t_end, text: g.text, ...speakerFields(g) })) : [];
        return { ...this.meetingRef(s), transcript_lines: s.segment_count, handoff: h ? { handoff_id: h.id, status: h.status } : null, matches };
      }),
      next_cursor: offset + limit < all.length ? String(offset + limit) : null,
      notice: SOURCE_NOTICE,
    };
  }

  meetingOverview(o: { meeting_id: string; project_id?: string | null }) {
    const s = this.meeting(o.meeting_id, o.project_id);
    const summary = this.store.latestOutput(s.id, 'final_summary');
    const overview = this.store.latestOutput(s.id, 'overview');
    const ov = overview?.data_json ? JSON.parse(overview.data_json) as { current_topic?: string; topics?: Array<{ title: string; start: string }> } : null;
    const frames = this.store.frames(s.id);
    const h = this.store.handoffForSession(s.id);
    const first = this.store.firstSegment(s.id), last = this.store.lastSegment(s.id);
    return {
      meeting: this.meetingRef(s),
      transcript: { lines: this.store.maxSegmentId(s.id) ? (this.store.db.prepare('SELECT COUNT(*) AS n FROM segments WHERE session_id = ?').get(s.id) as { n: number }).n : 0, from: first ? fmtT(first.t_start) : null, to: last ? fmtT(last.t_end) : null },
      summary: summary ? { source: 'generated', generated_by: 'Chumi (AI)', output_id: summary.id, stale_reason: summary.stale_reason ?? null, created_at: new Date(summary.completed_at ?? summary.created_at).toISOString(), content: (summary.content ?? '').slice(0, 12000) } : null,
      topics: ov?.topics?.length ? { source: 'generated', stale_reason: overview?.stale_reason ?? null, items: ov.topics.slice(0, 30) } : null,
      speakers: this.store.speakers(s.id), speaker_analysis: this.store.speakerAnalysis(s.id),
      frames: frames.slice(0, 40).map((f) => ({ source: 'frame', frame_id: f.id, time: fmtT(f.t), t: f.t, window: f.window_title })),
      frames_total: frames.length,
      handoff: h ? handoffForAgent(this.store, h, this.link) : null,
      notice: SOURCE_NOTICE,
    };
  }

  passages(o: { meeting_id: string; project_id?: string | null; from?: unknown; to?: unknown; segment_ids?: number[]; limit?: number; cursor?: string | number }) {
    const s = this.meeting(o.meeting_id, o.project_id);
    const limit = lim(o.limit, 40), offset = cursorOf(o.cursor);
    let rows: ReturnType<Store['segments']>;
    if (o.segment_ids?.length) {
      const ids = [...new Set(o.segment_ids.map(Number).filter(Number.isFinite))];
      rows = [];
      // Batch SQL parameters, not the evidence: every requested id remains pageable.
      for (let i = 0; i < ids.length; i += 500) rows.push(...this.store.segmentsByIds(s.id, ids.slice(i, i + 500)));
      rows.sort((a, b) => a.t_start - b.t_start || a.id - b.id);
    } else {
      const from = toMs(o.from), to = toMs(o.to);
      if (o.from != null && from == null) throw new EvidenceError('bad_request', `Could not read the time "${o.from}". Use m:ss or milliseconds.`);
      if (o.to != null && to == null) throw new EvidenceError('bad_request', `Could not read the time "${o.to}". Use m:ss or milliseconds.`);
      rows = this.store.segments(s.id, from ?? -Infinity, to ?? Infinity);
    }
    const page = rows.slice(offset, offset + limit);
    return {
      meeting: this.meetingRef(s),
      passages: page.map((g) => ({ source: 'transcript', segment_id: g.id, from_ms: g.t_start, to_ms: g.t_end, time: `${fmtT(g.t_start)}–${fmtT(g.t_end)}`, text: g.text, ...speakerFields(g), audio: g.source === 'system' ? 'computer audio' : g.source === 'mic' ? 'microphone' : g.source, open_in_chumi: this.link(s.id, { t: g.t_start, t2: g.t_end }) })),
      total: rows.length,
      next_cursor: offset + limit < rows.length ? String(offset + limit) : null,
      note: 'Original speech-recognition text may contain misheard words. Speaker labels are meeting-local estimates; names are user-supplied, not verified identities. Preserve mixed/unknown attribution; audio sources are not people.',
      notice: SOURCE_NOTICE,
    };
  }

  frame(o: { frame_id: number; project_id?: string | null; meeting_id?: string }) {
    const f = this.store.getFrame(Number(o.frame_id));
    if (!f) throw new EvidenceError('not_found', `Screen capture ${o.frame_id} is not available (it or its meeting may have been deleted).`);
    const s = this.meeting(f.session_id, o.project_id);
    if (o.meeting_id && o.meeting_id !== s.id) throw new EvidenceError('out_of_scope', `Screen capture ${o.frame_id} belongs to another meeting.`);
    const meta = { source: 'frame', frame_id: f.id, meeting_id: s.id, project: this.projectRef(s.project_id), time: fmtT(f.t), t: f.t, window: f.window_title, app: f.app, captured_at: new Date(f.created_at).toISOString(), open_in_chumi: this.link(s.id, { frame: f.id }) };
    const ok = resolve(f.path).startsWith(resolve(FRAMES_DIR)) && existsSync(f.path);
    if (!ok) return { ...meta, available: false, reason: 'The image file is missing (deleted from disk).', image: null };
    return { ...meta, available: true, image: { mime: 'image/jpeg', base64: readFileSync(f.path).toString('base64') } };
  }

  handoff(o: { handoff_id?: string; meeting_id?: string; project_id?: string | null }) {
    const h = o.handoff_id ? this.store.getHandoff(o.handoff_id) : o.meeting_id ? this.store.handoffForSession(o.meeting_id) : undefined;
    if (!h) throw new EvidenceError('not_found', o.handoff_id ? `Handoff ${o.handoff_id} is not available.` : 'This meeting has no handoff yet. The user can prepare one in Chumi.');
    const s = this.store.getSession(h.session_id);
    if (o.project_id && (h.project_id !== o.project_id || s?.project_id !== o.project_id)) throw new EvidenceError('out_of_scope', `Handoff ${h.id} is not for project ${o.project_id}.`);
    return handoffForAgent(this.store, h, this.link);
  }
}
