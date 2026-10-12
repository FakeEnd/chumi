/**
 * Captures the README screenshots (and the promo video's frames) from a real run of the app.
 *
 *   node scripts/demo-shoot.ts                       # English: all-English sample, English UI and answers
 *   node scripts/demo-shoot.ts --lang zh             # 中文: bilingual sample, Chinese UI and answers
 *   node scripts/demo-shoot.ts --provider codex      # default provider: the Claude plan (claude-cli)
 *   node scripts/demo-shoot.ts --project-folder DIR  # also shoot the agent loop: a reviewed handoff, and an answer
 *                                                    # that uses the earlier agent sessions in DIR (through mybot)
 *   node scripts/demo-shoot.ts --only agent --project-folder DIR   # just those two screenshots (about 3 AI requests)
 *
 * Plays a synthetic sample lab meeting (fictional people, macOS text-to-speech; see samples/) through a
 * throwaway server with an empty data folder (3× speed, real local Whisper), with a fictional demo profile.
 * It asks a few real AI questions, injects one rendered slide as a window capture, and screenshots the UI
 * with headless Chrome (Chrome DevTools Protocol, no extra dependencies). Nothing from your own sessions,
 * profile or windows is used. Uses roughly 10 AI requests.
 * Output: docs/assets/screens/*.png (en) or docs/assets/screens/zh/*.png, plus regions.js (where things are,
 * for the promo video's zooms and highlights).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const PROVIDER = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : 'claude-cli';
const LANG: 'en' | 'zh' = args.includes('--lang') && args[args.indexOf('--lang') + 1] === 'zh' ? 'zh' : 'en';
const OUT = join(ROOT, 'docs/assets/screens', LANG === 'zh' ? 'zh' : '');
// English uses the all-English sample; 中文 uses the original, where one speaker mixes Mandarin and English.
const SAMPLE_DIR = join(ROOT, LANG === 'zh' ? 'samples/lab-meeting' : 'samples/lab-meeting-en');
const SAMPLE = join(SAMPLE_DIR, LANG === 'zh' ? 'lab-meeting.wav' : 'lab-meeting-en.wav');
// The agent loop scenes: a project folder where Claude Code / Codex already worked on this meeting's handoff
// (mybot must be running and have indexed those sessions for the project-context answer).
const ONLY_AGENT = args.includes('--only') && args[args.indexOf('--only') + 1] === 'agent';
const PROJECT_FOLDER = args.includes('--project-folder') ? resolve(args[args.indexOf('--project-folder') + 1]) : null;
if (ONLY_AGENT && !PROJECT_FOLDER) throw new Error('--only agent needs --project-folder');

/** Everything the run types or asks, per language. */
const L = {
  en: {
    title: 'Lab meeting: enhancer model',
    project: 'Enhancer model',
    pcQ: 'What did the agent plan for split_peaks and the noise ceiling?',
    q1: 'Why does the PI think the GATA result might be a batch artifact?',
    slideQ: 'Explain what is shown on this slide and how it relates to what the speakers are saying.',
    explanation: 'English',
    profile: {
      background: 'Computer science undergraduate, now a first-year PhD student in bioinformatics.',
      researchInterests: 'Machine learning for gene regulation; sequence-to-function models.',
      domains: [
        { name: 'Programming', level: 4 }, { name: 'Machine learning', level: 3 }, { name: 'Statistics', level: 2 },
        { name: 'Genomics', level: 1 }, { name: 'Wet-lab techniques', level: 0, notes: 'Do not assume any protocol knowledge.' },
      ],
      knownConcepts: ['neural network', 'cross-validation', 'attention'],
      needsBackground: ['experimental assay design', 'count models'],
      style: 'Concise. Intuition first, then the mechanism.',
    },
  },
  zh: {
    title: '组会：增强子模型',
    project: '增强子模型',
    pcQ: '之前的 agent 对 split_peaks 和 noise ceiling 有什么计划？',
    q1: '为什么 PI 觉得 GATA 的结果可能是批次效应？',
    slideQ: '解释这张幻灯片上的内容，以及它和发言内容的关系。',
    explanation: 'Simplified Chinese',
    profile: {
      background: '计算机本科，现在是生物信息学一年级博士生。',
      researchInterests: '基因调控的机器学习；序列到功能模型。',
      domains: [
        { name: '编程', level: 4 }, { name: '机器学习', level: 3 }, { name: '统计学', level: 2 },
        { name: '基因组学', level: 1 }, { name: '湿实验技术', level: 0, notes: '不要假设我了解任何实验流程。' },
      ],
      knownConcepts: ['neural network', 'cross-validation', 'attention'],
      needsBackground: ['实验设计', '计数模型'],
      style: '简洁。先讲直觉，再讲机制。',
    },
  },
}[LANG];

/** Inside Chumi.app the top bar is the window's title bar; the screenshots show it the same way. */
const APP_SHELL = `(() => {
  const h = document.documentElement;
  h.dataset.shell = 'mac';
  h.style.setProperty('--traffic-inset', '94px');
  if (!document.body) return false;
  if (document.getElementById('demo-traffic')) return true;
  const d = document.createElement('div');
  d.id = 'demo-traffic';
  d.innerHTML = '<i></i><i></i><i></i>';
  Object.assign(d.style, { position: 'fixed', left: '18px', top: '0', height: '55px', display: 'flex', alignItems: 'center', gap: '10px', zIndex: '9999', pointerEvents: 'none' });
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => Object.assign(d.children[i].style, { width: '13px', height: '13px', borderRadius: '50%', display: 'block', background: c, boxShadow: 'inset 0 0 0 .5px rgba(0,0,0,.18)' }));
  document.body.appendChild(d);
  const fit = () => { const b = document.querySelector('.topbar'); if (b) d.style.height = b.offsetHeight + 'px'; };
  fit(); setInterval(fit, 200);
  return true;
})()`;

/** Measures elements on the current screen, in screenshot CSS px clipped to the viewport: [x, y, w, h]. */
const MEASURE = `(sel, textRe) => {
  const clip = (r) => { const y0 = Math.max(0, r.top), y1 = Math.min(innerHeight, r.bottom); return r.width && y1 > y0 ? [r.left, y0, r.width, y1 - y0].map(Math.round) : null; };
  const els = [...document.querySelectorAll(sel)];
  if (!textRe) return els.length ? clip(els[0].getBoundingClientRect()) : null;
  const re = new RegExp(textRe);
  for (const e of els) for (const n of e.querySelectorAll('li, p, td')) if (re.test(n.textContent)) { const r = clip(n.getBoundingClientRect()); if (r) return r; }
  return els.length ? clip(els[0].getBoundingClientRect()) : null;
}`;
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(existsSync);
const PORT = 4950 + Math.floor(Math.random() * 40);
const CDP_PORT = 9350 + Math.floor(Math.random() * 40);
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), 'chumi-demo-'));
const W = 1360, H = 860;
// Faster playback makes the live transcriber fall behind (the Speech badge would say so), which normal use never does.
// The agent-only run screenshots nothing live, so it can play faster and let transcription catch up at the end.
const SPEED = ONLY_AGENT ? 6 : 3;
// Vocabulary hints for this meeting's jargon (Settings → Transcription), as a user would add them.
const GLOSSARY = ['GATA', 'GATA1', 'GATA motif', 'MPRA', 'lentiMPRA', 'E-box', 'CUT&Tag', 'gapped k-mer', 'barcode', 'Poisson', 'negative binomial', 'erythroid'];
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
  async measure(sel: string, textRe?: string): Promise<number[] | null> {
    return this.eval(`(${MEASURE})(${JSON.stringify(sel)}, ${textRe ? JSON.stringify(textRe) : 'null'})`);
  }
  async goto(url: string, dark = false): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    await this.send('Page.navigate', { url });
    await sleep(500);
    if (url.startsWith('http')) await until(async () => this.eval(APP_SHELL), 10000, 'app shell');
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

const SLIDE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;width:1280px;height:720px;font-family:-apple-system,Helvetica;background:#fff;display:flex;flex-direction:column">
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
  if (!existsSync(SAMPLE)) throw new Error(`Missing ${SAMPLE}. Run: node scripts/make-sample.mjs --script ${join(SAMPLE_DIR, 'script.json')}`);
  mkdirSync(OUT, { recursive: true });
  // Scene timing comes from the sample's manifest, so both samples line up.
  const lines = JSON.parse(readFileSync(join(SAMPLE_DIR, 'manifest.json'), 'utf8')).lines as Array<{ startMs: number; endMs: number }>;
  const regions: Record<string, Record<string, unknown>> = {};
  const server: ChildProcess = spawn(process.execPath, [join(ROOT, 'server/main.ts')], { env: { ...process.env, CHUMI_DEV: '1', CHUMI_NO_HOTKEY: '1', CHUMI_DATA_DIR: DATA, PORT: String(PORT) }, stdio: 'ignore' });
  const stop = () => { chrome.kill('SIGTERM'); server.kill('SIGTERM'); setTimeout(() => { if (!process.env.KEEP_DATA) rmSync(DATA, { recursive: true, force: true }); process.exit(130); }, 1500); };
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(DATA, 'chrome')}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  try {
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    await until(async () => (await api('/api/state')).live.asr.state === 'ready', 120000, 'server');
    const defaults = await api('/api/settings');
    await api('/api/settings', { ui: { language: LANG }, asr: { glossary: [...new Set([...defaults.asr.glossary, ...GLOSSARY])] }, ai: { provider: PROVIDER, effort: 'auto' }, assist: { autoOverview: false, autoExplain: false, defaultDepth: 'standard' }, quickStart: { hotkey: 'ctrl+opt+cmd+L' } }, 'PUT');
    const base = await api('/api/profile');
    const profile = { ...base, ...L.profile, explanationLanguage: L.explanation, keepEnglishTerms: true };
    await api('/api/profile', profile, 'PUT');
    const st = await api('/api/provider/status?refresh=1');
    if (!st.ready) throw new Error(`AI provider not ready: ${st.state} ${st.message ?? ''}`);
    const page = await Page.open();

    // Render the slide that will be "captured" from a Zoom share.
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(SLIDE_HTML)}`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    const slidePng = join(DATA, 'slide.png'), slideJpg = join(DATA, 'slide.jpg');
    writeFileSync(slidePng, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
    execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', slidePng, '--out', slideJpg], { stdio: 'ignore' });

    const project = PROJECT_FOLDER ? (await api('/api/projects', { name: L.project, workspace: PROJECT_FOLDER })).project : null;
    const { session } = await api('/api/session/start', { title: L.title, type: 'lab_meeting', source: 'file', filePath: SAMPLE, speed: SPEED, project_id: project?.id });
    const sid = session.id;
    const lastT = async () => (await api(`/api/sessions/${sid}`)).segments.at(-1)?.t_end ?? 0;
    const segWith = async (re: RegExp) => (await api(`/api/sessions/${sid}`)).segments.find((s: any) => re.test(s.text));
    const done = (id: string) => until(async () => { const o = (await api(`/api/sessions/${sid}`)).outputs.find((x: any) => x.id === id); return o && !['pending', 'streaming'].includes(o.status) ? o : null; }, 300000, `output ${id}`);
    const shotSession = async (name: string, dark = false, query = '') => {
      // Let the transcriber settle so the Speech badge shows a steady state.
      await until(async () => { const l = (await api('/api/state')).live; return l.status !== 'recording' || l.asr.backlogSec <= 1; }, 60000, 'transcriber to catch up').catch(() => {});
      await page.goto(`${B}/?session=${sid}${query}`, dark); await page.waitFor('.card'); await page.shot(name);
    };

    if (!ONLY_AGENT) {
    // Scene 1 — live: catch-up on the GATA disagreement, an explanation, a question.
    await until(async () => (await lastT()) > lines[51].endMs, 400000, 'transcript past the GATA debate');
    await api('/api/session/pause', {});
    log('scene 1: asking');
    const mpra = await segWith(/MPRA/);
    const ids1 = [
      (await api('/api/ai/ask', { sessionId: sid, question: L.q1, depth: 'standard' })).id,
      (await api('/api/ai/explain', { sessionId: sid, term: 'MPRA', selection: mpra ? { fromT: mpra.t_start, toT: mpra.t_end, text: mpra.text } : null, depth: 'quick' })).id,
      (await api('/api/ai/recap', { sessionId: sid })).id,
    ];
    for (const id of ids1) await done(id);
    const cu = (await api('/api/ai/catchup', { sessionId: sid, scope: '2m' })).id;
    await done(cu);
    await api('/api/session/resume', {});
    await sleep(1500);
    await shotSession('live');
    regions.live = {
      transcript: await page.measure('.transcript-wrap'), catchBtn: await page.measure('.btn.catchup'),
      card: await page.measure('.card-catchup'), covers: await page.measure('.card-catchup .range'),
    };

    // Scene 2 — window capture: a slide from the shared screen, explained.
    await until(async () => (await lastT()) > lines[67].endMs, 300000, 'transcript past the barcode discussion');
    await api('/api/session/pause', {});
    log('scene 2: slide');
    const frame = await api('/api/dev/inject-frame', { sessionId: sid, path: slideJpg, t: lines[61].startMs + 11_000 });
    const ids2 = [
      (await api('/api/ai/recap', { sessionId: sid })).id,
      (await api('/api/ai/ask', { sessionId: sid, question: L.slideQ, depth: 'standard', frameIds: [frame.id] })).id,
    ];
    for (const id of ids2) await done(id);
    await api('/api/session/resume', {});
    await sleep(1500);
    await shotSession('window-capture');
    regions.win = {
      thumb: await page.measure('.slides .thumb'), card: await page.measure('.card-answer'),
      hl: await page.measure('.card-answer', '10,000|10000|1,500|1500|一万|万'),
    };

    // Scene 3 — an explanation pitched to the profile (English, or 中文 with English terms kept).
    await until(async () => (await lastT()) > lines[84].startMs + 10_000, 300000, 'transcript past the count-model discussion');
    await api('/api/session/pause', {});
    log('scene 3: explain');
    const nb = await segWith(/negative binomial/i);
    const ex = (await api('/api/ai/explain', { sessionId: sid, term: 'negative binomial model', selection: nb ? { fromT: nb.t_start, toT: nb.t_end, text: nb.text } : null, depth: 'standard' })).id;
    await done(ex);
    await shotSession('explain');
    regions.explain = { card: await page.measure('.card-explain') };
    await api('/api/session/resume', {});
    }

    // Scene 4 — end of meeting: structured summary with citations (dark mode).
    await until(async () => (await api('/api/state')).live.warnings.some((w: any) => w.code === 'file_finished') || (await lastT()) > lines.at(-1)!.endMs - 4000, 400000, 'end of sample');
    log('scene 4: summary');
    const ended = await api('/api/session/end', {});
    await done(ended.summaryId);
    if (!ONLY_AGENT) {
      await shotSession('summary', true);
      regions.sum = { card: await page.measure('.card-final_summary'), ref: await page.measure('.card-final_summary .ref') };
    }

    if (project) {
      // The project-context question is asked first, so the handoff is confirmed after it and doesn't show as changed.
      log('scene 8: project context (asking)');
      const pc = (await api('/api/ai/ask', { sessionId: sid, question: L.pcQ, depth: 'standard', projectContext: true })).id;
      const answer = await done(pc);
      const used = answer.data?.projectContext;
      if (used?.status !== 'used') throw new Error(`project context was not used (${used?.status ?? 'missing'}); is mybot running with sessions in ${PROJECT_FOLDER}?`);
      log(`answer (${used.sources.length} sessions): ${String(answer.content).slice(0, 700)}`);

      // Scene 7 — the reviewed handoff: drafted from the transcript, every item confirmed, ready to continue.
      log('scene 7: handoff');
      await api(`/api/sessions/${sid}/handoff`, {});
      const h = await until(async () => { const r = (await api(`/api/sessions/${sid}/handoff`)).handoff; return r && r.status !== 'generating' ? r : null; }, 300000, 'handoff draft');
      if (h.status === 'error') throw new Error(`handoff draft failed: ${h.error}`);
      for (const item of h.items) await api(`/api/handoff-items/${item.id}`, { review: 'confirmed' }, 'PATCH');
      await api(`/api/handoffs/${h.id}/confirm`, {});
      await page.goto(`${B}/?session=${sid}`); await page.waitFor('.handoff-box');
      await page.eval(`[...document.querySelectorAll('.handoff-box .btn-row .btn')].at(-1).click(), true`);
      await page.waitFor('.dialog .hitem');
      await page.shot('handoff');
      regions.handoff = { dialog: await page.measure('.dialog'), item: await page.measure('.dialog .hitem'), origin: await page.measure('.dialog .hitem .tag'),
        evidence: await page.measure('.dialog .hitem .evidence'), cont: await page.measure('.dialog .btn.primary') };

      // Scene 8 — the next question knows what the agents did: Project context on, answered from earlier agent sessions.
      log('scene 8: project context');
      await page.eval(`localStorage.setItem('chumi.projectContext.${sid}', '1'), true`);
      // The pinned final summary would push the answer out of view: fold it, and scroll the Ask box (with the
      // Project context toggle) to the top of the column. The sources list stays folded: session titles can contain local paths.
      await page.goto(`${B}/?session=${sid}`); await page.waitFor('.card-answer');
      await page.eval(`(() => { document.querySelector('.card-final_summary .card-head')?.click(); return true; })()`);
      await sleep(300);
      await page.eval(`(() => { document.querySelector('.askbox').scrollIntoView({ block: 'start' }); return true; })()`);
      await sleep(500);
      await page.shot('project-context');
      regions.pc = { toggle: await page.measure('.chip-toggle'), card: await page.measure('.card-answer'), sources: await page.measure('.card-answer .pc-sources') };
    }

    if (!ONLY_AGENT) {
    // Scene 5 — Settings → Transcription: speech models for this Mac, with the speed and accuracy test.
    log('scene 5: speech models');
    await page.goto(`${B}/?session=${sid}&dialog=settings&tab=asr`);
    await page.waitFor('.model-row');
    await page.eval(`[...document.querySelectorAll('.dialog .btn-row .btn')].at(-1).click(), true`);
    await page.waitFor('table.bench', 60000);
    await page.eval(`(() => { const body = document.querySelector('.dialog-body'), b = document.querySelector('table.bench').getBoundingClientRect(), d = body.getBoundingClientRect(); body.scrollTop += b.bottom - d.bottom + 16; return true; })()`);
    await sleep(400);
    await page.shot('models');
    regions.models = { dialog: await page.measure('.dialog'), list: await page.measure('.model-list'), active: await page.measure('.model-row.active'), bench: await page.measure('table.bench') };

    // Scene 6 — home screen.
    await page.goto(`${B}/`);
    await page.waitFor('.recent-list li');
    await page.shot('home');
    }

    // An agent-only run keeps the boxes measured by the last full run.
    const file = join(OUT, 'regions.js');
    const previous = ONLY_AGENT && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^[\s\S]*?window\.REGIONS = /, '').replace(/;\s*$/, '')) : {};
    writeFileSync(file, `// Written by scripts/demo-shoot.ts: element boxes in the ${LANG} screenshots (CSS px of a ${W}×${H} page).\nwindow.REGIONS = ${JSON.stringify({ ...previous, ...regions }, null, 1)};\n`);
    log('saved', join(OUT, 'regions.js'));
  } finally {
    chrome.kill('SIGTERM');
    server.kill('SIGTERM');
    await sleep(1500);
    if (!process.env.KEEP_DATA) rmSync(DATA, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('demo-shoot failed:', (e as Error).message); process.exit(1); });
