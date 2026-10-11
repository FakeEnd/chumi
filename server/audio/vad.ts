import { EventEmitter } from 'node:events';
import { SAMPLE_RATE } from './wav.ts';

export interface Utterance {
  id: number;
  /** Source-clock seconds of the first sample. */
  startSec: number;
  endSec: number;
  samples: Int16Array;
  final: boolean;
}

export interface SegmenterOptions {
  frameMs: number;
  prerollMs: number;
  /** Silence needed to close an utterance. */
  endSilenceMs: number;
  /** Long monologues are split (at the quietest point) so finals keep flowing. */
  maxUtteranceSec: number;
  minUtteranceMs: number;
  /** How often to emit a growing snapshot for partial (revisable) transcription. */
  progressMs: number;
  /** A pause this long counts as a "meaningful pause" (used to time overview updates). */
  pauseEventMs: number;
}

const DEFAULTS: SegmenterOptions = {
  frameMs: 20, prerollMs: 300, endSilenceMs: 500, maxUtteranceSec: 15, minUtteranceMs: 450, progressMs: 1500, pauseEventMs: 2500,
};

/**
 * Energy-based voice activity segmenter with an adaptive noise floor.
 * Emits growing snapshots ("progress") for partial transcripts and closed utterances ("final").
 */
export class Segmenter extends EventEmitter<{ progress: [Utterance]; final: [Utterance]; pause: [atSec: number] }> {
  private o: SegmenterOptions;
  private frameLen: number;
  private pending: Int16Array = new Int16Array(0);
  private clock: number | null = null; // source-clock seconds of the next unprocessed sample
  private floor = -50;
  private preroll: Int16Array[] = [];
  private active = false;
  private chunks: Int16Array[] = [];
  private energies: number[] = []; // per frame dB inside the active utterance
  private startSec = 0;
  private speechRun = 0;
  private silenceRun = 0;
  private idleSilenceFrames = 0;
  private pauseEmitted = false;
  private sinceProgress = 0;
  /** Utterance ids are unique across segmenters/runs so partial and final results can never be confused. */
  private static counter = 1;
  private nextId = Segmenter.counter++;

  constructor(opts: Partial<SegmenterOptions> = {}) {
    super();
    this.o = { ...DEFAULTS, ...opts };
    this.frameLen = Math.round(SAMPLE_RATE * this.o.frameMs / 1000);
  }

  get isActive(): boolean { return this.active; }

  push(tsSec: number, samples: Int16Array): void {
    if (this.clock !== null && Math.abs(tsSec - (this.clock + this.pending.length / SAMPLE_RATE)) > 0.3) {
      // Discontinuity (dropped audio, device switch): close what we have and restart the clock.
      this.flush();
      this.pending = new Int16Array(0);
      this.clock = null;
    }
    if (this.clock === null) this.clock = tsSec - this.pending.length / SAMPLE_RATE;
    const merged = new Int16Array(this.pending.length + samples.length);
    merged.set(this.pending); merged.set(samples, this.pending.length);
    let off = 0;
    while (off + this.frameLen <= merged.length) {
      this.processFrame(merged.subarray(off, off + this.frameLen));
      off += this.frameLen;
      this.clock += this.frameLen / SAMPLE_RATE;
    }
    this.pending = merged.slice(off);
  }

  /** Close the current utterance immediately (pause / end of session). */
  flush(): void {
    if (this.active) this.finish(this.chunks.length, true);
    this.active = false;
    this.chunks = []; this.energies = []; this.preroll = [];
    this.speechRun = 0; this.silenceRun = 0;
  }

  private processFrame(frame: Int16Array): void {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) { const v = frame[i] / 32768; sum += v * v; }
    const db = 10 * Math.log10(sum / frame.length + 1e-12);
    if (db < this.floor) this.floor = this.floor * 0.8 + db * 0.2;
    else this.floor = Math.min(-35, this.floor + 0.004 * (db - this.floor));
    const speech = db > Math.max(this.floor + 9, -52);
    const copy = frame.slice();

    if (!this.active) {
      this.preroll.push(copy);
      const maxPre = Math.ceil(this.o.prerollMs / this.o.frameMs);
      while (this.preroll.length > maxPre) this.preroll.shift();
      this.speechRun = speech ? this.speechRun + 1 : 0;
      if (!speech) {
        this.idleSilenceFrames++;
        if (!this.pauseEmitted && this.idleSilenceFrames * this.o.frameMs >= this.o.pauseEventMs) {
          this.pauseEmitted = true;
          this.emit('pause', this.clock!);
        }
      } else this.idleSilenceFrames = 0;
      if (this.speechRun >= 3) {
        this.active = true;
        this.chunks = this.preroll.slice();
        this.energies = this.chunks.map(() => db);
        this.startSec = this.clock! + this.o.frameMs / 1000 - this.chunks.length * this.o.frameMs / 1000;
        this.preroll = [];
        this.silenceRun = 0;
        this.sinceProgress = 0;
        this.pauseEmitted = false;
        this.idleSilenceFrames = 0;
      }
      return;
    }

    this.chunks.push(copy);
    this.energies.push(db);
    this.silenceRun = speech ? 0 : this.silenceRun + 1;
    this.sinceProgress += this.o.frameMs;

    if (this.silenceRun * this.o.frameMs >= this.o.endSilenceMs) {
      // Keep ~250 ms of trailing silence; the rest goes back to the preroll buffer.
      const keep = this.chunks.length - this.silenceRun + Math.ceil(250 / this.o.frameMs);
      this.finish(keep, false);
      this.active = false;
      this.idleSilenceFrames = this.silenceRun;
      this.speechRun = 0;
      return;
    }

    const durSec = this.chunks.length * this.o.frameMs / 1000;
    if (durSec >= this.o.maxUtteranceSec && this.silenceRun * this.o.frameMs >= 200) {
      // Already in a pause: end the utterance there (a natural boundary) instead of splitting.
      const keep = this.chunks.length - this.silenceRun + Math.ceil(250 / this.o.frameMs);
      this.finish(keep, false);
      this.active = false;
      this.idleSilenceFrames = this.silenceRun;
      this.speechRun = 0;
      return;
    }
    if (durSec >= this.o.maxUtteranceSec) {
      // Split at the quietest 300 ms window within the last 5 s.
      const win = Math.ceil(300 / this.o.frameMs);
      const searchFrom = Math.max(win, this.chunks.length - Math.ceil(5000 / this.o.frameMs));
      let best = this.chunks.length - win, bestE = Infinity;
      for (let i = searchFrom; i + win <= this.chunks.length; i++) {
        let e = 0;
        for (let j = i; j < i + win; j++) e += this.energies[j];
        if (e < bestE) { bestE = e; best = i + Math.floor(win / 2); }
      }
      const restChunks = this.chunks.slice(best);
      const restEnergies = this.energies.slice(best);
      const restStart = this.startSec + best * this.o.frameMs / 1000;
      this.finish(best, false);
      this.chunks = restChunks; this.energies = restEnergies; this.startSec = restStart;
      // The trailing-silence count can't exceed what is left after the split.
      this.silenceRun = Math.min(this.silenceRun, restChunks.length);
      this.sinceProgress = 0;
      return;
    }

    if (this.sinceProgress >= this.o.progressMs && durSec >= 1) {
      this.sinceProgress = 0;
      this.emit('progress', this.snapshot(this.chunks.length, false));
    }
  }

  private snapshot(nChunks: number, final: boolean): Utterance {
    const n = Math.max(0, Math.min(nChunks, this.chunks.length));
    const samples = new Int16Array(n * this.frameLen);
    for (let i = 0; i < n; i++) samples.set(this.chunks[i], i * this.frameLen);
    return { id: this.nextId, startSec: this.startSec, endSec: this.startSec + samples.length / SAMPLE_RATE, samples, final };
  }

  private finish(nChunks: number, _forced: boolean): void {
    nChunks = Math.max(0, Math.min(nChunks, this.chunks.length));
    if (nChunks === 0) { this.nextId = Segmenter.counter++; this.chunks = []; this.energies = []; return; }
    const u = this.snapshot(nChunks, true);
    // Count voiced frames: very short blips (coughs, clicks) are dropped.
    const voicedMs = this.energies.slice(0, nChunks).filter((e) => e > Math.max(this.floor + 9, -52)).length * this.o.frameMs;
    if (voicedMs >= this.o.minUtteranceMs) this.emit('final', u);
    this.nextId = Segmenter.counter++;
    this.chunks = []; this.energies = [];
  }
}
