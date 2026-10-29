import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { log } from '../util.ts';
import { AUDIO_DIR } from '../paths.ts';
import { WavWriter, wavHeader } from '../session/wavwriter.ts';
import type { SpeakerTurn } from '../../shared/speakers.ts';

const RATE = 16_000;
const MAX_SAMPLES = RATE * 60 * 120;
/** How often an open take rewrites its manifest, so a crash loses at most this much of its timing. */
const CHECKPOINT_MS = 5000;
const activeManifests = new Set<string>();
export interface Span { sample_start: number; sample_count: number; start_ms: number }
/** `open` marks a checkpoint of a take that is still being written (or was, when the app crashed). */
interface Take { version: 1; id: string; source: string; samples: number; spans: Span[]; open?: boolean; incomplete?: boolean }
export interface SavedTake extends Take { path: string }
export interface AudioMapping { packed_start_ms: number; start_ms: number; end_ms: number }
export interface SpeakerInput { source: string; path: string; mapping: AudioMapping[] }

function sessionDir(sessionId: string, root: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session ID.');
  return join(root, sessionId, 'speakers');
}

/**
 * Records timed takes: temporary copies for speaker analysis, or the session's retained audio recording.
 * Every take records its own input-to-session clock mapping; pauses never become invented speech.
 */
export class SpeakerRecorder {
  private directory: string;
  private takes = new Map<string, { writer: WavWriter; take: Take; savedAt: number }>();
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
      entry = { writer: new WavWriter(join(this.directory, `${id}.wav`)), take: { version: 1, id, source, samples: 0, spans: [] }, savedAt: 0 };
      this.takes.set(source, entry);
      activeManifests.add(join(this.directory, `${id}.json`));
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
    const continues = previous && Math.abs(startMs - previousEnd) < 2;
    if (continues) previous.sample_count += samples.length;
    else take.spans.push({ sample_start: take.samples, sample_count: samples.length, start_ms: startMs });
    take.samples += samples.length;
    // A new span checkpoints at once, so samples written after the last checkpoint always continue its last span.
    if (!continues || Date.now() - entry.savedAt >= CHECKPOINT_MS) this.save(entry, true);
  }

  private save(entry: { take: Take; savedAt: number }, open: boolean): void {
    const target = join(this.directory, `${entry.take.id}.json`);
    saveManifest(target, open ? { ...entry.take, open } : entry.take);
    entry.savedAt = Date.now();
  }

  /** Close one source's take and write its final manifest. */
  private finish(source: string): void {
    const entry = this.takes.get(source);
    if (!entry) return;
    this.takes.delete(source);
    try { entry.writer.close(); this.save(entry, false); }
    finally { activeManifests.delete(join(this.directory, `${entry.take.id}.json`)); }
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

const MANIFEST = /^[a-f0-9-]+\.json$/;

function saveManifest(target: string, take: Take): void {
  const fd = openSync(`${target}.tmp`, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(take)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(`${target}.tmp`, target);
}

function validateTake(take: Take, name: string): void {
  if (!take || take.version !== 1 || `${take.id}.json` !== name || !['mic', 'system', 'file'].includes(take.source)
    || !Number.isSafeInteger(take.samples) || take.samples <= 0 || !Array.isArray(take.spans)) throw new Error('Invalid speaker audio manifest.');
  let count = 0, end = -Infinity;
  for (const span of take.spans) {
    if (!span || span.sample_start !== count || !Number.isSafeInteger(span.sample_count) || span.sample_count <= 0
      || !Number.isFinite(span.start_ms) || span.start_ms < 0 || span.start_ms < end - 5) throw new Error('Invalid speaker audio mapping.');
    count += span.sample_count;
    end = span.start_ms + span.sample_count / RATE * 1000;
  }
  if (count !== take.samples) throw new Error('Incomplete speaker audio mapping.');
}

function availableSamples(path: string, open = false): number {
  if (statSync(path).size < 46) return 0;
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(44);
    if (readSync(fd, header, 0, 44, 0) !== 44) throw new Error('Incomplete audio header.');
    // Old open takes reserved a zero-filled header until close.
    if (!(open && header.every((v) => v === 0)) && (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 16) !== 'WAVEfmt '
      || header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 1 || header.readUInt32LE(24) !== RATE
      || header.readUInt16LE(34) !== 16 || header.toString('ascii', 36, 40) !== 'data')) throw new Error('Invalid recording WAV format.');
    return Math.max(0, Math.floor((statSync(path).size - 44) / 2));
  } finally { closeSync(fd); }
}

function resizeTake(take: Take, samples: number): Take {
  const spans = take.spans.filter((s) => s.sample_start < samples).map((s) => ({ ...s, sample_count: Math.min(s.sample_count, samples - s.sample_start) }));
  if (take.open && spans.length) spans[spans.length - 1].sample_count = samples - spans.at(-1)!.sample_start;
  return { ...take, samples, spans, incomplete: take.incomplete || samples < take.samples };
}

function savedTakes(sessionId: string, root: string, modes = ['temporary', 'retained'], issues: string[] = []): SavedTake[] {
  const base = sessionDir(sessionId, root);
  const takes: SavedTake[] = [];
  for (const mode of modes) {
    const directory = join(base, mode);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter((n) => MANIFEST.test(n))) {
      try {
        const wav = join(directory, name.replace(/\.json$/, '.wav'));
        if (existsSync(wav) && statSync(wav).size < 46) continue;
        const take = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Take;
        validateTake(take, name);
        if (take.open) { if (!activeManifests.has(join(directory, name))) throw new Error('Take still needs repair.'); continue; }
        const path = join(directory, `${take.id}.wav`);
        const available = availableSamples(path);
        const clipped = resizeTake(take, Math.min(take.samples, available));
        if (!clipped.samples) throw new Error('No readable samples in take.');
        if (clipped.incomplete || available !== take.samples) issues.push(name);
        takes.push({ ...clipped, path });
      } catch (error) {
        issues.push(name);
        log('recording', `skipping ${name}: ${(error as Error).message}`);
      }
    }
  }
  return takes.sort((a, b) => a.spans[0].start_ms - b.spans[0].start_ms);
}

export function speakerAudioAvailable(sessionId: string, root = AUDIO_DIR): boolean {
  try { recoverOpenTakes(sessionId, root); return savedTakes(sessionId, root).length > 0; } catch { return false; }
}

/** The session's audio recording: retained takes only, never temporary speaker-analysis copies. */
export function recordedTakes(sessionId: string, root = AUDIO_DIR, issues: string[] = []): SavedTake[] {
  return savedTakes(sessionId, root, ['retained'], issues);
}

/** Cheap check for session lists: whether any audio of this session is kept, including a take being recorded now. */
export function hasRecordedAudio(sessionId: string, root = AUDIO_DIR): boolean {
  const directory = join(sessionDir(sessionId, root), 'retained');
  return existsSync(directory) && readdirSync(directory).some((n) => MANIFEST.test(n));
}

/**
 * After a crash, close the takes that were still being written: fix the WAV header and write the final manifest.
 * Audio after the last checkpoint is kept as part of its last span; returns the number of takes recovered.
 */
export function recoverOpenTakes(sessionId: string, root = AUDIO_DIR): number {
  let recovered = 0;
  for (const mode of ['temporary', 'retained']) {
    const directory = join(sessionDir(sessionId, root), mode);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter((n) => MANIFEST.test(n))) {
      const manifest = join(directory, name);
      if (activeManifests.has(manifest)) continue;
      try {
        const path = join(directory, name.replace(/\.json$/, '.wav'));
        if (existsSync(path) && statSync(path).size < 46) {
          for (const empty of [path, manifest, `${manifest}.tmp`]) rmSync(empty, { force: true });
          continue;
        }
        let take: Take;
        try { take = JSON.parse(readFileSync(manifest, 'utf8')) as Take; validateTake(take, name); }
        catch {
          // A complete temporary manifest may survive a failed rename. Never invent timing for an unmapped WAV.
          take = JSON.parse(readFileSync(`${manifest}.tmp`, 'utf8')) as Take;
          validateTake(take, name);
          take.open = true;
        }
        const wav = join(directory, `${take.id}.wav`);
        const samples = availableSamples(wav, take.open);
        if (!take.open && samples >= take.samples) continue;
        if (!samples) throw new Error('No readable samples in take.');
        const closed = resizeTake(take, samples);
        delete closed.open;
        const fd = openSync(wav, 'r+');
        try {
          ftruncateSync(fd, 44 + samples * 2);
          if (writeSync(fd, wavHeader(samples * 2), 0, 44, 0) !== 44) throw new Error('Incomplete audio header write.');
          fsyncSync(fd);
        } finally { closeSync(fd); }
        saveManifest(manifest, closed);
        recovered++;
      } catch (error) { log('recording', `could not repair ${name}: ${(error as Error).message}`); }

    }
  }
  return recovered;
}

/** Delete only app-owned temporary copies, never the original imported audio or retained recordings. */
export function discardSpeakerAudio(sessionId: string, root = AUDIO_DIR): void {
  const base = sessionDir(sessionId, root);
  for (const name of ['temporary', 'work']) rmSync(join(base, name), { recursive: true, force: true });
}

/** Stream PCM into one file per source so clustering sees returning voices across every take. */
export async function prepareSpeakerInputs(sessionId: string, signal: AbortSignal, root = AUDIO_DIR): Promise<SpeakerInput[]> {
  recoverOpenTakes(sessionId, root);
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
