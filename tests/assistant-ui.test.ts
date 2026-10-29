import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
import { setLang, t } from '../web/src/i18n.ts';
import { digestProgress } from '../web/src/ai-progress.ts';

type Element = { type: any; props: Record<string, any>; children: any[] };
const h = (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children: children.flat(Infinity) });
const all = (node: any): Element[] => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(all)];
const words = (node: any): string => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.children ?? []).map(words).join('');

// Render the actual components with the same small JSX adapter used by the other UI tests.
async function component(file: string, name: string, adapters: Record<string, any>) {
  const source = readFileSync(new URL(`../web/src/components/${file}`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const transformed = await transformWithOxc(source, file, { jsx: { runtime: 'classic', pragma: '_testJsx', pragmaFrag: 'Fragment' } });
  const deps = { _testJsx: h, Fragment: 'fragment', t, digestProgress, msg: (s: string) => s, ...adapters };
  return new Function(...Object.keys(deps), `${transformed.code}\nreturn ${name};`)(...Object.values(deps));
}
const button = (tree: Element, label: string) => all(tree).find((e) => e.type === 'button' && words(e) === label);

test('cancelled cards can retry and speaker-label errors are translated', async () => {
  const retried: string[] = [];
  const render = await component('Assistant.tsx', 'OutputCard', {
    useStore: (selector: any) => selector({ deltas: {} }), refreshOutput: (id: string) => retried.push(id),
    fmtClock: String, ProjectContextSources: 'sources', DEPTH_LABEL: {},
  });
  const output = { id: 'summary', kind: 'final_summary', status: 'cancelled', created_at: 1, data: null };
  const card = (o: any) => render({ o, depth: 'standard', open: true, onToggle: () => {} });
  const cancelled = card(output);
  assert.match(words(cancelled), /Cancelled\./);
  assert.ok(button(cancelled, 'Retry'));
  button(cancelled, 'Retry')!.props.onClick();
  assert.deepEqual(retried, ['summary']);
  const message = 'Speaker labels changed. Regenerate the response to use the updated names.';
  try {
    setLang('zh');
    const error = card({ ...output, status: 'error', error: message });
    assert.match(words(error), /说话人标签已更改。请重新生成回答以使用更新后的名字。/);
    assert.ok(button(error, '重试'));
  } finally { setLang('en'); }
});

test('summary generation is available after cancellation but not while a summary is active or complete', async () => {
  let state: any = { live: null, profile: null, platform: 'darwin', settings: { audio: { source: 'mic' }, assist: { autoExplain: false, defaultDepth: 'standard' } }, data: { session: { id: 's', status: 'ended', created_at: 1, duration_ms: 1 }, segments: [{}], outputs: [], hasAudio: false } };
  let summaries = 0;
  const render = await component('TopBar.tsx', 'SessionToolbar', {
    useStore: (selector: any) => selector(state), fmtDate: String, fmtT: String, compactShortcutLabel: () => '',
    ResumeRecording: 'resume-recording', IconSpark: 'spark', IconCompact: 'compact', summarize: () => summaries++,
  });
  const toolbar = () => render({});
  for (const status of ['cancelled', 'error']) {
    state.data.outputs = [{ kind: 'final_summary', status }];
    const generate = button(toolbar(), 'Generate final summary');
    assert.ok(generate, status);
    generate.props.onClick();
  }
  assert.equal(summaries, 2);
  for (const status of ['pending', 'streaming', 'done']) {
    state.data.outputs = [{ kind: 'final_summary', status }];
    assert.equal(button(toolbar(), 'Generate final summary'), undefined, status);
  }
  state.data.outputs = [{ kind: 'final_summary', status: 'cancelled' }, { kind: 'final_summary', status: 'done' }];
  assert.equal(button(toolbar(), 'Generate final summary'), undefined);
});

test('summary and handoff show translated digest progress while waiting for the provider', async () => {
  const output = { id: 'summary', kind: 'final_summary', status: 'streaming', created_at: 1, data: { progress: { stage: 'digests', completed: 3, total: 9 } } };
  const render = await component('Assistant.tsx', 'OutputCard', {
    useStore: (selector: any) => selector({ deltas: {} }), fmtClock: String, ProjectContextSources: 'sources', DEPTH_LABEL: {},
  });
  const handoff = await component('Handoff.tsx', 'HandoffButton', {
    AGENT_NAMES: {},
    useStore: (selector: any) => selector({ data: { session: { id: 's' }, segments: [{}], handoff: { status: 'generating', output_id: 'summary' }, outputs: [output] } }),
  });
  const card = () => render({ o: output, depth: 'standard', open: true, onToggle: () => {} });
  assert.match(words(card()), /Summarising earlier parts 3\/9…/);
  assert.match(words(handoff()), /Summarising earlier parts 3\/9…/);
  try {
    setLang('zh');
    assert.match(words(card()), /正在整理前面的讨论 3\/9…/);
    assert.match(words(handoff()), /正在整理前面的讨论 3\/9…/);
  } finally { setLang('en'); }
  assert.equal(digestProgress({ ...output, status: 'done' }), null);
  assert.equal(digestProgress({ ...output, data: { progress: { stage: 'digests', completed: 10, total: 9 } } }), null);
  output.data = null as any;
  assert.match(words(card()), /Thinking…/);
});

test('retries replace failed answers and explanations, while unsuccessful regenerations keep the last good answer', async () => {
  const output = (id: string, status: string, parent_id: string | null = null, kind = 'answer') => ({ id, kind, status, parent_id, created_at: Number(id.slice(1)), data: null });
  const state: any = { data: { outputs: [output('o1', 'error')] }, hiddenCards: [] };
  const render = await component('Assistant.tsx', 'AssistantPanel', {
    useStore: (selector: any) => selector(state), useMemo: (fn: any) => fn(), useState: (initial: any) => [initial, () => {}],
  });
  const visible = () => all(render()).filter((e) => e.props.o).map((e) => e.props.o.id);
  assert.deepEqual(visible(), ['o1']);
  for (const kind of ['answer', 'explain']) {
    for (const parent of ['error', 'cancelled']) {
      for (const status of ['pending', 'streaming', 'error', 'cancelled', 'done']) {
        state.data.outputs = [output('o1', parent, null, kind), output('o2', status, 'o1', kind)];
        assert.deepEqual(visible(), ['o2'], `${kind}: ${parent} → ${status}`);
      }
    }
  }
  state.data.outputs = [output('o1', 'error'), output('o2', 'error', 'o1'), output('o3', 'error', 'o2')];
  assert.deepEqual(visible(), ['o3']);
  for (const status of ['error', 'cancelled']) {
    state.data.outputs = [output('o1', 'done'), output('o2', status, 'o1')];
    assert.deepEqual(visible(), ['o2', 'o1'], status);
  }
  state.data.outputs = [output('o1', 'done', null, 'explain'), output('o2', 'done', 'o1', 'explain')];
  assert.deepEqual(visible(), ['o2', 'o1'], 'a deeper explanation keeps the original successful explanation');
});
