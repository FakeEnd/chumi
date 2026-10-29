import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';

type Element = { type: any; props: Record<string, any>; children: any[] };
const h = (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children: children.flat(Infinity) });
const all = (node: any): Element[] => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(all)];
const words = (node: any): string => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.children ?? []).map(words).join('');
const tick = () => new Promise<void>((r) => setImmediate(r));

async function component(file: string, name: string, adapters: Record<string, any>) {
  const source = readFileSync(new URL(`../web/src/components/${file}`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const transformed = await transformWithOxc(source, file, { jsx: { runtime: 'classic', pragma: '_testJsx', pragmaFrag: 'Fragment' } });
  const state: any[] = [];
  let cursor = 0;
  const deps = { _testJsx: h, Fragment: 'fragment', t: (s: string) => s, useState: (initial: any) => {
    const index = cursor++; if (!(index in state)) state[index] = initial;
    return [state[index], (next: any) => { state[index] = next; }];
  }, ...adapters };
  const render = new Function(...Object.keys(deps), `${transformed.code}\nreturn ${name};`)(...Object.values(deps));
  return (props: any = {}) => { cursor = 0; return render(props); };
}

test('Claude resume requires confirmation, reports failure and refreshes provider status on success', async () => {
  let allowed = false, fail = false, calls = 0;
  let stored: any;
  const render = await component('ClaudeResume.tsx', 'ClaudeResume', {
    confirm: () => allowed, setState: (s: any) => { stored = s; },
    api: async (path: string, options: any) => {
      calls++; assert.equal(path, '/api/provider/claude/clear-overage'); assert.deepEqual(options, { body: {} });
      if (fail) throw new Error('Resume failed');
      return { id: 'claude-cli', ready: true };
    },
  });
  const click = () => all(render()).find((e) => e.type === 'button')!.props.onClick();
  click(); await tick(); assert.equal(calls, 0);
  allowed = true; fail = true; click();
  assert.equal(all(render()).find((e) => e.type === 'button')!.props.disabled, true);
  await tick(); assert.match(words(render()), /Resume failed/);
  fail = false; click(); await tick();
  assert.deepEqual(stored, { provider: { id: 'claude-cli', ready: true } });
  assert.ok(!words(render()).includes('Resume failed'));
});


test('Anthropic key controls validate input, show failures, confirm removal and apply returned status', async () => {
  let effect: (() => void) | undefined, allowed = false, fail = false;
  const requests: any[] = [];
  let stored: any;
  const render = await component('AnthropicKeySettings.tsx', 'AnthropicKeySettings', {
    useStore: (selector: any) => selector({ platform: 'darwin' }),
    useEffect: (run: () => void) => { effect ??= run; },
    confirm: () => allowed, setState: (s: any) => { stored = s; },
    api: async (_path: string, options?: any) => {
      if (!options) return { stored: false };
      requests.push(options);
      if (fail) throw new Error('That does not look like an API key.');
      return { id: 'anthropic-api', ready: options.method !== 'DELETE' };
    },
  });
  const button = (name: string) => all(render()).find((e) => e.type === 'button' && words(e) === name)!;
  render(); effect!(); await tick();
  assert.equal(button('Save key').props.disabled, true);
  assert.equal(button('Remove key'), undefined);
  const input = () => all(render()).find((e) => e.type === 'input')!;
  input().props.onChange({ target: { value: '  bad  ' } });
  fail = true; button('Save key').props.onClick(); await tick();
  assert.match(words(render()), /That does not look like an API key/);
  assert.equal(input().props.value, '  bad  ');
  assert.deepEqual(requests[0], { body: { key: 'bad' } });
  fail = false; input().props.onChange({ target: { value: 'valid-synthetic-key-value' } });
  button('Save key').props.onClick(); await tick();
  assert.deepEqual(stored, { provider: { id: 'anthropic-api', ready: true } });
  assert.equal(input().props.value, '');
  assert.match(words(render()), /saved in macOS Keychain/);
  button('Remove key').props.onClick(); await tick(); assert.equal(requests.length, 2);
  allowed = true; fail = true; button('Remove key').props.onClick(); await tick();
  assert.ok(button('Remove key'), 'failed deletion keeps the stored key state');
  fail = false; button('Remove key').props.onClick(); await tick();
  assert.deepEqual(requests.at(-1), { method: 'DELETE' });
  assert.equal(button('Remove key'), undefined);
  assert.match(words(render()), /API key removed/);
});


test('local model advice shares the saved context choice and tolerates custom or blank limits', async () => {
  const advice = await import('../shared/local-model-advice.ts');
  let effect: (() => void) | undefined, selected = 0;
  const hardware = { platform: 'darwin', arch: 'arm64', osRelease: '25.0.0', chip: 'Fixture', cores: 8,
    memoryBytes: 16 * advice.GiB, homeDiskFreeBytes: 100 * advice.GiB, acceleration: 'metal', speechModel: 'fixture',
    systemReserveBytes: 3 * advice.GiB, speechReserveBytes: 2 * advice.GiB, modelBudgetBytes: 10 * advice.GiB };
  const render = await component('LocalModelAdvice.tsx', 'LocalModelAdvice', {
    ...advice, msg: (s: string) => s, LocalModelDownloadControls: 'downloads',
    useStore: (selector: any) => selector({ settings: { asr: { model: 'fixture' } } }),
    useEffect: (run: () => void) => { effect ??= run; }, api: async () => hardware,
  });
  const props = { preset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', serviceReady: true, installedIds: [], onDownloaded() {}, onContextChange: (n: number) => { selected = n; } };
  render({ ...props, context: 8192 }); effect!(); await tick();
  for (const context of [NaN, 65536]) {
    const tree = render({ ...props, context });
    assert.match(words(tree), /custom request limit can still be saved/);
    assert.equal(all(tree).find((e) => e.type === 'downloads')!.props.model, undefined);
  }
  const tree = render({ ...props, context: 8192 });
  assert.equal(all(tree).find((e) => e.type === 'downloads')!.props.context, 8192);
  const select = all(tree).find((e) => e.type === 'select')!;
  select.props.onChange({ target: { value: '16384' } });
  assert.equal(selected, 16384);
});
