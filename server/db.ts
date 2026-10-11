import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './paths.ts';
import { DEFAULT_PROFILE, DEFAULT_SETTINGS, normalizeLanguage, type Profile, type Settings } from './settings.ts';
import { deepMerge, now } from './util.ts';

export interface SessionRow {
  id: string; title: string; type: string; status: 'recording' | 'paused' | 'ended' | 'interrupted';
  created_at: number; started_at: number | null; ended_at: number | null; last_activity_at: number | null;
  audio_source: string | null; duration_ms: number;
}
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

export interface FrameRow { id: number; session_id: string; t: number; path: string; width: number | null; height: number | null; kind: string; window_title: string | null; app: string | null; created_at: number }

export class Store {
  db: DatabaseSync;
  constructor(path = DB_PATH) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

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
  listSessions(q?: string): Array<SessionRow & { segment_count: number; snippet?: string }> {
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
      return rows;
    }
    return this.db.prepare('SELECT s.*, (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id) AS segment_count FROM sessions s ORDER BY s.created_at DESC').all() as unknown as Array<SessionRow & { segment_count: number }>;
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
}
