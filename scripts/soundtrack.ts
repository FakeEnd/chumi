/**
 * The music of the promo videos, synthesised here (no third-party audio) and deterministic (seeded noise).
 *
 *   lively(): the Chumi promo. A light, bouncy groove at 112 BPM in F major (F–Am–B♭–C): a plucked ukulele strum,
 *             upright-style bass, finger snaps, shaker and a soft kick, a marimba answering on the off-beats, and a
 *             whistled hook where the video lifts.
 *   bouncy(): the desktop-pet video. 120 BPM, C–G–Am–F: pad, bass, soft drums and a music-box melody.
 *
 * Both take section times in seconds of the finished video and play to its end, whatever its length.
 * Mix is the shared buffer: sound effects are added to it, and write() masters it into a WAV file.
 */
import { writeFileSync } from 'node:fs';

export const SR = 44100;
const TAU = Math.PI * 2;
export const midi = (m: number): number => 440 * 2 ** ((m - 69) / 12);
const tri = (x: number) => (2 / Math.PI) * Math.asin(Math.sin(x));

export class Mix {
  readonly duration: number;
  readonly n: number;
  readonly L: Float32Array;
  readonly R: Float32Array;
  private seed = 7;
  constructor(duration: number) {
    this.duration = duration;
    this.n = Math.ceil(duration * SR);
    this.L = new Float32Array(this.n); this.R = new Float32Array(this.n);
  }
  noise(): number { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 2 ** 31 - 1; }
  /** Mix `fn(t)` in from t0 for len seconds; pan 0 (left) … 1 (right). */
  add(t0: number, len: number, gain: number, pan: number, fn: (t: number) => number): void {
    const s0 = Math.floor(t0 * SR), m = Math.floor(len * SR), gl = gain * Math.cos(pan * Math.PI / 2), gr = gain * Math.sin(pan * Math.PI / 2);
    for (let j = Math.max(0, -s0); j < m && s0 + j < this.n; j++) { const v = fn(j / SR); this.L[s0 + j] += v * gl; this.R[s0 + j] += v * gr; }
  }
  addBuf(t0: number, buf: Float32Array, gain: number, pan: number): void {
    const s0 = Math.floor(t0 * SR), gl = gain * Math.cos(pan * Math.PI / 2), gr = gain * Math.sin(pan * Math.PI / 2);
    for (let j = Math.max(0, -s0); j < buf.length && s0 + j < this.n; j++) { this.L[s0 + j] += buf[j] * gl; this.R[s0 + j] += buf[j] * gr; }
  }
  /** Noise through a one-pole low-pass whose cutoff follows `cut(t)` (0–1); high: what the low-pass removes. */
  filtered(cut: (t: number) => number, high = false): (t: number) => number {
    let lp = 0;
    return (t) => { const x = this.noise(); lp += (x - lp) * cut(t); return high ? x - lp : lp; };
  }
  /** Fade in and out, soft-clip, normalise to `level` and write a 16-bit stereo WAV. */
  write(file: string, { fadeIn = 0.25, fadeOut = 1.2, drive = 1.4, level = 0.85 } = {}): void {
    const { n, L, R, duration } = this;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR, g = Math.min(1, t / fadeIn) * Math.min(1, (duration - t) / fadeOut);
      L[i] = Math.tanh(L[i] * g * drive); R[i] = Math.tanh(R[i] * g * drive); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    }
    const scale = level / (peak || 1), buf = Buffer.alloc(44 + n * 4);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
    for (let i = 0; i < n; i++) { buf.writeInt16LE(Math.round(L[i] * scale * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * scale * 32767), 46 + i * 4); }
    writeFileSync(file, buf);
  }
}

/** A bell or music-box note. */
export const bell = (f: number, decay: number) => (t: number): number =>
  Math.min(1, t * 300) * Math.exp(-t * decay) * (Math.sin(TAU * f * t) + 0.32 * Math.sin(TAU * 2 * f * t) * Math.exp(-t * 6) + 0.12 * Math.sin(TAU * 4.07 * f * t) * Math.exp(-t * 14));
/** A marimba bar: the fundamental and its two bright, quickly fading partials. */
const marimba = (f: number) => (t: number): number =>
  Math.min(1, t * 900) * (Math.sin(TAU * f * t) * Math.exp(-t * 5.5) + 0.3 * Math.sin(TAU * f * 3.93 * t) * Math.exp(-t * 24) + 0.08 * Math.sin(TAU * f * 9.2 * t) * Math.exp(-t * 45));

// ------------------------------------------------------------------ lively(): the Chumi promo
export type LivelyPlan = {
  /** When the bass, snaps and shaker come in. */ build: number;
  /** When the full groove (kick and marimba) starts. */ groove: number;
  /** Stretches where the whistled hook plays. */ hook: Array<[number, number]>;
  /** The final strum; the music rings out after it. */ end: number;
};

export function lively(mix: Mix, plan: LivelyPlan): void {
  const BEAT = 60 / 112, BAR = BEAT * 4, EIGHTH = BEAT / 2;
  // Ukulele voicings, strings G–C–E–A (re-entrant G), and the bass root of each chord.
  const CHORDS = [
    { uke: [69, 60, 65, 69], root: 41, tones: [65, 69, 72] },   // F
    { uke: [69, 60, 64, 69], root: 45, tones: [64, 69, 72] },   // Am
    { uke: [70, 62, 65, 70], root: 46, tones: [65, 70, 74] },   // B♭
    { uke: [67, 60, 64, 72], root: 48, tones: [64, 67, 72] },   // C
  ];
  // The whistled hook: [beat in the bar, note, beats] for each of the four bars.
  const HOOK = [
    [[0, 72, 1], [1, 69, 0.5], [1.5, 72, 0.5], [2, 77, 1.5], [3.5, 76, 0.5]],
    [[0, 76, 1], [1, 72, 0.5], [1.5, 69, 0.5], [2, 72, 2]],
    [[0, 74, 1], [1, 70, 0.5], [1.5, 74, 0.5], [2, 77, 1], [3, 79, 1]],
    [[0, 79, 1.5], [1.5, 77, 0.5], [2, 76, 1], [3, 72, 1]],
  ];
  const endBar = Math.round(plan.end / BAR);  // the final strum lands on the downbeat nearest plan.end
  const inHook = (t: number) => plan.hook.some(([a, b]) => t >= a && t < b);

  // Karplus–Strong plucks, a few takes per string so repeated strums don't sound copied.
  const takes = new Map<string, Float32Array>();
  const pluck = (m: number, take: number): Float32Array => {
    const key = `${m}:${take}`;
    let out = takes.get(key);
    if (out) return out;
    const N = Math.max(2, Math.round(SR / midi(m))), ring = new Float32Array(N);
    let lp = 0, peak = 0, mean = 0;
    for (let i = 0; i < N; i++) { lp += (mix.noise() - lp) * 0.55; ring[i] = lp; mean += lp / N; }
    for (let i = 0; i < N; i++) { ring[i] -= mean; peak = Math.max(peak, Math.abs(ring[i])); }
    out = new Float32Array(Math.floor(1.6 * SR));
    for (let i = 0, j = 0; i < out.length; i++) { const k = (j + 1) % N, a = ring[j]; out[i] = a / (peak || 1); ring[j] = 0.9968 * 0.5 * (a + ring[k]); j = k; }
    takes.set(key, out);
    return out;
  };
  const strum = (at: number, notes: number[], down: boolean, gain: number, b: number) => {
    const order = down ? notes : [...notes].reverse();
    order.forEach((m, i) => mix.addBuf(at + i * (down ? 0.013 : 0.009), pluck(m, (b + i) % 3), gain * (down ? 1 : 0.7) * (i === 0 ? 0.9 : 1), 0.42 + 0.05 * i));
  };

  for (let b = 0; b <= endBar; b++) {
    const t0 = b * BAR;
    if (t0 >= mix.duration) break;
    const ch = CHORDS[b % 4];
    if (b === endBar) {
      // The ending: one big strum on F, the bass, and a glockenspiel run up.
      strum(t0, CHORDS[0].uke, true, 0.32, b);
      strum(t0 + 0.05, [77, 81, 84], true, 0.14, b + 1);
      mix.add(t0, 2.6, 0.32, 0.5, (t) => Math.min(1, t * 300) * Math.exp(-t * 1.8) * (Math.sin(TAU * midi(41) * t) + 0.3 * tri(TAU * midi(53) * t)));
      [84, 89, 93, 96, 101].forEach((m, i) => mix.add(t0 + 0.08 + i * 0.06, 1.6, 0.09, 0.3 + 0.1 * i, bell(midi(m), 3.2)));
      break;
    }
    const built = t0 >= plan.build - 0.01, full = t0 >= plan.groove - 0.01;
    // Ukulele: down on the beats while it starts, then the island strum D · D U · U D U.
    const pattern: Array<[number, boolean]> = built ? [[0, true], [2, true], [3, false], [5, false], [6, true], [7, false]] : [[0, true], [4, true]];
    for (const [k, down] of pattern) strum(t0 + k * EIGHTH, ch.uke, down, (k % 2 ? 0.16 : 0.22) * (built ? 1 : 1.15), b + k);
    if (!built) {
      // A twinkle at the top of the first bars.
      if (b % 2 === 0) [84, 88, 91].forEach((m, i) => mix.add(t0 + 0.02 + i * 0.07, 1.2, 0.05, 0.6 - 0.1 * i, bell(midi(m), 4)));
      continue;
    }
    // Bass: root on 1, its octave on the "and" of 2, the fifth on 3, a step back on the "and" of 4.
    for (const [beat, d, len] of [[0, 0, 0.9], [1.5, 12, 0.35], [2, 7, 0.8], [3.5, b % 2 ? 2 : -1, 0.35]] as const) {
      const f = midi(ch.root + d);
      mix.add(t0 + beat * BEAT, len + 0.15, 0.34, 0.5, (t) => Math.min(1, t * 260) * Math.exp(-t * 4.2) * Math.min(1, (len + 0.15 - t) * 12) * (Math.sin(TAU * f * t) + 0.35 * tri(TAU * f * t) + 0.12 * Math.sin(TAU * 2 * f * t)));
    }
    // Finger snaps on 2 and 4.
    for (const beat of [1, 3]) {
      const hp = mix.filtered(() => 0.25, true);
      mix.add(t0 + beat * BEAT, 0.12, 0.2, beat === 1 ? 0.38 : 0.62, (t) => (hp(t) * 1.3 + 0.5 * Math.sin(TAU * 2200 * t)) * Math.exp(-t * 55));
    }
    // Shaker: eighths while building, sixteenths in the groove, leaning on the off-beats.
    const sub = full ? 4 : 2;
    for (let k = 0; k < 4 * sub; k++) {
      const hp = mix.filtered(() => 0.6, true), accent = k % sub === sub / 2 ? 1 : 0.55;
      mix.add(t0 + k * BEAT / sub, 0.07, 0.07 * accent, 0.68, (t) => hp(t) * Math.min(1, t * 400) * Math.exp(-t * 60));
    }
    if (!full) continue;
    // A soft kick on 1 and 3.
    for (const beat of [0, 2]) { let ph = 0; mix.add(t0 + beat * BEAT, 0.3, 0.42, 0.5, (t) => { ph += TAU * (50 + 80 * Math.exp(-t * 30)) / SR; return Math.sin(ph) * Math.exp(-t * 10); }); }
    // Marimba answering on the off-beats, every other bar (or under the hook, quieter, every bar).
    const hook = inHook(t0 + BAR / 2);
    if (hook || b % 2 === 1) [1, 3, 5, 7].forEach((k, i) => mix.add(t0 + k * EIGHTH, 1.0, hook ? 0.05 : 0.08, i % 2 ? 0.7 : 0.3, marimba(midi(ch.tones[[0, 1, 2, 1][i]] + 12))));
    // The whistled hook: an octave up, a scoop into each note and a little vibrato.
    if (hook) for (const [beat, m, len] of HOOK[b % 4]) {
      const f = midi(m + 12), d = len * BEAT;
      let ph = 0;
      mix.add(t0 + beat * BEAT, d + 0.08, 0.15, 0.55, (t) => {
        const scoop = 1 - 0.035 * Math.exp(-t * 40), vib = 1 + 0.006 * Math.sin(TAU * 5.6 * t) * Math.min(1, t * 3);
        ph += TAU * f * scoop * vib / SR;
        const env = Math.min(1, t * 35) * Math.min(1, (d + 0.08 - t) * 14);
        return env * (Math.sin(ph) + 0.04 * Math.sin(2 * ph) + 0.015 * mix.noise());
      });
    }
  }
}

// ------------------------------------------------------------------ bouncy(): the desktop-pet video
export type BouncyPlan = {
  /** When the groove (bass, drums, the full melody) starts. */ groove: number;
  /** The final chord and chime; the music rings out after it. */ end: number;
};

export function bouncy(mix: Mix, plan: BouncyPlan): void {
  const PAD = [[60, 64, 67, 72], [59, 62, 67, 71], [60, 64, 69, 72], [60, 65, 69, 72]];
  const BASS = [36, 43, 45, 41];
  const MEL = [[76, 79, 84, 79, 81, 79, 76, -1], [74, 79, 83, 79, 81, 79, 74, -1], [72, 76, 81, 76, 79, 76, 72, -1], [72, 77, 81, 77, 79, 81, 84, -1]];
  const BAR = 2, EIGHTH = 0.25;
  const endBar = Math.round(plan.end / BAR);
  for (let b = 0; b < endBar && b * BAR < mix.duration; b++) {
    const t0 = b * BAR, c = b % 4, on = t0 >= plan.groove - 0.01;
    for (const [k, m] of PAD[c].entries()) {
      const f = midi(m);
      mix.add(t0, BAR + 0.8, on ? 0.05 : 0.065, 0.3 + 0.13 * k, (t) => Math.min(1, t / 0.35) * Math.min(1, (BAR + 0.8 - t) / 0.8) * (Math.sin(TAU * f * t) + 0.5 * Math.sin(TAU * f * 1.003 * t + 1) + 0.18 * tri(TAU * 2 * f * t)));
    }
    for (let k = 0; k < 8; k++) {
      const at = t0 + k * EIGHTH, m = MEL[c][k];
      if (m > 0 && (on || k % 2 === 0)) {
        mix.add(at, 1.1, on ? 0.15 : 0.12, k % 2 ? 0.66 : 0.34, bell(midi(m), 4.2));
        mix.add(at + 0.375, 1.0, 0.045, k % 2 ? 0.25 : 0.75, bell(midi(m), 4.6));  // echo
      }
      if (!on) continue;
      const bf = midi(BASS[c] + [0, 12, 7, 12][k % 4]);
      mix.add(at, 0.24, 0.2, 0.5, (t) => Math.min(1, t * 200) * Math.exp(-t * 7) * (tri(TAU * bf * t) + 0.4 * Math.sin(TAU * bf * t)));
      if (k % 2 === 1) { const hp = mix.filtered(() => 0.5, true); mix.add(at, 0.05, 0.035, k % 4 === 1 ? 0.62 : 0.38, (t) => hp(t) * Math.exp(-t * 70)); }
    }
    if (!on) continue;
    for (const beat of [0, 1, 2, 3]) {
      const at = t0 + beat * 0.5;
      if (beat % 2 === 0) { let ph = 0; mix.add(at, 0.32, 0.42, 0.5, (t) => { ph += TAU * (48 + 95 * Math.exp(-t * 32)) / SR; return Math.sin(ph) * Math.exp(-t * 9); }); }
      else { const bp = mix.filtered(() => 0.35); mix.add(at, 0.18, 0.2, 0.5, (t) => bp(t) * 1.6 * Math.exp(-t * 26) + 0.5 * Math.sin(TAU * 196 * t) * Math.exp(-t * 22)); }
    }
  }
  // The ending: a bright chord and a chime.
  const end = endBar * BAR;
  for (const [k, m] of [48, 60, 64, 67, 72, 76].entries()) mix.add(end, 2.4, 0.07, 0.3 + 0.08 * k, (t) => Math.min(1, t * 40) * Math.exp(-t * 1.6) * (Math.sin(TAU * midi(m) * t) + 0.2 * tri(TAU * 2 * midi(m) * t)));
  for (const [k, m] of [84, 88, 91, 96].entries()) mix.add(end + k * 0.07, 1.8, 0.14, 0.35 + 0.1 * k, bell(midi(m), 3));
}
