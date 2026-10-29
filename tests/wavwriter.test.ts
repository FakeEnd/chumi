import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WavWriter } from '../server/session/wavwriter.ts';

test('a short PCM write fails and leaves a playable recording at the last complete block', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chumi-short-write-'));
  const path = join(dir, 'audio.wav');
  const writer = new WavWriter(path);
  writer.write(new Int16Array(100).fill(321));
  const write = fs.writeSync;
  let short = true;
  t.mock.method(fs, 'writeSync', (fd: number, buffer: Buffer, offset = 0, length = buffer.length, position: number | null = null) => {
    if (short) { short = false; return write(fd, buffer, offset, 3, position); }
    return write(fd, buffer, offset, length, position);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => writer.write(new Int16Array(100)), /Incomplete audio write/);
  writer.close();
  const wav = fs.readFileSync(path);
  assert.equal(wav.length, 44 + 200);
  assert.equal(wav.readUInt32LE(40), 200);
  assert.equal(wav.readInt16LE(44), 321);
});
