import { useEffect, useState } from 'react';
import { getState, setState, useStore } from '../store.ts';
import { startSession } from '../actions.ts';
import { DEFAULT_SESSION_TYPES } from '../../../shared/session-types.ts';
import { SessionTypeSelect } from './SessionTypes.tsx';
import { typeLabel } from '../util.ts';
import { locale, t, tn } from '../i18n.ts';
import { Dialog } from './Dialog.tsx';
import { onEnter } from '../keys.ts';
import { WindowPicker } from './WindowPicker.tsx';
import { ProjectSelect } from './Projects.tsx';
import { speechPrivacy } from '../speechSettings.ts';
import type { WindowInfo } from '../types.ts';

export function StartDialog() {
  const settings = useStore((s) => s.settings);
  const devMode = useStore((s) => s.devMode);
  const samples = useStore((s) => s.samples);
  const helperBuilt = useStore((s) => s.helperBuilt);
  const windows = useStore((s) => s.platform) === 'win32';
  const [draft, setDraft] = useState(() => {
    const s = getState();
    const draft = s.startDraft ?? { title: '', type: (settings?.sessionTypes ?? DEFAULT_SESSION_TYPES).find((o) => !o.archived)?.id ?? 'lab_meeting', source: settings?.audio.source ?? 'mic', file: samples[0]?.path ?? '', speed: 1, capture: false, win: null as WindowInfo | null, projectId: s.projects.some((p) => p.id === s.startProjectId && !p.archived_at) ? s.startProjectId : null, record: settings?.audio.saveRawAudio ?? false };
    const projectId = s.startProjectId ?? draft.projectId;
    return { ...draft, source: s.startSource ?? draft.source, projectId: s.projects.some((p) => p.id === projectId && !p.archived_at) ? projectId : null };
  });
  const { title, type, source, file, speed, capture, win, projectId, record } = draft;
  const [busy, setBusy] = useState(false);
  useEffect(() => { setState({ startDraft: draft, startProjectId: null, startSource: null }); }, [draft]);
  const blocked = busy || (source !== 'file' && !helperBuilt) || (capture && !win);
  const go = async () => {
    if (blocked) return;
    setBusy(true);
    await startSession({ title: title || `${typeLabel(type)} ${new Date().toLocaleDateString(locale())}`, type, source, ...(source === 'file' ? { filePath: file, speed } : {}), window: capture && win ? { id: win.id, title: win.title, app: win.app } : null, project_id: projectId, record_audio: record });
    setBusy(false);
  };
  return (
    <Dialog title={t('Start a session')} footer={<><span className="spacer" /><button className="btn primary" disabled={blocked} onClick={go}>{busy ? t('Starting…') : t('Start listening')}</button></>}>
      <label className="field"><span>{t('Title')}</span><input autoFocus value={title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder={t('e.g. Lab meeting: enhancer model')} onKeyDown={onEnter(go)} /></label>
      <label className="field"><span>{t('Session type')}</span>
        <SessionTypeSelect manage value={type} onChange={(type) => setDraft({ ...draft, type })} />
      </label>
      <label className="field"><span>{t('Project (optional): the folder where this work continues in your coding agent')}</span>
        <ProjectSelect value={projectId} onChange={(projectId) => setDraft({ ...draft, projectId })} />
      </label>
      <fieldset className="field">
        <legend>{t('Audio source')}</legend>
        <div className="radio-list">
          <label><input type="radio" checked={source === 'mic'} onChange={() => setDraft({ ...draft, source: 'mic' })} /> <b>{t('Microphone')}</b>: {t('in-person meetings and lectures')}</label>
          <label><input type="radio" checked={source === 'system'} onChange={() => setDraft({ ...draft, source: 'system' })} /> <b>{t('Computer audio')}</b>: {t('Zoom/Teams/recorded lectures, works with headphones')}</label>
          <label><input type="radio" checked={source === 'both'} onChange={() => setDraft({ ...draft, source: 'both' })} /> <b>{t('Both')}</b>: {windows ? t('hybrid meetings (microphone + computer audio, with duplicate filtering)') : t('hybrid meetings (echo cancellation + duplicate filtering)')}</label>
          {devMode && <label><input type="radio" checked={source === 'file'} onChange={() => setDraft({ ...draft, source: 'file' })} /> <b>{t('Audio file')}</b>: {t('test/demo: stream a WAV through the live pipeline')}</label>}
        </div>
      </fieldset>
      {source === 'file' && (
        <div className="field-row">
          <label className="field grow"><span>{t('File')}</span>
            <select value={file} onChange={(e) => setDraft({ ...draft, file: e.target.value })}>{samples.map((s) => <option key={s.path} value={s.path}>{s.name} ({s.sizeMb} MB)</option>)}</select>
          </label>
          <label className="field"><span>{t('Speed')}</span>
            <select value={speed} onChange={(e) => setDraft({ ...draft, speed: Number(e.target.value) })}>{[1, 2, 4, 8].map((x) => <option key={x} value={x}>{x}×</option>)}</select>
          </label>
        </div>
      )}
      <fieldset className="field">
        <label className="check-inline"><input type="checkbox" checked={capture} onChange={(e) => setDraft({ ...draft, capture: e.target.checked })} /><span><b>{t('Also capture a window')}</b>: {t('Zoom/Teams screen share, a lecture video or slides, so answers can refer to what is shown')}</span></label>
        {capture && <WindowPicker value={win} onChange={(win) => setDraft({ ...draft, win })} />}
      </fieldset>
      <fieldset className="field">
        <label className="check-inline"><input type="checkbox" checked={record} onChange={(e) => setDraft({ ...draft, record: e.target.checked })} /><span><b>{t('Record audio')}</b>: {t('keep the audio on this computer to play it back from any line and export it (about 115 MB per hour per source)')}</span></label>
      </fieldset>
      {source !== 'file' && !helperBuilt && (windows
        ? <p className="error-text">{t('The audio component is missing. Reinstall Chumi to restore it.')}</p>
        : <p className="error-text">{tn("The native audio helper isn't built. Run {cmd} in the project folder.", { cmd: <code>npm run build:native</code> })}</p>)}
      <p className="muted small">{speechPrivacy(settings?.asr)} {windows ? t('Allow desktop apps to access your microphone in Windows Settings. For hybrid meetings, headphones reduce speaker echo.') : t('The first time, macOS asks for Microphone and/or System Audio Recording permission.')}</p>
    </Dialog>
  );
}
