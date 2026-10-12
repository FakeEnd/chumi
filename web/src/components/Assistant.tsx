import { useEffect, useMemo, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { ask, cancelOutput, catchup, explain, refreshOutput, summarize } from '../actions.ts';
import { fmtClock, fmtT, parseT } from '../util.ts';
import { msg, plural, t } from '../i18n.ts';
import { DEPTH_LABEL } from './TopBar.tsx';
import { Markdown } from './Markdown.tsx';
import { focusTime } from './Transcript.tsx';
import type { Depth, Effort, Output } from '../types.ts';
import { HandoffBox } from './Handoff.tsx';
import { ProjectContextNote, ProjectContextSources, ProjectContextToggle } from './ProjectContext.tsx';

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

function OutputCard({ o, depth }: { o: Output; depth: Depth }) {
  const delta = useStore((s) => s.deltas[o.id]);
  const [collapsed, setCollapsed] = useState(false);
  const body = o.status === 'done' ? o.content ?? '' : delta ?? '';
  const auto = o.kind === 'auto_explain';
  const invalid = (o.data?.refCheck?.invalid as string[] | undefined) ?? [];
  const evidenceT = auto ? (o.covered_from ?? parseT(o.data?.evidence_time ?? '') ?? null) : null;
  return (
    <article className={`card card-${o.kind} status-${o.status}`} aria-busy={o.status === 'pending' || o.status === 'streaming'}>
      <header className="card-head" onClick={() => setCollapsed(!collapsed)}>
        {auto && <span className="tag">{t('Background')}</span>}
        {o.kind === 'final_summary' && <span className="tag tag-summary">{t('Summary')}</span>}
        <span className="card-title">{title(o)}</span>
        {o.depth && o.kind !== 'catchup' && <span className="tag tag-depth">{t(DEPTH_LABEL[o.depth as Depth] ?? o.depth)}</span>}
        {o.data?.effort && !['auto_explain', 'overview'].includes(o.kind) && <span className="tag tag-depth" title={t('Reasoning effort used')}>{EFFORT_LABEL[o.data.effort] ? t(EFFORT_LABEL[o.data.effort]) : o.data.effort}</span>}
      </header>
      {!collapsed && (
        <>
          <div className="card-meta">
            {o.covered_from != null && o.covered_to != null && !auto && (
              <button className="range" title={t('Transcript interval this answer covers. Click to show it.')} onClick={() => focusTime(o.covered_from!, o.covered_to!)}>
                {t('Covers {from}–{to}', { from: fmtT(o.covered_from), to: fmtT(o.covered_to) })}
              </button>
            )}
            {o.selection && <button className="range" onClick={() => focusTime(o.selection!.fromT, o.selection!.toT)}>{t('Selection {t}', { t: fmtT(o.selection.fromT) })}</button>}
            {auto && evidenceT != null && <button className="range" onClick={() => focusTime(evidenceT)}>{t('at {t}', { t: fmtT(evidenceT) })}</button>}
            <span className="muted">{fmtClock(o.created_at)}</span>
            {Array.isArray(o.data?.images) && o.data!.images.length > 0 && (
              <button className="range" title={t('Screen captures sent with this request')} onClick={() => setState({ dialog: 'frame', frameView: o.data!.images[0].id })}>▣ {plural(o.data!.images.length, '{n} screen capture', '{n} screen captures')}</button>
            )}
            {o.provider && <span className="muted" title={`${o.model ?? ''} · ${o.billing ?? ''}`}>{PROVIDER_SHORT[o.provider] ? t(PROVIDER_SHORT[o.provider]) : o.provider}{o.billing === 'subscription' ? ` · ${t('subscription')}` : o.billing === 'api' ? ` · ${t('billed')}` : ''}</span>}
          </div>
          <ProjectContextSources o={o} />
          {auto && o.data?.why && <p className="why muted">{o.data.why}</p>}
          {o.status === 'pending' && <div className="pending"><span className="spinner" /> {t('Waiting for the AI provider…')}</div>}
          {(o.status === 'streaming' || o.status === 'done') && body && <Markdown text={body} />}
          {o.status === 'streaming' && !body && <div className="pending"><span className="spinner" /> {t('Thinking…')}</div>}
          {o.status === 'error' && <div className="error-box">{o.error}</div>}
          {o.status === 'cancelled' && <div className="muted small">{t('Cancelled.')}</div>}
          {invalid.length > 0 && <div className="muted small warn-text">{t(invalid.length === 1 ? msg('Note: {n} cited time ({list}) did not match any transcript line.') : msg('Note: {n} cited times ({list}) did not match any transcript line.'), { n: invalid.length, list: invalid.slice(0, 3).join(', ') })}</div>}
          <div className="card-actions">
            {(o.status === 'pending' || o.status === 'streaming') && <button className="btn small" onClick={() => cancelOutput(o.id)}>{t('Cancel')}</button>}
            {o.status === 'done' && (o.kind === 'catchup' || o.kind === 'final_summary') && <button className="btn small" onClick={() => refreshOutput(o.id)} title={t('Re-run up to the current moment')}>{t('Refresh')}</button>}
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
  const [depth, setDepth] = useState<Depth>(defaultDepth);
  const [effort, setEffort] = useState<Effort>(defaultEffort);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setDepth(defaultDepth), [defaultDepth]);
  useEffect(() => setEffort(defaultEffort), [defaultEffort]);
  const send = (q: string, mode: 'ask' | 'explain' = 'ask') => {
    const text = q.trim();
    if (!text && !attached) return;
    if (mode === 'explain') explain(text || attached!.text.slice(0, 80), attached, depth, undefined, effort);
    else ask(text || t('What does this passage mean?'), attached, depth, [], effort);
    setState({ askDraft: '', attached: null });
    setDepth(defaultDepth); // one-off choices; they do not change settings or the profile
    setEffort(defaultEffort);
  };
  return (
    <div className="askbox">
      {attached && (
        <div className="attached">
          <span className="muted">{t('About [{t}]:', { t: fmtT(attached.fromT) })}</span> <span className="attached-text">“{attached.text.slice(0, 140)}{attached.text.length > 140 ? '…' : ''}”</span>
          <button className="link-btn" onClick={() => setState({ attached: null })} aria-label={t('Remove attached passage')}>✕</button>
        </div>
      )}
      <textarea id="ask-input" rows={2} placeholder={attached ? t('Ask about the selected passage… (Enter to send)') : t('Ask anything about the discussion… (Enter to send, Shift+Enter for newline)')}
        value={draft} onChange={(e) => setState({ askDraft: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft); } }} />
      <div className="ask-row">
        <div className="ask-options">
          <div className="seg-control small" role="group" aria-label={t('Depth for this question')}>
            {(['quick', 'standard', 'deep'] as Depth[]).map((d) => <button key={d} className={depth === d ? 'on' : ''} onClick={() => setDepth(d)}>{t(DEPTH_LABEL[d])}</button>)}
          </div>
          <select className="effort-select" value={effort} onChange={(e) => setEffort(e.target.value as Effort)} title={t('Reasoning effort for this question: higher is more thorough but slower and uses more of your plan')} aria-label={t('Reasoning effort')}>
            {(['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((x) => <option key={x} value={x}>{t('Effort: {level}', { level: t(EFFORT_LABEL[x]) })}</option>)}
          </select>
          <ProjectContextToggle />
        </div>
        <div className="ask-actions">
          <button className="btn small" onClick={() => send(draft, 'explain')} title={t('Explain the typed term (or the attached passage)')}>{t('Explain')}</button>
          <button className="btn small primary" onClick={() => send(draft)}>{t('Ask')}</button>
        </div>
      </div>
      <ProjectContextNote />
      <div className="chips">
        {(showAll ? QUICK : QUICK.slice(0, 3)).map((q) => <button key={q} className="chip" onClick={() => send(t(q))}>{t(q)}</button>)}
        {showAll && <button className="chip" onClick={() => ask(t('Give me the short version first: what is the key point right now?'), attached, 'quick')}>{t('Give me the short version first')}</button>}
        <button className="chip chip-more" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>{showAll ? t('Fewer') : t('More suggestions ({n})', { n: QUICK.length - 2 })}</button>
      </div>
    </div>
  );
}

export function AssistantPanel() {
  const data = useStore((s) => s.data);
  const live = useStore((s) => s.live);
  const depth = useStore((s) => s.settings?.assist.defaultDepth ?? 'standard');
  const [scope, setScope] = useState<'2m' | '5m' | 'all'>('2m');
  const isLive = !!data && live?.session?.id === data.session.id;
  const cards = useMemo(() => {
    if (!data) return [];
    const outs = data.outputs.filter((o) => ['catchup', 'answer', 'explain', 'auto_explain', 'final_summary'].includes(o.kind));
    const superseded = new Set(outs.filter((o) => o.parent_id && o.status !== 'error' && o.kind !== 'explain').map((o) => o.parent_id!));
    const visible = outs.filter((o) => !superseded.has(o.id)).sort((a, b) => b.created_at - a.created_at);
    const summary = visible.find((o) => o.kind === 'final_summary');
    return summary ? [summary, ...visible.filter((o) => o.id !== summary.id && o.kind !== 'final_summary')] : visible;
  }, [data?.outputs]);
  if (!data) return <aside className="assistant"><p className="muted pad">{t('No session open.')}</p></aside>;
  const ended = data.session.status === 'ended' || data.session.status === 'interrupted';
  const hasSummary = data.outputs.some((o) => o.kind === 'final_summary' && o.status !== 'error');
  return (
    <aside className="assistant" aria-label={t('Assistant')}>
      <div className="catchup-box">
        <button className="btn catchup" onClick={() => catchup(scope)} disabled={!data.segments.length}>{t('Catch me up')}</button>
        <div className="seg-control" role="group" aria-label={t('Catch-up scope')}>
          {([['2m', msg('2 min'), msg('The last 2 minutes')], ['5m', msg('5 min'), msg('The last 5 minutes')], ['all', msg('So far'), msg('The whole session so far')]] as const).map(([k, l, tip]) => <button key={k} className={scope === k ? 'on' : ''} title={t(tip)} onClick={() => setScope(k)}>{t(l)}</button>)}
        </div>
      </div>
      {!isLive && ended && !hasSummary && data.segments.length > 0 && <button className="btn small summary-btn" onClick={() => summarize()}>{t('Generate final summary')}</button>}
      <HandoffBox />
      <AskBox />
      <div className="cards">
        {cards.length === 0 && <p className="muted pad small">{t('Answers, catch-ups and background cards appear here. They stay put while the transcript keeps moving. Use Refresh to update a catch-up.')}</p>}
        {cards.map((o) => <OutputCard key={o.id} o={o} depth={depth} />)}
      </div>
    </aside>
  );
}
