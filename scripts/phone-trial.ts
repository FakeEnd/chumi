/**
 * Virtual trial of phone access: a stand-in phone pairs with Chumi and records the sample lab meeting through
 * the phone's audio upload, the way the Android app (android/) does.
 *
 *   node scripts/phone-trial.ts            # 8× speed, offline test provider
 *
 * Starts its own server on spare ports with a throwaway data folder and checks:
 * - Phone access is off by default and answers only paired devices.
 * - Pairing works, and credentials and developer routes stay closed to phones.
 * - A session started from the phone transcribes the uploaded audio.
 * - A dropped upload that reconnects and resends audio adds no duplicate lines.
 * - The phone can open the web interface with its cookie, and can end the session.
 * Needs whisper-server and a speech model, like scripts/acceptance.ts.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readWav } from '../server/audio/wav.ts';

const ROOT = resolve(import.meta.dirname, '..');
const SPEED = 8;
const PORT = 4930 + Math.floor(Math.random() * 30);
const PHONE_PORT = PORT + 40;
const LOCAL = `http://127.0.0.1:${PORT}`;
const PHONE = `http://127.0.0.1:${PHONE_PORT}`;
const DATA = mkdtempSync(join(tmpdir(), 'chumi-phone-trial-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok: boolean, what: string, detail = '') => { if (!ok) failed = true; console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `: ${detail}` : ''}`); };

async function call(base: string, path: string, o: { body?: unknown; method?: string; token?: string; cookie?: string } = {}): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-chumi': '1' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = o.cookie;
  const r = await fetch(base + path, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}

/** One "CHA1" frame: magic, source 1 (mic), flags, reserved, f64 timestamp, u32 count, int16 samples. */
function frame(ts: number, samples: Int16Array): Buffer {
  const b = Buffer.alloc(20 + samples.length * 2);
  b.write('CHA1', 0, 'ascii'); b.writeUInt8(1, 4); b.writeDoubleLE(ts, 8); b.writeUInt32LE(samples.length, 16);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(b, 20);
  return b;
}

/**
 * Uploads samples [from, to) as 50 ms frames, paced at SPEED× real time. With dropAt, the connection breaks there
 * in the middle of a frame, as when a phone loses its network.
 */
async function upload(token: string, capture: string, samples: Int16Array, from: number, to: number, dropAt?: number): Promise<void> {
  let pos = from;
  const started = Date.now();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (dropAt !== undefined && pos >= dropAt) {
        ctrl.enqueue(frame(pos / 16000, samples.subarray(pos, pos + 800)).subarray(0, 900));
        ctrl.error(new Error('network lost'));
        return;
      }
      if (pos >= to) { ctrl.close(); return; }
      const due = started + ((pos - from) / 16000 / SPEED) * 1000;
      if (due > Date.now()) await sleep(due - Date.now());
      const end = Math.min(pos + 800, to);
      ctrl.enqueue(frame(pos / 16000, samples.subarray(pos, end)));
      pos = end;
    },
  });
  try {
    const r = await fetch(`${PHONE}/api/remote/audio?capture=${capture}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-chumi': '1', 'content-type': 'application/octet-stream' }, body, duplex: 'half' } as RequestInit);
    await r.text();
  } catch (e) {
    if (dropAt === undefined) throw e;
  }
}

const server = spawn(process.execPath, [join(ROOT, 'server/main.ts')], { env: { ...process.env, CHUMI_DEV: '1', CHUMI_NO_HOTKEY: '1', CHUMI_DATA_DIR: DATA, PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'pipe'] });
server.stdout!.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
server.stderr!.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
try {
  for (let i = 0; ; i++) {
    if (i > 240) throw new Error('The server or speech engine did not start.');
    await sleep(500);
    const s = await call(LOCAL, '/api/state').catch(() => null);
    if (s?.json?.live?.asr?.state === 'ready') break;
  }
  await call(LOCAL, '/api/settings', { method: 'PUT', body: { ai: { provider: 'mock' } } });

  const off = await fetch(`${PHONE}/api/remote/whoami`).catch(() => null);
  check(!off, 'Phone access is off by default', off ? `port answered ${off.status}` : 'nothing listens');
  await call(LOCAL, '/api/settings', { method: 'PUT', body: { remote: { enabled: true, port: PHONE_PORT } } });
  await sleep(300);
  const status = await call(LOCAL, '/api/remote');
  check(status.json.listening && status.json.urls.length > 0, 'Turning it on listens on the network', status.json.urls.join(' '));

  check((await call(PHONE, '/api/remote/whoami')).status === 401, 'Unpaired requests are refused');
  check((await call(PHONE, '/api/state')).status === 401, 'Unpaired requests cannot read meetings');
  const { json: pairing } = await call(LOCAL, '/api/remote/pairing', { body: {} });
  check((await call(PHONE, '/api/remote/pair', { body: { code: 'nope', name: 'x' } })).status === 403, 'A wrong pairing code is refused');
  const paired = await call(PHONE, '/api/remote/pair', { body: { code: pairing.code, name: 'Stand-in phone' } });
  const token: string = paired.json?.token;
  check(!!token, 'Pairing with the code gives the phone a token');
  check((await call(PHONE, '/api/remote/pairing', { body: {}, token })).status === 403, 'A phone cannot create pairing codes');
  check((await call(PHONE, '/api/provider/compatible/key?preset=ollama&baseUrl=x', { token })).status === 403, 'A phone cannot read API keys');
  check((await call(PHONE, '/api/dev/stats', { token })).status === 403, 'Developer routes are closed to phones');
  const page = await call(PHONE, '/', { cookie: `chumi_device=${token}` });
  check(page.status === 200 && page.text.includes('<div id="root">'), 'The web interface opens with the app\'s cookie');

  const started = await call(PHONE, '/api/session/start', { body: { title: 'Phone trial', type: 'lab_meeting', source: 'phone' }, token });
  check(started.status === 200, 'The phone starts a session', started.json?.session?.id ?? started.json?.error);
  const sessionId: string = started.json.session.id;

  const samples = readWav(join(ROOT, 'samples/lab-meeting/lab-meeting.wav'));
  const part1 = 16000 * 75, overlap = 16000 * 5, part2 = 16000 * 150;
  // The first upload breaks off after 75 s of audio, in the middle of a frame.
  await upload(token, 'trial', samples, 0, part2, part1);
  await sleep(300);
  const mid = await call(PHONE, '/api/remote/whoami', { token });
  check(mid.json.status === 'recording' && !mid.json.phoneConnected, 'After the upload drops, the session keeps recording and waits');
  // The phone reconnects and resends the last 5 s it is not sure about.
  await upload(token, 'trial', samples, part1 - overlap, part2);
  let segs: Array<{ t_start: number; text: string }> = [];
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    segs = (await call(LOCAL, `/api/sessions/${sessionId}`)).json.segments ?? [];
    if (segs.length && segs[segs.length - 1].t_start > 135_000) break;
  }
  const text = segs.map((s) => s.text).join(' ');
  check(segs.length >= 10, 'The uploaded audio is transcribed', `${segs.length} lines, last at ${Math.round((segs.at(-1)?.t_start ?? 0) / 1000)} s`);
  check(/cluster|GPU|presenting/i.test(text), 'The transcript matches the sample', text.slice(0, 80));
  const texts = segs.map((s) => s.text.trim()).filter((t) => t.length > 20);
  check(new Set(texts).size === texts.length, 'Resent audio adds no duplicate lines');
  const ordered = segs.every((s, i) => i === 0 || s.t_start >= segs[i - 1].t_start);
  check(ordered && (segs.at(-1)?.t_start ?? 0) < 160_000, 'Line times follow the recording', `last line at ${Math.round((segs.at(-1)?.t_start ?? 0) / 1000)} s of 150 s`);

  const ended = await call(PHONE, '/api/session/end', { body: {}, token });
  check(ended.status === 200, 'The phone ends the session');
  check((await call(PHONE, '/api/remote/audio?capture=late', { body: {}, token })).status === 409, 'Uploads after the end are refused');
  const devices = (await call(LOCAL, '/api/remote')).json.devices;
  await call(LOCAL, `/api/remote/devices/${devices[0].id}`, { method: 'DELETE' });
  check((await call(PHONE, '/api/remote/whoami', { token })).status === 401, 'A removed phone is refused');
} catch (e) {
  check(false, 'Trial', (e as Error).message);
} finally {
  server.kill('SIGTERM');
  await sleep(1500);
  rmSync(DATA, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
