import { readFileSync } from 'node:fs';

export const SAMPLE_RATE = 16000;

/** Encode mono 16 kHz Int16 PCM as a WAV file. */
export function encodeWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(samples.buffer, samples.byteOffset, dataBytes).copy(buf, 44);
  return buf;
}

/** Read a 16-bit PCM WAV (any channel count / rate is converted to mono 16 kHz with simple resampling). */
export function readWav(path: string): Int16Array {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let off = 12, channels = 1, rate = SAMPLE_RATE, bits = 16, fmtTag = 1;
  let data: Buffer | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmtTag = b.readUInt16LE(off + 8); channels = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22);
    } else if (id === 'data') {
      data = b.subarray(off + 8, Math.min(b.length, off + 8 + size));
    }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error('WAV has no data chunk');
  if (fmtTag !== 1 || bits !== 16) throw new Error('Only 16-bit PCM WAV is supported');
  const frames = Math.floor(data.length / (2 * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += data.readInt16LE((i * channels + c) * 2);
    mono[i] = s / channels;
  }
  if (rate === SAMPLE_RATE) return Int16Array.from(mono, (v) => Math.round(v));
  const outLen = Math.floor(frames * SAMPLE_RATE / rate);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * rate / SAMPLE_RATE; const i0 = Math.floor(x); const f = x - i0;
    const a = mono[i0] ?? 0, c = mono[Math.min(frames - 1, i0 + 1)] ?? 0;
    out[i] = Math.round(a + (c - a) * f);
  }
  return out;
}

export function rmsDb(samples: Int16Array, start = 0, end = samples.length): number {
  let sum = 0;
  const n = Math.max(1, end - start);
  for (let i = start; i < end; i++) { const v = samples[i] / 32768; sum += v * v; }
  return 10 * Math.log10(sum / n + 1e-12);
}
