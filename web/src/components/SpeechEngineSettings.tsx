import { useEffect, useReducer, useRef, useState } from 'react';
import { getState, useStore } from '../store.ts';
import { saveSettings } from '../actions.ts';
import { api } from '../api.ts';
import { msg, t } from '../i18n.ts';
import type { SpeechEngineId } from '../types.ts';
import { endpointDirty, endpointDraftReducer, newEndpointDraft, type SpeechEndpoint } from '../endpointDraft.ts';
import { speechSettingsBusy } from '../speechSettings.ts';

type KeyedEngine = 'elevenlabs' | 'qwen-cloud';
interface EngineStatus { keys: Record<KeyedEngine, boolean>; fallback: boolean }

const ENGINES: { id: SpeechEngineId; name: string; note: string; cloud: string | null }[] = [
  { id: 'qwen3', name: msg('Qwen3-ASR (this computer, recommended)'), cloud: null,
    note: msg('Free and private. Recognizes Mandarin and English on this computer with Qwen3-ASR 0.6B int8. Download its model below; Whisper takes over until it is ready.') },
  { id: 'whisper', name: msg('Whisper (this computer)'), cloud: null,
    note: msg('Free and private: audio never leaves this computer. Uses the speech model chosen below.') },
  { id: 'elevenlabs', name: msg('ElevenLabs Scribe'), cloud: 'ElevenLabs',
    note: msg('Cloud service, accurate in English, Mandarin and many other languages. ElevenLabs bills per hour of audio; vocabulary hints add 20%.') },
  { id: 'qwen-cloud', name: msg('Qwen3-ASR (Alibaba Cloud)'), cloud: 'Alibaba Cloud',
    note: msg('Alibaba Cloud Model Studio. Strong on Mandarin, Chinese dialects and mixed Chinese–English speech. Alibaba Cloud bills by the length of the audio.') },
  { id: 'qwen-local', name: msg('Qwen3-ASR (self-hosted)'), cloud: null,
    note: msg('The open Qwen3-ASR model on a server you run, for example qwen-asr-serve on a computer with an NVIDIA GPU.') },
];

const REGIONS: { label: string; url: string }[] = [
  { label: msg('Singapore (international)'), url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  { label: msg('Beijing (mainland China)'), url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
];
const isPreset = (url: string) => REGIONS.some((r) => r.url === url);
const isLoopback = (url: string) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return true; } };

function useEndpointDraft(key: 'qwenCloud' | 'qwenLocal', saved: SpeechEndpoint) {
  const [state, dispatch] = useReducer(endpointDraftReducer, saved, newEndpointDraft);
  const pending = useRef(false);
  useEffect(() => dispatch({ type: 'saved', value: saved }), [saved.baseUrl, saved.model]);
  const save = async () => {
    if (pending.current || speechSettingsBusy(getState().live)) return;
    pending.current = true;
    dispatch({ type: 'submit', value: state.value });
    try {
      const accepted = await saveSettings({ asr: { [key]: state.value } });
      dispatch({ type: 'settled', value: accepted ? getState().settings?.asr[key] ?? null : null });
    } finally { pending.current = false; }
  };
  return {
    value: state.value, dirty: endpointDirty(state.value, saved), saving: state.submitted !== null, save,
    edit: (value: SpeechEndpoint) => dispatch({ type: 'edit', value }),
    discard: () => dispatch({ type: 'discard' }),
  };
}

function KeyField({ engine, stored, onChange }: { engine: KeyedEngine; stored: boolean; onChange: () => void }) {
  const windows = useStore((s) => s.platform) === 'win32';
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (remove: boolean) => {
    setBusy(true); setError('');
    try {
      await api(`/api/asr/engines/${engine}/key`, remove ? { method: 'DELETE' } : { body: { key: key.trim() } });
      setKey(''); onChange();
    } catch (e) { setError(e instanceof Error ? e.message : t('Could not update the API key.')); }
    finally { setBusy(false); }
  };
  return (
    <div className="field">
      <span>{t('API key')}</span>
      <div className="btn-row key-row">
        <input type="password" aria-label={t('API key')} autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)}
          placeholder={stored ? t('A key is saved. Enter a new one to replace it.') : windows ? t('Encrypted for your Windows account') : t('Stored in macOS Keychain')} />
        <button type="button" className="btn small" disabled={busy || !key.trim()} onClick={() => void act(false)}>{busy ? t('Saving…') : t('Save key')}</button>
        {stored && <button type="button" className="btn small ghost" disabled={busy} onClick={() => void act(true)}>{t('Remove key')}</button>}
      </div>
      {error && <span className="hint-line error-text">{t(error)}</span>}
    </div>
  );
}

/** Which engine turns meeting audio into text: local Qwen3-ASR, Whisper, or a speech service (server/asr/engines.ts). */
export function SpeechEngineSettings() {
  const settings = useStore((s) => s.settings)!;
  const live = useStore((s) => s.live);
  const asr = live?.asr;
  const busySession = speechSettingsBusy(live);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const cloudDraft = useEndpointDraft('qwenCloud', settings.asr.qwenCloud);
  const { value: cloud, edit: setCloud, dirty: cloudDirty } = cloudDraft;
  const [customAddr, setCustomAddr] = useState(!isPreset(settings.asr.qwenCloud.baseUrl));
  const localDraft = useEndpointDraft('qwenLocal', settings.asr.qwenLocal);
  const { value: local, edit: setLocal, dirty: localDirty } = localDraft;
  const saving = cloudDraft.saving || localDraft.saving;
  const active = settings.asr.engine;
  // Settings stay folded away unless the engine in use needs attention.
  const [open, setOpen] = useState<SpeechEngineId | null>(asr?.state === 'error' || asr?.state === 'missing_key' ? active : null);
  const load = () => void api<EngineStatus>('/api/asr/engines').then(setStatus).catch(() => {});
  useEffect(load, [settings.asr.engine, settings.asr.model]);
  const resetCloud = () => { cloudDraft.discard(); setCustomAddr(!isPreset(settings.asr.qwenCloud.baseUrl)); };
  useEffect(() => {
    if (cloud.baseUrl === settings.asr.qwenCloud.baseUrl) setCustomAddr(!isPreset(cloud.baseUrl));
  }, [cloud.baseUrl, settings.asr.qwenCloud.baseUrl]);

  const use = (e: (typeof ENGINES)[number]) => {
    if (speechSettingsBusy(getState().live) || saving) return;
    const where = e.cloud ?? (e.id === 'qwen-local' && !isLoopback(settings.asr.qwenLocal.baseUrl) ? settings.asr.qwenLocal.baseUrl : null);
    if (where && !confirm(t('While you record, meeting audio is sent to {service} to be transcribed. Continue?', { service: where }))) return;
    void saveSettings({ asr: { engine: e.id } });
  };
  const ready = (id: SpeechEngineId) => id === 'qwen3' || id === 'whisper' || id === 'qwen-local' || !!status?.keys[id as KeyedEngine];
  const dirty = (id: SpeechEngineId) => (id === 'qwen-cloud' && cloudDirty) || (id === 'qwen-local' && localDirty);

  return (
    <>
      <h3>{t('Speech recognition engine')}</h3>
      <ul className="model-list">
        {ENGINES.map((e) => {
          const known = e.id === 'qwen3' || e.id === 'whisper' || e.id === 'qwen-local' || !!status;
          const expanded = open === e.id || dirty(e.id);
          return (
            <li key={e.id} className={`model-row engine-row ${active === e.id ? 'active' : ''}`}>
              <div className="engine-head">
                <div className="model-name">
                  <b>{t(e.name)}</b>
                  {active === e.id && <span className="tag tag-ok">{t('In use')}</span>}
                  {e.cloud && <span className="tag tag-warn">{t('Sends audio to {service}', { service: e.cloud })}</span>}
                  {(e.id === 'qwen3' || e.id === 'whisper') && <span className="tag tag-muted">{t('Private')}</span>}
                </div>
                {known && <div className="model-actions">
                  {e.id !== 'whisper' && e.id !== 'qwen3' && (
                    <button type="button" className={`btn small disclosure ${ready(e.id) ? 'ghost' : ''}`} aria-expanded={expanded} disabled={dirty(e.id) || saving}
                      title={dirty(e.id) ? t('Save or discard the changes first.') : ''} onClick={() => setOpen(expanded ? null : e.id)}>
                      {ready(e.id) ? t('Settings') : t('Set up')}
                    </button>
                  )}
                  {active !== e.id && ready(e.id) && (
                    <button type="button" className="btn small primary" disabled={busySession || dirty(e.id) || saving}
                      title={busySession ? t('End the current session before changing the speech recognition engine.') : ''}
                      onClick={() => use(e)}>{t('Use')}</button>
                  )}
                </div>}
              </div>
              <div className="muted small">{t(e.note)}</div>
              {active === e.id && e.id !== 'whisper' && (asr?.state === 'error' || asr?.state === 'missing_key' || asr?.state === 'missing_model') && asr.message && <div className="small warn-text" role="status">{t(asr.message)}</div>}
              {expanded && e.id === 'elevenlabs' && status && (
                <div className="engine-settings">
                  <KeyField engine="elevenlabs" stored={status.keys.elevenlabs} onChange={load} />
                </div>
              )}
              {expanded && e.id === 'qwen-cloud' && status && (
                <div className="engine-settings">
                  <KeyField engine="qwen-cloud" stored={status.keys['qwen-cloud']} onChange={load} />
                  <label className="field"><span>{t('Region')}</span>
                    <select value={customAddr ? '' : cloud.baseUrl} onChange={(ev) => { setCustomAddr(!ev.target.value); if (ev.target.value) setCloud({ ...cloud, baseUrl: ev.target.value }); }}>
                      {REGIONS.map((r) => <option key={r.url} value={r.url}>{t(r.label)}</option>)}
                      <option value="">{t('Workspace address (below)')}</option>
                    </select>
                    <span className="hint-line">{t('Use the region where you created the API key. A workspace address from Model Studio also works.')}</span>
                  </label>
                  {customAddr && <label className="field"><span>{t('Address')}</span>
                    <input value={cloud.baseUrl} onChange={(ev) => setCloud({ ...cloud, baseUrl: ev.target.value })} spellCheck={false} />
                  </label>}
                  <label className="field"><span>{t('Model')}</span><input value={cloud.model} onChange={(ev) => setCloud({ ...cloud, model: ev.target.value })} spellCheck={false} /></label>
                  {(cloudDirty || cloudDraft.saving) && <div className="btn-row">
                    <button type="button" className="btn small primary" disabled={busySession || saving} onClick={() => void cloudDraft.save()}>{cloudDraft.saving ? t('Saving…') : t('Save')}</button>
                    <button type="button" className="btn small ghost" disabled={saving} onClick={resetCloud}>{t('Discard')}</button>
                  </div>}
                </div>
              )}
              {expanded && e.id === 'qwen-local' && (
                <div className="engine-settings">
                  <label className="field"><span>{t('Server address')}</span>
                    <input value={local.baseUrl} onChange={(ev) => setLocal({ ...local, baseUrl: ev.target.value })} spellCheck={false} />
                    <span className="hint-line">{t('For example: qwen-asr-serve Qwen/Qwen3-ASR-1.7B --port 8000, then http://127.0.0.1:8000/v1.')}</span>
                    {!isLoopback(local.baseUrl) && <span className="hint-line warn-text">{t('This server is on another computer: audio travels over the network to it.')}</span>}
                  </label>
                  <label className="field"><span>{t('Model')}</span><input value={local.model} onChange={(ev) => setLocal({ ...local, model: ev.target.value })} spellCheck={false} /></label>
                  {(localDirty || localDraft.saving) && <div className="btn-row">
                    <button type="button" className="btn small primary" disabled={busySession || saving} onClick={() => void localDraft.save()}>{localDraft.saving ? t('Saving…') : t('Save')}</button>
                    <button type="button" className="btn small ghost" disabled={saving} onClick={localDraft.discard}>{t('Discard')}</button>
                  </div>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {active !== 'whisper' && active !== 'qwen3' && (
        <p className="muted small">{status?.fallback
          ? t('If the service fails, Chumi uses local Qwen3-ASR first, then Whisper if the Qwen3 model is missing.')
          : t('Download Qwen3-ASR or a Whisper model below for local fallback when a speech service fails.')}</p>
      )}
    </>
  );
}
