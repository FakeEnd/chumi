// What the desktop pet lists under its toolbar: the latest answers and explanations of the current meeting.
// No DOM here, so tests can check it.

import { msg, t } from '../i18n.ts';
import type { Output } from '../types.ts';
import { tagOf, type Tag } from './tags.ts';

const SCOPE: Record<string, string> = { all: msg('session so far'), '5m': msg('last 5 min'), '2m': msg('last 2 min') };

/** Answers someone asked for, explanations, and the summary. Background recaps and digests stay in Chumi's window. */
export function listed(o: Output): boolean {
  if (o.status === 'cancelled' || o.status === 'suppressed') return false;
  return ['catchup', 'answer', 'explain', 'auto_explain', 'final_summary'].includes(o.kind) || (o.kind === 'overview' && !!o.question);
}

/** Newest first, only the tags given. `keep`: cards shown whatever their tag (one you just asked for or opened). */
export function recent(outputs: Iterable<Output>, n: number, tags: readonly Tag[] = ['meeting', 'tangent', 'background', 'summary'], keep: (o: Output) => boolean = () => false): Output[] {
  const working = (o: Output) => o.status === 'pending' || o.status === 'streaming';
  return [...outputs].filter((o) => listed(o) && (keep(o) || working(o) || tags.includes(tagOf(o) ?? 'meeting')))
    .sort((a, b) => b.created_at - a.created_at).slice(0, n);
}

/** How many listed cards of each tag there are, for the filter chips. */
export function tagCounts(outputs: Iterable<Output>): Map<Tag, number> {
  const counts = new Map<Tag, number>();
  for (const o of outputs) if (listed(o)) { const k = tagOf(o) ?? 'meeting'; counts.set(k, (counts.get(k) ?? 0) + 1); }
  return counts;
}

/** The same titles as the cards in Chumi's window. */
export function cardTitle(o: Output): string {
  switch (o.kind) {
    case 'catchup': return `${t('Catch-up')} · ${t(SCOPE[o.scope ?? '2m'] ?? SCOPE['2m'])}`;
    case 'answer': return o.question ?? t('Question');
    case 'explain': return t('Explain: {term}', { term: o.question ?? '' });
    case 'auto_explain': return o.question ?? t('Background');
    case 'final_summary': return t('Final summary');
    default: return t('Recap');
  }
}

/** Markdown → one line of plain text for the collapsed card: no citations, markup or links. */
export function preview(md: string, max = 180): string {
  const s = md
    .replace(/\[\d{1,2}:\d{2}[^\]]*\]/g, '')           // [m:ss], [m:ss–m:ss, …]
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')          // links and images
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '') // headings, bullets, quotes
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。；：、,.;:!?！？])/g, '$1')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** "20:58" today, otherwise with the date. */
export function when(ms: number, now: number, locale: string): string {
  const d = new Date(ms), today = new Date(now).toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Where "Open in Chumi" should land in the transcript for this card. */
export function focusOf(o: Output): { t: number; t2?: number } | undefined {
  if (o.selection) return { t: o.selection.fromT, t2: o.selection.toT };
  if (o.covered_from != null) return { t: o.covered_from, t2: o.covered_to ?? undefined };
  return undefined;
}
