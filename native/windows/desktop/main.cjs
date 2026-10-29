const { app, BrowserWindow, Menu, dialog, shell, globalShortcut, Notification, powerSaveBlocker, desktopCapturer, nativeImage, safeStorage, ipcMain } = require('electron');
const { createHash } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { isDesktopRequestUrl, isExternalNavigationUrl } = require('./external-links.cjs');
const { PetPanel } = require('./pet-panel.cjs');
const { resolveLanguage, translate } = require('./i18n.cjs');

const root = path.resolve(__dirname, '../../..');
const dataDir = process.env.CHUMI_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'Chumi');
const logDir = path.join(dataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
app.setPath('userData', path.join(dataDir, 'desktop'));
app.setAppUserModelId('org.chumi.desktop');

let window, petPanel, screenCapture, server, baseUrl, log, quitting = false, recording = false, sleepBlocker;
let windowReady = false, startupUrl = null, language = 'en';
let quitPending = false, quitFinished = false, relaunchRequested = false, quitTimer;
let starting = false, restartTimer, restartAttempts = 0, readyAt = 0, interruptedRecording = false;
const t = (text, vars) => translate(language, text, vars);
const geometryFile = path.join(dataDir, 'window.json');
const iconMode = process.argv.includes('--make-icon');
// The backend owns the save deadline; process exit confirms it has finished cleanup.
const shutdownGraceMs = 15000;
// Allow backend cleanup and taskkill, then release the single-instance lock even if exit never arrives.
const shutdownDeadlineMs = shutdownGraceMs + 5000;
const reportShellError = (error) => console.error('Chumi desktop:', error);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return fallback; throw e; }
}

async function freePort() {
  for (let port = 4777; port <= 4790; port++) {
    const listener = net.createServer();
    try {
      listener.listen(port, '127.0.0.1');
      await once(listener, 'listening');
      await new Promise((resolve) => listener.close(resolve));
      return port;
    } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error(t('Chumi cannot find a free local port. Close older Chumi copies and reopen it.'));
}

async function startServer() {
  // A second server on the same database would interrupt the first one's meeting.
  const existing = readJson(path.join(dataDir, 'server.json'), null);
  if (existing?.url) {
    let health;
    try { health = await fetch(existing.url + '/api/health', { signal: AbortSignal.timeout(1500) }).then((r) => r.json()); }
    catch { /* A previous app may have left its address after exiting. */ }
    if (health?.app === 'chumi') throw new Error(t('Another copy of Chumi is running. Close that copy, then reopen this app.'));
  }
  const backend = app.isPackaged ? path.join(process.resourcesPath, 'backend') : root;
  const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'node.exe')
    : process.env.CHUMI_NODE || path.join(root, 'build', 'windows', 'runtime', 'node.exe');
  const helper = app.isPackaged ? path.join(process.resourcesPath, 'chumi-audio.exe') : path.join(root, 'build', 'chumi-audio.exe');
  const port = await freePort();
  if (quitting) return;
  baseUrl = `http://127.0.0.1:${port}`;
  log = fs.createWriteStream(path.join(logDir, 'desktop-server.log'), { flags: 'a' });
  log.write(`\n${new Date().toISOString()} Chumi desktop starting\n`);
  const childLog = log;
  const child = server = spawn(node, [path.join(backend, 'server', 'main.ts')], {
    cwd: backend, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, CHUMI_APP: '1', CHUMI_DESKTOP: 'electron', CHUMI_AUDIO_HELPER: helper,
      CHUMI_DATA_DIR: dataDir, CHUMI_SYSTEM_LANGUAGE: app.getLocale(), PORT: String(port),
      CHUMI_SHUTDOWN_GRACE_MS: String(shutdownGraceMs),
      PATH: path.dirname(node) + path.delimiter + (process.env.PATH || '') },
  });
  child.stdout.pipe(childLog, { end: false });
  child.stderr.pipe(childLog, { end: false });
  child.once('close', () => childLog.end());
  let spawnError;
  child.on('error', (e) => { spawnError = e; });
  child.on('message', (message) => { if (server === child) void onServerMessage(message); });
  child.on('exit', (code, signal) => {
    if (server !== child) return;
    if (quitting || !windowReady) return;
    interruptedRecording ||= recording;
    if (Date.now() - readyAt >= 60000) restartAttempts = 0;
    petPanel?.suspend();
    screenCapture?.destroy(); screenCapture = null;
    setRecording(false);
    windowReady = false;
    void showFailure(t('Chumi’s background service stopped ({code}).', { code: signal || code }), true).catch(reportShellError);
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(t('Chumi could not start. Details are in the server log.') + '\n' + spawnError.message);
    if (quitting || server !== child || hasExited(child)) throw new Error(t('Chumi could not start. Details are in the server log.'));
    try {
      const response = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok && !hasExited(child)) return;
    } catch { /* Wait for the local server to listen. */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(t('Chumi took too long to start. Details are in the server log.'));
}

function setRecording(value) {
  recording = value;
  if (recording && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  else if (!recording && sleepBlocker !== undefined) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = undefined; }
}

async function onServerMessage(message) {
  if (message.type === 'desktop-state') { setRecording(message.status === 'recording'); return; }
  if (message.type !== 'desktop-request') return;
  try {
    let value;
    switch (message.action) {
      case 'choose-folder': {
        const selected = await dialog.showOpenDialog(window, { title: message.payload.prompt, properties: ['openDirectory', 'createDirectory'] });
        value = selected.canceled ? null : selected.filePaths[0]; break;
      }
      case 'notify':
        new Notification({ title: 'Chumi', body: message.payload.text }).show(); value = true; break;
      case 'open-url':
        if (!isDesktopRequestUrl(message.payload.url)) throw new Error(t('Unsupported link.'));
        await shell.openExternal(message.payload.url); break;
      case 'credential-read': case 'credential-write': case 'credential-delete': {
        const account = createHash('sha256').update(message.payload.service + '\0' + message.payload.account).digest('hex');
        const folder = path.join(dataDir, 'credentials');
        const file = path.join(folder, account);
        if (message.action === 'credential-delete') { fs.rmSync(file, { force: true }); break; }
        if (!safeStorage.isEncryptionAvailable()) throw new Error(t('Windows credential encryption is unavailable.'));
        if (message.action === 'credential-read') { value = fs.existsSync(file) ? safeStorage.decryptString(fs.readFileSync(file)) : null; break; }
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(file + '.tmp', safeStorage.encryptString(message.payload.key));
        fs.renameSync(file + '.tmp', file);
        break;
      }
      case 'hotkey': {
        globalShortcut.unregisterAll();
        const spec = message.payload.spec;
        const shortcut = spec.split('+').map((part) => ({ ctrl: 'Control', opt: 'Alt', alt: 'Alt', cmd: 'Super', shift: 'Shift' }[part.toLowerCase()] || part.toUpperCase())).join('+');
        value = { shortcut, registered: spec === 'off' || globalShortcut.register(shortcut, () => { if (server?.connected) server.send({ type: 'desktop-shortcut' }); }) };
        break;
      }
      case 'screen-list': {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
        value = sources.filter((s) => s.name !== 'Chumi' && s.name !== 'Chumi pet' && s.name !== 'Chumi capture').map((s) => ({ id: Number(s.id.split(':')[1]), title: s.name, app: '', bundleId: '', pid: 0, width: 0, height: 0, onScreen: true }));
        break;
      }
      case 'screen-capture': {
        screenCapture ??= new (require('./screen-capture.cjs').ScreenCapture)();
        value = await screenCapture.capture(message.payload.id, message.payload.force); break;
      }
      case 'screen-stop': await screenCapture?.stop(message.payload.id); break;
      default: throw new Error(`Unknown desktop action: ${message.action}`);
    }
    if (server.connected) server.send({ type: 'desktop-result', id: message.id, value });
  } catch (e) { if (server?.connected) server.send({ type: 'desktop-result', id: message.id, error: e.message }); }
}

function hasExited(child) { return child.exitCode !== null || child.signalCode != null; }

async function stopServer() {
  const child = server;
  if (!child?.pid || hasExited(child)) return;
  const exited = once(child, 'exit');
  child.stdin.end();
  const killTimer = setTimeout(() => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}), shutdownGraceMs + 2000);
  try { await exited; } finally { clearTimeout(killTimer); }
}

async function showStartup(message, showLog = true, canRestart = false) {
  startupUrl = null;
  await window.loadFile(path.join(__dirname, 'startup.html'), { query: { message, language, restartLabel: canRestart ? t('Restart Chumi') : '', logLabel: showLog ? t('Press Alt, then choose Chumi → View Logs') : '', log: showLog ? path.join(logDir, 'desktop-server.log') : '' } });
  if (!quitting) startupUrl = window.webContents.getURL();
}

async function showFailure(message, retry) {
  if (quitting) return;
  if (retry && !restartTimer && restartAttempts < 2) {
    const delay = [1000, 3000][restartAttempts++];
    restartTimer = setTimeout(() => { restartTimer = null; void launchServer(true).catch(reportShellError); }, delay);
  }
  await showStartup(message + (restartTimer ? '\n' + t('Chumi will restart automatically. Recording will stay stopped.') : ''), true, true);
}

async function launchServer(recovery = false) {
  if (starting || quitting) return;
  starting = true;
  windowReady = false;
  try {
    await showStartup(recovery ? t('Restarting Chumi…') : t('Preparing your meeting space…'), false);
    await stopServer();
    if (quitting) return;
    await startServer();
    if (quitting) return;
    const settings = await fetch(baseUrl + '/api/settings', { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
    if (quitting) return;
    language = resolveLanguage(settings?.ui?.language, app.getLocale());
    updateMenu();
    startupUrl = null;
    await window.loadURL(baseUrl);
    if (quitting) return;
    destroyPet();
    petPanel = new PetPanel({ baseUrl, dataDir,
      onOpen: (where) => {
        if (window.isMinimized()) window.restore();
        window.show(); window.focus();
        if (where.session) void window.webContents.executeJavaScript(`window.chumiOpen?.(${JSON.stringify(where)})`);
      },
      onEnabled: (on) => { Menu.getApplicationMenu().getMenuItemById('desktop-pet').checked = on; },
    });
    await petPanel.load();
    if (quitting) return;
    if (hasExited(server)) throw new Error(t('Chumi could not start. Details are in the server log.'));
    windowReady = true; readyAt = Date.now();
    if (recovery) new Notification({ title: 'Chumi', body: interruptedRecording
      ? t('Chumi restarted. Open your interrupted meeting to continue recording.') : t('Chumi is ready again.') }).show();
    interruptedRecording = false;
  } catch (e) {
    if (!quitting) {
      petPanel?.suspend();
      await showFailure(e.message, recovery);
    }
  } finally { starting = false; }
}

function destroyPet() {
  const panel = petPanel;
  petPanel = null;
  panel?.destroy();
}

function isStartupUrl(value) { return startupUrl !== null && value === startupUrl; }

function isAppUrl(value) {
  try { return new URL(value).origin === baseUrl; } catch { return false; }
}
function openLink(value) {
  if (!isExternalNavigationUrl(value)) return;
  if (isAppUrl(value)) void window.loadURL(value);
  else void shell.openExternal(value).catch((error) => dialog.showErrorBox(t('Could not open link'), error.message));
}

function makeWindow() {
  const saved = readJson(geometryFile, {});
  window = new BrowserWindow({
    title: 'Chumi', width: saved.width || 1440, height: saved.height || 900, minWidth: 1000, minHeight: 640,
    show: false, backgroundColor: '#f6f7fb', autoHideMenuBar: true,
    icon: app.isPackaged ? path.join(process.resourcesPath, 'app.asar', 'icon.png') : path.join(root, 'build', 'windows', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const { screen } = require('electron');
    const visible = screen.getAllDisplays().some((d) => saved.x < d.workArea.x + d.workArea.width && saved.y < d.workArea.y + d.workArea.height && saved.x + window.getBounds().width > d.workArea.x && saved.y + window.getBounds().height > d.workArea.y);
    if (visible) window.setPosition(saved.x, saved.y);
  }
  if (saved.maximized) window.maximize();
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) { e.preventDefault(); openLink(url); } });
  window.webContents.session.on('will-download', (e, item) => {
    const filename = dialog.showSaveDialogSync(window, { defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    if (filename) item.setSavePath(filename); else item.cancel();
  });
  window.webContents.on('render-process-gone', () => { if (!quitting && windowReady) void window.loadURL(baseUrl); });
  window.on('close', (e) => {
    if (quitFinished) return;
    e.preventDefault();
    app.quit();
  });
  updateMenu();
}

function updateMenu() {
  const role = (role, label) => ({ role, label: t(label) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Chumi', submenu: [{ label: t('View Logs'), click: () => void shell.openPath(logDir) }, { type: 'separator' }, role('quit', 'Exit')] },
    { label: t('Edit'), submenu: [role('undo', 'Undo'), role('redo', 'Redo'), { type: 'separator' }, role('cut', 'Cut'), role('copy', 'Copy'), role('paste', 'Paste'), role('delete', 'Delete'), role('selectAll', 'Select All')] },
    { label: t('View'), submenu: [role('reload', 'Reload'), role('resetZoom', 'Actual Size'), role('zoomIn', 'Zoom In'), role('zoomOut', 'Zoom Out'), role('togglefullscreen', 'Toggle Full Screen'), ...(!app.isPackaged ? [role('toggleDevTools', 'Developer Tools')] : [])] },
    { label: t('Window'), submenu: [{ id: 'desktop-pet', label: t('Desktop Pet'), type: 'checkbox', checked: petPanel?.enabled ?? true, click: () => petPanel?.toggle() }] },
  ]));
}

function onShellMessage(event, message) {
  if (quitting || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) return;
  if (message?.type === 'restart' && isStartupUrl(event.senderFrame.url)) {
    if (!starting && !quitting) { clearTimeout(restartTimer); restartTimer = null; restartAttempts = 0; void launchServer(true).catch(reportShellError); }
    return;
  }
  if (!isAppUrl(event.senderFrame.url)) return;
  if (message?.type === 'pet-reset') petPanel?.resetPosition();
  if (message?.type === 'language' && ['en', 'zh'].includes(message.language) && message.language !== language) {
    language = message.language;
    updateMenu();
  }
}

function finishQuit(force = false) {
  if (quitFinished) return;
  quitFinished = true;
  clearTimeout(quitTimer);
  if (relaunchRequested) app.relaunch();
  if (force) app.exit(); else app.quit();
}

async function requestQuit() {
  quitPending = true;
  try {
    if (recording) {
      const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Chumi', message: t('Save the meeting and close?'), detail: t('You can continue recording the next time you open Chumi.'), buttons: [t('Keep recording'), t('Save and close')], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return;
    }
    quitting = true; windowReady = false;
    quitTimer = setTimeout(() => finishQuit(true), shutdownDeadlineMs);
    clearTimeout(restartTimer); restartTimer = null;
    try { if (window) fs.writeFileSync(geometryFile, JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() })); }
    catch (error) { reportShellError(error); }
    window?.hide();
    destroyPet();
    screenCapture?.destroy(); screenCapture = null;
    globalShortcut.unregisterAll(); setRecording(false);
    try { await stopServer(); }
    finally { finishQuit(); }
  } finally { quitPending = false; }
}

app.on('before-quit', (e) => {
  if (quitFinished) return;
  if (!window && !server?.pid) { quitting = true; return; } // A second launch can exit before Electron is ready.
  e.preventDefault();
  if (!quitPending && !quitting) void requestQuit().catch(reportShellError);
});

if (iconMode) {
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const target = process.argv[process.argv.indexOf('--make-icon') + 1];
    const icon = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false });
    const svg = fs.readFileSync(path.join(root, 'assets', 'logo.svg'), 'utf8');
    await icon.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;background:transparent;width:512px;height:512px">${svg}</body>`));
    const png = await icon.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;canvas.getContext('2d').drawImage(image,0,0,512,512);resolve(canvas.toDataURL('image/png'))};image.onerror=reject;image.src=${JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'))}})`);
    fs.writeFileSync(target, nativeImage.createFromDataURL(png).toPNG());
    const sizes = [16, 32, 48, 64, 128, 256];
    const images = sizes.map((size) => nativeImage.createFromDataURL(png).resize({ width: size, height: size }).toPNG());
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    sizes.forEach((size, i) => {
      const entry = 6 + i * 16;
      header[entry] = header[entry + 1] = size === 256 ? 0 : size;
      header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(images[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
      offset += images[i].length;
    });
    fs.writeFileSync(path.join(path.dirname(target), 'chumi.ico'), Buffer.concat([header, ...images]));
    fs.copyFileSync(target, path.join(__dirname, 'icon.png'));
    app.quit();
  });
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (quitting) { relaunchRequested = true; return; }
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.whenReady().then(async () => {
    language = resolveLanguage('auto', app.getLocale());
    makeWindow();
    ipcMain.on('chumi-shell', onShellMessage);
    await launchServer();
  }).catch(reportShellError);
}
