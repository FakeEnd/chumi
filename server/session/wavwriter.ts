import { openSync, writeSync, closeSync, fsyncSync, ftruncateSync } from 'node:fs';

/** The 44-byte header of a 16 kHz mono 16-bit PCM WAV holding `bytes` of samples. */
export function wavHeader(bytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}

/** Streams 16 kHz mono PCM to a retained recording or an opt-in temporary speaker-analysis file. */
export class WavWriter {
  private fd: number;
  private bytes = 0;
  private closed = false;
  constructor(path: string) {
    this.fd = openSync(path, 'wx', 0o600);
    try { if (writeSync(this.fd, wavHeader(0)) !== 44) throw new Error('Incomplete audio header write.'); }
    catch (error) { closeSync(this.fd); this.closed = true; throw error; }
  }
  write(samples: Int16Array): void {
    if (this.closed) throw new Error('Audio writer is closed.');
    const b = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    try {
      if (writeSync(this.fd, b, 0, b.length, 44 + this.bytes) !== b.length) throw new Error('Incomplete audio write.');
      this.bytes += b.length;
    } catch (error) {
      // The recorder only commits a span after this returns; discard a partially written block.
      try { ftruncateSync(this.fd, 44 + this.bytes); } catch { /* Recovery clamps to the readable data. */ }
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (writeSync(this.fd, wavHeader(this.bytes), 0, 44, 0) !== 44) throw new Error('Incomplete audio header write.');
      fsyncSync(this.fd);
    }
    finally { closeSync(this.fd); }
  }
}
