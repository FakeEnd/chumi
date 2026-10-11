/**
 * Renders the promo video from docs/video/promo.html.
 *
 *   node scripts/make-video.ts               # English → docs/assets/chumi-promo.mp4
 *   node scripts/make-video.ts --lang zh     # Chinese version (Chinese UI screenshots) → docs/assets/chumi-promo-zh.mp4
 *   node scripts/make-video.ts --preview     # a few still frames into the temp folder, for checking layout
 *
 * Frames are rendered deterministically (render(t) per frame) with headless Chrome over the DevTools
 * protocol, the music bed is synthesised here (no third-party audio), and ffmpeg encodes H.264 + AAC.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const LANG = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'en';
const PREVIEW = args.includes('--preview');
const POSTER_ONLY = args.includes('--poster-only');
const FPS = 30, W = 1920, H = 1080;
const NAME = LANG === 'zh' ? 'chumi-promo-zh' : 'chumi-promo';
const MASTER = join(ROOT, 'dist/video', `${NAME}-1080p.mp4`);   // full quality, for sharing (git-ignored)
const WEB = join(ROOT, 'docs/assets', `${NAME}.mp4`);             // 720p, small enough for the repository
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(existsSync)!;
const CDP_PORT = 9450 + Math.floor(Math.random() * 40);
const TMP = mkdtempSync(join(tmpdir(), 'chumi-video-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ CDP
let ws: WebSocket; let msgId = 0; const waiting = new Map<number, (v: any) => void>();
const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((r) => { const id = ++msgId; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

async function openPage(): Promise<void> {
  let target: any;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = ((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as any[]).find((t) => t.type === 'page'); } catch { /* not up */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('Chrome did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); } });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `file://${join(ROOT, 'docs/video/promo.html')}?lang=${LANG}` });
  for (let i = 0; i < 80; i++) { if (await evaluate(`document.readyState === 'complete' && [...document.images].every((i) => i.complete && i.naturalWidth > 0) && typeof render === 'function'`)) break; await sleep(150); }
  await evaluate(`Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => document.fonts.ready).then(() => true)`);
}

async function frame(t: number, file: string): Promise<void> {
  await evaluate(`render(${t.toFixed(4)}); true`);
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
}

// ------------------------------------------------------------------ music bed (synthesised)
function music(duration: number, clicks: number[], appWindow: [number, number], file: string): void {
  const SR = 44100, n = Math.ceil(duration * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  const midi = (m: number) => 440 * 2 ** ((m - 69) / 12);
  const chords = [[48, 55, 64, 71, 74], [45, 52, 60, 67, 71], [41, 48, 57, 64, 67], [43, 50, 59, 62, 69]]; // Cmaj9 Am9 Fmaj9 G6/9
  const bar = 60 / 88 * 4, chordLen = bar * 2;
  for (let c = 0; c * chordLen < duration; c++) {
    const notes = chords[c % chords.length], t0 = c * chordLen, t1 = t0 + chordLen + 1.2;
    for (let i = Math.floor(t0 * SR); i < Math.min(n, t1 * SR); i++) {
      const t = i / SR - t0;
      const env = Math.min(1, t / 1.1) * Math.min(1, (t1 - t0 - t) / 1.2);
      let s = 0;
      notes.forEach((m, k) => {
        const f = midi(m + 12 * (k === 0 ? 0 : 0));
        for (const d of [-0.0018, 0, 0.0021]) s += Math.sin(2 * Math.PI * f * (1 + d) * (i / SR)) * (k === 0 ? 0.55 : 0.32);
        s += 0.08 * Math.sin(4 * Math.PI * f * (i / SR));
      });
      const trem = 1 + 0.06 * Math.sin(2 * Math.PI * 0.18 * (i / SR));
      L[i] += s * env * trem * 0.045; R[i] += s * env * (2 - trem) * 0.045;
    }
  }
  // gentle plucked arpeggio while the app is on screen, with a small echo
  const eighth = 60 / 88 / 2;
  for (let k = 0; ; k++) {
    const t0 = appWindow[0] + k * eighth; if (t0 > appWindow[1] - 0.2) break;
    const chord = chords[Math.floor(t0 / chordLen) % chords.length];
    const m = chord[1 + (k % 4)] + 12, f = midi(m), pan = k % 2 ? 0.65 : 0.35;
    for (let echo = 0; echo < 3; echo++) {
      const start = Math.floor((t0 + echo * 0.34) * SR), gain = 0.05 * 0.38 ** echo;
      for (let j = 0; j < SR * 0.9 && start + j < n; j++) {
        const t = j / SR, e = Math.exp(-t * 5.5) * Math.min(1, t * 400);
        const v = (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t)) * e * gain;
        L[start + j] += v * (1 - pan) * 2 * (echo % 2 ? 0.8 : 1); R[start + j] += v * pan * 2;
      }
    }
  }
  for (const c of clicks) {
    const start = Math.floor(c * SR);
    for (let j = 0; j < SR * 0.05 && start + j < n; j++) { const t = j / SR; const v = Math.sin(2 * Math.PI * 1900 * t) * Math.exp(-t * 120) * 0.12; L[start + j] += v; R[start + j] += v; }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, g = Math.min(1, t / 1.4) * Math.min(1, (duration - t) / 2.6);
    L[i] *= g; R[i] *= g; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const scale = 0.62 / (peak || 1), buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * scale)) * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * scale)) * 32767), 46 + i * 4); }
  writeFileSync(file, buf);
}

// ------------------------------------------------------------------ main
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(TMP, 'chrome')}`, '--hide-scrollbars', '--force-color-profile=srgb', '--allow-file-access-from-files', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
try {
  await openPage();
  const duration = await evaluate('window.DURATION') as number;
  const clicks = await evaluate('window.CLICKS') as number[];
  const appWindow = await evaluate('window.APP_WINDOW') as [number, number];
  const posterT = await evaluate('window.POSTER_T') as number;
  const previewT = await evaluate('window.PREVIEW_T') as number[];
  const poster = async () => {
    // Poster: the catch-up scene with a play button, so the README shows the app rather than the logo.
    await evaluate(`document.getElementById('play').style.display = 'grid'; true`);
    const png = join(TMP, 'poster.jpg');
    await frame(posterT, png);
    await evaluate(`document.getElementById('play').style.display = 'none'; true`);
    execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '1280', png, '--out', WEB.replace(/\.mp4$/, '-poster.jpg')], { stdio: 'ignore' });
  };
  if (POSTER_ONLY) {
    await poster();
    console.log(`wrote ${WEB.replace(/\.mp4$/, '-poster.jpg')}`);
  } else if (PREVIEW) {
    const dir = join(TMP, 'preview'); mkdirSync(dir, { recursive: true });
    for (const t of previewT) await frame(t, join(dir, `t${String(t).replace('.', '_')}.jpg`));
    console.log(dir);
  } else {
    const frames = join(TMP, 'frames'); mkdirSync(frames, { recursive: true });
    const total = Math.round(duration * FPS);
    const started = Date.now();
    for (let i = 0; i < total; i++) {
      await frame(i / FPS, join(frames, `f${String(i).padStart(5, '0')}.jpg`));
      if (i % 300 === 0) console.log(`frame ${i}/${total} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    music(duration, clicks, appWindow, join(TMP, 'music.wav'));
    mkdirSync(join(ROOT, 'dist/video'), { recursive: true });
    const enc = (out: string, extra: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, 'f%05d.jpg'), '-i', join(TMP, 'music.wav'),
      ...extra, '-pix_fmt', 'yuv420p', '-preset', 'slow', '-tune', 'animation', '-movflags', '+faststart', '-c:a', 'aac', '-shortest', out], { stdio: 'inherit' });
    enc(MASTER, ['-c:v', 'libx264', '-crf', '19', '-b:a', '192k']);
    enc(WEB, ['-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-crf', '24', '-b:a', '128k']);
    await poster();
    console.log(`wrote ${MASTER}\nwrote ${WEB}`);
  }
} finally {
  chrome.kill('SIGTERM');
  await Promise.race([new Promise((r) => chrome.once('exit', r)), sleep(3000)]);
  if (!PREVIEW && !process.env.KEEP_TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
