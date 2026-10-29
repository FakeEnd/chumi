import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const require = createRequire(new URL('../native/windows/desktop/main.cjs', import.meta.url));
const { isCodexNewLink, isCodexThreadLink, isDesktopRequestUrl, isExternalNavigationUrl } = require('./external-links.cjs') as {
  isCodexNewLink(value: unknown): boolean; isCodexThreadLink(value: unknown): boolean;
  isDesktopRequestUrl(value: unknown): boolean; isExternalNavigationUrl(value: unknown): boolean;
};
const newLink = 'codex://new?' + new URLSearchParams({ path: '/Users/研究 A&B #1', prompt: 'Read the handoff.\n先给计划。' });
const windowsLink = 'codex://new?' + new URLSearchParams({ path: 'C:\\Users\\研究 A&B\\project', prompt: 'Read C:\\交接 文件.md' });
const threadLink = 'codex://threads/01a17075-85a7-7f90-ac7e-faf371b998a8';
const allowed = [newLink, windowsLink, threadLink, 'codex://threads/Abc_123-XYZ'];
const denied = [
  'codex://settings', 'codex://plugins/install?plugin=test', 'codex://new',
  'codex://new?path=%2Ftmp', 'codex://new?prompt=hello',
  'codex://new?path=&prompt=hello', 'codex://new?path=%2Ftmp&prompt=',
  'codex://new?path=%2Ftmp&prompt=+++', 'codex://new?path=%20&prompt=hello',
  'codex://new?path=%2Ftmp&prompt=hello&execute=true',
  'codex://new?path=%2Ftmp&prompt=hello&prompt=again',
  'codex://new?path=%2Ftmp&path=%2Fother',
  'codex://new?path=%2Ftmp&prompt=hello#', 'codex://new?path=%2Ftmp&prompt=hello#settings',
  'codex://new/?path=%2Ftmp&prompt=hello', 'codex://new:123?path=%2Ftmp&prompt=hello',
  'codex://user@new?path=%2Ftmp&prompt=hello', 'codex://new.evil?path=%2Ftmp&prompt=hello',
  'codex://threads/', 'codex://threads/id/', 'codex://threads/id/other',
  'codex://threads/id?', 'codex://threads/id?view=settings', 'codex://threads/id#',
  'codex://threads/id#settings', 'codex://threads:123/id', 'codex://user@threads/id',
  'codex://threads/id.with.dot', 'codex://threads/%69d', 'codex://threads/中文',
  'codex://threads/id/../other', 'codex://threads/id\n', 'codex://threads\\id',
  'javascript:alert(1)', 'file:///tmp/meeting.md', 'x-codex://threads/id',
];

test('Windows Codex links allow only the prefilled composer and exact saved chat IDs', () => {
  for (const value of allowed) {
    assert.equal(isExternalNavigationUrl(value), true, value);
    assert.equal(isCodexNewLink(value) || isCodexThreadLink(value), true, value);
  }
  for (const value of denied) {
    assert.equal(isExternalNavigationUrl(value), false, value);
    assert.equal(isDesktopRequestUrl(value), false, value);
  }
  for (const value of [null, undefined, {}, 42]) assert.equal(isExternalNavigationUrl(value), false);
  assert.equal(isDesktopRequestUrl(newLink), true);
  assert.equal(isDesktopRequestUrl(threadLink), false, 'backend opening is limited to auth and the new-chat flow');
  for (const value of ['https://example.com/login?q=1', 'http://127.0.0.1:4777']) assert.equal(isDesktopRequestUrl(value), true);
  assert.equal(isExternalNavigationUrl('mailto:person@example.com'), true);
  assert.equal(isDesktopRequestUrl('mailto:person@example.com'), false);
});

test('Windows navigation, new windows and backend requests use the actual guarded launch paths', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'chumi-window-links-'));
  try {
    const opened: string[] = [], loaded: string[] = [], results: Array<{ error?: string }> = [];
    let popup!: (o: { url: string }) => { action: string };
    const events = new Map<string, (...args: any[]) => void>();
    const electron = {
      app: { getPath: () => temp, setPath() {}, setAppUserModelId() {}, on() {}, requestSingleInstanceLock: () => false, quit() {} },
      BrowserWindow: class {
        webContents = { setWindowOpenHandler(fn: typeof popup) { popup = fn; }, on: (name: string, fn: (...args: any[]) => void) => events.set(name, fn), session: { on() {} } };
        once() {} on() {} loadURL(url: string) { loaded.push(url); return Promise.resolve(); }
      },
      Menu: { setApplicationMenu() {}, buildFromTemplate: (template: unknown) => template },
      shell: { openExternal: async (url: string) => { opened.push(url); } },
      dialog: { showErrorBox() {} },
    };
    const context = vm.createContext({
      // pet-panel.cjs would load the real electron package, which downloads Electron where it is not installed.
      require: (name: string) => name === 'electron' ? electron : name === './pet-panel.cjs' ? { PetPanel: class {} } : require(name),
      __dirname: resolve('native/windows/desktop'), URL, console,
      process: { env: { CHUMI_DATA_DIR: temp }, argv: [] },
      setTimeout, clearTimeout,
      testServer: { connected: true, send: (result: { error?: string }) => results.push(result) },
    });
    vm.runInContext(readFileSync(resolve('native/windows/desktop/main.cjs'), 'utf8'), context);
    vm.runInContext('baseUrl = "http://127.0.0.1:4777"; server = testServer; makeWindow();', context);
    const request = vm.runInContext('onServerMessage', context) as (message: unknown) => Promise<void>;
    assert.equal(popup({ url: threadLink }).action, 'deny');
    assert.deepEqual(opened, [threadLink]);
    popup({ url: 'codex://settings' });
    assert.deepEqual(opened, [threadLink]);
    let prevented = 0;
    events.get('will-navigate')!({ preventDefault: () => prevented++ }, newLink);
    events.get('will-navigate')!({ preventDefault: () => prevented++ }, 'codex://plugins/install');
    assert.equal(prevented, 2);
    assert.deepEqual(opened, [threadLink, newLink]);
    assert.deepEqual(loaded, [], 'no Codex URL is loaded into the embedded page');
    await request({ type: 'desktop-request', id: 'ok', action: 'open-url', payload: { url: newLink } });
    assert.equal(results.at(-1)!.error, undefined);
    await request({ type: 'desktop-request', id: 'blocked', action: 'open-url', payload: { url: threadLink } });
    assert.match(results.at(-1)!.error!, /Unsupported link/);
    assert.deepEqual(opened, [threadLink, newLink, newLink]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('macOS compiles both native navigation paths and matches the Codex URL allowlist', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const temp = mkdtempSync(join(tmpdir(), 'chumi-mac-links-'));
  try {
    const source = join(temp, 'main.swift'), binary = join(temp, 'links-test'), cases = join(temp, 'cases.json');
    writeFileSync(cases, JSON.stringify([...allowed.map((url) => ({ url, allowed: true })), ...denied.map((url) => ({ url, allowed: false }))]));
    writeFileSync(source, String.raw`
import Foundation
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let cases = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
for item in cases {
    let raw = item["url"] as! String
    let expected = item["allowed"] as! Bool
    let actual = URL(string: raw).map { WebController.isAllowedCodexURL($0) } ?? false
    precondition(actual == expected, "Wrong link policy for \(raw): \(actual)")
}
print("codex-link-policies-ok")
`);
    execFileSync('/usr/bin/swiftc', [resolve('native/app/WebController.swift'), resolve('native/app/ShellLocalization.swift'), resolve('native/app/WindowChrome.swift'), source,
      '-swift-version', '5', '-module-cache-path', join(temp, 'swift-cache'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
    assert.match(execFileSync(binary, [cases], { timeout: 5000, encoding: 'utf8' }), /codex-link-policies-ok/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
