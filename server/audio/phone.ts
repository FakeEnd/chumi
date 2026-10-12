/**
 * Audio from the Chumi phone app (android/): the same "CHA1" frames as the native helper (16 kHz mono PCM),
 * uploaded over an authenticated HTTP stream (server/remote/access.ts). The phone keeps recording through network
 * drops and sends what it buffered when it reconnects, so each capture on the phone has an id and its own clock.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { FrameParser, type AudioInput, type CaptureEvents } from './capture.ts';
import { SAMPLE_RATE } from './wav.ts';

export class PhoneCapture extends EventEmitter<CaptureEvents> implements AudioInput {
  readonly kind = 'phone';
  private startedAt = 0;
  private upload: IncomingMessage | null = null;
  /** Seconds added to each phone capture's clock to place it in this run's time. */
  private offsets = new Map<string, number>();
  private endTs = 0;
  private stopped = false;
  private levelAt = 0;

  get connected(): boolean { return !!this.upload; }
  get active(): boolean { return !this.stopped; }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.stopped = false;
    this.emit('helper', { type: 'ready', sources: ['mic'], micDevice: 'phone' });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.upload?.destroy();
    this.upload = null;
    this.emit('exit', 0, 'stopped');
  }

  /** Reads one upload until it ends. A newer upload from the phone replaces an older one. */
  attach(req: IncomingMessage, captureId: string): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('The session is not recording.'));
    this.upload?.destroy();
    this.upload = req;
    this.emit('helper', { type: 'info', code: 'phone_connected', message: 'The phone is sending audio.' });
    const parser = new FrameParser((_src, ts, samples) => this.onFrame(captureId, ts, samples));
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this.upload === req) {
          this.upload = null;
          if (!this.stopped) this.emit('helper', { type: 'warning', code: 'phone_disconnected', message: 'The phone stopped sending audio. It keeps recording and catches up when it reconnects.' });
        }
        resolve();
      };
      req.on('data', (d: Buffer) => { if (this.upload === req) parser.push(d); });
      req.on('end', finish);
      req.on('close', finish);
      req.on('error', finish);
    });
  }

  private onFrame(captureId: string, ts: number, samples: Int16Array): void {
    if (this.stopped || !samples.length) return;
    let offset = this.offsets.get(captureId);
    if (offset === undefined) {
      // A new capture starts now (or right after the previous one, if the phone was ahead of the server clock).
      offset = Math.max(this.endTs, (Date.now() - this.startedAt) / 1000) - ts;
      this.offsets.set(captureId, offset);
    }
    const at = ts + offset;
    const dur = samples.length / SAMPLE_RATE;
    if (at + dur <= this.endTs + 0.001) return; // already received before a reconnect
    this.endTs = Math.max(this.endTs, at + dur);
    this.emit('frames', 'mic', at, samples);
    const nowMs = Date.now();
    if (nowMs - this.levelAt >= 100) {
      this.levelAt = nowMs;
      let sum = 0, peak = 0;
      for (const v of samples) { const x = Math.abs(v / 32768); sum += x * x; if (x > peak) peak = x; }
      this.emit('level', 'mic', 10 * Math.log10(sum / samples.length + 1e-12), 20 * Math.log10(peak + 1e-9));
    }
  }
}

/** The phone input of the live session, if it records from the phone. */
export const phoneLink: { current: PhoneCapture | null } = { current: null };
