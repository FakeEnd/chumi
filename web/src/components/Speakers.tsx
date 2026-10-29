import { useEffect, useState } from 'react';
import type { Speaker, SpeakerAnalysisStatus, SpeakerRuntime, SpeakerView } from '../../../shared/speakers.ts';
import { analyzeSpeakers, cancelSpeakers, correctSpeaker, refreshSpeakers, renameSpeaker, saveSettings } from '../actions.ts';
import { api } from '../api.ts';
import { msg, t, tn } from '../i18n.ts';
import { setState, useStore } from '../store.ts';
import type { Segment } from '../types.ts';
import { sourceLabel } from '../util.ts';

const STATUS: Record<SpeakerAnalysisStatus, string> = {
  not_run: msg('Not analyzed'), queued: msg('Waiting to label speakers…'), running: msg('Labeling speakers locally…'),
  done: msg('Speaker labeling complete'), failed: msg('Speaker labeling failed'), cancelled: msg('Speaker labeling cancelled'),
};
const labelOf = (label: string) => /^[A-Z]+$/.test(label) ? t('Speaker {label}', { label }) : label;
const displaySpeaker = (speaker: Speaker) => speaker.name ? `${speaker.name} · ${labelOf(speaker.label)}` : labelOf(speaker.label);
const errorText = (error: unknown) => error instanceof Error ? error.message : t('Could not update speaker labels.');

function RuntimeSetup({ runtime }: { runtime: SpeakerRuntime }) {
  const windowsApp = useStore((s) => s.appMode && s.platform === 'win32');
  if (windowsApp && !runtime.ready) return <p className="small warn-text">{t('Speaker labels are not available in the Windows app yet.')}</p>;
  return <>
    <p className={runtime.ready ? 'small ok-text' : 'small warn-text'}>{runtime.ready ? t('Local speaker model is ready.') : t('Local speaker labeling is not ready.')}</p>
    {!runtime.ready && <>
      {runtime.reason && <p className="small muted">{t(runtime.reason)}</p>}
      <p className="small">{tn('Run {command} in the Chumi folder, then refresh this status. Setup installs the local runtime and downloads its model.', { command: <code>{runtime.setupCommand}</code> })}</p>
    </>}
  </>;
}

export function SpeakerSettings() {
  const enabled = useStore((s) => !!s.settings?.asr.diarization);
  const liveStatus = useStore((s) => s.live?.status);
  const recording = !!liveStatus && liveStatus !== 'idle';
  const [runtime, setRuntime] = useState<SpeakerRuntime | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setBusy(true); setError('');
    try { setRuntime(await api<SpeakerRuntime>('/api/speakers/runtime')); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const toggle = async (next: boolean) => {
    setSaving(true);
    try { await saveSettings({ asr: { diarization: next } }); }
    finally { setSaving(false); }
  };
  return <section className="speaker-settings">
    <h3>{t('Speaker labels')}</h3>
    <label className="field check"><input type="checkbox" checked={enabled} disabled={saving || recording || (!enabled && (busy || !runtime?.ready))} onChange={(e) => void toggle(e.target.checked)} />{t('Automatically label speakers after each meeting (local, optional)')}</label>
    <p className="small muted">{t('Creates Speaker A, B, C labels within each meeting and audio source. It does not identify people or guess their real names; you can add names and correct individual lines.')}</p>
    <p className="small muted">{t('When enabled before recording, Chumi saves temporary audio locally for speaker analysis. It deletes that audio after analysis, failure or cancellation unless the session records audio.')}</p>
    {recording && <p className="small muted">{t('End the current recording before changing automatic speaker labeling.')}</p>}
    {runtime && <RuntimeSetup runtime={runtime} />}
    <button type="button" className="btn small" disabled={busy} onClick={() => void load()}>{busy ? t('Checking…') : t('Refresh speaker model status')}</button>
    {error && <p className="small error-text" role="alert">{t(error)}</p>}
  </section>;
}

function SpeakerName({ speaker, disabled }: { speaker: Speaker; disabled: boolean }) {
  const [name, setName] = useState(speaker.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setName(speaker.name ?? ''); setError(''); }, [speaker.id, speaker.name]);
  const save = async () => {
    setBusy(true); setError('');
    try { await renameSpeaker(speaker.session_id, speaker.id, name.trim() || null); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return <li>
    <form className="speaker-name-row" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label><span>{labelOf(speaker.label)} <span className="muted small">· {sourceLabel(speaker.source)}</span></span>
        <input value={name} maxLength={80} disabled={disabled || busy} placeholder={t('Name (optional)')} aria-label={t('Name for {speaker}', { speaker: labelOf(speaker.label) })} onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="submit" className="btn small" disabled={disabled || busy || name.trim() === (speaker.name ?? '')}>{busy ? t('Saving…') : t('Save')}</button>
    </form>
    {error && <p className="small error-text" role="alert">{t(error)}</p>}
  </li>;
}

export function SpeakersPanel() {
  const data = useStore((s) => s.data);
  const live = useStore((s) => s.live);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sessionId = data?.session.id;
  const view = data?.speakerView;
  useEffect(() => {
    setError(''); setBusy(false);
    if (!sessionId || view) return;
    let active = true;
    void refreshSpeakers(sessionId).catch((e: unknown) => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [sessionId]);
  const labelingOn = useStore((s) => !!s.settings?.asr.diarization);
  if (!data) return null;
  const analyzing = view?.analysis.status === 'queued' || view?.analysis.status === 'running';
  const activeSession = !!live && live.session?.id === data.session.id && live.status !== 'idle';
  // Nothing to show or run: a meeting recorded without speaker labels, by someone who doesn't use them.
  if (view && view.analysis.status === 'not_run' && !view.speakers.length && !view.audioAvailable && !(activeSession && labelingOn)) return null;
  const run = async (action: 'analyze' | 'cancel' | 'refresh') => {
    setBusy(true); setError('');
    try {
      if (action === 'analyze') await analyzeSpeakers(data.session.id);
      else if (action === 'cancel') await cancelSpeakers(data.session.id);
      else await refreshSpeakers(data.session.id);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return <details className="speakers-panel">
    <summary><b>{t('Speakers')}</b><span className="small muted" role="status">{view ? t(STATUS[view.analysis.status]) : error ? t('Speaker status unavailable') : t('Loading…')}</span></summary>
    <div className="speakers-body">
      {view && <>
        <p className="small muted">{t('Speaker labels are estimates within this meeting and audio source. Review them before attributing a statement to someone.')}</p>
        {analyzing && <progress aria-label={t('Speaker labeling in progress')} />}
        {view.analysis.error && <p className="small error-text" role="alert">{t(view.analysis.error)}</p>}
        {!analyzing && !view.runtime.ready && <p className="small warn-text">{t('Set up the local speaker model in Settings → Transcription.')}{view.runtime.reason ? ` ${t(view.runtime.reason)}` : ''}</p>}
        {!analyzing && !activeSession && !view.audioAvailable && <p className="small muted">{t('No local audio is available for analysis or retry. Enable speaker labeling before your next recording, or turn on “Record audio” if you need to rerun it.')}</p>}
        {activeSession && <p className="small muted">{t('Automatic speaker analysis runs after the recording ends.')}</p>}
        {!analyzing && !activeSession && view.runtime.ready && view.audioAvailable && !view.canRun && <p className="small muted">{t('Speaker analysis cannot run for this session right now.')}</p>}
        <div className="btn-row">
          {analyzing ? <button type="button" className="btn small" disabled={busy} onClick={() => void run('cancel')}>{t('Cancel speaker analysis')}</button>
            : <button type="button" className="btn small" disabled={busy || !view.canRun || !!activeSession} onClick={() => void run('analyze')}>{view.analysis.status === 'not_run' ? t('Label speakers') : t('Run speaker analysis again')}</button>}
          <button type="button" className="btn small" disabled={busy} onClick={() => void run('refresh')}>{t('Refresh')}</button>
          {!view.runtime.ready && <button type="button" className="link-btn small" onClick={() => setState({ dialog: 'settings', settingsTab: 'asr' })}>{t('Open Transcription settings')}</button>}
        </div>
        {!!view.speakers.length && <>
          <ul className="speaker-names">{view.speakers.map((speaker) => <SpeakerName key={speaker.id} speaker={speaker} disabled={!!analyzing} />)}</ul>
          <p className="small muted">{t('Clear a name to return to its letter label. New summaries and handoffs use the current labels; review or regenerate older outputs after corrections.')}</p>
        </>}
      </>}
      {!view && <button type="button" className="btn small" disabled={busy} onClick={() => void run('refresh')}>{t('Refresh')}</button>}
      {error && <p className="small error-text" role="alert">{t(error)}</p>}
    </div>
  </details>;
}

export function SpeakerControl({ segment, view }: { segment: Segment; view: SpeakerView }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const speaker = view.speakers.find((s) => s.id === segment.speaker_id);
  const label = segment.speaker_state === 'mixed' ? t('Mixed speakers')
    : segment.speaker_state === 'assigned' ? speaker?.name || labelOf(speaker?.label ?? segment.speaker_label ?? '?') : t('Unknown speaker');
  const value = segment.speaker_origin !== 'manual' ? 'automatic' : segment.speaker_id ? `speaker:${segment.speaker_id}` : 'unknown';
  const analyzing = view.analysis.status === 'queued' || view.analysis.status === 'running';
  const change = async (next: string) => {
    setBusy(true); setError('');
    try {
      await correctSpeaker(segment.session_id, segment.id, next.startsWith('speaker:') ? { mode: 'speaker', speakerId: next.slice(8) } : { mode: next as 'automatic' | 'unknown' });
      setEditing(false);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return <span className="speaker-control" onMouseUp={(e) => e.stopPropagation()}>
    <button type="button" className={`speaker-tag${segment.speaker_origin === 'manual' ? ' manual' : ''}`} disabled={analyzing} aria-expanded={editing} title={segment.speaker_origin === 'manual' ? t('Manually corrected. Click to change the speaker for this line.') : t('Correct the speaker for this line')} onClick={() => setEditing((open) => !open)}>{label}{segment.speaker_origin === 'manual' ? ' *' : ''}</button>
    {editing && <span className="speaker-correction">
      <label><span className="small">{t('Speaker for this line')}</span><select autoFocus value={value} disabled={busy} onChange={(e) => void change(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}>
        <option value="automatic">{t('Use automatic assignment')}</option>
        <option value="unknown">{t('Unknown speaker')}</option>
        {view.speakers.filter((s) => s.source === segment.source).map((s) => <option key={s.id} value={`speaker:${s.id}`}>{displaySpeaker(s)}</option>)}
      </select></label>
      <button type="button" className="link-btn small" disabled={busy} onClick={() => setEditing(false)}>{t('Close')}</button>
      {error && <span className="small error-text" role="alert">{t(error)}</span>}
    </span>}
  </span>;
}
