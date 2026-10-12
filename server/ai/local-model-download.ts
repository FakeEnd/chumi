import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeCompatibleUrl } from '../../shared/compatible-provider.ts';
import { assessLocalModels, ESTIMATE_CONTEXTS, LOCAL_MODEL_CATALOG, type LocalHardware } from '../../shared/local-model-advice.ts';
import { downloadPending, type LocalDownloadError, type LocalModelDownload } from '../../shared/local-model-download.ts';
import { isLocalModelPreset } from '../../shared/local-models.ts';
import { readCompatibleKey } from './compatible-credentials.ts';

type Target = { preset?: unknown; baseUrl?: unknown; modelId?: unknown; context?: unknown };
interface Dependencies {
  hardware: () => Promise<LocalHardware>;
  fetch?: typeof fetch;
  readKey?: typeof readCompatibleKey;
  stateFile?: string;
  pollMs?: number;
  requestTimeoutMs?: number;
  streamIdleMs?: number;
}
class DownloadFailure extends Error {
  readonly code: LocalDownloadError;
  constructor(code: LocalDownloadError) { super(code); this.code = code; }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bytes = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const jobId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(v);
const errorCodes: LocalDownloadError[] = ['connection', 'authentication', 'unsupported_api', 'server', 'invalid_response', 'incomplete', 'memory', 'disk', 'runtime', 'interrupted', 'unknown_start', 'job_missing'];

export function downloadTarget(target: Target) {
  if (!isLocalModelPreset(target.preset)) throw new Error('Choose Ollama or LM Studio to download a local model.');
  if (typeof target.baseUrl !== 'string' || target.baseUrl.length > 2048) throw new Error('Enter a valid model server URL.');
  const baseUrl = normalizeCompatibleUrl(target.baseUrl, true);
  if (!baseUrl.endsWith('/v1')) throw new Error('One-click downloads require a model server URL ending in /v1.');
  const model = LOCAL_MODEL_CATALOG.find((row) => row.id === target.modelId);
  if (!model) throw new Error('Choose a model from the recommendation catalog.');
  if (typeof target.context !== 'number' || !(ESTIMATE_CONTEXTS as readonly number[]).includes(target.context)) throw new Error('Choose a supported context length.');
  return { preset: target.preset, baseUrl, model, context: target.context };
}

/** Transfers are owned by the model service, never by the settings panel. No shell, arbitrary URL, or inference. */
export class LocalModelDownloader {
  private current: LocalModelDownload | null = null;
  private controller: AbortController | null = null;
  private work: Promise<void> = Promise.resolve();
  private lastSave = 0;
  private stopping = false;
  private readonly deps: Dependencies;

  constructor(deps: Dependencies) {
    this.deps = deps;
    if (!deps.stateFile || !existsSync(deps.stateFile)) return;
    try {
      const saved: unknown = JSON.parse(readFileSync(deps.stateFile, 'utf8'));
      if (!object(saved) || !jobId(saved.id)) return;
      const target = downloadTarget(saved);
      const statuses = ['starting', 'downloading', 'verifying', 'paused', 'attention', 'completed', 'failed', 'cancelled', 'interrupted'];
      if (typeof saved.status !== 'string' || !statuses.includes(saved.status)) return;
      this.current = { id: saved.id, preset: target.preset, baseUrl: target.baseUrl, modelId: target.model.id,
        modelName: target.model.name, context: target.context, status: saved.status as LocalModelDownload['status'],
        received: bytes(saved.received), total: bytes(saved.total), progressScope: target.preset === 'ollama' ? 'file' : 'model',
        ...(errorCodes.includes(saved.error as LocalDownloadError) ? { error: saved.error as LocalDownloadError } : {}),
        ...(jobId(saved.remoteJobId) ? { remoteJobId: saved.remoteJobId } : {}) };
      if (downloadPending(this.current)) {
        this.current.status = target.preset === 'lmstudio' && this.current.remoteJobId ? 'attention' : 'interrupted';
        this.current.error = target.preset === 'lmstudio' && !this.current.remoteJobId ? 'unknown_start' : 'interrupted';
      }
    } catch { /* Invalid journals cannot authorize a download. */ }
  }

  snapshot(): LocalModelDownload | null { return this.current ? { ...this.current } : null; }
  waitForIdle(): Promise<void> { return this.work; }

  private save(force = false): void {
    if (!this.deps.stateFile || (!force && Date.now() - this.lastSave < 1000)) return;
    const path = this.deps.stateFile;
    writeFileSync(`${path}.tmp`, JSON.stringify(this.current), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    this.lastSave = Date.now();
  }
  private update(patch: Partial<LocalModelDownload>): void {
    if (!this.current) return;
    const changedStatus = patch.status && patch.status !== this.current.status;
    Object.assign(this.current, patch);
    try { this.save(!!changedStatus); } catch { /* Keep reporting live state if disk fills during a transfer. */ }
  }

  start(input: Target): LocalModelDownload {
    if (this.stopping) throw new Error('Chumi is shutting down. Reopen it to download a model.');
    const target = downloadTarget(input); // Validate before disk, credentials, or network.
    if (downloadPending(this.current)) {
      if (this.current!.preset === target.preset && this.current!.baseUrl === target.baseUrl && this.current!.modelId === target.model.id) return this.snapshot()!;
      throw new Error('Another local model download is being tracked. Finish it before starting a new one.');
    }
    this.current = { id: randomUUID(), preset: target.preset, baseUrl: target.baseUrl, modelId: target.model.id,
      modelName: target.model.name, context: target.context, status: 'starting', received: 0, total: 0,
      progressScope: target.preset === 'ollama' ? 'file' : 'model' };
    try { this.save(true); }
    catch { this.current = null; throw new Error('Could not save download progress. Check Chumi’s data folder and free disk space.'); }
    this.launch(false);
    return this.snapshot()!;
  }

  /** Restart monitoring an existing LM Studio job; never repeat its download POST. */
  resume(id: string): LocalModelDownload {
    if (!this.current || this.current.id !== id) throw new Error('This download is no longer current. Refresh its status.');
    if (this.current.preset !== 'lmstudio' || !this.current.remoteJobId) throw new Error('No LM Studio download job is available to check.');
    if (this.controller || !downloadPending(this.current)) return this.snapshot()!;
    this.launch(true);
    return this.snapshot()!;
  }
  restore(): void {
    if (this.current?.status === 'attention' && this.current.remoteJobId) this.resume(this.current.id);
  }
  cancel(id: string): LocalModelDownload {
    if (!this.current || this.current.id !== id) throw new Error('This download is no longer current. Refresh its status.');
    if (this.current.preset !== 'ollama') {
      // Chumi cannot cancel an LM Studio job, but it can stop following one it can no longer reach.
      if (this.current.status !== 'attention') throw new Error('Pause or cancel this download in LM Studio.');
      this.controller?.abort();
      this.update({ status: 'interrupted', error: undefined });
      return this.snapshot()!;
    }
    if (downloadPending(this.current)) { this.update({ status: 'cancelled', error: undefined }); this.controller?.abort(); }
    return this.snapshot()!;
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.controller?.abort();
    await this.work;
  }

  private launch(monitorOnly: boolean): void {
    const controller = new AbortController();
    this.controller = controller;
    this.work = this.run(controller, monitorOnly).finally(() => { if (this.controller === controller) this.controller = null; });
  }
  private async run(controller: AbortController, monitorOnly: boolean): Promise<void> {
    const state = this.current!;
    try {
      if (!monitorOnly) {
        const hw = await this.deps.hardware();
        controller.signal.throwIfAborted();
        const row = assessLocalModels(hw, state.preset, state.context).find((row) => row.model.id === state.modelId)!;
        if (row.fit === 'unsupported') throw new DownloadFailure('runtime');
        if (row.fit !== 'fits') throw new DownloadFailure('memory');
        if (row.disk === 'low') throw new DownloadFailure('disk');
      }
      const key = await (this.deps.readKey ?? readCompatibleKey)(state.preset, state.baseUrl);
      controller.signal.throwIfAborted();
      const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
      if (state.preset === 'ollama') await this.pullOllama(state, headers, controller.signal);
      else await this.downloadStudio(state, headers, controller.signal, monitorOnly);
    } catch (error) {
      if (this.current !== state) return;
      if (this.stopping) this.update({ status: state.preset === 'lmstudio' && state.remoteJobId ? 'attention' : 'interrupted',
        error: state.preset === 'lmstudio' && !state.remoteJobId ? 'unknown_start' : 'interrupted' });
      else if (controller.signal.aborted) this.update({ status: 'cancelled', error: undefined });
      else this.update({ status: state.preset === 'lmstudio' && state.remoteJobId && !(error instanceof DownloadFailure && error.code === 'job_missing') ? 'attention' : 'failed',
        error: error instanceof DownloadFailure ? error.code : 'connection' });
    }
  }
  private async request(state: LocalModelDownload, suffix: string, headers: Record<string, string>, signal: AbortSignal, body?: unknown): Promise<Response> {
    const response = await (this.deps.fetch ?? fetch)(`${state.baseUrl.slice(0, -3)}${suffix}`, {
      method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(this.deps.requestTimeoutMs ?? 15000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DownloadFailure(response.status === 401 || response.status === 403 ? 'authentication'
        : response.status === 404 && suffix.includes('/download/status/') ? 'job_missing'
        : response.status === 404 || response.status === 405 ? 'unsupported_api' : 'server');
    }
    return response;
  }
  private async json(response: Response): Promise<Record<string, unknown>> {
    if (!response.body) throw new DownloadFailure('invalid_response');
    let text = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > 65536) throw new DownloadFailure('invalid_response');
    }
    let data: unknown;
    try { data = JSON.parse(text + decoder.decode()); } catch { throw new DownloadFailure('invalid_response'); }
    if (!object(data)) throw new DownloadFailure('invalid_response');
    return data;
  }
  private async pullOllama(state: LocalModelDownload, headers: Record<string, string>, signal: AbortSignal): Promise<void> {
    const model = LOCAL_MODEL_CATALOG.find((row) => row.id === state.modelId)!;
    // The streaming request has an inactivity deadline, not a 15-second total download deadline.
    const streamController = new AbortController();
    let timer = setTimeout(() => streamController.abort(), this.deps.streamIdleMs ?? 120000);
    const refreshTimer = () => { clearTimeout(timer); timer = setTimeout(() => streamController.abort(), this.deps.streamIdleMs ?? 120000); };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await (this.deps.fetch ?? fetch)(`${state.baseUrl.slice(0, -3)}/api/pull`, {
        method: 'POST', headers, body: JSON.stringify({ model: model.downloads.ollama.identifier, stream: true }),
        redirect: 'error', signal: AbortSignal.any([signal, streamController.signal]),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new DownloadFailure(response.status === 401 || response.status === 403 ? 'authentication'
          : response.status === 404 || response.status === 405 ? 'unsupported_api' : 'server');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      const consume = (line: string): boolean => {
        if (!line.trim()) return false;
        let event: unknown;
        try { event = JSON.parse(line); } catch { throw new DownloadFailure('invalid_response'); }
        if (!object(event) || typeof event.status !== 'string') throw new DownloadFailure(object(event) && event.error ? 'server' : 'invalid_response');
        if (event.error) throw new DownloadFailure('server');
        if (event.status === 'success') { this.update({ status: 'completed', error: undefined }); return true; }
        if (event.digest && bytes(event.total) > 0) this.update({ status: 'downloading', total: bytes(event.total), received: Math.min(bytes(event.completed), bytes(event.total)) });
        else if (/verifying|writing|removing/.test(event.status)) this.update({ status: 'verifying' });
        return false;
      };
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) { pending += decoder.decode(); if (pending && consume(pending)) return; throw new DownloadFailure('incomplete'); }
        refreshTimer();
        pending += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          if (newline > 65536) throw new DownloadFailure('invalid_response');
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (consume(line)) return;
        }
        if (pending.length > 65536) throw new DownloadFailure('invalid_response');
      }
    } finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); streamController.abort(); }
  }
  private async downloadStudio(state: LocalModelDownload, headers: Record<string, string>, signal: AbortSignal, monitorOnly: boolean): Promise<void> {
    let data: Record<string, unknown>;
    if (monitorOnly) data = await this.json(await this.request(state, `/api/v1/models/download/status/${encodeURIComponent(state.remoteJobId!)}`, headers, signal));
    else {
      const download = LOCAL_MODEL_CATALOG.find((row) => row.id === state.modelId)!.downloads.lmstudio;
      try {
        data = await this.json(await this.request(state, '/api/v1/models/download', headers, signal,
          { model: `https://huggingface.co/${download.identifier}`, quantization: download.quantization }));
      } catch (error) {
        // A lost POST response does not prove the service rejected the download; never auto-resubmit.
        throw error instanceof DownloadFailure && ['authentication', 'unsupported_api', 'server'].includes(error.code)
          ? error : new DownloadFailure('unknown_start');
      }
    }
    while (true) {
      signal.throwIfAborted();
      if (state.remoteJobId && data.job_id !== state.remoteJobId) throw new DownloadFailure('invalid_response');
      if (data.error || data.status === 'failed') { this.update({ status: 'failed', error: 'server' }); return; }
      if (data.status === 'already_downloaded' || data.status === 'completed') { this.update({ status: 'completed', error: undefined, received: bytes(data.downloaded_bytes), total: bytes(data.total_size_bytes) }); return; }
      if (!['downloading', 'paused'].includes(String(data.status)) || !jobId(data.job_id)) throw new DownloadFailure('invalid_response');
      if (state.remoteJobId && state.remoteJobId !== data.job_id) throw new DownloadFailure('invalid_response');
      this.update({ remoteJobId: data.job_id, status: data.status === 'paused' ? 'paused' : 'downloading', error: undefined,
        total: bytes(data.total_size_bytes), received: Math.min(bytes(data.downloaded_bytes), bytes(data.total_size_bytes) || Number.MAX_SAFE_INTEGER) });
      await delay(this.deps.pollMs ?? 1000, undefined, { signal });
      data = await this.json(await this.request(state, `/api/v1/models/download/status/${encodeURIComponent(state.remoteJobId!)}`, headers, signal));
    }
  }
}
