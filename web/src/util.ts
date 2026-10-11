import { marked } from 'marked';

export function fmtT(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}
export function parseT(s: string): number | null {
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return null;
}
export const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtDate = (ms: number) => new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html(token) { return esc((token as { text: string }).text); },
    link(token) {
      const t = token as unknown as { href: string; text: string };
      const ok = /^https?:\/\//i.test(t.href);
      return ok ? `<a href="${esc(t.href)}" target="_blank" rel="noreferrer">${esc(t.text)}</a>` : esc(t.text);
    },
    image(token) { return esc((token as { text: string }).text || ''); },
  },
});

const REF = /\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[–—-]\s*(\d{1,2}:\d{2}(?::\d{2})?))?\]/g;

/** Markdown → safe HTML with clickable transcript references. */
export function renderMd(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  // Only touch text outside tags.
  return html.replace(/(^|>)([^<]+)(?=<|$)/g, (_m, lead: string, text: string) => lead + text.replace(REF, (all, a: string, b?: string) => {
    const t = parseT(a);
    const t2 = b ? parseT(b) : null;
    if (t == null) return all;
    return `<button class="ref" data-t="${t}"${t2 != null ? ` data-t2="${t2}"` : ''} title="Show in transcript">${b ? `${a}–${b}` : a}</button>`;
  }));
}

export const SESSION_TYPES: Array<{ id: string; label: string }> = [
  { id: 'lab_meeting', label: 'Lab meeting' }, { id: 'advisor', label: 'Advisor 1:1' }, { id: 'lecture', label: 'Lecture' }, { id: 'wip', label: 'WIP / seminar' }, { id: 'other', label: 'Other' },
];
export const typeLabel = (t: string) => SESSION_TYPES.find((x) => x.id === t)?.label ?? t;
export const SOURCE_LABEL: Record<string, string> = { mic: 'Microphone', system: 'Computer audio', both: 'Mic + computer', file: 'Audio file (test)' };
