import { useEffect, useMemo, useRef, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { ask, cancelOutput, explain, refreshOutput, submitQuestion } from '../actions.ts';
import { fmtClock, fmtT, parseT } from '../util.ts';
import { msg, plural, t } from '../i18n.ts';
import { DEPTH_LABEL } from './TopBar.tsx';
import { Markdown } from './Markdown.tsx';
import { focusTime } from './Transcript.tsx';
import type { Depth, Effort, Output } from '../types.ts';
import { ProjectContextNote, ProjectContextSources, ProjectContextToggle } from './ProjectContext.tsx';
import { splitCategory, type QuestionCategory } from '../../../shared/question-category.ts';
import { onEnter } from '../keys.ts';

const EFFORT_LABEL: Record<string, string> = { auto: msg('Auto'), low: msg('Low'), medium: msg('Medium'), high: msg('High'), xhigh: msg('Extra high'), max: msg('Max') };

const QUICK = [
  msg('What are they discussing right now?'),
  msg('Explain the background needed to follow this argument.'),
  msg('Why are they using this method?'),
  msg('How does this relate to deep learning or regulatory genomics?'),
  msg('Explain the statistical assumptions.'),
  msg('How does this connect to the earlier discussion?'),
];

const PROVIDER_SHORT: Record<string, string> = { codex: msg('ChatGPT plan'), 'claude-cli': msg('Claude plan'), 'anthropic-api': msg('Anthropic API (paid)'), mock: msg('offline test stub'), local: msg('local') };
const SCOPE_LABEL: Record<string, string> = { all: msg('session so far'), '5m': msg('last 5 min'), '2m': msg('last 2 min') };

function title(o: Output): string {
  switch (o.kind) {
    case 'catchup': return `${t('Catch-up')} · ${t(SCOPE_LABEL[o.scope ?? '2m'] ?? SCOPE_LABEL['2m'])}`;
    case 'answer': return o.question ?? t('Question');
    case 'explain': return t('Explain: {term}', { term: o.question ?? '' });
    case 'auto_explain': return o.question ?? t('Background');
    case 'final_summary': return t('Final summary');
    case 'overview': return t('Recap');
    default: return o.kind;
  }
}

/** Colour stripe of a card: what the meeting discussed, a tangent beyond it, background, or the summary. */
type Stripe = QuestionCategory | 'background' | 'summary';
const CATEGORY_TAG: Record<QuestionCategory, { label: string; tip: string }> = {
  meeting: { label: msg('Meeting'), tip: msg('Chumi classified this question as about the meeting discussion') },
  tangent: { label: msg('Tangent'), tip: msg('Chumi classified this question as going beyond the meeting discussion') },
};

/** Filter chips above the cards, one per stripe colour. */
const FILTERS: Array<{ key: Stripe; label: string; tip: string }> = [
  { key: 'meeting', label: msg('Meeting'), tip: msg('Catch-ups and questions about the meeting discussion') },
  { key: 'tangent', label: msg('Tangent'), tip: msg('Questions that go beyond the meeting discussion') },
  { key: 'background', label: msg('Background'), tip: msg('Explanations and automatic background cards') },
  { key: 'summary', label: msg('Summary'), tip: msg('The final summary') },
];

function stripeOf(o: Output, category: QuestionCategory | null): Stripe | null {
  switch (o.kind) {
    case 'answer': return category;
    case 'catchup': return 'meeting';
    case 'explain': case 'auto_explain': return 'background';
    case 'final_summary': return 'summary';
    default: return null;
  }
}

function OutputCard({ o, depth, open, onToggle }: { o: Output; depth: Depth; open: boolean; onToggle: () => void }) {
  const delta = useStore((s) => s.deltas[o.id]);
  const streamed = o.kind === 'answer' && o.status !== 'done' ? splitCategory(delta ?? '', true) : null;
  const body = o.status === 'done' ? o.content ?? '' : streamed ? streamed.body : delta ?? '';
  const category: QuestionCategory | null = o.data?.category ?? streamed?.category ?? null;
  const stripe = stripeOf(o, category);
  const busy = o.status === 'pending' || o.status === 'streaming';
  const auto = o.kind === 'auto_explain';
  const invalid = (o.data?.refCheck?.invalid as string[] | undefined) ?? [];
  const evidenceT = auto ? (o.covered_from ?? parseT(o.data?.evidence_time ?? '') ?? null) : null;
  // The meeting time it was asked at (or, for background cards, where the term came up); else the clock time.
  const at: number | null = typeof o.data?.askedT === 'number' ? o.data.askedT : evidenceT;
  return (
    <article className={`card card-${o.kind} status-${o.status}${stripe ? ` stripe-${stripe}` : ''}${open ? ' open' : ''}`} aria-busy={busy}>
      <header className="card-head" onClick={onToggle}>
        {at != null
          ? <button className="card-time range" title={t(auto ? msg('Came up at {t}. Click to show the transcript there.') : msg('Asked at {t} in the meeting. Click to show the transcript there.'), { t: fmtT(at) })} onClick={(e) => { e.stopPropagation(); focusTime(at); }}>{fmtT(at)}</button>
          : <span className="card-time muted" title={t('Asked at {clock}', { clock: fmtClock(o.created_at) })}>{fmtClock(o.created_at)}</span>}
        <button className="card-toggle" aria-expanded={open}>
          <span className="card-chev" aria-hidden="true">▸</span>
          {category && <span className={`tag tag-${category}`} title={t(CATEGORY_TAG[category].tip)}>{t(CATEGORY_TAG[category].label)}</span>}
          {auto && <span className="tag">{t('Background')}</span>}
          {o.kind === 'final_summary' && <span className="tag tag-summary">{t('Summary')}</span>}
          {o.stale_reason === 'speaker_labels_changed' && <span className="tag tag-warn">{t('Speaker labels changed')}</span>}
          <span className="card-title">{title(o)}</span>
        </button>
        {busy && !open && <span className="spinner" aria-label={t('Thinking…')} />}
        {o.status === 'error' && !open && <span className="tag tag-warn">{t('Failed')}</span>}
        {open && o.depth && o.kind !== 'catchup' && <span className="tag tag-depth">{t(DEPTH_LABEL[o.depth as Depth] ?? o.depth)}</span>}
        {open && o.data?.effort && !['auto_explain', 'overview'].includes(o.kind) && <span className="tag tag-depth" title={t('Reasoning effort used')}>{EFFORT_LABEL[o.data.effort] ? t(EFFORT_LABEL[o.data.effort]) : o.data.effort}</span>}
      </header>
      {open && (
        <>
          <div className="card-meta">
            {o.covered_from != null && o.covered_to != null && !auto && (
              <button className="range" title={t('Transcript interval this answer covers. Click to show it.')} onClick={() => focusTime(o.covered_from!, o.covered_to!)}>
                {t('Covers {from}–{to}', { from: fmtT(o.covered_from), to: fmtT(o.covered_to) })}
              </button>
            )}
            {o.selection && <button className="range" onClick={() => focusTime(o.selection!.fromT, o.selection!.toT)}>{t('Selection {t}', { t: fmtT(o.selection.fromT) })}</button>}
            {at != null && <span className="muted">{fmtClock(o.created_at)}</span>}
            {Array.isArray(o.data?.images) && o.data!.images.length > 0 && (
              <button className="range" title={t('Screen captures sent with this request')} onClick={() => setState({ dialog: 'frame', frameView: o.data!.images[0].id })}>▣ {plural(o.data!.images.length, '{n} screen capture', '{n} screen captures')}</button>
            )}
            {o.provider && <span className="muted" title={`${o.model ?? ''} · ${o.billing ?? ''}`}>{PROVIDER_SHORT[o.provider] ? t(PROVIDER_SHORT[o.provider]) : o.provider}{o.billing === 'subscription' ? ` · ${t('subscription')}` : o.billing === 'api' ? ` · ${t('billed')}` : ''}</span>}
          </div>
          <ProjectContextSources o={o} />
          {o.stale_reason === 'speaker_labels_changed' && <p className="small warn-text">{t('This answer used older speaker labels or names. Regenerate it to use the current corrections.')}</p>}
          {auto && o.data?.why && <p className="why muted">{o.data.why}</p>}
          {o.status === 'pending' && <div className="pending"><span className="spinner" /> {t('Waiting for the AI provider…')}</div>}
          {(o.status === 'streaming' || o.status === 'done') && body && <Markdown text={body} />}
          {o.status === 'streaming' && !body && <div className="pending"><span className="spinner" /> {t('Thinking…')}</div>}
          {o.status === 'error' && <div className="error-box">{o.error}</div>}
          {o.status === 'cancelled' && <div className="muted small">{t('Cancelled.')}</div>}
          {invalid.length > 0 && <div className="muted small warn-text">{t(invalid.length === 1 ? msg('Note: {n} cited time ({list}) did not match any transcript line.') : msg('Note: {n} cited times ({list}) did not match any transcript line.'), { n: invalid.length, list: invalid.slice(0, 3).join(', ') })}</div>}
          <div className="card-actions">
            {(o.status === 'pending' || o.status === 'streaming') && <button className="btn small" onClick={() => cancelOutput(o.id)}>{t('Cancel')}</button>}
            {o.status === 'done' && (o.stale_reason === 'speaker_labels_changed' || o.kind === 'catchup' || o.kind === 'final_summary') && <button className="btn small" onClick={() => refreshOutput(o.id)} title={t('Re-run up to the current moment')}>{o.stale_reason === 'speaker_labels_changed' ? t('Regenerate with current speakers') : t('Refresh')}</button>}
            {auto && o.status === 'done' && (
              <>
                <button className="btn small" onClick={() => explain(o.question ?? '', evidenceT != null ? { fromT: evidenceT, toT: evidenceT + 5000, text: o.question ?? '' } : null, depth === 'quick' ? 'standard' : depth, o.id)}>{t('Explain more')}</button>
                <button className="btn small" onClick={() => explain(o.question ?? '', evidenceT != null ? { fromT: evidenceT, toT: evidenceT + 5000, text: o.question ?? '' } : null, 'deep', o.id)}>{t('Deep dive')}</button>
              </>
            )}
            {o.status === 'done' && (o.kind === 'answer' || o.kind === 'explain') && o.depth !== 'deep' && <button className="btn small" onClick={() => (o.kind === 'explain' ? explain(o.question ?? '', o.selection, 'deep', o.id) : ask(o.question ?? '', o.selection, 'deep'))}>{t('Go deeper')}</button>}
            {(o.status === 'error') && <button className="btn small" onClick={() => refreshOutput(o.id)}>{t('Retry')}</button>}
            {o.status === 'done' && body && <button className="btn small ghost" onClick={() => void navigator.clipboard?.writeText(body)}>{t('Copy')}</button>}
          </div>
        </>
      )}
    </article>
  );
}

function AskBox() {
  const attached = useStore((s) => s.attached);
  const draft = useStore((s) => s.askDraft);
  const defaultDepth = useStore((s) => s.settings?.assist.defaultDepth ?? 'standard');
  const defaultEffort = useStore((s) => s.settings?.ai.effort ?? 'auto');
  const supportsEffort = useStore((s) => s.settings?.ai.provider !== 'compatible');
  const [depth, setDepth] = useState<Depth>(defaultDepth);
  const [effort, setEffort] = useState<Effort>(defaultEffort);
  const [showAll, setShowAll] = useState(false);
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  useEffect(() => setDepth(defaultDepth), [defaultDepth]);
  useEffect(() => setEffort(defaultEffort), [defaultEffort]);
  const send = async (q: string, mode: 'ask' | 'explain' = 'ask', requestedDepth = depth) => {
    const text = q.trim();
    if (pending.current || (!text && !attached)) return;
    const requestedEffort = supportsEffort ? effort : undefined;
    pending.current = true; setSending(true);
    try {
      const result = await submitQuestion(q, mode, requestedDepth, requestedEffort);
      if (result.cleared) {
        setDepth((now) => now === depth ? defaultDepth : now);
        setEffort((now) => now === effort ? defaultEffort : now);
      }
    } finally { pending.current = false; setSending(false); }
  };
  return (
    <div className="askbox" aria-busy={sending}>
      {attached && (
        <div className="attached">
          <span className="muted">{t('About [{t}]:', { t: fmtT(attached.fromT) })}</span> <span className="attached-text">“{attached.text.slice(0, 140)}{attached.text.length > 140 ? '…' : ''}”</span>
          <button className="link-btn" onClick={() => setState({ attached: null })} aria-label={t('Remove attached passage')}>✕</button>
        </div>
      )}
      <textarea id="ask-input" rows={2} placeholder={attached ? t('Ask about the selected passage… (Enter to send)') : t('Ask anything about the discussion… (Enter to send, Shift+Enter for newline)')}
        value={draft} onChange={(e) => setState({ askDraft: e.target.value })}
        onKeyDown={onEnter(() => send(draft))} />
      <div className="ask-row">
        <div className="ask-options">
          <div className="seg-control small" role="group" aria-label={t('Depth for this question')}>
            {(['quick', 'standard', 'deep'] as Depth[]).map((d) => <button key={d} className={depth === d ? 'on' : ''} onClick={() => setDepth(d)}>{t(DEPTH_LABEL[d])}</button>)}
          </div>
          {supportsEffort && <select className="effort-select" value={effort} onChange={(e) => setEffort(e.target.value as Effort)} title={t('Reasoning effort for this question: higher is more thorough but slower and uses more of your plan')} aria-label={t('Reasoning effort')}>
            {(['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((x) => <option key={x} value={x}>{t('Effort: {level}', { level: t(EFFORT_LABEL[x]) })}</option>)}
          </select>}
          <ProjectContextToggle />
        </div>
        <div className="ask-actions">
          <button className="btn small" disabled={sending} onClick={() => void send(draft, 'explain')} title={t('Explain the typed term (or the attached passage)')}>{t('Explain')}</button>
          <button className="btn small primary" disabled={sending} onClick={() => void send(draft)}>{t('Ask')}</button>
        </div>
      </div>
      <ProjectContextNote />
      <div className="chips">
        {(showAll ? QUICK : QUICK.slice(0, 3)).map((q) => <button key={q} className="chip" disabled={sending} onClick={() => void send(t(q))}>{t(q)}</button>)}
        {showAll && <button className="chip" disabled={sending} onClick={() => void send(t('Give me the short version first: what is the key point right now?'), 'ask', 'quick')}>{t('Give me the short version first')}</button>}
        <button className="chip chip-more" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>{showAll ? t('Fewer') : t('More suggestions ({n})', { n: QUICK.length - 2 })}</button>
      </div>
    </div>
  );
}

export function AssistantPanel() {
  const data = useStore((s) => s.data);
  const depth = useStore((s) => s.settings?.assist.defaultDepth ?? 'standard');
  const hidden = useStore((s) => s.hiddenCards);
  const cards = useMemo(() => {
    if (!data) return [];
    const outs = data.outputs.filter((o) => ['catchup', 'answer', 'explain', 'auto_explain', 'final_summary'].includes(o.kind));
    const superseded = new Set(outs.filter((o) => o.parent_id && o.status !== 'error' && o.kind !== 'explain').map((o) => o.parent_id!));
    const visible = outs.filter((o) => !superseded.has(o.id)).sort((a, b) => b.created_at - a.created_at);
    const summary = visible.find((o) => o.kind === 'final_summary');
    return summary ? [summary, ...visible.filter((o) => o.id !== summary.id && o.kind !== 'final_summary')] : visible;
  }, [data?.outputs]);
  // Like an agent chat: the latest card you asked for stays open and earlier ones fold to their title row.
  // Background cards arrive on their own, so they never take the open slot from your own question.
  const currentId = useMemo(() => {
    const asked = cards.filter((o) => o.kind !== 'auto_explain');
    return (asked.length ? asked.reduce((a, b) => (b.created_at > a.created_at ? b : a)) : cards[0])?.id ?? null;
  }, [cards]);
  // Cards opened or closed by hand; forgotten once a newer card becomes the current one.
  const [manual, setManual] = useState<{ current: string | null; open: Record<string, boolean> }>({ current: null, open: {} });
  const overrides = manual.current === currentId ? manual.open : {};
  const isOpen = (id: string) => overrides[id] ?? id === currentId;
  if (!data) return <aside className="assistant"><p className="muted pad">{t('No session open.')}</p></aside>;
  // The filter never hides the card you just asked for or one still being written, so a new answer cannot vanish.
  const stripes = new Map(cards.map((o) => [o.id, stripeOf(o, o.data?.category ?? null)]));
  const counts = new Map<Stripe, number>();
  for (const k of stripes.values()) if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  const shown = cards.filter((o) => o.id === currentId || o.status === 'pending' || o.status === 'streaming' || !hidden.includes(stripes.get(o.id) ?? ''));
  const toggle = (k: Stripe) => setState({ hiddenCards: hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k] });
  return (
    <aside className="assistant" aria-label={t('Assistant')}>
      <AskBox />
      {cards.length > 0 && (
        <div className="card-filter" role="group" aria-label={t('Show cards by tag')}>
          {FILTERS.filter((f) => counts.has(f.key) || hidden.includes(f.key)).map((f) => (
            <button key={f.key} className={`filter-chip chip-${f.key}`} aria-pressed={!hidden.includes(f.key)} title={t(f.tip)} onClick={() => toggle(f.key)}>
              <span className="dot" aria-hidden="true" />{t(f.label)}<span className="count">{counts.get(f.key) ?? 0}</span>
            </button>
          ))}
          {shown.length < cards.length && <button className="link-btn small" onClick={() => setState({ hiddenCards: [] })}>{t('{n} hidden · Show all', { n: cards.length - shown.length })}</button>}
        </div>
      )}
      <div className="cards">
        {cards.length === 0 && <p className="muted pad small">{t('Answers, catch-ups and background cards appear here. They stay put while the transcript keeps moving. Use Refresh to update a catch-up.')}</p>}
        {shown.map((o) => <OutputCard key={o.id} o={o} depth={depth} open={isOpen(o.id)} onToggle={() => setManual({ current: currentId, open: { ...overrides, [o.id]: !isOpen(o.id) } })} />)}
      </div>
    </aside>
  );
}
