import { useEffect, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { api } from '../api.ts';
import { deleteSession, exportAudio, exportUrl, openSession } from '../actions.ts';
import { ResumeRecording } from './ResumeRecording.tsx';
import { Dialog } from './Dialog.tsx';
import type { Session } from '../types.ts';
import { t } from '../i18n.ts';
import { SessionMeta, SessionTitle } from './SessionLabel.tsx';

export function HistoryDialog() {
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const projects = useStore((s) => s.projects);
  const [list, setList] = useState<Session[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [exporting, setExporting] = useState<Set<string>>(new Set());
  const live = useStore((s) => s.live);
  const rev = useStore((s) => s.sessionsRev);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    const tm = setTimeout(() => {
      const ps = new URLSearchParams(); if (q) ps.set('q', q); if (project) ps.set('project', project);
      void api<{ sessions: Session[] }>(`/api/sessions${ps.size ? `?${ps}` : ''}`, { signal: controller.signal })
        .then((r) => { if (!controller.signal.aborted) setList(r.sessions); })
        .catch(() => { if (!controller.signal.aborted) setError(t('Could not load saved sessions.')); });
    }, 200);
    return () => { clearTimeout(tm); controller.abort(); };
  }, [q, project, rev, retry]);
  return (
    <Dialog title={t('Session history')} wide>
      <div className="field-row">
        <input className="search grow" aria-label={t('Search sessions')} placeholder={t('Search transcripts, summaries and titles (English or 中文)…')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label={t('Filter by project')}>
          <option value="">{t('All projects')}</option><option value="none">{t('No project')}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <ul className="history">
        {error && <li className="pad error-text" role="alert">{error} <button className="btn small" onClick={() => setRetry((n) => n + 1)}>{t('Retry')}</button></li>}
        {!error && list === null && <li className="muted pad" role="status">{t('Loading…')}</li>}
        {list?.length === 0 && <li className="muted pad">{q || project ? t('No matches.') : t('No saved sessions yet.')}</li>}
        {list?.map((s) => (
          <li key={s.id}>
            <button className="h-main" onClick={() => { void openSession(s.id); setState({ dialog: null }); }}>
              <span className="h-title session-title"><SessionTitle s={s} /></span>
              <span className="muted small"><SessionMeta s={s} /></span>
              {s.snippet && <span className="snippet small">…{s.snippet}…</span>}
            </button>
            <div className="h-actions">
              <a className="btn small" href={exportUrl(s.id, 'md')} download>Markdown</a>
              <a className="btn small" href={exportUrl(s.id, 'txt')} download>{t('Text')}</a>
              {s.has_audio && <button className="btn small" disabled={live?.session?.id === s.id || exporting.has(s.id)} title={t('Download the recording as one audio file')}
                onClick={() => { setExporting((x) => new Set(x).add(s.id)); void exportAudio(s.id).finally(() => setExporting((x) => { const n = new Set(x); n.delete(s.id); return n; })); }}>{exporting.has(s.id) ? t('Preparing…') : t('Audio')}</button>}
              <ResumeRecording session={s} onResumed={() => setState({ dialog: null })} />
              <button className="btn small danger" disabled={live?.session?.id === s.id} onClick={() => { if (confirm(s.has_audio ? t('Delete “{title}” permanently? Transcript, AI answers, summary, screen captures and the audio recording will be removed from this computer.', { title: s.title }) : t('Delete “{title}” permanently? Transcript, AI answers, summary and screen captures will be removed from this computer.', { title: s.title }))) void deleteSession(s.id); }}>{t('Delete')}</button>
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
