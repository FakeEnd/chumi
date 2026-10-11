import { openSync, writeSync, closeSync } from 'node:fs';

/** Streams 16 kHz mono PCM to a WAV file, patching the header sizes on close. Used only when "save raw audio" is on. */
export class WavWriter {
  private fd: number;
  private bytes = 0;
  constructor(path: string) {
    this.fd = openSync(path, 'w');
    writeSync(this.fd, Buffer.alloc(44));
  }
  write(samples: Int16Array): void {
    const b = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    writeSync(this.fd, b);
    this.bytes += b.length;
  }
  close(): void {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + this.bytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
    h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(this.bytes, 40);
    writeSync(this.fd, h, 0, 44, 0);
    closeSync(this.fd);
  }
}
