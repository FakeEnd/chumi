import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getState, setState, useStore } from '../store.ts';
import { explain, frameUrl } from '../actions.ts';
import { fmtT } from '../util.ts';
import type { Frame, Segment, TimelineEvent } from '../types.ts';

type Item = { kind: 'seg'; seg: Segment } | { kind: 'mark'; ev: TimelineEvent } | { kind: 'frame'; f: Frame };

const MARK_TEXT: Record<string, (e: TimelineEvent) => string> = {
  pause: (e) => `Paused at ${fmtT(e.t)}`,
  resume: (e) => `Resumed at ${fmtT(e.t)}`,
  gap: (e) => `Recording gap — ${e.detail ?? `at ${fmtT(e.t)}`}`,
  interrupted: (e) => `Recording interrupted at ${fmtT(e.t)} — ${e.detail ?? ''}`,
  error: (e) => `Error at ${fmtT(e.t)}: ${e.detail ?? ''}`,
  window: (e) => `${e.detail ?? 'Window capture'} (from ${fmtT(e.t)})`,
};

const Row = memo(function Row({ seg, hl, showSource }: { seg: Segment; hl: boolean; showSource: boolean }) {
  return (
    <div className={`seg${hl ? ' hl' : ''}`} data-seg="" data-t={seg.t_start} data-tend={seg.t_end} lang={seg.lang === 'zh' ? 'zh-CN' : seg.lang ?? undefined}>
      <button className="ts" title="Attach this line to a question" onClick={() => setState({ attached: { fromT: seg.t_start, toT: seg.t_end, text: seg.text } })}>{fmtT(seg.t_start)}</button>
      <span className="txt">{showSource && seg.source === 'system' && <span className="src-tag">computer</span>}{seg.text}</span>
    </div>
  );
});

export function Transcript() {
  const data = useStore((s) => s.data);
  const live = useStore((s) => s.live);
  const partials = useStore((s) => s.partials);
  const focus = useStore((s) => s.focus);
  const defaultDepth = useStore((s) => s.settings?.assist.defaultDepth ?? 'standard');
  const isLive = !!data && live?.session?.id === data.session.id;
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [hl, setHl] = useState<Set<number>>(new Set());
  const [toolbar, setToolbar] = useState<null | { x: number; y: number; fromT: number; toT: number; text: string }>(null);
  const lastTop = useRef(0);
  const lastCount = useRef(0);

  const items: Item[] = useMemo(() => {
    if (!data) return [];
    const marks = data.timeline.filter((e) => MARK_TEXT[e.kind]).map((ev) => ({ kind: 'mark' as const, ev }));
    const segs = data.segments.map((seg) => ({ kind: 'seg' as const, seg }));
    const frames = (data.frames ?? []).filter((f) => f.kind === 'slide').map((f) => ({ kind: 'frame' as const, f }));
    const at = (x: Item) => (x.kind === 'seg' ? x.seg.t_start : x.kind === 'mark' ? x.ev.t : x.f.t);
    return [...segs, ...marks, ...frames].sort((a, b) => at(a) - at(b));
  }, [data?.segments, data?.timeline, data?.frames]);

  const showSource = data?.session.audio_source === 'both';
  const partialList = isLive ? Object.entries(partials) : [];

  const scrollToBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  // New content: follow when at the live edge, otherwise keep the reading position and count new lines.
  useLayoutEffect(() => {
    const n = data?.segments.length ?? 0;
    const added = n - lastCount.current;
    lastCount.current = n;
    if (follow) scrollToBottom();
    else if (added > 0 && added < 50) setNewCount((c) => c + added);
  }, [data?.segments.length, partials, follow, scrollToBottom]);

  useEffect(() => { setFollow(true); setNewCount(0); lastCount.current = data?.segments.length ?? 0; requestAnimationFrame(scrollToBottom); }, [data?.session.id]);

  const onScroll = () => {
    const el = scroller.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) { if (!follow) { setFollow(true); setNewCount(0); } }
    else if (el.scrollTop < lastTop.current - 4 && follow) setFollow(false);
    lastTop.current = el.scrollTop;
    if (toolbar) setToolbar(null);
  };

  // Jump to a referenced time (from an AI answer) and highlight the supporting lines.
  useEffect(() => {
    if (!focus || !data) return;
    const t2 = focus.t2 ?? focus.t + 8000;
    const ids = data.segments.filter((s) => s.t_end >= focus.t - 1500 && s.t_start <= t2 + 500).map((s) => s.id);
    const target = data.segments.find((s) => s.t_end >= focus.t - 1500) ?? data.segments[data.segments.length - 1];
    if (!target) return;
    setFollow(false);
    setHl(new Set(ids.length ? ids : [target.id]));
    const el = scroller.current?.querySelector(`[data-t="${target.t_start}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = setTimeout(() => setHl(new Set()), 6000);
    return () => clearTimeout(timer);
  }, [focus?.nonce]);

  const onMouseUp = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!sel || text.length < 2 || !sel.rangeCount) { setToolbar(null); return; }
    const segOf = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest('[data-seg]') as HTMLElement | null;
    const a = segOf(sel.anchorNode), b = segOf(sel.focusNode);
    if (!a || !b || !scroller.current?.contains(a)) { setToolbar(null); return; }
    const ts = [a, b].map((e) => Number(e.dataset.t)), te = [a, b].map((e) => Number(e.dataset.tend));
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const host = scroller.current.getBoundingClientRect();
    setToolbar({ x: Math.min(host.width - 260, Math.max(8, rect.left - host.left)), y: rect.top - host.top + scroller.current.scrollTop - 40, fromT: Math.min(...ts), toT: Math.max(...te), text: text.slice(0, 4000) });
  };

  const returnToLive = () => { setFollow(true); setNewCount(0); scrollToBottom(); };

  if (!data) return <div className="transcript empty-state"><p>Start a session or open one from History.</p></div>;

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={scroller} onScroll={onScroll} onMouseUp={onMouseUp} role="log" aria-live="off" aria-label="Transcript">
        {items.length === 0 && partialList.length === 0 && (
          <p className="empty-state">{isLive ? (live?.status === 'paused' ? 'Paused.' : 'Listening… the transcript appears here a second or two after speech.') : 'No transcript in this session.'}</p>
        )}
        {items.map((it) => it.kind === 'seg'
          ? <Row key={`s${it.seg.id}`} seg={it.seg} hl={hl.has(it.seg.id)} showSource={showSource} />
          : it.kind === 'frame'
            ? <button key={`f${it.f.id}`} className="frame-marker" onClick={() => setState({ dialog: 'frame', frameView: it.f.id })} title="Screen changed here — click to view">
                <span className="ts">{fmtT(it.f.t)}</span><img src={frameUrl(it.f.id)} alt="" loading="lazy" /><span className="muted small">Screen changed</span>
              </button>
            : <div key={`m${it.ev.id}`} className={`marker marker-${it.ev.kind}`}>{MARK_TEXT[it.ev.kind](it.ev)}</div>)}
        {partialList.map(([src, p]) => (
          <div key={`p-${src}`} className="seg partial" aria-hidden="true">
            <span className="ts">{fmtT(p.t)}</span>
            <span className="txt">{showSource && src === 'system' && <span className="src-tag">computer</span>}{p.text}<span className="dots"> …</span></span>
          </div>
        ))}
        {toolbar && (
          <div className="sel-toolbar" style={{ left: toolbar.x, top: Math.max(0, toolbar.y) }} onMouseDown={(e) => e.preventDefault()}>
            <button onClick={() => { explain(toolbar.text.length <= 80 ? toolbar.text : 'the selected passage', toolbar, defaultDepth); setToolbar(null); window.getSelection()?.removeAllRanges(); }}>Explain</button>
            <button onClick={() => { setState({ attached: { fromT: toolbar.fromT, toT: toolbar.toT, text: toolbar.text } }); setToolbar(null); document.getElementById('ask-input')?.focus(); }}>Ask about this…</button>
            <button onClick={() => { void navigator.clipboard?.writeText(`[${fmtT(toolbar.fromT)}] ${toolbar.text}`); setToolbar(null); }}>Copy</button>
          </div>
        )}
      </div>
      {!follow && (
        <button className="return-live" onClick={returnToLive}>
          {newCount > 0 ? `${newCount} new line${newCount === 1 ? '' : 's'} · ` : ''}{isLive ? 'Return to live ↓' : 'Jump to end ↓'}
        </button>
      )}
    </div>
  );
}

export function focusTime(t: number, t2?: number): void { setState({ focus: { t, t2, nonce: (getState().focus?.nonce ?? 0) + 1 } }); }
