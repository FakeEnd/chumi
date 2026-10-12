import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { AUDIO_DIR } from '../paths.ts';
import { WavWriter } from '../session/wavwriter.ts';
import type { SpeakerTurn } from '../../shared/speakers.ts';

const RATE = 16_000;
const MAX_SAMPLES = RATE * 60 * 120;
interface Span { sample_start: number; sample_count: number; start_ms: number }
interface Take { version: 1; id: string; source: string; samples: number; spans: Span[] }
interface SavedTake extends Take { path: string }
export interface AudioMapping { packed_start_ms: number; start_ms: number; end_ms: number }
export interface SpeakerInput { source: string; path: string; mapping: AudioMapping[] }

function sessionDir(sessionId: string, root: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session ID.');
  return join(root, sessionId, 'speakers');
}

/** Every take records its own input-to-session clock mapping; pauses never become invented speech. */
export class SpeakerRecorder {
  private directory: string;
  private takes = new Map<string, { writer: WavWriter; take: Take }>();
  private closed = false;
  constructor(sessionId: string, retain: boolean, root = AUDIO_DIR) {
    this.directory = join(sessionDir(sessionId, root), retain ? 'retained' : 'temporary');
  }

  write(source: string, startMs: number, samples: Int16Array): void {
    if (this.closed || !samples.length) return;
    if (!['mic', 'system', 'file'].includes(source) || !Number.isFinite(startMs) || startMs < 0) throw new Error('Invalid speaker audio timestamp.');
    let entry = this.takes.get(source);
    if (!entry) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      entry = { writer: new WavWriter(join(this.directory, `${id}.wav`)), take: { version: 1, id, source, samples: 0, spans: [] } };
      this.takes.set(source, entry);
    }
    const take = entry.take;
    const previous = take.spans.at(-1);
    const previousEnd = previous ? previous.start_ms + previous.sample_count / RATE * 1000 : 0;
    if (previous && startMs < previousEnd - 5) {
      // The helper re-anchors its clock on device changes and drift, which can step back by up to ~200 ms.
      // Treat that as continuous audio; a larger step starts a new take for this source only.
      if (startMs >= previousEnd - 250) startMs = previousEnd;
      else { this.finish(source); this.write(source, startMs, samples); return; }
    }
    entry.writer.write(samples);
    if (previous && Math.abs(startMs - previousEnd) < 2) previous.sample_count += samples.length;
    else take.spans.push({ sample_start: take.samples, sample_count: samples.length, start_ms: startMs });
    take.samples += samples.length;
  }

  /** Close one source's take and write its manifest. */
  private finish(source: string): void {
    const entry = this.takes.get(source);
    if (!entry) return;
    this.takes.delete(source);
    entry.writer.close();
    const target = join(this.directory, `${entry.take.id}.json`);
    writeFileSync(`${target}.tmp`, JSON.stringify(entry.take), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let failure: unknown;
    for (const source of [...this.takes.keys()]) {
      try { this.finish(source); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}

function savedTakes(sessionId: string, root: string): SavedTake[] {
  const base = sessionDir(sessionId, root);
  const takes: SavedTake[] = [];
  for (const mode of ['temporary', 'retained']) {
    const directory = join(base, mode);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter((n) => /^[a-f0-9-]+\.json$/.test(n))) {
      const take = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Take;
      if (take.version !== 1 || `${take.id}.json` !== name || !['mic', 'system', 'file'].includes(take.source)
        || !Number.isSafeInteger(take.samples) || take.samples <= 0 || !Array.isArray(take.spans)) throw new Error('Invalid speaker audio manifest.');
      let count = 0, end = -Infinity;
      for (const span of take.spans) {
        if (span.sample_start !== count || !Number.isSafeInteger(span.sample_count) || span.sample_count <= 0
          || !Number.isFinite(span.start_ms) || span.start_ms < 0 || span.start_ms < end - 5) throw new Error('Invalid speaker audio mapping.');
        count += span.sample_count;
        end = span.start_ms + span.sample_count / RATE * 1000;
      }
      const path = join(directory, `${take.id}.wav`);
      if (count !== take.samples || statSync(path).size !== 44 + take.samples * 2) throw new Error('Incomplete speaker audio.');
      takes.push({ ...take, path });
    }
  }
  return takes.sort((a, b) => a.spans[0].start_ms - b.spans[0].start_ms);
}

export function speakerAudioAvailable(sessionId: string, root = AUDIO_DIR): boolean {
  try { return savedTakes(sessionId, root).length > 0; } catch { return false; }
}

/** Delete only app-owned temporary copies, never the original imported audio or retained recordings. */
export function discardSpeakerAudio(sessionId: string, root = AUDIO_DIR): void {
  const base = sessionDir(sessionId, root);
  for (const name of ['temporary', 'work']) rmSync(join(base, name), { recursive: true, force: true });
}

/** Stream PCM into one file per source so clustering sees returning voices across every take. */
export async function prepareSpeakerInputs(sessionId: string, signal: AbortSignal, root = AUDIO_DIR): Promise<SpeakerInput[]> {
  const takes = savedTakes(sessionId, root);
  if (!takes.length) throw new Error('No audio is available for speaker analysis. Enable speaker labeling before the next recording.');
  const work = join(sessionDir(sessionId, root), 'work');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const out: SpeakerInput[] = [];
  for (const source of [...new Set(takes.map((t) => t.source))]) {
    signal.throwIfAborted();
    const group = takes.filter((t) => t.source === source);
    const totalSamples = group.reduce((n, t) => n + t.samples, 0);
    if (totalSamples > MAX_SAMPLES) throw new Error('Local speaker analysis currently supports up to two hours of audio per source.');
    const path = join(work, `${source}.wav`);
    const writer = new WavWriter(path);
    const mapping: AudioMapping[] = [];
    let packedSamples = 0;
    try {
      for (const take of group) {
        const fd = openSync(take.path, 'r');
        try {
          for (const span of take.spans) {
            if (packedSamples + span.sample_count + RATE / 4 > MAX_SAMPLES + RATE * 60) throw new Error('Local speaker analysis currently supports up to two hours of audio per source.');
            // Separate capture discontinuities rather than joining words across a pause/restart.
            if (packedSamples) { writer.write(new Int16Array(RATE / 4)); packedSamples += RATE / 4; }
            mapping.push({ packed_start_ms: packedSamples / RATE * 1000, start_ms: span.start_ms, end_ms: span.start_ms + span.sample_count / RATE * 1000 });
            let copied = 0;
            const buffer = Buffer.alloc(256 * 1024);
            while (copied < span.sample_count * 2) {
              signal.throwIfAborted();
              const size = Math.min(buffer.length, span.sample_count * 2 - copied);
              const read = readSync(fd, buffer, 0, size, 44 + span.sample_start * 2 + copied);
              if (read !== size) throw new Error('Incomplete speaker audio.');
              writer.write(new Int16Array(buffer.buffer, buffer.byteOffset, read / 2));
              copied += read;
              await setImmediate();
            }
            packedSamples += span.sample_count;
          }
        } finally { closeSync(fd); }
      }
    } finally { writer.close(); }
    out.push({ source, path, mapping });
  }
  return out;
}

export function mapSpeakerTurns(input: SpeakerInput, turns: Array<{ start_ms: number; end_ms: number; speaker: string }>): SpeakerTurn[] {
  const out: SpeakerTurn[] = [];
  for (const turn of turns) for (const span of input.mapping) {
    const start = Math.max(turn.start_ms, span.packed_start_ms);
    const end = Math.min(turn.end_ms, span.packed_start_ms + span.end_ms - span.start_ms);
    if (end > start) out.push({ source: input.source, speaker: turn.speaker,
      start_ms: Math.max(span.start_ms, span.start_ms + start - span.packed_start_ms),
      end_ms: Math.min(span.end_ms, span.start_ms + end - span.packed_start_ms) });
  }
  return out;
}
