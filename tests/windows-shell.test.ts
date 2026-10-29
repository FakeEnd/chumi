import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const require = createRequire(new URL('../native/windows/desktop/main.cjs', import.meta.url));
const source = readFileSync(new URL('../native/windows/desktop/main.cjs', import.meta.url), 'utf8');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const { resolveLanguage } = require('./i18n.cjs');

// Exercise the actual shell without launching Electron, opening ports or using real settings.
function harness(locale = 'en-US', install?: { directory: string; chromiumUrl: string }) {
  let menu: any[] = [], answer: Promise<{ response: number }> = Promise.resolve({ response: 0 });
  const dialogs: any[] = [], files = new Map<string, string>(), timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0, ready: () => Promise<void> = async () => {};
  const ipc = new EventEmitter(), children: any[] = [], pets: any[] = [], notices: any[] = [], errors: any[] = [], kills: any[] = [];
  let failingStarts = 0, holdStop = false;
  const childProcess = { spawn: () => {
    const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, exitCode: null as number | null, signalCode: null as string | null, connected: true,
      stdout: { pipe() {} }, stderr: { pipe() {} }, stdin: { end() { if (!holdStop) { child.exitCode = 0; child.emit('exit', 0); child.emit('close'); } } },
    });
    children.push(child);
    if (failingStarts-- > 0) { child.exitCode = 1; queueMicrotask(() => { child.emit('error', new Error('spawn failed')); child.emit('close'); }); }
    return child;
  }, execFile: (...args: any[]) => { kills.push(args); } };
  class PetPanel {
    enabled = true; suspended = false; destroyed = false;
    constructor() { pets.push(this); }
    check() { if (this.destroyed) throw new Error('Object has been destroyed'); }
    async load() { this.check(); } suspend() { this.check(); this.suspended = true; } destroy() { this.check(); this.destroyed = true; }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false, quits: 0, exits: 0, relaunches: 0, getLocale: () => locale,
    getPath: () => 'test-data', setPath() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: (fn: typeof ready) => { ready = fn; return { catch() {} }; } }),
    quit() { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); if (!prevented) app.quits++; },
    relaunch() { app.relaunches++; }, exit() { app.exits++; },
  });
  class Window extends EventEmitter {
    loads: any[] = []; visible = false; focused = false; maximized = false; options: any;
    webContents = Object.assign(new EventEmitter(), {
      getURL: () => this.webContents.mainFrame.url, mainFrame: { url: 'http://127.0.0.1:4789' }, session: { on() {} }, setWindowOpenHandler() {}, executeJavaScript: async () => {},
    });
    constructor(options: any) { super(); this.options = options; }
    async loadFile(file: string, options: any) { this.loads.push({ file, ...options }); this.webContents.mainFrame.url = (install?.chromiumUrl ?? pathToFileURL(file).href) + '?' + new URLSearchParams(options.query); }
    async loadURL(url: string) { this.loads.push({ url }); this.webContents.mainFrame.url = url; }
    getNormalBounds() { return { x: 10, y: 20, width: 1200, height: 800 }; }
    isMaximized() { return this.maximized; } isMinimized() { return false; }
    show() { this.visible = true; } hide() { this.visible = false; this.maximized = false; } focus() { this.focused = true; }
  }
  const electron = { app, BrowserWindow: Window, ipcMain: ipc,
    Menu: { setApplicationMenu() {}, buildFromTemplate: (items: any[]) => { menu = items; return items; } },
    dialog: { showMessageBox: (_window: unknown, options: any) => { dialogs.push(options); return answer; } },
    Notification: class { constructor(options: any) { notices.push(options); } show() {} },
    globalShortcut: { unregisterAll() {} }, powerSaveBlocker: { start: () => 1, stop() {} },
  };
  const context = vm.createContext({
    require: (name: string) => name === 'electron' ? electron : name === './pet-panel.cjs' ? { PetPanel } : name === 'node:child_process' ? childProcess : name === 'node:path' && install ? win32 : name === 'node:fs' ? {
      mkdirSync() {}, createWriteStream: () => ({ write() {}, end() {} }), readFileSync: (file: string) => { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); },
      writeFileSync: (file: string, contents: string) => files.set(file, contents),
    } : require(name),
    __dirname: install?.directory ?? resolve('native/windows/desktop'), process: { env: { CHUMI_DATA_DIR: 'test-data' }, argv: [] }, URL, Buffer, console: { error: (...args: any[]) => errors.push(args) }, AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ ui: { language: 'auto' } }) }),
    setTimeout: (fn: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  vm.runInContext(source, context);
  const run = (code: string) => vm.runInContext(code, context);
  run(`language = resolveLanguage('auto', ${JSON.stringify(locale)}); baseUrl = 'http://127.0.0.1:4789'; makeWindow();`);
  run('freePort = async () => 4789;');
  const window = run('window') as Window;
  return { app, window, dialogs, files, timers, context, run, children, pets, notices, errors, kills,
    failStarts: (count: number) => { failingStarts = count; }, holdStop: () => { holdStop = true; },
    fire: async (ms: number) => { const entry = [...timers].find(([, timer]) => timer.ms === ms); assert.ok(entry, `timer ${ms} exists`); timers.delete(entry[0]); entry[1].fn(); await settle(); },
    crash: (signal = 'SIGKILL') => { const child = children.at(-1)!; child.signalCode = signal; child.emit('exit', null, signal); child.emit('close'); },
    ready: () => ready(), menu: () => menu,
    answer: (response: number | Promise<{ response: number }>) => { answer = typeof response === 'number' ? Promise.resolve({ response }) : response; },
    message: (message: unknown, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }) => run('onShellMessage')(event, message),
    close: () => window.emit('close', { preventDefault() {} }),
  };
}

for (const [locale, expected, buttons] of [
  ['en-US', 'Window', ['Keep recording', 'Save and close']],
  ['zh-TW', '窗口', ['继续会议', '保存并关闭']],
] as const) {
  test(`Windows shell localizes menus, recording prompt and startup page for ${locale}`, async () => {
    const h = harness(locale);
    assert.equal(h.menu()[3].label, expected);
    assert.ok(h.menu()[1].submenu.every((item: any) => item.type === 'separator' || item.label), 'edit roles have explicit translations');
    assert.ok(h.menu()[2].submenu.every((item: any) => item.label), 'view roles have explicit translations');
    h.run('setRecording(true)'); h.close();
    assert.deepEqual(plain(h.dialogs[0].buttons), buttons);
    assert.equal(h.dialogs[0].cancelId, 0);
    await h.run("showStartup(t('Preparing your meeting space…'), false)");
    assert.equal(h.window.loads.at(-1).query.log, '');
    await h.run("showStartup(t('Chumi could not start. Details are in the server log.'))");
    const query = h.window.loads.at(-1).query;
    assert.equal(query.language, locale.startsWith('zh') ? 'zh' : 'en');
    assert.ok(query.logLabel.includes('Alt'));
    assert.equal(/[\u4e00-\u9fff]/u.test(query.message), locale.startsWith('zh'));
    await Promise.resolve();
    assert.equal(h.app.quits, 0, 'cancel keeps the meeting open');
  });
}

test('Windows shell follows explicit UI language changes only from its own main page', () => {
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveLanguage('zh', 'en-US'), 'zh');
  assert.equal(resolveLanguage('auto', 'fr-FR'), 'en');
  const h = harness();
  h.message({ type: 'language', language: 'zh' }, { sender: h.window.webContents, senderFrame: { url: h.window.webContents.mainFrame.url } });
  assert.equal(h.menu()[3].label, 'Window');
  h.window.webContents.mainFrame.url = 'https://example.com';
  h.message({ type: 'language', language: 'zh' });
  assert.equal(h.menu()[3].label, 'Window');
  h.window.webContents.mainFrame.url = 'http://127.0.0.1:4789';
  h.message({ type: 'language', language: 'zh' });
  assert.equal(h.menu()[3].label, '窗口');
  h.message({ type: 'language', language: 'invalid' });
  assert.equal(h.menu()[3].label, '窗口');
  h.message({ type: 'language', language: 'en' });
  assert.equal(h.menu()[3].label, 'Window');
});

test('Windows startup page uses explicit language and log visibility rather than message wording', () => {
  const page = readFileSync(new URL('../native/windows/desktop/startup.html', import.meta.url), 'utf8');
  for (const language of ['en', 'zh']) {
    const elements = new Map(['message', 'log', 'restart'].map((id) => [id, { textContent: '', addEventListener() {} }]));
    const document = { documentElement: { lang: '' }, getElementById: (id: string) => elements.get(id) };
    const query = new URLSearchParams({ language, message: '<b>Failure</b>', logLabel: 'View Logs', log: 'test.log' });
    vm.runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)![1], { document, URLSearchParams, location: { search: '?' + query } });
    assert.equal(document.documentElement.lang, language === 'zh' ? 'zh-CN' : 'en');
    assert.equal(elements.get('message')!.textContent, '<b>Failure</b>', 'diagnostics remain text');
    assert.equal(elements.get('log')!.textContent, 'View Logs\ntest.log');
  }
});

test('Windows preload reports the resolved UI language initially and after a settings change', () => {
  const sent: any[] = [];
  let loaded!: () => void, changed!: () => void;
  const document = { documentElement: { lang: 'en', dataset: {} } };
  vm.runInNewContext(readFileSync(new URL('../native/windows/desktop/preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld() {} }, ipcRenderer: { send: (_channel: string, message: unknown) => sent.push(plain(message)) } }),
    window: { addEventListener: (_event: string, fn: () => void) => { loaded = fn; } }, document,
    MutationObserver: class { constructor(fn: () => void) { changed = fn; } observe() {} },
  });
  loaded();
  document.documentElement.lang = 'zh-CN'; changed();
  assert.deepEqual(sent, [{ type: 'language', language: 'en' }, { type: 'language', language: 'zh' }]);
});


async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)); }

test('Windows automatically restarts a crashed server and reloads the pet without resuming recording', async () => {
  const h = harness();
  await h.run('launchServer()');
  assert.equal(h.run('windowReady'), true);
  h.run('setRecording(true)');
  h.crash();
  assert.equal(h.run('recording'), false);
  assert.equal(h.pets[0].suspended, true);
  assert.equal(h.window.loads.at(-1).query.restartLabel, 'Restart Chumi');
  assert.doesNotMatch(h.window.loads.at(-1).query.message, /saved/);
  await h.fire(1000);
  assert.equal(h.children.length, 2);
  assert.equal(h.pets[0].destroyed, true);
  assert.equal(h.pets.length, 2);
  assert.equal(h.run('windowReady'), true);
  assert.equal(h.run('recording'), false);
  assert.match(h.notices.at(-1).body, /interrupted meeting/);
});

test('Windows crash recovery backs off, stops after two attempts, and can retry from the startup page', async () => {
  const h = harness();
  await h.run('launchServer()');
  h.failStarts(2); h.crash();
  await h.fire(1000);
  await h.fire(3000);
  assert.equal(h.children.length, 3);
  assert.equal(h.timers.size, 0);
  assert.equal(h.run('windowReady'), false);
  assert.equal(h.window.loads.at(-1).query.restartLabel, 'Restart Chumi');
  const startupUrl = h.window.webContents.mainFrame.url;
  h.message({ type: 'restart' }, { sender: h.window.webContents, senderFrame: { url: startupUrl } });
  h.window.webContents.mainFrame.url = 'file:///somewhere/startup.html'; h.message({ type: 'restart' });
  h.window.webContents.mainFrame.url = 'http://127.0.0.1:4789'; h.message({ type: 'restart' });
  await settle();
  assert.equal(h.children.length, 3, 'iframes, other files and the web UI cannot restart the server');
  h.window.webContents.mainFrame.url = startupUrl;
  h.message({ type: 'restart' }); h.message({ type: 'restart' });
  await settle();
  assert.equal(h.children.length, 4, 'double clicks start only one server');
  assert.equal(h.run('windowReady'), true);
});

test('Windows stops crash loops across successful but short-lived restarts and cancels recovery on quit', async () => {
  const h = harness();
  await h.run('launchServer()');
  h.crash(); await h.fire(1000);
  h.crash(); await h.fire(3000);
  h.crash();
  assert.equal(h.timers.size, 0, 'briefly reaching ready does not replenish the retry budget');
  h.run('restartAttempts = 0');
  await h.run('launchServer(true)');
  h.crash();
  assert.equal(h.timers.size, 1);
  h.app.quit(); await settle();
  assert.equal(h.timers.size, 0);
  assert.equal(h.app.quits, 1);
});

test('Windows menu Exit and window close share one cancellable recording confirmation', async () => {
  const h = harness();
  await h.run('launchServer()'); h.run('setRecording(true)');
  let respond!: (answer: { response: number }) => void;
  h.answer(new Promise((resolve) => { respond = resolve; }));
  assert.equal(h.menu()[0].submenu.at(-1).role, 'quit');
  h.app.quit(); h.close(); h.app.quit();
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.run('quitting'), false);
  respond({ response: 0 }); await settle();
  assert.equal(h.app.quits, 0);
  assert.equal(h.run('recording'), true);
  assert.equal(h.children[0].exitCode, null);
  h.answer(1); h.app.quit(); await settle();
  assert.equal(h.dialogs.length, 2);
  assert.equal(h.app.quits, 1);
  assert.equal(h.children[0].exitCode, 0);
  assert.equal(h.files.has(join('test-data', 'window.json')), true);
});

test('Windows hides during shutdown, waits for server exit and relaunches only after saving completes', async () => {
  const h = harness();
  await h.run('launchServer()');
  h.window.show(); h.window.maximized = true; h.holdStop();
  h.close(); await settle();
  assert.equal(h.dialogs.length, 0, 'idle quit needs no confirmation');
  assert.equal(h.window.visible, false);
  assert.equal(h.pets[0].destroyed, true);
  assert.equal(h.app.quits, 0);
  assert.equal(h.run('quitting'), true);
  assert.ok([...h.timers.values()].some((timer) => timer.ms === 17000), 'the backend retains its cleanup deadline');
  assert.equal(JSON.parse(h.files.get(join('test-data', 'window.json'))!).maximized, true, 'geometry is saved before hide changes the maximized state');
  h.app.quit(); h.close();
  assert.equal(h.app.quits, 0, 'repeated quit does not bypass saving');
  h.app.emit('second-instance'); h.app.emit('second-instance');
  assert.equal(h.window.visible, false);
  assert.equal(h.window.focused, false);
  assert.equal(h.app.relaunches, 0);
  h.children[0].exitCode = 0; h.children[0].emit('exit', 0); await settle();
  assert.equal(h.app.quits, 1);
  assert.equal(h.app.relaunches, 1);
  assert.equal(h.timers.size, 0);
});

test('Windows quitting during startup cannot spawn a backend after shutdown begins', async () => {
  const h = harness();
  let port!: (value: number) => void;
  h.context.portPromise = new Promise<number>((resolve) => { port = resolve; });
  h.run('freePort = () => portPromise');
  const starting = h.run('launchServer()'); await settle();
  h.close(); await settle();
  assert.equal(h.app.quits, 1);
  port(4789); await starting;
  assert.equal(h.children.length, 0);
  assert.equal(h.pets.length, 0);
});

test('Windows closing during automatic recovery never touches the destroyed suspended pet', async () => {
  const h = harness();
  await h.run('launchServer()');
  h.crash();
  let health!: (value: unknown) => void;
  h.context.fetch = () => new Promise((resolve) => { health = resolve; });
  h.holdStop();
  await h.fire(1000);
  assert.equal(h.run('starting'), true);
  assert.equal(h.pets[0].suspended, true);
  h.close();
  assert.equal(h.pets[0].destroyed, true);
  assert.equal(h.run('petPanel'), null);
  health({ ok: false }); await settle();
  await h.fire(150); // startServer now observes quitting and throws.
  assert.equal(h.run('starting'), false);
  assert.deepEqual(h.errors, [], 'the recovery catch skips the destroyed pet while quitting');
  h.children.at(-1).exitCode = 0; h.children.at(-1).emit('exit', 0); await settle();
  assert.equal(h.app.quits, 1);
});

test('Windows automatic and manual recovery handle a rejected error page without an unhandled rejection', async () => {
  for (const manual of [false, true]) {
    const h = harness();
    await h.run('launchServer()');
    h.crash(); await settle();
    h.window.loadFile = async () => { throw new Error('Renderer stopped'); };
    if (manual) { h.message({ type: 'restart' }); await settle(); }
    else await h.fire(1000);
    assert.equal(h.run('starting'), false);
    assert.ok(h.errors.some((args) => args[1]?.message === 'Renderer stopped'));
    h.app.quit(); await settle();
    assert.equal(h.timers.size, 0);
  }
});

test('Windows startup restart trusts Chromium’s URL for lowercase drives and percent/braces in install paths', async () => {
  const h = harness('en-US', { directory: String.raw`d:\Chumi% {review}\desktop`, chromiumUrl: 'file:///D:/Chumi%25%20{review}/desktop/startup.html' });
  h.failStarts(1);
  await h.run('launchServer()');
  assert.equal(h.window.loads.at(-1).file, String.raw`d:\Chumi% {review}\desktop\startup.html`);
  const startupUrl = h.window.webContents.getURL();
  assert.equal(h.run('startupUrl'), startupUrl);
  h.message({ type: 'restart' }, { sender: h.window.webContents, senderFrame: { url: startupUrl } });
  h.window.webContents.mainFrame.url = startupUrl.replace('startup.html', 'other.html'); h.message({ type: 'restart' });
  await settle();
  assert.equal(h.children.length, 1, 'an iframe or different file still cannot restart');
  h.window.webContents.mainFrame.url = startupUrl;
  h.message({ type: 'restart' }); await settle();
  assert.equal(h.children.length, 2);
  assert.equal(h.run('windowReady'), true);
});

test('Windows forces exit at the shutdown deadline even if taskkill produces no exit event', async () => {
  const h = harness();
  await h.run('launchServer()'); h.run('setRecording(true)'); h.holdStop();
  let respond!: (answer: { response: number }) => void;
  h.answer(new Promise((resolve) => { respond = resolve; }));
  h.close();
  assert.equal(h.timers.size, 0, 'the deadline does not include time spent deciding');
  respond({ response: 1 }); await settle();
  h.app.emit('second-instance');
  await h.fire(17000);
  assert.equal(h.kills.length, 1);
  assert.equal(h.app.exits, 0);
  await h.fire(20000);
  assert.equal(h.app.exits, 1);
  assert.equal(h.app.relaunches, 1);
  assert.equal(h.app.quits, 0);
  h.children[0].exitCode = 0; h.children[0].emit('exit', 0); await settle();
  assert.equal(h.app.relaunches, 1, 'a late child exit cannot relaunch twice');
  assert.equal(h.app.quits, 0);
  assert.equal(h.timers.size, 0);
});

test('Windows shell translations cover every literal and menu role with matching placeholders', () => {
  const dictionary = vm.runInNewContext(readFileSync(new URL('../native/windows/desktop/i18n.cjs', import.meta.url), 'utf8') + '\nzh;', { module: { exports: {} } });
  const literal = String.raw`(['"])((?:\\.|(?!\1).)*?)\1`;
  const calls = new RegExp(String.raw`\bt\(\s*${literal}`, 'g');
  const roles = new RegExp(String.raw`\brole\(\s*'[^']+'\s*,\s*${literal}`, 'g');
  const keys = new Set([...source.matchAll(calls), ...source.matchAll(roles)].map((match) => match[2].replace(/\\(['"\\])/g, '$1')));
  assert.ok(keys.size >= 35, 'the extractor covers dialogs, startup text and menu roles');
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of keys) {
    assert.ok(Object.hasOwn(dictionary, key), `missing Chinese translation: ${key}`);
    assert.deepEqual(placeholders(dictionary[key]), placeholders(key), `placeholders for ${key}`);
  }
  const h = harness('zh-CN');
  assert.equal(h.menu()[1].submenu.find((item: any) => item.role === 'delete')?.label, '删除');
});
