import { useEffect, useState } from 'react';
import { COMPATIBLE_PRESETS, validateCompatibleSettings, type CompatiblePreset, type CompatibleProfile, type CompatibleSettings, type StructuredOutputMode } from '../../../shared/compatible-provider.ts';
import { isLocalModelPreset } from '../../../shared/local-models.ts';
import { LocalModelPicker } from './LocalModelPicker.tsx';
import { api } from '../api.ts';
import { refreshProvider } from '../actions.ts';
import { getState, setState, useStore } from '../store.ts';
import { msg, t } from '../i18n.ts';
import type { ProviderStatus, Settings } from '../types.ts';

const PRESET_LABELS: Record<CompatiblePreset, string> = {
  ollama: msg('Ollama'), lmstudio: msg('LM Studio'), qwen: msg('Qwen / Alibaba Cloud'),
  doubao: msg('Doubao / Volcengine'), minimax: msg('MiniMax'), glm: msg('GLM / Zhipu'), custom: msg('Custom compatible API'),
};

export function CompatibleProviderSettings() {
  const saved = useStore((s) => s.settings!.ai.compatible);
  const savedJson = JSON.stringify(saved);
  const [draft, setDraft] = useState<CompatibleSettings>(() => structuredClone(saved));
  const [busy, setBusy] = useState<'save' | 'key' | 'remove' | 'test' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [key, setKey] = useState('');
  const [stored, setStored] = useState<boolean | null>(null);
  const [keyError, setKeyError] = useState('');
  const [checkingKey, setCheckingKey] = useState(false);
  const [testResult, setTestResult] = useState<ProviderStatus | null>(null);
  const [discoveryRefresh, setDiscoveryRefresh] = useState(0);
  const dirty = JSON.stringify(draft) !== savedJson;
  const preset = draft.preset;
  const profile = draft.profiles[preset];
  const savedProfile = saved.profiles[saved.preset];
  const local = isLocalModelPreset(preset);
  const actionsDisabled = dirty || !!busy || checkingKey || !savedProfile.baseUrl;

  // Unrelated settings updates must not erase a partially edited profile.
  useEffect(() => { setDraft(JSON.parse(savedJson) as CompatibleSettings); setTestResult(null); }, [savedJson]);
  useEffect(() => { setKey(''); setError(''); setNotice(''); setTestResult(null); }, [preset, profile.baseUrl]);
  useEffect(() => {
    let current = true;
    setStored(null);
    setKeyError('');
    if (dirty || !savedProfile.baseUrl) { setCheckingKey(false); return; }
    setCheckingKey(true);
    const query = new URLSearchParams({ preset: saved.preset, baseUrl: savedProfile.baseUrl });
    void api<{ stored: boolean }>(`/api/provider/compatible/key?${query}`).then((result) => {
      if (current) setStored(result.stored);
    }).catch((e: unknown) => {
      if (current) setKeyError(e instanceof Error ? e.message : t('Could not check the saved API key.'));
    }).finally(() => { if (current) setCheckingKey(false); });
    return () => { current = false; };
  }, [saved.preset, savedProfile.baseUrl, dirty]);

  const update = (patch: Partial<CompatibleProfile>) => {
    setDraft((previous) => ({ ...previous, profiles: { ...previous.profiles, [previous.preset]: { ...previous.profiles[previous.preset], ...patch } } }));
    setError(''); setNotice(''); setTestResult(null);
  };
  const refreshIfActive = async () => {
    if (getState().settings?.ai.provider === 'compatible') await refreshProvider();
  };
  const save = async () => {
    setBusy('save'); setError(''); setNotice('');
    try {
      if (Object.values(draft.profiles).some((p) => !Number.isInteger(p.maxOutputTokens) || p.maxOutputTokens < 64 || p.maxOutputTokens > 32768)) {
        throw new Error(t('Maximum output tokens must be a whole number from 64 to 32768.'));
      }
      const compatible = validateCompatibleSettings(draft);
      const result = await api<Settings>('/api/settings', { method: 'PUT', body: { ai: { compatible } } });
      setState({ settings: result });
      setDraft(structuredClone(result.ai.compatible));
      setNotice(getState().settings?.ai.provider === 'compatible' ? t('Model settings saved.') : t('Model settings saved. Choose “Other models” above to use them.'));
      await refreshIfActive();
    } catch (e) { setError(e instanceof Error ? e.message : t('Could not save model settings.')); }
    finally { setBusy(null); }
  };
  const keyAction = async (remove: boolean) => {
    setBusy(remove ? 'remove' : 'key'); setError(''); setNotice(''); setTestResult(null);
    try {
      await api('/api/provider/compatible/key', {
        method: remove ? 'DELETE' : 'POST',
        body: { preset: saved.preset, baseUrl: savedProfile.baseUrl, ...(remove ? {} : { key: key.trim() }) },
      });
      setKey(''); setStored(!remove); setKeyError('');
      setDiscoveryRefresh((n) => n + 1);
      setNotice(remove ? t('API key removed from Keychain.') : t('API key saved in Keychain for this preset and endpoint.'));
      await refreshIfActive();
    } catch (e) { setError(e instanceof Error ? e.message : t('Could not update the API key.')); }
    finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test'); setError(''); setNotice(''); setTestResult(null);
    try {
      const result = await api<ProviderStatus>('/api/provider/compatible/test', {
        body: { preset: saved.preset, baseUrl: savedProfile.baseUrl, model: savedProfile.model },
      });
      setTestResult(result);
      await refreshIfActive();
    } catch (e) { setError(e instanceof Error ? e.message : t('The model connection test failed.')); }
    finally { setBusy(null); }
  };

  return (
    <div className="compatible-settings">
      <h3>{t('Other model settings')}</h3>
      <p className="small muted">{t('Choose a service and model below. Each service keeps its own settings and API key. Changes take effect when you save.')}</p>
      <fieldset className="field" disabled={!!busy}>
        <label className="field"><span>{t('Model service preset')}</span>
          <select value={preset} onChange={(e) => setDraft((previous) => ({ ...previous, preset: e.target.value as CompatiblePreset }))}>
            {(Object.keys(COMPATIBLE_PRESETS) as CompatiblePreset[]).map((id) => <option key={id} value={id}>{t(PRESET_LABELS[id])}</option>)}
          </select>
        </label>
        {local && <LocalModelPicker preset={preset} baseUrl={profile.baseUrl} value={profile.model} refreshKey={discoveryRefresh}
          onChange={(model) => update({ model, supportsImages: false, structuredOutput: 'prompt' })} />}
        <p className="small muted">{local
          ? t('Start the local model server and choose a model you have downloaded. A server on this Mac can still route requests to a cloud service; check its model and routing settings.')
          : t('Requests use your provider account and its API billing or applicable plan. Check the provider’s terms and balance; a chat app subscription does not by itself confirm API access.')}</p>
        <label className="field check"><input type="checkbox" checked={profile.enabled} onChange={(e) => update({ enabled: e.target.checked })} />{local
          ? t('Allow Chumi to use this local model for answers')
          : t('Allow requests to this API endpoint using my provider account (charges may apply)')}</label>
        <details className="model-connection" open={local ? undefined : true}>
        <summary>{t('Server connection settings')}</summary>
        <label className="field"><span>{t('Model server URL (include the API base path)')}</span>
          <input type="url" value={profile.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} spellCheck={false} autoComplete="off" placeholder="https://example.com/v1" />
        </label>
        </details>
        {!local && <label className="field"><span>{t('Model ID (or provider deployment ID)')}</span>
          <input value={profile.model} onChange={(e) => update({ model: e.target.value })} spellCheck={false} autoComplete="off" />
          <span className="hint-line">{t('Use the exact ID from your model server or provider console. Changing the preset does not choose a model for you.')}</span>
        </label>}
        <details className="model-connection">
        <summary>{t('Advanced model options')}</summary>
        <label className="field check"><input type="checkbox" checked={profile.supportsImages} onChange={(e) => update({ supportsImages: e.target.checked })} />{t('This model and endpoint accept images (off by default)')}</label>
        <p className="small muted">{t('Enable images only after checking model support. Captures are sent only when this is enabled and “Send screen captures” is on in Screen settings.')}</p>
        <label className="field"><span>{t('Structured output support')}</span>
          <select value={profile.structuredOutput} onChange={(e) => update({ structuredOutput: e.target.value as StructuredOutputMode })}>
            <option value="prompt">{t('Prompt only (recommended)')}</option>
            <option value="json_object">{t('JSON object mode (requires server support)')}</option>
            <option value="json_schema">{t('JSON schema mode (requires server support)')}</option>
          </select>
        </label>
        <label className="field"><span>{t('Maximum output tokens per request')}</span>
          <input type="number" min={64} max={32768} step={1} value={Number.isNaN(profile.maxOutputTokens) ? '' : profile.maxOutputTokens} onChange={(e) => update({ maxOutputTokens: e.target.valueAsNumber })} />
        </label>
        <p className="small muted">{t('Compatible models use the model server’s reasoning defaults. Chumi’s reasoning effort controls are not sent to these endpoints.')}</p>
        </details>
        <div className="btn-row">
          <button type="button" className="btn small" disabled={!dirty} onClick={() => void save()}>{busy === 'save' ? t('Saving…') : t('Save model settings')}</button>
          <button type="button" className="btn small" disabled={!dirty} onClick={() => { setDraft(structuredClone(saved)); setError(''); setNotice(''); }}>{t('Discard changes')}</button>
          <span className="small muted" role="status">{dirty ? t('Unsaved changes') : t('Settings saved')}</span>
        </div>
      </fieldset>
      <details className="model-connection" open={local ? undefined : true}>
      <summary>{t('API key for the saved endpoint')}</summary>
      <p className="small muted">{t('Keys are stored in macOS Keychain, separately from settings. Local servers usually do not need a key.')}</p>
      {dirty && <p className="small warn-text">{t('Save or discard changes before checking the connection or changing its API key.')}</p>}
      {!dirty && savedProfile.baseUrl && <p className="small muted">{t('Saved endpoint: {url}', { url: savedProfile.baseUrl })}</p>}
      <div className="field-row">
        <input type="password" aria-label={t('API key for the saved endpoint')} placeholder={t('API key (stored in macOS Keychain)')} value={key} onChange={(e) => setKey(e.target.value)} disabled={actionsDisabled} autoComplete="off" />
        <button type="button" className="btn small" disabled={actionsDisabled || !key.trim()} onClick={() => void keyAction(false)}>{busy === 'key' ? t('Saving…') : t('Save key')}</button>
        <button type="button" className="btn small" disabled={actionsDisabled || stored !== true} onClick={() => void keyAction(true)}>{busy === 'remove' ? t('Removing…') : t('Remove key')}</button>
      </div>
      {!dirty && <p className="small muted" role="status">{checkingKey ? t('Checking saved key…') : stored === true ? t('An API key is saved for this preset and endpoint.') : stored === false ? t('No API key stored.') : t('Key status unavailable.')}</p>}
      {keyError && <p className="small warn-text" role="alert">{t(keyError)}</p>}
      </details>
      <p className="small muted">{t('The connection test generates a short synthetic answer and may incur a provider charge. It sends no meeting content and runs only when you click the button.')}</p>
      <button type="button" className="btn small" disabled={actionsDisabled || !savedProfile.enabled || !savedProfile.model} onClick={() => void test()}>{busy === 'test' ? t('Testing…') : t('Test with a short generation')}</button>
      {testResult && <div className={testResult.ready ? 'small ok-text' : 'small warn-text'} role="status">
        <p>{testResult.ready ? t('Connection test passed for {model}.', { model: testResult.model ?? savedProfile.model }) : t('Connection test did not pass.')}</p>
        {testResult.message && <p>{t(testResult.message)}</p>}
        {testResult.quota.note && testResult.quota.note !== testResult.message && <p>{t(testResult.quota.note)}</p>}
      </div>}
      {notice && <p className="small ok-text" role="status">{notice}</p>}
      {error && <p className="small warn-text" role="alert">{t(error)}</p>}
    </div>
  );
}
