import { useEffect, useMemo, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { ask, cancelOutput, catchup, explain, refreshOutput, summarize } from '../actions.ts';
import { fmtClock, fmtT, parseT } from '../util.ts';
import { Markdown } from './Markdown.tsx';
import { focusTime } from './Transcript.tsx';
import type { Depth, Effort, Output } from '../types.ts';

const EFFORT_LABEL: Record<string, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

const QUICK = [
  'What are they discussing right now?',
  'Explain the background needed to follow this argument.',
  'Why are they using this method?',
  'How does this relate to deep learning or regulatory genomics?',
  'Explain the statistical assumptions.',
  'How does this connect to the earlier discussion?',
];

const PROVIDER_SHORT: Record<string, string> = { codex: 'ChatGPT plan', 'claude-cli': 'Claude plan', 'anthropic-api': 'Anthropic API (paid)', mock: 'offline test stub', local: 'local' };

function title(o: Output): string {
  switch (o.kind) {
    case 'catchup': return `Catch-up · ${o.scope === 'all' ? 'session so far' : o.scope === '5m' ? 'last 5 min' : 'last 2 min'}`;
    case 'answer': return o.question ?? 'Question';
    case 'explain': return `Explain: ${o.question}`;
    case 'auto_explain': return o.question ?? 'Background';
    case 'final_summary': return 'Final summary';
    case 'overview': return 'Recap';
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
        {auto && <span className="tag">Background</span>}
        {o.kind === 'final_summary' && <span className="tag tag-summary">Summary</span>}
        <span className="card-title">{title(o)}</span>
        {o.depth && o.kind !== 'catchup' && <span className="tag tag-depth">{o.depth}</span>}
        {o.data?.effort && !['auto_explain', 'overview'].includes(o.kind) && <span className="tag tag-depth" title="Reasoning effort used">{EFFORT_LABEL[o.data.effort] ?? o.data.effort}</span>}
      </header>
      {!collapsed && (
        <>
          <div className="card-meta">
            {o.covered_from != null && o.covered_to != null && !auto && (
              <button className="range" title="Transcript interval this answer covers — click to show" onClick={() => focusTime(o.covered_from!, o.covered_to!)}>
                Covers {fmtT(o.covered_from)}–{fmtT(o.covered_to)}
              </button>
            )}
            {o.selection && <button className="range" onClick={() => focusTime(o.selection!.fromT, o.selection!.toT)}>Selection {fmtT(o.selection.fromT)}</button>}
            {auto && evidenceT != null && <button className="range" onClick={() => focusTime(evidenceT)}>at {fmtT(evidenceT)}</button>}
            <span className="muted">{fmtClock(o.created_at)}</span>
            {Array.isArray(o.data?.images) && o.data!.images.length > 0 && (
              <button className="range" title="Screen captures sent with this request" onClick={() => setState({ dialog: 'frame', frameView: o.data!.images[0].id })}>▣ {o.data!.images.length} screen capture{o.data!.images.length > 1 ? 's' : ''}</button>
            )}
            {o.provider && <span className="muted" title={`${o.model ?? ''} · ${o.billing ?? ''}`}>{PROVIDER_SHORT[o.provider] ?? o.provider}{o.billing === 'subscription' ? ' · subscription' : o.billing === 'api' ? ' · billed' : ''}</span>}
          </div>
          {auto && o.data?.why && <p className="why muted">{o.data.why}</p>}
          {o.status === 'pending' && <div className="pending"><span className="spinner" /> Waiting for the AI provider…</div>}
          {(o.status === 'streaming' || o.status === 'done') && body && <Markdown text={body} />}
          {o.status === 'streaming' && !body && <div className="pending"><span className="spinner" /> Thinking…</div>}
          {o.status === 'error' && <div className="error-box">{o.error}</div>}
          {o.status === 'cancelled' && <div className="muted small">Cancelled.</div>}
          {invalid.length > 0 && <div className="muted small warn-text">Note: {invalid.length} cited time{invalid.length > 1 ? 's' : ''} ({invalid.slice(0, 3).join(', ')}) did not match any transcript line.</div>}
          <div className="card-actions">
            {(o.status === 'pending' || o.status === 'streaming') && <button className="btn small" onClick={() => cancelOutput(o.id)}>Cancel</button>}
            {o.status === 'done' && (o.kind === 'catchup' || o.kind === 'final_summary') && <button className="btn small" onClick={() => refreshOutput(o.id)} title="Re-run up to the current moment">Refresh</button>}
            {auto && o.status === 'done' && (
              <>
                <button className="btn small" onClick={() => explain(o.question ?? '', evidenceT != null ? { fromT: evidenceT, toT: evidenceT + 5000, text: o.question ?? '' } : null, depth === 'quick' ? 'standard' : depth, o.id)}>Explain more</button>
                <button className="btn small" onClick={() => explain(o.question ?? '', evidenceT != null ? { fromT: evidenceT, toT: evidenceT + 5000, text: o.question ?? '' } : null, 'deep', o.id)}>Deep dive</button>
              </>
            )}
            {o.status === 'done' && (o.kind === 'answer' || o.kind === 'explain') && o.depth !== 'deep' && <button className="btn small" onClick={() => (o.kind === 'explain' ? explain(o.question ?? '', o.selection, 'deep', o.id) : ask(o.question ?? '', o.selection, 'deep'))}>Go deeper</button>}
            {(o.status === 'error') && <button className="btn small" onClick={() => refreshOutput(o.id)}>Retry</button>}
            {o.status === 'done' && body && <button className="btn small ghost" onClick={() => void navigator.clipboard?.writeText(body)}>Copy</button>}
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
    else ask(text || 'What does this passage mean?', attached, depth, [], effort);
    setState({ askDraft: '', attached: null });
    setDepth(defaultDepth); // one-off choices; they do not change settings or the profile
    setEffort(defaultEffort);
  };
  return (
    <div className="askbox">
      {attached && (
        <div className="attached">
          <span className="muted">About [{fmtT(attached.fromT)}]:</span> <span className="attached-text">“{attached.text.slice(0, 140)}{attached.text.length > 140 ? '…' : ''}”</span>
          <button className="link-btn" onClick={() => setState({ attached: null })} aria-label="Remove attached passage">✕</button>
        </div>
      )}
      <textarea id="ask-input" rows={2} placeholder={attached ? 'Ask about the selected passage… (Enter to send)' : 'Ask anything about the discussion… (Enter to send, Shift+Enter for newline)'}
        value={draft} onChange={(e) => setState({ askDraft: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft); } }} />
      <div className="ask-row">
        <div className="ask-options">
          <div className="seg-control small" role="group" aria-label="Depth for this question">
            {(['quick', 'standard', 'deep'] as Depth[]).map((d) => <button key={d} className={depth === d ? 'on' : ''} onClick={() => setDepth(d)}>{d === 'quick' ? 'Quick' : d === 'standard' ? 'Standard' : 'Deep'}</button>)}
          </div>
          <select className="effort-select" value={effort} onChange={(e) => setEffort(e.target.value as Effort)} title="Reasoning effort for this question: higher is more thorough but slower and uses more of your plan" aria-label="Reasoning effort">
            {(['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((x) => <option key={x} value={x}>{x === 'auto' ? 'Effort: Auto' : `Effort: ${EFFORT_LABEL[x]}`}</option>)}
          </select>
        </div>
        <div className="ask-actions">
          <button className="btn small" onClick={() => send(draft, 'explain')} title="Explain the typed term (or the attached passage)">Explain</button>
          <button className="btn small primary" onClick={() => send(draft)}>Ask</button>
        </div>
      </div>
      <div className="chips">
        {(showAll ? QUICK : QUICK.slice(0, 3)).map((q) => <button key={q} className="chip" onClick={() => send(q)}>{q}</button>)}
        {showAll && <button className="chip" onClick={() => ask('Give me the short version first: what is the key point right now?', attached, 'quick')}>Give me the short version first</button>}
        <button className="chip chip-more" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>{showAll ? 'Fewer' : `More suggestions (${QUICK.length - 2})`}</button>
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
  if (!data) return <aside className="assistant"><p className="muted pad">No session open.</p></aside>;
  const ended = data.session.status === 'ended' || data.session.status === 'interrupted';
  const hasSummary = data.outputs.some((o) => o.kind === 'final_summary' && o.status !== 'error');
  return (
    <aside className="assistant" aria-label="Assistant">
      <div className="catchup-box">
        <button className="btn catchup" onClick={() => catchup(scope)} disabled={!data.segments.length}>Catch me up</button>
        <div className="seg-control" role="group" aria-label="Catch-up scope">
          {([['2m', '2 min', 'The last 2 minutes'], ['5m', '5 min', 'The last 5 minutes'], ['all', 'So far', 'The whole session so far']] as const).map(([k, l, t]) => <button key={k} className={scope === k ? 'on' : ''} title={t} onClick={() => setScope(k)}>{l}</button>)}
        </div>
      </div>
      {!isLive && ended && !hasSummary && data.segments.length > 0 && <button className="btn small summary-btn" onClick={() => summarize()}>Generate final summary</button>}
      <AskBox />
      <div className="cards">
        {cards.length === 0 && <p className="muted pad small">Answers, catch-ups and background cards appear here. They stay put while the transcript keeps moving; use Refresh to update a catch-up.</p>}
        {cards.map((o) => <OutputCard key={o.id} o={o} depth={depth} />)}
      </div>
    </aside>
  );
}
