import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../db.ts';
import { log } from '../util.ts';

/*
 * mybot integration (https://github.com/jzhoulab/mybot).
 *
 * mybot indexes conversations into one local, searchable memory and answers questions grounded in them.
 * When enabled, Chumi writes every finished session to <exportDir>/<session-id>.jsonl in the
 * "chumi-transcript/1" format documented in docs/mybot.md; mybot's `chumi` source adapter indexes that folder.
 *
 * Meetings contain other people's words, so exports are marked owner-only ("visibility": "private") unless
 * the user explicitly turns on sharing with their team.
 */

export const FORMAT = 'chumi-transcript/1';
const KIND_EXPORTED = new Set(['answer', 'explain', 'catchup']);

export function expandDir(dir: string): string {
  return dir.replace(/^~(?=$|\/)/, homedir());
}

/** Build the JSONL document for one session (only finished or interrupted sessions are exported). */
export function sessionToJsonl(store: Store, id: string, shareWithTeam: boolean): string | null {
  const s = store.getSession(id);
  if (!s || s.status === 'recording' || s.status === 'paused') return null;
  const started = s.started_at ?? s.created_at;
  const iso = (ms: number) => new Date(ms).toISOString();
  const lines: unknown[] = [{
    type: 'session', format: FORMAT, id: s.id, title: s.title, session_type: s.type, status: s.status,
    started_at: iso(started), ended_at: s.ended_at ? iso(s.ended_at) : null, duration_ms: s.duration_ms,
    audio_source: s.audio_source, visibility: shareWithTeam ? 'shared' : 'private',
  }];
  const events = store.timeline(id).filter((e) => ['pause', 'resume', 'gap', 'interrupted'].includes(e.kind));
  const segs = store.segments(id);
  let ei = 0;
  for (const seg of segs) {
    while (ei < events.length && events[ei].t <= seg.t_start) {
      const e = events[ei++];
      lines.push({ type: 'gap', kind: e.kind, t_ms: e.t, timestamp: iso(started + e.t), detail: e.detail });
    }
    lines.push({ type: 'segment', t_ms: seg.t_start, t_end_ms: seg.t_end, timestamp: iso(started + seg.t_start), source: seg.source, lang: seg.lang, text: seg.text });
  }
  const outs = store.outputs(id).filter((o) => o.status === 'done' && o.content);
  for (const o of outs) {
    if (KIND_EXPORTED.has(o.kind)) {
      lines.push({ type: 'qa', kind: o.kind, created_at: iso(o.created_at), question: o.question, answer: o.content, covered_from_ms: o.covered_from, covered_to_ms: o.covered_to });
    }
  }
  const summary = [...outs].reverse().find((o) => o.kind === 'final_summary');
  if (summary) lines.push({ type: 'summary', created_at: iso(summary.created_at), text: summary.content });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

export class MybotExporter {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  private cfg() { return this.store.getSettings().integrations.mybot; }
  get dir(): string { return expandDir(this.cfg().exportDir); }

  /** Write (or refresh) one session's export; removes it if the session no longer qualifies. */
  sync(id: string, force = false): boolean {
    const c = this.cfg();
    if (!c.enabled && !force) return false;
    const doc = sessionToJsonl(this.store, id, c.shareWithTeam);
    const file = join(this.dir, `${id}.jsonl`);
    if (!doc) { if (!this.store.getSession(id)) rmSync(file, { force: true }); return false; }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(file + '.tmp', doc);
    renameSync(file + '.tmp', file);
    return true;
  }

  remove(id: string): void { rmSync(join(this.dir, `${id}.jsonl`), { force: true }); }

  exportAll(): { exported: number; dir: string } {
    let exported = 0;
    for (const s of this.store.listSessions()) if (this.sync(s.id, true)) exported++;
    log('mybot', `exported ${exported} sessions to ${this.dir}`);
    return { exported, dir: this.dir };
  }

  status(): { enabled: boolean; dir: string; files: number; shareWithTeam: boolean } {
    const c = this.cfg();
    const files = existsSync(this.dir) ? readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).length : 0;
    return { enabled: c.enabled, dir: this.dir, files, shareWithTeam: c.shareWithTeam };
  }
}
