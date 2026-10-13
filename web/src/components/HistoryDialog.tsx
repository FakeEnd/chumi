import { useEffect, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { api } from '../api.ts';
import { deleteSession, exportUrl, openSession, resumeSaved } from '../actions.ts';
import { Dialog } from './Dialog.tsx';
import type { Session } from '../types.ts';
import { t } from '../i18n.ts';
import { SessionMeta, SessionTitle } from './SessionLabel.tsx';

export function HistoryDialog() {
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const projects = useStore((s) => s.projects);
  const [list, setList] = useState<Session[]>([]);
  const live = useStore((s) => s.live);
  const settings = useStore((s) => s.settings);
  const load = (query: string) => { const ps = new URLSearchParams(); if (query) ps.set('q', query); if (project) ps.set('project', project); void api<{ sessions: Session[] }>(`/api/sessions${ps.size ? `?${ps}` : ''}`).then((r) => setList(r.sessions)); };
  const rev = useStore((s) => s.sessionsRev);
  useEffect(() => { const tm = setTimeout(() => load(q), 200); return () => clearTimeout(tm); }, [q, project, rev]);
  const idle = !live || live.status === 'idle';
  return (
    <Dialog title={t('Session history')} wide>
      <div className="field-row">
        <input className="search grow" placeholder={t('Search transcripts, summaries and titles (English or 中文)…')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label={t('Filter by project')}>
          <option value="">{t('All projects')}</option><option value="none">{t('No project')}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <ul className="history">
        {list.length === 0 && <li className="muted pad">{q ? t('No matches.') : t('No saved sessions yet.')}</li>}
        {list.map((s) => (
          <li key={s.id}>
            <div className="h-main" onClick={() => { void openSession(s.id); setState({ dialog: null }); }}>
              <div className="h-title session-title"><SessionTitle s={s} /></div>
              <div className="muted small"><SessionMeta s={s} /></div>
              {s.snippet && <div className="snippet small">…{s.snippet}…</div>}
            </div>
            <div className="h-actions">
              <a className="btn small" href={exportUrl(s.id, 'md')} download>Markdown</a>
              <a className="btn small" href={exportUrl(s.id, 'txt')} download>{t('Text')}</a>
              {s.status === 'interrupted' && idle && <button className="btn small" onClick={() => void resumeSaved(s.id, settings?.audio.source ?? 'mic').then(() => setState({ dialog: null }))}>{t('Resume recording')}</button>}
              <button className="btn small danger" disabled={live?.session?.id === s.id} onClick={() => { if (confirm(t('Delete “{title}” permanently? Transcript, AI answers and summary will be removed from this computer.', { title: s.title }))) void deleteSession(s.id); }}>{t('Delete')}</button>
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
