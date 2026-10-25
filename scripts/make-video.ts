/**
 * Renders the promo video from docs/video/promo.html.
 *
 *   node scripts/make-video.ts               # English → docs/assets/chumi-promo.mp4
 *   node scripts/make-video.ts --lang zh     # Chinese version (Chinese UI screenshots) → docs/assets/chumi-promo-zh.mp4
 *   node scripts/make-video.ts --speed 1.5   # a faster cut → docs/assets/chumi-promo-1.5x.mp4 (also --speed 2)
 *   node scripts/make-video.ts --preview     # a few still frames into the temp folder, for checking layout
 *   node scripts/make-video.ts --preview --at 12.5,30   # stills at those times
 *
 * Frames are rendered deterministically (render(t) per frame) with headless Chrome over the DevTools
 * protocol, the music is synthesised by scripts/soundtrack.ts (no third-party audio), and ffmpeg encodes H.264 + AAC.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lively, Mix, type LivelyPlan } from './soundtrack.ts';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const LANG = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'en';
const PREVIEW = args.includes('--preview');
const POSTER_ONLY = args.includes('--poster-only');
// Plays the same timeline faster: frames sample it at t × SPEED, and the music is synthesised for the shorter length.
const SPEED = args.includes('--speed') ? Number(args[args.indexOf('--speed') + 1]) : 1;
if (!(SPEED >= 0.5 && SPEED <= 4)) throw new Error('--speed must be between 0.5 and 4');
const FPS = 30, W = 1920, H = 1080;
const NAME = (LANG === 'zh' ? 'chumi-promo-zh' : 'chumi-promo') + (SPEED === 1 ? '' : `-${SPEED}x`);
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
  const clips = await evaluate(`Object.keys(window.CLIPS ?? {}).length`) as number;
  if (clips < 3) throw new Error(`Live footage is missing (dist/footage/${LANG}/). Record it first: node scripts/record-footage.ts --lang ${LANG}`);
}

async function frame(t: number, file: string): Promise<void> {
  // render(t) may return a promise: footage frames are swapped in and decoded before the screenshot.
  await evaluate(`Promise.resolve(render(${t.toFixed(4)})).then(() => true)`);
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
}

// ------------------------------------------------------------------ music (synthesised: scripts/soundtrack.ts)
function music(duration: number, clicks: number[], plan: LivelyPlan, file: string): void {
  const mix = new Mix(duration);
  lively(mix, plan);
  // A soft tick for each click on screen.
  for (const c of clicks) mix.add(c, 0.05, 0.12, 0.5, (t) => Math.sin(2 * Math.PI * 1900 * t) * Math.exp(-t * 120));
  mix.write(file, { fadeIn: 0.3, fadeOut: 2.2, drive: 1.2, level: 0.8 });
}

// ------------------------------------------------------------------ main
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(TMP, 'chrome')}`, '--hide-scrollbars', '--force-color-profile=srgb', '--allow-file-access-from-files', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
try {
  await openPage();
  const duration = await evaluate('window.DURATION') as number;
  const clicks = await evaluate('window.CLICKS') as number[];
  const plan = await evaluate('window.MUSIC') as LivelyPlan;
  const posterT = await evaluate('window.POSTER_T') as number;
  // --at 12.5,30 previews those times instead of the page's own picks.
  const previewT = args.includes('--at') ? args[args.indexOf('--at') + 1].split(',').map(Number) : await evaluate('window.PREVIEW_T') as number[];
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
    const total = Math.round(duration / SPEED * FPS);
    const started = Date.now();
    for (let i = 0; i < total; i++) {
      await frame(i / FPS * SPEED, join(frames, `f${String(i).padStart(5, '0')}.jpg`));
      if (i % 300 === 0) console.log(`frame ${i}/${total} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    const at = (x: number) => x / SPEED;
    music(duration / SPEED, clicks.map(at), { build: at(plan.build), groove: at(plan.groove), hook: plan.hook.map(([a, b]) => [at(a), at(b)] as [number, number]), end: at(plan.end) }, join(TMP, 'music.wav'));
    mkdirSync(join(ROOT, 'dist/video'), { recursive: true });
    const enc = (out: string, extra: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, 'f%05d.jpg'), '-i', join(TMP, 'music.wav'),
      ...extra, '-pix_fmt', 'yuv420p', '-preset', 'slow', '-tune', 'animation', '-movflags', '+faststart', '-c:a', 'aac', '-shortest', out], { stdio: 'inherit' });
    enc(MASTER, ['-c:v', 'libx264', '-crf', '19', '-b:a', '192k']);
    enc(WEB, ['-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-crf', '24', '-b:a', '128k']);
    if (SPEED === 1) await poster();  // faster cuts share the full-length poster
    console.log(`wrote ${MASTER}\nwrote ${WEB}`);
  }
} finally {
  chrome.kill('SIGTERM');
  await Promise.race([new Promise((r) => chrome.once('exit', r)), sleep(3000)]);
  if (!PREVIEW && !process.env.KEEP_TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
