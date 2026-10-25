/**
 * Renders the desktop-pet promo from docs/video/pet/promo.html: live footage of the real pet (record it first with
 * scripts/record-footage.ts, into dist/footage/), with the app's own character drawn for the intro and outro.
 *
 *   node scripts/make-pet-video.ts              # 中文 → docs/assets/chumi-pet-zh.mp4
 *   node scripts/make-pet-video.ts --lang en    # English → docs/assets/chumi-pet.mp4
 *   node scripts/make-pet-video.ts --preview    # a few still frames into the temp folder, for checking layout
 *   node scripts/make-pet-video.ts --preview --at 12.5,30   # stills at those times
 *
 * Vite serves the page so it can import the TypeScript pet, headless Chrome renders each frame with render(t) over the
 * DevTools protocol, the soundtrack (music from scripts/soundtrack.ts, and sound effects) is synthesised, and ffmpeg encodes
 * H.264 + AAC.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { bell, bouncy, midi, Mix, SR, type BouncyPlan } from './soundtrack.ts';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const LANG = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'zh';
const PREVIEW = args.includes('--preview');
const FPS = 30, W = 1920, H = 1080;
const NAME = LANG === 'en' ? 'chumi-pet' : 'chumi-pet-zh';
const MASTER = join(ROOT, 'dist/video', `${NAME}-1080p.mp4`);   // full quality, for sharing (git-ignored)
const WEB = join(ROOT, 'docs/assets', `${NAME}.mp4`);             // 720p, small enough for the repository
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(existsSync)!;
const CDP_PORT = 9490 + Math.floor(Math.random() * 40);
const TMP = mkdtempSync(join(tmpdir(), 'chumi-pet-video-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ CDP
let ws: WebSocket; let msgId = 0; const waiting = new Map<number, (v: any) => void>();
const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((r, reject) => {
  const id = ++msgId;
  const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Chrome did not answer ${method}`)); }, 60_000);
  waiting.set(id, (v) => { clearTimeout(timer); r(v); });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression: string) => {
  const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result;
  if (r?.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r?.result?.value;
};

async function openPage(url: string): Promise<void> {
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
  await send('Page.navigate', { url });
  for (let i = 0; i < 120; i++) { if (await evaluate(`document.readyState === 'complete' && typeof render === 'function' && [...document.images].every((i) => i.complete && i.naturalWidth > 0)`)) break; await sleep(150); }
  await evaluate(`Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => document.fonts.ready).then(() => true)`);
  const clips = await evaluate(`Object.keys(window.CLIPS ?? {}).length`) as number;
  if (clips < 3) throw new Error(`Live footage is missing (dist/footage/${LANG}/). Record it first: node scripts/record-footage.ts --lang ${LANG}`);
}

async function frame(t: number, file: string): Promise<void> {
  // render(t) returns a promise: the footage frame is swapped in and decoded before the screenshot.
  await evaluate(`Promise.resolve(render(${t.toFixed(4)})).then(() => true)`);
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
}

// ------------------------------------------------------------------ soundtrack (synthesised)
// The bouncy music-box loop (scripts/soundtrack.ts) under the whole video, plus a sound for each thing Chumi does on
// screen (boing, pop, sparkle…). Everything is deterministic.
function soundtrack(duration: number, plan: BouncyPlan, sfx: Array<[number, string]>, file: string): void {
  const mix = new Mix(duration);
  bouncy(mix, plan);
  const TAU = Math.PI * 2, add = mix.add.bind(mix), filtered = mix.filtered.bind(mix);
  const notes = (at: number, ms: number[], gap: number, gain: number, decay: number) => ms.forEach((m, i) => add(at + i * gap, 0.9, gain, 0.3 + (0.4 * i) / Math.max(1, ms.length - 1), bell(midi(m), decay)));
  const FX: Record<string, (at: number) => void> = {
    pop: (at) => add(at, 0.14, 0.42, 0.55, (t) => Math.sin(TAU * (420 * t + 900 * (t - (1 - Math.exp(-t * 50)) / 50))) * Math.exp(-t * 26)),
    tick: (at) => add(at, 0.1, 0.22, 0.5, (t) => (Math.sin(TAU * 1320 * t) + 0.3 * Math.sin(TAU * 2640 * t)) * Math.exp(-t * 48)),
    click: (at) => { const hp = filtered(() => 0.6, true); add(at, 0.04, 0.4, 0.55, (t) => (0.6 * Math.sin(TAU * 3100 * t) + hp(t)) * Math.exp(-t * 220)); },
    menu: (at) => { const lp = filtered(() => 0.12); add(at, 0.12, 0.25, 0.6, (t) => lp(t) * Math.exp(-t * 35)); },
    boing: (at) => {
      let ph = 0;
      add(at, 0.55, 0.42, 0.5, (t) => { ph += TAU * (170 + 250 * (1 - Math.exp(-t * 11)) + 45 * Math.sin(TAU * 15 * t) * Math.exp(-t * 5)) / SR; return Math.sin(ph) * Math.exp(-t * 5.5) * Math.min(1, t * 120); });
      let k = 0; add(at, 0.16, 0.35, 0.5, (t) => { k += TAU * (60 + 80 * Math.exp(-t * 40)) / SR; return Math.sin(k) * Math.exp(-t * 22); });
    },
    grab: (at) => { let ph = 0; add(at, 0.42, 0.26, 0.5, (t) => { ph += TAU * (380 + 650 * (t / 0.42) ** 1.4 + 30 * Math.sin(TAU * 20 * t)) / SR; return Math.sin(ph) * Math.sin(Math.PI * t / 0.42); }); },
    whoosh: (at) => { const lp = filtered((t) => 0.02 + 0.25 * Math.sin(Math.PI * Math.min(1, t / 0.5))); add(at, 0.5, 0.55, 0.5, (t) => lp(t) * Math.sin(Math.PI * t / 0.5) ** 2); },
    sparkle: (at) => notes(at, [84, 88, 91, 96, 100, 103], 0.045, 0.1, 7),
    bling: (at) => notes(at, [88, 95], 0.09, 0.17, 5),
    hearts: (at) => notes(at, [91, 96, 100], 0.12, 0.1, 6),
    think: (at) => [0, 4, 7, 4, 9, 7, 12, 7].forEach((d, i) => { const f = midi(84 + d); add(at + i * 0.17, 0.16, 0.08, i % 2 ? 0.65 : 0.35, (t) => Math.sin(TAU * f * (1 + 0.6 * t) * t) * Math.exp(-t * 20)); }),
    // A pencil: band-limited noise (high-passed, then softened) in short strokes.
    scribble: (at) => { const hp = filtered(() => 0.35, true); let lp = 0; add(at, 0.9, 0.05, 0.6, (t) => { lp += (hp(t) - lp) * 0.45; return lp * Math.abs(Math.sin(TAU * 6 * t)) ** 2 * Math.min(1, t * 10) * Math.min(1, (0.9 - t) * 6); }); },
    confetti: (at) => { const lp = filtered(() => 0.4); add(at, 0.25, 0.45, 0.5, (t) => lp(t) * 1.5 * Math.exp(-t * 26)); FX.sparkle(at + 0.08); FX.sparkle(at + 0.36); notes(at + 0.6, [96, 91, 100], 0.1, 0.08, 6); },
    lullaby: (at) => notes(at, [79, 76, 72, 67], 0.36, 0.13, 2.2),
  };
  for (const [at, kind] of sfx) FX[kind]?.(at);
  mix.write(file);
}

// ------------------------------------------------------------------ main
const vite = await createServer({
  root: ROOT, configFile: false, logLevel: 'error', appType: 'mpa',
  // No file watching or hot reload: an edit during a render must not reload the page between frames.
  server: { host: '127.0.0.1', port: 5230 + Math.floor(Math.random() * 60), hmr: false, watch: null, fs: { allow: [ROOT, '/System/Library/Fonts'] } },
});
await vite.listen();
const base = vite.resolvedUrls!.local[0];
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(TMP, 'chrome')}`, '--hide-scrollbars', '--force-color-profile=srgb', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
try {
  await openPage(`${base}docs/video/pet/promo.html?lang=${LANG}`);
  const duration = await evaluate('window.DURATION') as number;
  const sfx = await evaluate('window.SFX') as Array<[number, string]>;
  const plan = await evaluate('window.MUSIC') as BouncyPlan;
  const posterT = await evaluate('window.POSTER_T') as number;
  // --at 12.5,30 previews those times instead of the page's own picks.
  const previewT = args.includes('--at') ? args[args.indexOf('--at') + 1].split(',').map(Number) : await evaluate('window.PREVIEW_T') as number[];
  if (PREVIEW) {
    const dir = join(TMP, 'preview'); mkdirSync(dir, { recursive: true });
    for (const t of previewT) await frame(t, join(dir, `t${String(t).replace('.', '_')}.jpg`));
    soundtrack(duration, plan, sfx, join(dir, 'soundtrack.wav'));
    console.log(dir);
  } else {
    const frames = join(TMP, 'frames'); mkdirSync(frames, { recursive: true });
    const total = Math.round(duration * FPS), started = Date.now();
    for (let i = 0; i < total; i++) {
      await frame(i / FPS, join(frames, `f${String(i).padStart(5, '0')}.jpg`));
      if (i % 300 === 0) console.log(`frame ${i}/${total} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    // The poster: Chumi offering the catch-up on the desktop. Taken before encoding, while Chrome is still busy with us.
    const png = join(TMP, 'poster.jpg');
    await frame(posterT, png);
    execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '1280', png, '--out', WEB.replace(/\.mp4$/, '-poster.jpg')], { stdio: 'ignore' });
    soundtrack(duration, plan, sfx, join(TMP, 'soundtrack.wav'));
    mkdirSync(join(ROOT, 'dist/video'), { recursive: true });
    const enc = (out: string, extra: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, 'f%05d.jpg'), '-i', join(TMP, 'soundtrack.wav'),
      ...extra, '-pix_fmt', 'yuv420p', '-preset', 'slow', '-tune', 'animation', '-movflags', '+faststart', '-c:a', 'aac', '-shortest', out], { stdio: 'inherit' });
    enc(MASTER, ['-c:v', 'libx264', '-crf', '19', '-b:a', '192k']);
    enc(WEB, ['-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-crf', '24', '-b:a', '128k']);
    console.log(`wrote ${MASTER}\nwrote ${WEB}`);
  }
} finally {
  chrome.kill('SIGTERM');
  await Promise.race([new Promise((r) => chrome.once('exit', r)), sleep(3000)]);
  await vite.close();
  if (!PREVIEW && !process.env.KEEP_TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
