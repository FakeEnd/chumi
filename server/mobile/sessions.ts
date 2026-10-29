import { createHash, randomUUID } from 'node:crypto';
import type { Store, OutputRow } from '../db.ts';
import { SESSION_STYLES, type SessionStyle } from '../../shared/session-types.ts';

export class MobileError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}

export interface MobileSegment { id: string; tStart: number; tEnd: number; text: string; lang: string | null }
export interface MobileSnapshot {
  clientId: string; revision: number; title: string; startedAt: number; durationMs: number;
  status: 'recording' | 'paused' | 'ended'; type: SessionStyle; projectId: string | null;
  segments: MobileSegment[];
}
interface Metadata { title: string; type: string; projectId: string | null }
interface Mapping { client_id: string; session_id: string; revision: number; digest: string; phone_metadata: string | null }

const invalid = (message: string): never => { throw new MobileError(400, 'invalid_request', message); };
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid('Expected a JSON object.');
  return v as Record<string, unknown>;
};
const whole = (v: unknown, min: number, max: number, field: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) return invalid(`Invalid ${field}.`);
  return v;
};
const string = (v: unknown, max: number, field: string): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || v.includes('\0')) return invalid(`Invalid ${field}.`);
  return v;
};

/** Validate and canonicalize before hashing, including keys and UUID casing. */
export function mobileSnapshot(value: unknown): MobileSnapshot {
  const v = object(value);
  const clientId = string(v.clientId, 36, 'clientId').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(clientId)) invalid('clientId must be a UUID.');
  const durationMs = whole(v.durationMs, 0, 7 * 24 * 60 * 60_000, 'durationMs');
  if (!['recording', 'paused', 'ended'].includes(String(v.status))) invalid('Invalid session status.');
  if (!(SESSION_STYLES as readonly unknown[]).includes(v.type)) invalid('Invalid session type.');
  if (!Array.isArray(v.segments) || v.segments.length > 20_000) invalid('Expected at most 20,000 finalized segments.');
  const seen = new Set<string>();
  let lastStart = -1;
  const segments = (v.segments as unknown[]).map((raw): MobileSegment => {
    const s = object(raw);
    const id = string(s.id, 128, 'segment id');
    if (seen.has(id)) invalid('Segment IDs must be unique.');
    seen.add(id);
    const tStart = whole(s.tStart, 0, durationMs, 'segment tStart');
    const tEnd = whole(s.tEnd, tStart, durationMs, 'segment tEnd');
    if (tStart < lastStart) invalid('Segments must be ordered by tStart.');
    lastStart = tStart;
    return { id, tStart, tEnd, text: string(s.text, 16_000, 'segment text'), lang: s.lang == null ? null : string(s.lang, 40, 'segment lang') };
  });
  return {
    clientId, revision: whole(v.revision, 1, Number.MAX_SAFE_INTEGER, 'revision'), title: string(v.title, 300, 'title'),
    startedAt: whole(v.startedAt, 0, 8_640_000_000_000_000, 'startedAt'), durationMs,
    status: v.status as MobileSnapshot['status'], type: v.type as SessionStyle,
    projectId: v.projectId == null ? null : string(v.projectId, 128, 'projectId'), segments,
  };
}

export function mobileOutput(o: OutputRow) {
  return { id: o.id, sessionId: o.session_id, kind: o.kind, status: o.status, question: o.question,
    text: o.content, error: o.error, createdAt: o.created_at, completedAt: o.completed_at, provider: o.provider, model: o.model };
}

/** A separate ownership ledger prevents the phone from addressing or overwriting desktop meetings. */
export class MobileSessions {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS mobile_sessions (
        client_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, digest TEXT NOT NULL, phone_metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS mobile_segments (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        client_segment_id TEXT NOT NULL, segment_id INTEGER NOT NULL UNIQUE REFERENCES segments(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, PRIMARY KEY(session_id, client_segment_id), UNIQUE(session_id, position)
      );
    `);
    const columns = store.db.prepare('PRAGMA table_info(mobile_sessions)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'phone_metadata')) store.db.exec('ALTER TABLE mobile_sessions ADD COLUMN phone_metadata TEXT');
  }

  private mapping(sessionId: string): Mapping | undefined {
    return this.store.db.prepare('SELECT * FROM mobile_sessions WHERE session_id = ?').get(sessionId) as unknown as Mapping | undefined;
  }

  owned(sessionId: string) {
    const mapping = this.mapping(sessionId);
    const session = mapping && this.store.getSession(sessionId);
    if (!mapping || !session || session.audio_source !== 'mobile') throw new MobileError(404, 'not_found', 'Mobile session not found.');
    return { mapping, session };
  }

  private segments(sessionId: string): MobileSegment[] {
    const rows = this.store.db.prepare(`SELECT m.client_segment_id AS id, s.t_start AS tStart, s.t_end AS tEnd, s.text, s.lang
      FROM mobile_segments m JOIN segments s ON s.id = m.segment_id WHERE m.session_id = ? ORDER BY m.position`).all(sessionId) as unknown as MobileSegment[];
    return rows.map((s) => ({ id: s.id, tStart: s.tStart, tEnd: s.tEnd, text: s.text, lang: s.lang }));
  }

  detail(sessionId: string) {
    const { mapping: m, session: s } = this.owned(sessionId);
    return { session: { id: s.id, clientId: m.client_id, revision: m.revision, title: s.title, type: s.type,
      status: s.status, startedAt: s.started_at, durationMs: s.duration_ms, projectId: s.project_id },
    segments: this.segments(sessionId), outputs: this.store.outputs(sessionId).map(mobileOutput) };
  }

  output(outputId: string) {
    const o = this.store.getOutput(outputId);
    if (!o) throw new MobileError(404, 'not_found', 'Output not found.');
    this.owned(o.session_id);
    return { output: mobileOutput(o) };
  }

  ingest(value: unknown): { sessionId: string; clientId: string; revision: number; status: 'accepted' | 'unchanged'; metadata: Metadata } {
    const v = mobileSnapshot(value);
    const digest = createHash('sha256').update(JSON.stringify(v)).digest('hex');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const known = this.store.db.prepare('SELECT * FROM mobile_sessions WHERE client_id = ?').get(v.clientId) as unknown as Mapping | undefined;
      const id = known?.session_id ?? `s_mobile_${randomUUID()}`;
      const before = known ? this.owned(id).session : undefined;
      if (known && v.revision < known.revision) throw new MobileError(409, 'stale_revision', 'A newer snapshot is already stored.', { revision: known.revision });
      if (known && v.revision === known.revision) {
        if (digest !== known.digest) throw new MobileError(409, 'revision_conflict', 'This revision was already used for different content.', { revision: known.revision });
        if (!known.phone_metadata) this.store.db.prepare('UPDATE mobile_sessions SET phone_metadata = ? WHERE session_id = ?')
          .run(JSON.stringify({ title: v.title, type: v.type, projectId: v.projectId }), id);
        this.store.db.exec('COMMIT');
        return { sessionId: id, clientId: v.clientId, revision: known.revision, status: 'unchanged',
          metadata: { title: before!.title, type: before!.type, projectId: before!.project_id } };
      }
      const phone: Metadata = { title: v.title, type: v.type, projectId: v.projectId };
      // Old pairings have no baseline. Preserve Mac edits on their first sync after upgrading.
      const previousPhone: Metadata = known?.phone_metadata ? JSON.parse(known.phone_metadata) : phone;
      const metadata: Metadata = {
        title: before && phone.title === previousPhone.title ? before.title : phone.title,
        type: before && phone.type === previousPhone.type ? before.type : phone.type,
        projectId: before && phone.projectId === previousPhone.projectId ? before.project_id : phone.projectId,
      };
      if (metadata.projectId) {
        const p = this.store.getProject(metadata.projectId);
        if (!p || (p.archived_at != null && before?.project_id !== metadata.projectId)) throw new MobileError(400, 'invalid_project', 'Choose an available project.');
      }
      const previous = known ? this.segments(id) : [];
      if (before && (v.startedAt !== before.started_at || v.durationMs < before.duration_ms)) throw new MobileError(409, 'session_conflict', 'Session start cannot change and duration cannot decrease.');
      if (previous.length > v.segments.length || previous.some((s, i) => JSON.stringify(s) !== JSON.stringify(v.segments[i]))) {
        throw new MobileError(409, 'segment_conflict', 'Keep previously synced finalized segments unchanged and append new segments.');
      }
      if (!known) {
        this.store.createSession({ id, title: v.title, type: v.type, audio_source: 'mobile' });
        this.store.db.prepare('INSERT INTO mobile_sessions(client_id, session_id, revision, digest) VALUES (?, ?, ?, ?)').run(v.clientId, id, v.revision, digest);
        this.store.addTimeline(id, 0, 'start', 'Recorded and transcribed on the paired phone.');
      }
      if ((before?.project_id ?? null) !== metadata.projectId) this.store.assignSession(id, metadata.projectId);
      for (let i = previous.length; i < v.segments.length; i++) {
        const s = v.segments[i];
        const row = this.store.addSegment({ session_id: id, t_start: s.tStart, t_end: s.tEnd, text: s.text, lang: s.lang, source: 'mobile', run: 0 });
        this.store.db.prepare('INSERT INTO mobile_segments(session_id, client_segment_id, segment_id, position) VALUES (?, ?, ?, ?)').run(id, s.id, row.id, i);
      }
      if (before && before.status !== v.status) {
        const kind = v.status === 'ended' ? 'stop' : v.status === 'paused' ? 'pause' : 'resume';
        this.store.addTimeline(id, v.durationMs, kind, 'Phone recording status synced.');
      } else if (!before && v.status !== 'recording') {
        this.store.addTimeline(id, v.durationMs, v.status === 'ended' ? 'stop' : 'pause', 'Phone recording status synced.');
      }
      if (before && (before.title !== metadata.title || before.type !== metadata.type)) this.store.db.prepare('UPDATE sessions SET revision = revision + 1 WHERE id = ?').run(id);
      this.store.updateSession(id, { title: metadata.title, type: metadata.type, started_at: v.startedAt, status: v.status,
        duration_ms: v.durationMs, ended_at: v.status === 'ended' ? v.startedAt + v.durationMs : null, last_activity_at: Date.now() });
      this.store.db.prepare('UPDATE mobile_sessions SET revision = ?, digest = ?, phone_metadata = ? WHERE session_id = ?').run(v.revision, digest, JSON.stringify(phone), id);
      this.store.db.exec('COMMIT');
      return { sessionId: id, clientId: v.clientId, revision: v.revision, status: 'accepted', metadata };
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
  }
}
