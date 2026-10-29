import { useEffect, useState } from 'react';
import { DEFAULT_SESSION_TYPES, SESSION_STYLES, availableSessionTypes, sessionStyle, validateSessionTypes, type SessionStyle, type SessionTypeOption } from '../../../shared/session-types.ts';
import { saveSettings } from '../actions.ts';
import { getState, setState, useStore } from '../store.ts';
import { msg, t } from '../i18n.ts';
import { typeLabel } from '../util.ts';
import { onEnter } from '../keys.ts';

export function SessionTypeSelect({ value, onChange, className, manage = false }: { value: string; onChange: (id: string) => void; className?: string; manage?: boolean }) {
  const options = useStore((s) => s.settings?.sessionTypes) ?? DEFAULT_SESSION_TYPES;
  return <select className={className} value={value} aria-label={t('Session type')} title={typeLabel(value)}
    onChange={(e) => e.target.value === '__manage' ? setState({ dialog: 'settings', settingsTab: 'session-types', dialogReturnTo: getState().dialog }) : onChange(e.target.value)}>
    {availableSessionTypes(options, value).map((o) => <option key={o.id} value={o.id}>{typeLabel(o.id)}{o.archived ? ` ${t('(removed)')}` : ''}</option>)}
    {manage && <option value="__manage">{t('Edit session types…')}</option>}
  </select>;
}

const STYLE_LABEL: Record<SessionStyle, string> = { lab_meeting: msg('Lab meeting'), advisor: msg('Advisor 1:1'), lecture: msg('Lecture'), wip: msg('WIP / seminar'), other: msg('General') };
const isUnchangedDefault = (o: SessionTypeOption) => DEFAULT_SESSION_TYPES.some((d) => d.id === o.id && d.name === o.name);

export function SessionTypesTab() {
  const saved = useStore((s) => s.settings?.sessionTypes) ?? DEFAULT_SESSION_TYPES;
  const [rows, setRows] = useState<SessionTypeOption[]>(() => structuredClone(saved));
  const [names, setNames] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Follow changes saved elsewhere (another window) while there are no local edits.
  useEffect(() => { if (!dirty) setRows(structuredClone(saved)); }, [saved, dirty]);
  const visible = rows.filter((o) => !o.archived);
  const shown = (o: SessionTypeOption) => names[o.id] ?? (isUnchangedDefault(o) ? typeLabel(o.id) : o.name);
  const edited = () => { setDirty(true); setError(''); };
  const add = () => {
    const clean = name.trim();
    if (!clean) return;
    // Adding back a removed type restores it, so its meetings and summary style come back too.
    const removed = rows.find((o) => o.archived && (o.name.toLowerCase() === clean.toLowerCase() || (isUnchangedDefault(o) && typeLabel(o.id).toLowerCase() === clean.toLowerCase())));
    setRows(removed ? rows.map((o) => o === removed ? { ...o, archived: false } : o) : [...rows, { id: `custom_${crypto.randomUUID()}`, name: clean }]);
    setName(''); edited();
  };
  const remove = (id: string) => {
    // A type that was never saved is simply dropped; saved ones are archived so their meetings keep a name.
    setRows(saved.some((o) => o.id === id) ? rows.map((o) => o.id === id ? { ...o, archived: true } : o) : rows.filter((o) => o.id !== id));
    const nextNames = { ...names }; delete nextNames[id];
    setNames(nextNames); edited();
  };
  const save = async () => {
    const lower = visible.map((o) => shown(o).trim().toLowerCase());
    if (new Set(lower).size !== lower.length) { setError('Session type names must be unique.'); return; }
    let next: SessionTypeOption[];
    // Typing a default's translated name back leaves it a default, so it keeps following the interface language.
    const nameFor = (o: SessionTypeOption) => names[o.id] === undefined || (isUnchangedDefault(o) && names[o.id].trim() === typeLabel(o.id)) ? o.name : names[o.id];
    try { next = validateSessionTypes(rows.map((o) => ({ ...o, name: nameFor(o) })), saved); }
    catch (e) { setError((e as Error).message); return; }
    setBusy(true); setError('');
    if (await saveSettings({ sessionTypes: next })) { setRows(next); setNames({}); setDirty(false); }
    setBusy(false);
  };
  return <section>
    <p className="small muted">{t('Start with these defaults, then rename, add or remove types to fit your meetings. Each type picks the summary style Chumi uses; added types start with the general one.')}</p>
    <fieldset className="session-types-editor" disabled={busy}>
      <div className="session-type-list">
        {visible.map((o, i) => <div className="session-type-row" key={o.id}>
          <span className="session-type-number">{i + 1}</span>
          <input aria-label={t('Session type name {n}', { n: i + 1 })} maxLength={60} value={shown(o)}
            onChange={(e) => { setNames({ ...names, [o.id]: e.target.value }); edited(); }} />
          <select aria-label={t('Summary style for {name}', { name: shown(o) })} title={t('Which built-in template Chumi uses for the AI instructions and the final summary')}
            value={sessionStyle(rows, o.id)} onChange={(e) => { setRows(rows.map((r) => r.id === o.id ? { ...r, style: e.target.value as SessionStyle } : r)); edited(); }}>
            {SESSION_STYLES.map((st) => <option key={st} value={st}>{t('Summary: {style}', { style: t(STYLE_LABEL[st]) })}</option>)}
          </select>
          <button className="btn small ghost danger" disabled={visible.length === 1} title={visible.length === 1 ? t('Keep at least one session type.') : undefined}
            onClick={() => remove(o.id)}>{t('Remove')}</button>
        </div>)}
      </div>
      <div className="session-type-add">
        <input aria-label={t('New session type')} placeholder={t('e.g. Journal club')} maxLength={60} value={name}
          onChange={(e) => setName(e.target.value)} onKeyDown={onEnter(add)} />
        <button className="btn" disabled={!name.trim()} onClick={add}>{t('Add type')}</button>
      </div>
      <p className="small muted">{t('Removing a type hides it from new meetings. Existing meetings keep their type. If needed, Quick start switches to the first remaining type.')}</p>
      {error && <p className="error-text" role="alert">{t(error)}</p>}
      <div className="btn-row">
        <button className="btn primary" disabled={!dirty} onClick={() => void save()}>{busy ? t('Saving…') : t('Save changes')}</button>
      </div>
      {!dirty && <p className="small ok-text" role="status">{t('Session types are saved.')}</p>}
    </fieldset>
  </section>;
}
