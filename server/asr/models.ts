import { execFile, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, MODELS_DIR, REPO_ROOT } from '../paths.ts';
import { toSimplified } from './clean.ts';
import { readWav } from '../audio/wav.ts';
import type { WhisperServer } from './whisper.ts';

/** whisper.cpp ggml models (MIT), from the official repository on Hugging Face. */
const BASE_URL = process.env.CHUMI_MODEL_BASE_URL || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export interface ModelInfo {
  id: string;            // file name
  name: string;
  sizeMB: number;
  speed: 1 | 2 | 3 | 4 | 5;     // relative, 5 = fastest
  accuracy: 1 | 2 | 3 | 4 | 5;  // relative, 5 = best (incl. Mandarin and mixed speech)
  minRamGB: number;
  note: { en: string; zh: string };
}

export const MODEL_CATALOG: ModelInfo[] = [
  { id: 'ggml-tiny-q5_1.bin', name: 'Tiny', sizeMB: 31, speed: 5, accuracy: 1, minRamGB: 4,
    note: { en: 'Fastest and smallest. Misses many technical terms; weak on Mandarin.', zh: '最快最小。专业术语常听错，中文效果较差。' } },
  { id: 'ggml-base-q5_1.bin', name: 'Base', sizeMB: 57, speed: 5, accuracy: 2, minRamGB: 4,
    note: { en: 'For very old or low-memory Macs.', zh: '适合很旧或内存很小的 Mac。' } },
  { id: 'ggml-small-q5_1.bin', name: 'Small', sizeMB: 181, speed: 4, accuracy: 3, minRamGB: 8,
    note: { en: 'Good balance for Intel Macs and 8 GB machines.', zh: '适合 Intel 芯片或 8 GB 内存的 Mac，速度与准确度较均衡。' } },
  { id: 'ggml-medium-q5_0.bin', name: 'Medium', sizeMB: 514, speed: 3, accuracy: 4, minRamGB: 8,
    note: { en: 'More accurate than Small; slower on Intel Macs.', zh: '比 Small 更准确；在 Intel Mac 上较慢。' } },
  { id: 'ggml-large-v3-turbo-q5_0.bin', name: 'Large v3 Turbo (compact)', sizeMB: 547, speed: 4, accuracy: 5, minRamGB: 8,
    note: { en: 'Near-best accuracy at a smaller size. Recommended for 8–16 GB Apple Silicon.', zh: '接近最佳准确度，体积更小。推荐 8–16 GB 内存的 Apple 芯片 Mac。' } },
  { id: 'ggml-large-v3-turbo-q8_0.bin', name: 'Large v3 Turbo', sizeMB: 834, speed: 4, accuracy: 5, minRamGB: 16,
    note: { en: 'Best balance for Apple Silicon with 16 GB or more. The default.', zh: '16 GB 及以上内存的 Apple 芯片 Mac 的最佳选择（默认）。' } },
  { id: 'ggml-large-v3-q5_0.bin', name: 'Large v3', sizeMB: 1031, speed: 2, accuracy: 5, minRamGB: 16,
    note: { en: 'Full Large v3: slightly more robust on hard audio, but several times slower.', zh: '完整版 Large v3：嘈杂音频下略稳一些，但慢好几倍。' } },
];

export interface Hardware { chip: string; appleSilicon: boolean; memoryGB: number; cores: number; gpu?: { name: string; memoryGB: number } | null }

let gpuCache: Hardware['gpu'] | undefined;
/** An NVIDIA GPU for whisper.cpp's CUDA build (Windows and Linux; Macs use Metal). */
function nvidiaGpu(): Hardware['gpu'] {
  if (process.platform === 'darwin') return null;
  if (gpuCache !== undefined) return gpuCache;
  try {
    const [name, mib] = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).split('\n')[0].split(',');
    gpuCache = name?.trim() ? { name: name.trim(), memoryGB: Math.round(Number(mib) / 1024) } : null;
  } catch { gpuCache = null; }
  return gpuCache;
}

export function hardware(): Hardware {
  return { chip: os.cpus()[0]?.model ?? 'unknown', appleSilicon: process.platform === 'darwin' && os.arch() === 'arm64', memoryGB: Math.round(os.totalmem() / 2 ** 30), cores: os.cpus().length, gpu: nvidiaGpu() };
}

/** Pick the most accurate model that this computer runs comfortably in real time. */
export function recommendModel(hw: Hardware = hardware()): string {
  // Large v3 Turbo q8_0 needs about 1.5 GB of GPU memory with the CUDA build.
  if (!hw.appleSilicon && hw.gpu && hw.gpu.memoryGB >= 4) return 'ggml-large-v3-turbo-q8_0.bin';
  if (!hw.appleSilicon) return hw.memoryGB >= 16 ? 'ggml-small-q5_1.bin' : 'ggml-base-q5_1.bin';
  if (hw.memoryGB >= 16) return 'ggml-large-v3-turbo-q8_0.bin';
  if (hw.memoryGB >= 8) return 'ggml-large-v3-turbo-q5_0.bin';
  return 'ggml-small-q5_1.bin';
}

export function isInstalled(id: string): boolean {
  const info = MODEL_CATALOG.find((m) => m.id === id);
  const file = join(MODELS_DIR, id);
  if (!existsSync(file)) return false;
  return !info || statSync(file).size > info.sizeMB * 1048576 * 0.97;
}

export interface DownloadState { id: string; received: number; total: number; status: 'downloading' | 'done' | 'error' | 'cancelled'; error?: string }

/** One model download at a time, streamed to <file>.part and renamed only when complete and the right size. */
export class ModelDownloader extends EventEmitter<{ progress: [DownloadState] }> {
  current: DownloadState | null = null;
  private controller: AbortController | null = null;

  async start(id: string): Promise<void> {
    if (!MODEL_CATALOG.some((m) => m.id === id)) throw new Error('Unknown model');
    if (this.current?.status === 'downloading') throw new Error('Another model is already downloading.');
    if (isInstalled(id)) return;
    mkdirSync(MODELS_DIR, { recursive: true });
    const part = join(MODELS_DIR, `${id}.part`);
    const state: DownloadState = { id, received: 0, total: 0, status: 'downloading' };
    this.current = state;
    this.controller = new AbortController();
    let lastEmit = 0;
    const emit = (force = false) => { if (force || Date.now() - lastEmit > 400) { lastEmit = Date.now(); this.emit('progress', { ...state }); } };
    try {
      const res = await fetch(`${BASE_URL}/${id}`, { signal: this.controller.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      state.total = Number(res.headers.get('content-length') ?? 0);
      emit(true);
      const counter = new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, ctl) => { state.received += chunk.byteLength; emit(); ctl.enqueue(chunk); } });
      await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as never), createWriteStream(part));
      if (state.total && statSync(part).size !== state.total) throw new Error('Download incomplete');
      renameSync(part, join(MODELS_DIR, id));
      state.status = 'done';
    } catch (e) {
      rmSync(part, { force: true });
      state.status = this.controller.signal.aborted ? 'cancelled' : 'error';
      state.error = (e as Error).message;
    } finally {
      this.controller = null;
      emit(true);
    }
  }

  cancel(): void { this.controller?.abort(); }
}

// ------------------------------------------------------------------ speed & accuracy check
const BENCH = {
  en: { voice: 'Samantha', text: 'We trained a convolutional model on ATAC-seq peaks and validated the predicted enhancers with a massively parallel reporter assay.' },
  zh: { voice: 'Tingting', text: '我们用三个生物学重复来检验这个结果，如果第三个重复也一致，就说明这不是批次效应。' },
};

function say(voice: string, text: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => execFile('/usr/bin/say', ['-v', voice, '-o', out, '--data-format=LEI16@16000', '--file-format=WAVE', text], (e) => (e ? reject(e) : resolve())));
}

export interface BenchResult { lang: 'en' | 'zh'; audioSec: number; ms: number; realtimeFactor: number; accuracy: number; text: string }

/** Transcribe two short synthetic clips (English, Mandarin) with the active model; report speed and a rough accuracy. */
export async function benchmark(whisper: WhisperServer): Promise<BenchResult[]> {
  const dir = join(DATA_DIR, 'bench');
  mkdirSync(dir, { recursive: true });
  const out: BenchResult[] = [];
  const windowsClips = join(REPO_ROOT, 'assets', 'bench');
  const references = process.platform === 'win32' ? JSON.parse(readFileSync(join(windowsClips, 'references.json'), 'utf8')) as Record<string, string> : null;
  for (const lang of ['en', 'zh'] as const) {
    const file = references ? join(windowsClips, `${lang}.wav`) : join(dir, `${lang}.wav`);
    if (!references && !existsSync(file)) await say(BENCH[lang].voice, BENCH[lang].text, file);
    const samples = readWav(file);
    const audioSec = samples.length / 16000;
    await whisper.transcribe(samples.subarray(0, 8000), { language: lang }); // warm-up
    const r = await whisper.transcribe(samples, { language: lang });
    const text = lang === 'zh' ? toSimplified(r.text) : r.text;
    out.push({ lang, audioSec, ms: r.ms, realtimeFactor: audioSec / Math.max(0.001, r.ms / 1000), accuracy: Math.round(textAccuracy(text, references?.[lang] ?? BENCH[lang].text) * 100), text });
  }
  return out;
}

/** 1 − character error rate, ignoring case, spaces and punctuation (works for English and Chinese). */
export function textAccuracy(hyp: string, ref: string): number {
  const norm = (x: string) => [...x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')];
  const a = norm(hyp), b = norm(ref);
  if (!b.length) return a.length ? 0 : 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.max(0, 1 - prev[b.length] / b.length);
}
