import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getState, setState, useStore } from '../store.ts';
import { explain, frameUrl } from '../actions.ts';
import { fmtT } from '../util.ts';
import { msg, t } from '../i18n.ts';
import type { SpeakerView } from '../../../shared/speakers.ts';
import type { Frame, Segment, TimelineEvent } from '../types.ts';
import { SpeakerControl, SpeakersPanel } from './Speakers.tsx';
import { playFrom } from './AudioPlayer.tsx';
import { IconPlay } from './icons.tsx';

type Item = { kind: 'seg'; seg: Segment } | { kind: 'mark'; ev: TimelineEvent } | { kind: 'frame'; f: Frame };

const MARK_TEXT: Record<string, (e: TimelineEvent) => string> = {
  pause: (e) => t('Paused at {t}', { t: fmtT(e.t) }),
  resume: (e) => t('Resumed at {t}', { t: fmtT(e.t) }),
  gap: (e) => t('Recording gap: {detail}', { detail: e.detail ?? t('at {t}', { t: fmtT(e.t) }) }),
  interrupted: (e) => t('Recording interrupted at {t}. {detail}', { t: fmtT(e.t), detail: e.detail ?? '' }),
  error: (e) => t('Error at {t}: {detail}', { t: fmtT(e.t), detail: e.detail ?? '' }),
  window: (e) => t('{detail} (from {t})', { detail: e.detail ?? t('Window capture'), t: fmtT(e.t) }),
};

const Row = memo(function Row({ seg, hl, showSource, speakerView, playable, playing }: { seg: Segment; hl: boolean; showSource: boolean; speakerView?: SpeakerView; playable: boolean; playing: boolean }) {
  return (
    <div className={`seg${hl ? ' hl' : ''}${playing ? ' playing' : ''}`} data-seg="" data-id={seg.id} data-t={seg.t_start} data-tend={seg.t_end} lang={seg.lang === 'zh' ? 'zh-CN' : seg.lang ?? undefined}>
      {playable && <button className="play" title={t('Play from here')} aria-label={t('Play from {t}', { t: fmtT(seg.t_start) })} onClick={() => playFrom(seg.t_start)}><IconPlay width={10} height={10} /></button>}
      <button className="ts" title={t('Attach this line to a question')} onClick={() => setState({ attached: { fromT: seg.t_start, toT: seg.t_end, text: seg.text } })}>{fmtT(seg.t_start)}</button>
      <span className="txt">
        {showSource && seg.source === 'system' && <span className="src-tag">{t('computer')}</span>}
        {showSource && seg.speaker_state && seg.source === 'mic' && <span className="src-tag">{t('Microphone')}</span>}
        {speakerView && seg.speaker_state && <SpeakerControl segment={seg} view={speakerView} />}
        {seg.text}
      </span>
    </div>
  );
});

export function Transcript() {
  const data = useStore((s) => s.data);
  const live = useStore((s) => s.live);
  const partials = useStore((s) => s.partials);
  const focus = useStore((s) => s.focus);
  const defaultDepth = useStore((s) => s.settings?.assist.defaultDepth ?? 'standard');
  const playingSeg = useStore((s) => s.playingSeg);
  const isLive = !!data && live?.session?.id === data.session.id;
  const playable = !isLive && !!data?.hasAudio;
  /** Wheel, touch or keyboard scrolling pauses following the playback for a few seconds. */
  const userScrollAt = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  // Opened from an evidence link: start at the passage, not at the newest line.
  const [follow, setFollow] = useState(() => !getState().focus);
  /** While a jump to a cited passage is scrolling, scroll events must not switch back to following the end. */
  const jumpingUntil = useRef(0);
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

  useEffect(() => {
    setNewCount(0); lastCount.current = data?.segments.length ?? 0;
    // Opened from an evidence link: the focus effect scrolls to the passage, so don't jump to the end.
    if (getState().focus) { setFollow(false); return; }
    setFollow(true); requestAnimationFrame(scrollToBottom);
  }, [data?.session.id]);

  const onScroll = () => {
    const el = scroller.current!;
    if (Date.now() < jumpingUntil.current) { lastTop.current = el.scrollTop; return; }
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
    jumpingUntil.current = Date.now() + 1200;
    setHl(new Set(ids.length ? ids : [target.id]));
    const el = scroller.current?.querySelector(`[data-t="${target.t_start}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = setTimeout(() => setHl(new Set()), 6000);
    return () => clearTimeout(timer);
  }, [focus?.nonce]);

  // Keep the line being heard in view, unless the reader just scrolled somewhere else.
  useEffect(() => {
    const host = scroller.current;
    const el = playingSeg != null ? host?.querySelector(`[data-id="${playingSeg}"]`) : null;
    if (!host || !el || Date.now() - userScrollAt.current < 4000) return;
    const r = el.getBoundingClientRect(), h = host.getBoundingClientRect();
    if (r.top >= h.top && r.bottom <= h.bottom) return;
    setFollow(false);
    jumpingUntil.current = Date.now() + 1200;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [playingSeg]);

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

  if (!data) return <div className="transcript empty-state"><p>{t('Start a session or open one from History.')}</p></div>;

  return (
    <>
    <SpeakersPanel key={data.session.id} />
    <div className="transcript-wrap">
      <div className={`transcript${playable ? ' playable' : ''}`} ref={scroller} onScroll={onScroll} onMouseUp={onMouseUp} role="log" aria-live="off" aria-label={t('Transcript')}
        onWheel={() => { userScrollAt.current = Date.now(); }} onTouchMove={() => { userScrollAt.current = Date.now(); }} onKeyDown={() => { userScrollAt.current = Date.now(); }}>
        {items.length === 0 && partialList.length === 0 && (
          <p className="empty-state">{isLive ? (live?.status === 'paused' ? t('Paused.') : t('Listening… the transcript appears here a second or two after speech.')) : t('No transcript in this session.')}</p>
        )}
        {items.map((it) => it.kind === 'seg'
          ? <Row key={`s${it.seg.id}`} seg={it.seg} hl={hl.has(it.seg.id)} showSource={showSource} speakerView={data.speakerView} playable={playable} playing={playingSeg === it.seg.id} />
          : it.kind === 'frame'
            ? <button key={`f${it.f.id}`} className="frame-marker" onClick={() => setState({ dialog: 'frame', frameView: it.f.id })} title={t('Screen changed here. Click to view.')}>
                <span className="ts">{fmtT(it.f.t)}</span><img src={frameUrl(it.f.id)} alt="" loading="lazy" /><span className="muted small">{t('Screen changed')}</span>
              </button>
            : <div key={`m${it.ev.id}`} className={`marker marker-${it.ev.kind}`}>{MARK_TEXT[it.ev.kind](it.ev)}</div>)}
        {partialList.map(([src, p]) => (
          <div key={`p-${src}`} className="seg partial" aria-hidden="true">
            <span className="ts">{fmtT(p.t)}</span>
            <span className="txt">{showSource && src === 'system' && <span className="src-tag">{t('computer')}</span>}{p.text}<span className="dots"> …</span></span>
          </div>
        ))}
        {toolbar && (
          <div className="sel-toolbar" style={{ left: toolbar.x, top: Math.max(0, toolbar.y) }} onMouseDown={(e) => e.preventDefault()}>
            <button onClick={() => { explain(toolbar.text.length <= 80 ? toolbar.text : t('the selected passage'), toolbar, defaultDepth); setToolbar(null); window.getSelection()?.removeAllRanges(); }}>{t('Explain')}</button>
            <button onClick={() => { setState({ attached: { fromT: toolbar.fromT, toT: toolbar.toT, text: toolbar.text } }); setToolbar(null); document.getElementById('ask-input')?.focus(); }}>{t('Ask about this…')}</button>
            <button onClick={() => { void navigator.clipboard?.writeText(`[${fmtT(toolbar.fromT)}] ${toolbar.text}`); setToolbar(null); }}>{t('Copy')}</button>
          </div>
        )}
      </div>
      {!follow && (
        <button className="return-live" onClick={returnToLive}>
          {newCount > 0 ? `${t(newCount === 1 ? msg('{n} new line') : msg('{n} new lines'), { n: newCount })} · ` : ''}{isLive ? t('Return to live ↓') : t('Jump to end ↓')}
        </button>
      )}
    </div>
    </>
  );
}

export function focusTime(t: number, t2?: number): void { setState({ focus: { t, t2, nonce: (getState().focus?.nonce ?? 0) + 1 } }); }
