import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Transcriber, type FinalPiece } from '../server/asr/transcriber.ts';
import { SpeechService } from '../server/asr/speech.ts';
import { WhisperServer } from '../server/asr/whisper.ts';
import type { Spoken } from '../server/asr/language.ts';
import { readWav } from '../server/audio/wav.ts';
import { sherpaModelId } from '../server/asr/models.ts';
import { isSherpaEngine, type LocalEngineId } from '../server/asr/engines.ts';
import { MODELS_DIR, which } from '../server/paths.ts';

interface Clip {
  id: string; lang: Spoken; wav: string; dur_sec: number; ref_norm: string;
  dataset: string; session: string; mixed: boolean;
}
interface Result {
  id: string; lang: Spoken; dur_sec: number; session: string; dataset: string; mixed: boolean;
  hyp: string; hyp_lang: string | null; hyp_langs: (string | null)[]; ref_norm: string;
  hyp_norm: string; errors: number; ref_length: number; ms: number; retried: boolean;
  calls: number; split: boolean; transcription_errors: string[];
}
type Draft = Omit<Result, 'hyp_norm' | 'errors' | 'ref_length'>;

function cleanText(text: string): string {
  return text.replace(/<[^>]*>|\[[^\]]*\]|\{[^}]*\}/g, '').normalize('NFKC').replace(/[\p{P}\p{S}]/gu, '').toLowerCase();
}

export function normalize(text: string, lang: Spoken, simplify: (text: string) => string): string {
  const cleaned = cleanText(text);
  return lang === 'zh' ? simplify(cleaned).replace(/\s+/gu, '') : cleaned.replace(/\s+/gu, ' ').trim();
}

export function editDistance(ref: readonly string[], hyp: readonly string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ref.length; i++) {
    const row = [i];
    for (let j = 1; j <= hyp.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + Number(ref[i - 1] !== hyp[j - 1]));
    }
    prev = row;
  }
  return prev[hyp.length];
}

const foreignLetter = /(?:(?!\p{Script=Han}|\p{Script=Latin})\p{L})/u;
const namePrefix = /^[^\r\n:：]{1,8}[:：]/u;

function summarize(rows: Result[], lang: Spoken, subset: 'all' | 'under_3s') {
  const count = rows.length;
  const errors = rows.reduce((n, r) => n + r.errors, 0);
  const refLength = rows.reduce((n, r) => n + r.ref_length, 0);
  const audioSec = rows.reduce((n, r) => n + r.dur_sec, 0);
  const totalMs = rows.reduce((n, r) => n + r.ms, 0);
  const rate = (predicate: (r: Result) => boolean) => count ? rows.filter(predicate).length / count : null;
  return {
    lang, subset, count, audio_sec: audioSec, metric: lang === 'zh' ? 'CER' : 'WER', errors, ref_length: refLength,
    error_rate: refLength ? errors / refLength : null,
    language_error_rate: rate((r) => r.hyp_lang !== r.lang),
    foreign_script_rate: rate((r) => foreignLetter.test(r.hyp)),
    name_prefix_rate: rate((r) => namePrefix.test(r.hyp.trim())),
    empty_rate: rate((r) => !r.hyp.trim()),
    mean_ms: count ? totalMs / count : null,
    realtime_factor: audioSec ? totalMs / (audioSec * 1000) : null,
    retry_rate: rate((r) => r.retried),
    transcription_error_clips: rows.filter((r) => r.transcription_errors.length).length,
  };
}

function markdown(groups: ReturnType<typeof summarize>[]): string {
  const pct = (v: number | null) => v === null ? '—' : `${(100 * v).toFixed(2)}%`;
  return [
    '| Language | Subset | Clips | CER / WER | Language error | Foreign script | Name prefix | Empty | Mean ms | RTF | Retried |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...groups.map((g) => `| ${g.lang} | ${g.subset} | ${g.count} | ${pct(g.error_rate)} | ${pct(g.language_error_rate)} | ${pct(g.foreign_script_rate)} | ${pct(g.name_prefix_rate)} | ${pct(g.empty_rate)} | ${g.mean_ms?.toFixed(0) ?? '—'} | ${g.realtime_factor?.toFixed(3) ?? '—'} | ${pct(g.retry_rate)} |`),
    '',
    'CER/WER = total edit errors / total reference units. Empty or mixed language labels count as language errors.',
    'RTF = total transcription seconds / total audio seconds, including retries and splits; model loading is excluded.',
    'Foreign script = any Unicode letter outside Han and Latin. Name prefix = 1–8 characters followed by : or ：.',
    'Retried = the same audio was submitted again (language-policy or engine-error retry); splitting alone is separate.',
    'Normalization follows sources.md, using OpenCC t2s from the manifest directory’s .venv or python3.',
    '',
  ].join('\n');
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No evaluation port')); return; }
      server.close(() => resolvePort(address.port));
    });
  });
}

// Keep WhisperServer's inference client; isolate startup because its normal launcher owns Chumi's PID file and port 8178.
class EvalWhisperServer extends WhisperServer {
  private child: ChildProcess | null = null;
  private loading: Promise<void> | null = null;
  private threads: number;
  constructor(model: string, threads: number) { super({ model, threads }); this.threads = threads; }

  override ensure(): Promise<void> {
    if (this.state === 'ready' && this.child?.exitCode === null && this.child.signalCode === null) return Promise.resolve();
    this.loading ??= this.launch().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async launch(): Promise<void> {
    const binary = which('whisper-server');
    if (!binary) throw new Error('whisper-server is not installed');
    if (!existsSync(this.modelPath)) throw new Error(`Model not found: ${this.modelPath}`);
    const port = await freePort();
    if (port === 4777 || port === 4778 || port === 8178) throw new Error('Reserved Chumi port');
    Reflect.set(this, 'port', port);
    const args = ['-m', this.modelPath, '--host', '127.0.0.1', '--port', String(port), '-l', 'auto', '-t', String(this.threads), '-nth', '0.6'];
    if (process.env.CHUMI_ASR_CPU === '1') args.push('--no-gpu');
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.state = 'starting';
    let tail = '', spawnError: Error | null = null;
    child.on('error', (e) => { spawnError = e; });
    const keepTail = (b: Buffer) => { tail = (tail + b.toString()).slice(-4000); };
    child.stdout!.on('data', keepTail); child.stderr!.on('data', keepTail);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`whisper-server exited: ${tail}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { this.state = 'ready'; console.log(`Evaluation whisper-server ready on ${port}`); return; }
      } catch { /* loading */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`whisper-server startup timed out: ${tail}`);
  }

  override async stop(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.kill('SIGTERM');
      try { await exited; } finally { clearTimeout(timer); }
    }
    this.child = null; this.state = 'stopped';
  }
}

function score(drafts: Draft[], manifest: string): Result[] {
  const chinese = drafts.filter((r) => r.lang === 'zh').map((r) => cleanText(r.hyp));
  const conversions = new Map<string, string>();
  if (chinese.length) {
    const venvPython = join(dirname(manifest), '.venv', 'bin', 'python');
    const python = existsSync(venvPython) ? venvPython : 'python3';
    const converted = JSON.parse(execFileSync(python, ['-c',
      'import json,sys\nfrom opencc import OpenCC\nc=OpenCC("t2s")\njson.dump([c.convert(t) for t in json.load(sys.stdin)],sys.stdout,ensure_ascii=False)',
    ], { input: JSON.stringify(chinese), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as string[];
    chinese.forEach((text, i) => conversions.set(text, converted[i]));
  }
  return drafts.map((r) => {
    const hypNorm = normalize(r.hyp, r.lang, (text) => conversions.get(text)!);
    const units = (text: string) => r.lang === 'zh' ? [...text] : text.split(/\s+/u).filter(Boolean);
    const ref = units(r.ref_norm);
    return { ...r, hyp_norm: hypNorm, errors: editDistance(ref, units(hypNorm)), ref_length: ref.length };
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    engine: { type: 'string', default: 'whisper' }, threads: { type: 'string', default: '4' }, glossary: { type: 'string', default: '' },
    manifest: { type: 'string' }, lang: { type: 'string', default: 'all' },
    language: { type: 'string', default: 'auto' }, guard: { type: 'string', default: 'on' },
    prior: { type: 'string', default: 'en' }, model: { type: 'string', default: 'ggml-large-v3-turbo-q8_0.bin' },
    limit: { type: 'string' }, out: { type: 'string' },
  } });
  if (!values.manifest || !values.out) throw new Error('Usage: node scripts/asr-eval.ts --manifest <jsonl> --out <directory> [--engine whisper|qwen3|sensevoice --threads N --glossary term1,term2 --lang zh|en|all --language auto|zh|en --guard on|off --prior zh|en --model <ggml> --limit N]');
  if (!['zh', 'en', 'all'].includes(values.lang) || !['auto', 'zh', 'en'].includes(values.language)
    || !['on', 'off'].includes(values.guard) || !['zh', 'en'].includes(values.prior)) throw new Error('Invalid language, guard or prior');
  if (!['whisper', 'qwen3', 'sensevoice'].includes(values.engine)) throw new Error('Invalid engine');
  const threads = Number(values.threads);
  if (!Number.isInteger(threads) || threads < 1 || threads > 16) throw new Error('Invalid threads');
  const glossary = values.glossary.split(',').map((s) => s.trim()).filter(Boolean);
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (values.limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer');
  const manifest = resolve(values.manifest), out = resolve(values.out);
  const clips = (readFileSync(manifest, 'utf8').split(/\r?\n/u).filter((s) => s.trim()).map((s) => JSON.parse(s)) as Clip[])
    .filter((r) => values.lang === 'all' || r.lang === values.lang).slice(0, limit);
  if (!clips.length) throw new Error('No selected clips');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'progress.jsonl'), '');
  const model = isAbsolute(values.model) || values.model.includes('/') || values.model.includes('\\') ? resolve(values.model) : values.model;
  const whisper = new EvalWhisperServer(model, threads);
  const speech = new SpeechService(whisper, () => ({ engine: values.engine as LocalEngineId, threads, qwenCloud: { baseUrl: '', model: '' }, qwenLocal: { baseUrl: '', model: '' } }), () => false);
  let currentCalls: Set<Int16Array> = new Set(), calls = 0, retried = false;
  const transcribe = speech.transcribe.bind(speech);
  speech.transcribe = async (samples, options) => {
    calls++; if (currentCalls.has(samples)) retried = true;
    currentCalls.add(samples);
    return transcribe(samples, options);
  };
  const transcriber = new Transcriber(speech, () => ({ language: values.language, guard: values.guard === 'on', prior: values.prior as Spoken, glossary, chineseScript: 'simplified' }));
  let pieces: FinalPiece[] = [], errors: string[] = [];
  transcriber.on('final', (batch) => { pieces.push(...batch); });
  transcriber.on('error', (error) => { errors.push(error); });
  const abort = () => { transcriber.stop(); void speech.stop(); process.exitCode = 130; };
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const drafts: Draft[] = [];
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  try {
    await speech.ensure();
    eventLoop.enable();
    await new Promise((r) => setTimeout(r, 20));
    let session: string | null = null;
    for (const [i, clip] of clips.entries()) {
      if (transcriber.stopped) throw new Error('Evaluation interrupted');
      if (session !== clip.session) { transcriber.reset(clip.session); session = clip.session; }
      pieces = []; errors = []; currentCalls = new Set(); calls = 0; retried = false;
      const samples = readWav(clip.wav);
      const started = performance.now();
      transcriber.pushFinal('file', { id: i + 1, samples, startSec: 0, endSec: samples.length / 16000, final: true });
      if (!await transcriber.drain(900_000)) throw new Error(`Transcriber did not drain: ${clip.id}`);
      const ms = Math.round(performance.now() - started);
      const hypLangs = [...new Set(pieces.map((p) => p.lang))];
      const row: Draft = {
        id: clip.id, lang: clip.lang, dur_sec: clip.dur_sec, session: clip.session, dataset: clip.dataset, mixed: clip.mixed,
        hyp: pieces.map((p) => p.text).join(' ').trim(), hyp_lang: hypLangs.length === 1 ? hypLangs[0] : hypLangs.length ? 'mixed' : null,
        hyp_langs: hypLangs, ref_norm: clip.ref_norm, ms, retried, calls, split: currentCalls.size > 1, transcription_errors: errors,
      };
      drafts.push(row);
      appendFileSync(join(out, 'progress.jsonl'), JSON.stringify(row) + '\n');
      console.log(`${i + 1}/${clips.length} ${clip.id} ${ms} ms lang=${row.hyp_lang} calls=${calls}${errors.length ? ` errors=${errors.join('; ')}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 20));
    eventLoop.disable();
    const eventLoopMaxDelayMs = eventLoop.max / 1e6;
    const results = score(drafts, manifest);
    writeFileSync(join(out, 'results.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const groups = (['zh', 'en'] as const).filter((lang) => results.some((r) => r.lang === lang)).flatMap((lang) => {
      const rows = results.filter((r) => r.lang === lang);
      return [summarize(rows, lang, 'all'), summarize(rows.filter((r) => r.dur_sec < 3), lang, 'under_3s')];
    });
    const summary = { config: { ...values, manifest, model: isSherpaEngine(speech.engine) ? join(MODELS_DIR, sherpaModelId(speech.engine)) : whisper.modelPath, threads, glossary, chineseScript: 'simplified' }, event_loop_max_delay_ms: eventLoopMaxDelayMs, groups };
    writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    writeFileSync(join(out, 'summary.md'), markdown(groups));
    console.log(markdown(groups));
    console.log(`Event loop maximum delay: ${eventLoopMaxDelayMs.toFixed(2)} ms`);
  } finally {
    eventLoop.disable();
    transcriber.stop(); await speech.stop();
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}

if (import.meta.main) await main();
