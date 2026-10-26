const { app, BrowserWindow, Menu, dialog, shell, globalShortcut, Notification, powerSaveBlocker, desktopCapturer, nativeImage, safeStorage, ipcMain } = require('electron');
const { createHash } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { isDesktopRequestUrl, isExternalNavigationUrl } = require('./external-links.cjs');
const { PetPanel } = require('./pet-panel.cjs');

const root = path.resolve(__dirname, '../../..');
const dataDir = process.env.CHUMI_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'Chumi');
const logDir = path.join(dataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
app.setPath('userData', path.join(dataDir, 'desktop'));
app.setAppUserModelId('org.chumi.desktop');

let window, petPanel, server, baseUrl, log, quitting = false, recording = false, sleepBlocker;
let windowReady = false;
const geometryFile = path.join(dataDir, 'window.json');
const iconMode = process.argv.includes('--make-icon');
// The backend owns the save deadline; process exit confirms it has finished cleanup.
const shutdownGraceMs = 15000;

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
  throw new Error('Chumi cannot find a free local port. Close older Chumi copies and reopen it.');
}

async function startServer() {
  // A second server on the same database would interrupt the first one's meeting.
  const existing = readJson(path.join(dataDir, 'server.json'), null);
  if (existing?.url) {
    let health;
    try { health = await fetch(existing.url + '/api/health', { signal: AbortSignal.timeout(1500) }).then((r) => r.json()); }
    catch { /* A previous app may have left its address after exiting. */ }
    if (health?.app === 'chumi') throw new Error('Another copy of Chumi is running. Close that copy, then reopen this app.');
  }
  const backend = app.isPackaged ? path.join(process.resourcesPath, 'backend') : root;
  const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'node.exe')
    : process.env.CHUMI_NODE || path.join(root, 'build', 'windows', 'runtime', 'node.exe');
  const helper = app.isPackaged ? path.join(process.resourcesPath, 'chumi-audio.exe') : path.join(root, 'build', 'chumi-audio.exe');
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  log = fs.createWriteStream(path.join(logDir, 'desktop-server.log'), { flags: 'a' });
  log.write(`\n${new Date().toISOString()} Chumi desktop starting\n`);
  server = spawn(node, [path.join(backend, 'server', 'main.ts')], {
    cwd: backend, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, CHUMI_APP: '1', CHUMI_DESKTOP: 'electron', CHUMI_AUDIO_HELPER: helper,
      CHUMI_DATA_DIR: dataDir, CHUMI_SYSTEM_LANGUAGE: app.getLocale(), PORT: String(port),
      CHUMI_SHUTDOWN_GRACE_MS: String(shutdownGraceMs),
      PATH: path.dirname(node) + path.delimiter + (process.env.PATH || '') },
  });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });
  let spawnError;
  server.on('error', (e) => { spawnError = e; });
  server.on('message', (message) => void onServerMessage(message));
  server.on('exit', (code) => {
    if (quitting || !windowReady) return;
    petPanel?.suspend();
    setRecording(false);
    windowReady = false;
    void showStartup(`Chumi 的后台服务已停止（${code}）。会议记录已保存，请重新打开应用。`);
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw new Error('Chumi could not start. Details are in the server log.');
    try {
      const response = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Wait for the local server to listen. */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Chumi took too long to start. Details are in the server log.');
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
        if (!isDesktopRequestUrl(message.payload.url)) throw new Error('Unsupported link.');
        await shell.openExternal(message.payload.url); break;
      case 'credential-read': case 'credential-write': case 'credential-delete': {
        const account = createHash('sha256').update(message.payload.service + '\0' + message.payload.account).digest('hex');
        const folder = path.join(dataDir, 'credentials');
        const file = path.join(folder, account);
        if (message.action === 'credential-delete') { fs.rmSync(file, { force: true }); break; }
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
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
        value = sources.filter((s) => s.name !== 'Chumi' && s.name !== 'Chumi pet').map((s) => ({ id: Number(s.id.split(':')[1]), title: s.name, app: '', bundleId: '', pid: 0, width: 0, height: 0, onScreen: true }));
        break;
      }
      case 'screen-capture': {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1200 } });
        const source = sources.find((s) => Number(s.id.split(':')[1]) === message.payload.id);
        if (!source) { value = { error: 'window_not_found' }; break; }
        const bitmap = source.thumbnail.resize({ width: 64, height: 48 }).toBitmap();
        const grey = Buffer.alloc(64 * 48);
        for (let i = 0; i < grey.length; i++) grey[i] = Math.round(bitmap[i * 4] * 0.114 + bitmap[i * 4 + 1] * 0.587 + bitmap[i * 4 + 2] * 0.299);
        value = { ...source.thumbnail.getSize(), title: source.name, image: source.thumbnail.toJPEG(90).toString('base64'), thumb: grey.toString('base64'), mean: grey.reduce((sum, x) => sum + x, 0) / grey.length };
        break;
      }
      default: throw new Error(`Unknown desktop action: ${message.action}`);
    }
    if (server.connected) server.send({ type: 'desktop-result', id: message.id, value });
  } catch (e) { if (server?.connected) server.send({ type: 'desktop-result', id: message.id, error: e.message }); }
}

async function stopServer() {
  if (!server?.pid || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.stdin.end();
  const killTimer = setTimeout(() => execFile('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true }, () => {}), shutdownGraceMs + 2000);
  await exited;
  clearTimeout(killTimer);
  log?.end();
}

async function showStartup(message) {
  await window.loadFile(path.join(__dirname, 'startup.html'), { query: { message, log: path.join(logDir, 'desktop-server.log') } });
}

function isAppUrl(value) {
  try { return new URL(value).origin === baseUrl; } catch { return false; }
}
function openLink(value) {
  if (!isExternalNavigationUrl(value)) return;
  if (isAppUrl(value)) void window.loadURL(value);
  else void shell.openExternal(value).catch((error) => dialog.showErrorBox('Could not open link', error.message));
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
  window.webContents.on('render-process-gone', () => { if (!quitting && baseUrl) void window.loadURL(baseUrl); });
  window.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    void (async () => {
      if (recording) {
        const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Chumi', message: '关闭并保存当前会议？', detail: '下次打开 Chumi 可以继续录音。', buttons: ['继续会议', '保存并关闭'], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1) return;
      }
      fs.writeFileSync(geometryFile, JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }));
      app.quit();
    })();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Chumi', submenu: [{ label: '查看日志', click: () => void shell.openPath(logDir) }, { type: 'separator' }, { role: 'quit', label: '退出' }] },
    { role: 'editMenu', label: '编辑' },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }, ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    { label: '窗口', submenu: [{ id: 'desktop-pet', label: '桌宠', type: 'checkbox', checked: true, click: () => petPanel?.toggle() }] },
  ]));
}

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  petPanel?.destroy();
  if (!server?.pid) return; // A second launch can quit synchronously, before Electron is ready.
  e.preventDefault();
  globalShortcut.unregisterAll(); setRecording(false);
  void stopServer().finally(() => app.quit());
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
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    makeWindow();
    await showStartup('正在准备会议空间…');
    try {
      await startServer();
      if (!quitting) {
        await window.loadURL(baseUrl); windowReady = true;
        petPanel = new PetPanel({ baseUrl, dataDir,
          onOpen: (where) => {
            if (window.isMinimized()) window.restore();
            window.show(); window.focus();
            if (where.session) void window.webContents.executeJavaScript(`window.chumiOpen?.(${JSON.stringify(where)})`);
          },
          onEnabled: (on) => { Menu.getApplicationMenu().getMenuItemById('desktop-pet').checked = on; },
        });
        ipcMain.on('chumi-shell', (event, message) => {
          if (event.sender === window.webContents && event.senderFrame === event.sender.mainFrame && isAppUrl(event.senderFrame.url)
              && message?.type === 'pet-reset') petPanel.resetPosition();
        });
        await petPanel.load();
      }
    }
    catch (e) { await showStartup(e.message); }
  });
}
