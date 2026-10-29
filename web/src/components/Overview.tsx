import { useState } from 'react';
import { useStore } from '../store.ts';
import { recap } from '../actions.ts';
import { fmtClock, fmtT, parseT } from '../util.ts';
import { focusTime } from './Transcript.tsx';
import { Markdown } from './Markdown.tsx';
import { t } from '../i18n.ts';
import { digestProgress } from '../ai-progress.ts';

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
    <section className={`overview ${open ? '' : 'collapsed'}`} aria-label={t('Current topic and overview')}>
      <div className="overview-head">
        <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '▾' : '▸'}</button>
        <span className="overview-topic">{d?.current_topic ? <>{t('Now:')} <strong>{d.current_topic}</strong></> : <span className="muted">{t('Overview appears after a minute or two of discussion.')}</span>}</span>
        <span className="muted small">{busy ? digestProgress(ovs.find((o) => o.status === 'streaming')) ?? t('updating…') : done ? t('updated {clock} · to {t}', { clock: fmtClock(done.completed_at ?? done.created_at), t: fmtT(done.covered_to) }) : ''}</span>
        <button className="btn small" onClick={() => recap()} disabled={busy} title={t('Update the overview now')}>{t('Recap now')}</button>
      </div>
      {open && d && (
        <div className="overview-body">
          {d.overview?.length ? <Markdown text={d.overview.map((b) => `- ${b}`).join('\n')} /> : null}
          {d.open_question ? <div className="open-q"><span className="muted">{t('Open question:')}</span> <Markdown text={d.open_question} className="inline" /></div> : null}
          {d.topics?.length ? (
            <div className="topics">{d.topics.map((tp, i) => (
              <button key={i} className="topic-chip" onClick={() => { const ms = parseT(tp.start); if (ms != null) focusTime(ms); }} title={t('Jump to this part of the transcript')}>{tp.start} · {tp.title}</button>
            ))}</div>
          ) : null}
        </div>
      )}
      {open && !d && failed && <div className="muted small error-text">{t('Overview unavailable: {error}', { error: failed.error ?? '' })}</div>}
    </section>
  );
}
