import { useState } from 'react';
import { setState, useStore } from '../store.ts';
import { ask, frameUrl, setWindow } from '../actions.ts';
import { fmtT } from '../util.ts';
import { Dialog } from './Dialog.tsx';
import { WindowPicker } from './WindowPicker.tsx';
import { focusTime } from './Transcript.tsx';
import type { WindowInfo } from '../types.ts';
import { plural, t, tn } from '../i18n.ts';

/** Horizontal strip of captured slides/screens for the open session. */
export function SlideStrip() {
  const frames = useStore((s) => s.data?.frames);
  const screen = useStore((s) => s.live?.screen);
  const isLive = useStore((s) => !!s.data && s.live?.session?.id === s.data.session.id);
  const [open, setOpen] = useState(true);
  if (!frames?.length && !(isLive && screen)) return null;
  return (
    <section className="slides" aria-label={t('Screen captures')}>
      <div className="slides-head">
        <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '▾' : '▸'}</button>
        <span className="small"><b>{t('Screen')}</b> · {plural(frames?.length ?? 0, '{n} capture', '{n} captures')}{isLive && screen ? ` · ${t('capturing {app}', { app: screen.app })}${screen.status === 'paused' ? ` ${t('(paused)')}` : ''}` : ''}</span>
      </div>
      {open && !!frames?.length && (
        <div className="slides-row">
          {frames.map((f) => (
            <button key={f.id} className={`thumb ${f.kind}`} onClick={() => setState({ dialog: 'frame', frameView: f.id })} title={`${fmtT(f.t)} · ${f.window_title ?? ''}`}>
              <img src={frameUrl(f.id)} alt={t('Screen at {t}', { t: fmtT(f.t) })} loading="lazy" />
              <span>{fmtT(f.t)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function FrameViewer() {
  const id = useStore((s) => s.frameView);
  const frames = useStore((s) => s.data?.frames ?? []);
  const depth = useStore((s) => s.settings?.assist.defaultDepth ?? 'standard');
  const idx = frames.findIndex((f) => f.id === id);
  const f = frames[idx];
  if (!f) return null;
  const go = (d: number) => { const n = frames[idx + d]; if (n) setState({ frameView: n.id }); };
  return (
    <Dialog title={`${t('Screen at {t}', { t: fmtT(f.t) })}${f.window_title ? ` · ${f.window_title}` : ''}`} wide footer={<>
      <button className="btn small" disabled={idx <= 0} onClick={() => go(-1)}>← {t('Previous')}</button>
      <button className="btn small" disabled={idx >= frames.length - 1} onClick={() => go(1)}>{t('Next')} →</button>
      <span className="spacer" />
      <button className="btn small" onClick={() => { focusTime(f.t); setState({ dialog: null }); }}>{t('Show transcript here')}</button>
      <button className="btn small primary" onClick={() => { ask(t('Explain what is shown on this slide/screen and how it relates to what the speakers are saying.'), null, depth, [f.id]); setState({ dialog: null }); }}>{t('Ask about this slide')}</button>
    </>}>
      <img className="frame-full" src={frameUrl(f.id)} alt={t('Screen capture at {t}', { t: fmtT(f.t) })} />
      <p className="muted small">{f.kind === 'snapshot' ? t('Captured on demand for a question.') : t('Captured automatically when the window changed.')} {t('Stored only on this Mac. It is sent to the AI provider only with questions, catch-ups and summaries (Settings → Screen).')}</p>
    </Dialog>
  );
}

/** Mid-session: choose, switch or stop the captured window. */
export function WindowDialog() {
  const screen = useStore((s) => s.live?.screen);
  const [win, setWin] = useState<WindowInfo | null>(null);
  return (
    <Dialog title={t('Capture a window')} footer={<>
      {screen && <button className="btn small danger" onClick={() => void setWindow(null).then(() => setState({ dialog: null }))}>{t('Stop capturing')}</button>}
      <span className="spacer" />
      <button className="btn primary" disabled={!win} onClick={() => win && void setWindow(win).then(() => setState({ dialog: null }))}>{screen ? t('Switch window') : t('Start capturing')}</button>
    </>}>
      <p className="small">{t('Pick the Zoom/Teams window, the browser showing a lecture video, or a slide deck. Chumi saves a picture whenever the screen changes, so answers can refer to slides and figures.')}</p>
      {screen && <p className="small">{tn('Currently capturing: {app}', { app: <b>{screen.app}</b> })}{screen.title ? ` · ${screen.title}` : ''} ({plural(screen.frames, '{n} capture', '{n} captures')})</p>}
      <WindowPicker value={win} onChange={setWin} />
    </Dialog>
  );
}
