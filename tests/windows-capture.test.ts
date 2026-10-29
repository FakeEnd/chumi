import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { join, resolve, win32 } from 'node:path';
import { ZH } from '../web/src/i18n-zh.ts';
import vm from 'node:vm';

const require = createRequire(new URL('../native/windows/desktop/screen-capture.cjs', import.meta.url));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function renderer() {
  let pixel = [60, 120, 180, 255], jpegCount = 0, requests = 0, constraints: any;
  const track = { readyState: 'live' };
  const video = { videoWidth: 3840, videoHeight: 2160, readyState: 2, play: async () => {}, srcObject: null };
  const canvases: any[] = [];
  const window: any = {};
  vm.runInNewContext(readFileSync(new URL('../native/windows/desktop/screen-capture.js', import.meta.url), 'utf8'), {
    window, Uint8Array, btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    navigator: { mediaDevices: { getDisplayMedia: async (value: any) => { requests++; constraints = plain(value); return { getVideoTracks: () => [track] }; } } },
    document: { querySelector: () => video, createElement: () => {
      const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: Array.from({ length: 64 * 48 }, () => pixel).flat() }) }),
        toDataURL: () => { jpegCount++; return 'data:image/jpeg;base64,' + Buffer.from('jpeg-' + jpegCount).toString('base64'); } };
      canvases.push(canvas); return canvas;
    } },
  });
  return { capture: window.chumiCapture.capture, video, track, canvases, pixel: (next: number[]) => { pixel = next; },
    counts: () => ({ requests, jpegCount }), constraints: () => constraints };
}

test('Windows capture bounds the selected stream and skips JPEG encoding and IPC data for unchanged frames', async () => {
  const h = renderer();
  const first = await h.capture(false);
  assert.deepEqual(h.constraints(), { audio: false, video: { width: { max: 1600 }, height: { max: 1000 }, frameRate: { max: 1 } } });
  assert.equal(first.width, 1600); assert.equal(first.height, 900);
  assert.equal(Buffer.from(first.thumb, 'base64').length, 64 * 48);
  assert.equal(first.mean, Math.round(60 * 0.299 + 120 * 0.587 + 180 * 0.114));
  assert.ok(first.image);
  const same = await h.capture(false);
  assert.equal(same.image, undefined);
  assert.equal(same.thumb, first.thumb);
  assert.deepEqual(h.counts(), { requests: 1, jpegCount: 1 });
  assert.ok((await h.capture(true)).image, 'snapshots always receive an image');
  h.pixel([180, 60, 30, 255]);
  assert.ok((await h.capture(false)).image);
  h.video.videoWidth = 800; h.video.videoHeight = 1200;
  const resized = await h.capture(false);
  assert.equal(resized.width, 667); assert.equal(resized.height, 1000); assert.ok(resized.image);
  h.track.readyState = 'ended';
  assert.equal((await h.capture(false)).error, 'window_not_found');
});

test('Windows capture grants only its own main frame even with lowercase drives and percent/braces in the install path', async () => {
  const windows: any[] = [], sizes: any[] = [];
  let sources = [{ id: 'window:42:0', name: 'Lecture' }, { id: 'window:43:0', name: 'Other app' }];
  class Window {
    options: any; destroyed = false; handler!: (request: any, callback: (value: any) => void) => void;
    webContents = { mainFrame: { url: '' }, setWindowOpenHandler() {}, on() {},
      session: { setDisplayMediaRequestHandler: (handler: typeof this.handler) => { this.handler = handler; } },
      executeJavaScript: async (script: string, gesture: boolean) => { assert.equal(gesture, true); return { thumb: 'thumb', image: script.includes('true') ? 'forced' : 'changed' }; },
    };
    constructor(options: any) { this.options = options; windows.push(this); }
    async loadFile(file: string) {
      assert.equal(file, String.raw`d:\Chumi% {review}\desktop\screen-capture.html`);
      this.webContents.mainFrame.url = 'file:///D:/Chumi%25%20{review}/desktop/screen-capture.html';
    }
    destroy() { this.destroyed = true; }
  }
  const module = { exports: {} as any };
  vm.runInNewContext(readFileSync(new URL('../native/windows/desktop/screen-capture.cjs', import.meta.url), 'utf8'), {
    module, __dirname: String.raw`d:\Chumi% {review}\desktop`, setTimeout, clearTimeout,
    require: (name: string) => name === 'electron' ? { BrowserWindow: Window, desktopCapturer: { getSources: async (options: any) => { sizes.push(plain(options.thumbnailSize)); return sources; } } } : name === 'node:path' ? win32 : require(name),
  });
  const capture = new module.exports.ScreenCapture();
  assert.equal((await capture.capture(42)).title, 'Lecture');
  const first = windows[0];
  assert.equal(first.options.show, false);
  assert.equal(first.options.webPreferences.backgroundThrottling, false);
  let selected: any;
  const request = { frame: first.webContents.mainFrame, videoRequested: true, audioRequested: false };
  first.handler(request, (value: any) => { selected = value; });
  assert.equal(selected.video.id, 'window:42:0');
  for (const patch of [{ frame: undefined }, { frame: { url: request.frame.url } }, { audioRequested: true }, { videoRequested: false }]) {
    first.handler({ ...request, ...patch }, (value: any) => { selected = value; });
    assert.deepEqual(plain(selected), {});
  }
  assert.equal((await capture.capture(42, true)).image, 'forced');
  assert.equal(windows.length, 1, 'successive ticks reuse the selected stream');
  await capture.capture(43);
  assert.equal(first.destroyed, true, 'switching windows releases the old stream');
  await capture.stop(42);
  assert.equal(windows[1].destroyed, false, 'a delayed stop for the old source preserves the new one');
  await capture.stop(43);
  assert.equal(windows[1].destroyed, true);
  sources = [];
  assert.equal((await capture.capture(43)).error, 'window_not_found');
  assert.ok(sizes.every((size) => size.width === 0 && size.height === 0));
  capture.destroy();
  assert.equal((await capture.capture(42)).error, 'capture_stopped');
});

test('Windows watcher keeps the last JPEG on unchanged ticks, forces snapshots and releases capture on pause and stop', async () => {
  const calls: any[] = [], files = new Map<string, Buffer>(), frames: any[] = [], writes: string[] = [], notices: any[] = [], logs: any[] = [];
  let next: any = { width: 800, height: 600, mean: 100, thumb: Buffer.alloc(64 * 48, 100).toString('base64'), image: Buffer.from('first').toString('base64') };
  const code = stripTypeScriptTypes(readFileSync(new URL('../server/screen/watcher.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, ''));
  const context = vm.createContext({ EventEmitter, Buffer, join, FRAMES_DIR: 'frames', DESKTOP: true, Date, setTimeout, clearInterval,
    mkdirSync() {}, log: (...args: any[]) => logs.push(args), existsSync: (file: string) => files.has(file),
    writeFileSync: (file: string, data: Buffer) => { files.set(file, data); writes.push(file); },
    copyFileSync: (from: string, to: string) => files.set(to, files.get(from)!),
    desktopRequest: async (action: string, payload: any) => { calls.push({ action, ...payload }); return next; },
    store: { frames: () => [], addFrame: (row: any) => { frames.push(row); return row; } },
  });
  vm.runInContext(code + "\nglobalThis.watcher = new ScreenWatcher(store, { sessionId: 'one', windowId: 42, nowT: () => 1000, intervalSec: 3 });", context);
  const watcher = context.watcher;
  watcher.on('notice', (...args: any[]) => notices.push(args));
  await watcher.tick();
  assert.equal(calls[0].force, true, 'new sessions require their own latest image');
  assert.equal(frames.length, 1);
  delete next.image;
  await watcher.tick();
  assert.equal(calls[1].force, false);
  assert.equal(writes.length, 1, 'unchanged ticks do not rewrite latest JPEG');
  assert.equal(frames.length, 1);
  next = { ...next, image: Buffer.from('snapshot').toString('base64') };
  await watcher.snapshot();
  assert.equal(calls.at(-1).force, true);
  assert.equal(files.get(frames.at(-1).path)!.toString(), 'snapshot');
  for (const failures of [1, 2, 3, 4]) { next = { error: 'capture_failed', message: 'Permission denied', failures }; await watcher.tick(); }
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0], 'warning');
  assert.equal(notices[0][1], 'screen_capture_failed');
  assert.ok(ZH[notices[0][2]], 'the existing Notices component translates this message via t(n.message)');
  assert.match(ZH[notices[0][2]], /重试/);
  const logCount = logs.length;
  next = { error: 'capture_backoff' };
  for (let i = 0; i < 20; i++) await watcher.tick();
  assert.equal(notices.length, 1, 'backoff ticks cannot repeat the notice');
  assert.equal(logs.length, logCount, 'backoff ticks cannot repeat failure logs');
  watcher.pause(); watcher.stop();
  assert.deepEqual(calls.slice(-2).map((c) => c.action), ['screen-stop', 'screen-stop']);
});

test('Windows capture backs off rejected and timed-out streams, caps retries, and resets after success or source changes', async () => {
  let now = 0, mode: 'reject' | 'timeout' | 'success' = 'reject', enumerations = 0, nextTimer = 0;
  const windows: any[] = [], timers = new Map<number, () => void>();
  class Window {
    destroyed = false;
    webContents = { mainFrame: {}, setWindowOpenHandler() {}, on() {}, session: { setDisplayMediaRequestHandler() {} },
      executeJavaScript: async () => {
        if (mode === 'reject') throw new Error('Permission denied');
        if (mode === 'timeout') return new Promise(() => {});
        return { thumb: 'thumb', mean: 120, image: 'jpeg' };
      },
    };
    constructor() { windows.push(this); }
    async loadFile() {} destroy() { this.destroyed = true; }
  }
  const module = { exports: {} as any };
  vm.runInNewContext(readFileSync(new URL('../native/windows/desktop/screen-capture.cjs', import.meta.url), 'utf8'), {
    module, __dirname: resolve('native/windows/desktop'), Date: { now: () => now },
    setTimeout: (fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => name === 'electron' ? { BrowserWindow: Window, desktopCapturer: { getSources: async () => {
      enumerations++; return [{ id: 'window:42:0', name: 'Lecture' }, { id: 'window:43:0', name: 'Other app' }];
    } } } : require(name),
  });
  const capture = new module.exports.ScreenCapture();
  for (const [index, delay] of [3000, 6000, 12000, 24000, 30000, 30000].entries()) {
    const result = await capture.capture(42);
    assert.equal(result.error, 'capture_failed');
    assert.equal(result.failures, index + 1);
    assert.equal(windows.length, index + 1);
    assert.equal(windows.at(-1).destroyed, true);
    for (let i = 0; i < 3; i++) assert.equal((await capture.capture(42, true)).error, 'capture_backoff', 'snapshots also respect the backoff');
    now += delay - 1;
    assert.equal((await capture.capture(42)).error, 'capture_backoff');
    assert.equal(enumerations, index + 1, 'waiting ticks neither enumerate nor build a renderer');
    now++;
  }
  mode = 'success';
  assert.equal((await capture.capture(42)).image, 'jpeg');
  assert.equal(capture.failures, 0);
  mode = 'timeout';
  const pending = capture.capture(42);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  const timedOut = await pending;
  assert.equal(timedOut.failures, 1, 'success resets the outage counter');
  assert.match(timedOut.message, /timed out/);
  assert.equal((await capture.capture(42)).error, 'capture_backoff');
  assert.equal(timers.size, 0);
  mode = 'success';
  assert.equal((await capture.capture(43)).image, 'jpeg', 'another selected window can capture immediately');
  mode = 'reject';
  await capture.capture(43);
  await capture.stop(43);
  mode = 'success';
  assert.equal((await capture.capture(43)).image, 'jpeg', 'stopping and reselecting also resets the backoff');
  capture.destroy();
});
