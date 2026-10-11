import type { OutputRow, SegmentRow, Store } from '../db.ts';
import { fmtT } from '../util.ts';

export const TOTAL_RAW_BUDGET = 40_000;   // chars of raw transcript we are willing to send in one request (~10k tokens)
export const RECENT_WINDOW_MS = 10 * 60_000;

const STOP = new Set(('the and for that this with from have what about there their they them then than were been being into just like your you our are was but not can will would could should also more some such very when where which while who why how its it’s it\'s okay yeah right know think mean really going thing things kind sort lot well because actually basically '
  + 'explain does what mean term this that why using use used method').split(' '));

export function formatSeg(s: SegmentRow, label = true): string {
  const who = label && s.source === 'system' ? '(computer audio) ' : label && s.source === 'mic' ? '' : '';
  return `[${fmtT(s.t_start)}] ${who}${s.text}`;
}

/** Render transcript lines, keeping the most recent ones if over budget. */
export function renderSegments(segs: SegmentRow[], maxChars: number): { text: string; from: number | null; to: number | null; truncated: boolean } {
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
  };
}

export function totalChars(segs: SegmentRow[]): number { return segs.reduce((n, s) => n + s.text.length + 10, 0); }

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

export interface Digest { from: number; to: number; text: string }

export function digests(store: Store, sessionId: string): Digest[] {
  return store.outputs(sessionId, ['digest']).filter((o) => o.status === 'done' && o.content)
    .map((o) => ({ from: o.covered_from ?? 0, to: o.covered_to ?? 0, text: o.content! }))
    .sort((a, b) => a.from - b.from);
}

export function renderDigests(ds: Digest[], beforeT = Infinity): string {
  return ds.filter((d) => d.from < beforeT).map((d) => `[${fmtT(d.from)}–${fmtT(d.to)}] ${d.text}`).join('\n');
}

export interface OverviewData {
  current_topic: string;
  overview: string[];
  topics: Array<{ title: string; start: string }>;
  open_question: string;
  digest?: string;
  topic_changed?: boolean;
}

export function latestOverview(store: Store, sessionId: string): (OutputRow & { data: OverviewData }) | null {
  const o = store.latestOutput(sessionId, 'overview');
  if (!o?.data_json) return null;
  try { return { ...o, data: JSON.parse(o.data_json) as OverviewData }; } catch { return null; }
}

export function renderOverview(ov: OverviewData | null | undefined): string {
  if (!ov) return '(no overview yet)';
  const topics = ov.topics?.length ? ov.topics.map((t) => `- [${t.start}] ${t.title}`).join('\n') : '- (none)';
  return `Current topic: ${ov.current_topic}\nOverview so far:\n${ov.overview.map((b) => `- ${b}`).join('\n')}\nTopic timeline:\n${topics}${ov.open_question ? `\nOpen question: ${ov.open_question}` : ''}`;
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
  const covered = (s: SegmentRow) => ds.some((d) => s.t_start >= d.from - 1000 && s.t_end <= d.to + 1000);
  const segs = store.segments(sessionId, -Infinity, upTo).filter((s) => s.t_end <= upTo && !covered(s));
  const chunks: SegmentRow[][] = [];
  let cur: SegmentRow[] = [], chars = 0;
  for (const s of segs) {
    const contiguous = !cur.length || s.t_start - cur[cur.length - 1].t_end < 5 * 60_000;
    if (cur.length && (chars + s.text.length > maxChars || !contiguous)) { chunks.push(cur); cur = []; chars = 0; }
    cur.push(s); chars += s.text.length + 10;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
