import { useEffect, useRef, useState } from 'react';
import type { ActionProgress as Progress, ProjectAgenda, ProjectBrief, ProjectBriefItem, ProjectWorkItem } from '../../../shared/project-work.ts';
import { getState, notify, setState, useStore } from '../store.ts';
import { openSession } from '../actions.ts';
import { api } from '../api.ts';
import { fmtDate } from '../util.ts';
import { plural, t } from '../i18n.ts';
import { Dialog } from './Dialog.tsx';
import { ActionProgress } from './ActionProgress.tsx';

function AgendaEditor({ projectId, agenda, onSaved, onRefresh }: {
  projectId: string; agenda: ProjectAgenda;
  onSaved: (agenda: ProjectAgenda) => void; onRefresh: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agenda);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const latestAgenda = useRef(agenda);
  latestAgenda.current = agenda;
  useEffect(() => { if (!editing && !saving) setDraft(agenda); }, [agenda, editing, saving]);
  const conflict = editing && agenda.version !== draft.version;
  const save = async () => {
    if (pending.current || conflict) return;
    pending.current = true; setSaving(true); setError('');
    try {
      const result = await api<{ agenda: ProjectAgenda }>(`/api/projects/${encodeURIComponent(projectId)}/agenda`, { method: 'PATCH', body: { text: draft.text, expectedVersion: draft.version } });
      if (latestAgenda.current.version > result.agenda.version) {
        setError(t('The agenda was saved, then changed elsewhere. Compare the latest version before continuing.'));
      } else { onSaved(result.agenda); setDraft(result.agenda); setEditing(false); }
    } catch (e) { setError(e instanceof Error ? e.message : t('Could not save the agenda. Your edits are kept.')); }
    finally { pending.current = false; setSaving(false); }
  };
  const refresh = async () => {
    setRefreshing(true);
    try { await onRefresh(); } catch (e) { setError(e instanceof Error ? e.message : t('Could not refresh the project brief.')); }
    finally { setRefreshing(false); }
  };
  return <section className="hsection brief-agenda">
    <div className="hitem-head"><h3>{t('Agenda for the next meeting')}</h3><span className="spacer" />
      {!editing && <button className="btn small" onClick={() => { setDraft(agenda); setEditing(true); setError(''); }}>{t('Edit agenda')}</button>}
    </div>
    <p className="tiny muted">{t('Notes you write for the next meeting. Saved for this project until you change them.')}</p>
    {!editing ? <p className={agenda.text ? 'brief-agenda-text' : 'small muted'}>{agenda.text || t('No agenda yet. Add the points you want to discuss.')}</p> : <>
      <label className="field"><span>{t('Discussion points')}</span><textarea autoFocus rows={5} maxLength={8000} disabled={saving} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} /></label>
      {conflict && <div className="warn-box small" role="status">
        <p>{t('The agenda changed elsewhere. Your draft is kept. Compare the latest saved agenda before saving again.')}</p>
        <p className="brief-agenda-text">{agenda.text || t('The saved agenda is empty.')}</p>
        <button type="button" className="btn small" disabled={saving} onClick={() => setDraft({ ...draft, version: agenda.version })}>{t('Use this version and keep my edits')}</button>
      </div>}
      {error && <p className="error-text small" role="alert">{t(error)} {t('Your edits are kept. Refresh the latest version to compare changes.')}</p>}
      <div className="btn-row">
        <button className="btn small primary" disabled={saving || conflict || draft.text === agenda.text} onClick={() => void save()}>{saving ? t('Saving…') : t('Save agenda')}</button>
        <button className="btn small" disabled={saving} onClick={() => { setEditing(false); setError(''); }}>{t('Cancel')}</button>
        <button className="btn small ghost" disabled={saving || refreshing} onClick={() => void refresh()}>{refreshing ? t('Refreshing…') : t('Refresh latest')}</button>
      </div>
    </>}
  </section>;
}

function SourceLinks({ item }: { item: Pick<ProjectBriefItem, 'sessionId' | 'sessionTitle'> & Partial<Pick<ProjectBriefItem, 'sessionStartedAt' | 'stale'>> }) {
  const show = async (handoff: boolean) => {
    setState({ dialog: null });
    try {
      await openSession(item.sessionId);
      if (handoff && getState().viewId === item.sessionId) setState({ dialog: 'handoff' });
    } catch (e) { notify('error', e instanceof Error ? e.message : t('Could not open the source meeting.')); }
  };
  return <div className="brief-source small">
    <span className="muted">{item.sessionTitle}{item.sessionStartedAt != null ? ` · ${fmtDate(item.sessionStartedAt)}` : ''}</span>
    <button className="link-btn small" onClick={() => void show(false)}>{t('Open source meeting')}</button>
    <button className="link-btn small" onClick={() => void show(true)}>{t('Open source handoff')}</button>
    {item.stale && <span className="tag tag-warn">{t('Meeting changed since review')}</span>}
  </div>;
}

function ReviewNeeded({ entries }: { entries: ProjectBrief['reviewNeeded'] }) {
  const reasons = { unconfirmed: t('Handoff not confirmed'), changed: t('Meeting changed since review'), moved: t('Moved here from another project after review'), failed: t('Handoff draft failed') };
  return <div className="warn-box small">
    <p>{plural(entries.length, '{n} handoff is unconfirmed or its meeting changed. Check the source handoff before relying on it.', '{n} handoffs are unconfirmed or their meetings changed. Check the source handoffs before relying on them.')}</p>
    <ul>{entries.map((entry) => <li key={entry.sessionId}><span>{reasons[entry.reason]}</span><SourceLinks item={{ sessionId: entry.sessionId, sessionTitle: entry.title }} /></li>)}</ul>
  </div>;
}

function WorkRow({ item, onSaved, onRefresh }: { item: ProjectWorkItem; onSaved: (id: string, progress: Progress) => void; onRefresh: () => Promise<unknown> }) {
  return <li className={`hitem ${item.progress.status === 'blocked' ? 'brief-blocked' : ''}`}>
    <div className="hitem-text">{item.text}</div>
    {(item.owner || item.due) && <div className="tiny muted">{t('Owner: {owner} · Deadline: {due}', { owner: item.owner ?? t('not stated'), due: item.due ?? t('not stated') })}</div>}
    <SourceLinks item={item} />
    <ActionProgress itemId={item.id} progress={item.progress} onSaved={(progress) => onSaved(item.id, progress)} onRefresh={onRefresh} />
  </li>;
}

function BriefBody({ projectId }: { projectId: string }) {
  const workRev = useStore((s) => s.projectWorkRev);
  const live = useStore((s) => s.live);
  const archived = useStore((s) => !!s.projects.find((p) => p.id === projectId)?.archived_at);
  const [brief, setBrief] = useState<ProjectBrief | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef<AbortController | null>(null);
  const refresh = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setRefreshing(true); setError('');
    try {
      const result = await api<ProjectBrief>(`/api/projects/${encodeURIComponent(projectId)}/brief`, { signal: controller.signal });
      if (!controller.signal.aborted) setBrief((current) => {
        if (!current) return result;
        const known = new Map([...current.actions, ...current.completedActions].map((i) => [i.id, i.progress]));
        const work = [...result.actions, ...result.completedActions].map((i) => {
          const previous = known.get(i.id);
          return previous && previous.version > i.progress.version ? { ...i, progress: previous } : i;
        });
        return { ...result, agenda: current.agenda.version > result.agenda.version ? current.agenda : result.agenda,
          actions: work.filter((i) => i.progress.status !== 'completed'), completedActions: work.filter((i) => i.progress.status === 'completed') };
      });
    } catch (e) {
      if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : t('Could not refresh the project brief.')); throw e; }
    } finally { if (request.current === controller) setRefreshing(false); }
  };
  useEffect(() => { void refresh().catch(() => {}); return () => request.current?.abort(); }, [projectId, workRev]);
  const updated = (id: string, progress: Progress) => setBrief((current) => {
    if (!current) return current;
    const item = [...current.actions, ...current.completedActions].find((i) => i.id === id);
    if (!item || item.progress.version > progress.version) return current;
    const actions = current.actions.filter((i) => i.id !== id), completedActions = current.completedActions.filter((i) => i.id !== id);
    const next = { ...item, progress };
    if (progress.status === 'completed') completedActions.unshift(next); else actions.unshift(next);
    return { ...current, actions, completedActions };
  });
  const row = (item: ProjectWorkItem) => <WorkRow key={item.id} item={item} onSaved={updated} onRefresh={refresh} />;
  const context = (items: ProjectBriefItem[], label: string, omitted: number) => <section className="hsection">
    <h3>{label}</h3>
    {items.length ? <ul className="hitems">{items.map((item) => <li key={item.id} className="hitem"><div className="hitem-text">{item.text}</div><SourceLinks item={item} /></li>)}</ul> : <p className="small muted">{t('None found.')}</p>}
    {omitted > 0 && <p className="tiny muted">{t('{n} older items are available in their source meetings.', { n: omitted })}</p>}
  </section>;
  const start = <button className="btn primary" disabled={!brief || archived || (!!live && live.status !== 'idle')} title={archived ? t('Restore this archived project before starting a session for it.') : ''} onClick={() => setState({ startProjectId: projectId, dialog: 'start' })}>{t('Start a session for this project')}</button>;
  return <Dialog title={brief ? t('Project brief: {project}', { project: brief.project.name }) : t('Project brief')} wide className="project-brief" footer={<><button className="btn small" disabled={refreshing} onClick={() => void refresh().catch(() => {})}>{refreshing ? t('Refreshing…') : t('Refresh latest')}</button><span className="spacer" />{start}</>}>
    <p className="small muted">{t('Confirmed meeting handoffs and progress you update manually, gathered for your next meeting.')}</p>
    {error && <p className="error-text small" role="alert">{t(error)}</p>}
    {!brief && !error && <p className="small muted">{t('Loading…')}</p>}
    {brief && <>
      {brief.latestMeeting && <div className="brief-latest small"><b>{t('Latest meeting')}</b><span>{brief.latestMeeting.title}</span>
        {brief.latestMeeting.startedAt !== null && <span className="muted">{fmtDate(brief.latestMeeting.startedAt)}</span>}
        <button className="link-btn small" onClick={() => { setState({ dialog: null }); void openSession(brief.latestMeeting!.id).catch((e: unknown) => notify('error', e instanceof Error ? e.message : t('Could not open the source meeting.'))); }}>{t('Open meeting')}</button>
      </div>}
      {brief.reviewNeeded.length > 0 && <ReviewNeeded entries={brief.reviewNeeded} />}
      <AgendaEditor projectId={projectId} agenda={brief.agenda} onSaved={(agenda) => setBrief((current) => current && current.agenda.version <= agenda.version ? { ...current, agenda } : current)} onRefresh={refresh} />
      {/* Keep all action cards in one keyed list: moving between unfinished and completed on a
          background refresh must not unmount an editor and discard its draft. */}
      <ul className="hitems brief-work">{[
        <li key="unfinished-heading" className="brief-group-heading"><h3>{t('Unfinished work')}</h3>{!brief.actions.length && <p className="small muted">{t('No unfinished confirmed actions.')}</p>}</li>,
        ...brief.actions.map(row),
        <li key="completed-heading" className="brief-group-heading"><h3>{t('Recent results')}</h3>{!brief.completedActions.length && <p className="small muted">{t('No completed actions yet.')}</p>}</li>,
        ...brief.completedActions.map(row),
      ]}</ul>
      {brief.omitted.completedActions > 0 && <p className="tiny muted">{t('{n} older completed actions are available in their source meetings.', { n: brief.omitted.completedActions })}</p>}
      {context(brief.decisions, t('Recent decisions'), brief.omitted.decisions)}
      {context(brief.questions, t('Open questions'), brief.omitted.questions)}
    </>}
  </Dialog>;
}

export function ProjectBriefDialog() {
  const projectId = useStore((s) => s.briefProjectId);
  return projectId ? <BriefBody key={projectId} projectId={projectId} /> : null;
}
