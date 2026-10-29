import { useDialogDraft } from '../dialogDraft.ts';
import { useEffect, useRef, useState } from 'react';
import { ACTION_STATUSES, isActionResultUrl, type ActionProgress as Progress, type ActionResult, type ActionStatus } from '../../../shared/project-work.ts';
import { updateActionProgress } from '../actions.ts';
import { fmtDate } from '../util.ts';
import { msg, t } from '../i18n.ts';

const STATUS: Record<ActionStatus, string> = {
  not_started: msg('Not started'), in_progress: msg('In progress'), blocked: msg('Blocked'), completed: msg('Completed'),
};
const EMPTY: Progress = { status: 'not_started', note: '', results: [], updatedAt: null, version: 0 };
const copy = (p: Progress): Progress => ({ ...p, results: p.results.map((r) => ({ ...r })) });

const resultHref = (value: string): string | null => isActionResultUrl(value) ? value : null;

function SavedProgress({ progress }: { progress: Progress }) {
  return <>
    <div className="hitem-head"><span className={`tag ${progress.status === 'blocked' ? 'tag-warn' : progress.status === 'completed' ? 'tag-ok' : 'tag-muted'}`}>{t(STATUS[progress.status])}</span>
      {progress.updatedAt !== null && <span className="tiny muted">{t('Updated {time}', { time: fmtDate(progress.updatedAt) })}</span>}
    </div>
    {progress.note && <p className="small action-note">{progress.note}</p>}
    {!!progress.results.length && <ul className="action-results">{progress.results.map((r, index) => <li key={`${r.url}-${index}`}>
      {resultHref(r.url) ? <a href={resultHref(r.url)!} target="_blank" rel="noreferrer">{r.label || r.url}</a> : <span>{r.label} — {r.url}</span>}
    </li>)}</ul>}
  </>;
}

/** Human-maintained execution progress; changing it never changes meeting review or confirmation. */
export function ActionProgress({ itemId, progress, onSaved, onRefresh }: {
  itemId: string; progress?: Progress | null;
  onSaved?: (progress: Progress) => void;
  onRefresh?: () => Promise<unknown>;
}) {
  const saved = progress ?? EMPTY;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => copy(saved));
  useDialogDraft(editing && (draft.status !== saved.status || draft.note !== saved.note || JSON.stringify(draft.results) !== JSON.stringify(saved.results)));
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const latestSaved = useRef(saved);
  latestSaved.current = saved;
  useEffect(() => { if (!editing && !saving) setDraft(copy(saved)); }, [saved, editing, saving]);
  const changedElsewhere = editing && saved.version !== draft.version;
  const editResult = (index: number, patch: Partial<ActionResult>) => setDraft((d) => ({ ...d, results: d.results.map((r, i) => i === index ? { ...r, ...patch } : r) }));
  const refresh = async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try { await onRefresh(); } catch (e) { setError(e instanceof Error ? e.message : t('Could not refresh progress.')); }
    finally { setRefreshing(false); }
  };
  const save = async () => {
    if (pending.current || changedElsewhere) return;
    const results = draft.results.map((r) => ({ label: r.label.trim(), url: r.url.trim() }));
    if (results.some((r) => !r.label || !resultHref(r.url))) {
      setError(t('Give each result a label and an http(s) URL or an existing Codex thread link.')); return;
    }
    pending.current = true; setSaving(true); setError('');
    try {
      const result = await updateActionProgress(itemId, { status: draft.status, note: draft.note, results, expectedVersion: draft.version });
      if (result && latestSaved.current.version > result.version) {
        setError(t('Progress was saved, then changed elsewhere. Compare the latest version before continuing.'));
      } else if (result) { setDraft(copy(result)); onSaved?.(result); setEditing(false); }
      else setError(t('Progress was not saved. Your edits are kept. Refresh the latest version before trying again.'));
    } catch (e) { setError(e instanceof Error ? e.message : t('Could not save progress. Your edits are kept.')); }
    finally { pending.current = false; setSaving(false); }
  };
  return <section className="action-progress" aria-label={t('Work progress')}>
    <div className="hitem-head"><b className="small">{t('Work progress')}</b><span className="spacer" />
      {!editing && <button type="button" className="link-btn small" onClick={() => { setDraft(copy(saved)); setEditing(true); setError(''); }}>{t('Update progress')}</button>}
    </div>
    {!editing ? <SavedProgress progress={saved} /> : <>
      <fieldset className="action-progress-fields" disabled={saving}>
        <label className="field"><span>{t('Status')}</span><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as ActionStatus })}>
          {ACTION_STATUSES.map((status) => <option key={status} value={status}>{t(STATUS[status])}</option>)}
        </select></label>
        <label className="field"><span>{t('Progress note')}</span><textarea rows={3} value={draft.note} maxLength={4000} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label>
        <div className="field"><span>{t('Results (up to 8 links)')}</span>
          {draft.results.map((r, i) => <div className="action-result-edit" key={i}>
            <label className="field grow"><span>{t('Result label')}</span><input value={r.label} maxLength={120} onChange={(e) => editResult(i, { label: e.target.value })} /></label>
            <label className="field grow"><span>{t('Result URL')}</span><input value={r.url} maxLength={2048} spellCheck={false} onChange={(e) => editResult(i, { url: e.target.value })} /></label>
            <button type="button" className="btn small ghost" onClick={() => setDraft({ ...draft, results: draft.results.filter((_, index) => index !== i) })}>{t('Remove result')}</button>
          </div>)}
          <button type="button" className="btn small" disabled={draft.results.length >= 8} onClick={() => setDraft({ ...draft, results: [...draft.results, { label: '', url: '' }] })}>{t('Add result link')}</button>
        </div>
      </fieldset>
      {changedElsewhere && <div className="warn-box small" role="status">
        <p>{t('Progress changed elsewhere. Your draft is kept. Compare the latest saved progress before saving again.')}</p>
        <SavedProgress progress={saved} />
        <button type="button" className="btn small" disabled={saving} onClick={() => setDraft({ ...draft, version: saved.version })}>{t('Use this version and keep my edits')}</button>
      </div>}
      {error && <p className="error-text small" role="alert">{t(error)}</p>}
      <div className="btn-row">
        <button type="button" className="btn small primary" disabled={saving || changedElsewhere} onClick={() => void save()}>{saving ? t('Saving…') : t('Save progress')}</button>
        <button type="button" className="btn small" disabled={saving} onClick={() => { setEditing(false); setError(''); }}>{t('Cancel')}</button>
        {onRefresh && <button type="button" className="btn small ghost" disabled={saving || refreshing} onClick={() => void refresh()}>{refreshing ? t('Refreshing…') : t('Refresh latest')}</button>}
      </div>
      <p className="tiny muted">{t('Work progress is separate from meeting review. Mark completion only after checking the result.')}</p>
    </>}
  </section>;
}
