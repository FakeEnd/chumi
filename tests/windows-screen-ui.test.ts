import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { transformWithOxc } from 'vite';
import { screenLabel } from '../web/src/util.ts';

const require = createRequire(new URL('../native/windows/desktop/main.cjs', import.meta.url));
type Element = { type: any; props: Record<string, any>; children: any[] };
const h = (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children: children.flat(Infinity) });
const words = (node: any): string => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.children ?? []).map(words).join('');
const all = (node: any): Element[] => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(all)];

async function component(file: string, name: string, adapters: Record<string, any>) {
  const source = readFileSync(new URL(`../web/src/components/${file}`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const transformed = await transformWithOxc(source, file, { jsx: { runtime: 'classic', pragma: '_testJsx', pragmaFrag: 'Fragment' } });
  const deps = { _testJsx: h, Fragment: 'fragment', msg: (s: string) => s, ...adapters };
  return new Function(...Object.keys(deps), `${transformed.code}\nreturn ${name};`)(...Object.values(deps));
}

// Run the Electron request handler with a window source, then render the UI with its metadata.
test('Windows window titles label the picker and live capture when Electron has no app name', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'chumi-windows-screen-'));
  try {
    const results: any[] = [];
    const electron = {
      app: { setPath() {}, setAppUserModelId() {}, on() {}, requestSingleInstanceLock: () => false, quit() {} },
      desktopCapturer: { getSources: async () => [{ id: 'window:42:0', name: 'Lecture - Room 2' }, { id: 'window:43:0', name: 'Chumi' }] },
    };
    const context = vm.createContext({
      require: (name: string) => name === 'electron' ? electron : name === './pet-panel.cjs' ? { PetPanel: class {} } : require(name),
      __dirname: resolve('native/windows/desktop'), process: { env: { CHUMI_DATA_DIR: temp }, argv: [] },
      testServer: { connected: true, send: (result: any) => results.push(result) },
    });
    vm.runInContext(readFileSync(resolve('native/windows/desktop/main.cjs'), 'utf8'), context);
    vm.runInContext('server = testServer;', context);
    await vm.runInContext('onServerMessage', context)({ type: 'desktop-request', id: 1, action: 'screen-list', payload: {} });
    const windows = JSON.parse(JSON.stringify(results[0].value));
    assert.equal(windows.length, 1);
    assert.equal(windows[0].app, '');
    const t = (s: string, vars: Record<string, string> = {}) => s.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
    const picker = await component('WindowPicker.tsx', 'WindowPicker', { useState: () => [{ loading: false, toolBuilt: true, windows }, () => {}], useEffect() {}, t });
    const option = all(picker({ value: null, onChange() {} })).find((e) => e.type === 'option' && e.props.value === 42)!;
    assert.equal(words(option), 'Lecture - Room 2');
    const screen = { app: windows[0].app, title: windows[0].title, status: 'capturing', frames: 2 };
    const state = { live: { screen, status: 'recording', session: { id: 's' } }, data: { session: { id: 's' }, frames: [], segments: [], outputs: [] }, settings: { audio: { source: 'none' }, assist: { defaultDepth: 'standard' } } };
    const shared = { useStore: (selector: any) => selector(state), useState: (initial: any) => [initial, () => {}], t, screenLabel, plural: (n: number, one: string, many: string) => t(n === 1 ? one : many, { n: String(n) }), Dialog: 'dialog', WindowPicker: 'picker' };
    const dialog = await component('Slides.tsx', 'WindowDialog', { ...shared, tn: (s: string, vars: any) => h('fragment', null, s.split('{app}')[0], vars.app) });
    assert.match(words(dialog()), /Currently capturing: Lecture - Room 2 \(2 captures\)/);
    const strip = await component('Slides.tsx', 'SlideStrip', shared);
    assert.match(words(strip()), /capturing Lecture - Room 2/);
    const toolbar = await component('TopBar.tsx', 'SessionToolbar', { ...shared, fmtDate: String, fmtT: String, sourceLabel: String, IconWindow: 'icon', IconSpark: 'icon', IconCompact: 'icon', compactShortcutLabel: () => '' });
    assert.match(words(toolbar({})), /Lecture - Room 2 · 2/);
    screen.title = 'Lecture 5: Attention - YouTube — Google Chrome and a long meeting title';
    const shortTitle = 'Lecture 5: Attention - YouTube — Google…';
    assert.ok(words(toolbar({})).includes(`${shortTitle} · 2`));
    assert.ok(words(strip()).includes(`capturing ${shortTitle}`));
    assert.ok(words(dialog()).includes(`Currently capturing: ${screen.title} (2 captures)`));
    screen.title = windows[0].title;
    windows[0].app = screen.app = 'Browser';
    assert.equal(words(all(picker({ value: null, onChange() {} })).find((e) => e.type === 'option' && e.props.value === 42)), 'Browser · Lecture - Room 2');
    assert.match(words(dialog()), /Currently capturing: Browser · Lecture - Room 2 \(2 captures\)/);
    assert.match(words(strip()), /capturing Browser/);
    assert.match(words(toolbar({})), /Browser · 2/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
