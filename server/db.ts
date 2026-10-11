import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './paths.ts';
import { DEFAULT_PROFILE, DEFAULT_SETTINGS, normalizeLanguage, type Profile, type Settings } from './settings.ts';
import { deepMerge, now } from './util.ts';

export interface SessionRow {
  id: string; title: string; type: string; status: 'recording' | 'paused' | 'ended' | 'interrupted';
  created_at: number; started_at: number | null; ended_at: number | null; last_activity_at: number | null;
  audio_source: string | null; duration_ms: number;
  /** Project this meeting belongs to (null = unassigned). Set only by the user, never inferred. */
  project_id: string | null; project_assigned_at: number | null;
  /** Content revision: bumped by new transcript, frames, finished AI outputs, resumes and reassignment. */
  revision: number;
}
export interface ProjectRow {
  id: string; name: string; workspace: string; repo_json: string | null;
  created_at: number; updated_at: number; archived_at: number | null;
}
export interface HandoffRow {
  id: string; session_id: string; project_id: string | null;
  status: 'generating' | 'draft' | 'confirmed' | 'error';
  source_revision: number | null; confirmed_revision: number | null; confirmed_at: number | null; confirmed_segment_max: number | null;
  delivered_at: number | null; delivered_via: string | null; output_id: string | null; error: string | null;
  created_at: number; updated_at: number;
}
export interface HandoffItemRow {
  id: string; handoff_id: string; project_id: string | null; kind: 'decision' | 'action' | 'question'; position: number;
  text: string; rationale: string | null; conditions_json: string | null; acceptance_json: string | null;
  /** agreed = explicitly committed in the meeting; suggested = raised but not agreed; chumi = proposed by Chumi; user = added by the user. */
  origin: 'agreed' | 'suggested' | 'chumi' | 'user'; owner: string | null; due: string | null;
  evidence_json: string; review: 'pending' | 'confirmed' | 'rejected'; edited: number; updated_at: number;
}
export interface AgentReadRow { id: number; at: number; client: string | null; tool: string; project_id: string | null; session_id: string | null; handoff_id: string | null; revision: number | null; token: string | null }
export interface SegmentRow {
  id: number; session_id: string; t_start: number; t_end: number; text: string;
  lang: string | null; source: string | null; run: number; created_at: number;
}
export interface TimelineRow { id: number; session_id: string; t: number; kind: string; wall: number; detail: string | null }
export interface OutputRow {
  id: string; session_id: string; kind: string; status: string; question: string | null; selection_json: string | null;
  scope: string | null; depth: string | null; covered_from: number | null; covered_to: number | null; content: string | null;
  data_json: string | null; error: string | null; provider: string | null; model: string | null; billing: string | null;
  auto_epoch: number | null; parent_id: string | null; created_at: number; completed_at: number | null;
}

const SCHEMA = `
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, last_activity_at INTEGER,
  audio_source TEXT, duration_ms INTEGER NOT NULL DEFAULT 0
);
-- Raw transcript: only final ASR text. Never edited by AI.
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  t_start INTEGER NOT NULL, t_end INTEGER NOT NULL, text TEXT NOT NULL,
  lang TEXT, source TEXT, run INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS seg_session_t ON segments(session_id, t_start);
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(text, content='segments', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS seg_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS seg_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
-- Recording lifecycle: start / pause / resume / stop / gap / interrupted / error
CREATE TABLE IF NOT EXISTS timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  t INTEGER NOT NULL, kind TEXT NOT NULL, wall INTEGER NOT NULL, detail TEXT
);
-- AI-generated content, kept separate from the raw transcript.
CREATE TABLE IF NOT EXISTS ai_outputs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, status TEXT NOT NULL,
  question TEXT, selection_json TEXT, scope TEXT, depth TEXT,
  covered_from INTEGER, covered_to INTEGER,
  content TEXT, data_json TEXT, error TEXT,
  provider TEXT, model TEXT, billing TEXT, auto_epoch INTEGER, parent_id TEXT,
  created_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS out_session ON ai_outputs(session_id, created_at);
-- Captured window images (slides / shared screen). Files live under <data>/frames/<session>/.
CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  t INTEGER NOT NULL, path TEXT NOT NULL, width INTEGER, height INTEGER,
  kind TEXT NOT NULL DEFAULT 'slide', window_title TEXT, app TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS frames_session_t ON frames(session_id, t);
CREATE TABLE IF NOT EXISTS explained_terms (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  term_key TEXT NOT NULL, term TEXT NOT NULL, output_id TEXT, t INTEGER, origin TEXT,
  PRIMARY KEY (session_id, term_key)
);
`;

/**
 * Explicit, versioned schema changes (PRAGMA user_version). Each runs once, in a transaction, and never
 * rewrites existing rows, so older installations keep every meeting, output and setting.
 */
const MIGRATIONS: string[] = [
  // 1 — projects, content revisions, reviewed handoffs, agent read log
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL, repo_json TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
  );
  ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
  ALTER TABLE sessions ADD COLUMN project_assigned_at INTEGER;
  ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id, created_at);
  CREATE TABLE IF NOT EXISTS session_project_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT, at INTEGER NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS rev_segment AFTER INSERT ON segments BEGIN
    UPDATE sessions SET revision = revision + 1 WHERE id = new.session_id;
  END;
  CREATE TRIGGER IF NOT EXISTS rev_frame AFTER INSERT ON frames BEGIN
    UPDATE sessions SET revision = revision + 1 WHERE id = new.session_id;
  END;
  CREATE TRIGGER IF NOT EXISTS rev_output_done AFTER UPDATE OF status ON ai_outputs
    WHEN new.status = 'done' AND old.status != 'done' AND new.kind IN ('final_summary', 'answer', 'explain', 'catchup', 'overview', 'auto_explain') BEGIN
    UPDATE sessions SET revision = revision + 1 WHERE id = new.session_id;
  END;
  CREATE TRIGGER IF NOT EXISTS rev_output_insert AFTER INSERT ON ai_outputs
    WHEN new.status = 'done' AND new.kind IN ('final_summary', 'answer', 'explain', 'catchup', 'overview', 'auto_explain') BEGIN
    UPDATE sessions SET revision = revision + 1 WHERE id = new.session_id;
  END;
  CREATE TRIGGER IF NOT EXISTS rev_timeline AFTER INSERT ON timeline WHEN new.kind IN ('resume', 'gap', 'interrupted') BEGIN
    UPDATE sessions SET revision = revision + 1 WHERE id = new.session_id;
  END;
  CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT, status TEXT NOT NULL,
    source_revision INTEGER, confirmed_revision INTEGER, confirmed_at INTEGER, confirmed_segment_max INTEGER,
    delivered_at INTEGER, delivered_via TEXT, output_id TEXT, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS handoffs_session ON handoffs(session_id);
  CREATE TABLE IF NOT EXISTS handoff_items (
    id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
    project_id TEXT, kind TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL, rationale TEXT, conditions_json TEXT, acceptance_json TEXT,
    origin TEXT NOT NULL, owner TEXT, due TEXT, evidence_json TEXT NOT NULL DEFAULT '[]',
    review TEXT NOT NULL DEFAULT 'pending', edited INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS handoff_items_handoff ON handoff_items(handoff_id, position);
  CREATE TABLE IF NOT EXISTS agent_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, client TEXT, tool TEXT NOT NULL,
    project_id TEXT, session_id TEXT, handoff_id TEXT, revision INTEGER, token TEXT
  );
  `,
];
export const SCHEMA_VERSION = MIGRATIONS.length;

export interface FrameRow { id: number; session_id: string; t: number; path: string; width: number | null; height: number | null; kind: string; window_title: string | null; app: string | null; created_at: number }

export class Store {
  db: DatabaseSync;
  constructor(path = DB_PATH) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Apply pending migrations. Safe when two processes (app server, MCP server) open the database at once. */
  private migrate(): void {
    const version = () => (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    while (version() < MIGRATIONS.length) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const v = version();
        if (v < MIGRATIONS.length) {
          this.db.exec(MIGRATIONS[v]);
          this.db.exec(`PRAGMA user_version = ${v + 1}`);
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }
  schemaVersion(): number { return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; }

  close(): void { this.db.close(); }

  // ---------- settings / profile ----------
  getKV<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try { return JSON.parse(row.value) as T; } catch { return fallback; }
  }
  setKV(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), now());
  }
  getSettings(): Settings { return deepMerge(DEFAULT_SETTINGS, this.getKV('settings', {})); }
  saveSettings(s: Settings): void { this.setKV('settings', s); }
  getProfile(): Profile {
    const p = { ...DEFAULT_PROFILE, ...this.getKV<Partial<Profile>>('profile', {}) };
    return { ...p, explanationLanguage: normalizeLanguage(p.explanationLanguage) };
  }
  saveProfile(p: Profile): void { this.setKV('profile', p); }

  // ---------- sessions ----------
  createSession(s: { id: string; title: string; type: string; audio_source: string }): SessionRow {
    const t = now();
    this.db.prepare('INSERT INTO sessions(id, title, type, status, created_at, started_at, last_activity_at, audio_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.title, s.type, 'recording', t, t, t, s.audio_source);
    return this.getSession(s.id)!;
  }
  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }
  updateSession(id: string, patch: Partial<SessionRow>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (!keys.length) return;
    const sql = `UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => (patch as Record<string, never>)[k]), id);
  }
  touchSession(id: string, durationMs?: number): void {
    if (durationMs != null) this.db.prepare('UPDATE sessions SET last_activity_at = ?, duration_ms = MAX(duration_ms, ?) WHERE id = ?').run(now(), Math.round(durationMs), id);
    else this.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(now(), id);
  }
  /** projectId: a project id, 'none' for unassigned meetings, or undefined for all. */
  listSessions(q?: string, projectId?: string): Array<SessionRow & { segment_count: number; snippet?: string }> {
    const inProject = (r: SessionRow) => projectId === undefined || (projectId === 'none' ? r.project_id == null : r.project_id === projectId);
    if (q && q.trim()) {
      const term = q.trim();
      // Trigram FTS needs >= 3 characters; fall back to LIKE for shorter queries (e.g. two Chinese characters).
      const segHits = term.length >= 3
        ? this.db.prepare(`SELECT s.session_id AS sid, snippet(segments_fts, 0, '«', '»', '…', 12) AS snip
            FROM segments_fts f JOIN segments s ON s.id = f.rowid WHERE segments_fts MATCH ? ORDER BY rank LIMIT 500`)
          .all(`"${term.replace(/"/g, '""')}"`) as Array<{ sid: string; snip: string }>
        : this.db.prepare('SELECT session_id AS sid, text AS snip FROM segments WHERE text LIKE ? LIMIT 500').all(`%${term}%`) as Array<{ sid: string; snip: string }>;
      const outHits = this.db.prepare('SELECT session_id AS sid, substr(content, 1, 160) AS snip FROM ai_outputs WHERE content LIKE ? LIMIT 200').all(`%${term}%`) as Array<{ sid: string; snip: string }>;
      const titleHits = this.db.prepare('SELECT id AS sid, title AS snip FROM sessions WHERE title LIKE ?').all(`%${term}%`) as Array<{ sid: string; snip: string }>;
      const snippets = new Map<string, string>();
      for (const h of [...titleHits, ...segHits, ...outHits]) if (!snippets.has(h.sid)) snippets.set(h.sid, h.snip);
      if (!snippets.size) return [];
      const ids = [...snippets.keys()];
      const rows = this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id) AS segment_count FROM sessions s WHERE s.id IN (${ids.map(() => '?').join(',')}) ORDER BY s.created_at DESC`)
        .all(...ids) as unknown as Array<SessionRow & { segment_count: number; snippet?: string }>;
      for (const r of rows) r.snippet = snippets.get(r.id);
      return rows.filter(inProject);
    }
    return (this.db.prepare('SELECT s.*, (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id) AS segment_count FROM sessions s ORDER BY s.created_at DESC').all() as unknown as Array<SessionRow & { segment_count: number }>).filter(inProject);
  }
  deleteSession(id: string): void { this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id); }
  openSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE status IN ('recording', 'paused')").all() as unknown as SessionRow[];
  }

  // ---------- transcript ----------
  addSegment(seg: Omit<SegmentRow, 'id' | 'created_at'>): SegmentRow {
    const r = this.db.prepare('INSERT INTO segments(session_id, t_start, t_end, text, lang, source, run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(seg.session_id, seg.t_start, seg.t_end, seg.text, seg.lang, seg.source, seg.run, now());
    return { ...seg, id: Number(r.lastInsertRowid), created_at: now() };
  }
  segments(sessionId: string, fromT = -Infinity, toT = Infinity): SegmentRow[] {
    return this.db.prepare('SELECT * FROM segments WHERE session_id = ? AND t_end >= ? AND t_start <= ? ORDER BY t_start, id')
      .all(sessionId, Number.isFinite(fromT) ? fromT : -1e15, Number.isFinite(toT) ? toT : 1e15) as unknown as SegmentRow[];
  }
  /** Segments that start after time t (used by the assistant's triggers instead of re-reading the whole session). */
  segmentsAfter(sessionId: string, t: number): SegmentRow[] {
    return this.db.prepare('SELECT * FROM segments WHERE session_id = ? AND t_start > ? ORDER BY t_start, id').all(sessionId, t) as unknown as SegmentRow[];
  }
  firstSegment(sessionId: string): SegmentRow | undefined {
    return this.db.prepare('SELECT * FROM segments WHERE session_id = ? ORDER BY t_start LIMIT 1').get(sessionId) as SegmentRow | undefined;
  }
  lastSegment(sessionId: string): SegmentRow | undefined {
    return this.db.prepare('SELECT * FROM segments WHERE session_id = ? ORDER BY t_end DESC LIMIT 1').get(sessionId) as SegmentRow | undefined;
  }
  /** Keyword retrieval over one session (trigram FTS, BM25 ranking). */
  searchSegments(sessionId: string, terms: string[], limit = 12): SegmentRow[] {
    const usable = terms.map((t) => t.trim()).filter((t) => t.length >= 3).slice(0, 12);
    if (!usable.length) return [];
    const match = usable.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    try {
      return this.db.prepare(`SELECT s.* FROM segments_fts f JOIN segments s ON s.id = f.rowid
        WHERE segments_fts MATCH ? AND s.session_id = ? ORDER BY bm25(segments_fts) LIMIT ?`).all(match, sessionId, limit) as unknown as SegmentRow[];
    } catch { return []; }
  }

  // ---------- timeline ----------
  addTimeline(sessionId: string, t: number, kind: string, detail?: unknown): TimelineRow {
    const d = detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail);
    const r = this.db.prepare('INSERT INTO timeline(session_id, t, kind, wall, detail) VALUES (?, ?, ?, ?, ?)').run(sessionId, Math.round(t), kind, now(), d);
    return { id: Number(r.lastInsertRowid), session_id: sessionId, t: Math.round(t), kind, wall: now(), detail: d };
  }
  timeline(sessionId: string): TimelineRow[] {
    return this.db.prepare('SELECT * FROM timeline WHERE session_id = ? ORDER BY t, id').all(sessionId) as unknown as TimelineRow[];
  }

  // ---------- AI outputs ----------
  insertOutput(o: Partial<OutputRow> & { id: string; session_id: string; kind: string; status: string }): OutputRow {
    const row: OutputRow = {
      question: null, selection_json: null, scope: null, depth: null, covered_from: null, covered_to: null, content: null,
      data_json: null, error: null, provider: null, model: null, billing: null, auto_epoch: null, parent_id: null,
      created_at: now(), completed_at: null, ...o,
    } as OutputRow;
    const cols = Object.keys(row);
    this.db.prepare(`INSERT INTO ai_outputs(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => (row as unknown as Record<string, never>)[c]));
    return row;
  }
  updateOutput(id: string, patch: Partial<OutputRow>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (!keys.length) return;
    this.db.prepare(`UPDATE ai_outputs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (patch as Record<string, never>)[k]), id);
  }
  getOutput(id: string): OutputRow | undefined {
    return this.db.prepare('SELECT * FROM ai_outputs WHERE id = ?').get(id) as OutputRow | undefined;
  }
  outputs(sessionId: string, kinds?: string[]): OutputRow[] {
    if (kinds?.length) {
      return this.db.prepare(`SELECT * FROM ai_outputs WHERE session_id = ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY created_at`).all(sessionId, ...kinds) as unknown as OutputRow[];
    }
    return this.db.prepare('SELECT * FROM ai_outputs WHERE session_id = ? ORDER BY created_at').all(sessionId) as unknown as OutputRow[];
  }
  latestOutput(sessionId: string, kind: string, status = 'done'): OutputRow | undefined {
    return this.db.prepare('SELECT * FROM ai_outputs WHERE session_id = ? AND kind = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(sessionId, kind, status) as OutputRow | undefined;
  }
  /** Mark outputs that were in flight when the server stopped, so they don't appear stuck. */
  failStaleOutputs(): void {
    this.db.prepare("UPDATE ai_outputs SET status = 'error', error = 'Interrupted: the app stopped before this finished.' WHERE status IN ('pending', 'streaming')").run();
  }

  // ---------- screen captures ----------
  addFrame(f: Omit<FrameRow, 'id' | 'created_at'>): FrameRow {
    const r = this.db.prepare('INSERT INTO frames(session_id, t, path, width, height, kind, window_title, app, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.session_id, Math.round(f.t), f.path, f.width, f.height, f.kind, f.window_title, f.app, now());
    return { ...f, t: Math.round(f.t), id: Number(r.lastInsertRowid), created_at: now() };
  }
  frames(sessionId: string, fromT = -1e15, toT = 1e15): FrameRow[] {
    return this.db.prepare('SELECT * FROM frames WHERE session_id = ? AND t >= ? AND t <= ? ORDER BY t, id').all(sessionId, fromT, toT) as unknown as FrameRow[];
  }
  getFrame(id: number): FrameRow | undefined {
    return this.db.prepare('SELECT * FROM frames WHERE id = ?').get(id) as FrameRow | undefined;
  }

  // ---------- explained-term memory (per session) ----------
  explainedTerms(sessionId: string): Array<{ term_key: string; term: string; origin: string | null }> {
    return this.db.prepare('SELECT term_key, term, origin FROM explained_terms WHERE session_id = ?').all(sessionId) as Array<{ term_key: string; term: string; origin: string | null }>;
  }
  addExplainedTerm(sessionId: string, key: string, term: string, outputId: string | null, t: number | null, origin: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO explained_terms(session_id, term_key, term, output_id, t, origin) VALUES (?, ?, ?, ?, ?, ?)').run(sessionId, key, term, outputId, t, origin);
    return Number(r.changes) > 0;
  }

  // ---------- projects ----------
  listProjects(includeArchived = false): Array<ProjectRow & { meeting_count: number }> {
    return this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS meeting_count FROM projects p
      ${includeArchived ? '' : 'WHERE p.archived_at IS NULL'} ORDER BY p.updated_at DESC`).all() as unknown as Array<ProjectRow & { meeting_count: number }>;
  }
  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }
  createProject(p: { id: string; name: string; workspace: string; repo_json?: string | null }): ProjectRow {
    const t = now();
    this.db.prepare('INSERT INTO projects(id, name, workspace, repo_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(p.id, p.name, p.workspace, p.repo_json ?? null, t, t);
    return this.getProject(p.id)!;
  }
  /** Renaming or moving keeps the id, so meetings and handoffs stay attached. */
  updateProject(id: string, patch: Partial<Pick<ProjectRow, 'name' | 'workspace' | 'repo_json' | 'archived_at'>>): void {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (patch as Record<string, never>)[k]), now(), id);
  }
  /** Assign (or unassign with null) a meeting. Bumps the revision so consumers see the change. */
  assignSession(sessionId: string, projectId: string | null): void {
    const t = now();
    this.db.prepare('UPDATE sessions SET project_id = ?, project_assigned_at = ?, revision = revision + 1 WHERE id = ?').run(projectId, projectId ? t : null, sessionId);
    this.db.prepare('INSERT INTO session_project_log(session_id, project_id, at) VALUES (?, ?, ?)').run(sessionId, projectId, t);
  }
  lastAssignmentAt(sessionId: string): number | null {
    const r = this.db.prepare('SELECT MAX(at) AS at FROM session_project_log WHERE session_id = ?').get(sessionId) as { at: number | null };
    return r.at ?? null;
  }

  // ---------- handoffs ----------
  getHandoff(id: string): HandoffRow | undefined {
    return this.db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as HandoffRow | undefined;
  }
  handoffForSession(sessionId: string): HandoffRow | undefined {
    return this.db.prepare('SELECT * FROM handoffs WHERE session_id = ?').get(sessionId) as HandoffRow | undefined;
  }
  createHandoff(h: { id: string; session_id: string; project_id: string | null; status: HandoffRow['status'] }): HandoffRow {
    const t = now();
    this.db.prepare('INSERT INTO handoffs(id, session_id, project_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(h.id, h.session_id, h.project_id, h.status, t, t);
    return this.getHandoff(h.id)!;
  }
  updateHandoff(id: string, patch: Partial<HandoffRow>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (!keys.length) return;
    this.db.prepare(`UPDATE handoffs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (patch as Record<string, never>)[k]), now(), id);
  }
  handoffItems(handoffId: string): HandoffItemRow[] {
    return this.db.prepare('SELECT * FROM handoff_items WHERE handoff_id = ? ORDER BY position, updated_at').all(handoffId) as unknown as HandoffItemRow[];
  }
  getHandoffItem(id: string): HandoffItemRow | undefined {
    return this.db.prepare('SELECT * FROM handoff_items WHERE id = ?').get(id) as HandoffItemRow | undefined;
  }
  insertHandoffItem(i: Omit<HandoffItemRow, 'updated_at'>): void {
    const row = { ...i, updated_at: now() };
    const cols = Object.keys(row);
    this.db.prepare(`INSERT INTO handoff_items(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => (row as unknown as Record<string, never>)[c]));
  }
  updateHandoffItem(id: string, patch: Partial<HandoffItemRow>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id' && k !== 'handoff_id');
    if (!keys.length) return;
    this.db.prepare(`UPDATE handoff_items SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (patch as Record<string, never>)[k]), now(), id);
  }
  deleteHandoffItems(ids: string[]): void {
    if (!ids.length) return;
    this.db.prepare(`DELETE FROM handoff_items WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  maxSegmentId(sessionId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM segments WHERE session_id = ?').get(sessionId) as { m: number }).m;
  }

  // ---------- agent reads (written by the MCP server; shown as connection status) ----------
  recordAgentRead(r: Omit<AgentReadRow, 'id' | 'at'>): void {
    this.db.prepare('INSERT INTO agent_reads(at, client, tool, project_id, session_id, handoff_id, revision, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now(), r.client, r.tool, r.project_id, r.session_id, r.handoff_id, r.revision, r.token);
    this.db.prepare('DELETE FROM agent_reads WHERE id <= (SELECT MAX(id) - 2000 FROM agent_reads)').run();
  }
  agentReads(opts: { client?: string; handoffId?: string; token?: string; limit?: number } = {}): AgentReadRow[] {
    const where: string[] = []; const args: Array<string | number> = [];
    if (opts.client) { where.push('client LIKE ?'); args.push(`%${opts.client}%`); }
    if (opts.handoffId) { where.push('handoff_id = ?'); args.push(opts.handoffId); }
    if (opts.token) { where.push('token = ?'); args.push(opts.token); }
    return this.db.prepare(`SELECT * FROM agent_reads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, opts.limit ?? 20) as unknown as AgentReadRow[];
  }
}
