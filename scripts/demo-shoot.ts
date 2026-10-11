/**
 * Captures the README screenshots from a real run of the app.
 *
 *   node scripts/demo-shoot.ts                       # uses the Claude plan provider (claude-cli)
 *   node scripts/demo-shoot.ts --provider codex
 *
 * Plays the synthetic sample lab meeting through a throwaway server (8× speed, real local Whisper),
 * asks a few real AI questions, injects one rendered slide as a window capture, and screenshots the UI
 * with headless Chrome (Chrome DevTools Protocol, no extra dependencies). Uses roughly 10 AI requests.
 * Output: docs/assets/screens/*.png
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs/assets/screens');
const SAMPLE = join(ROOT, 'samples/lab-meeting/lab-meeting.wav');
const args = process.argv.slice(2);
const PROVIDER = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : 'claude-cli';
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(existsSync);
const PORT = 4950 + Math.floor(Math.random() * 40);
const CDP_PORT = 9350 + Math.floor(Math.random() * 40);
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), 'chumi-demo-'));
const W = 1360, H = 860;
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
  for (;;) { const v = await fn().catch(() => null); if (v) return v as T; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(500); }
}

// ------------------------------------------------------------------ minimal CDP client
class Page {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, (v: any) => void>();
  static async open(): Promise<Page> {
    const target = await until(async () => { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`); const l = await r.json() as any[]; return l.find((t) => t.type === 'page'); }, 20000, 'chrome');
    const p = new Page();
    p.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => p.ws.addEventListener('open', r, { once: true }));
    p.ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && p.waiting.has(m.id)) { p.waiting.get(m.id)!(m); p.waiting.delete(m.id); } });
    await p.send('Page.enable');
    return p;
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((r) => { this.waiting.set(id, r); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  }
  async goto(url: string, dark = false): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    await this.send('Page.navigate', { url });
    await sleep(500);
  }
  async waitFor(selector: string, ms = 15000): Promise<void> {
    await until(async () => this.eval(`!!document.querySelector(${JSON.stringify(selector)})`), ms, selector);
    await sleep(900);
  }
  async shot(name: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    log('saved', file);
  }
}

const SLIDE_HTML = `<!doctype html><html><body style="margin:0;width:1280px;height:720px;font-family:-apple-system,Helvetica;background:#fff;display:flex;flex-direction:column">
<div style="background:#1e3a5f;color:#fff;padding:34px 56px;font-size:40px;font-weight:700">MPRA validation design</div>
<div style="display:flex;flex:1;padding:36px 56px;gap:40px">
 <ul style="font-size:28px;line-height:1.6;color:#1b2033;flex:1;margin:0">
  <li>~1,500 candidate enhancer variants</li><li>Barcodes per variant: <b>100 vs 200?</b></li><li>3 biological replicates</li>
  <li>Counts → <b>negative binomial</b> model</li><li>FDR 5% (Benjamini–Hochberg)</li><li>Chromosome-level hold-out for the model</li></ul>
 <svg width="440" height="420" viewBox="0 0 440 420"><text x="220" y="26" font-size="20" text-anchor="middle" fill="#334">Activity (log2 RNA/DNA)</text>
  <line x1="50" y1="380" x2="420" y2="380" stroke="#889"/><line x1="50" y1="40" x2="50" y2="380" stroke="#889"/>
  ${Array.from({ length: 40 }, (_, i) => `<circle cx="${60 + (i * 9.1) % 350}" cy="${360 - ((i * 37) % 290)}" r="6" fill="${i % 5 === 0 ? '#e0552b' : '#4f46e5'}" opacity=".75"/>`).join('')}
  <text x="235" y="408" font-size="18" text-anchor="middle" fill="#334">Model prediction</text></svg>
</div><div style="padding:0 56px 24px;color:#889;font-size:18px">Lab meeting · validation plan (preliminary)</div></body></html>`;

async function main(): Promise<void> {
  if (!CHROME) throw new Error('Google Chrome or Microsoft Edge is needed for screenshots.');
  if (!existsSync(SAMPLE)) throw new Error('Run `npm run sample` first.');
  mkdirSync(OUT, { recursive: true });
  const server: ChildProcess = spawn(process.execPath, [join(ROOT, 'server/main.ts')], { env: { ...process.env, CHUMI_DEV: '1', CHUMI_NO_HOTKEY: '1', CHUMI_DATA_DIR: DATA, PORT: String(PORT) }, stdio: 'ignore' });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(DATA, 'chrome')}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  try {
    await until(async () => (await api('/api/state')).live.asr.state === 'ready', 120000, 'server');
    await api('/api/settings', { ai: { provider: PROVIDER, effort: 'auto' }, assist: { autoOverview: false, autoExplain: false, defaultDepth: 'standard' }, quickStart: { hotkey: 'ctrl+opt+cmd+L' } }, 'PUT');
    const profile = await api('/api/profile');
    await api('/api/profile', { ...profile, explanationLanguage: 'English' }, 'PUT');
    const st = await api('/api/provider/status?refresh=1');
    if (!st.ready) throw new Error(`AI provider not ready: ${st.state} ${st.message ?? ''}`);
    const page = await Page.open();

    // Render the slide that will be "captured" from a Zoom share.
    await page.goto(`data:text/html,${encodeURIComponent(SLIDE_HTML)}`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    const slidePng = join(DATA, 'slide.png'), slideJpg = join(DATA, 'slide.jpg');
    writeFileSync(slidePng, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
    execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', slidePng, '--out', slideJpg], { stdio: 'ignore' });

    const { session } = await api('/api/session/start', { title: 'Lab meeting: enhancer model', type: 'lab_meeting', source: 'file', filePath: SAMPLE, speed: 8 });
    const sid = session.id;
    const lastT = async () => (await api(`/api/sessions/${sid}`)).segments.at(-1)?.t_end ?? 0;
    const segWith = async (re: RegExp) => (await api(`/api/sessions/${sid}`)).segments.find((s: any) => re.test(s.text));
    const done = (id: string) => until(async () => { const o = (await api(`/api/sessions/${sid}`)).outputs.find((x: any) => x.id === id); return o && !['pending', 'streaming'].includes(o.status) ? o : null; }, 300000, `output ${id}`);
    const shotSession = async (name: string, dark = false) => {
      // At 8× playback the transcriber can lag a few seconds; wait so the speech badge shows a steady state.
      await until(async () => { const l = (await api('/api/state')).live; return l.status !== 'recording' || l.asr.backlogSec <= 2; }, 20000, 'transcriber to catch up').catch(() => {});
      await page.goto(`${B}/?session=${sid}`, dark); await page.waitFor('.card'); await page.shot(name);
    };

    // Scene 1 — live: catch-up on the GATA disagreement, an explanation, a question.
    await until(async () => (await lastT()) > 570_000, 400000, 'transcript to 9:30');
    await api('/api/session/pause', {});
    log('scene 1: asking');
    const mpra = await segWith(/MPRA/);
    const ids1 = [
      (await api('/api/ai/ask', { sessionId: sid, question: 'Why does the PI think the GATA result might be a batch artifact?', depth: 'standard' })).id,
      (await api('/api/ai/explain', { sessionId: sid, term: 'MPRA', selection: mpra ? { fromT: mpra.t_start, toT: mpra.t_end, text: mpra.text } : null, depth: 'quick' })).id,
      (await api('/api/ai/recap', { sessionId: sid })).id,
    ];
    for (const id of ids1) await done(id);
    const cu = (await api('/api/ai/catchup', { sessionId: sid, scope: '2m' })).id;
    await done(cu);
    await api('/api/session/resume', {});
    await sleep(1500);
    await shotSession('live');

    // Scene 2 — window capture: a slide from the shared screen, explained.
    await until(async () => (await lastT()) > 750_000, 300000, 'transcript to 12:30');
    await api('/api/session/pause', {});
    log('scene 2: slide');
    const frame = await api('/api/dev/inject-frame', { sessionId: sid, path: slideJpg, t: 668_000 });
    const ids2 = [
      (await api('/api/ai/recap', { sessionId: sid })).id,
      (await api('/api/ai/ask', { sessionId: sid, question: 'Explain what is shown on this slide and how it relates to what the speakers are saying.', depth: 'standard', frameIds: [frame.id] })).id,
    ];
    for (const id of ids2) await done(id);
    await api('/api/session/resume', {});
    await sleep(1500);
    await shotSession('window-capture');

    // Scene 3 — the same help in Chinese (中文), English terms kept.
    await until(async () => (await lastT()) > 945_000, 300000, 'transcript to 15:45');
    await api('/api/session/pause', {});
    log('scene 3: 中文');
    await api('/api/profile', { ...profile, explanationLanguage: 'Simplified Chinese' }, 'PUT');
    const nb = await segWith(/negative binomial/i);
    const zh = (await api('/api/ai/explain', { sessionId: sid, term: 'negative binomial model', selection: nb ? { fromT: nb.t_start, toT: nb.t_end, text: nb.text } : null, depth: 'standard' })).id;
    await done(zh);
    await shotSession('chinese');
    await api('/api/profile', { ...profile, explanationLanguage: 'English' }, 'PUT');
    await api('/api/session/resume', {});

    // Scene 4 — end of meeting: structured summary with citations (dark mode).
    await until(async () => (await api('/api/state')).live.warnings.some((w: any) => w.code === 'file_finished') || (await lastT()) > 1_228_000, 400000, 'end of sample');
    log('scene 4: summary');
    const ended = await api('/api/session/end', {});
    await done(ended.summaryId);
    await shotSession('summary', true);

    // Scene 5 — home screen.
    await page.goto(`${B}/`);
    await page.waitFor('.recent-list li');
    await page.shot('home');
  } finally {
    chrome.kill('SIGTERM');
    server.kill('SIGTERM');
    await sleep(1500);
    if (!process.env.KEEP_DATA) rmSync(DATA, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('demo-shoot failed:', (e as Error).message); process.exit(1); });
