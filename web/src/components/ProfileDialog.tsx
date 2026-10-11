import { useState } from 'react';
import { useStore } from '../store.ts';
import { saveProfile } from '../actions.ts';
import { Dialog } from './Dialog.tsx';
import type { Profile } from '../types.ts';

const LEVELS = ['0 · new to this', '1 · introductory', '2 · working knowledge', '3 · strong', '4 · expert'];
const toList = (s: string) => s.split(/[\n,;，；]+/).map((x) => x.trim()).filter(Boolean);

export function ProfileDialog() {
  const profile = useStore((s) => s.profile);
  const [p, setP] = useState<Profile>(() => structuredClone(profile!));
  const [known, setKnown] = useState(profile!.knownConcepts.join(', '));
  const [needs, setNeeds] = useState(profile!.needsBackground.join(', '));
  const set = (patch: Partial<Profile>) => setP({ ...p, ...patch });
  const save = async () => { if (await saveProfile({ ...p, knownConcepts: toList(known), needsBackground: toList(needs) })) { /* keep open */ } };
  return (
    <Dialog title="Knowledge profile" wide footer={<><span className="muted small">Used to tailor explanations. Per-question depth never changes this profile.</span><span className="spacer" /><button className="btn primary" onClick={save}>Save profile</button></>}>
      <div className="grid2">
        <label className="field"><span>Academic & professional background</span><textarea rows={3} value={p.background} onChange={(e) => set({ background: e.target.value })} /></label>
        <label className="field"><span>Current research interests</span><textarea rows={3} value={p.researchInterests} onChange={(e) => set({ researchInterests: e.target.value })} /></label>
      </div>
      <div className="field">
        <span>Familiarity by domain</span>
        <table className="domains">
          <thead><tr><th>Domain</th><th>Level</th><th>Notes for the AI</th><th /></tr></thead>
          <tbody>
            {p.domains.map((d, i) => (
              <tr key={i}>
                <td><input value={d.name} onChange={(e) => { const ds = p.domains.slice(); ds[i] = { ...d, name: e.target.value }; set({ domains: ds }); }} /></td>
                <td><select value={d.level} onChange={(e) => { const ds = p.domains.slice(); ds[i] = { ...d, level: Number(e.target.value) }; set({ domains: ds }); }}>{LEVELS.map((l, k) => <option key={k} value={k}>{l}</option>)}</select></td>
                <td><input value={d.notes ?? ''} onChange={(e) => { const ds = p.domains.slice(); ds[i] = { ...d, notes: e.target.value }; set({ domains: ds }); }} /></td>
                <td><button className="link-btn" onClick={() => set({ domains: p.domains.filter((_, k) => k !== i) })} aria-label={`Remove ${d.name}`}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn small" onClick={() => set({ domains: [...p.domains, { name: '', level: 1 }] })}>+ Add domain</button>
      </div>
      <div className="grid2">
        <label className="field"><span>Concepts I already understand <em className="muted">(comma or newline separated — never auto-explained)</em></span><textarea rows={3} value={known} onChange={(e) => setKnown(e.target.value)} /></label>
        <label className="field"><span>Topics where I need more background</span><textarea rows={3} value={needs} onChange={(e) => setNeeds(e.target.value)} /></label>
      </div>
      <div className="grid2">
        <label className="field"><span>Explanation language</span>
          <select value={p.explanationLanguage} onChange={(e) => set({ explanationLanguage: e.target.value })}>
            <option value="Simplified Chinese">中文 (Simplified Chinese)</option>
            <option value="English">English</option>
          </select>
        </label>
        {p.explanationLanguage !== 'English' && <label className="field check"><input type="checkbox" checked={p.keepEnglishTerms} onChange={(e) => set({ keepEnglishTerms: e.target.checked })} /> Keep important English technical terms in English</label>}
      </div>
      <label className="field"><span>Preferred explanation style</span><textarea rows={2} value={p.style} onChange={(e) => set({ style: e.target.value })} /></label>
    </Dialog>
  );
}
