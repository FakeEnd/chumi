import { useEffect, useRef, useState } from 'react';
import { normalizeCompatibleUrl } from '../../../shared/compatible-provider.ts';
import type { ModelAssessment } from '../../../shared/local-model-advice.ts';
import { downloadPending, type LocalDownloadError, type LocalDownloadStatus, type LocalModelDownload } from '../../../shared/local-model-download.ts';
import type { LocalModelPreset } from '../../../shared/local-models.ts';
import { api } from '../api.ts';
import { msg, t } from '../i18n.ts';

const STATUS: Record<LocalDownloadStatus, string> = {
  starting: msg('Preparing download…'), downloading: msg('Downloading model…'), verifying: msg('Verifying and installing…'),
  paused: msg('Download paused in LM Studio'), attention: msg('Download status needs attention'),
  completed: msg('Download complete'), failed: msg('Download failed'), cancelled: msg('Download cancelled'), interrupted: msg('Download interrupted'),
};
const ERRORS: Record<LocalDownloadError, string> = {
  connection: msg('Could not reach the model service. Open it and check your connection, then try again.'),
  authentication: msg('The model service rejected authentication. Check the API key for this endpoint and its download permissions.'),
  unsupported_api: msg('This service does not support the download API. Update Ollama or LM Studio (0.4 or later), and check the server URL.'),
  server: msg('The model service could not complete the download. Check its download details, network connection, and model storage space.'),
  invalid_response: msg('The model service returned an unreadable download status. Check its version and download details.'),
  incomplete: msg('The connection ended before the model was verified. Retry to continue downloading.'),
  memory: msg('This model no longer fits the current memory budget. Refresh the hardware recommendation or shorten the estimated context.'),
  disk: msg('There is not enough free space on the home volume. Free up space, then refresh the recommendation.'),
  runtime: msg('This model runtime does not support the detected computer or operating system.'),
  interrupted: msg('Chumi closed while this download was active. Ollama downloads can be retried; existing LM Studio jobs can be checked.'),
  unknown_start: msg('LM Studio may have accepted the download, but its reply was lost. Check Downloads in LM Studio before trying again.'),
  job_missing: msg('LM Studio no longer has this download job. Check its downloaded models before starting a new download.'),
};
const size = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : `${(value / 1e6).toFixed(1)} MB`;

export function LocalModelDownloadControls({ preset, baseUrl, model, context, serviceReady, installed, onCompleted }: {
  preset: LocalModelPreset; baseUrl: string; model: ModelAssessment | undefined; context: number;
  serviceReady: boolean; installed: boolean; onCompleted: () => void;
}) {
  const [state, setState] = useState<LocalModelDownload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const handled = useRef('');
  const mounted = useRef(true);
  const pending = downloadPending(state);
  let normalized = '';
  try { normalized = normalizeCompatibleUrl(baseUrl, true); } catch { /* Editing an endpoint. */ }
  const sameTarget = state?.preset === preset && state.baseUrl === normalized;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<LocalModelDownload | null>('/api/provider/local-download', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState(next); setLoaded(true); setError('');
        if (downloadPending(next)) timer = setTimeout(() => void poll(), next?.status === 'attention' ? 3000 : 1000);
      } catch {
        if (!controller.signal.aborted) {
          setError(t('Could not read download progress. Reconnecting…'));
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [attempt]);
  useEffect(() => {
    if (state?.status === 'completed' && sameTarget && handled.current !== state.id) {
      handled.current = state.id;
      onCompleted();
    }
  }, [state, sameTarget, onCompleted]);

  const act = async (action: 'start' | 'cancel' | 'check') => {
    setBusy(true); setError('');
    try {
      const next = await api<LocalModelDownload>(`/api/provider/local-download${action === 'start' ? '' : `/${action}`}`, {
        body: action === 'start' ? { preset, baseUrl, modelId: model?.model.id, context } : { id: state?.id },
      });
      if (mounted.current) { setState(next); setLoaded(true); setAttempt((n) => n + 1); }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : t('Could not start the download.')); }
    finally { if (mounted.current) setBusy(false); }
  };

  return <div className="local-download-controls">
    {model && <>
      <button type="button" className="btn primary small" disabled={!loaded || busy || pending || !serviceReady || installed}
        onClick={() => void act('start')}>{installed ? t('Already in the model list') : t('Download recommended model · {size}', { size: size(model.download.bytes) })}</button>
      <p className="small muted">{serviceReady
        ? t('Downloads from the model’s official source into {service}. The model list refreshes automatically when finished.', { service: preset === 'ollama' ? 'Ollama' : 'LM Studio' })
        : t('Start the local model service and refresh the model list to enable one-click downloads.')}</p>
    </>}
    {state && <div className="local-download-status" aria-label={t('Model download')}>
      <div className="local-model-heading"><strong>{state.modelName}</strong><span className="small muted">{state.preset === 'ollama' ? 'Ollama' : 'LM Studio'}</span></div>
      <p className={state.status === 'completed' ? 'small ok-text' : 'small'} role="status">{t(STATUS[state.status])}</p>
      {!sameTarget && <p className="small muted">{t('This download belongs to another model service: {url}', { url: state.baseUrl })}</p>}
      {pending && state.status !== 'attention' && <>
        <progress aria-label={t('Download progress')} max={100} value={state.total > 0 && state.status !== 'verifying' ? Math.min(99, state.received / state.total * 100) : undefined} />
        {state.total > 0 && state.status !== 'verifying' && <p className="small muted">{t(state.progressScope === 'file' ? msg('Current file: {received} / {total} · {percent}%') : msg('Downloaded: {received} / {total} · {percent}%'), {
          received: size(state.received), total: size(state.total), percent: Math.min(99, Math.floor(state.received / state.total * 100)),
        })}</p>}
      </>}
      {state.error && <p className="small warn-text" role="alert">{t(ERRORS[state.error])}</p>}
      {pending && state.preset === 'ollama' && <button type="button" className="btn small" disabled={busy} onClick={() => void act('cancel')}>{t('Cancel download')}</button>}
      {pending && state.preset === 'lmstudio' && <p className="small muted">{t('To pause or cancel, use Downloads in LM Studio.')}</p>}
      {state.status === 'attention' && <div className="btn-row">
        <button type="button" className="btn small" disabled={busy} onClick={() => void act('check')}>{t('Check existing download')}</button>
        <button type="button" className="btn small ghost" disabled={busy} title={t('Chumi stops following this job, so you can start another download. LM Studio may still finish it.')} onClick={() => void act('cancel')}>{t('Stop tracking')}</button>
      </div>}
      {pending && <p className="small muted">{t('You can close Settings while downloading. Keep Chumi and the model service running.')}</p>}
      {state.status === 'completed' && sameTarget && <p className="small muted">{t('The model list refreshes automatically. Choose the downloaded model above and save your settings.')}</p>}
      {state.status === 'completed' && sameTarget && state.preset === 'lmstudio' && <p className="small muted">{t('In LM Studio, enable Just-In-Time loading or load the downloaded model in Developer so it appears in this list.')}</p>}
      {state.status === 'cancelled' && <p className="small muted">{t('Ollama keeps partial files for a later retry. No installed models were deleted.')}</p>}
    </div>}
    {error && <p className="small warn-text" role="alert">{t(error)}</p>}
  </div>;
}
