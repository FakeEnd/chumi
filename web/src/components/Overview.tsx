import { useState } from 'react';
import { useStore } from '../store.ts';
import { recap } from '../actions.ts';
import { fmtClock, fmtT, parseT } from '../util.ts';
import { focusTime } from './Transcript.tsx';
import { Markdown } from './Markdown.tsx';

export function Overview() {
  const outs = useStore((s) => s.data?.outputs);
  const [open, setOpen] = useState(true);
  if (!outs) return null;
  const ovs = outs.filter((o) => o.kind === 'overview');
  const done = [...ovs].reverse().find((o) => o.status === 'done' && o.data);
  const busy = ovs.some((o) => o.status === 'pending' || o.status === 'streaming');
  const failed = [...ovs].reverse().find((o) => o.status === 'error');
  const d = done?.data as { current_topic?: string; overview?: string[]; topics?: Array<{ title: string; start: string }>; open_question?: string } | undefined;
  return (
    <section className={`overview ${open ? '' : 'collapsed'}`} aria-label="Current topic and overview">
      <div className="overview-head">
        <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '▾' : '▸'}</button>
        <span className="overview-topic">{d?.current_topic ? <>Now: <strong>{d.current_topic}</strong></> : <span className="muted">Overview appears after a minute or two of discussion.</span>}</span>
        <span className="muted small">{busy ? 'updating…' : done ? `updated ${fmtClock(done.completed_at ?? done.created_at)} · to ${fmtT(done.covered_to)}` : ''}</span>
        <button className="btn small" onClick={() => recap()} disabled={busy} title="Update the overview now">Recap now</button>
      </div>
      {open && d && (
        <div className="overview-body">
          {d.overview?.length ? <Markdown text={d.overview.map((b) => `- ${b}`).join('\n')} /> : null}
          {d.open_question ? <div className="open-q"><span className="muted">Open question:</span> <Markdown text={d.open_question} className="inline" /></div> : null}
          {d.topics?.length ? (
            <div className="topics">{d.topics.map((t, i) => (
              <button key={i} className="topic-chip" onClick={() => { const ms = parseT(t.start); if (ms != null) focusTime(ms); }} title="Jump to this part of the transcript">{t.start} · {t.title}</button>
            ))}</div>
          ) : null}
        </div>
      )}
      {open && !d && failed && <div className="muted small error-text">Overview unavailable: {failed.error}</div>}
    </section>
  );
}
