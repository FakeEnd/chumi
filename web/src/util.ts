import { marked } from 'marked';
import { getState } from './store.ts';
import { DEFAULT_SESSION_TYPES } from '../../shared/session-types.ts';
import { locale, msg, t as tr } from './i18n.ts';

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
export const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
export const fmtDate = (ms: number) => new Date(ms).toLocaleString(locale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

marked.use({
  gfm: true,
  breaks: false,
  // CommonMark doesn't close **…** when the closing ** follows punctuation and comes right before a letter, which is
  // how Chinese is written ("**简短回答：**之前…"), so the stars showed. A plain bold span (no * inside) is read here;
  // anything else goes to marked's own rules.
  extensions: [{
    name: 'plainStrong', level: 'inline',
    start: (src: string) => { const i = src.indexOf('**'); return i < 0 ? undefined : i; },
    tokenizer(src: string) {
      const m = /^\*\*(?![\s*])([^*\n]*?[^\s*\\])\*\*/.exec(src);
      return m ? { type: 'strong', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) } : undefined;
    },
  }],
  renderer: {
    html(token) { return esc((token as { text: string }).text); },
    // After an inline <code>, <kbd>, <pre> or <script> tag, marked flags the text that follows as raw HTML ("escaped")
    // and passes it through untouched. Tags are shown as text here, so that text is escaped like the rest.
    text(token) { return 'escaped' in token && token.escaped ? esc(token.text) : false; },
    link(token) {
      const t = token as unknown as { href: string; text: string };
      const ok = /^https?:\/\//i.test(t.href);
      return ok ? `<a href="${esc(t.href)}" target="_blank" rel="noreferrer">${esc(t.text)}</a>` : esc(t.text);
    },
    image(token) { return esc((token as { text: string }).text || ''); },
  },
});

// A citation is [m:ss], [m:ss–m:ss], or several of those separated by commas: [1:58–3:59, 10:06].
const T = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
const ONE = new RegExp(String.raw`^(${T})(?:\s*[–—-]\s*(${T}))?$`);
const REF = new RegExp(String.raw`\[(${T}(?:\s*[–—-]\s*${T})?(?:\s*[,;，、]\s*${T}(?:\s*[–—-]\s*${T})?)*)\]`, 'g');

function refButton(part: string): string {
  const m = part.trim().match(ONE);
  if (!m) return part;
  const t = parseT(m[1]);
  const t2 = m[2] ? parseT(m[2]) : null;
  if (t == null) return part;
  return `<button class="ref" data-t="${t}"${t2 != null ? ` data-t2="${t2}"` : ''} title="${tr('Show in transcript')}">${m[2] ? `${m[1]}–${m[2]}` : m[1]}</button>`;
}

/** Markdown → safe HTML with clickable transcript references. */
export function renderMd(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  // Only touch text outside tags.
  return html.replace(/(^|>)([^<]+)(?=<|$)/g, (_m, lead: string, text: string) => lead + text.replace(REF, (_all, inner: string) => inner.split(/\s*[,;，、]\s*/).map(refButton).join(' ')));
}

const TYPE_LABEL: Record<string, string> = { lab_meeting: msg('Lab meeting'), advisor: msg('Advisor 1:1'), lecture: msg('Lecture'), wip: msg('WIP / seminar'), other: msg('Other') };
export const typeLabel = (id: string): string => {
  const option = (getState().settings?.sessionTypes ?? DEFAULT_SESSION_TYPES).find((o) => o.id === id);
  const original = DEFAULT_SESSION_TYPES.find((o) => o.id === id);
  return option && option.name !== original?.name ? option.name : Object.hasOwn(TYPE_LABEL, id) ? tr(TYPE_LABEL[id]) : option?.name ?? id;
};
const SOURCE_LABEL: Record<string, string> = { mic: msg('Microphone'), system: msg('Computer audio'), both: msg('Mic + computer'), file: msg('Audio file (test)') };
export const sourceLabel = (src: string): string => (SOURCE_LABEL[src] ? tr(SOURCE_LABEL[src]) : src);
