import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { Store } from './db.ts';
import { AUDIO_DIR, DATA_DIR, FRAMES_DIR, MODELS_DIR, REPO_ROOT, WEB_DIST, ensureDirs, findAudioHelper, findScreenTool } from './paths.ts';
import { deepMerge, log } from './util.ts';
import { WhisperServer } from './asr/whisper.ts';
import { MODEL_CATALOG, ModelDownloader, benchmark, hardware, isInstalled, recommendModel } from './asr/models.ts';
import { ProviderRegistry } from './ai/registry.ts';
import { Assistant, publicOutput, type CatchupScope, type Selection } from './ai/assistant.ts';
import { SessionManager, publicFrame } from './session/manager.ts';
import { listWindows, requestScreenPermission, screenPermission } from './screen/watcher.ts';
import { HotkeyAgent } from './hotkey.ts';
import { MybotExporter } from './integrations/mybot.ts';
import { exportSession } from './export.ts';
import { checkPermissions, listDevices } from './audio/capture.ts';
import { storeKey, deleteKey } from './ai/anthropic-api.ts';
import type { ClaudeCliProvider } from './ai/claude-cli.ts';
import { EFFORTS, SOURCE_NAMES, normalizeLanguage, type Depth, type Effort, type Profile, type Settings } from './settings.ts';

ensureDirs();
const PORT = Number(process.env.PORT || 4777);
const HOST = '127.0.0.1';
const DEV = !!process.env.CHUMI_DEV;

const store = new Store();
store.failStaleOutputs();
const settings0 = store.getSettings();
const whisper = new WhisperServer({ model: settings0.asr.model, threads: settings0.asr.threads });
const registry = new ProviderRegistry(store);
const downloader = new ModelDownloader();

// ---------------------------------------------------------------- server-sent events
const clients = new Set<ServerResponse>();
function broadcast(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
const assistant = new Assistant(store, registry, broadcast);
const manager = new SessionManager(store, whisper, assistant, broadcast);
assistant.visual = manager;
manager.recoverOnBoot();

// mybot export: refresh a session's JSONL when it ends, gets its summary or Q&A, is renamed; remove it on delete.
const mybot = new MybotExporter(store);
const syncMybot = (id: string) => { try { mybot.sync(id); } catch (e) { log('mybot', `export failed: ${(e as Error).message}`); } };
assistant.onOutputDone = (row) => { if (row.kind !== 'digest' && row.kind !== 'overview') syncMybot(row.session_id); };

// ---------------------------------------------------------------- quick start (button + global shortcut)
const hotkey = new HotkeyAgent();
hotkey.on('state', () => broadcast('hotkey', hotkeyState()));
const hotkeyState = () => ({ state: hotkey.state, shortcut: hotkey.shortcut, message: hotkey.message });

function macNotify(text: string): void {
  if (!store.getSettings().quickStart.notify) return;
  const esc = (x: string) => x.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('/usr/bin/osascript', ['-e', `display notification "${esc(text)}" with title "Chumi"`], () => {});
}

async function quickStart(): Promise<void> {
  const st = store.getSettings();
  const source = st.quickStart.source === 'default' ? st.audio.source : st.quickStart.source;
  const when = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  await manager.start({ title: `Quick session · ${when}`, type: st.quickStart.type, source });
}

/** Shortcut: idle → start listening; recording → pause; paused → resume. Ending is always a deliberate click. */
async function onShortcut(): Promise<void> {
  const key = hotkey.shortcut || 'the shortcut';
  try {
    if (manager.status === 'idle') {
      await quickStart();
      const src = manager.source;
      macNotify(`Listening (${SOURCE_NAMES[src] ?? src}). Press ${key} to pause.`);
      broadcast('notice', { level: 'info', code: 'quick_start', message: `Quick start: listening (${SOURCE_NAMES[src] ?? src}). Rename the session or change its type in the top bar.` });
    } else if (manager.status === 'recording') {
      await manager.pause();
      macNotify(`Paused. Press ${key} to resume.`);
    } else if (manager.status === 'paused') {
      await manager.resume();
      macNotify('Listening again.');
    }
  } catch (e) {
    macNotify(`Could not start: ${(e as Error).message}`);
    broadcast('notice', { level: 'error', code: 'quick_start_failed', message: `Quick start failed: ${(e as Error).message}` });
  }
}
hotkey.on('pressed', () => void onShortcut());
// Test servers (acceptance runs) must not grab the shortcut from the real app.
if (!process.env.CHUMI_NO_HOTKEY) hotkey.configure(store.getSettings().quickStart.hotkey);
registry.onStatus = (s) => broadcast('provider', s);
whisper.on('state', (state, message) => broadcast('asr', { state, message }));
downloader.on('progress', (d) => broadcast('asr-download', d));

// ---------------------------------------------------------------- helpers
class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 2_000_000) throw new HttpError(413, 'Body too large'); chunks.push(c as Buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

function serveStatic(res: ServerResponse, pathname: string): void {
  if (!existsSync(WEB_DIST)) {
    send(res, 200, '<!doctype html><meta charset="utf-8"><title>Chumi</title><body style="font-family:system-ui;padding:40px"><h2>Chumi server is running</h2><p>The web interface has not been built yet. Run <code>npm run build:web</code>, then reload.</p></body>', { 'content-type': 'text/html; charset=utf-8' });
    return;
  }
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = resolve(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, 'index.html');
  const ext = extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable' });
  res.end(readFileSync(file));
}

function sessionDetail(id: string) {
  const s = store.getSession(id);
  if (!s) throw new HttpError(404, 'Session not found');
  return {
    session: s,
    segments: store.segments(id),
    timeline: store.timeline(id),
    outputs: store.outputs(id).filter((o) => o.kind !== 'digest' && o.status !== 'suppressed').map(publicOutput),
    frames: store.frames(id).map(publicFrame),
    live: manager.session?.id === id,
  };
}

let sysLang: 'en' | 'zh' | null = null;
/** macOS preferred language (WKWebView's navigator.language reflects the app bundle, not the user's choice). */
function systemLanguage(): 'en' | 'zh' {
  if (sysLang) return sysLang;
  let first = '';
  try { first = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2000 }).match(/"?([A-Za-z]{2,3}[-_A-Za-z]*)"?/)?.[1] ?? ''; } catch { /* not macOS or not set */ }
  if (!first) first = process.env.LANG ?? '';
  sysLang = first.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  return sysLang;
}

function samples(): Array<{ name: string; path: string; sizeMb: number }> {
  const dir = join(REPO_ROOT, 'samples');
  const out: Array<{ name: string; path: string; sizeMb: number }> = [];
  if (!existsSync(dir)) return out;
  for (const sub of readdirSync(dir)) {
    const d = join(dir, sub);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) if (f.endsWith('.wav')) out.push({ name: `${sub}/${f}`, path: join(d, f), sizeMb: Math.round(statSync(join(d, f)).size / 1e5) / 10 });
  }
  return out;
}

function applySettingsPatch(patch: Record<string, any>): Settings {
  const before = store.getSettings();
  const next = deepMerge(before, patch) as Settings;
  if (!['codex', 'claude-cli', 'anthropic-api', 'mock'].includes(next.ai.provider)) throw new HttpError(400, 'Unknown provider');
  if (next.ai.effort !== 'auto' && !EFFORTS.includes(next.ai.effort)) throw new HttpError(400, 'Unknown effort level');
  if (before.asr.model !== next.asr.model) {
    if (!isInstalled(next.asr.model)) throw new HttpError(400, 'Download this speech model first.');
    if (manager.status === 'recording' || manager.status === 'paused') throw new HttpError(409, 'End the current session before switching the speech model.');
  }
  if (!['auto', 'en', 'zh'].includes(next.ui.language)) throw new HttpError(400, 'Unknown interface language');
  if (!['simplified', 'original'].includes(next.asr.chineseScript)) throw new HttpError(400, 'Unknown Chinese script option');
  if (!['low', 'medium', 'high'].includes(next.ai.backgroundEffort)) throw new HttpError(400, 'Unknown background effort level');
  if (next.ai.provider === 'anthropic-api' && !next.ai.anthropicApi.enabled) throw new HttpError(400, 'Enable paid API access first (Settings → AI provider). It is off by default.');
  if (next.ai.provider === 'mock' && !next.devMode && !DEV) throw new HttpError(400, 'The offline test provider is only available in developer mode.');
  if (!next.ai.anthropicApi.enabled && next.ai.provider === 'anthropic-api') next.ai.provider = 'codex';
  store.saveSettings(next);
  if (before.assist.autoExplain !== next.assist.autoExplain) assistant.setAutoExplain(next.assist.autoExplain);
  if (before.asr.model !== next.asr.model || before.asr.threads !== next.asr.threads) whisper.configure({ model: next.asr.model, threads: next.asr.threads });
  if (before.quickStart.hotkey !== next.quickStart.hotkey && !process.env.CHUMI_NO_HOTKEY) hotkey.configure(next.quickStart.hotkey);
  if (next.integrations.mybot.enabled && (before.integrations.mybot.shareWithTeam !== next.integrations.mybot.shareWithTeam || !before.integrations.mybot.enabled || before.integrations.mybot.exportDir !== next.integrations.mybot.exportDir)) mybot.exportAll();
  if (before.ai.provider !== next.ai.provider || JSON.stringify(before.ai) !== JSON.stringify(next.ai)) void registry.status(true).catch(() => {});
  broadcast('settings', next);
  return next;
}

// ---------------------------------------------------------------- routes
type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => Promise<unknown> | unknown;
const routes: Array<{ method: string; re: RegExp; keys: string[]; h: Handler }> = [];
function route(method: string, path: string, h: Handler): void {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, h });
}

route('GET', '/api/health', () => ({ ok: true, app: 'chumi', version: '0.1.0' }));

route('GET', '/api/state', async () => ({
  settings: store.getSettings(),
  profile: store.getProfile(),
  live: manager.state(),
  provider: registry.cachedStatus() ?? await registry.status().catch(() => null),
  autoExplainEpoch: assistant.autoExplainEpoch,
  devMode: DEV || store.getSettings().devMode,
  helperBuilt: !!findAudioHelper(),
  hotkey: hotkeyState(),
  screenToolBuilt: !!findScreenTool(),
  appMode: !!process.env.CHUMI_APP,
  systemLanguage: systemLanguage(),
  dataDir: DATA_DIR,
  samples: (DEV || store.getSettings().devMode) ? samples() : [],
}));

route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(`event: hello\ndata: ${JSON.stringify({ live: manager.state() })}\n\n`);
  clients.add(res);
  const ka = setInterval(() => res.write(': keep-alive\n\n'), 20000);
  req.on('close', () => { clearInterval(ka); clients.delete(res); });
  return undefined;
});

route('POST', '/api/session/start', async (req) => {
  const b = await readJson(req);
  const source = b.source ?? store.getSettings().audio.source;
  if (source === 'file') {
    if (!(DEV || store.getSettings().devMode)) throw new HttpError(400, 'Audio-file input is a developer/test feature.');
    if (!b.filePath || !existsSync(b.filePath)) throw new HttpError(400, 'Audio file not found');
  } else if (!findAudioHelper()) throw new HttpError(400, 'The native audio helper is not built yet. Run "npm run build:native".');
  const win = b.window && Number.isFinite(Number(b.window.id)) ? { id: Number(b.window.id), title: String(b.window.title ?? ''), app: String(b.window.app ?? '') } : null;
  const s = await manager.start({ title: String(b.title ?? '').slice(0, 200), type: b.type ?? 'lab_meeting', source, filePath: b.filePath, speed: Math.min(16, Math.max(0.5, Number(b.speed ?? 1))), window: win });
  return { session: s };
});
route('POST', '/api/session/quick-start', async () => {
  if (manager.status !== 'idle') throw new HttpError(409, 'A session is already active.');
  if (!findAudioHelper()) throw new HttpError(400, 'The native audio helper is not built yet. Run "npm run build:native".');
  await quickStart();
  return { session: manager.session ? store.getSession(manager.session.id) : null };
});
route('POST', '/api/session/pause', async () => { await manager.pause(); return manager.state(); });
route('POST', '/api/session/resume', async () => { await manager.resume(); return manager.state(); });
route('POST', '/api/session/end', async () => { const r = await manager.end(); syncMybot(r.sessionId); return r; });
route('POST', '/api/session/window', async (req) => {
  const b = await readJson(req);
  if (!manager.session) throw new HttpError(400, 'No active session.');
  manager.setWindow(b.window && Number.isFinite(Number(b.window.id)) ? { id: Number(b.window.id), title: String(b.window.title ?? ''), app: String(b.window.app ?? '') } : null);
  return manager.state();
});

route('GET', '/api/screen/windows', async () => {
  const permission = await screenPermission();
  const r = await listWindows();
  return { permission, toolBuilt: !!findScreenTool(), ...r };
});
route('POST', '/api/screen/request', async () => ({ permission: await requestScreenPermission() }));
route('GET', '/api/frames/:id', (_req, res, p) => {
  const f = store.getFrame(Number(p.id));
  if (!f || !resolve(f.path).startsWith(FRAMES_DIR) || !existsSync(f.path)) throw new HttpError(404, 'Frame not found');
  res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' });
  res.end(readFileSync(f.path));
  return undefined;
});
route('POST', '/api/sessions/:id/resume', async (req, _res, p) => {
  const b = await readJson(req);
  if (b.source === 'file') {
    devOnly();
    if (!b.filePath || !existsSync(b.filePath)) throw new HttpError(400, 'Audio file not found');
  }
  await manager.resumeSession(p.id, b.source ?? store.getSettings().audio.source, b.source === 'file' ? { path: b.filePath, speed: Number(b.speed ?? 1) } : undefined);
  return manager.state();
});

route('GET', '/api/sessions', (_req, _res, _p, url) => ({ sessions: store.listSessions(url.searchParams.get('q') ?? undefined) }));
route('GET', '/api/sessions/:id', (_req, _res, p) => sessionDetail(p.id));
route('PATCH', '/api/sessions/:id', async (req, _res, p) => {
  const b = await readJson(req);
  const patch: Record<string, string> = {};
  if (typeof b.title === 'string') patch.title = b.title.slice(0, 200);
  if (typeof b.type === 'string') patch.type = b.type;
  store.updateSession(p.id, patch);
  syncMybot(p.id);
  broadcast('session-updated', store.getSession(p.id));
  return { session: store.getSession(p.id) };
});
route('DELETE', '/api/sessions/:id', (_req, _res, p) => {
  if (manager.session?.id === p.id) throw new HttpError(409, 'End the session before deleting it.');
  store.deleteSession(p.id);
  for (const dir of [join(FRAMES_DIR, p.id), join(AUDIO_DIR, p.id)]) rmSync(dir, { recursive: true, force: true });
  mybot.remove(p.id);
  return { ok: true };
});
route('GET', '/api/sessions/:id/export', (_req, res, p, url) => {
  const fmt = url.searchParams.get('format') === 'txt' ? 'txt' : 'md';
  const e = exportSession(store, p.id, fmt);
  res.writeHead(200, { 'content-type': e.mime, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(e.filename)}`, 'cache-control': 'no-store' });
  res.end(e.body);
  return undefined;
});

const needSession = (id: unknown): string => { if (typeof id !== 'string' || !store.getSession(id)) throw new HttpError(400, 'Unknown session'); return id; };
const effortOf = (e: unknown): Effort | 'auto' | null => (EFFORTS.includes(e as Effort) || e === 'auto' ? (e as Effort | 'auto') : null);
const depthOf = (d: unknown): Depth => (d === 'quick' || d === 'deep' || d === 'standard' ? d : store.getSettings().assist.defaultDepth);
const selOf = (s: any): Selection | null => (s && typeof s.text === 'string' && Number.isFinite(s.fromT) ? { fromT: Number(s.fromT), toT: Number(s.toT ?? s.fromT), text: String(s.text).slice(0, 4000) } : null);

route('POST', '/api/ai/catchup', async (req) => {
  const b = await readJson(req);
  const scope: CatchupScope = ['2m', '5m', 'all'].includes(b.scope) ? b.scope : '2m';
  return { id: assistant.catchup(needSession(b.sessionId), scope, undefined, effortOf(b.effort)) };
});
route('POST', '/api/ai/ask', async (req) => {
  const b = await readJson(req);
  if (!b.question || typeof b.question !== 'string') throw new HttpError(400, 'Question required');
  const frameIds = Array.isArray(b.frameIds) ? b.frameIds.map(Number).filter(Number.isFinite).slice(0, 3) : [];
  return { id: assistant.ask(needSession(b.sessionId), b.question.slice(0, 2000), selOf(b.selection), depthOf(b.depth), frameIds, effortOf(b.effort)) };
});
route('POST', '/api/ai/explain', async (req) => {
  const b = await readJson(req);
  if (!b.term || typeof b.term !== 'string') throw new HttpError(400, 'Term required');
  return { id: assistant.explain(needSession(b.sessionId), b.term.slice(0, 300), selOf(b.selection), depthOf(b.depth), b.parentId, effortOf(b.effort)) };
});
route('POST', '/api/ai/recap', async (req) => { const b = await readJson(req); return { id: assistant.overview(needSession(b.sessionId), true) }; });
route('POST', '/api/ai/summary', async (req) => { const b = await readJson(req); return { id: assistant.summary(needSession(b.sessionId), effortOf(b.effort)) }; });
route('POST', '/api/ai/outputs/:id/refresh', (_req, _res, p) => { const id = assistant.refresh(p.id); if (!id) throw new HttpError(404, 'Cannot refresh'); return { id }; });
route('POST', '/api/ai/outputs/:id/cancel', (_req, _res, p) => ({ ok: assistant.cancel(p.id) }));

route('GET', '/api/integrations/mybot', () => mybot.status());
route('POST', '/api/integrations/mybot/export-all', () => mybot.exportAll());
route('GET', '/api/asr/models', () => {
  const active = store.getSettings().asr.model;
  return {
    hardware: hardware(), recommended: recommendModel(), active,
    models: MODEL_CATALOG.map((m) => ({ ...m, installed: isInstalled(m.id), active: m.id === active })),
    download: downloader.current,
  };
});
route('POST', '/api/asr/models/:id/download', (_req, _res, p) => {
  if (!MODEL_CATALOG.some((m) => m.id === p.id)) throw new HttpError(404, 'Unknown model');
  void downloader.start(p.id).catch((e) => log('asr', `download failed: ${(e as Error).message}`));
  return { started: true };
});
route('POST', '/api/asr/models/:id/cancel', () => { downloader.cancel(); return { ok: true }; });
route('DELETE', '/api/asr/models/:id', (_req, _res, p) => {
  if (!MODEL_CATALOG.some((m) => m.id === p.id)) throw new HttpError(404, 'Unknown model');
  if (store.getSettings().asr.model === p.id) throw new HttpError(409, 'This model is in use. Switch to another model first.');
  rmSync(join(MODELS_DIR, p.id), { force: true });
  return { ok: true };
});
route('POST', '/api/asr/benchmark', async () => {
  if (manager.status === 'recording') throw new HttpError(409, 'Pause or end the session first; the test would compete with live transcription.');
  return { model: store.getSettings().asr.model, results: await benchmark(whisper) };
});
route('GET', '/api/settings', () => store.getSettings());
route('PUT', '/api/settings', async (req) => applySettingsPatch(await readJson(req)));
route('GET', '/api/profile', () => store.getProfile());
route('PUT', '/api/profile', async (req) => {
  const b = await readJson(req) as Partial<Profile>;
  const cur = store.getProfile();
  const next: Profile = {
    background: String(b.background ?? cur.background), researchInterests: String(b.researchInterests ?? cur.researchInterests),
    domains: Array.isArray(b.domains) ? b.domains.filter((d) => d && d.name).map((d) => ({ name: String(d.name).slice(0, 120), level: Math.max(0, Math.min(4, Number(d.level) || 0)) as 0 | 1 | 2 | 3 | 4, notes: d.notes ? String(d.notes).slice(0, 300) : undefined })) : cur.domains,
    knownConcepts: Array.isArray(b.knownConcepts) ? b.knownConcepts.map(String).filter(Boolean).slice(0, 300) : cur.knownConcepts,
    needsBackground: Array.isArray(b.needsBackground) ? b.needsBackground.map(String).filter(Boolean).slice(0, 300) : cur.needsBackground,
    explanationLanguage: normalizeLanguage(b.explanationLanguage ?? cur.explanationLanguage), keepEnglishTerms: b.keepEnglishTerms ?? cur.keepEnglishTerms,
    style: String(b.style ?? cur.style),
  };
  store.saveProfile(next);
  broadcast('profile', next);
  return next;
});

route('GET', '/api/provider/status', async (_req, _res, _p, url) => registry.status(url.searchParams.get('refresh') === '1'));
route('POST', '/api/provider/anthropic-key', async (req) => { const b = await readJson(req); await storeKey(String(b.key ?? '').trim()); return registry.status(true); });
route('DELETE', '/api/provider/anthropic-key', async () => { await deleteKey(); return registry.status(true); });
route('POST', '/api/provider/claude/clear-overage', async () => { (registry.providers['claude-cli'] as ClaudeCliProvider).clearOverageBlock(); return registry.status(true); });

route('GET', '/api/audio/devices', async () => ({ devices: await listDevices() }));
route('GET', '/api/audio/permissions', async () => checkPermissions());
route('POST', '/api/audio/request-mic', async () => {
  const helper = findAudioHelper();
  if (!helper) throw new HttpError(400, 'Audio helper not built');
  return new Promise((r) => execFile(helper, ['--request-mic'], { timeout: 60000 }, (_e, out) => { try { r(JSON.parse(out)); } catch { r({ microphone: 'unknown' }); } }));
});
route('POST', '/api/audio/open-settings', async (req) => {
  const b = await readJson(req);
  const anchor = b.pane === 'audio-capture' ? 'Privacy_AudioCapture' : b.pane === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Microphone';
  execFile('/usr/bin/open', [`x-apple.systempreferences:com.apple.preference.security?${anchor}`]);
  return { ok: true };
});

// Developer / acceptance-test hooks (only with CHUMI_DEV=1 or devMode)
const devOnly = () => { if (!(DEV || store.getSettings().devMode)) throw new HttpError(403, 'Developer mode only'); };
route('POST', '/api/dev/mock', async (req) => { devOnly(); const b = await readJson(req); registry.mock.failMode = b.failMode ?? null; if (b.delayMs != null) registry.mock.delayMs = Number(b.delayMs); return registry.status(true); });
route('POST', '/api/dev/auto-explain/force', async (req) => { devOnly(); const b = await readJson(req); return { started: assistant.maybeAutoExplain(needSession(b.sessionId), true) }; });
route('POST', '/api/dev/inject-frame', async (req) => {
  devOnly();
  const b = await readJson(req);
  const sid = needSession(b.sessionId);
  if (!b.path || !existsSync(b.path)) throw new HttpError(400, 'Image not found');
  mkdirSync(join(FRAMES_DIR, sid), { recursive: true });
  const dest = join(FRAMES_DIR, sid, `injected-${Date.now()}.jpg`);
  copyFileSync(b.path, dest);
  const f = store.addFrame({ session_id: sid, t: Number(b.t ?? manager.nowT()), path: dest, width: null, height: null, kind: 'slide', window_title: 'Injected test frame', app: 'test' });
  broadcast('frame', publicFrame(f));
  return publicFrame(f);
});
route('POST', '/api/dev/hotkey', async () => { devOnly(); await onShortcut(); return manager.state(); });
route('GET', '/api/dev/stats', () => { devOnly(); return { assistant: assistant.stats, mockCalls: registry.mock.calls.length, live: manager.state() }; });
route('GET', '/api/dev/mock-calls', () => { devOnly(); return registry.mock.calls.slice(-20).map((c) => ({ task: c.task, instructions: c.instructions, input: c.input, effort: c.effort })); });

// ---------------------------------------------------------------- server
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const server = createServer(async (req, res) => {
  try {
    // Defend against DNS-rebinding and cross-site requests: local host names only, and a custom header on writes.
    if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, { error: 'Forbidden host' });
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
    if (req.method !== 'GET' && req.headers['x-chumi'] !== '1') return send(res, 403, { error: 'Missing X-Chumi header' });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.h(req, res, params, url);
      if (out !== undefined && !res.headersSent) send(res, 200, out);
      return;
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) log('http', (e as Error).stack ?? e);
    if (!res.headersSent) send(res, status, { error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  log('server', `Chumi listening on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
  void whisper.ensure().catch((e) => log('asr', `not ready: ${(e as Error).message}`));
  void registry.status(true).catch(() => {});
});
setInterval(() => { void registry.status(true).catch(() => {}); }, 90_000).unref();

let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('server', `${sig}: shutting down`);
  // Keep everything captured so far; the session is marked "interrupted" and can be resumed (with a gap marker).
  try { await Promise.race([manager.suspendForShutdown().catch(() => {}), new Promise((r) => setTimeout(r, 6000))]); } catch { /* ignore */ }
  server.close();
  hotkey.stop();
  await Promise.race([Promise.all([whisper.stop(), registry.shutdown()]), new Promise((r) => setTimeout(r, 3000))]);
  store.close();
  process.exit(0);
}
// A live recording must survive unexpected bugs: log them, tell the UI, keep running.
// (Transcript segments are already persisted, so state on disk stays consistent.)
process.on('uncaughtException', (e) => {
  log('server', `uncaught exception: ${e.stack ?? e}`);
  broadcast('notice', { level: 'error', code: 'internal_error', message: `Internal error (logged; recording continues): ${e.message}` });
});
process.on('unhandledRejection', (e) => { log('server', `unhandled rejection: ${(e as Error)?.stack ?? e}`); });
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
