import { useCallback, useEffect, useState } from 'react';
import type { LocalModelDiscovery, LocalModelPreset } from '../../../shared/local-models.ts';
import { api } from '../api.ts';
import { t } from '../i18n.ts';
import { LocalModelAdvice } from './LocalModelAdvice.tsx';

function SetupGuide({ preset, downloadOnly = false }: { preset: LocalModelPreset; downloadOnly?: boolean }) {
  return <div className="local-model-guide small">
    {!downloadOnly && <p>{preset === 'ollama'
      ? t('Open Ollama to start its local service. If you installed the command-line version, run ollama serve in Terminal.')
      : t('Open LM Studio → Developer and turn on Start server. Keep LM Studio running while using Chumi.')}</p>}
    <p>{t('Use “Download recommended model” below, or download another model in {name} and refresh this list.', { name: preset === 'ollama' ? 'Ollama' : 'LM Studio' })}</p>
    {preset === 'lmstudio' && <p>{t('In LM Studio, enable Just-In-Time loading or load the downloaded model in Developer so it appears in this list.')}</p>}
    <div className="btn-row">
      {!downloadOnly && <a className="btn small" href={preset === 'ollama' ? 'https://ollama.com/download' : 'https://lmstudio.ai/download'} target="_blank" rel="noreferrer">{t('Download {name}', { name: preset === 'ollama' ? 'Ollama' : 'LM Studio' })}</a>}
      <a href={preset === 'ollama' ? 'https://docs.ollama.com/quickstart' : 'https://lmstudio.ai/docs/app/basics/download-model'} target="_blank" rel="noreferrer">{t('Model download guide')}</a>
    </div>
  </div>;
}

export function LocalModelPicker({ preset, baseUrl, value, onChange, refreshKey, contextTokens, onContextChange }: {
  preset: LocalModelPreset; baseUrl: string; value: string; onChange: (model: string) => void; refreshKey: number; contextTokens: number; onContextChange: (tokens: number) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const downloaded = useCallback(() => setAttempt((n) => n + 1), []);
  const [response, setResponse] = useState<{ identity: string; result?: LocalModelDiscovery; error?: string } | null>(null);
  const identity = JSON.stringify([preset, baseUrl, refreshKey, attempt]);
  const current = response?.identity === identity ? response : null;
  const result = current?.result;
  const loading = !current;
  const name = preset === 'ollama' ? 'Ollama' : 'LM Studio';
  const selected = result?.models.find((model) => model.id === value || (preset === 'ollama' && model.id === `${value}:latest`));
  const listed = !!selected;

  useEffect(() => {
    const controller = new AbortController();
    // Debounce URL editing, and ignore results from a previously selected service.
    const timer = setTimeout(() => {
      void api<LocalModelDiscovery>('/api/provider/compatible/models', { body: { preset, baseUrl }, signal: controller.signal })
        .then((result) => { if (!controller.signal.aborted) setResponse({ identity, result }); })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setResponse({ identity, error: error instanceof Error ? error.message : 'Could not read local models.' });
        });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [preset, baseUrl, identity]);

  return <><div className="local-model-picker" aria-busy={loading}>
    <div className="local-model-heading">
      <label htmlFor="local-model-select">{t('Available local models')}</label>
      <button type="button" className="btn small" disabled={loading} onClick={() => setAttempt((n) => n + 1)}>{loading ? t('Reading models…') : t('Refresh models')}</button>
    </div>
    <select id="local-model-select" value={selected?.id ?? value} disabled={loading || result?.state !== 'ready'} onChange={(event) => onChange(event.target.value)}>
      <option value="">{t('Choose a model…')}</option>
      {value && !listed && <option value={value} disabled>{loading ? value : t('{model} (not listed)', { model: value })}</option>}
      {result?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select>
    <div className="small" role="status">
      {loading && <p className="muted">{t('Looking for models in {name}…', { name })}</p>}
      {result?.state === 'ready' && <p className="muted">{t('Choose one model, then save your model settings. Reading this list does not load models or send meeting content.')}</p>}
      {result?.state === 'ready' && value && !listed && <p className="warn-text">{t('The saved model is not in this list. Choose an available model or restore it in your local server.')}</p>}
      {result?.state === 'empty' && <p>{t('{name} is running, but no local models are listed yet.', { name })}</p>}
      {result?.state === 'unreachable' && <p>{result.installation === 'detected'
        ? t('{name} was found, but its local service is not responding. Start it and refresh the list.', { name })
        : t('Could not connect to {name}, and no installation was found in the usual locations. Install it, or open your existing installation, then refresh.', { name })}</p>}
      {result?.state === 'auth_required' && <p className="warn-text">{t('The local server requires authentication. Save the server settings, add its API key under “API key for the saved endpoint”, then refresh models.')}</p>}
      {result?.state === 'error' && <p className="warn-text">{t('The server responded, but its model list could not be read. Check the API base URL and local server version, then refresh.')}</p>}
      {current?.error && <p className="warn-text" role="alert">{t(current.error)}</p>}
    </div>
    {(result?.state === 'unreachable' || result?.state === 'empty') && <SetupGuide preset={preset} downloadOnly={result.state === 'empty'} />}
    {result?.state === 'ready' && <details className="small"><summary>{t('Get more models')}</summary><SetupGuide preset={preset} downloadOnly /></details>}
  </div><LocalModelAdvice preset={preset} baseUrl={baseUrl} serviceReady={result?.state === 'ready' || result?.state === 'empty'}
    installedIds={result?.models.map((model) => model.id) ?? []} onDownloaded={downloaded} context={contextTokens} onContextChange={onContextChange} /></>;
}
