import { useEffect, useState } from 'react';
import { assessLocalModels, ESTIMATE_CONTEXTS, GiB, MODEL_CATALOG_CHECKED, runtimeUnsupported, type LocalHardware, type ModelAssessment, type ModelFit } from '../../../shared/local-model-advice.ts';
import type { LocalModelPreset } from '../../../shared/local-models.ts';
import { api } from '../api.ts';
import { msg, t } from '../i18n.ts';
import { useStore } from '../store.ts';
import { LocalModelDownloadControls } from './LocalModelDownload.tsx';

const FIT_LABEL: Record<ModelFit, string> = {
  fits: msg('Within memory budget'), tight: msg('Memory may be tight'), too_large: msg('Exceeds memory budget'),
  unsupported: msg('Runtime unsupported'), unknown: msg('Cannot assess'),
};
const memory = (bytes: number) => `${(Math.ceil(bytes / GiB * 10) / 10).toFixed(1)} GiB`;
const downloadSize = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

function MemoryRange({ row }: { row: ModelAssessment }) {
  return <>{memory(row.memory.lowBytes)} – {memory(row.memory.highBytes)}</>;
}

export function LocalModelAdvice({ preset, baseUrl, serviceReady, installedIds, onDownloaded, context, onContextChange }: {
  preset: LocalModelPreset; baseUrl: string; serviceReady: boolean; installedIds: string[]; onDownloaded: () => void; context: number; onContextChange: (tokens: number) => void;
}) {
  const speechModel = useStore((state) => state.settings!.asr.model);
  const [attempt, setAttempt] = useState(0);
  const [report, setReport] = useState<{ identity: string; hardware?: LocalHardware; error?: boolean } | null>(null);
  const identity = JSON.stringify([speechModel, attempt]);
  const current = report?.identity === identity ? report : null;
  const hw = current?.hardware;
  const supportedContext = ESTIMATE_CONTEXTS.some((tokens) => tokens === context);
  const rows = hw && supportedContext ? assessLocalModels(hw, preset, context) : [];
  const recommended = rows.find((row) => row.recommended);

  useEffect(() => {
    const controller = new AbortController();
    void api<LocalHardware>('/api/provider/local-hardware', { signal: controller.signal })
      .then((hardware) => { if (!controller.signal.aborted) setReport({ identity, hardware }); })
      .catch(() => { if (!controller.signal.aborted) setReport({ identity, error: true }); });
    return () => controller.abort();
  }, [identity]);

  return <section className="local-model-advice" aria-label={t('Local model recommendations')}>
    <div className="local-model-heading">
      <h4>{t('Before downloading: models for this computer')}</h4>
      <button type="button" className="btn small" disabled={!current} onClick={() => setAttempt((n) => n + 1)}>{t('Refresh hardware')}</button>
    </div>
    {!current && <p className="small muted" role="status">{t('Checking this computer’s hardware…')}</p>}
    {current?.error && <p className="small warn-text" role="alert">{t('Hardware detection failed. Refresh to try again; no model recommendation is available yet.')}</p>}
    {hw && <>
      <p className="small">{t('{chip} · {ram} memory · {cores} CPU cores', { chip: hw.chip, ram: memory(hw.memoryBytes), cores: hw.cores })}</p>
      <p className="small muted">{hw.acceleration === 'metal' ? t('Apple Silicon · Metal · shared CPU/GPU memory') : t('GPU acceleration is unverified. Recommendations use conservative CPU assumptions; responses may be slow.')}</p>
      {runtimeUnsupported(hw, preset) && <p className="warn-text small" role="alert">{preset === 'lmstudio'
        ? t('LM Studio requires Apple Silicon and macOS 14 or later on Mac.')
        : t('Ollama requires macOS 14 or later. Update macOS before downloading a model.')}</p>}
      <label className="field advice-context"><span>{t('Context length')}</span>
        <select value={Number.isFinite(context) ? context : ''} onChange={(event) => onContextChange(Number(event.target.value))}>
          {!supportedContext && <option value={Number.isFinite(context) ? context : ''}>{Number.isFinite(context) ? context : t('Choose a context length…')}</option>}
          {ESTIMATE_CONTEXTS.map((tokens) => <option value={tokens} key={tokens}>{t('{n}K tokens', { n: tokens / 1024 })}</option>)}
        </select>
      </label>
      <p className="small muted">{t('Save model settings to use this context length for requests and memory estimates. Chumi sets it in Ollama; in LM Studio, set the same length when loading the model. Longer contexts need more memory.')}</p>
      {!supportedContext && <p className="small muted">{t('Memory estimates and recommended downloads are available for 4K, 8K, 16K and 32K contexts. A custom request limit can still be saved in Advanced model options.')}</p>}
      {recommended ? <div className="model-recommendation">
        <div className="model-name"><strong>{recommended.model.name}</strong><span className="tag tag-ok">{t('Recommended starting point')}</span></div>
        <span className="small muted">{recommended.download.quantization} · {t('Text model')}</span>
        <dl className="model-estimates">
          <div><dt>{t('Approx. download')}</dt><dd>{downloadSize(recommended.download.bytes)}</dd></div>
          <div><dt>{t('Estimated model memory')}</dt><dd><MemoryRange row={recommended} /></dd></div>
        </dl>
        {recommended.model.parametersB < 4 && <p className="small warn-text">{t('This small model is a low-memory starting point for short questions. Complex explanations and meeting summaries may be unreliable.')}</p>}
        <details className="small model-download-steps">
          <summary>{t('Manual download options')}</summary>
          {preset === 'ollama' ? <><p>{t('With Ollama running, paste this command into Terminal:')}</p><code>ollama pull {recommended.download.identifier}</code></>
            : <><p>{t('In LM Studio → Discover, search for this repository and choose {quant}.', { quant: recommended.download.quantization })}</p><code>{recommended.download.identifier}</code></>}
          <p>{t('After downloading, refresh the model list above and choose the installed model.')}</p>
          <a href={recommended.download.url} target="_blank" rel="noreferrer">{t('Official model file and license')}</a>
        </details>
      </div> : <p className="small warn-text" role="status">{t('No conservative recommendation at this context length. Try a shorter context, check disk space, or use another computer. Chumi will not switch to a cloud provider.')}</p>}
      <LocalModelDownloadControls preset={preset} baseUrl={baseUrl} model={recommended} context={context} serviceReady={serviceReady}
        installed={preset === 'ollama' && !!recommended && installedIds.includes(recommended.download.identifier)} onCompleted={onDownloaded} />
      <details className="advice-comparison" open={recommended ? undefined : true}>
        <summary>{t('Compare model sizes and memory')}</summary>
        <div className="advice-table-wrap"><table className="advice-table">
          <thead><tr><th>{t('Model')}</th><th>{t('Approx. download')}</th><th>{t('Estimated model memory')}</th><th>{t('Fit for this computer')}</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.model.id} className={row.recommended ? 'recommended' : undefined}>
            <td><a href={row.download.url} target="_blank" rel="noreferrer">{row.model.name}</a><small>{row.download.quantization}</small></td>
            <td>{downloadSize(row.download.bytes)}</td><td><MemoryRange row={row} /></td>
            <td className={row.fit === 'fits' && row.disk !== 'low' ? 'ok-text' : 'warn-text'}>{t(row.recommended ? 'Recommended starting point' : FIT_LABEL[row.fit])}
              {row.disk === 'low' && <small>{t('Low space on home volume')}</small>}</td>
          </tr>)}</tbody>
        </table></div>
      </details>
      <details className="small advice-assumptions">
        <summary>{t('Memory budget and estimate limits')}</summary>
        <p>{t('Planning budget for the model: {budget}. Reserved: {system} for the system and apps, plus {speech} for Chumi transcription. Additional headroom is kept for the runtime.', {
          budget: memory(hw.modelBudgetBytes), system: memory(hw.systemReserveBytes), speech: memory(hw.speechReserveBytes),
        })}</p>
        <p>{t('Based on the selected speech model: {model}.', { model: hw.speechModel })}</p>
        <p>{hw.homeDiskFreeBytes == null ? t('Free disk space could not be checked. Verify space in your model download location.')
          : t('Free space on the home volume: {space}. Downloads need extra temporary space. Check the destination separately if your model manager uses another disk.', { space: downloadSize(hw.homeDiskFreeBytes) })}</p>
        <p>{t('Estimates assume one text request, F16 context cache, and the exact quantization shown. Image input, parallel requests, other apps, and different runtimes can use more memory. This is not a guarantee or a measurement of currently available RAM.')}</p>
        <p>{t('Catalog sizes checked {date}; confirm the current file size before downloading. Smaller models are preferred as a starting point for live meetings.', { date: MODEL_CATALOG_CHECKED })}</p>
        <a href="https://docs.ollama.com/context-length" target="_blank" rel="noreferrer">{t('Context length and memory guide')}</a>
      </details>
      <p className="small muted">{t('These are planning estimates. Close memory-heavy apps and test the chosen model before a meeting.')}</p>
    </>}
  </section>;
}
