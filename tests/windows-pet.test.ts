import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const require = createRequire(new URL('../native/windows/desktop/pet-panel.cjs', import.meta.url));
const source = readFileSync(new URL('../native/windows/desktop/pet-panel.cjs', import.meta.url), 'utf8');
const url = 'http://127.0.0.1:4777/pet.html';
const positionFile = join('test-data', 'pet-window.json');
const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

// Run the actual native host. The substitutes record Electron effects and let tests move the
// system cursor and displays; timers are explicit so no polling or desktop session is required.
function harness(files = new Map<string, string>(), displays = [primary]) {
  let cursor = { x: 0, y: 0 }, nextTimer = 0;
  const timers = new Map<number, () => void>();
  const ipc = new EventEmitter();
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => primary, getAllDisplays: () => displays,
    getCursorScreenPoint: () => cursor,
  });
  const sent: Array<{ method: string; args: any[] }> = [], opened: any[] = [], enabled: boolean[] = [];
  let menu: any[] = [];
  class Window extends EventEmitter {
    bounds = { x: 0, y: 0, width: 380, height: 300 };
    visible = false; focused = false; focusable = false; ignored = true; protected = false; destroyed = false;
    zoom = 1; loads: string[] = []; focusCount = 0; options: any;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url },
      send: (_channel: string, message: (typeof sent)[number]) => sent.push(message),
      setZoomFactor: (zoom: number) => { this.zoom = zoom; },
      setWindowOpenHandler: (fn: () => unknown) => { this.popup = fn; },
      executeJavaScript: async () => JSON.stringify([{ id: 'open', label: '打开 Chumi', enabled: true }, { id: '-' }, { id: 'hide', label: '隐藏', enabled: true }]),
    });
    popup!: () => unknown;
    constructor(options: any) { super(); this.options = options; }
    setIgnoreMouseEvents(value: boolean) { this.ignored = value; }
    setContentProtection(value: boolean) { this.protected = value; }
    setAlwaysOnTop() {}
    setBounds(bounds: typeof this.bounds) { this.bounds = { ...bounds }; }
    getBounds() { return { ...this.bounds }; }
    setPosition(x: number, y: number) { this.bounds = { ...this.bounds, x, y }; }
    setFocusable(value: boolean) { this.focusable = value; }
    isFocused() { return this.focused; }
    focus() { this.focused = true; this.focusCount++; }
    blur() { this.focused = false; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.visible = false; }
    async loadURL(value: string) { this.loads.push(value); this.webContents.mainFrame = { url: value }; }
  }
  const module = { exports: {} as any };
  const context = vm.createContext({ module, __dirname: resolve('native/windows/desktop'),
    require: (name: string) => name === 'electron' ? {
      BrowserWindow: Window, ipcMain: ipc, screen,
      Menu: { buildFromTemplate: (items: any[]) => { menu = items; return { popup() {} }; } },
    } : name === 'node:fs' ? {
      readFileSync: (file: string) => { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
      writeFileSync: (file: string, text: string) => files.set(file, text),
    } : require(name),
    setInterval: (fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearInterval: (id: number) => timers.delete(id), Date,
  });
  vm.runInContext(source, context);
  const panel = new module.exports.PetPanel({ baseUrl: 'http://127.0.0.1:4777', dataDir: 'test-data',
    onOpen: (where: unknown) => opened.push(where), onEnabled: (on: boolean) => enabled.push(on) });
  const window = panel.window as Window;
  const send = (message: unknown, event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }) => ipc.emit('chumi-pet', event, message);
  const layout = (patch: Record<string, unknown> = {}) => send({ type: 'layout', enabled: true, zoom: 1, height: 320,
    shareable: false, pet: [[30, 40, 140, 160]], ui: [[20, 220, 300, 40]], ...patch });
  return { panel, window, screen, ipc, timers, sent, opened, enabled, files, send, layout,
    move: (x: number, y: number) => { cursor = { x, y }; }, tick: () => { for (const fn of timers.values()) fn(); },
    displays: (next: typeof displays) => { displays = next; screen.emit('display-removed'); }, menu: () => menu };
}

test('Windows pet IPC accepts only its own top-level page and cannot navigate to other content', () => {
  const h = harness();
  assert.equal(h.window.visible, false);
  assert.equal(h.window.protected, true);
  const message = { type: 'open', session: 'meeting-a', t: 2500, dialog: 'handoff' };
  h.send(message, { sender: { mainFrame: {} } as any, senderFrame: {} as any });
  h.send(message, { sender: h.window.webContents, senderFrame: { url } });
  h.window.webContents.mainFrame.url = 'https://example.com/pet.html';
  h.send(message);
  assert.equal(h.opened.length, 0);
  h.window.webContents.mainFrame.url = url;
  h.send(message);
  assert.deepEqual(h.opened, [message]);
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  h.window.webContents.emit('will-navigate', event, url);
  h.window.webContents.emit('will-navigate', event, 'http://127.0.0.1:4777/');
  h.window.webContents.emit('will-navigate', event, 'https://example.com');
  assert.equal(prevented, 2);
  assert.deepEqual(plain(h.window.popup()), { action: 'deny' });
  h.panel.destroy();
});

test('Windows pet click-through follows scaled character and UI regions without taking focus', () => {
  const h = harness();
  h.layout({ zoom: 1.5 });
  assert.equal(h.window.bounds.width, 570);
  assert.equal(h.window.zoom, 1.5);
  const { x, y } = h.window.bounds;
  h.move(x + 60 * 1.5, y + 80 * 1.5); h.tick();
  assert.equal(h.window.ignored, false, 'the character receives clicks');
  assert.deepEqual(plain(h.sent.at(-1)), { method: 'pointer', args: [60, 80] });
  h.move(x + 100 * 1.5, y + 240 * 1.5); h.tick();
  assert.equal(h.window.ignored, false, 'toolbar buttons receive clicks');
  h.move(x + 330 * 1.5, y + 280 * 1.5); h.tick();
  assert.equal(h.window.ignored, true, 'empty transparent areas pass clicks through');
  assert.equal(h.window.focusCount, 0);
  h.panel.destroy();
});

test('Windows pet disabling stops polling, releases the keyboard and keeps capture protection in step', () => {
  const h = harness();
  h.layout(); h.layout();
  assert.equal(h.timers.size, 1, 'layout updates do not multiply the cursor timer');
  h.send({ type: 'keyboard', on: true });
  assert.equal(h.window.focusable, true);
  assert.equal(h.window.focused, true);
  h.layout({ shareable: true });
  assert.equal(h.window.protected, false);
  h.layout({ enabled: false, height: 0, pet: [], ui: [] });
  assert.equal(h.window.visible, false);
  assert.equal(h.window.focusable, false);
  assert.equal(h.window.focused, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.window.protected, true);
  assert.deepEqual(h.enabled, [false]);
  h.panel.toggle();
  assert.deepEqual(plain(h.sent.at(-1)), { method: 'setEnabled', args: [true] });
  h.layout();
  assert.equal(h.window.visible, true);
  assert.equal(h.timers.size, 1);
  assert.deepEqual(h.enabled, [false, true]);
  h.panel.destroy();
  assert.equal(h.window.destroyed, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.ipc.listenerCount('chumi-pet'), 0);
  assert.equal(h.screen.listenerCount('display-removed'), 0);
  assert.equal(h.screen.listenerCount('display-metrics-changed'), 0);
});

test('Windows pet preserves a dragged position and returns from a removed display', () => {
  const files = new Map([[positionFile, JSON.stringify({ x: 100, y: 100 })]]);
  const left = { workArea: { x: -1280, y: 0, width: 1280, height: 1024 } };
  const h = harness(files, [primary, left]);
  h.layout();
  h.move(160, 180); h.send({ type: 'drag', phase: 'start' });
  h.move(162, 181); h.send({ type: 'drag', phase: 'move' });
  assert.deepEqual(h.window.bounds, { x: 100, y: 100, width: 380, height: 320 });
  h.move(-1000, 280); h.send({ type: 'drag', phase: 'move' });
  h.send({ type: 'drag', phase: 'end' });
  const saved = JSON.parse(files.get(positionFile)!);
  assert.ok(saved.x < 0, 'the secondary display position is saved');
  assert.equal(h.sent.filter((e) => e.method === 'drag' && e.args[0] === 'start').length, 1);
  assert.ok(h.sent.some((e) => e.method === 'drag' && e.args[0] === 'end'));
  h.panel.destroy();
  const reopened = harness(files, [primary, left]);
  reopened.layout({ zoom: 2, height: 900 });
  assert.ok(reopened.window.bounds.x < 0);
  assert.equal(reopened.window.bounds.width, 760);
  assert.ok(reopened.window.bounds.height <= left.workArea.height, 'large cards stay within the display');
  reopened.displays([primary]);
  assert.ok(reopened.window.bounds.x >= 0, 'unplugging the display makes the pet reachable');
  reopened.panel.resetPosition();
  assert.ok(JSON.parse(files.get(positionFile)!).x >= 0);
  reopened.panel.destroy();
});

test('Windows pet native menu forwards the selected shared-page action', async () => {
  const h = harness();
  await h.panel.menu();
  const items = h.menu();
  assert.equal(items[0].label, '打开 Chumi');
  assert.equal(items[1].type, 'separator');
  items[2].click();
  assert.deepEqual(plain(h.sent.at(-1)), { method: 'run', args: ['hide'] });
  let prevented = false;
  h.window.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.window.destroyed, false);
  assert.deepEqual(plain(h.sent.at(-1)), { method: 'setEnabled', args: [false] });
  h.panel.destroy();
});

test('Windows pet reload sends the new page its available card space again', async () => {
  const h = harness();
  h.layout();
  assert.equal(h.sent.filter((e) => e.method === 'room').length, 1);
  h.window.webContents.emit('render-process-gone');
  assert.equal(h.window.visible, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.window.loads.at(-1), url);
  h.sent.length = 0;
  h.layout();
  assert.equal(h.sent.filter((e) => e.method === 'room').length, 1);
  assert.equal(h.window.visible, true);
  assert.equal(h.timers.size, 1);
  h.panel.destroy();
});
