import { validateSessionTypes } from '../shared/session-types.ts';
import { randomUUID } from 'node:crypto';
import type { Speaker, SpeakerAnalysis, SpeakerAnnotation, SpeakerCorrection, SpeakerTurn } from '../shared/speakers.ts';
import type { ActionProgress, ProjectAgenda } from '../shared/project-work.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from './paths.ts';
import { DEFAULT_PROFILE, DEFAULT_SETTINGS, LEGACY_DEFAULT_PROFILE, normalizeLanguage, type Profile, type Settings } from './settings.ts';
import { deepMerge, now } from './util.ts';
import { isLocalEngine } from './asr/engines.ts';

export interface SessionRow {
  id: string; title: string; type: string; status: 'recording' | 'paused' | 'ended' | 'interrupted';
  created_at: number; started_at: number | null; ended_at: number | null; last_activity_at: number | null;
  audio_source: string | null; duration_ms: number;
  /** Project this meeting belongs to (null = unassigned). Set only by the user, never inferred. */
  project_id: string | null; project_assigned_at: number | null;
  /** Content revision: bumped by new transcript, frames, finished AI outputs, resumes and reassignment. */
  revision: number;
  /** 1 = keep this meeting's audio on this computer (chosen when it starts; resuming continues the choice). */
  record_audio: number;
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
export interface SegmentRow extends SpeakerAnnotation {
  id: number; session_id: string; t_start: number; t_end: number; text: string;
  lang: string | null; source: string | null; run: number; created_at: number;
}
export interface TimelineRow { id: number; session_id: string; t: number; kind: string; wall: number; detail: string | null }
export interface OutputRow {
  id: string; session_id: string; kind: string; status: string; question: string | null; selection_json: string | null;
  scope: string | null; depth: string | null; covered_from: number | null; covered_to: number | null; content: string | null;
  data_json: string | null; error: string | null; provider: string | null; model: string | null; billing: string | null;
  auto_epoch: number | null; parent_id: string | null; created_at: number; completed_at: number | null;
  /** Existing generated text is retained, but no longer used as fresh context after a speaker correction. */
  stale_reason?: string | null;
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
  // 2 — meeting-local speaker annotations; the original transcript stays unchanged.
  `
  CREATE TABLE session_speakers (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source TEXT NOT NULL, label TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL,
    UNIQUE(session_id, label)
  );
  CREATE TABLE speaker_analyses (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL, generation TEXT, error TEXT, updated_at INTEGER
  );
  CREATE TABLE speaker_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source TEXT NOT NULL, speaker_id TEXT NOT NULL REFERENCES session_speakers(id) ON DELETE CASCADE,
    start_ms REAL NOT NULL, end_ms REAL NOT NULL
  );
  CREATE INDEX speaker_turns_session ON speaker_turns(session_id, source, start_ms);
  CREATE TABLE segment_speakers (
    segment_id INTEGER PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
    speaker_id TEXT REFERENCES session_speakers(id), state TEXT NOT NULL, origin TEXT NOT NULL,
    auto_speaker_id TEXT REFERENCES session_speakers(id), auto_state TEXT NOT NULL
  );
  ALTER TABLE ai_outputs ADD COLUMN stale_reason TEXT;
  `,
  // 3 — per-meeting audio recording
  `
  ALTER TABLE sessions ADD COLUMN record_audio INTEGER NOT NULL DEFAULT 0;
  `,
  // 4 — user-maintained action progress and project agendas, separate from handoff review.
  `
  CREATE TABLE action_progress (
    item_id TEXT PRIMARY KEY REFERENCES handoff_items(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, item_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'blocked', 'completed')),
    note TEXT NOT NULL DEFAULT '', results_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER, version INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO action_progress(item_id, project_id, item_text) SELECT id, project_id, text FROM handoff_items WHERE kind = 'action';
  CREATE TABLE project_agendas (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    text TEXT NOT NULL DEFAULT '', updated_at INTEGER, version INTEGER NOT NULL DEFAULT 0
  );
  CREATE TRIGGER work_item_created AFTER INSERT ON handoff_items WHEN new.kind = 'action' BEGIN
    INSERT INTO action_progress(item_id, project_id, item_text) VALUES (new.id, new.project_id, new.text);
  END;
  -- Invalidate old editors when the work's identity, review or project changes. Keep the old content
  -- scoped to its original project/text until the user explicitly saves progress for the new work.
  CREATE TRIGGER work_item_changed AFTER UPDATE OF review, kind, text, project_id ON handoff_items
    WHEN (old.kind = 'action' OR new.kind = 'action') AND
      (old.review IS NOT new.review OR old.kind IS NOT new.kind OR old.text IS NOT new.text OR old.project_id IS NOT new.project_id) BEGIN
    INSERT OR IGNORE INTO action_progress(item_id, project_id, item_text) VALUES (new.id, new.project_id, new.text);
    UPDATE action_progress SET version = version + 1 WHERE item_id = new.id;
  END;
  CREATE TRIGGER work_review_changed AFTER UPDATE OF status, project_id, confirmed_revision ON handoffs
    WHEN old.status IS NOT new.status OR old.project_id IS NOT new.project_id OR old.confirmed_revision IS NOT new.confirmed_revision BEGIN
    UPDATE action_progress SET version = version + 1 WHERE item_id IN (SELECT id FROM handoff_items WHERE handoff_id = new.id);
  END;
  CREATE TRIGGER work_project_changed AFTER UPDATE OF project_id ON sessions
    WHEN old.project_id IS NOT new.project_id BEGIN
    UPDATE action_progress SET version = version + 1 WHERE item_id IN
      (SELECT i.id FROM handoff_items i JOIN handoffs h ON h.id = i.handoff_id WHERE h.session_id = new.id);
  END;
  `,
];
export const SCHEMA_VERSION = MIGRATIONS.length;

export interface FrameRow { id: number; session_id: string; t: number; path: string; width: number | null; height: number | null; kind: string; window_title: string | null; app: string | null; created_at: number }

export interface SpeakerCoverage { source: string; start_ms: number; end_ms: number }
type StoredTurn = SpeakerCoverage & { speaker_id: string };
type SpeakerState = NonNullable<SpeakerAnnotation['speaker_state']>;
const SEGMENT_SELECT = `SELECT s.*, a.speaker_id, CASE WHEN a.speaker_id IS NOT NULL THEN COALESCE(p.name, 'Speaker ' || p.label) END AS speaker_label,
  a.state AS speaker_state, a.origin AS speaker_origin FROM segments s
  LEFT JOIN segment_speakers a ON a.segment_id = s.id LEFT JOIN session_speakers p ON p.id = a.speaker_id`;
/** Speaker fields for agents and exports; speaker_state is null when the line was never analysed. */
export const speakerFields = (s: SegmentRow) => ({ speaker_id: s.speaker_id ?? null, speaker_label: s.speaker_label ?? null, speaker_state: s.speaker_state ?? null, speaker_origin: s.speaker_origin ?? null });
const overlapMs = (a: { start_ms: number; end_ms: number }, b: { start_ms: number; end_ms: number }) => Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, '\\$&')}%`;
const likeSnippet = (column: string) => `substr(${column}, MAX(1, instr(lower(${column}), lower(?)) - 80), 160)`;
const ftsTerm = (term: string) => `"${term.replace(/"/g, '""')}"`;
const usesFts = (term: string) => [...term].length >= 3;
const hasCjk = (term: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term);
const cleanSearchTerm = (term: string) => term.replace(/\p{Cc}/gu, '')
  .replace(/^[\p{Ps}\p{Pe}\p{Pi}\p{Pf}"'`<>]+|[\p{Ps}\p{Pe}\p{Pi}\p{Pf}"'`<>.!?。！？…:：]+$/gu, '');
/** Normal keyword punctuation is optional; punctuation inside technical terms stays literal. */
export function searchTerms(query: string): string[] {
  return [...new Set(query.split(/[\s,;，、；]+/u).map(cleanSearchTerm).filter(Boolean))].slice(0, 12);
}
/** Union intervals before measuring, so overlapping worker turns cannot inflate confidence. */
function intervals(rows: Array<{ start_ms: number; end_ms: number }>): Array<{ start_ms: number; end_ms: number }> {
  const out: Array<{ start_ms: number; end_ms: number }> = [];
  for (const r of [...rows].sort((a, b) => a.start_ms - b.start_ms)) {
    const last = out.at(-1);
    if (last && r.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, r.end_ms);
    else out.push({ start_ms: r.start_ms, end_ms: r.end_ms });
  }
  return out;
}
type Span = { start_ms: number; end_ms: number };
/** Overlap of two already merged, sorted interval lists (a linear sweep). */
function mergedOverlap(a: Span[], b: Span[]): number {
  let total = 0, i = 0, j = 0;
  while (i < a.length && j < b.length) {
    total += overlapMs(a[i], b[j]);
    if (a[i].end_ms < b[j].end_ms) i++; else j++;
  }
  return total;
}
function intervalOverlap(a: Span[], b: Span[]): number { return mergedOverlap(intervals(a), intervals(b)); }
/** Turns of one source sorted by start, with the longest duration, for range lookups. */
function turnIndex(turns: StoredTurn[]): Map<string, { turns: StoredTurn[]; longest: number }> {
  const out = new Map<string, { turns: StoredTurn[]; longest: number }>();
  for (const t of turns) { const g = out.get(t.source) ?? { turns: [], longest: 0 }; g.turns.push(t); g.longest = Math.max(g.longest, t.end_ms - t.start_ms); out.set(t.source, g); }
  for (const g of out.values()) g.turns.sort((a, b) => a.start_ms - b.start_ms);
  return out;
}
function firstStartAtOrAfter(turns: StoredTurn[], ms: number): number {
  let lo = 0, hi = turns.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (turns[mid].start_ms < ms) lo = mid + 1; else hi = mid; }
  return lo;
}
function speakerLabel(n: number): string {
  let label = '';
  do { label = String.fromCharCode(65 + n % 26) + label; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return label;
}

export class Store {
  db: DatabaseSync;
  constructor(path = DB_PATH) {
    // A fresh install (setup, doctor, the MCP server) may open the database before the app ever created its folder.
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
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
  getSettings(): Settings {
    const settings = deepMerge(DEFAULT_SETTINGS, this.getKV('settings', {})) as Settings;
    // Until someone picks an engine, the local one follows this version's default for the platform.
    if (!settings.asr.engineSelected && isLocalEngine(settings.asr.engine)) settings.asr.engine = DEFAULT_SETTINGS.asr.engine;
    return settings;
  }
  saveSettings(s: Settings): Settings {
    const sessionTypes = validateSessionTypes(s.sessionTypes, this.getSettings().sessionTypes);
    const type = sessionTypes.some((o) => o.id === s.quickStart.type && !o.archived) ? s.quickStart.type : sessionTypes.find((o) => !o.archived)!.id;
    const asr = { ...s.asr };
    if (s.asr.engine !== this.getSettings().asr.engine) asr.engineSelected = true;
    const next = { ...s, asr, sessionTypes, quickStart: { ...s.quickStart, type } };
    this.setKV('settings', next);
    return next;
  }
  /**
   * Once, before the first profile is saved: an install that already has meetings keeps the built-in profile it has
   * been using; a fresh install starts empty, explaining in the system language until the user describes themselves.
   */
  ensureProfile(systemLanguage: 'en' | 'zh'): void {
    if (this.getKV<Partial<Profile> | null>('profile', null)) return;
    const used = (this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n > 0;
    this.saveProfile(used ? LEGACY_DEFAULT_PROFILE : { ...DEFAULT_PROFILE, explanationLanguage: systemLanguage === 'zh' ? 'Simplified Chinese' : 'English' });
  }
  getProfile(): Profile {
    const p = { ...DEFAULT_PROFILE, ...this.getKV<Partial<Profile>>('profile', {}) };
    return { ...p, explanationLanguage: normalizeLanguage(p.explanationLanguage) };
  }
  saveProfile(p: Profile): void { this.setKV('profile', p); }

  // ---------- sessions ----------
  createSession(s: { id: string; title: string; type: string; audio_source: string; record_audio?: boolean }): SessionRow {
    const t = now();
    this.db.prepare('INSERT INTO sessions(id, title, type, status, created_at, started_at, last_activity_at, audio_source, record_audio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.title, s.type, 'recording', t, t, t, s.audio_source, s.record_audio ? 1 : 0);
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
    const projectWhere = projectId === undefined ? '1' : projectId === 'none' ? 's.project_id IS NULL' : 's.project_id = ?';
    const projectArgs = projectId === undefined || projectId === 'none' ? [] : [projectId];
    if (q && q.trim()) {
      const terms = searchTerms(q);
      if (!terms.length) return [];
      let snippets: Map<string, string> | undefined;
      for (const term of terms) {
        const fts = usesFts(term), like = likePattern(term), match = ftsTerm(term);
        const joinFts = fts ? 'JOIN segments_fts f ON f.rowid = g.id' : '';
        // One transcript hit per meeting, scoped before grouping; repeated words cannot crowd out other meetings.
        const segmentIds = `SELECT MIN(g.id) FROM segments g ${joinFts} JOIN sessions s ON s.id = g.session_id
          WHERE ${fts ? 'segments_fts MATCH ?' : "g.text LIKE ? ESCAPE '\\'"} AND ${projectWhere} GROUP BY g.session_id`;
        const segHits = this.db.prepare(`SELECT g.session_id AS sid, ${fts ? "snippet(segments_fts, 0, '«', '»', '…', 12)" : likeSnippet('g.text')} AS snip
          FROM segments g ${joinFts} WHERE g.id IN (${segmentIds}) ${fts ? 'AND segments_fts MATCH ?' : ''}`)
          .all(...(fts ? [] : [term]), fts ? match : like, ...projectArgs, ...(fts ? [match] : [])) as Array<{ sid: string; snip: string }>;
        const outHits = this.db.prepare(`SELECT o.session_id AS sid, MIN(${likeSnippet('o.content')}) AS snip FROM ai_outputs o JOIN sessions s ON s.id = o.session_id
          WHERE o.status = 'done' AND o.kind IN ('final_summary', 'overview', 'answer', 'explain', 'catchup', 'auto_explain')
          AND o.content LIKE ? ESCAPE '\\' AND ${projectWhere} GROUP BY o.session_id`).all(term, like, ...projectArgs) as Array<{ sid: string; snip: string }>;
        const handoffHits = this.db.prepare(`SELECT h.session_id AS sid, MIN(${likeSnippet('i.text')}) AS snip
          FROM handoff_items i JOIN handoffs h ON h.id = i.handoff_id JOIN sessions s ON s.id = h.session_id
          WHERE i.review != 'rejected' AND i.text LIKE ? ESCAPE '\\' AND ${projectWhere} GROUP BY h.session_id`)
          .all(term, like, ...projectArgs) as Array<{ sid: string; snip: string }>;
        const titleHits = this.db.prepare(`SELECT s.id AS sid, s.title AS snip FROM sessions s WHERE s.title LIKE ? ESCAPE '\\' AND ${projectWhere}`)
          .all(like, ...projectArgs) as Array<{ sid: string; snip: string }>;
        const hits = new Map<string, string>();
        for (const h of [...titleHits, ...segHits, ...outHits, ...handoffHits]) if (!hits.has(h.sid)) hits.set(h.sid, h.snip);
        // All words must occur in the meeting, even if they are in different lines or kinds of content.
        if (!snippets) snippets = hits;
        else for (const sid of snippets.keys()) if (!hits.has(sid)) snippets.delete(sid);
        if (!snippets.size) return [];
      }
      const rows = this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id) AS segment_count FROM sessions s
        WHERE s.id IN (SELECT value FROM json_each(?)) ORDER BY COALESCE(s.started_at, s.created_at) DESC, s.id`)
        .all(JSON.stringify([...snippets!.keys()])) as unknown as Array<SessionRow & { segment_count: number; snippet?: string }>;
      for (const r of rows) r.snippet = snippets!.get(r.id);
      return rows;
    }
    return this.db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id) AS segment_count FROM sessions s WHERE ${projectWhere} ORDER BY COALESCE(s.started_at, s.created_at) DESC, s.id`)
      .all(...projectArgs) as unknown as Array<SessionRow & { segment_count: number }>;
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
    return this.db.prepare(`${SEGMENT_SELECT} WHERE s.session_id = ? AND s.t_end >= ? AND s.t_start <= ? ORDER BY s.t_start, s.id`)
      .all(sessionId, Number.isFinite(fromT) ? fromT : -1e15, Number.isFinite(toT) ? toT : 1e15) as unknown as SegmentRow[];
  }
  /** Segments that start after time t (used by the assistant's triggers instead of re-reading the whole session). */
  segmentsAfter(sessionId: string, t: number): SegmentRow[] {
    return this.db.prepare(`${SEGMENT_SELECT} WHERE s.session_id = ? AND s.t_start > ? ORDER BY s.t_start, s.id`).all(sessionId, t) as unknown as SegmentRow[];
  }
  firstSegment(sessionId: string): SegmentRow | undefined {
    return this.db.prepare(`${SEGMENT_SELECT} WHERE s.session_id = ? ORDER BY s.t_start, s.id LIMIT 1`).get(sessionId) as SegmentRow | undefined;
  }
  lastSegment(sessionId: string): SegmentRow | undefined {
    return this.db.prepare(`${SEGMENT_SELECT} WHERE s.session_id = ? ORDER BY s.t_end DESC, s.id DESC LIMIT 1`).get(sessionId) as SegmentRow | undefined;
  }
  /** Keyword retrieval over one session (trigram FTS, BM25 ranking). */
  searchSegments(sessionId: string, terms: string[], limit = 12): SegmentRow[] {
    const usable = [...new Set(terms.map((t) => cleanSearchTerm(t.trim())).filter((t) => usesFts(t) || hasCjk(t)))].slice(0, 12);
    if (!usable.length || limit <= 0) return [];
    const long = usable.filter(usesFts), short = usable.filter((t) => !usesFts(t));
    try {
      const ranked = long.length ? this.db.prepare(`${SEGMENT_SELECT} JOIN segments_fts f ON s.id = f.rowid
        WHERE segments_fts MATCH ? AND s.session_id = ? ORDER BY bm25(segments_fts), s.t_start, s.id LIMIT ?`)
        .all(long.map(ftsTerm).join(' OR '), sessionId, limit) as unknown as SegmentRow[] : [];
      // Short CJK words need LIKE; short Latin words would mostly retrieve unrelated lines.
      const brief = short.length ? this.db.prepare(`${SEGMENT_SELECT} WHERE s.session_id = ? AND (${short.map(() => "s.text LIKE ? ESCAPE '\\'").join(' OR ')})
        ORDER BY s.t_start, s.id LIMIT ?`).all(sessionId, ...short.map(likePattern), limit) as unknown as SegmentRow[] : [];
      return [...new Map([...ranked, ...brief].map((s) => [s.id, s])).values()].slice(0, limit);
    } catch { return []; }
  }

  segmentsByIds(sessionId: string, ids: number[]): SegmentRow[] {
    if (!ids.length) return [];
    return this.db.prepare(`${SEGMENT_SELECT} WHERE s.session_id = ? AND s.id IN (${ids.map(() => '?').join(',')}) ORDER BY s.t_start, s.id`)
      .all(sessionId, ...ids) as unknown as SegmentRow[];
  }

  // ---------- meeting-local speaker annotations ----------
  speakers(sessionId: string): Speaker[] {
    return this.db.prepare('SELECT id, session_id, source, label, name FROM session_speakers WHERE session_id = ? ORDER BY rowid').all(sessionId) as unknown as Speaker[];
  }
  speakerAnalysis(sessionId: string): SpeakerAnalysis {
    return this.db.prepare('SELECT status, generation, error, updated_at FROM speaker_analyses WHERE session_id = ?').get(sessionId) as unknown as SpeakerAnalysis
      ?? { status: 'not_run', generation: null, error: null, updated_at: null };
  }
  setSpeakerAnalysis(sessionId: string, analysis: SpeakerAnalysis): void {
    this.requireSpeakerSession(sessionId);
    if (!['not_run', 'queued', 'running', 'done', 'failed', 'cancelled'].includes(analysis.status)
      || analysis.generation != null && (typeof analysis.generation !== 'string' || !analysis.generation.trim())) throw new Error('Invalid speaker analysis');
    this.db.prepare(`INSERT INTO speaker_analyses(session_id, status, generation, error, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET status = excluded.status, generation = excluded.generation, error = excluded.error, updated_at = excluded.updated_at`)
      .run(sessionId, analysis.status, analysis.generation, analysis.error, analysis.updated_at ?? now());
  }
  private requireSpeakerSession(sessionId: string): SessionRow {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    return session;
  }
  private speakerTransaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private speakerChanged(sessionId: string, staleOutputs = true): void {
    this.db.prepare('UPDATE sessions SET revision = revision + 1 WHERE id = ?').run(sessionId);
    const session = this.getSession(sessionId)!;
    this.addTimeline(sessionId, session.duration_ms, 'speaker_labels_changed', { revision: session.revision });
    // Keep generated history visible, but never feed outdated names/assignments into a new AI request.
    if (staleOutputs) this.db.prepare("UPDATE ai_outputs SET stale_reason = 'speaker_labels_changed' WHERE session_id = ?").run(sessionId);
  }
  /**
   * One voice covering half the line, or (when the whole line was analysed) at least a second of it with no other
   * voice, is that speaker. Whisper lines often span pauses or music, which no speaker covers.
   */
  private speakerForSegment(segment: SegmentRow, index: Map<string, { turns: StoredTurn[]; longest: number }>, fullyAnalysed: boolean): { id: string | null; state: SpeakerState } {
    const range = { start_ms: segment.t_start, end_ms: segment.t_end }, duration = segment.t_end - segment.t_start;
    if (duration <= 0) return { id: null, state: 'unknown' };
    const group = index.get(segment.source ?? '');
    const bySpeaker = new Map<string, StoredTurn[]>();
    if (group) {
      const end = firstStartAtOrAfter(group.turns, range.end_ms);
      for (let i = firstStartAtOrAfter(group.turns, range.start_ms - group.longest); i < end; i++) {
        const t = group.turns[i];
        if (overlapMs(t, range) > 0) { const g = bySpeaker.get(t.speaker_id) ?? []; g.push(t); bySpeaker.set(t.speaker_id, g); }
      }
    }
    const significant = [...bySpeaker].map(([id, ts]) => ({ id, ms: intervalOverlap(ts, [range]) }))
      .filter((s) => s.ms >= Math.min(250, duration * 0.15)).sort((a, b) => b.ms - a.ms);
    if (significant.length > 1) return { id: null, state: 'mixed' };
    const top = significant[0];
    if (top && (top.ms >= duration * 0.5 || fullyAnalysed && top.ms >= 1000)) return { id: top.id, state: 'assigned' };
    return { id: null, state: 'unknown' };
  }
  /** Apply only the analysed time ranges. Worker cluster names never identify a person across takes. */
  /** Returns false when this result was superseded (cancelled or replaced) and nothing was written. */
  applySpeakerTurns(sessionId: string, generation: string, turns: SpeakerTurn[], coverage?: SpeakerCoverage[]): boolean {
    this.requireSpeakerSession(sessionId);
    const validRange = (r: SpeakerCoverage) => typeof r.source === 'string' && ['mic', 'system', 'file'].includes(r.source)
      && Number.isFinite(r.start_ms) && Number.isFinite(r.end_ms) && r.start_ms >= 0 && r.end_ms > r.start_ms;
    if (!generation || !Array.isArray(turns) || turns.some((t) => !validRange(t) || typeof t.speaker !== 'string' || !t.speaker.trim() || t.speaker.length > 200)
      || coverage && (!Array.isArray(coverage) || coverage.some((c) => !validRange(c)))) throw new Error('Invalid speaker turns or coverage');
    const rawCoverage = coverage ?? [...new Set(turns.map((t) => t.source))].map((source) => turns.filter((t) => t.source === source)
      .reduce((r, t) => ({ source, start_ms: Math.min(r.start_ms, t.start_ms), end_ms: Math.max(r.end_ms, t.end_ms) }), { source, start_ms: Infinity, end_ms: -Infinity }));
    const ranges = [...new Set(rawCoverage.map((r) => r.source))].flatMap((source) => intervals(rawCoverage.filter((r) => r.source === source)).map((r) => ({ ...r, source })));
    if (turns.some((t) => !ranges.some((r) => r.source === t.source && r.start_ms <= t.start_ms && r.end_ms >= t.end_ms))) throw new Error('Speaker turn is outside analysed coverage');
    let applied = false;
    this.speakerTransaction(() => {
      const analysis = this.speakerAnalysis(sessionId);
      if (analysis.generation !== generation || !['queued', 'running'].includes(analysis.status)) return;
      applied = true;
      const previous = this.db.prepare('SELECT source, speaker_id, start_ms, end_ms FROM speaker_turns WHERE session_id = ?').all(sessionId) as unknown as StoredTurn[];
      const groups = new Map<string, SpeakerTurn[]>();
      for (const t of turns) { const key = JSON.stringify([t.source, t.speaker]); const group = groups.get(key) ?? []; group.push(t); groups.set(key, group); }
      // Match only when old and new clusters agree in their overlapping audio, in both directions.
      const candidates: Array<{ key: string; id: string; score: number }> = [];
      const merged = new Map<string, Span[]>();
      const spans = (key: string, rows: Span[]) => { let m = merged.get(key); if (!m) { m = intervals(rows); merged.set(key, m); } return m; };
      const oldBySpeaker = new Map<string, StoredTurn[]>();
      for (const t of previous) { const g = oldBySpeaker.get(t.speaker_id) ?? []; g.push(t); oldBySpeaker.set(t.speaker_id, g); }
      for (const [key, group] of groups) {
        const source = group[0].source;
        const mine = spans(key, group);
        const newInOld = mergedOverlap(mine, spans(`old:${source}`, previous.filter((t) => t.source === source)));
        if (!newInOld) continue;
        const allNew = spans(`new:${source}`, turns.filter((t) => t.source === source));
        for (const [id, oldGroup] of oldBySpeaker) {
          if (oldGroup[0].source !== source) continue;
          const theirs = spans(`id:${id}`, oldGroup), score = mergedOverlap(mine, theirs);
          if (!score) continue;
          const oldInNew = mergedOverlap(theirs, allNew);
          if (score / newInOld >= 0.6 && oldInNew && score / oldInNew >= 0.6) candidates.push({ key, id, score });
        }
      }
      const mapped = new Map<string, string>(), used = new Set<string>();
      for (const c of candidates.sort((a, b) => b.score - a.score)) if (!mapped.has(c.key) && !used.has(c.id)) { mapped.set(c.key, c.id); used.add(c.id); }
      let labelIndex = this.speakers(sessionId).length;
      for (const [key, group] of groups) if (!mapped.has(key)) {
        const id = `sp_${randomUUID()}`;
        this.db.prepare('INSERT INTO session_speakers(id, session_id, source, label, name, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
          .run(id, sessionId, group[0].source, speakerLabel(labelIndex++), now());
        mapped.set(key, id);
      }
      // Retain earlier coverage and split old turns at a partial replacement boundary.
      const kept: StoredTurn[] = previous.flatMap((t) => {
        let pieces = [t];
        for (const r of ranges.filter((r) => r.source === t.source)) pieces = pieces.flatMap((p) => overlapMs(p, r) <= 0 ? [p] : [
          ...(p.start_ms < r.start_ms ? [{ ...p, end_ms: r.start_ms }] : []),
          ...(p.end_ms > r.end_ms ? [{ ...p, start_ms: r.end_ms }] : []),
        ]);
        return pieces;
      });
      const next: StoredTurn[] = [...kept, ...turns.map((t) => ({ source: t.source, start_ms: t.start_ms, end_ms: t.end_ms, speaker_id: mapped.get(JSON.stringify([t.source, t.speaker]))! }))];
      this.db.prepare('DELETE FROM speaker_turns WHERE session_id = ?').run(sessionId);
      const insert = this.db.prepare('INSERT INTO speaker_turns(session_id, source, speaker_id, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)');
      for (const t of next) insert.run(sessionId, t.source, t.speaker_id, t.start_ms, t.end_ms);
      // Lines that only gain their first labels do not make earlier AI output wrong; changed labels do.
      let labelled = false, relabelled = false;
      const index = turnIndex(next);
      const upsert = this.db.prepare(`INSERT INTO segment_speakers(segment_id, speaker_id, state, origin, auto_speaker_id, auto_state) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(segment_id) DO UPDATE SET speaker_id = excluded.speaker_id, state = excluded.state, origin = excluded.origin,
        auto_speaker_id = excluded.auto_speaker_id, auto_state = excluded.auto_state`);
      const bySource = new Map<string, Span[]>();
      for (const r of ranges) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
      for (const s of this.segments(sessionId)) {
        const span = { start_ms: s.t_start, end_ms: s.t_end }, analysed = bySource.get(s.source ?? '') ?? [];
        const covered = mergedOverlap(analysed, [span]);
        if (!covered) continue;
        const auto = this.speakerForSegment(s, index, covered >= s.t_end - s.t_start), manual = s.speaker_origin === 'manual';
        const id = manual ? s.speaker_id ?? null : auto.id, state = manual ? s.speaker_state! : auto.state;
        if (!s.speaker_state) labelled = true;
        else if (id !== (s.speaker_id ?? null) || state !== s.speaker_state) relabelled = true;
        upsert.run(s.id, id, state, manual ? 'manual' : 'automatic', auto.id, auto.state);
      }
      this.setSpeakerAnalysis(sessionId, { status: 'done', generation, error: null, updated_at: now() });
      if (relabelled) this.speakerChanged(sessionId);
      else if (labelled) this.speakerChanged(sessionId, false);
    });
    return applied;
  }
  renameSpeaker(sessionId: string, speakerId: string, name: string | null): void {
    this.requireSpeakerSession(sessionId);
    if (name !== null && (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(name))) throw new Error('Speaker name must be 1–80 characters without control characters');
    const clean = name?.trim() ?? null;
    this.speakerTransaction(() => {
      const speaker = this.speakers(sessionId).find((s) => s.id === speakerId);
      if (!speaker) throw new Error('Speaker does not belong to this session');
      if (speaker.name === clean) return;
      this.db.prepare('UPDATE session_speakers SET name = ? WHERE id = ? AND session_id = ?').run(clean, speakerId, sessionId);
      this.speakerChanged(sessionId);
    });
  }
  correctSegmentSpeaker(sessionId: string, segmentId: number, correction: SpeakerCorrection): void {
    this.requireSpeakerSession(sessionId);
    if (!correction || !['automatic', 'unknown', 'speaker'].includes(correction.mode)) throw new Error('Invalid speaker correction');
    this.speakerTransaction(() => {
      const segment = this.segmentsByIds(sessionId, [segmentId])[0];
      if (!segment) throw new Error('Transcript segment does not belong to this session');
      const saved = this.db.prepare('SELECT auto_speaker_id, auto_state FROM segment_speakers WHERE segment_id = ?').get(segmentId) as { auto_speaker_id: string | null; auto_state: SpeakerState } | undefined;
      const auto = saved ?? { auto_speaker_id: null, auto_state: 'unknown' as const };
      let id: string | null = null, state: SpeakerState = 'unknown';
      if (correction.mode === 'speaker') {
        const speaker = this.speakers(sessionId).find((s) => s.id === correction.speakerId);
        if (!speaker || speaker.source !== segment.source) throw new Error('Speaker does not belong to this session and audio source');
        id = speaker.id; state = 'assigned';
      } else if (correction.mode === 'automatic') { id = auto.auto_speaker_id; state = auto.auto_state; }
      const origin = correction.mode === 'automatic' ? 'automatic' : 'manual';
      if (segment.speaker_id === id && segment.speaker_state === state && segment.speaker_origin === origin) return;
      this.db.prepare(`INSERT INTO segment_speakers(segment_id, speaker_id, state, origin, auto_speaker_id, auto_state) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(segment_id) DO UPDATE SET speaker_id = excluded.speaker_id, state = excluded.state, origin = excluded.origin`)
        .run(segmentId, id, state, origin, auto.auto_speaker_id, auto.auto_state);
      this.speakerChanged(sessionId);
    });
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
  /**
   * Mark outputs that were in flight when the server stopped, so they don't appear stuck. A handoff draft in
   * progress goes back to review if it already had items (as a failed redraft does), otherwise to error.
   */
  failStaleOutputs(): void {
    this.db.prepare("UPDATE ai_outputs SET status = 'error', error = 'Interrupted: the app stopped before this finished.' WHERE status IN ('pending', 'streaming')").run();
    this.db.prepare(`UPDATE handoffs SET status = CASE WHEN EXISTS (SELECT 1 FROM handoff_items WHERE handoff_id = handoffs.id) THEN 'draft' ELSE 'error' END,
      error = 'Interrupted: the app stopped before the draft finished.', updated_at = ? WHERE status = 'generating'`).run(now());
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
  /** A failed redraft must leave both the old items and their source metadata intact. */
  replaceHandoffDraft(id: string, removeIds: string[], items: Array<Omit<HandoffItemRow, 'updated_at'>>, source: Pick<HandoffRow, 'source_revision' | 'confirmed_segment_max' | 'project_id'>): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.deleteHandoffItems(removeIds);
      for (const item of items) this.insertHandoffItem(item);
      this.updateHandoff(id, { ...source, status: 'draft', error: null });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  maxSegmentId(sessionId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM segments WHERE session_id = ?').get(sessionId) as { m: number }).m;
  }

  // ---------- user-maintained project work ----------
  actionProgress(item: Pick<HandoffItemRow, 'id' | 'project_id' | 'text'>): ActionProgress {
    const row = this.db.prepare('SELECT * FROM action_progress WHERE item_id = ?').get(item.id) as {
      project_id: string | null; item_text: string; status: ActionProgress['status']; note: string;
      results_json: string; updated_at: number | null; version: number;
    } | undefined;
    if (!row || row.project_id !== item.project_id || row.item_text !== item.text) {
      return { status: 'not_started', note: '', results: [], updatedAt: null, version: row?.version ?? 0 };
    }
    return { status: row.status, note: row.note, results: JSON.parse(row.results_json) as ActionProgress['results'], updatedAt: row.updated_at, version: row.version };
  }
  saveActionProgress(item: Pick<HandoffItemRow, 'id' | 'project_id' | 'text'>, value: Pick<ActionProgress, 'status' | 'note' | 'results'>): ActionProgress {
    this.db.prepare(`UPDATE action_progress SET project_id = ?, item_text = ?, status = ?, note = ?, results_json = ?, updated_at = ?, version = version + 1 WHERE item_id = ?`)
      .run(item.project_id, item.text, value.status, value.note, JSON.stringify(value.results), now(), item.id);
    return this.actionProgress(item);
  }
  projectAgenda(projectId: string): ProjectAgenda {
    const row = this.db.prepare('SELECT text, version, updated_at AS updatedAt FROM project_agendas WHERE project_id = ?').get(projectId) as unknown as ProjectAgenda | undefined;
    return row ?? { text: '', version: 0, updatedAt: null };
  }
  saveProjectAgenda(projectId: string, text: string): ProjectAgenda {
    this.db.prepare(`INSERT INTO project_agendas(project_id, text, updated_at, version) VALUES (?, ?, ?, 1)
      ON CONFLICT(project_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at, version = project_agendas.version + 1`)
      .run(projectId, text, now());
    return this.projectAgenda(projectId);
  }

  // ---------- agent reads (written by the MCP server; shown as connection status) ----------
  recordAgentRead(r: Omit<AgentReadRow, 'id' | 'at'>): void {
    this.db.prepare('INSERT INTO agent_reads(at, client, tool, project_id, session_id, handoff_id, revision, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now(), r.client, r.tool, r.project_id, r.session_id, r.handoff_id, r.revision, r.token);
    // Connection verification must survive ordinary read-log rotation.
    this.db.prepare("DELETE FROM agent_reads WHERE id <= (SELECT MAX(id) - 2000 FROM agent_reads) AND NOT (tool = 'connection_check' AND token IS NOT NULL AND token != '')").run();
  }
  agentReads(opts: { client?: string; handoffId?: string; token?: string; verifiedOnly?: boolean; limit?: number } = {}): AgentReadRow[] {
    const where: string[] = []; const args: Array<string | number> = [];
    if (opts.client) { where.push('client = ?'); args.push(opts.client); }
    if (opts.verifiedOnly) where.push("tool = 'connection_check' AND token IS NOT NULL AND token != ''");
    if (opts.handoffId) { where.push('handoff_id = ?'); args.push(opts.handoffId); }
    if (opts.token) { where.push('token = ?'); args.push(opts.token); }
    return this.db.prepare(`SELECT * FROM agent_reads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, opts.limit ?? 20) as unknown as AgentReadRow[];
  }
}
