import { accessSync, constants, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SpeakerRuntime } from '../../shared/speakers.ts';
import { REPO_ROOT } from '../paths.ts';
import { spawnCommand, stopProcess } from '../platform.ts';

const SEGMENTATION = 'sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx';
const EMBEDDING = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';
const TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
type Turn = { start_ms: number; end_ms: number; speaker: string };
const paths = () => ({
  python: resolve(process.env.CHUMI_SPEAKER_PYTHON || join(REPO_ROOT, process.platform === 'win32' ? 'build/speakers/venv/Scripts/python.exe' : 'build/speakers/venv/bin/python3')),
  models: resolve(process.env.CHUMI_SPEAKER_MODELS || join(REPO_ROOT, 'build/speakers/models')),
  worker: join(REPO_ROOT, 'scripts/diarize.py'),
});
const nonemptyFile = (path: string): boolean => { try { const s = statSync(path); return s.isFile() && s.size > 0; } catch { return false; } };
const aborted = () => new DOMException('Speaker analysis cancelled.', 'AbortError');

/** Cheap readiness check. The subprocess validates dependencies and models when it starts. */
export function speakerRuntime(): SpeakerRuntime {
  const p = paths();
  const result = (reason: string | null): SpeakerRuntime => ({ ready: reason === null, reason, setupCommand: 'npm run setup:speakers' });
  try { accessSync(p.python, constants.X_OK); } catch { return result('Local speaker analysis is not installed. Run the speaker setup command.'); }
  if (!nonemptyFile(p.worker)) return result('The local speaker analysis worker is missing.');
  if (![SEGMENTATION, EMBEDDING].every((name) => nonemptyFile(join(p.models, name)))) return result('Local speaker models are missing. Run the speaker setup command.');
  return result(null);
}

const ERRORS: Record<string, string> = {
  bad_audio: 'Speaker analysis requires a complete 16 kHz mono PCM WAV recording.',
  audio_duration: 'Speaker analysis supports up to two hours of recordings per audio source.',
  missing_dependency: 'Local speaker dependencies are missing. Run the speaker setup command.',
  inference_failed: 'Local speaker analysis failed. Check the installed models or run the speaker setup command again.',
};

function parseResult(output: string): Turn[] {
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error('The speaker worker returned invalid output.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The speaker worker returned invalid output.');
  const result = value as Record<string, unknown>;
  if (result.v !== 1) throw new Error('The speaker worker returned an unsupported response.');
  if (result.type === 'error') throw new Error(ERRORS[String(result.code)] ?? ERRORS.inference_failed);
  if (result.type !== 'result' || !Number.isSafeInteger(result.duration_ms) || (result.duration_ms as number) <= 0 || (result.duration_ms as number) > (2 * 60 * 60 + 60) * 1000 || !Array.isArray(result.turns) || result.turns.length > 100_000) throw new Error('The speaker worker returned invalid output.');
  let previousStart = -1;
  return result.turns.map((turn: unknown): Turn => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) throw new Error('The speaker worker returned an invalid speaker turn.');
    const t = turn as Record<string, unknown>;
    if (!Number.isSafeInteger(t.start_ms) || !Number.isSafeInteger(t.end_ms) || (t.start_ms as number) < previousStart || (t.start_ms as number) < 0 || (t.end_ms as number) <= (t.start_ms as number) || (t.end_ms as number) > (result.duration_ms as number) || typeof t.speaker !== 'string' || !/^speaker_\d{1,5}$/.test(t.speaker)) throw new Error('The speaker worker returned an invalid speaker turn.');
    previousStart = t.start_ms as number;
    return { start_ms: t.start_ms as number, end_ms: t.end_ms as number, speaker: t.speaker };
  });
}

/** One source recording per process: the caller serializes jobs and retains source-relative times. */
export async function runDiarization(wavPath: string, options: { signal: AbortSignal }): Promise<Turn[]> {
  const { signal } = options;
  if (signal.aborted) throw aborted();
  const state = speakerRuntime();
  if (!state.ready) throw new Error(state.reason!);
  if (!nonemptyFile(wavPath)) throw new Error('The recording for speaker analysis is missing.');
  const p = paths();
  return new Promise((resolveResult, reject) => {
    const child = spawnCommand(p.python, ['-u', p.worker], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' }, windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      stopProcess(child);
      killTimer = setTimeout(() => stopProcess(child, 'SIGKILL'), 1000);
    };
    const cancel = () => stop(aborted());
    const timer = setTimeout(() => stop(new Error('Local speaker analysis timed out.')), TIMEOUT_MS);
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', cancel); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) stop(new Error('The speaker worker returned too much output.'));
      else if (!failure) chunks.push(chunk);
    });
    child.stdin!.on('error', () => stop(new Error('Could not send the recording to the local speaker worker.')));
    child.on('error', () => { cleanup(); reject(failure ?? new Error('Could not start the local speaker worker. Run the speaker setup command.')); });
    child.on('close', (code) => {
      cleanup();
      if (failure) { reject(failure); return; }
      try {
        const turns = parseResult(Buffer.concat(chunks).toString('utf8'));
        if (code !== 0) throw new Error('The local speaker worker stopped before finishing.');
        resolveResult(turns);
      } catch (error) { reject(error); }
    });
    child.stdin!.end(JSON.stringify({ v: 1, wav: resolve(wavPath), models: p.models }) + '\n');
  });
}
