import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { MODELS_DIR } from '../paths.ts';
import { qwenHotwords, qwenLanguage, senseVoiceLanguage } from './sherpa-config.ts';
import { isInstalled, sherpaModelId } from './models.ts';
import { ENGINE_NAMES, type SherpaEngineId, type RemoteOptions } from './engines.ts';
import type { AsrState, WhisperResult } from './whisper.ts';

interface DecodeResult { text: string; lang?: string }
interface DecodeRequest {
  promise: Promise<DecodeResult>;
  resolve(result: DecodeResult): void;
  reject(error: Error): void;
}

export class SherpaAsr extends EventEmitter<{ state: [AsrState, string | null] }> {
  state: AsrState = 'stopped';
  message: string | null = null;
  private worker: Worker | null = null;
  private pending = new Map<number, DecodeRequest>();
  private nextId = 0;
  private loading: Promise<void> | null = null;
  private threads: () => number;
  readonly engine: SherpaEngineId;
  constructor(engine: SherpaEngineId, threads: () => number) { super(); this.engine = engine; this.threads = threads; }

  get installed(): boolean { return isInstalled(sherpaModelId(this.engine)); }

  private setState(state: AsrState, message: string | null = null): void {
    this.state = state; this.message = message; this.emit('state', state, message);
  }

  ensure(): Promise<void> {
    if (this.state === 'ready' && this.worker) return Promise.resolve();
    this.loading ??= this.load().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async load(): Promise<void> {
    if (!this.installed) {
      this.setState('missing_model', this.engine === 'qwen3'
        ? 'Download Qwen3-ASR in Settings → Transcription. Another installed local model takes over until it is downloaded.'
        : 'Download SenseVoice in Settings → Transcription. Another installed local model takes over until it is downloaded.');
      throw new Error(this.message!);
    }
    this.setState('starting', `Loading ${ENGINE_NAMES[this.engine]}…`);
    const worker = new Worker(new URL('./sherpa-worker.ts', import.meta.url), {
      workerData: { engine: this.engine, dir: join(MODELS_DIR, sherpaModelId(this.engine)), threads: this.threads() },
    });
    this.worker = worker;
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => {
          for (const request of this.pending.values()) request.reject(error);
          this.pending.clear();
          this.setState('error', error.message);
          reject(error);
        };
        worker.on('message', (message: { ready?: boolean; id?: number; text?: string; lang?: string; error?: string }) => {
          if (message.ready) { resolve(); return; }
          if (message.id === undefined) { fail(new Error(message.error)); return; }
          const request = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) request?.reject(new Error(message.error));
          else request?.resolve({ text: message.text ?? '', lang: message.lang });
        });
        worker.on('error', fail);
        worker.on('exit', (code) => {
          if (this.worker !== worker) return;
          this.worker = null;
          fail(new Error(`${ENGINE_NAMES[this.engine]} worker exited (${code}).`));
        });
      });
      this.setState('ready');
    } catch (e) {
      if (this.worker === worker) this.worker = null;
      await worker.terminate();
      throw e;
    }
  }

  async stop(): Promise<void> {
    await this.loading?.catch(() => {});
    await Promise.allSettled([...this.pending.values()].map((request) => request.promise));
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
    this.setState('stopped');
  }

  async transcribe(samples: Int16Array, options: RemoteOptions): Promise<WhisperResult> {
    await this.ensure();
    const started = performance.now();
    const id = ++this.nextId;
    const request = Promise.withResolvers<DecodeResult>();
    this.pending.set(id, request);
    try { this.worker!.postMessage({ id, samples, language: options.language, hotwords: qwenHotwords(options.glossary ?? []) }); }
    catch (e) { this.pending.delete(id); request.reject(e); }
    const { text, lang } = await request.promise;
    return {
      text, language: this.engine === 'qwen3' ? qwenLanguage(text) : senseVoiceLanguage(lang), langProbs: {},
      segments: [{ start: 0, end: samples.length / 16000, text: ` ${text}` }], ms: performance.now() - started,
    };
  }
}
