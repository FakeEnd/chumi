import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import { saveSettings } from '../actions.ts';
import { api } from '../api.ts';
import { msg, t } from '../i18n.ts';
import type { SpeechEngineId } from '../types.ts';

type KeyedEngine = 'elevenlabs' | 'qwen-cloud';
interface EngineStatus { keys: Record<KeyedEngine, boolean>; fallback: boolean }

const ENGINES: { id: SpeechEngineId; name: string; note: string; cloud: string | null }[] = [
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
const isLoopback = (url: string) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return true; } };

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

/** Which engine turns meeting audio into text: local Whisper, or a speech service (server/asr/engines.ts). */
export function SpeechEngineSettings() {
  const settings = useStore((s) => s.settings)!;
  const live = useStore((s) => s.live);
  const asr = live?.asr;
  const busySession = live?.status === 'recording' || live?.status === 'paused';
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [cloud, setCloud] = useState(settings.asr.qwenCloud);
  const [local, setLocal] = useState(settings.asr.qwenLocal);
  const load = () => void api<EngineStatus>('/api/asr/engines').then(setStatus).catch(() => {});
  useEffect(load, [settings.asr.engine, settings.asr.model]);
  useEffect(() => setCloud(settings.asr.qwenCloud), [settings.asr.qwenCloud.baseUrl, settings.asr.qwenCloud.model]);
  useEffect(() => setLocal(settings.asr.qwenLocal), [settings.asr.qwenLocal.baseUrl, settings.asr.qwenLocal.model]);
  const active = settings.asr.engine;

  const use = (e: (typeof ENGINES)[number]) => {
    const where = e.cloud ?? (e.id === 'qwen-local' && !isLoopback(settings.asr.qwenLocal.baseUrl) ? settings.asr.qwenLocal.baseUrl : null);
    if (where && !confirm(t('While you record, meeting audio is sent to {service} to be transcribed. Continue?', { service: where }))) return;
    void saveSettings({ asr: { engine: e.id } });
  };
  const ready = (id: SpeechEngineId) => id === 'whisper' || id === 'qwen-local' || !!status?.keys[id as KeyedEngine];
  const cloudDirty = cloud.baseUrl !== settings.asr.qwenCloud.baseUrl || cloud.model !== settings.asr.qwenCloud.model;
  const localDirty = local.baseUrl !== settings.asr.qwenLocal.baseUrl || local.model !== settings.asr.qwenLocal.model;

  return (
    <>
      <h3>{t('Speech recognition engine')}</h3>
      <ul className="model-list">
        {ENGINES.map((e) => (
          <li key={e.id} className={`model-row ${active === e.id ? 'active' : ''}`}>
            <div className="model-main">
              <div className="model-name">
                <b>{t(e.name)}</b>
                {active === e.id && <span className="tag tag-ok">{t('In use')}</span>}
                {e.cloud && <span className="tag tag-warn">{t('Sends audio to {service}', { service: e.cloud })}</span>}
                {e.id === 'whisper' && <span className="tag tag-muted">{t('Private')}</span>}
              </div>
              <div className="muted small">{t(e.note)}</div>
              {active === e.id && e.id !== 'whisper' && (asr?.state === 'error' || asr?.state === 'missing_key') && asr.message && <div className="small warn-text" role="status">{asr.message}</div>}
              {e.id === 'elevenlabs' && status && <KeyField engine="elevenlabs" stored={status.keys.elevenlabs} onChange={load} />}
              {e.id === 'qwen-cloud' && status && (
                <>
                  <KeyField engine="qwen-cloud" stored={status.keys['qwen-cloud']} onChange={load} />
                  <label className="field"><span>{t('Region')}</span>
                    <select value={REGIONS.find((r) => r.url === cloud.baseUrl)?.url ?? ''} onChange={(ev) => ev.target.value && setCloud({ ...cloud, baseUrl: ev.target.value })}>
                      {REGIONS.map((r) => <option key={r.url} value={r.url}>{t(r.label)}</option>)}
                      <option value="">{t('Workspace address (below)')}</option>
                    </select>
                  </label>
                  <label className="field"><span>{t('Address')}</span>
                    <input value={cloud.baseUrl} onChange={(ev) => setCloud({ ...cloud, baseUrl: ev.target.value })} spellCheck={false} />
                    <span className="hint-line">{t('Use the region where you created the API key. A workspace address from Model Studio also works.')}</span>
                  </label>
                  <label className="field"><span>{t('Model')}</span><input value={cloud.model} onChange={(ev) => setCloud({ ...cloud, model: ev.target.value })} spellCheck={false} /></label>
                  {cloudDirty && <div className="btn-row">
                    <button type="button" className="btn small primary" disabled={busySession} onClick={() => void saveSettings({ asr: { qwenCloud: cloud } })}>{t('Save')}</button>
                    <button type="button" className="btn small ghost" onClick={() => setCloud(settings.asr.qwenCloud)}>{t('Discard')}</button>
                  </div>}
                </>
              )}
              {e.id === 'qwen-local' && (
                <>
                  <label className="field"><span>{t('Server address')}</span>
                    <input value={local.baseUrl} onChange={(ev) => setLocal({ ...local, baseUrl: ev.target.value })} spellCheck={false} />
                    <span className="hint-line">{t('For example: qwen-asr-serve Qwen/Qwen3-ASR-1.7B --port 8000, then http://127.0.0.1:8000/v1.')}</span>
                    {!isLoopback(local.baseUrl) && <span className="hint-line warn-text">{t('This server is on another computer: audio travels over the network to it.')}</span>}
                  </label>
                  <label className="field"><span>{t('Model')}</span><input value={local.model} onChange={(ev) => setLocal({ ...local, model: ev.target.value })} spellCheck={false} /></label>
                  {localDirty && <div className="btn-row">
                    <button type="button" className="btn small primary" disabled={busySession} onClick={() => void saveSettings({ asr: { qwenLocal: local } })}>{t('Save')}</button>
                    <button type="button" className="btn small ghost" onClick={() => setLocal(settings.asr.qwenLocal)}>{t('Discard')}</button>
                  </div>}
                </>
              )}
            </div>
            <div className="model-actions">
              {active !== e.id && (
                <button className="btn small primary" disabled={busySession || !ready(e.id) || (e.id === 'qwen-cloud' && cloudDirty) || (e.id === 'qwen-local' && localDirty)}
                  title={busySession ? t('End the current session before changing the speech recognition engine.') : !ready(e.id) ? t('Save the API key first.') : ''}
                  onClick={() => use(e)}>{t('Use')}</button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {active !== 'whisper' && (
        <p className="muted small">{status?.fallback
          ? t('If the service fails, Chumi transcribes with the local Whisper model below until it works again, so no part of the meeting is lost.')
          : t('Download a local Whisper model below as a backup: without one, audio the service fails on is not transcribed.')}</p>
      )}
    </>
  );
}
