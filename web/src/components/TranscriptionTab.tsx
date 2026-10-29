import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.ts';
import { saveSettings } from '../actions.ts';
import { api } from '../api.ts';
import { getLang, t, tn } from '../i18n.ts';
import { SpeakerSettings } from './Speakers.tsx';
import { SpeechEngineSettings } from './SpeechEngineSettings.tsx';
import { maxAsrThreads, threadDraftValue } from '../../../shared/asr-threads.ts';
import { MODEL_BASE_URL, MODEL_MIRROR_URL, modelSourceName, type ModelDownloadSource } from '../../../shared/model-source.ts';
import { speechSettingsBusy } from '../speechSettings.ts';

interface ModelRow {
  engine?: 'qwen3' | 'sensevoice';
  id: string; name: string; sizeMB: number; speed: number; accuracy: number; minRamGB: number;
  note: { en: string; zh: string }; installed: boolean; active: boolean; partial: boolean;
}
interface ModelList {
  source: ModelDownloadSource;
  hardware: { chip: string; appleSilicon: boolean; memoryGB: number; cores: number; gpu?: { name: string; memoryGB: number } | null };
  recommended: string; active: string; models: ModelRow[];
  download: { id: string; received: number; total: number; status: string; error?: string } | null;
}
interface BenchResult { lang: 'en' | 'zh'; audioSec: number; ms: number; realtimeFactor: number; accuracy: number; text: string }

const Dots = ({ n, label }: { n: number; label: string }) => (
  <span className="dots-rating" title={`${label}: ${n}/5`} aria-label={`${label}: ${n}/5`}>
    {[1, 2, 3, 4, 5].map((i) => <span key={i} className={i <= n ? 'on' : ''} />)}
  </span>
);

const fmtSize = (mb: number) => (mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

export function TranscriptionTab() {
  const settings = useStore((s) => s.settings)!;
  const live = useStore((s) => s.live);
  const download = useStore((s) => s.asrDownload);
  const [threads, setThreads] = useState(String(settings.asr.threads));
  useEffect(() => setThreads(String(settings.asr.threads)), [settings.asr.threads]);
  const [list, setList] = useState<ModelList | null>(null);
  const [glossary, setGlossary] = useState(settings.asr.glossary.join(', '));
  const glossaryEdit = useRef({ value: glossary, dirty: false, saved: settings.asr.glossary, submitted: null as string[] | null });
  glossaryEdit.current.saved = settings.asr.glossary;
  const flushGlossary = () => {
    const edit = glossaryEdit.current;
    if (!edit.dirty || edit.submitted) return;
    const value = edit.value.split(/[,，、;；\n]+/).map((x) => x.trim()).filter(Boolean);
    const same = (other: string[] | null) => other !== null && value.length === other.length && value.every((x, i) => x === other[i]);
    if (same(edit.saved)) { edit.dirty = false; return; }
    edit.submitted = value;
    const draft = edit.value;
    void saveSettings({ asr: { glossary: value } }).then((ok) => {
      if (edit.submitted === value) edit.submitted = null;
      if (ok) { edit.saved = value; if (edit.value === draft) edit.dirty = false; }
      if (edit.value !== draft) flushGlossary();
    });
  };
  // Escape and an outside click can remove the focused textarea without firing blur.
  useEffect(() => () => flushGlossary(), []);
  const [bench, setBench] = useState<{ running: boolean; model?: string; results?: BenchResult[]; error?: string }>({ running: false });
  const busySession = speechSettingsBusy(live);
  const load = () => void api<ModelList>('/api/asr/models').then(setList).catch(() => {});
  // Reload when the source changes and whenever a download stops (or disappears after a server restart), so a stale 'downloading' entry can't linger.
  useEffect(load, [settings.asr.model, settings.asr.engine, settings.asr.modelBaseUrl, download?.status]);
  const dl = download?.status === 'downloading' ? download : null;
  const S = saveSettings;
  const source = list?.source.fromEnvironment ? list.source : list ? { baseUrl: settings.asr.modelBaseUrl || MODEL_BASE_URL, fromEnvironment: false } : null;
  const sourceName = source ? modelSourceName(source.baseUrl) : '';

  const runBench = () => {
    setBench({ running: true });
    void api<{ model: string; results: BenchResult[] }>('/api/asr/benchmark', { body: {} })
      .then((r) => setBench({ running: false, model: r.model, results: r.results }))
      .catch((e) => setBench({ running: false, error: (e as Error).message }));
  };
  const hw = list?.hardware;

  return (
    <section>
      <p className="small">{t('Speech recognition is independent of the AI provider: it keeps running when the AI is unavailable.')}</p>

      <SpeechEngineSettings />

      <SpeakerSettings />

      <h3>{t('Local speech models')}</h3>
      {source && <label className="field"><span>{t('Download source')}</span>
        <select value={source.baseUrl} disabled={!!dl || source.fromEnvironment} onChange={(e) => void S({ asr: { modelBaseUrl: e.target.value } })}>
          <option value={MODEL_BASE_URL}>{t('Hugging Face')}</option>
          <option value={MODEL_MIRROR_URL}>{t('hf-mirror.com')}</option>
          {![MODEL_BASE_URL, MODEL_MIRROR_URL].includes(source.baseUrl) && <option value={source.baseUrl}>{sourceName}</option>}
        </select>
        {source.fromEnvironment && <span className="muted small">{t('Set by CHUMI_MODEL_BASE_URL. Change that variable and restart Chumi to use another source.')}</span>}
      </label>}
      {hw && (
        <p className="small">
          {hw.appleSilicon ? t('This Mac: {chip} · {mem} GB memory.', { chip: hw.chip, mem: hw.memoryGB }) : t('This computer: {chip} · {mem} GB memory.', { chip: hw.gpu ? `${hw.chip} · ${hw.gpu.name}` : hw.chip, mem: hw.memoryGB })}{' '}
          {hw.appleSilicon ? t('Apple Silicon runs the large models in real time.') : hw.gpu && hw.gpu.memoryGB >= 4 ? t('With this NVIDIA GPU and the CUDA build of whisper.cpp, the large models run in real time.') : t('Without GPU acceleration for whisper.cpp, a smaller model keeps up better.')}
        </p>
      )}
      {!list && <p className="muted small">{t('Loading…')}</p>}
      <ul className="model-list">
        {list?.models.map((m) => {
          const downloading = dl?.id === m.id;
          const pct = downloading && dl!.total ? Math.round((dl!.received / dl!.total) * 100) : 0;
          const tooBig = hw ? hw.memoryGB < m.minRamGB : false;
          return (
            <li key={m.id} className={`model-row ${m.active ? 'active' : ''}`}>
              <div className="model-main">
                <div className="model-name">
                  <b>{m.name}</b>
                  {m.id === list.recommended && <span className="tag">{t('Recommended for this computer')}</span>}
                  {m.active && <span className="tag tag-ok">{m.engine || settings.asr.engine === 'whisper' ? t('In use') : t('Backup')}</span>}
                  {!m.active && m.installed && <span className="tag tag-muted">{t('Downloaded')}</span>}
                  {tooBig && <span className="tag tag-warn">{t('Needs {n} GB+ memory', { n: m.minRamGB })}</span>}
                </div>
                <div className="muted small">{getLang() === 'zh' ? m.note.zh : m.note.en}</div>
                <div className="model-stats small">
                  <span>{fmtSize(m.sizeMB)}</span>
                  <span>{t('Speed')} <Dots n={m.speed} label={t('Speed')} /></span>
                  <span>{t('Accuracy')} <Dots n={m.accuracy} label={t('Accuracy')} /></span>
                </div>
                {downloading && (
                  <div className="model-progress"><span className="quota-bar"><span style={{ width: `${pct}%` }} /></span><span className="small muted">{dl!.total ? `${pct}% · ${fmtSize(dl!.received / 1048576)} / ${fmtSize(dl!.total / 1048576)}` : t('Starting download…')}</span></div>
                )}
                {download?.id === m.id && download.status === 'error' && <div className="error-text small">{t('Download failed: {error}', { error: t(download.error ?? '') })}</div>}
              </div>
              <div className="model-actions">
                {m.installed && !m.active && <button className="btn small primary" disabled={busySession} title={busySession ? t('End the current session before switching the speech model.') : ''} onClick={() => void S({ asr: m.engine ? { engine: m.engine } : { model: m.id } })}>{t('Use')}</button>}
                {!m.installed && !downloading && (
                  <button className="btn small" disabled={!!dl || !source} onClick={() => { if (confirm(t('Download {name} ({size}) from {source}? It is saved on this computer.', { name: m.name, size: fmtSize(m.sizeMB), source: sourceName }))) void api(`/api/asr/models/${m.id}/download`, { body: {} }); }}>{t('Download')} · {fmtSize(m.sizeMB)}</button>
                )}
                {!m.installed && m.partial && !downloading && <button className="btn small ghost" onClick={() => { if (confirm(t('Discard the partial download of {name}? A retry will start from the beginning.', { name: m.name }))) void api(`/api/asr/models/${m.id}`, { method: 'DELETE' }).then(load); }}>{t('Discard partial download')}</button>}
                {downloading && <button className="btn small" onClick={() => void api(`/api/asr/models/${m.id}/cancel`, { body: {} })}>{t('Cancel')}</button>}
                {m.installed && !m.active && <button className="btn small ghost" onClick={() => { if (confirm(t('Delete {name} from this computer? You can download it again later.', { name: m.name }))) void api(`/api/asr/models/${m.id}`, { method: 'DELETE' }).then(load); }}>{t('Delete')}</button>}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="muted small">{t('Bigger is not always better: if the transcript falls behind (the Speech badge shows “behind”), switch to a faster model. Switching takes a few seconds and is only possible between sessions.')}</p>

      <div className="btn-row">
        <button className="btn small" disabled={bench.running || busySession} onClick={runBench}>{bench.running ? t('Testing…') : settings.asr.engine === 'whisper' ? t('Test speed and accuracy of the current model') : t('Test speed and accuracy of the engine in use')}</button>
      </div>
      {bench.error && <p className="error-text small">{t(bench.error)}</p>}
      {bench.results && (
        <table className="bench small">
          <thead><tr><th>{t('Test clip')}</th><th>{t('Time')}</th><th>{t('Speed')}</th><th>{t('Accuracy')}</th></tr></thead>
          <tbody>
            {bench.results.map((r) => (
              <tr key={r.lang} title={r.text}>
                <td>{r.lang === 'en' ? t('English, {s} s', { s: r.audioSec.toFixed(1) }) : t('Mandarin, {s} s', { s: r.audioSec.toFixed(1) })}</td>
                <td>{(r.ms / 1000).toFixed(2)} s</td>
                <td className={r.realtimeFactor < 2 ? 'warn-text' : ''}>{t('{x}× real time', { x: r.realtimeFactor.toFixed(1) })}</td>
                <td>{r.accuracy}%</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={4} className="muted">{t('Clips are spoken by system voices, so real meetings score lower. Speed should stay above about 2× real time for smooth live captions.')}</td></tr></tfoot>
        </table>
      )}

      <h3>{t('Language')}</h3>
      <label className="field"><span>{t('Spoken language')}</span>
        <select value={settings.asr.language} onChange={(e) => S({ asr: { language: e.target.value } })}>
          <option value="auto">{t('Auto: English, Mandarin and mixed (recommended)')}</option><option value="en">{t('English only')}</option><option value="zh">{t('Mandarin only (English terms kept)')}</option>
        </select>
      </label>
      {settings.asr.language !== 'en' && (
        <label className="field"><span>{t('Chinese script for Mandarin speech')}</span>
          <select value={settings.asr.chineseScript} onChange={(e) => S({ asr: { chineseScript: e.target.value } })}>
            <option value="simplified">{t('Simplified (简体): convert any Traditional characters')}</option>
            <option value="original">{t('As recognized: may mix Simplified and Traditional')}</option>
          </select>
          <span className="muted small hint-line">{tn('Speech recognition sometimes writes Mandarin in Traditional characters, for example {trad} instead of {simp}. This option converts them to Simplified. English text is never changed.', { trad: <span lang="zh-TW">這個模型</span>, simp: <span lang="zh-CN">这个模型</span> })}</span>
        </label>
      )}

      <h3>{t('Accuracy and performance')}</h3>
      <label className="field"><span>{t('Vocabulary hints (commas, 、, or semicolons): improves spelling of technical terms and names')}</span>
        <textarea rows={3} value={glossary} onChange={(e) => { glossaryEdit.current.value = e.target.value; glossaryEdit.current.dirty = true; setGlossary(e.target.value); }} onBlur={flushGlossary} />
      </label>
      {settings.asr.engine === 'sensevoice' && <p className="muted small">{t('SenseVoice does not support vocabulary hints. The glossary has no effect on this engine.')}</p>}
      <label className="field"><span>{t('CPU threads (more is faster up to the number of performance cores; {n} cores on this computer)', { n: hw?.cores ?? '?' })}</span><input type="number" min={2} max={maxAsrThreads(hw?.cores ?? 16)} value={threads} disabled={busySession} title={busySession ? t('Wait until recording and transcription finish before changing speech recognition settings.') : ''} onChange={(e) => setThreads(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} onBlur={() => { const value = threadDraftValue(threads, settings.asr.threads, hw?.cores ?? 16); setThreads(String(value)); if (value !== settings.asr.threads) void S({ asr: { threads: value } }).then((ok) => { if (!ok) setThreads(String(settings.asr.threads)); }); }} /></label>
    </section>
  );
}
