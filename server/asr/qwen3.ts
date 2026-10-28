import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { MODELS_DIR } from '../paths.ts';
import { mostlyHan } from './clean.ts';
import { isInstalled, QWEN_MODEL_ID } from './models.ts';
import type { RemoteOptions } from './engines.ts';
import type { AsrState, WhisperResult } from './whisper.ts';

interface DecodeRequest {
  promise: Promise<string>;
  resolve(text: string): void;
  reject(error: Error): void;
}

export const qwenLanguage = (text: string): 'zh' | 'en' => mostlyHan(text) ? 'zh' : 'en';
export const qwenHotwords = (terms: string[]): string => [...new Set(terms.flatMap((t) => t.split(/[,，\r\n]+/)).map((t) => t.trim()).filter(Boolean))].join(',');

export class QwenAsr extends EventEmitter<{ state: [AsrState, string | null] }> {
  state: AsrState = 'stopped';
  message: string | null = null;
  private worker: Worker | null = null;
  private pending = new Map<number, DecodeRequest>();
  private nextId = 0;
  private loading: Promise<void> | null = null;
  private threads: () => number;
  constructor(threads: () => number) { super(); this.threads = threads; }

  get installed(): boolean { return isInstalled(QWEN_MODEL_ID); }

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
      this.setState('missing_model', 'Download Qwen3-ASR in Settings → Transcription. Chumi uses Whisper until it is downloaded.');
      throw new Error(this.message!);
    }
    this.setState('starting', 'Loading Qwen3-ASR…');
    const worker = new Worker(new URL('./qwen3-worker.ts', import.meta.url), {
      workerData: { dir: join(MODELS_DIR, QWEN_MODEL_ID), threads: this.threads() },
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
        worker.on('message', (message: { ready?: boolean; id?: number; text?: string; error?: string }) => {
          if (message.ready) { resolve(); return; }
          if (message.id === undefined) { fail(new Error(message.error)); return; }
          const request = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) request?.reject(new Error(message.error));
          else request?.resolve(message.text ?? '');
        });
        worker.on('error', fail);
        worker.on('exit', (code) => {
          if (this.worker !== worker) return;
          this.worker = null;
          fail(new Error(`Qwen3-ASR worker exited (${code}).`));
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
    const request = Promise.withResolvers<string>();
    this.pending.set(id, request);
    try { this.worker!.postMessage({ id, samples, language: options.language, hotwords: qwenHotwords(options.glossary ?? []) }); }
    catch (e) { this.pending.delete(id); request.reject(e); }
    const text = await request.promise;
    return {
      text, language: qwenLanguage(text), langProbs: {},
      segments: [{ start: 0, end: samples.length / 16000, text: ` ${text}` }], ms: performance.now() - started,
    };
  }
}
