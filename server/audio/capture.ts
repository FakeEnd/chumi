import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { findAudioHelper } from '../paths.ts';
import { log } from '../util.ts';
import { readWav, SAMPLE_RATE } from './wav.ts';
import type { AudioSourceMode } from '../settings.ts';

export type SourceName = 'mic' | 'system' | 'file';

export interface CaptureEvents {
  frames: [source: SourceName, tsSec: number, samples: Int16Array];
  level: [source: SourceName, rms: number, peak: number];
  helper: [event: Record<string, unknown>];
  exit: [code: number | null, reason: string];
}

export interface AudioInput extends EventEmitter<CaptureEvents> {
  readonly kind: 'helper' | 'file';
  start(): Promise<void>;
  stop(): Promise<void>;
}

const MAGIC = Buffer.from('CHA1');
const HEADER = 20;

/** Parses the helper's binary frame stream: "CHA1" | src u8 | flags u8 | u16 | f64 ts | u32 n | n × i16. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private onFrame: (src: number, ts: number, samples: Int16Array) => void;
  constructor(onFrame: (src: number, ts: number, samples: Int16Array) => void) { this.onFrame = onFrame; }
  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < HEADER) return;
      if (!this.buf.subarray(0, 4).equals(MAGIC)) {
        // Resynchronise on the next magic marker (should never happen with a healthy helper).
        const idx = this.buf.indexOf(MAGIC, 1);
        this.buf = idx < 0 ? Buffer.alloc(0) : this.buf.subarray(idx);
        continue;
      }
      const n = this.buf.readUInt32LE(16);
      const total = HEADER + n * 2;
      if (this.buf.length < total) return;
      const src = this.buf.readUInt8(4);
      const ts = this.buf.readDoubleLE(8);
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = this.buf.readInt16LE(HEADER + i * 2);
      this.buf = this.buf.subarray(total);
      this.onFrame(src, ts, samples);
    }
  }
}

/** Permission probes and capture must use the same macOS privacy identity. */
export function audioHelperArgs(args: string[], platform: NodeJS.Platform = process.platform, appMode = !!process.env.CHUMI_APP): string[] {
  return platform === 'darwin' && !appMode ? [...args, '--self-responsible'] : [...args];
}

/** Live capture through the platform's native helper. Both use the same PCM/event protocol. */
export class HelperCapture extends EventEmitter<CaptureEvents> implements AudioInput {
  readonly kind = 'helper';
  private proc: ChildProcess | null = null;
  private stopping = false;
  private opts: { source: AudioSourceMode; micDeviceUid?: string | null; aec?: boolean };
  constructor(opts: { source: AudioSourceMode; micDeviceUid?: string | null; aec?: boolean }) { super(); this.opts = opts; }

  async start(): Promise<void> {
    this.stopping = false;
    const helper = findAudioHelper();
    if (!helper) throw new Error(process.platform === 'win32' ? 'The audio component is missing. Reinstall Chumi to restore it.' : 'Audio helper not built. Run "npm run build:native" (see README).');
    const args = audioHelperArgs(['--source', this.opts.source]);
    if (this.opts.micDeviceUid) args.push('--mic-device', this.opts.micDeviceUid);
    if (this.opts.source === 'both') args.push('--aec', this.opts.aec === false ? 'off' : 'on');
    log('audio', 'spawn', helper, args.join(' '));
    const proc = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    const parser = new FrameParser((src, ts, samples) => this.emit('frames', src === 2 ? 'system' : 'mic', ts, samples));
    proc.stdout!.on('data', (d: Buffer) => parser.push(d));
    let errBuf = '';
    proc.stderr!.on('data', (d: Buffer) => {
      errBuf += d.toString('utf8');
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i).trim();
        errBuf = errBuf.slice(i + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev.type === 'level') this.emit('level', ev.source as SourceName, Number(ev.rms), Number(ev.peak));
          else { this.emit('helper', ev); if (ev.type !== 'ready') log('audio', 'helper:', line); }
        } catch { log('audio', 'helper stderr:', line); }
      }
    });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      this.emit('exit', code, this.stopping ? 'stopped' : `helper exited (code ${code}${signal ? `, ${signal}` : ''})`);
    });
    // Wait until the helper reports ready (or fails) so callers can surface permission errors.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        if (process.platform === 'win32') {
          proc.stdin!.end();
          reject(new Error('Audio capture did not start. Check your audio device and Windows microphone settings.'));
        } else {
          this.emit('helper', { type: 'warning', code: 'helper_waiting', message: 'Audio capture is waiting for macOS. Look for a permission dialog from Chumi or chumi-audio (Documents folder, Microphone or System Audio Recording) and allow it.' });
          resolve();
        }
      }, 8000);
      const onHelper = (ev: Record<string, unknown>) => { if (ev.type === 'ready') { cleanup(); resolve(); } };
      const onExit = (_code: number | null, reason: string) => { cleanup(); reject(new Error(`Audio capture failed to start: ${reason}`)); };
      const onError = (error: Error) => { cleanup(); this.proc = null; reject(error); };
      const cleanup = () => { clearTimeout(timer); this.off('helper', onHelper); this.off('exit', onExit); proc.off('error', onError); };
      this.on('helper', onHelper); this.on('exit', onExit);
      proc.once('error', onError);
    });
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 3000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      try { p.stdin?.end(); if (process.platform !== 'win32') p.kill('SIGTERM'); } catch { resolve(); }
    });
  }
}

/** Streams a WAV file through the same pipeline, in real time or accelerated (for demos and acceptance tests). */
export class FileCapture extends EventEmitter<CaptureEvents> implements AudioInput {
  readonly kind = 'file';
  private timer: NodeJS.Timeout | null = null;
  private pos = 0;
  private samples: Int16Array | null = null;
  private path: string;
  private speed: number;
  private startAtSec: number;
  constructor(path: string, speed = 1, startAtSec = 0) { super(); this.path = path; this.speed = speed; this.startAtSec = startAtSec; }
  get positionSec(): number { return this.pos / SAMPLE_RATE; }
  async start(): Promise<void> {
    this.samples ??= readWav(this.path);
    if (this.pos === 0) this.pos = Math.floor(this.startAtSec * SAMPLE_RATE);
    const chunk = Math.round(SAMPLE_RATE * 0.05); // 50 ms frames, like the helper
    const intervalMs = Math.max(1, 50 / this.speed);
    let levelTick = 0;
    const startWall = Date.now();
    const startPos = this.pos;
    this.timer = setInterval(() => {
      const s = this.samples!;
      // Catch up based on elapsed wall time so timer jitter doesn't slow playback.
      const target = startPos + Math.floor(((Date.now() - startWall) / 1000) * SAMPLE_RATE * this.speed);
      while (this.pos < Math.min(target, s.length)) {
        const end = Math.min(this.pos + chunk, s.length);
        const frame = s.slice(this.pos, end);
        this.emit('frames', 'file', this.pos / SAMPLE_RATE, frame);
        if (++levelTick % 2 === 0) {
          let sum = 0, peak = 0;
          for (const v of frame) { const x = Math.abs(v / 32768); sum += x * x; if (x > peak) peak = x; }
          this.emit('level', 'file', 10 * Math.log10(sum / frame.length + 1e-12), 20 * Math.log10(peak + 1e-9));
        }
        this.pos = end;
      }
      if (this.pos >= s.length) { void this.stop().then(() => this.emit('exit', 0, 'file finished')); }
    }, intervalMs);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function listDevices(): Promise<unknown[]> {
  const helper = findAudioHelper();
  if (!helper) return Promise.resolve([]);
  return new Promise((resolve) => execFile(helper, ['--list-devices'], { timeout: 5000, windowsHide: true }, (err, out) => {
    if (err) return resolve([]);
    try { resolve(JSON.parse(out)); } catch { resolve([]); }
  }));
}

export function checkPermissions(): Promise<Record<string, string>> {
  const helper = findAudioHelper();
  if (!helper) return Promise.resolve({ microphone: 'unknown', systemAudio: 'unknown', helper: 'missing' });
  return new Promise((resolve) => execFile(helper, audioHelperArgs(['--check-permissions']), { timeout: 5000, windowsHide: true }, (err, out) => {
    if (err) return resolve({ microphone: 'unknown', systemAudio: 'unknown' });
    try { resolve(JSON.parse(out)); } catch { resolve({ microphone: 'unknown', systemAudio: 'unknown' }); }
  }));
}
