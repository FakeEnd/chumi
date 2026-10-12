import { useStore } from '../store.ts';
import { fmtDate, fmtT, typeLabel } from '../util.ts';
import { plural, t } from '../i18n.ts';
import type { Session } from '../types.ts';

/** A saved session's title line, the same in Recent sessions and Session history: title, project, state. */
export function SessionTitle({ s }: { s: Session }) {
  const project = useStore((st) => st.projects.find((p) => p.id === s.project_id)?.name);
  return <>
    <span className="session-name">{s.title}</span>
    {project && <span className="tag project-tag">{project}</span>}
    {s.status === 'interrupted' && <span className="tag tag-warn">{t('interrupted')}</span>}
    {(s.status === 'recording' || s.status === 'paused') && <span className="tag tag-live">{t('live')}</span>}
  </>;
}

/** Type · date · length · lines, the same in both lists. */
export function SessionMeta({ s }: { s: Session }) {
  return <>{typeLabel(s.type)} · {fmtDate(s.started_at ?? s.created_at)} · {fmtT(s.duration_ms)} · {plural(s.segment_count ?? 0, '{n} line', '{n} lines')}</>;
}
