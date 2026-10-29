import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store, speakerFields } from './db.ts';
import { AUDIO_DIR, DATA_DIR, FRAMES_DIR, REPO_ROOT, WEB_DIST, ensureDirs, findAudioHelper, findScreenTool, which } from './paths.ts';
import { crossSiteSource, deepMerge, log, uid } from './util.ts';
import { WhisperServer } from './asr/whisper.ts';
import { SpeechService } from './asr/speech.ts';
import { defaultLocalEngine, ENGINE_NAMES, isSherpaEngine, isKeyedEngine, isSpeechEngine, normalizeLocalAsrUrl, normalizeQwenCloudUrl, speechModelId } from './asr/engines.ts';
import { normalizeModelBaseUrl } from '../shared/model-source.ts';
import { MODEL_CATALOG, ModelDownloader, benchmark, hardware, hasPartialModel, isInstalled, sherpaModelId } from './asr/models.ts';
import { ProviderRegistry } from './ai/registry.ts';
import { Assistant, publicOutput, type CatchupScope, type Selection } from './ai/assistant.ts';
import { SessionManager, publicFrame } from './session/manager.ts';
import { exportRecording, playbackInfo, recordingBytes, sessionRecording, type Recording } from './session/recording.ts';
import { listWindows, requestScreenPermission, screenPermission } from './screen/watcher.ts';
import { localize, sessionTitle, systemLanguage } from './i18n.ts';
import type { MessageVars } from '../shared/messages.ts';
import { HotkeyAgent } from './hotkey.ts';
import { exportMybotSessions, validateMybotDirectory } from './mybot-export.ts';
import { MybotExporter } from './integrations/mybot.ts';
import { MybotContext } from './integrations/mybot-context.ts';
import { HandoffError, HandoffService } from './projects/handoff.ts';
import { AgentChecks } from './agent-checks.ts';
import { AGENTS, AgentIntegration, type AgentId } from './projects/agents.ts';
import { AGENT_BILLING, AGENT_NAMES } from '../shared/agents.ts';
import { chooseApp, chooseFolder, IS_WIN, notify, openExternalUrl, openPrivacySettings } from './platform.ts';
import { chumiLink, SERVER_INFO, workspaceExists } from './projects/evidence.ts';
import { exportName, exportSession } from './export.ts';
import { audioHelperArgs, checkPermissions, listDevices } from './audio/capture.ts';
import { readKey, storeKey, deleteKey } from './ai/anthropic-api.ts';
import { readCompatibleKey, storeCompatibleKey, deleteCompatibleKey } from './ai/compatible-credentials.ts';
import { discoverLocalModels } from './ai/local-models.ts';
import { localHardware } from './ai/local-hardware.ts';
import { LocalModelDownloader } from './ai/local-model-download.ts';
import { isCompatiblePreset, normalizeCompatibleUrl, validateCompatibleSettings, COMPATIBLE_PRESETS } from '../shared/compatible-provider.ts';
import type { ClaudeCliProvider } from './ai/claude-cli.ts';
import type { CodexProvider } from './ai/codex.ts';
import { ASR_THREAD_LIMIT, EFFORTS, PET_TAGS, SOURCE_NAMES, isProviderId, normalizeLanguage, type Depth, type Effort, type Profile, type Settings } from './settings.ts';
import { SpeakerService } from './speakers/service.ts';
import { speakerRuntime } from './speakers/runtime.ts';
import { discardSpeakerAudio, hasRecordedAudio, speakerAudioAvailable } from './speakers/audio.ts';
import type { SpeakerCorrection } from '../shared/speakers.ts';
import { loadMobileConfiguration } from './mobile-config.ts';
import { startMobileServer } from './mobile/server.ts';
import { DESKTOP } from './desktop.ts';
import { acquireDataDirectoryLock } from './instance-lock.ts';
import { speechEngineChanged, speechRestartRequired } from './asr/settings-guard.ts';
import { finishShutdown, SHUTDOWN_GRACE_MS } from './shutdown.ts';
import { quitCheck } from './quit-check.ts';
import { ProjectWorkService, ProjectWorkError } from './projects/work.ts';
import { continueInDeepSeekHarness, launchCodexDesktop } from './projects/desktop-handoff.ts';
import { rememberDshApp } from './projects/dsh.ts';

const PORT = Number(process.env.PORT || 4777);
const HOST = '127.0.0.1';
const DEV = !!process.env.CHUMI_DEV;
/** Dev only, for recordings and trials: Continue does everything except the OS open (Terminal, Codex app) and logs it. */
const NO_LAUNCH = DEV && process.env.CHUMI_NO_LAUNCH === '1';
// The existing desktop listener stays loopback-only. Mobile access is a separate opt-in TLS gateway.
let mobileServer: Awaited<ReturnType<typeof startMobileServer>> | null = null;
let mobileStartNotice: { level: 'error'; code: 'mobile_start_failed'; message: string } | null = null;

// Reserve both the data folder and the port before any crash recovery can change stored meetings.
const dataLock = acquireDataDirectoryLock(DATA_DIR);
process.once('exit', () => dataLock.release());
const server = createServer();
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => { server.off('error', reject); resolve(); });
  });
} catch (error) {
  dataLock.release();
  throw error;
}
ensureDirs();
const store = new Store();
store.failStaleOutputs();
const settings0 = store.getSettings();
const whisper = new WhisperServer({ model: settings0.asr.model, threads: settings0.asr.threads });
/** Local Whisper can stand in for a speech service only when its program and the chosen model are installed. */
const whisperUsable = () => !!which('whisper-server') && isInstalled(store.getSettings().asr.model);
const speech = new SpeechService(whisper, () => store.getSettings().asr, whisperUsable);
const registry = new ProviderRegistry(store);
const downloader = new ModelDownloader(() => store.getSettings().asr.modelBaseUrl);
const localModelDownloader = new LocalModelDownloader({
  hardware: () => localHardware(store.getSettings().asr.model), stateFile: join(DATA_DIR, 'local-model-download.json'),
});
localModelDownloader.restore();

// ---------------------------------------------------------------- server-sent events
const clients = new Set<ServerResponse>();
function broadcast(event: string, data: unknown): void {
  if (DESKTOP && event === 'live') process.send!({ type: 'desktop-state', status: (data as { status: string }).status });
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
const assistant = new Assistant(store, registry, broadcast);
const manager = new SessionManager(store, speech, assistant, broadcast);
assistant.visual = manager;
assistant.clock = (id) => (manager.session?.id === id ? manager.nowT() : null);
manager.recoverOnBoot();

// mybot export: refresh a session's JSONL when it ends, gets its summary or Q&A, is renamed; remove it on delete.
const mybot = new MybotExporter(store);
const mybotExportFailed = (error: unknown) => {
  log('mybot', `export failed: ${(error as Error).message}`);
  broadcast('notice', { level: 'warning', code: 'mybot_export_failed', message: 'mybot export failed. Check the export folder and try again; your meetings and settings are saved in Chumi.' });
};
const syncMybot = (id: string) => { try { mybot.sync(id); } catch (e) { mybotExportFailed(e); } };
manager.onEnded = syncMybot;
// Project context for questions: searches a running mybot for the project's earlier agent sessions (only when turned on).
const projectContext = new MybotContext(store);
assistant.projectContext = (id, query, signal) => projectContext.forSession(id, query, signal);
assistant.onOutputDone = (row) => { if (row.kind !== 'digest' && row.kind !== 'overview' && row.kind !== 'handoff') syncMybot(row.session_id); };

// Projects and reviewed handoffs to Claude Code / Codex (docs/project-integration-prd.md).
const handoffs = new HandoffService(store, assistant, (sessionId) => { broadcast('handoff', { sessionId, handoff: handoffs.view(sessionId) }); syncMybot(sessionId); });
const agents = new AgentIntegration(store);
const agentChecks = new AgentChecks(agents);
const projectWork = new ProjectWorkService(store);
const speakers = new SpeakerService(store, (id) => {
  broadcast('speakers', speakerUpdate(id));
  syncMybot(id);
});
speakers.recover();
manager.beforeResume = (id) => speakers.cancel(id);
manager.beforeSummary = (id) => {
  if (!store.getSettings().asr.diarization || !speakerAudioAvailable(id)) {
    discardSpeakerAudio(id); // Includes unfinished/corrupt temporary takes that cannot be retried.
    return null;
  }
  try { return speakers.analyze(id); }
  catch (error) {
    store.setSpeakerAnalysis(id, { status: 'failed', generation: null, error: (error as Error).message, updated_at: Date.now() });
    discardSpeakerAudio(id);
    broadcast('speakers', speakerUpdate(id));
    return null;
  }
};

// ---------------------------------------------------------------- quick start (button + global shortcut)
const hotkey = new HotkeyAgent();
hotkey.on('state', () => broadcast('hotkey', hotkeyState()));
const hotkeyState = () => ({ state: hotkey.state, shortcut: hotkey.shortcut, message: hotkey.message });

function macNotify(key: string, vars?: MessageVars): void {
  const settings = store.getSettings();
  if (settings.quickStart.notify) notify(localize(settings.ui.language, key, vars));
}

async function quickStart(): Promise<void> {
  const st = store.getSettings();
  const source = st.quickStart.source === 'default' ? st.audio.source : st.quickStart.source;
  await manager.start({ title: sessionTitle(st.ui.language, true), type: st.quickStart.type, source });
}

/** Shortcut: idle → start listening; recording → pause; paused → resume. Ending is always a deliberate click. */
async function onShortcut(): Promise<void> {
  const key = hotkey.shortcut || localize(store.getSettings().ui.language, 'the shortcut');
  try {
    if (manager.status === 'starting' || manager.status === 'ending') {
      const message = manager.status === 'starting' ? 'Chumi is still starting speech recognition. Please wait a moment.' : 'Chumi is still saving the previous meeting. Try again in a moment.';
      macNotify(message);
      broadcast('notice', { level: 'info', code: 'quick_start_busy', message });
    } else if (manager.status === 'idle') {
      await quickStart();
      const src = manager.source;
      macNotify('Listening ({source}). Press {key} to pause.', { source: SOURCE_NAMES[src] ?? src, key });
      broadcast('notice', { level: 'info', code: 'quick_start', message: 'Quick start: listening ({source}). Rename the session or change its type in the top bar.', vars: { source: SOURCE_NAMES[src] ?? src } });
    } else if (manager.status === 'recording') {
      await manager.pause();
      macNotify('Paused. Press {key} to resume.', { key });
    } else if (manager.status === 'paused') {
      await manager.resume();
      macNotify('Listening again.');
    }
  } catch (e) {
    macNotify('Could not start. Open Chumi for details.');
    broadcast('notice', { level: 'error', code: 'quick_start_failed', message: 'Quick start failed: {error}', vars: { error: (e as Error).message } });
  }
}
hotkey.on('pressed', () => void onShortcut());
if (DESKTOP) process.on('message', (message: any) => { if (message?.type === 'desktop-shortcut') void onShortcut(); });
// Test servers (acceptance runs) must not grab the shortcut from the real app.
if (!process.env.CHUMI_NO_HOTKEY) hotkey.configure(store.getSettings().quickStart.hotkey);
registry.onStatus = (s) => broadcast('provider', s);
speech.on('state', (state, message) => broadcast('asr', { state, message }));
speech.on('fallback', (message) => broadcast('notice', { level: 'warning', code: 'asr_fallback', message }));
downloader.on('progress', (d) => {
  broadcast('asr-download', d);
  if (d.status === 'done' && (MODEL_CATALOG.some((m) => m.id === d.id && m.engine) || d.id === store.getSettings().asr.model)) void speech.ensure().catch((e) => log('asr', (e as Error).message));
});

// ---------------------------------------------------------------- helpers
class HttpError extends Error { status: number; vars?: MessageVars; constructor(status: number, msg: string, vars?: MessageVars) { super(msg); this.status = status; this.vars = vars; } }

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
// The interface shows AI answers and transcript text as HTML (escaped in web/src/util.ts). Should markup ever get through,
// the page still runs only its own scripts, loads nothing from other hosts and can't be framed by another site.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function serveStatic(res: ServerResponse, pathname: string): void {
  if (!existsSync(WEB_DIST)) {
    send(res, 200, '<!doctype html><meta charset="utf-8"><title>Chumi</title><body style="font-family:system-ui;padding:40px"><h2>Chumi server is running</h2><p>The web interface has not been built yet. Run <code>npm run build:web</code>, then reload.</p></body>', { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP });
    return;
  }
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = resolve(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, 'index.html');
  const ext = extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable', ...(ext === '.html' ? { 'content-security-policy': CSP } : {}) });
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
    handoff: handoffs.view(id),
    speakerView: speakers.view(id),
    hasAudio: hasRecordedAudio(id),
  };
}

/** Speaker changes, compactly: annotations of analysed lines and each output's staleness, not the whole meeting. */
function speakerUpdate(id: string) {
  return { sessionId: id, speakerView: speakers.view(id), session: store.getSession(id), handoff: handoffs.view(id),
    annotations: store.segments(id).filter((s) => s.speaker_state).map((s) => ({ id: s.id, ...speakerFields(s) })),
    stale: Object.fromEntries(store.outputs(id).filter((o) => o.kind !== 'digest' && o.status !== 'suppressed').map((o) => [o.id, o.stale_reason ?? null])) };
}

// First run: a fresh install starts with an empty profile in the system language (the checklist on Home asks for it).
store.ensureProfile(systemLanguage());

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
  if (patch.asr?.threads !== undefined && (!Number.isInteger(next.asr.threads) || next.asr.threads < 2 || next.asr.threads > ASR_THREAD_LIMIT)) throw new HttpError(400, 'CPU threads must be a whole number between 2 and the smaller of 16 or the number of CPU cores.');
  if (patch.asr?.modelBaseUrl !== undefined) {
    try { next.asr.modelBaseUrl = normalizeModelBaseUrl(patch.asr.modelBaseUrl); } catch (error) { throw new HttpError(400, (error as Error).message); }
  }
  if (patch.asr?.engine !== undefined) next.asr.engineSelected = true;
  if (!isProviderId(next.ai.provider)) throw new HttpError(400, 'Unknown provider');
  // Only a patch that edits the profiles can be rejected for them; a stale saved profile must not block other settings.
  try { next.ai.compatible = validateCompatibleSettings(next.ai.compatible); }
  catch (error) {
    if (patch.ai?.compatible !== undefined) throw new HttpError(400, (error as Error).message);
    next.ai.compatible = before.ai.compatible;
  }
  if (next.ai.effort !== 'auto' && !EFFORTS.includes(next.ai.effort)) throw new HttpError(400, 'Unknown effort level');
  if (before.asr.model !== next.asr.model) {
    if (MODEL_CATALOG.some((m) => m.id === next.asr.model && m.engine) || !isInstalled(next.asr.model)) throw new HttpError(400, 'Download this speech model first.');
  }
  if (!['auto', 'en', 'zh'].includes(next.ui.language)) throw new HttpError(400, 'Unknown interface language');
  if (typeof next.ui.setupDismissed !== 'boolean') throw new HttpError(400, 'Invalid setup checklist setting');
  const pet = next.pet, inList = (list: unknown, allowed: readonly string[]) => Array.isArray(list) && list.every((v) => allowed.includes(v));
  if (![pet.enabled, pet.toolbar, pet.inRecordings].every((v) => typeof v === 'boolean') || !(Number.isFinite(pet.size) && pet.size >= 0.5 && pet.size <= 2)
    || !['none', 'latest', 'recent'].includes(pet.cards) || !inList(pet.tags, PET_TAGS) || !inList(pet.say, [...PET_TAGS, 'chatter'])) throw new HttpError(400, 'Invalid desktop pet setting');
  // Only the current fields, rounded to 5 %, so a field from an earlier version doesn't linger.
  next.pet = { enabled: pet.enabled, size: Math.round(pet.size * 20) / 20, toolbar: pet.toolbar, cards: pet.cards, tags: pet.tags, say: pet.say, inRecordings: pet.inRecordings };
  if (!/^https?:\/\/[^\s/]+(\/\S*)?$/.test(String(next.integrations.mybot.serverUrl))) throw new HttpError(400, 'The mybot address must start with http:// (for example http://127.0.0.1:8788).');
  if (!['simplified', 'original'].includes(next.asr.chineseScript)) throw new HttpError(400, 'Unknown Chinese script option');
  if (!isSpeechEngine(next.asr.engine)) throw new HttpError(400, 'Unknown speech recognition engine.');
  try {
    next.asr.qwenCloud = { baseUrl: normalizeQwenCloudUrl(next.asr.qwenCloud.baseUrl), model: speechModelId(next.asr.qwenCloud.model) };
    next.asr.qwenLocal = { baseUrl: normalizeLocalAsrUrl(next.asr.qwenLocal.baseUrl), model: speechModelId(next.asr.qwenLocal.model) };
  } catch (error) { throw new HttpError(400, (error as Error).message); }
  const speechChanged = speechEngineChanged(before.asr, next.asr);
  if (manager.status !== 'idle' && speechRestartRequired(before.asr, next.asr)) {
    throw new HttpError(409, 'Wait until recording and transcription finish before changing speech recognition settings.');
  }
  if (typeof next.asr.diarization !== 'boolean') throw new HttpError(400, 'Speaker labeling must be enabled or disabled.');
  if (before.asr.diarization !== next.asr.diarization) {
    if (manager.status !== 'idle') throw new HttpError(409, 'End the current session before changing speaker labeling.');
    if (next.asr.diarization && !speakerRuntime().ready) throw new HttpError(400, speakerRuntime().reason ?? 'Set up the local speaker models first.');
  }
  if (!['low', 'medium', 'high'].includes(next.ai.backgroundEffort)) throw new HttpError(400, 'Unknown background effort level');
  if (next.ai.provider === 'anthropic-api' && !next.ai.anthropicApi.enabled) throw new HttpError(400, 'Enable paid API access first (Settings → AI provider). It is off by default.');
  if (next.ai.provider === 'mock' && !next.devMode && !DEV) throw new HttpError(400, 'The offline test provider is only available in developer mode.');
  if (!next.ai.anthropicApi.enabled && next.ai.provider === 'anthropic-api') next.ai.provider = 'codex';
  if (patch.integrations?.mybot?.exportDir !== undefined || (!before.integrations.mybot.enabled && next.integrations.mybot.enabled)) {
    try { next.integrations.mybot.exportDir = validateMybotDirectory(next.integrations.mybot.exportDir); }
    catch (error) { throw new HttpError(400, (error as Error).message); }
  }
  try { Object.assign(next, store.saveSettings(next)); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  if (before.asr.model !== next.asr.model || before.asr.engine !== next.asr.engine) downloader.discardPartials();
  if (before.assist.autoExplain !== next.assist.autoExplain) assistant.setAutoExplain(next.assist.autoExplain);
  if (before.asr.model !== next.asr.model || before.asr.threads !== next.asr.threads) whisper.configure({ model: next.asr.model, threads: next.asr.threads });
  if (speechChanged || before.asr.threads !== next.asr.threads) speech.configure();
  if (before.quickStart.hotkey !== next.quickStart.hotkey && !process.env.CHUMI_NO_HOTKEY) hotkey.configure(next.quickStart.hotkey);
  if (before.ai.provider !== next.ai.provider || JSON.stringify(before.ai) !== JSON.stringify(next.ai)) void registry.status(true).catch(() => {});
  broadcast('settings', next);
  if (next.integrations.mybot.enabled && (before.integrations.mybot.shareWithTeam !== next.integrations.mybot.shareWithTeam || !before.integrations.mybot.enabled || before.integrations.mybot.exportDir !== next.integrations.mybot.exportDir)) void exportMybotSessions(store, mybot).then((result) => broadcast('mybot-exported', result)).catch(mybotExportFailed);
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
route('GET', '/api/quit-check', () => quitCheck(store, manager.status, manager.pendingSummaryCount));

route('GET', '/api/state', async () => {
  // Provider startup can take seconds. Read the live snapshot after it, so an early ASR-ready event isn't overwritten.
  const provider = registry.cachedStatus() ?? await registry.status().catch(() => null);
  return {
  settings: store.getSettings(),
  profile: store.getProfile(),
  live: manager.state(),
  provider,
  asrDownload: downloader.current,
  autoExplainEpoch: assistant.autoExplainEpoch,
  devMode: DEV || store.getSettings().devMode,
  helperBuilt: !!findAudioHelper(),
  platform: process.platform,
  hotkey: hotkeyState(),
  screenToolBuilt: DESKTOP || !!findScreenTool(),
  appMode: !!process.env.CHUMI_APP,
  systemLanguage: systemLanguage(),
  dataDir: DATA_DIR,
  samples: (DEV || store.getSettings().devMode) ? samples() : [],
  };
});

route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(`event: hello\ndata: ${JSON.stringify({ live: manager.state() })}\n\n`);
  if (mobileStartNotice) res.write(`event: notice\ndata: ${JSON.stringify(mobileStartNotice)}\n\n`);
  clients.add(res);
  const ka = setInterval(() => res.write(': keep-alive\n\n'), 20000);
  req.on('close', () => { clearInterval(ka); clients.delete(res); });
  return undefined;
});

route('POST', '/api/session/start', async (req) => {
  const b = await readJson(req);
  const options = store.getSettings().sessionTypes;
  const type = b.type ?? options.find((o) => !o.archived)?.id;
  if (!options.some((o) => o.id === type && !o.archived)) throw new HttpError(400, 'Choose an available session type.');
  const source = b.source ?? store.getSettings().audio.source;
  if (source === 'file') {
    if (!(DEV || store.getSettings().devMode)) throw new HttpError(400, 'Audio-file input is a developer/test feature.');
    if (!b.filePath || !existsSync(b.filePath)) throw new HttpError(400, 'Audio file not found');
  } else if (!findAudioHelper()) throw new HttpError(400, 'The native audio helper is not built yet. Run "npm run build:native".');
  const win = b.window && Number.isFinite(Number(b.window.id)) ? { id: Number(b.window.id), title: String(b.window.title ?? ''), app: String(b.window.app ?? '') } : null;
  const projectId = b.project_id ? String(b.project_id) : null;
  if (projectId && !store.getProject(projectId)) throw new HttpError(400, 'Unknown project');
  if (manager.status !== 'idle') throw new HttpError(409, 'A session is already active. End it first.');
  const recordAudio = typeof b.record_audio === 'boolean' ? b.record_audio : undefined;
  const s = await manager.start({ title: String(b.title ?? '').slice(0, 200), type, source, filePath: b.filePath, speed: Math.min(16, Math.max(0.5, Number(b.speed ?? 1))), window: win, projectId, recordAudio });
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
route('POST', '/api/session/end', () => manager.end());
route('POST', '/api/session/window', async (req) => {
  const b = await readJson(req);
  if (!manager.session) throw new HttpError(400, 'No active session.');
  manager.setWindow(b.window && Number.isFinite(Number(b.window.id)) ? { id: Number(b.window.id), title: String(b.window.title ?? ''), app: String(b.window.app ?? '') } : null);
  return manager.state();
});

route('GET', '/api/screen/windows', async () => {
  const permission = await screenPermission();
  const r = await listWindows();
  return { permission, toolBuilt: DESKTOP || !!findScreenTool(), ...r };
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
  if (store.getSession(p.id)?.audio_source === 'mobile') throw new HttpError(409, 'Continue this recording on its iPhone.');
  const b = await readJson(req);
  if (b.source === 'file') {
    devOnly();
    if (!b.filePath || !existsSync(b.filePath)) throw new HttpError(400, 'Audio file not found');
  }
  await manager.resumeSession(p.id, b.source ?? store.getSettings().audio.source, b.source === 'file' ? { path: b.filePath, speed: Number(b.speed ?? 1) } : undefined);
  return manager.state();
});

route('GET', '/api/sessions', (_req, _res, _p, url) => ({ sessions: store.listSessions(url.searchParams.get('q') ?? undefined, url.searchParams.get('project') || undefined).map((s) => ({ ...s, has_audio: hasRecordedAudio(s.id) })) }));
route('GET', '/api/sessions/:id', (_req, _res, p) => sessionDetail(p.id));
route('PATCH', '/api/sessions/:id', async (req, _res, p) => {
  const b = await readJson(req);
  if (!store.getSession(p.id)) throw new HttpError(404, 'Session not found');
  const patch: Record<string, string> = {};
  if (b.title !== undefined) {
    if (typeof b.title !== 'string' || !b.title.trim()) throw new HttpError(400, 'Give the session a title.');
    patch.title = b.title.trim().slice(0, 200).trimEnd();
  }
  if (typeof b.type === 'string') {
    if (b.type !== store.getSession(p.id)?.type && !store.getSettings().sessionTypes.some((o) => o.id === b.type && !o.archived)) throw new HttpError(400, 'Choose an available session type.');
    patch.type = b.type;
  }
  store.updateSession(p.id, patch);
  syncMybot(p.id);
  broadcast('session-updated', store.getSession(p.id));
  return { session: store.getSession(p.id) };
});
route('DELETE', '/api/sessions/:id', async (_req, _res, p) => {
  if (manager.session?.id === p.id) throw new HttpError(409, 'End the session before deleting it.');
  if (!store.getSession(p.id)) throw new HttpError(404, 'Session not found');
  manager.invalidateDeferredSummary(p.id);
  await speakers.cancel(p.id);
  if (manager.session?.id === p.id) throw new HttpError(409, 'End the session before deleting it.');
  assistant.cancelSession(p.id);
  store.deleteSession(p.id);
  broadcast('session-deleted', { id: p.id });
  const leftover: string[] = [];
  const cleanup = async (path: string, remove: () => void | Promise<void>) => {
    try { await remove(); }
    catch (error) { leftover.push(path); log('cleanup', `Could not delete ${path}: ${(error as Error).message}`); }
  };
  await cleanup(join(mybot.dir, `${p.id}.jsonl`), () => mybot.remove(p.id));
  for (const dir of [join(FRAMES_DIR, p.id), join(AUDIO_DIR, p.id)]) await cleanup(dir, () => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
  if (leftover.length) broadcast('notice', { level: 'warning', code: 'session_cleanup_failed', message: 'The session was deleted, but some files could not be removed: {paths}. Close any app using them and remove them manually.', vars: { paths: leftover.join(', ') } });
  return { ok: true };
});

// ---------------------------------------------------------------- recorded audio
function recordingOf(id: string): Recording {
  if (!store.getSession(id)) throw new HttpError(404, 'Session not found');
  if (manager.session?.id === id) throw new HttpError(409, 'End the session to play or export its audio.');
  let rec: Recording | null;
  try { rec = sessionRecording(id); }
  catch (error) { throw new HttpError(500, 'The audio recording cannot be read: {error}', { error: (error as Error).message }); }
  if (!rec) throw new HttpError(404, 'This session has no audio recording.');
  return rec;
}
/** The recording as a WAV, mixed on the fly; byte ranges let the player seek. */
async function sendRecording(req: IncomingMessage, res: ServerResponse, rec: Recording, headers: Record<string, string>): Promise<void> {
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  const partial = !!range && !!(range[1] || range[2]);
  let from = 0, to = rec.bytes;
  if (partial) {
    if (range[1]) { from = Number(range[1]); if (range[2]) to = Math.min(rec.bytes, Number(range[2]) + 1); }
    else from = Math.max(0, rec.bytes - Number(range[2]));
    if (from >= to) { res.writeHead(416, { 'content-range': `bytes */${rec.bytes}` }); res.end(); return; }
  }
  res.writeHead(partial ? 206 : 200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': String(to - from), ...(partial ? { 'content-range': `bytes ${from}-${to - 1}/${rec.bytes}` } : {}), ...headers });
  // The player routinely stops reading partway through a range.
  await pipeline(Readable.from(recordingBytes(rec, from, to)), res).catch(() => {});
}
route('GET', '/api/sessions/:id/audio/info', (_req, _res, p) => playbackInfo(recordingOf(p.id)));
// The URL carries the recording's version, so a resumed meeting's longer recording is never served from cache.
route('GET', '/api/sessions/:id/audio', async (req, res, p) => { await sendRecording(req, res, recordingOf(p.id), { 'cache-control': 'private, max-age=86400' }); return undefined; });
/** Prepares the download (AAC encoding can take a few seconds for a long meeting) so the UI can show progress. */
route('POST', '/api/sessions/:id/audio/export', async (_req, _res, p) => ({ ext: (await exportRecording(p.id, recordingOf(p.id))).ext }));
route('GET', '/api/sessions/:id/audio/export', async (req, res, p) => {
  const rec = recordingOf(p.id);
  const file = await exportRecording(p.id, rec);
  const headers = { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${exportName(store.getSession(p.id)!)}.${file.ext}`)}`, 'cache-control': 'no-store' };
  if (!file.path) { await sendRecording(req, res, rec, headers); return undefined; }
  // audio/x-m4a, not audio/mp4: WebKit (Chumi.app) renames a download to match its type, and audio/mp4 became .mp4.
  res.writeHead(200, { 'content-type': 'audio/x-m4a', 'content-length': String(statSync(file.path).size), ...headers });
  await pipeline(createReadStream(file.path), res).catch(() => {});
  return undefined;
});

route('GET', '/api/speakers/runtime', () => speakerRuntime());
route('GET', '/api/sessions/:id/speakers', (_req, _res, p) => {
  if (!store.getSession(p.id)) throw new HttpError(404, 'Session not found');
  return speakers.view(p.id);
});
route('POST', '/api/sessions/:id/speakers/analyze', (_req, _res, p) => {
  if (!store.getSession(p.id)) throw new HttpError(404, 'Session not found');
  if (manager.session?.id === p.id) throw new HttpError(409, 'End the session before analyzing speakers.');
  try { void speakers.analyze(p.id); }
  catch (error) { throw new HttpError(409, (error as Error).message); }
  return speakerUpdate(p.id);
});
route('POST', '/api/sessions/:id/speakers/cancel', async (_req, _res, p) => {
  if (!store.getSession(p.id)) throw new HttpError(404, 'Session not found');
  if (manager.session?.id === p.id) throw new HttpError(409, 'End the session before cancelling speaker analysis.');
  await speakers.cancel(p.id);
  return speakerUpdate(p.id);
});
route('PATCH', '/api/sessions/:id/speakers/:speakerId', async (req, _res, p) => {
  if (!store.getSession(p.id)) throw new HttpError(404, 'Session not found');
  const body = await readJson(req);
  if (body.name !== null && (typeof body.name !== 'string' || body.name.trim().length > 80)) throw new HttpError(400, 'Speaker names must be at most 80 characters.');
  try { store.renameSpeaker(p.id, p.speakerId, typeof body.name === 'string' ? body.name.trim() || null : null); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  const update = speakerUpdate(p.id); broadcast('speakers', update); syncMybot(p.id); return update;
});
route('PATCH', '/api/sessions/:id/segments/:segmentId/speaker', async (req, _res, p) => {
  if (!store.getSession(p.id)) throw new HttpError(404, 'Session not found');
  const body = await readJson(req);
  if (!['automatic', 'unknown', 'speaker'].includes(body.mode) || !Number.isSafeInteger(Number(p.segmentId))
    || (body.mode === 'speaker' && typeof body.speakerId !== 'string')) throw new HttpError(400, 'Invalid speaker correction.');
  const correction: SpeakerCorrection = body.mode === 'speaker' ? { mode: 'speaker', speakerId: body.speakerId } : { mode: body.mode };
  try { store.correctSegmentSpeaker(p.id, Number(p.segmentId), correction); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  const update = speakerUpdate(p.id); broadcast('speakers', update); syncMybot(p.id); return update;
});
// ---------------------------------------------------------------- projects
function gitInfo(dir: string): Promise<{ root: string; remote: string | null; branch: string | null } | null> {
  const git = (args: string[]) => new Promise<string | null>((r) => execFile('git', ['-C', dir, ...args], { timeout: 5000 }, (e, out) => r(e ? null : String(out).trim() || null)));
  return git(['rev-parse', '--show-toplevel']).then(async (root) => (root ? { root, remote: await git(['remote', 'get-url', 'origin']), branch: await git(['branch', '--show-current']) } : null));
}
function checkWorkspace(raw: unknown): string {
  const w = String(raw ?? '').trim().replace(/^~(?=\/|$)/, process.env.HOME ?? '~').replace(/\/+$/, '');
  if (!w || !isAbsolute(w)) throw new HttpError(400, 'Choose the project folder (a full path such as /Users/you/code/project).');
  if (!existsSync(w) || !statSync(w).isDirectory()) throw new HttpError(400, 'This folder does not exist: {path}', { path: w });
  return w;
}
const projectPublic = (p: ReturnType<typeof store.listProjects>[number]) => ({ ...p, repo: p.repo_json ? JSON.parse(p.repo_json) : null, repo_json: undefined, workspace_exists: workspaceExists(p) });
route('GET', '/api/projects', (_req, _res, _p, url) => ({ projects: store.listProjects(url.searchParams.get('archived') === '1').map(projectPublic) }));
route('GET', '/api/projects/:id/brief', (_req, _res, p) => projectWork.brief(p.id));
route('PATCH', '/api/projects/:id/agenda', async (req, _res, p) => {
  const agenda = projectWork.updateAgenda(p.id, await readJson(req));
  broadcast('project-work', { projectId: p.id });
  return { agenda };
});
route('POST', '/api/projects', async (req) => {
  const b = await readJson(req);
  const name = String(b.name ?? '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'Give the project a name.');
  const workspace = checkWorkspace(b.workspace);
  const repo = await gitInfo(workspace);
  const p = store.createProject({ id: uid('p_'), name, workspace, repo_json: repo ? JSON.stringify(repo) : null });
  broadcast('projects', {});
  return { project: projectPublic({ ...p, meeting_count: 0 }) };
});
route('PATCH', '/api/projects/:id', async (req, _res, p) => {
  const cur = store.getProject(p.id);
  if (!cur) throw new HttpError(404, 'Project not found');
  const b = await readJson(req);
  const patch: Parameters<typeof store.updateProject>[1] = {};
  if (typeof b.name === 'string') { const n = b.name.trim().slice(0, 80); if (!n) throw new HttpError(400, 'Give the project a name.'); patch.name = n; }
  if (b.workspace !== undefined) { patch.workspace = checkWorkspace(b.workspace); const repo = await gitInfo(patch.workspace); patch.repo_json = repo ? JSON.stringify(repo) : null; }
  if (typeof b.archived === 'boolean') patch.archived_at = b.archived ? Date.now() : null;
  store.updateProject(p.id, patch);
  if ((patch.name !== undefined && patch.name !== cur.name) || (patch.workspace !== undefined && patch.workspace !== cur.workspace)) {
    for (const session of store.listSessions(undefined, p.id).reverse()) syncMybot(session.id);
  }
  broadcast('projects', {});
  return { project: projectPublic({ ...store.getProject(p.id)!, meeting_count: 0 }) };
});
route('POST', '/api/projects/choose-folder', async () => {
  const out = await chooseFolder('Choose the project folder (where you run your coding agent)');
  return out ? { path: out } : { cancelled: true };
});
route('POST', '/api/sessions/:id/project', async (req, _res, p) => {
  if (!store.getSession(p.id)) throw new HttpError(404, 'Session not found');
  const b = await readJson(req);
  const projectId = b.project_id ? String(b.project_id) : null;
  if (projectId) { const pr = store.getProject(projectId); if (!pr || pr.archived_at) throw new HttpError(400, 'Unknown project'); }
  if (store.getSession(p.id)!.project_id !== projectId) store.assignSession(p.id, projectId);
  syncMybot(p.id);
  broadcast('session-updated', store.getSession(p.id));
  broadcast('handoff', { sessionId: p.id, handoff: handoffs.view(p.id) });
  return { session: store.getSession(p.id) };
});

// ---------------------------------------------------------------- reviewed handoff
route('GET', '/api/sessions/:id/handoff', (_req, _res, p) => ({ handoff: handoffs.view(p.id) }));
route('POST', '/api/sessions/:id/handoff', (_req, _res, p) => { handoffs.generate(p.id); return { handoff: handoffs.view(p.id) }; });
route('PATCH', '/api/handoff-items/:id/progress', async (req, _res, p) => {
  const result = projectWork.updateProgress(p.id, await readJson(req));
  const handoff = handoffs.view(result.sessionId);
  broadcast('handoff', { sessionId: result.sessionId, handoff });
  broadcast('project-work', { projectId: result.projectId });
  syncMybot(result.sessionId);
  return { ...result, handoff };
});
route('PATCH', '/api/handoff-items/:id', async (req, _res, p) => {
  const b = await readJson(req);
  const sid = handoffs.updateItem(p.id, {
    text: typeof b.text === 'string' ? b.text : undefined, rationale: b.rationale === undefined ? undefined : b.rationale,
    conditions: Array.isArray(b.conditions) ? b.conditions.map(String) : undefined, acceptance: Array.isArray(b.acceptance) ? b.acceptance.map(String) : undefined,
    owner: b.owner === undefined ? undefined : b.owner, due: b.due === undefined ? undefined : b.due, review: b.review, kind: b.kind,
  });
  return { handoff: handoffs.view(sid) };
});
const handoffSession = (id: string) => { const h = store.getHandoff(id); if (!h) throw new HttpError(404, 'Handoff not found'); return h.session_id; };
route('POST', '/api/handoffs/:id/items', async (req, _res, p) => { const b = await readJson(req); const sid = handoffs.addItem(p.id, b.kind, String(b.text ?? '')); return { handoff: handoffs.view(sid) }; });
route('POST', '/api/handoffs/:id/confirm', (_req, _res, p) => { handoffs.confirm(p.id); return { handoff: handoffs.view(handoffSession(p.id)) }; });
route('POST', '/api/handoffs/:id/reopen', (_req, _res, p) => { handoffs.reopen(p.id); return { handoff: handoffs.view(handoffSession(p.id)) }; });
route('POST', '/api/handoffs/:id/retarget', (_req, _res, p) => { handoffs.retarget(p.id); return { handoff: handoffs.view(handoffSession(p.id)) }; });
route('POST', '/api/handoffs/:id/continue', async (req, _res, p) => {
  const b = await readJson(req);
  const via = String(b.agent ?? 'copy');
  if (via !== 'copy' && via !== 'codex-app' && !AGENTS.includes(via as AgentId)) throw new HttpError(400, 'Unknown agent');
  const h = store.getHandoff(p.id);
  if (!h) throw new HttpError(404, 'Handoff not found');
  const prompt = handoffs.continuationPrompt(p.id, chumiLink(), store.getProfile().explanationLanguage !== 'English');
  let launched = false;
  /** For an app that cannot be given the handoff: the instruction to paste there, and whether Chumi put it on the clipboard. */
  let paste: { text: string; copied: boolean } | undefined;
  if (via !== 'copy') {
    const project = store.getProject(h.project_id!)!;
    try {
      const skipped = (what: string) => log('handoff', `CHUMI_NO_LAUNCH: not opened: ${what}`);
      if (via === 'codex-app') await launchCodexDesktop(h.id, project.workspace, prompt, NO_LAUNCH ? { openUrl: async (url) => skipped(url) } : {});
      else if (via === 'deepseek-harness') {
        // For recordings the dialog says what a real Continue says, so a skipped copy reports as copied.
        const r = await continueInDeepSeekHarness(h.id, project.workspace, prompt, NO_LAUNCH ? { installed: () => true, copy: async (text) => skipped(`clipboard: ${text}`), open: async () => skipped('dsh://open') } : {});
        paste = { text: r.instruction, copied: r.copied };
      } else if (NO_LAUNCH) skipped(await agents.launchScript(via as AgentId, h.id, project.workspace, prompt));
      else await agents.launch(via as AgentId, h.id, project.workspace, prompt);
      launched = true;
    } catch (e) { throw new HttpError(400, (e as Error).message); }
  }
  handoffs.markDelivered(p.id, via);
  return { prompt, launched, paste, handoff: handoffs.view(h.session_id) };
});

// ---------------------------------------------------------------- coding agent connection (Claude Code, Codex, opencode, Qwen Code, Antigravity, DeepSeek Harness)
const isAgent = (a: string): a is AgentId => AGENTS.includes(a as AgentId);
route('GET', '/api/agents/info', () => ({ commands: agents.setupCommands(), exports: { mybot: store.getSettings().integrations.mybot.enabled ? mybot.status() : null } }));
route('GET', '/api/agents/local', () => agentChecks.local());
route('GET', '/api/agents/:agent/status', (_req, _res, p) => { if (!isAgent(p.agent)) throw new HttpError(404, 'Unknown agent'); return agentChecks.status(p.agent); });
route('POST', '/api/agents/:agent/connect', async (_req, _res, p) => { if (!isAgent(p.agent)) throw new HttpError(404, 'Unknown agent'); agentChecks.invalidate(p.agent); try { await agents.connect(p.agent); } catch (e) { throw new HttpError(400, (e as Error).message); } return { status: await agentChecks.status(p.agent, true) }; });
route('POST', '/api/agents/:agent/disconnect', async (_req, _res, p) => { if (!isAgent(p.agent)) throw new HttpError(404, 'Unknown agent'); agentChecks.invalidate(p.agent); await agents.disconnect(p.agent); return { status: await agentChecks.status(p.agent, true) }; });
// DeepSeek Harness is the one agent Chumi finds as a desktop app; when it is installed somewhere Chumi doesn't look, the user points to it.
route('POST', '/api/agents/:agent/choose-app', async (_req, _res, p) => {
  if (p.agent !== 'deepseek-harness') throw new HttpError(404, 'Unknown agent');
  const dir = await chooseApp(IS_WIN ? 'Choose the folder DeepSeek Harness was installed to' : 'Choose DeepSeek Harness');
  if (!dir) return { cancelled: true };
  try { rememberDshApp(dir); } catch (e) { throw new HttpError(400, (e as Error).message); }
  agentChecks.invalidate(p.agent);
  return { status: await agentChecks.status(p.agent, true) };
});
route('GET', '/api/agents/available', async () => ({ agents: await Promise.all(AGENTS.map(async (a) => ({ agent: a, name: AGENT_NAMES[a], installed: !!await agents.cli(a) }))) }));
route('POST', '/api/agents/:agent/verify', async (req, _res, p) => {
  if (!isAgent(p.agent)) throw new HttpError(404, 'Unknown agent');
  if (AGENT_BILLING[p.agent] === 'plan') {
    // The check runs a real (tiny) request: only within the plan's included usage, never on credits or overage.
    const plan = await (p.agent === 'codex' ? registry.providers.codex : registry.providers['claude-cli']).status(true).catch(() => null);
    if (!plan || !plan.ready || plan.billing !== 'subscription') {
      return { result: { ok: false, detail: 'Not run, so nothing is charged: {error}', vars: { error: plan?.message ?? plan?.quota.note ?? 'the plan status could not be checked.' } }, status: await agentChecks.status(p.agent, true) };
    }
  } else if ((await readJson(req)).consent !== true) {
    // These agents use the user's own model account, which Chumi cannot check: only run after the user agreed.
    throw new HttpError(400, 'Confirm the request first: Chumi cannot tell how this agent\'s model is billed.');
  }
  const r = await agents.verify(p.agent);
  return { result: r, status: await agentChecks.status(p.agent, true) };
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
  return { id: assistant.ask(needSession(b.sessionId), b.question.slice(0, 2000), selOf(b.selection), depthOf(b.depth), frameIds, effortOf(b.effort), { projectContext: b.projectContext === true }) };
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
route('POST', '/api/integrations/mybot/export-all', () => {
  try { validateMybotDirectory(store.getSettings().integrations.mybot.exportDir); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  return exportMybotSessions(store, mybot, true).then((result) => { broadcast('mybot-exported', result); return result; });
});
route('GET', '/api/integrations/mybot/server', () => projectContext.health());
route('GET', '/api/asr/models', () => {
  const active = store.getSettings().asr.model;
  return {
    hardware: hardware(), recommended: sherpaModelId(defaultLocalEngine()), active,
    models: MODEL_CATALOG.map((m) => ({ ...m, installed: isInstalled(m.id), partial: hasPartialModel(m.id), active: m.engine ? speech.engine === m.engine : m.id === active })),
    download: downloader.current, source: downloader.source(),
  };
});
route('POST', '/api/asr/setup', () => {
  const id = speech.engine === 'whisper' ? store.getSettings().asr.model : sherpaModelId(isSherpaEngine(speech.engine) ? speech.engine : defaultLocalEngine());
  if (isInstalled(id)) void speech.ensure().catch((e) => log('asr', (e as Error).message));
  else void downloader.start(id).catch((e) => log('asr', (e as Error).message));
  return { id, download: downloader.current };
});
route('POST', '/api/asr/models/:id/download', (_req, _res, p) => {
  if (!MODEL_CATALOG.some((m) => m.id === p.id)) throw new HttpError(404, 'Unknown model');
  void downloader.start(p.id).catch((e) => log('asr', `download failed: ${(e as Error).message}`));
  return { started: true };
});
route('POST', '/api/asr/models/:id/cancel', () => { downloader.cancel(); return { ok: true }; });
route('DELETE', '/api/asr/models/:id', (_req, _res, p) => {
  if (!MODEL_CATALOG.some((m) => m.id === p.id)) throw new HttpError(404, 'Unknown model');
  if (isInstalled(p.id) && (store.getSettings().asr.model === p.id || MODEL_CATALOG.some((m) => m.id === p.id && m.engine && (speech.engine === m.engine || manager.status !== 'idle')))) throw new HttpError(409, 'This model is in use. Switch to another model first.');
  try { downloader.remove(p.id); } catch (error) { throw new HttpError(409, (error as Error).message); }
  return { ok: true };
});
route('POST', '/api/asr/benchmark', async () => {
  if (manager.status !== 'idle') throw new HttpError(409, 'Wait until recording and transcription finish before testing speech recognition.');
  return { model: speech.engine === 'whisper' ? store.getSettings().asr.model : speech.label, results: await benchmark(speech) };
});
route('GET', '/api/asr/engines', async () => ({
  keys: { elevenlabs: await speech.hasKey('elevenlabs'), 'qwen-cloud': await speech.hasKey('qwen-cloud') }, fallback: MODEL_CATALOG.some((m) => m.engine && isInstalled(m.id)) || whisperUsable(),
}));
route('POST', '/api/asr/engines/:id/key', async (req, _res, p) => {
  if (!isKeyedEngine(p.id)) throw new HttpError(404, 'This speech engine has no API key.');
  const b = await readJson(req);
  if (typeof b.key !== 'string') throw new HttpError(400, 'An API key is required.');
  try { await speech.saveKey(p.id, b.key.trim()); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  return { stored: true };
});
route('DELETE', '/api/asr/engines/:id/key', async (_req, _res, p) => {
  if (!isKeyedEngine(p.id)) throw new HttpError(404, 'This speech engine has no API key.');
  if (store.getSettings().asr.engine === p.id && manager.status !== 'idle') throw new HttpError(409, 'End the current session before removing this key.');
  await speech.deleteKey(p.id);
  return { stored: false };
});
route('GET', '/api/settings', () => store.getSettings());
route('PUT', '/api/settings', async (req) => {
  const patch = await readJson(req);
  // Keys are read asynchronously, so check before the synchronous settings update.
  const engine = patch.asr?.engine;
  if (isKeyedEngine(engine) && engine !== store.getSettings().asr.engine && !(await speech.hasKey(engine))) throw new HttpError(400, 'Save your {engine} API key first.', { engine: ENGINE_NAMES[engine] });
  return applySettingsPatch(patch);
});
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
route('POST', '/api/provider/codex/login', async () => {
  const result = await (registry.providers.codex as CodexProvider).beginLogin();
  await openExternalUrl(result.authUrl);
  return { started: true };
});
route('GET', '/api/provider/anthropic-key', async () => ({ stored: !!(await readKey()) }));
route('POST', '/api/provider/anthropic-key', async (req) => { const b = await readJson(req); await storeKey(String(b.key ?? '').trim()); return registry.status(true); });
route('DELETE', '/api/provider/anthropic-key', async () => { await deleteKey(); return registry.status(true); });
route('POST', '/api/provider/claude/clear-overage', async () => { (registry.providers['claude-cli'] as ClaudeCliProvider).clearOverageBlock(); return registry.status(true); });

/** Refuse stale UI actions rather than save a credential or run a test against a different endpoint. */
function compatibleTarget(target: { preset?: unknown; baseUrl?: unknown; model?: unknown }, testModel = false) {
  if (!isCompatiblePreset(target.preset) || typeof target.baseUrl !== 'string') throw new HttpError(400, 'Unknown model preset or endpoint.');
  const preset = target.preset;
  const settings = store.getSettings().ai.compatible;
  const profile = settings.profiles[preset];
  let baseUrl: string;
  try { baseUrl = normalizeCompatibleUrl(target.baseUrl, COMPATIBLE_PRESETS[preset].local); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  if (baseUrl !== profile.baseUrl || (testModel && (preset !== settings.preset || target.model !== profile.model))) {
    throw new HttpError(409, 'Model settings changed. Save and refresh the configuration before continuing.');
  }
  return { preset, baseUrl };
}

route('POST', '/api/provider/compatible/models', async (req) => {
  const body = await readJson(req);
  try { return await discoverLocalModels(body); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
});
route('GET', '/api/provider/local-hardware', () => localHardware(store.getSettings().asr.model));
route('GET', '/api/provider/local-download', () => localModelDownloader.snapshot());
route('POST', '/api/provider/local-download', async (req) => {
  try { return localModelDownloader.start(await readJson(req)); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
});
route('POST', '/api/provider/local-download/cancel', async (req) => {
  const body = await readJson(req);
  try { return localModelDownloader.cancel(String(body.id ?? '')); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
});
route('POST', '/api/provider/local-download/check', async (req) => {
  const body = await readJson(req);
  try { return localModelDownloader.resume(String(body.id ?? '')); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
});
route('GET', '/api/provider/compatible/key', async (_req, _res, _p, url) => {
  const { preset, baseUrl } = compatibleTarget({ preset: url.searchParams.get('preset'), baseUrl: url.searchParams.get('baseUrl') });
  return { stored: !!(await readCompatibleKey(preset, baseUrl)) };
});
route('POST', '/api/provider/compatible/key', async (req) => {
  const body = await readJson(req);
  const { preset, baseUrl } = compatibleTarget(body);
  if (typeof body.key !== 'string') throw new HttpError(400, 'An API key is required.');
  try { await storeCompatibleKey(preset, baseUrl, body.key.trim()); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  registry.compatible.invalidateStatus();
  return { stored: true };
});
route('DELETE', '/api/provider/compatible/key', async (req) => {
  const { preset, baseUrl } = compatibleTarget(await readJson(req));
  await deleteCompatibleKey(preset, baseUrl);
  registry.compatible.invalidateStatus();
  return { stored: false };
});
route('POST', '/api/provider/compatible/test', async (req) => {
  compatibleTarget(await readJson(req), true);
  return registry.compatible.testConnection();
});

route('GET', '/api/audio/devices', async () => ({ devices: await listDevices() }));
route('GET', '/api/audio/permissions', async () => checkPermissions());
route('POST', '/api/audio/request-mic', async () => {
  const helper = findAudioHelper();
  if (!helper) throw new HttpError(400, 'Audio helper not built');
  return new Promise((r) => execFile(helper, audioHelperArgs(['--request-mic']), { timeout: 60000, windowsHide: true }, (_e, out) => { try { r(JSON.parse(out)); } catch { r({ microphone: 'unknown' }); } }));
});
route('POST', '/api/audio/open-settings', async (req) => {
  const b = await readJson(req);
  openPrivacySettings(b.pane === 'audio-capture' || b.pane === 'screen' ? b.pane : 'microphone');
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
server.on('request', async (req, res) => {
  try {
    // Defend against DNS-rebinding and cross-site requests: local host names only, no API calls from other sites' pages
    // (some GETs start agent CLIs or the screen tool), and a custom header on writes.
    if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, { error: 'Forbidden host' });
    if (shuttingDown) return send(res, 503, { error: 'Chumi is shutting down.' });
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
    const crossSite = crossSiteSource(req.headers);
    if (crossSite) return send(res, 403, { error: 'Cross-site request refused ({error})', vars: { error: crossSite } });
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
    const status = e instanceof HttpError || e instanceof HandoffError || e instanceof ProjectWorkError ? e.status : 500;
    if (status === 500) log('http', (e as Error).stack ?? e, e instanceof HttpError ? e.vars ?? '' : '');
    if (!res.headersSent) send(res, status, { error: (e as Error).message, ...(e instanceof HttpError && e.vars ? { vars: e.vars } : {}) });
  }
});

log('server', `Chumi listening on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
// Where agents' "open in Chumi" links should point (read by the MCP server).
try { writeFileSync(SERVER_INFO, JSON.stringify({ url: `http://${HOST}:${PORT}`, pid: process.pid, startedAt: Date.now() })); } catch { /* links are optional */ }
void speech.ensure().catch((e) => log('asr', `not ready: ${(e as Error).message}`));
void registry.status(true).catch(() => {});

let shuttingDown = false;
if (process.env.CHUMI_MOBILE === '1') {
  void (async () => {
    // Pairing errors disable only the companion; the desktop must still start.
    const mobileConfig = loadMobileConfiguration(join(DATA_DIR, 'mobile', 'companion.json'));
    const started = await startMobileServer({
      store, assistant, host: mobileConfig.host, port: mobileConfig.port, token: mobileConfig.token, tls: mobileConfig.tls,
      onSessionChanged: (id) => { syncMybot(id); broadcast('mobile-sync', { sessionId: id }); },
    });
    mobileServer = started;
    mobileStartNotice = null;
    if (shuttingDown) { void started.close(); return; }
    log('mobile', `iPhone companion enabled at ${mobileConfig.url} (pairing required)`);
  })().catch((error) => {
    log('mobile', `Could not enable iPhone companion: ${(error as Error).message}`);
    // Startup usually finishes before the web UI connects. Replay the failure to later clients.
    mobileStartNotice = { level: 'error', code: 'mobile_start_failed', message: 'The iPhone companion could not start. See the server log.' };
    broadcast('notice', mobileStartNotice);
  });
}
setInterval(() => { void registry.status(true).catch(() => {}); }, 90_000).unref();

async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('server', `${sig}: shutting down`);
  server.close();
  hotkey.stop();
  // Desktop parents pass this budget and wait a little longer for process exit as the save acknowledgment.
  const configured = Number(process.env.CHUMI_SHUTDOWN_GRACE_MS);
  const budget = Number.isFinite(configured) && configured >= SHUTDOWN_GRACE_MS ? configured : SHUTDOWN_GRACE_MS;
  const deadline = setTimeout(() => { log('server', 'shutdown deadline reached'); process.exit(1); }, budget);
  await finishShutdown([
    // Includes the audio helper's 3-second stop plus the final transcript's 4-second drain.
    { name: 'save meeting', timeoutMs: 8000, run: () => manager.suspendForShutdown() },
    { name: 'stop speaker analysis', timeoutMs: 3000, run: () => speakers.shutdown() },
    { name: 'stop iPhone companion', timeoutMs: 2000, run: () => mobileServer?.close() },
    { name: 'stop services', timeoutMs: 3000, run: () => Promise.all([speech.stop(), registry.shutdown(), localModelDownloader.shutdown()]).then(() => {}) },
  ], budget, (name, error) => log('server', `${name}: ${error.message}`));
  store.close();
  dataLock.release();
  clearTimeout(deadline);
  process.exit(0);
}
// A live recording must survive unexpected bugs: log them, tell the UI, keep running.
// (Transcript segments are already persisted, so state on disk stays consistent.)
process.on('uncaughtException', (e) => {
  log('server', `uncaught exception: ${e.stack ?? e}`);
  broadcast('notice', { level: 'error', code: 'internal_error', message: 'Internal error (logged; recording continues): {error}', vars: { error: e.message } });
});
process.on('unhandledRejection', (e) => { log('server', `unhandled rejection: ${(e as Error)?.stack ?? e}`); });
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
// A closed terminal or console window (on Windows, closing the console that runs Chumi) arrives as SIGHUP.
process.on('SIGHUP', () => void shutdown('SIGHUP'));
// Desktop shells keep stdin open while they live; EOF saves the meeting and shuts down gracefully.
if (process.env.CHUMI_APP) {
  process.stdin.resume();
  process.stdin.on('end', () => void shutdown('desktop closed'));
}
