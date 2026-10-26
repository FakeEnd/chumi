/**
 * Records the live footage the promo videos are cut from: the real Chumi window and the real desktop pet, while a
 * sample meeting plays and the AI answers stream in.
 *
 *   node scripts/record-footage.ts                    # English → dist/footage/en/
 *   node scripts/record-footage.ts --lang zh          # 中文 → dist/footage/zh/
 *   node scripts/record-footage.ts --provider claude-cli
 *   node scripts/record-footage.ts --provider mock --speed 8    # a quick dry run of every step, without AI requests
 *   node scripts/record-footage.ts --only agent --project-folder DIR [--lang zh]
 *       # continuing a confirmed handoff: Chumi's window choosing Claude Code, Codex and Codex app, then the pet's
 *       # Continue. Nothing is opened (the server runs with CHUMI_NO_LAUNCH). The data folder is kept, with the
 *       # handoff's prompt, so a real agent can then continue it in DIR through Chumi's MCP server.
 *
 * Plays the same synthetic lab meeting as scripts/demo-shoot.ts through a throwaway server (empty data folder, real
 * local Whisper, the fictional demo profile) and drives two headless Chrome pages:
 *   - Chumi's window at 1360×860, captured at 2× in a screenshot loop: the transcript arriving, a real click on
 *     Catch me up and the answer streaming in, then an explanation streaming in.
 *   - The desktop pet page, zoomed 3× and captured by screencast with a transparent background: listening, being
 *     petted, catching up from its toolbar, a question typed into its ask box, and ending the meeting.
 * Each clip is a folder of frames plus clip.json (frame times, the pointer path and clicks, element boxes).
 * Uses about 6 AI requests (default provider: Codex, your ChatGPT plan).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_SHELL, buildWeb, DEMO, GLOSSARY } from './demo-common.ts';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const PROVIDER = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : 'codex';
const LANG: 'en' | 'zh' = args.includes('--lang') && args[args.indexOf('--lang') + 1] === 'zh' ? 'zh' : 'en';
const L = DEMO[LANG];
const OUT = join(ROOT, 'dist/footage', LANG);
const SAMPLE_DIR = join(ROOT, LANG === 'zh' ? 'samples/llm-meeting' : 'samples/llm-meeting-en');
const SAMPLE = join(SAMPLE_DIR, LANG === 'zh' ? 'llm-meeting.wav' : 'llm-meeting-en.wav');
const ASK = LANG === 'zh' ? 'Maya 的 74% 现在能放进论文吗？' : "Can Maya's 74% go in the paper yet?";
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(existsSync);
const PORT = 4910 + Math.floor(Math.random() * 30);
const CDP_PORT = 9410 + Math.floor(Math.random() * 30);
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), 'chumi-footage-'));
const W = 1360, H = 860;              // Chumi's window, CSS px (captured at 2×)
const PET_ZOOM = 3, PET_W = 380, PET_H = 760;  // the pet page, CSS px (captured at 3×)
// Played a little faster than real time, so lines keep arriving while Whisper keeps up.
const SPEED = args.includes('--speed') ? Number(args[args.indexOf('--speed') + 1]) : 2.5;
const AGENT = args.includes('--only') && args[args.indexOf('--only') + 1] === 'agent';
const PROJECT_FOLDER = args.includes('--project-folder') ? resolve(args[args.indexOf('--project-folder') + 1]) : null;
if (AGENT && !PROJECT_FOLDER) throw new Error('--only agent needs --project-folder DIR (the sample project the agents work in)');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function api(path: string, body?: unknown, method?: string): Promise<any> {
  const r = await fetch(B + path, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-chumi': '1' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${t}`);
  return t && r.headers.get('content-type')?.includes('json') ? JSON.parse(t) : t;
}
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v as T; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(300); }
}

// ------------------------------------------------------------------ CDP pages
type Ev = { t: number; type: 'move' | 'down' | 'up' | 'mark'; x?: number; y?: number; name?: string };
type Clip = { name: string; dir: string; frames: Array<{ t: number; f: string }>; start: number; stop?: () => Promise<void>; track: number[][] };

class Page {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, (v: any) => void>();
  private onFrame: ((data: string, session: number, meta?: { deviceWidth: number; deviceHeight: number }) => void) | null = null;
  /** A screencast frame that came out at the wrong size (reported when the clip stops). */
  frameError: Error | null = null;
  /** The pointer path and clicks of the clip being recorded, in captured px. */
  events: Ev[] = [];
  private pointer = { x: 0, y: 0 };
  /** 2: Chumi's window at device scale 2; PET_ZOOM: the pet page zoomed with CSS (pointer px are captured px). */
  readonly scale: number;
  constructor(scale: number) { this.scale = scale; }

  static async open(scale: number, fresh: boolean): Promise<Page> {
    const target = fresh
      ? await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json() as any
      : await until(async () => ((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as any[]).find((t) => t.type === 'page'), 20000, 'chrome');
    const p = new Page(scale);
    p.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => p.ws.addEventListener('open', r, { once: true }));
    p.ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && p.waiting.has(m.id)) { p.waiting.get(m.id)!(m); p.waiting.delete(m.id); }
      if (m.method === 'Page.screencastFrame') { void p.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }); try { p.onFrame?.(m.params.data, m.params.sessionId, m.params.metadata); } catch (e) { p.frameError = e as Error; } }
    });
    await p.send('Page.enable');
    // Both pages behave as focused, and the one being recorded is brought to the front (see focus()):
    // headless Chrome neither renders nor takes input for a background tab.
    await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return p;
  }
  /** Emulated screen and background, re-applied whenever the page comes to the front (that resets them). */
  private screen: Array<[string, Record<string, unknown>]> = [];
  async emulate(method: string, params: Record<string, unknown>): Promise<void> { this.screen.push([method, params]); await this.send(method, params); }
  async focus(): Promise<void> {
    await this.send('Page.bringToFront');
    for (const [method, params] of this.screen) await this.send(method, params);
    await sleep(300);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((r, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`Chrome did not answer ${method}`)); }, 60_000);
      this.waiting.set(id, (v) => { clearTimeout(timer); r(v); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    return r.result?.result?.value;
  }
  /** Box of the first visible element matching `sel`, in captured px: [x, y, w, h]. (Some controls exist twice, one
   *  per toolbar layout, with one copy hidden.) */
  async box(sel: string): Promise<number[] | null> {
    const r = await this.eval(`(() => { for (const e of document.querySelectorAll(${JSON.stringify(sel)})) { const b = e.getBoundingClientRect(); if (b.width && b.height) return [b.left, b.top, b.width, b.height]; } return null; })()`);
    return r ? r.map((v: number) => Math.round(v * (this.scale === PET_ZOOM ? 1 : this.scale))) : null;
  }
  // Pointer: CSS px of the page's viewport (on the pet page that is already the zoomed, captured px).
  // While a 2× screenshot is being taken, Chrome reads pointer coordinates at half scale, so a click meant for a
  // button lands somewhere else: pointer events wait for the screenshot in flight and hold the next one back.
  private shotInFlight: Promise<unknown> | null = null;
  private hold: Promise<void> | null = null;
  private async mouse(type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
    let done!: () => void;
    this.hold = new Promise((r) => { done = r; });
    try {
      if (this.shotInFlight) await this.shotInFlight;
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });
    } finally { this.hold = null; done(); }
  }
  private at(x: number, y: number) { return { x: Math.round(x * (this.scale === PET_ZOOM ? 1 : this.scale)), y: Math.round(y * (this.scale === PET_ZOOM ? 1 : this.scale)) }; }
  /** Glide the pointer to (x, y) over `ms`, easing in and out, as a hand would. */
  async moveTo(x: number, y: number, ms = 700): Promise<void> {
    const from = { ...this.pointer }, steps = Math.max(1, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const u = i / steps, e = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
      const px = from.x + (x - from.x) * e, py = from.y + (y - from.y) * e;
      await this.mouse('mouseMoved', px, py);
      this.events.push({ t: Date.now(), type: 'move', ...this.at(px, py) });
      await sleep(16);
    }
    this.pointer = { x, y };
  }
  async click(x: number, y: number, ms = 700): Promise<void> {
    await this.moveTo(x, y, ms);
    await sleep(120);
    await this.mouse('mousePressed', x, y, { button: 'left', clickCount: 1 });
    this.events.push({ t: Date.now(), type: 'down', ...this.at(x, y) });
    await sleep(90);
    await this.mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
    this.events.push({ t: Date.now(), type: 'up', ...this.at(x, y) });
  }
  async clickEl(sel: string, ms = 700): Promise<void> {
    const r = await this.eval(`(() => { for (const e of document.querySelectorAll(${JSON.stringify(sel)})) { const b = e.getBoundingClientRect(); if (b.width && b.height) return [b.left + b.width / 2, b.top + b.height / 2]; } return null; })()`);
    if (!r) throw new Error(`nothing visible to click: ${sel}`);
    await this.click(r[0], r[1], ms);
    // What the click reached, for the log (and to catch a click that went elsewhere).
    const hit = await this.eval(`(() => { const e = document.elementFromPoint(${r[0]}, ${r[1]}); return (e?.closest('button, input, a, .card')?.outerHTML ?? e?.outerHTML ?? '').slice(0, 90); })()`);
    log(`click ${sel} at ${r.map(Math.round)} → ${hit}`);
  }
  /** Rub the pointer back and forth around (x, y): petting. */
  async rub(x: number, y: number, ms: number): Promise<void> {
    await this.moveTo(x, y, 500);
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const k = (Date.now() - t0) / 1000, px = x + 32 * Math.sin(k * 10), py = y + 4 * Math.sin(k * 17);
      await this.mouse('mouseMoved', px, py);
      this.events.push({ t: Date.now(), type: 'move', ...this.at(px, py) });
      await sleep(16);
    }
    this.pointer = { x, y };
  }
  async type(text: string): Promise<void> {
    for (const ch of text) { await this.send('Input.insertText', { text: ch }); await sleep(LANG === 'zh' ? 110 : 55); }
  }
  async key(key: string): Promise<void> {
    const code = key === 'Enter' ? 13 : 0;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, text: key === 'Enter' ? '\r' : undefined });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
  }
  mark(name: string): void { this.events.push({ t: Date.now(), type: 'mark', name }); }

  // ---------------------------------------------------------------- recording
  private clip: Clip | null = null;
  /**
   * While a clip records, sample `expr` ten times a second: a number, or [top, bottom], in captured px (null when
   * absent). It tells the video where the streaming answer is, so its camera can follow the newest line and see
   * when the text stops growing.
   */
  private sample(clip: Clip, expr: string | undefined): () => Promise<void> {
    if (!expr) return async () => {};
    let on = true;
    const loop = (async () => {
      while (on) {
        const v = await this.eval(expr).catch(() => null);
        const px = (x: number) => Math.round(x * (this.scale === PET_ZOOM ? 1 : this.scale));
        if (typeof v === 'number') clip.track.push([Date.now(), px(v)]);
        else if (Array.isArray(v) && v.length === 2) clip.track.push([Date.now(), px(v[0]), px(v[1])]);
        await sleep(100);
      }
    })();
    return async () => { on = false; await loop; };
  }

  /** Screenshot loop at the page's device scale (Chumi's window). */
  async recordShots(name: string, track?: string): Promise<void> {
    await this.focus();
    const dir = join(OUT, name); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const clip: Clip = this.clip = { name, dir, frames: [], start: Date.now(), track: [] };
    this.events = [];
    const stopSampling = this.sample(clip, track);
    let on = true;
    const loop = (async () => {
      while (on) {
        if (this.hold) await this.hold;
        this.shotInFlight = this.send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
        const r: any = await this.shotInFlight;
        this.shotInFlight = null;
        const f = `${String(clip.frames.length).padStart(5, '0')}.jpg`;
        writeFileSync(join(dir, f), Buffer.from(r.result.data, 'base64'));
        clip.frames.push({ t: Date.now(), f });
      }
    })();
    clip.stop = async () => { on = false; await loop; await stopSampling(); };
  }
  /** Screencast with a transparent background (the pet), kept at about 30 frames a second. */
  async recordCast(name: string, track?: string): Promise<void> {
    await this.focus();
    const dir = join(OUT, name); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const clip: Clip = this.clip = { name, dir, frames: [], start: Date.now(), track: [] };
    this.events = [];
    const stopSampling = this.sample(clip, track);
    let last = 0;
    this.onFrame = (data, _s, meta?: { deviceWidth: number; deviceHeight: number }) => {
      const now = Date.now();
      if (now - last < 30) return;
      if (meta && (Math.round(meta.deviceWidth) !== PET_W * PET_ZOOM || Math.round(meta.deviceHeight) !== PET_H * PET_ZOOM)) throw new Error(`pet frame is ${meta.deviceWidth}×${meta.deviceHeight}`);
      last = now;
      const f = `${String(clip.frames.length).padStart(5, '0')}.png`;
      writeFileSync(join(dir, f), Buffer.from(data, 'base64'));
      clip.frames.push({ t: now, f });
    };
    await this.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: PET_W * PET_ZOOM, maxHeight: PET_H * PET_ZOOM });
    clip.stop = async () => { await this.send('Page.stopScreencast'); this.onFrame = null; await stopSampling(); };
  }
  async stop(extra: Record<string, unknown> = {}): Promise<void> {
    const c = this.clip!;
    await c.stop!();
    if (this.frameError) throw this.frameError;
    const t0 = c.start, rel = (t: number) => +((t - t0) / 1000).toFixed(3);
    const clip = JSON.stringify({
      name: c.name, lang: LANG, scale: this.scale, duration: rel(Date.now()),
      frames: c.frames.map((x) => [rel(x.t), x.f]),
      events: this.events.map((e) => ({ ...e, t: rel(e.t) })), track: c.track.map(([t, ...v]) => [rel(t), ...v]), ...extra,
    });
    writeFileSync(join(c.dir, 'clip.json'), clip);
    // The same as a script, so a page opened from disk (the promo videos) can load it with a <script> tag.
    writeFileSync(join(c.dir, 'clip.js'), `(window.CLIPS ??= {})[${JSON.stringify(c.name)}] = ${clip};\n`);
    log(`clip ${c.name}: ${c.frames.length} frames, ${rel(Date.now())} s`);
    this.clip = null;
  }
}

async function main(): Promise<void> {
  if (!CHROME) throw new Error('Google Chrome or Microsoft Edge is needed.');
  if (!existsSync(SAMPLE)) throw new Error(`Missing ${SAMPLE}. Run: node scripts/make-sample.mjs --script ${join(SAMPLE_DIR, 'script.json')}`);
  mkdirSync(OUT, { recursive: true });
  buildWeb(ROOT);
  const lines = JSON.parse(readFileSync(join(SAMPLE_DIR, 'manifest.json'), 'utf8')).lines as Array<{ startMs: number; endMs: number; text: string; tags: string[] }>;
  const lineOf = (re: RegExp) => { const l = lines.find((x) => re.test(x.text)); if (!l) throw new Error(`no sample line matches ${re}`); return l; };
  const topic = lines.findIndex((l) => l.tags.includes('topic_change'));
  const debateEnd = lines.slice(0, topic).filter((l) => l.tags.includes('disagreement')).at(-1)!;
  const server: ChildProcess = spawn(process.execPath, [join(ROOT, 'server/main.ts')], { env: { ...process.env, CHUMI_DEV: '1', CHUMI_NO_HOTKEY: '1', CHUMI_NO_LAUNCH: '1', CHUMI_DATA_DIR: DATA, PORT: String(PORT) }, stdio: 'ignore' });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(DATA, 'chrome')}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--force-color-profile=srgb', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  const stopAll = () => { chrome.kill('SIGTERM'); server.kill('SIGTERM'); };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { stopAll(); setTimeout(() => { rmSync(DATA, { recursive: true, force: true }); process.exit(130); }, 1500); });
  try {
    await until(async () => (await api('/api/state')).live.asr.state === 'ready', 120000, 'server');
    const defaults = await api('/api/settings');
    await api('/api/settings', {
      ui: { language: LANG }, asr: { glossary: [...new Set([...defaults.asr.glossary, ...GLOSSARY])] }, ai: { provider: PROVIDER, effort: 'auto' },
      assist: { autoOverview: false, autoExplain: false, defaultDepth: 'standard' },
      pet: { enabled: true, size: 1, toolbar: true, cards: 'latest', tags: ['meeting', 'tangent', 'background', 'summary'], say: ['meeting', 'tangent', 'background', 'summary', 'chatter'] },
    }, 'PUT');
    await api('/api/profile', { ...(await api('/api/profile')), ...L.profile, explanationLanguage: L.explanation, keepEnglishTerms: true }, 'PUT');
    const st = await api('/api/provider/status?refresh=1');
    if (!st.ready) throw new Error(`AI provider not ready: ${st.state} ${st.message ?? ''}`);

    // Chumi's window, as in Chumi.app (unified title bar).
    const main = await Page.open(2, false);
    await main.emulate('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
    // The pet: drawn 3× larger on a transparent page, so the camera can come close.
    const pet = await Page.open(PET_ZOOM, true);
    await pet.emulate('Emulation.setDeviceMetricsOverride', { width: PET_W * PET_ZOOM, height: PET_H * PET_ZOOM, deviceScaleFactor: 1, mobile: false });
    await pet.emulate('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const sc = (v: number) => v * PET_ZOOM;  // pet CSS px → its captured px (with the zoom, boxes and pointer agree)

    // ---- the pet, before and as the meeting starts
    await pet.send('Page.navigate', { url: `${B}/pet.html` });
    await until(async () => pet.eval(`!!document.querySelector('.bar button')`), 15000, 'pet page');
    // Zoomed once the page exists (at document start there is no root element yet).
    await pet.eval(`document.documentElement.style.zoom = '${PET_ZOOM}'; true`);
    await sleep(400);
    const petBox = await pet.box('.chumi-pet');
    if (!petBox || petBox[2] < 100 * PET_ZOOM) throw new Error(`the pet page is not zoomed: ${JSON.stringify(petBox)}`);
    if (AGENT) { await recordAgent(main, pet, lines.at(-1)!.endMs); return; }
    await pet.recordCast('pet-start');
    await sleep(2600);                                 // it waves hello
    await pet.moveTo(sc(40), sc(120), 10);             // the pointer comes in from the side; its eyes follow
    await pet.moveTo(sc(300), sc(80), 1400);
    await sleep(600);
    pet.mark('start');
    const { session } = await api('/api/session/start', { title: L.title, type: 'lab_meeting', source: 'file', filePath: SAMPLE, speed: SPEED, record_audio: false });
    const sid = session.id;
    await sleep(4500);                                 // ears up: listening, jotting lines down
    await pet.rub(sc(190), sc(150), 2400);             // a pat on the head
    await pet.moveTo(sc(360), sc(40), 900);
    await sleep(3500);
    await pet.stop({ box: { pet: await pet.box('.chumi-pet'), bar: await pet.box('.bar') } });

    const lastT = async () => (await api(`/api/sessions/${sid}`)).segments.at(-1)?.t_end ?? 0;
    const outputs = async () => (await api(`/api/sessions/${sid}`)).outputs as any[];
    const newOutput = async (kind: string, before: Set<string>) => until(async () => (await outputs()).find((o) => o.kind === kind && !before.has(o.id)), 30000, `${kind} to start`);
    const done = (id: string) => until(async () => { const o = (await outputs()).find((x) => x.id === id); return o && !['pending', 'streaming'].includes(o.status) ? o : null; }, 300000, `output ${id}`);
    const known = async () => new Set((await outputs()).map((o) => o.id));

    // ---- Chumi's window: the transcript arriving, then a real click on Catch me up, and the answer streaming in
    await main.send('Page.navigate', { url: `${B}/?session=${sid}` });
    await until(async () => main.eval(APP_SHELL), 10000, 'app shell');
    await until(async () => main.eval(`!!document.querySelector('.btn.catchup')`), 15000, 'session view');
    // An explanation from earlier in the meeting, so Chumi's answer column is not empty when Catch me up is clicked.
    await until(async () => (await lastT()) > lineOf(/a round of DPO/).endMs + 2000, 300000, 'the setup to be transcribed');
    const dpo = (await api(`/api/sessions/${sid}`)).segments.find((s: any) => /DPO/.test(s.text));
    log('an earlier explanation: DPO');
    await done((await api('/api/ai/explain', { sessionId: sid, term: 'DPO', selection: dpo ? { fromT: dpo.t_start, toT: dpo.t_end, text: dpo.text } : null, depth: 'standard' })).id);
    log('waiting for the judge-bias debate to be transcribed');
    await until(async () => (await lastT()) > debateEnd.endMs - 9000, 400000, 'transcript near the end of the debate');
    await main.recordShots('main-catchup', followText(`document.querySelector('.card-catchup .md')`));
    await until(async () => (await lastT()) > debateEnd.endMs, 120000, 'transcript past the debate');
    await sleep(1500);
    let before = await known();
    const catchBtn = await main.box('.btn.catchup');
    await main.clickEl('.btn.catchup', 900);
    main.mark('click');
    const cu = await newOutput('catchup', before);
    await until(async () => main.eval(`(document.querySelector('.card-catchup .md')?.textContent ?? '').length > 20`), 120000, 'catch-up text').then(() => main.mark('streaming'));
    await done(cu.id); main.mark('done');
    await sleep(2500);
    await main.stop({ box: { catchBtn, card: await main.box('.card-catchup'), transcript: await main.box('.transcript-wrap') } });

    // ---- the pet: catch up from its toolbar, read the card, ask a question
    // The window's catch-up left a "ready" bubble on the pet: let it go first, so this one starts clean.
    await pet.focus();
    await until(async () => pet.eval(`getComputedStyle(document.querySelector('.chumi-bubble')).visibility === 'hidden'`), 15000, 'the pet bubble to clear').catch(() => {});
    await pet.recordCast('pet-catchup', `(() => { const c = document.querySelector('.cards'); return c && !c.hidden ? c.getBoundingClientRect().bottom : null; })()`);
    await pet.moveTo(sc(330), sc(60), 10);
    await sleep(400);
    before = await known();
    await pet.clickEl('button[data-act=catchup]', 1100);
    pet.mark('click');
    const pcu = await newOutput('catchup', before);
    await until(async () => pet.eval(`document.querySelector('.card .head .spin') === null && document.querySelector('.card .prev')?.textContent.length > 20`), 300000, 'pet card').catch(() => {});
    await done(pcu.id); pet.mark('done');
    await sleep(2200);
    await pet.clickEl('.card .head', 900);             // open the card
    pet.mark('open');
    await sleep(3200);
    await pet.clickEl('button[data-act=ask]', 900);
    await sleep(500);
    await pet.type(ASK);
    await sleep(400);
    before = await known();
    await pet.key('Enter');
    pet.mark('ask');
    const ans = await newOutput('answer', before);
    await done(ans.id); pet.mark('answered');
    await sleep(3000);
    await pet.moveTo(sc(370), sc(30), 900);
    await sleep(800);
    await pet.stop({ box: { pet: await pet.box('.chumi-pet'), bar: await pet.box('.bar'), cards: await pet.box('.cards') } });

    // ---- Chumi's window: an explanation, pitched to the profile
    await until(async () => (await lastT()) > lineOf(/eight passages for the main results/).endMs, 300000, 'transcript past the compute plan');
    // (The DPO explanation from earlier is also a .card-explain: look at the KV cache one.)
    const kvCard = `[...document.querySelectorAll('.card-explain')].find((c) => /KV cache/.test(c.querySelector('.card-title')?.textContent ?? ''))`;
    await main.recordShots('main-explain', followText(`${kvCard}?.querySelector('.md')`));
    await sleep(1500);
    const kv = (await api(`/api/sessions/${sid}`)).segments.find((s: any) => /KV/i.test(s.text));
    main.mark('ask');
    const ex = (await api('/api/ai/explain', { sessionId: sid, term: 'KV cache', selection: kv ? { fromT: kv.t_start, toT: kv.t_end, text: kv.text } : null, depth: 'standard' })).id;
    await until(async () => main.eval(`(${kvCard}?.querySelector('.md')?.textContent ?? '').length > 20`), 120000, 'explanation text').then(() => main.mark('streaming'));
    await done(ex); main.mark('done');
    await sleep(2500);
    const kvBox = await main.eval(`(() => { const b = ${kvCard}?.getBoundingClientRect(); return b ? [b.left, b.top, b.width, b.height].map((v) => Math.round(v * 2)) : null; })()`);
    await main.stop({ box: { card: kvBox ?? await main.box('.card-explain') } });

    // ---- the pet: end the meeting (two clicks), the summary is written
    await pet.focus();
    await until(async () => pet.eval(`getComputedStyle(document.querySelector('.chumi-bubble')).visibility === 'hidden'`), 15000, 'the pet bubble to clear').catch(() => {});
    await pet.recordCast('pet-end');
    await pet.moveTo(sc(330), sc(60), 10);
    await sleep(500);
    await pet.clickEl('button[data-act=end]', 1000);
    await sleep(700);
    await pet.clickEl('button[data-act=end]', 200);
    pet.mark('end');
    const ended = await until(async () => (await api(`/api/sessions/${sid}`)).session.status === 'ended', 60000, 'meeting to end');
    void ended;
    const summary = await until(async () => (await outputs()).find((o) => o.kind === 'final_summary'), 60000, 'summary to start');
    await done(summary.id); pet.mark('summary');
    await sleep(4500);                                 // celebration
    await pet.stop();
    log(`footage in ${OUT}`);
  } finally {
    stopAll();
    await sleep(1500);
    if (AGENT) log(`data folder (kept, for the agents' MCP reads): ${DATA}`);
    else if (!process.env.KEEP_DATA) rmSync(DATA, { recursive: true, force: true });
  }
}

/**
 * [top, bottom] of an answer's text (viewport px) as it streams in. Like a reader, it scrolls the answer column when
 * the newest line would go below the window, so the end of a long answer is written where the camera can see it.
 */
const followText = (md: string) => `(() => {
  const m = ${md}; if (!m) return null;
  let b = m.getBoundingClientRect().bottom; const limit = innerHeight - 28;
  if (b > limit) {
    let p = m.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    if (p) { p.scrollTop += b - limit; b = m.getBoundingClientRect().bottom; }
  }
  return [m.getBoundingClientRect().top, b];
})()`;

/** Continue a confirmed handoff: in Chumi's window with each destination, then once from the pet's toolbar. */
async function recordAgent(main: Page, pet: Page, meetingEndMs: number): Promise<void> {
  const sc = (v: number) => v * PET_ZOOM;
  const { project } = await api('/api/projects', { name: L.project, workspace: PROJECT_FOLDER });
  const { session } = await api('/api/session/start', { title: L.title, type: 'lab_meeting', source: 'file', filePath: SAMPLE, speed: SPEED, record_audio: false, project_id: project.id });
  const sid = session.id;
  const meeting = async () => api(`/api/sessions/${sid}`);
  log('waiting for the whole meeting to be transcribed');
  await until(async () => ((await meeting()).segments.at(-1)?.t_end ?? 0) > meetingEndMs - 4000, 900000, 'the whole meeting');
  await sleep(3000);
  await api('/api/session/end', {});
  await until(async () => (await meeting()).outputs.find((o: any) => o.kind === 'final_summary' && !['pending', 'streaming'].includes(o.status)), 300000, 'the summary');
  log('drafting the handoff');
  await api(`/api/sessions/${sid}/handoff`, {});
  const h = await until(async () => { const r = (await api(`/api/sessions/${sid}/handoff`)).handoff; return r && r.status !== 'generating' ? r : null; }, 300000, 'handoff draft');
  if (h.status === 'error') throw new Error(`handoff draft failed: ${h.error}`);
  for (const item of h.items) await api(`/api/handoff-items/${item.id}`, { review: 'confirmed' }, 'PATCH');
  await api(`/api/handoffs/${h.id}/confirm`, {});
  log(`handoff ${h.id} confirmed with ${h.items.length} items`);

  // ---- Chumi's window: the confirmed handoff, continued in Claude Code, then Codex, then Codex app
  await main.send('Page.navigate', { url: `${B}/?session=${sid}` });
  await until(async () => main.eval(APP_SHELL), 10000, 'app shell');
  await until(async () => main.eval(`!!document.querySelector('.handoff-btn')`), 15000, 'handoff button');
  await main.eval(`(() => { for (const b of document.querySelectorAll('.handoff-btn')) if (b.getBoundingClientRect().width) { b.click(); return true; } })()`);
  await until(async () => main.eval(`!!document.querySelector('.dialog .handoff-destination select')`), 10000, 'handoff dialog');
  await sleep(800);
  const select = await main.box('.dialog .handoff-destination select');
  // The first item, its origin and its evidence: the video's handoff scene highlights them in this same footage.
  const item = await main.box('.dialog .hitem'), origin = await main.box('.dialog .hitem .tag'), evidence = await main.box('.dialog .hitem .evidence');
  const delivered = (via: string) => until(async () => (await api(`/api/sessions/${sid}/handoff`)).handoff?.delivered_via === via, 20000, `delivery to ${via}`);
  await main.recordShots('main-handoff');
  await main.moveTo(W * 0.62, H * 0.92, 10);
  await sleep(1200);
  for (const place of ['claude-code', 'codex', 'codex-app']) {
    // The menu itself is the system's (it isn't in a screenshot); the video draws it from these marks and boxes.
    await main.moveTo((select![0] + select![2] / 2) / 2, (select![1] + select![3] / 2) / 2, 800);
    main.mark(`menu:${place}`);
    await sleep(900);
    await main.eval(`(() => { const s = document.querySelector('.dialog .handoff-destination select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(place)}); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
    main.mark(`chose:${place}`);
    await sleep(700);
    await main.clickEl('.dialog .btn.primary', 700);
    main.mark(`continue:${place}`);
    await delivered(place);
    await sleep(2800);
  }
  const dialogBox = await main.box('.dialog');
  await main.stop({ box: { select, dialog: dialogBox, item, origin, evidence, cont: await main.box('.dialog .btn.primary'), hint: await main.box('.dialog .small.muted') } });

  // ---- the pet: the meeting's handoff is confirmed, so its toolbar continues it (in Codex app, chosen last)
  await pet.focus();
  await until(async () => pet.eval(`!!document.querySelector('button[data-act=continue]')`), 15000, 'the pet’s Continue button');
  await until(async () => pet.eval(`getComputedStyle(document.querySelector('.chumi-bubble')).visibility === 'hidden'`), 20000, 'the pet bubble to clear').catch(() => {});
  await pet.recordCast('pet-handoff');
  await pet.moveTo(sc(360), sc(40), 10);
  await sleep(700);
  const go = await pet.box('button[data-act=continue]');
  await pet.moveTo(go![0] + go![2] / 2, go![1] + go![3] / 2, 1100);
  await sleep(1300);                                   // its tooltip names the destination
  await pet.clickEl('button[data-act=continue]', 200);
  pet.mark('continue');
  await delivered('codex-app').catch(() => {});
  await until(async () => pet.eval(`getComputedStyle(document.querySelector('.chumi-bubble')).visibility !== 'hidden'`), 10000, 'the pet bubble').then(() => pet.mark('said'));
  await sleep(4200);
  await pet.moveTo(sc(370), sc(30), 900);
  await sleep(600);
  await pet.stop({ box: { pet: await pet.box('.chumi-pet'), bar: await pet.box('.bar'), go } });

  // The prompt a coding agent starts from (Copy instructions), for the real runs in the project folder.
  const { prompt } = await api(`/api/handoffs/${h.id}/continue`, { agent: 'copy' });
  writeFileSync(join(DATA, 'handoff-prompt.md'), prompt);
  writeFileSync(join(OUT, 'agent.json'), JSON.stringify({ data: DATA, handoff: h.id, project: PROJECT_FOLDER, prompt: join(DATA, 'handoff-prompt.md') }, null, 1));
  log(`handoff prompt: ${join(DATA, 'handoff-prompt.md')}`);
}

main().catch((e) => { console.error('record-footage failed:', (e as Error).message); process.exit(1); });
