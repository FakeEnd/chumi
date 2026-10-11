import { useState } from 'react';
import { useStore } from '../store.ts';
import { startSession } from '../actions.ts';
import { SESSION_TYPES } from '../util.ts';
import { Dialog } from './Dialog.tsx';
import { WindowPicker } from './WindowPicker.tsx';
import type { WindowInfo } from '../types.ts';

export function StartDialog() {
  const settings = useStore((s) => s.settings);
  const devMode = useStore((s) => s.devMode);
  const samples = useStore((s) => s.samples);
  const helperBuilt = useStore((s) => s.helperBuilt);
  const [title, setTitle] = useState('');
  const [type, setType] = useState('lab_meeting');
  const [source, setSource] = useState<string>(settings?.audio.source ?? 'mic');
  const [file, setFile] = useState(samples[0]?.path ?? '');
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [capture, setCapture] = useState(false);
  const [win, setWin] = useState<WindowInfo | null>(null);
  const go = async () => {
    setBusy(true);
    await startSession({ title: title || `${SESSION_TYPES.find((t) => t.id === type)?.label} ${new Date().toLocaleDateString()}`, type, source, ...(source === 'file' ? { filePath: file, speed } : {}), window: capture && win ? { id: win.id, title: win.title, app: win.app } : null });
    setBusy(false);
  };
  return (
    <Dialog title="Start a session" footer={<><span className="spacer" /><button className="btn primary" disabled={busy || (source !== 'file' && !helperBuilt) || (capture && !win)} onClick={go}>{busy ? 'Starting…' : 'Start listening'}</button></>}>
      <label className="field"><span>Title</span><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Lab meeting — enhancer model" onKeyDown={(e) => e.key === 'Enter' && go()} /></label>
      <label className="field"><span>Session type</span>
        <select value={type} onChange={(e) => setType(e.target.value)}>{SESSION_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
      </label>
      <fieldset className="field">
        <span>Audio source</span>
        <div className="radio-list">
          <label><input type="radio" checked={source === 'mic'} onChange={() => setSource('mic')} /> <b>Microphone</b> — in-person meetings and lectures</label>
          <label><input type="radio" checked={source === 'system'} onChange={() => setSource('system')} /> <b>Computer audio</b> — Zoom/Teams/recorded lectures, works with headphones</label>
          <label><input type="radio" checked={source === 'both'} onChange={() => setSource('both')} /> <b>Both</b> — hybrid meetings (echo cancellation + duplicate filtering)</label>
          {devMode && <label><input type="radio" checked={source === 'file'} onChange={() => setSource('file')} /> <b>Audio file</b> — test/demo: stream a WAV through the live pipeline</label>}
        </div>
      </fieldset>
      {source === 'file' && (
        <div className="field-row">
          <label className="field grow"><span>File</span>
            <select value={file} onChange={(e) => setFile(e.target.value)}>{samples.map((s) => <option key={s.path} value={s.path}>{s.name} ({s.sizeMb} MB)</option>)}</select>
          </label>
          <label className="field"><span>Speed</span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[1, 2, 4, 8].map((x) => <option key={x} value={x}>{x}×</option>)}</select>
          </label>
        </div>
      )}
      <fieldset className="field">
        <label className="check-inline"><input type="checkbox" checked={capture} onChange={(e) => setCapture(e.target.checked)} /><span><b>Also capture a window</b>: Zoom/Teams screen share, a lecture video or slides, so answers can refer to what is shown</span></label>
        {capture && <WindowPicker value={win} onChange={setWin} />}
      </fieldset>
      {source !== 'file' && !helperBuilt && <p className="error-text">The native audio helper isn't built. Run <code>npm run build:native</code> in the project folder.</p>}
      <p className="muted small">Audio is transcribed on this Mac and is not uploaded. {settings?.audio.saveRawAudio ? 'Raw audio will be saved (Settings → Audio).' : 'Raw audio is not saved.'} The first time, macOS asks for Microphone and/or System Audio Recording permission.</p>
    </Dialog>
  );
}
