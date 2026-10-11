import { useEffect, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { api } from '../api.ts';
import { deleteSession, exportUrl, openSession, resumeSaved } from '../actions.ts';
import { fmtDate, fmtT, typeLabel } from '../util.ts';
import { Dialog } from './Dialog.tsx';
import type { Session } from '../types.ts';
import { plural, t } from '../i18n.ts';

export function HistoryDialog() {
  const [q, setQ] = useState('');
  const [list, setList] = useState<Session[]>([]);
  const live = useStore((s) => s.live);
  const settings = useStore((s) => s.settings);
  const load = (query: string) => void api<{ sessions: Session[] }>(`/api/sessions${query ? `?q=${encodeURIComponent(query)}` : ''}`).then((r) => setList(r.sessions));
  useEffect(() => { const t = setTimeout(() => load(q), 200); return () => clearTimeout(t); }, [q]);
  const idle = !live || live.status === 'idle';
  return (
    <Dialog title={t('Session history')} wide>
      <input className="search" placeholder={t('Search transcripts, summaries and titles (English or 中文)…')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <ul className="history">
        {list.length === 0 && <li className="muted pad">{q ? t('No matches.') : t('No saved sessions yet.')}</li>}
        {list.map((s) => (
          <li key={s.id}>
            <div className="h-main" onClick={() => { void openSession(s.id); setState({ dialog: null }); }}>
              <div className="h-title">{s.title} {s.status === 'interrupted' && <span className="tag tag-warn">{t('interrupted')}</span>}{(s.status === 'recording' || s.status === 'paused') && <span className="tag tag-live">{t('live')}</span>}</div>
              <div className="muted small">{typeLabel(s.type)} · {fmtDate(s.started_at ?? s.created_at)} · {fmtT(s.duration_ms)} · {plural(s.segment_count ?? 0, '{n} line', '{n} lines')}</div>
              {s.snippet && <div className="snippet small">…{s.snippet}…</div>}
            </div>
            <div className="h-actions">
              <a className="btn small" href={exportUrl(s.id, 'md')} download>Markdown</a>
              <a className="btn small" href={exportUrl(s.id, 'txt')} download>{t('Text')}</a>
              {s.status === 'interrupted' && idle && <button className="btn small" onClick={() => void resumeSaved(s.id, settings?.audio.source ?? 'mic').then(() => setState({ dialog: null }))}>{t('Resume recording')}</button>}
              <button className="btn small danger" disabled={live?.session?.id === s.id} onClick={() => { if (confirm(t('Delete “{title}” permanently? Transcript, AI answers and summary will be removed from this Mac.', { title: s.title }))) void deleteSession(s.id).then(() => load(q)); }}>{t('Delete')}</button>
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
