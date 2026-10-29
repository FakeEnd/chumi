import { useDialogDraft } from '../dialogDraft.ts';
import { useState } from 'react';
import { useStore } from '../store.ts';
import { saveProfile } from '../actions.ts';
import { Dialog } from './Dialog.tsx';
import type { Profile } from '../types.ts';
import { msg, t } from '../i18n.ts';

const LEVELS = [msg('new to this'), msg('introductory'), msg('working knowledge'), msg('strong'), msg('expert')];
const toList = (s: string) => s.split(/[\n,;，；]+/).map((x) => x.trim()).filter(Boolean);
/** One click to start the table on a new profile; the level is set right after. */
const SUGGESTED = [msg('Machine learning'), msg('Statistics'), msg('Programming'), msg('Genomics'), msg('Molecular & cell biology'), msg('Neuroscience'), msg('Chemistry'), msg('Physics'), msg('Wet-lab techniques')];

export function ProfileDialog() {
  const profile = useStore((s) => s.profile);
  const [p, setP] = useState<Profile>(() => structuredClone(profile!));
  const [known, setKnown] = useState(profile!.knownConcepts.join(', '));
  const [needs, setNeeds] = useState(profile!.needsBackground.join(', '));
  const form = JSON.stringify({ p, known, needs });
  const [saved, setSaved] = useState(form);
  useDialogDraft(form !== saved);
  const set = (patch: Partial<Profile>) => setP({ ...p, ...patch });
  const save = async () => { if (await saveProfile({ ...p, knownConcepts: toList(known), needsBackground: toList(needs) })) { setSaved(form); } };
  return (
    <Dialog title={t('Knowledge profile')} wide footer={<><span className="muted small">{t('Used to tailor explanations. Per-question depth never changes this profile.')}</span><span className="spacer" /><button className="btn primary" onClick={save}>{t('Save profile')}</button></>}>
      <div className="grid2">
        <label className="field"><span>{t('Academic & professional background')}</span><textarea rows={3} value={p.background} placeholder={t('e.g. Computer science undergrad, now a first-year PhD student in computational biology')} onChange={(e) => set({ background: e.target.value })} /></label>
        <label className="field"><span>{t('Current research interests')}</span><textarea rows={3} value={p.researchInterests} placeholder={t('e.g. Machine learning for gene regulation')} onChange={(e) => set({ researchInterests: e.target.value })} /></label>
      </div>
      <div className="field">
        <span>{t('Familiarity by domain')}</span>
        {p.domains.length > 0 && <table className="domains">
          <thead><tr><th>{t('Domain')}</th><th>{t('Level')}</th><th>{t('Notes for the AI')}</th><th /></tr></thead>
          <tbody>
            {p.domains.map((d, i) => (
              <tr key={i}>
                <td><input aria-label={t('Domain')} value={d.name} onChange={(e) => { const ds = p.domains.slice(); ds[i] = { ...d, name: e.target.value }; set({ domains: ds }); }} /></td>
                <td><select aria-label={t('Level')} value={d.level} onChange={(e) => { const ds = p.domains.slice(); ds[i] = { ...d, level: Number(e.target.value) }; set({ domains: ds }); }}>{LEVELS.map((l, k) => <option key={k} value={k}>{k} · {t(l)}</option>)}</select></td>
                <td><input aria-label={t('Notes for the AI')} value={d.notes ?? ''} onChange={(e) => { const ds = p.domains.slice(); ds[i] = { ...d, notes: e.target.value }; set({ domains: ds }); }} /></td>
                <td><button className="link-btn" onClick={() => set({ domains: p.domains.filter((_, k) => k !== i) })} aria-label={t('Remove {name}', { name: d.name })}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>}
        {!p.domains.length && <p className="muted small">{t('Add the fields your meetings touch, and how well you know each. Chumi explains less where you are strong and more where you are new.')}</p>}
        {p.domains.length < 4 && <div className="chips">{SUGGESTED.filter((name) => !p.domains.some((d) => d.name === t(name))).map((name) => <button key={name} className="chip" onClick={() => set({ domains: [...p.domains, { name: t(name), level: 1 }] })}>+ {t(name)}</button>)}</div>}
        <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => set({ domains: [...p.domains, { name: '', level: 1 }] })}>+ {t('Add domain')}</button>
      </div>
      <div className="grid2">
        <label className="field"><span>{t('Concepts I already understand')} <em className="muted">{t('(comma or newline separated; never auto-explained)')}</em></span><textarea rows={3} value={known} placeholder={t('e.g. cross-validation, transformer, p-value')} onChange={(e) => setKnown(e.target.value)} /></label>
        <label className="field"><span>{t('Topics where I need more background')}</span><textarea rows={3} value={needs} placeholder={t('e.g. experimental assay design, count models')} onChange={(e) => setNeeds(e.target.value)} /></label>
      </div>
      <div className="grid2">
        <label className="field"><span>{t('AI answer language')}</span>
          <select value={p.explanationLanguage} onChange={(e) => set({ explanationLanguage: e.target.value })}>
            <option value="Simplified Chinese">中文 (Simplified Chinese)</option>
            <option value="English">English</option>
          </select>
        </label>
        {p.explanationLanguage !== 'English' && <label className="field check"><input type="checkbox" checked={p.keepEnglishTerms} onChange={(e) => set({ keepEnglishTerms: e.target.checked })} /> {t('Keep important English technical terms in English')}</label>}
      </div>
      <label className="field"><span>{t('Preferred explanation style')}</span><textarea rows={2} value={p.style} placeholder={t('e.g. Concise. Intuition first, then the mechanism.')} onChange={(e) => set({ style: e.target.value })} /></label>
    </Dialog>
  );
}
