import type { OutputRow, SegmentRow, Store } from '../db.ts';
import { fmtT } from '../util.ts';
import type { InputBudget } from './provider.ts';

export function limitText(text: string, budget: InputBudget): string {
  if (budget.estimate(text) <= budget.tokens) return text;
  const chars = Array.from(text), marker = '\n[… details omitted …]';
  let lo = 0, hi = chars.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (budget.estimate(chars.slice(0, mid).join('') + marker) <= budget.tokens) lo = mid; else hi = mid - 1; }
  return lo ? chars.slice(0, lo).join('') + marker : '';
}

/** Trim the oldest verbatim lines first, keeping summaries and the user's question. */
export function fitInput(text: string, budget: InputBudget | null | undefined): string {
  if (!budget || budget.estimate(text) <= budget.tokens) return text;
  const lines = text.split('\n');
  for (const pattern of [/^\[\d+:\d+(?::\d+)?\] /, /^\[\d+:\d+(?::\d+)?[–—-]/]) {
    for (let i = 0; i < lines.length && budget.estimate(lines.join('\n')) > budget.tokens; i++) {
      if (pattern.test(lines[i])) lines[i] = '';
    }
  }
  return lines.filter((line, i) => line || lines[i - 1]).join('\n');
}

/** Split oversized lines as well as groups; never mark text covered before all parts were sent. */
export function splitSegments(segs: SegmentRow[], budget: InputBudget, wrap: (text: string) => string): SegmentRow[][] {
  const chunks: SegmentRow[][] = [];
  let chunk: SegmentRow[] = [];
  const fits = (rows: SegmentRow[]) => budget.estimate(wrap(rows.map((s) => formatSeg(s)).join('\n'))) <= budget.tokens;
  for (const seg of segs) {
    if (fits([...chunk, seg])) { chunk.push(seg); continue; }
    if (chunk.length) { chunks.push(chunk); chunk = []; }
    if (fits([seg])) { chunk.push(seg); continue; }
    let rest = Array.from(seg.text);
    while (rest.length) {
      let lo = 0, hi = rest.length;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits([{ ...seg, text: rest.slice(0, mid).join('') }])) lo = mid; else hi = mid - 1; }
      // The provider reports an actionable error if even the fixed instructions cannot fit.
      if (!lo) { chunks.push([{ ...seg, text: rest.join('') }]); break; }
      chunks.push([{ ...seg, text: rest.slice(0, lo).join('') }]); rest = rest.slice(lo);
    }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

export const TOTAL_RAW_BUDGET = 40_000;   // chars of raw transcript we are willing to send in one request (~10k tokens)
export const RECENT_WINDOW_MS = 10 * 60_000;

const STOP = new Set(('the and for that this with from have what about there their they them then than were been being into just like your you our are was but not can will would could should also more some such very when where which while who why how its it’s it\'s okay yeah right know think mean really going thing things kind sort lot well because actually basically '
  + 'explain does what mean term this that why using use used method').split(' '));

/**
 * One transcript line for the AI. Tags stay short because they repeat on every line; their meaning is stated once
 * in the base rules: (Speaker A) or a name is automatic, "✓" marks the user's correction. Unanalysed lines have none.
 */
export function formatSeg(s: SegmentRow, label = true): string {
  const speaker = s.speaker_state === 'mixed' ? 'mixed speakers'
    : s.speaker_state === 'assigned' && s.speaker_label ? `${s.speaker_label}${s.speaker_origin === 'manual' ? ' ✓' : ''}`
      : s.speaker_state === 'unknown' ? 'speaker unknown' : '';
  const tags = [s.source === 'system' ? 'computer audio' : '', speaker].filter(Boolean).join('; ');
  return `[${fmtT(s.t_start)}] ${label && tags ? `(${tags}) ` : ''}${s.text}`;
}

/** Render transcript lines, keeping the most recent ones if over budget. */
export function renderSegments(segs: SegmentRow[], maxChars: number): { text: string; from: number | null; to: number | null; truncated: boolean; segmentIds: number[] } {
  const lines: string[] = [];
  let used = 0, truncated = false, firstIdx = segs.length;
  for (let i = segs.length - 1; i >= 0; i--) {
    const l = formatSeg(segs[i]);
    if (used + l.length + 1 > maxChars) { truncated = true; break; }
    lines.unshift(l); used += l.length + 1; firstIdx = i;
  }
  const kept = segs.slice(firstIdx);
  return {
    text: (truncated ? '[… earlier lines omitted …]\n' : '') + lines.join('\n'),
    from: kept.length ? kept[0].t_start : null,
    to: kept.length ? kept[kept.length - 1].t_end : null,
    truncated,
    segmentIds: kept.map((s) => s.id),
  };
}

/** Size as sent (with time and speaker tags), so budget checks match what renderSegments keeps. */
export function totalChars(segs: SegmentRow[]): number { return segs.reduce((n, s) => n + formatSeg(s).length + 1, 0); }

/** Keywords for retrieval: technical-looking English words and CJK trigrams. */
export function keywords(text: string, max = 12): string[] {
  const out = new Map<string, number>();
  for (const w of text.match(/[A-Za-z][A-Za-z0-9\-]{2,}/g) ?? []) {
    const k = w.toLowerCase();
    if (STOP.has(k) || k.length < 4 && !/[A-Z]{2,}/.test(w)) continue;
    out.set(w, (out.get(w) ?? 0) + (/[A-Z0-9]/.test(w.slice(1)) ? 3 : 1));
  }
  for (const run of text.match(/[一-鿿]{3,}/g) ?? []) {
    for (let i = 0; i + 3 <= run.length && i < 12; i += 2) out.set(run.slice(i, i + 3), 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
}

export interface Digest { from: number; to: number; text: string; segmentIds: number[]; legacyCompletedAt?: number | null }

export function digests(store: Store, sessionId: string): Digest[] {
  return store.outputs(sessionId, ['digest']).filter((o) => o.status === 'done' && o.content && !o.stale_reason)
    .flatMap((o) => {
      let ids: unknown;
      try { ids = JSON.parse(o.data_json ?? '{}').segmentIds; } catch { return []; }
      // Keep saved time-only notes, but never let them cover lines committed after they finished.
      if (ids === undefined) return [{ from: o.covered_from ?? 0, to: o.covered_to ?? 0, text: o.content!, segmentIds: [], legacyCompletedAt: o.completed_at }];
      if (!Array.isArray(ids) || !ids.length || !ids.every(Number.isSafeInteger)) return [];
      return [{ from: o.covered_from ?? 0, to: o.covered_to ?? 0, text: o.content!, segmentIds: ids as number[] }];
    })
    .sort((a, b) => a.from - b.from);
}

export function renderDigests(ds: Digest[], beforeT = Infinity, maxChars = Infinity): string {
  const notes = ds.filter((d) => d.from < beforeT).map((d) => `[${fmtT(d.from)}–${fmtT(d.to)}] ${d.text}`);
  if (notes.join('\n').length <= maxChars) return notes.join('\n');
  const kept: string[] = [];
  for (let i = notes.length - 1; i >= 0; i--) {
    const candidate = [`[… ${i} earlier notes omitted …]`, notes[i], ...kept].join('\n');
    if (candidate.length > maxChars) break;
    kept.unshift(notes[i]);
  }
  const result = [`[… ${notes.length - kept.length} earlier notes omitted …]`, ...kept].join('\n');
  return result.length <= maxChars ? result : '';
}

export interface OverviewData {
  current_topic: string;
  overview: string[];
  topics: Array<{ title: string; start: string }>;
  open_question: string;
  digest?: string;
  topic_changed?: boolean;
  lastSegmentId?: number;
}

export function latestOverview(store: Store, sessionId: string): (OutputRow & { data: OverviewData }) | null {
  const o = store.latestOutput(sessionId, 'overview');
  if (!o?.data_json || o.stale_reason) return null;
  try { return { ...o, data: JSON.parse(o.data_json) as OverviewData }; } catch { return null; }
}

export function renderOverview(ov: OverviewData | null | undefined, maxChars = Infinity): string {
  if (!ov) return '(no overview yet)';
  const topics = ov.topics?.length ? ov.topics.map((t) => `- [${t.start}] ${t.title}`).join('\n') : '- (none)';
  const text = `Current topic: ${ov.current_topic}\nOverview so far:\n${ov.overview.map((b) => `- ${b}`).join('\n')}\nTopic timeline:\n${topics}${ov.open_question ? `\nOpen question: ${ov.open_question}` : ''}`;
  if (text.length <= maxChars) return text;
  const omitted = '[… overview details omitted …]';
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if ([...kept, line, omitted].join('\n').length > maxChars) break;
    kept.push(line);
  }
  return [...kept, omitted].join('\n');
}

/** Older passages relevant to a query, excluding a time range already included verbatim. */
export function retrieve(store: Store, sessionId: string, query: string, exclude: [number, number] | null, k = 8): SegmentRow[] {
  const hits = store.searchSegments(sessionId, keywords(query), k * 3);
  return hits
    .filter((s) => !exclude || s.t_end < exclude[0] || s.t_start > exclude[1])
    .slice(0, k)
    .sort((a, b) => a.t_start - b.t_start);
}

/** Spans of transcript with no digest yet (before `upTo`), chunked to ~maxChars. */
export function undigestedChunks(store: Store, sessionId: string, upTo: number, maxChars = 14_000): SegmentRow[][] {
  const ds = digests(store, sessionId);
  const covered = new Set(ds.flatMap((d) => d.segmentIds));
  const legacy = ds.filter((d) => d.legacyCompletedAt != null);
  const segs = store.segments(sessionId, -Infinity, upTo).filter((s) => s.t_end <= upTo && !covered.has(s.id)
    && !legacy.some((d) => s.created_at <= d.legacyCompletedAt! && s.t_start >= d.from - 1000 && s.t_end <= d.to + 1000));
  const chunks: SegmentRow[][] = [];
  let cur: SegmentRow[] = [], chars = 0;
  for (const s of segs) {
    const contiguous = !cur.length || s.t_start - cur[cur.length - 1].t_end < 5 * 60_000;
    const size = formatSeg(s).length + 1;
    if (cur.length && (chars + size > maxChars || !contiguous)) { chunks.push(cur); cur = []; chars = 0; }
    cur.push(s); chars += size;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
