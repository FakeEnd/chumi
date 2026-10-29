import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
import { DEFAULT_SETTINGS } from '../server/settings.ts';
import { MODEL_BASE_URL } from '../shared/model-source.ts';
import { transcriptionHarness } from './helpers/transcription-ui.ts';
import { tick } from './helpers/web-ui.ts';
import { getLang, setLang, t, tn } from '../web/src/i18n.ts';

type Element = { type: any; props: Record<string, any>; children: any[] };
const jsx = (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children: children.flat(Infinity) });
const all = (node: any): Element[] => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(all)];
const words = (node: any): string => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.children ?? []).map(words).join('');

async function component(name: string, adapters: Record<string, any>) {
  const source = readFileSync(new URL(`../web/src/components/${name}.tsx`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const transformed = await transformWithOxc(source, `${name}.tsx`, { jsx: { runtime: 'classic', pragma: '_testJsx', pragmaFrag: 'Fragment' } });
  const deps = { _testJsx: jsx, Fragment: 'fragment', t, tn, getLang, ...adapters };
  return new Function(...Object.keys(deps), `${transformed.code}\nreturn ${name};`)(...Object.values(deps));
}

test('a resynced terminal or empty download clears stale model-list progress and refreshes the model list', async () => {
  const stale = { id: 'model', status: 'downloading', received: 42, total: 100 };
  const state: any = { settings: structuredClone(DEFAULT_SETTINGS), live: null, asrDownload: stale };
  const list = { source: { baseUrl: MODEL_BASE_URL, fromEnvironment: false }, download: stale,
    models: [{ id: 'model', name: 'Model', sizeMB: 50, note: { en: '', zh: '' } }] };
  let reads = 0;
  const ui = await transcriptionHarness(state, { api: async () => { reads++; return list; }, saveSettings: async () => true });
  await tick(); ui.render();
  for (const status of ['downloading', 'done', 'error', null]) {
    state.asrDownload = status ? { ...stale, status } : null;
    ui.render(); await tick(); ui.render();
    const buttons = ui.elements().filter((e) => e.type === 'button');
    if (status === 'downloading') assert.ok(buttons.some((e) => words(e) === 'Cancel'));
    else {
      assert.ok(!buttons.some((e) => words(e) === 'Cancel'));
      assert.equal(buttons.find((e) => words(e).startsWith('Download'))?.props.disabled, false);
    }
  }
  assert.equal(reads, 4);
  ui.unmount();
});

test('connection notices warn accurately, offer Reload after ten seconds, and clear on recovery', async () => {
  const state = { loaded: true, connected: false, notices: [] };
  let waited = false, previous: unknown, cleanup: (() => void) | undefined, reloads = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const render = await component('Notices', {
    useStore: (f: any) => f(state),
    useState: () => [waited, (value: boolean) => { waited = value; }],
    useEffect: (fn: () => (() => void) | undefined, deps: unknown[]) => { if (deps[0] !== previous) { cleanup?.(); previous = deps[0]; cleanup = fn(); } },
    setTimeout: (fn: () => void, ms: number) => { timers.set(1, { fn, ms }); return 1; }, clearTimeout: (id: number) => timers.delete(id),
    location: { reload: () => reloads++ },
  });
  let tree = render();
  assert.match(words(tree), /Recording status is unknown/);
  assert.doesNotMatch(words(tree), /continue on the server/);
  assert.equal(timers.get(1)?.ms, 10000);
  assert.ok(!all(tree).some((e) => e.type === 'button'));
  timers.get(1)!.fn(); tree = render();
  assert.match(words(tree), /Recording may have stopped/);
  all(tree).find((e) => e.type === 'button')!.props.onClick(); assert.equal(reloads, 1);
  try {
    setLang('zh'); assert.match(words(render()), /录音可能已停止/);
  } finally { setLang('en'); }
  state.connected = true; tree = render(); assert.equal(words(tree), ''); assert.equal(timers.size, 0);
  state.connected = false; render(); tree = render(); assert.match(words(tree), /Recording status is unknown/);
  state.loaded = false; assert.equal(words(render()), '');
  timers.get(1)!.fn(); assert.match(words(render()), /Recording may have stopped/);
  cleanup?.();
});
