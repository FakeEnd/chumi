import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.ts';
import { saveSettings } from '../actions.ts';
import { msg, t } from '../i18n.ts';
import { petShell } from '../shell.ts';
import { TAGS, TOPICS, type Topic } from '../pet/tags.ts';
import type { Settings } from '../types.ts';

const LABEL: Record<Topic, string> = { meeting: msg('Meeting'), tangent: msg('Tangent'), background: msg('Background'), summary: msg('Summary'), chatter: msg('Chatter') };
const TIP: Record<Topic, string> = {
  meeting: msg('Catch-ups and questions about the meeting discussion'), tangent: msg('Questions that go beyond the meeting discussion'),
  background: msg('Explanations and automatic background cards'), summary: msg('The final summary'), chatter: msg('Greetings and reactions: hello, listening, a pat on the head'),
};

/** Tag chips like the filter above Chumi's cards: pressed = shown. */
function Chips<T extends Topic>({ all, on, label, onChange }: { all: readonly T[]; on: T[]; label: string; onChange: (next: T[]) => void }) {
  return (
    <div className="card-filter" role="group" aria-label={label}>
      {all.map((k) => (
        <button type="button" key={k} className={`filter-chip chip-${k}`} aria-pressed={on.includes(k)} title={t(TIP[k])}
          onClick={() => onChange(on.includes(k) ? on.filter((x) => x !== k) : all.filter((x) => x === k || on.includes(x)))}>
          <span className="dot" aria-hidden="true" />{t(LABEL[k])}
        </button>
      ))}
    </div>
  );
}

const sizePercent = (value: string): number | null => {
  const n = Number(value);
  return value.trim() && Number.isFinite(n) ? Math.min(200, Math.max(50, Math.round(n / 5) * 5)) : null;
};

/** Settings → Desktop pet: the small Chumi that floats on the desktop in Chumi.app (docs/desktop-pet.md). */
export function PetSettings() {
  const pet = useStore((s) => s.settings!.pet);
  const app = useStore((s) => s.appMode && (s.platform === 'darwin' || s.platform === 'win32'));
  const windows = useStore((s) => s.platform === 'win32');
  const [moved, setMoved] = useState(false);
  const [pct, setPct] = useState(Math.round(pet.size * 100));
  const [sizeDraft, setSizeDraft] = useState(String(pct));
  const sizeFocused = useRef(false);
  const sizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sizeEdit = useRef({ value: sizeDraft, dirty: false, pending: null as number | null, saved: pet.size });
  sizeEdit.current.saved = pet.size;
  const S = (patch: Partial<Settings['pet']>) => void saveSettings({ pet: patch });
  useEffect(() => {
    const n = Math.round(pet.size * 100), edit = sizeEdit.current;
    if (edit.pending !== null) return;
    setPct(n);
    if (!sizeFocused.current && !edit.dirty) { edit.value = String(n); setSizeDraft(edit.value); }
  }, [pet.size]);
  const saveSize = (n: number) => {
    clearTimeout(sizeTimer.current);
    sizeEdit.current.pending = null;
    if (n / 100 !== sizeEdit.current.saved) S({ size: n / 100 });
  };
  // Closing Settings can remove the focused field before blur, or before the slider's timer fires.
  useEffect(() => () => {
    clearTimeout(sizeTimer.current);
    const edit = sizeEdit.current, n = edit.dirty ? sizePercent(edit.value) : null;
    if (n !== null) saveSize(n); else if (edit.pending !== null) saveSize(edit.pending);
  }, []);
  const changeSize = (n: number, debounce: boolean) => {
    clearTimeout(sizeTimer.current);
    const edit = sizeEdit.current;
    edit.value = String(n); edit.dirty = false; edit.pending = n;
    setPct(n); setSizeDraft(String(n));
    if (debounce && n / 100 !== edit.saved) sizeTimer.current = setTimeout(() => saveSize(n), 350);
    else saveSize(n);
  };
  const commitSize = () => {
    sizeFocused.current = false;
    const edit = sizeEdit.current, n = edit.dirty ? sizePercent(edit.value) : null;
    if (n !== null) changeSize(n, false);
    else {
      edit.value = String(pct); edit.dirty = false; setSizeDraft(edit.value);
      if (edit.pending !== null) saveSize(edit.pending);
    }
  };
  return (
    <section>
      <p className="small">{t('A small Chumi in the corner of your screen, above other windows. From its toolbar you start, pause or end a meeting, catch up and ask, and its cards show the latest answers, so you can follow along without leaving your call.')}</p>
      {!app && <p className="small warn-text">{t('The desktop pet is part of the Chumi desktop app on macOS and Windows. These settings apply there.')}</p>}
      <label className="field check"><input type="checkbox" checked={pet.enabled} onChange={(e) => S({ enabled: e.target.checked })} /> {t('Show the desktop pet')}</label>

      <fieldset className="field" disabled={!pet.enabled}>
        <span>{t('Size')}</span>
        <div className="field-row" style={{ alignItems: 'center', marginBottom: 0 }}>
          <input type="range" min={50} max={200} step={5} value={pct} onChange={(e) => changeSize(Number(e.target.value), true)} aria-label={t('Size')} style={{ flex: 1 }} />
          <input type="number" min={50} max={200} step={5} value={sizeDraft} onFocus={() => { sizeFocused.current = true; }} onChange={(e) => { sizeEdit.current.value = e.target.value; sizeEdit.current.dirty = true; setSizeDraft(e.target.value); }} onBlur={commitSize} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} aria-label={t('Size in percent')} style={{ width: 72, flex: 'none' }} />
          <span>%</span>
          {pct !== 100 && <button type="button" className="btn small" onClick={() => changeSize(100, false)}>{t('Reset')}</button>}
        </div>
      </fieldset>

      <fieldset className="field" disabled={!pet.enabled}>
        <span>{t('Show under the pet')}</span>
        <label className="field check"><input type="checkbox" checked={pet.toolbar} onChange={(e) => S({ toolbar: e.target.checked })} /> {t('Toolbar: quick start, pause, catch up, ask and end')}</label>
        <select value={pet.cards} onChange={(e) => S({ cards: e.target.value as Settings['pet']['cards'] })} aria-label={t('Answer cards')}>
          <option value="latest">{t('Cards: the latest answer')}</option>
          <option value="recent">{t('Cards: the recent answers')}</option>
          <option value="none">{t('Cards: none')}</option>
        </select>
        <p className="small muted" style={{ margin: 0 }}>{t('Cards show during a meeting. Without one, ⌄ on the toolbar shows the last meeting’s.')}</p>
        {pet.cards !== 'none' && <Chips all={TAGS} on={pet.tags} label={t('Cards by tag')} onChange={(tags) => S({ tags })} />}
      </fieldset>

      <fieldset className="field" disabled={!pet.enabled}>
        <span>{t('Speech bubbles')}</span>
        <Chips all={TOPICS} on={pet.say} label={t('Speech bubbles by tag')} onChange={(say) => S({ say })} />
        <p className="small muted" style={{ margin: 0 }}>{t('It always tells you when something fails.')}</p>
      </fieldset>

      <label className="field check"><input type="checkbox" checked={pet.inRecordings} disabled={!pet.enabled} onChange={(e) => S({ inRecordings: e.target.checked })} /> {t('Show the pet in screen shares and recordings')}</label>
      <p className="small muted">{t('Off by default, so a screen you share in a meeting does not show what you asked Chumi. Some newer capture tools may still show it.')}</p>

      <label className="field check"><input type="checkbox" checked={pet.lowKey} disabled={!pet.enabled} onChange={(e) => S({ lowKey: e.target.checked })} /> {t('Low-key while recording')}</label>
      <p className="small muted">{t('During recording, only the pet’s look changes: idle pose with a soft star glow to show it’s listening, no sound bars, note-taking animation or announcements, and plain icons (hover for details). While the pet is shown, start/pause/resume notifications are skipped; continue handoffs from Chumi’s window. Recording, transcription and the system microphone indicator stay unchanged; recording people still needs their consent.')}</p>

      {app && <p><button type="button" className="btn small" disabled={!pet.enabled} onClick={() => setMoved(petShell('pet-reset'))}>{t('Move it back to the corner')}</button>{moved && <span className="small muted"> {t('Done.')}</span>}</p>}
      <ul className="small muted">
        <li>{windows ? t('Press Alt to show the menu bar, then choose 窗口 → 桌宠.') : t('Also in the menu bar: Window → Desktop Pet.')}</li>
        <li>{t('Right-click the pet for Catch Me Up, Open Chumi, Pet Only and Hide. Drag it by the character to move it.')}</li>
      </ul>
    </section>
  );
}
