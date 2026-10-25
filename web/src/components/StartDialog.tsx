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
  const [title, setTitle] = useState('');
  const [type, setType] = useState(() => (settings?.sessionTypes ?? DEFAULT_SESSION_TYPES).find((o) => !o.archived)?.id ?? 'lab_meeting');
  const [source, setSource] = useState<string>(settings?.audio.source ?? 'mic');
  const [file, setFile] = useState(samples[0]?.path ?? '');
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [capture, setCapture] = useState(false);
  const [win, setWin] = useState<WindowInfo | null>(null);
  const [projectId, setProjectId] = useState<string | null>(() => {
    const s = getState();
    return s.projects.some((p) => p.id === s.startProjectId && !p.archived_at) ? s.startProjectId : null;
  });
  useEffect(() => { setState({ startProjectId: null }); }, []);
  const [record, setRecord] = useState(settings?.audio.saveRawAudio ?? false);
  const blocked = busy || (source !== 'file' && !helperBuilt) || (capture && !win);
  const go = async () => {
    if (blocked) return;
    setBusy(true);
    await startSession({ title: title || `${typeLabel(type)} ${new Date().toLocaleDateString(locale())}`, type, source, ...(source === 'file' ? { filePath: file, speed } : {}), window: capture && win ? { id: win.id, title: win.title, app: win.app } : null, project_id: projectId, record_audio: record });
    setBusy(false);
  };
  return (
    <Dialog title={t('Start a session')} footer={<><span className="spacer" /><button className="btn primary" disabled={blocked} onClick={go}>{busy ? t('Starting…') : t('Start listening')}</button></>}>
      <label className="field"><span>{t('Title')}</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('e.g. Lab meeting: enhancer model')} onKeyDown={onEnter(go)} /></label>
      <label className="field"><span>{t('Session type')}</span>
        <SessionTypeSelect value={type} onChange={setType} />
      </label>
      <label className="field"><span>{t('Project (optional): the folder where this work continues in your coding agent')}</span>
        <ProjectSelect value={projectId} onChange={setProjectId} />
      </label>
      <fieldset className="field">
        <span>{t('Audio source')}</span>
        <div className="radio-list">
          <label><input type="radio" checked={source === 'mic'} onChange={() => setSource('mic')} /> <b>{t('Microphone')}</b>: {t('in-person meetings and lectures')}</label>
          <label><input type="radio" checked={source === 'system'} onChange={() => setSource('system')} /> <b>{t('Computer audio')}</b>: {t('Zoom/Teams/recorded lectures, works with headphones')}</label>
          <label><input type="radio" checked={source === 'both'} onChange={() => setSource('both')} /> <b>{t('Both')}</b>: {windows ? t('hybrid meetings (microphone + computer audio, with duplicate filtering)') : t('hybrid meetings (echo cancellation + duplicate filtering)')}</label>
          {devMode && <label><input type="radio" checked={source === 'file'} onChange={() => setSource('file')} /> <b>{t('Audio file')}</b>: {t('test/demo: stream a WAV through the live pipeline')}</label>}
        </div>
      </fieldset>
      {source === 'file' && (
        <div className="field-row">
          <label className="field grow"><span>{t('File')}</span>
            <select value={file} onChange={(e) => setFile(e.target.value)}>{samples.map((s) => <option key={s.path} value={s.path}>{s.name} ({s.sizeMb} MB)</option>)}</select>
          </label>
          <label className="field"><span>{t('Speed')}</span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[1, 2, 4, 8].map((x) => <option key={x} value={x}>{x}×</option>)}</select>
          </label>
        </div>
      )}
      <fieldset className="field">
        <label className="check-inline"><input type="checkbox" checked={capture} onChange={(e) => setCapture(e.target.checked)} /><span><b>{t('Also capture a window')}</b>: {t('Zoom/Teams screen share, a lecture video or slides, so answers can refer to what is shown')}</span></label>
        {capture && <WindowPicker value={win} onChange={setWin} />}
      </fieldset>
      <fieldset className="field">
        <label className="check-inline"><input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} /><span><b>{t('Record audio')}</b>: {t('keep the audio on this computer to play it back from any line and export it (about 115 MB per hour per source)')}</span></label>
      </fieldset>
      {source !== 'file' && !helperBuilt && (windows
        ? <p className="error-text">{t('The audio component is missing. Reinstall Chumi to restore it.')}</p>
        : <p className="error-text">{tn("The native audio helper isn't built. Run {cmd} in the project folder.", { cmd: <code>npm run build:native</code> })}</p>)}
      <p className="muted small">{speechPrivacy(settings?.asr)} {windows ? t('Allow desktop apps to access your microphone in Windows Settings. For hybrid meetings, headphones reduce speaker echo.') : t('The first time, macOS asks for Microphone and/or System Audio Recording permission.')}</p>
    </Dialog>
  );
}
