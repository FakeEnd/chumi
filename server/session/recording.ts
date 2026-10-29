import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, openSync, readSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { AUDIO_DIR } from '../paths.ts';
import { log } from '../util.ts';
import { recordedTakes, recoverOpenTakes, type SavedTake } from '../speakers/audio.ts';
import { wavHeader } from './wavwriter.ts';
import type { PlaybackInfo, PlaybackRegion } from '../../shared/recording.ts';

const PER_MS = 16; // samples per millisecond at 16 kHz
/** Silences up to this long stay as recorded; longer gaps (pauses, restarts) become a BREAK_MS break. */
const KEEP_GAP_MS = 2000;
const BREAK_MS = 1000;
const BLOCK = 16_000 * 10;
const LAYOUT = 1; // bump when the layout changes, so cached exports are rebuilt

interface Placed { path: string; sample_start: number; sample_count: number; at: number }
/** The session's recording as one mono track: every source mixed, in session order. */
export interface Recording extends PlaybackInfo { samples: number; placed: Placed[]; bytes: number }

/** Lay the recorded spans of every source end to end; sources that overlap in session time are mixed. */
export function playbackLayout(takes: SavedTake[]): { regions: PlaybackRegion[]; placed: Placed[]; samples: number } {
  const spans = takes.flatMap((take) => take.spans.map((s) => ({ ...s, path: take.path, end_ms: s.start_ms + s.sample_count / PER_MS })))
    .sort((a, b) => a.start_ms - b.start_ms);
  const regions: PlaybackRegion[] = [];
  const placed: Placed[] = [];
  let samples = 0;
  for (const s of spans) {
    let region = regions.at(-1);
    if (region && s.start_ms <= region.end_ms + KEEP_GAP_MS) region.end_ms = Math.max(region.end_ms, s.end_ms);
    else {
      const packed = region ? region.packed_ms + region.end_ms - region.start_ms + BREAK_MS : 0;
      region = { packed_ms: packed, start_ms: s.start_ms, end_ms: s.end_ms };
      regions.push(region);
    }
    const at = Math.round((region.packed_ms + s.start_ms - region.start_ms) * PER_MS);
    placed.push({ path: s.path, sample_start: s.sample_start, sample_count: s.sample_count, at });
    samples = Math.max(samples, at + s.sample_count);
  }
  return { regions, placed, samples };
}

/** Repair abandoned takes lazily, then play every readable part of the retained recording. */
export function sessionRecording(sessionId: string, root = AUDIO_DIR): Recording | null {
  recoverOpenTakes(sessionId, root);
  const issues: string[] = [];
  const takes = recordedTakes(sessionId, root, issues);
  if (!takes.length) { if (issues.length) throw new Error('No readable audio remains in this recording.'); return null; }
  const { regions, placed, samples } = playbackLayout(takes);
  const version = createHash('sha1').update(JSON.stringify([LAYOUT, ...takes.map((t) => [t.id, t.samples])])).digest('hex').slice(0, 12);
  return { version, duration_ms: samples / PER_MS, regions, samples, placed, bytes: 44 + samples * 2, ...(issues.length ? { warning: 'Part of this recording could not be read. Available audio is still playable.' } : {}) };
}

export const playbackInfo = ({ version, duration_ms, regions, warning }: Recording): PlaybackInfo => ({ version, duration_ms, regions, ...(warning ? { warning } : {}) });

function mixBlock(rec: Recording, start: number, n: number, fds: Map<string, number>): Int16Array {
  const acc = new Int32Array(n);
  for (const p of rec.placed) {
    const from = Math.max(start, p.at), to = Math.min(start + n, p.at + p.sample_count);
    if (to <= from) continue;
    let fd = fds.get(p.path);
    if (fd === undefined) { fd = openSync(p.path, 'r'); fds.set(p.path, fd); }
    const buffer = Buffer.alloc((to - from) * 2);
    if (readSync(fd, buffer, 0, buffer.length, 44 + (p.sample_start + from - p.at) * 2) !== buffer.length) throw new Error('The audio recording is incomplete.');
    const pcm = new Int16Array(buffer.buffer, buffer.byteOffset, to - from);
    for (let i = 0; i < pcm.length; i++) acc[from - start + i] += pcm[i];
  }
  return Int16Array.from(acc, (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v));
}

/** Bytes [from, to) of the recording as a WAV file, mixed on the fly so no second copy is kept on disk. */
export async function* recordingBytes(rec: Recording, from = 0, to = rec.bytes): AsyncGenerator<Buffer> {
  if (from < 44) { yield wavHeader(rec.samples * 2).subarray(from, Math.min(44, to)); from = 44; }
  const end = Math.ceil((to - 44) / 2);
  const fds = new Map<string, number>();
  try {
    for (let s = Math.floor((from - 44) / 2); s < end; s += BLOCK) {
      const n = Math.min(BLOCK, end - s);
      const pcm = mixBlock(rec, s, n, fds);
      // A range may start or end inside a sample.
      yield Buffer.from(pcm.buffer, pcm.byteOffset, n * 2).subarray(Math.max(0, from - 44 - s * 2), Math.min(n * 2, to - 44 - s * 2));
    }
  } finally { for (const fd of fds.values()) closeSync(fd); }
}

const run = promisify(execFile);
type Exported = { path: string | null; ext: 'm4a' | 'wav' };
const exporting = new Map<string, Promise<Exported>>();

/**
 * One file to keep or share. On macOS it is AAC (.m4a, about 14 MB per hour), cached until the recording changes;
 * elsewhere, or if encoding fails, the caller streams the WAV itself (path is then null).
 */
export function exportRecording(sessionId: string, rec: Recording, root = AUDIO_DIR): Promise<Exported> {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/afconvert')) return Promise.resolve({ path: null, ext: 'wav' });
  const dir = join(root, sessionId);
  const target = join(dir, `export-${rec.version}.m4a`);
  if (existsSync(target)) return Promise.resolve({ path: target, ext: 'm4a' });
  const pending = exporting.get(target);
  if (pending) return pending;
  const job = (async (): Promise<Exported> => {
    const wav = join(dir, 'export.wav.tmp'), m4a = `${target}.tmp`;
    try {
      for (const name of readdirSync(dir)) if (/^export-[0-9a-f]+\.m4a$/.test(name)) rmSync(join(dir, name), { force: true });
      await pipeline(Readable.from(recordingBytes(rec)), createWriteStream(wav, { mode: 0o600 }));
      await run('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '32000', wav, m4a], { timeout: 10 * 60_000 });
      renameSync(m4a, target);
      return { path: target, ext: 'm4a' };
    } catch (error) {
      log('recording', `AAC export failed, offering WAV: ${(error as Error).message}`);
      rmSync(m4a, { force: true });
      return { path: null, ext: 'wav' };
    } finally {
      rmSync(wav, { force: true });
      exporting.delete(target);
    }
  })();
  exporting.set(target, job);
  return job;
}
