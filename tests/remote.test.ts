import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { RemoteAccess, requestToken } from '../server/remote/access.ts';
import { PhoneCapture } from '../server/audio/phone.ts';

const DIR = mkdtempSync(join(tmpdir(), 'chumi-remote-'));
test.after(() => rmSync(DIR, { recursive: true, force: true }));

/** One "CHA1" frame as the native helper and the phone app write it. */
export function frame(ts: number, samples: Int16Array): Buffer {
  const b = Buffer.alloc(20 + samples.length * 2);
  b.write('CHA1', 0, 'ascii'); b.writeUInt8(1, 4); b.writeDoubleLE(ts, 8); b.writeUInt32LE(samples.length, 16);
  samples.forEach((v, i) => b.writeInt16LE(v, 20 + i * 2));
  return b;
}
const chunk = (n = 800) => new Int16Array(n).fill(1000); // 50 ms at 16 kHz

test('pairing: a code works once, wrong guesses use it up, and only token hashes are stored', () => {
  const file = join(DIR, 'devices.json');
  const access = new RemoteAccess(file);
  assert.throws(() => access.pair('123456', 'Pixel'), /No pairing code/);
  const { code } = access.newCode();
  assert.match(code, /^\d{6}$/);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.throws(() => access.pair(wrong, 'Pixel'), /Wrong pairing code/);
  const { token, device } = access.pair(code, 'Pixel 9');
  assert.equal(device.name, 'Pixel 9');
  assert.throws(() => access.pair(code, 'again'), /No pairing code/, 'a code works once');
  assert.equal(access.authenticate(token)?.id, device.id);
  assert.equal(access.authenticate(`${token}x`), null);
  assert.equal(access.authenticate(null), null);
  assert.ok(!readFileSync(file, 'utf8').includes(token), 'the token itself is never written');
  assert.equal(new RemoteAccess(file).authenticate(token)?.id, device.id, 'pairing survives a restart');

  access.newCode();
  for (let i = 0; i < 5; i++) assert.throws(() => access.pair('x', 'guess'));
  assert.throws(() => access.pair(code, 'late'), /No pairing code/, 'five wrong guesses end the code');

  assert.equal(access.revoke(device.id), true);
  assert.equal(access.authenticate(token), null);
});

test('the device token comes from the Authorization header or the web view cookie', () => {
  assert.equal(requestToken({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(requestToken({ cookie: 'x=1; chumi_device=def; y=2' }), 'def');
  assert.equal(requestToken({ cookie: 'x=1' }), null);
  assert.equal(requestToken({}), null);
});

test('phone audio: frames keep their timing across a reconnect, resent frames are dropped, a new capture follows on', async () => {
  const input = new PhoneCapture();
  const got: Array<[string, number, number]> = [];
  input.on('frames', (src, ts, s) => got.push([src, Math.round(ts * 1000), s.length]));
  await input.start();

  const first = new PassThrough();
  const done1 = input.attach(first as unknown as IncomingMessage, 'cap1');
  assert.equal(input.connected, true);
  first.write(Buffer.concat([frame(0, chunk()), frame(0.05, chunk())]));
  first.end();
  await done1;
  assert.equal(input.connected, false);

  // The phone reconnects and resends from 0.05 s: only the new frame counts.
  const second = new PassThrough();
  const done2 = input.attach(second as unknown as IncomingMessage, 'cap1');
  second.end(Buffer.concat([frame(0.05, chunk()), frame(0.1, chunk())]));
  await done2;
  assert.deepEqual(got.map((g) => g[1] - got[0][1]), [0, 50, 100]);
  assert.ok(got.every((g) => g[0] === 'mic'));

  // A new capture on the phone (its clock restarts) is placed after what was received.
  const third = new PassThrough();
  const done3 = input.attach(third as unknown as IncomingMessage, 'cap2');
  third.end(frame(0, chunk()));
  await done3;
  assert.ok(got[3][1] >= got[2][1] + 50);

  await input.stop();
  await assert.rejects(input.attach(new PassThrough() as unknown as IncomingMessage, 'cap3'), /not recording/);
});
