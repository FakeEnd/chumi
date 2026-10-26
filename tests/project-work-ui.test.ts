import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
import { ACTION_STATUSES, isActionResultUrl, type ActionProgress, type ProjectAgenda } from '../shared/project-work.ts';
import { AGENT_NAMES } from '../shared/agents.ts';

type Element = { type: any; props: Record<string, any>; children: any[] };
const h = (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children: children.flat(Infinity) });
const words = (node: any): string => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.children ?? []).map(words).join('');
const all = (node: any): Element[] => !node || typeof node !== 'object' ? [] : [node, ...[...(node.children ?? []), node.props?.footer].flatMap(all)];
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));
const baseProgress = (): ActionProgress => ({ status: 'not_started', note: '', results: [], updatedAt: null, version: 0 });

// Run the actual component event handlers with small deterministic hook/JSX adapters.
// This exercises draft ownership and request ordering without a browser or live services.
async function componentHarness(file: string, name: string, props: Record<string, any>, adapters: Record<string, any> = {}) {
  const cells: any[] = [];
  let cursor = 0, dirty = false, tree: Element, effects: Array<() => void> = [];
  const useState = (initial: any) => {
    const index = cursor++;
    if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [cells[index].value, (value: any) => { cells[index].value = typeof value === 'function' ? value(cells[index].value) : value; dirty = true; }];
  };
  const useRef = (value: any) => { const index = cursor++; return cells[index] ??= { current: value }; };
  const useEffect = (fn: () => void, deps: any[]) => {
    const index = cursor++, previous = cells[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) { cells[index] = deps; effects.push(fn); }
  };
  const source = readFileSync(new URL(`../web/src/components/${file}`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const transformed = await transformWithOxc(source, file, { jsx: { runtime: 'classic', pragma: '_testJsx', pragmaFrag: 'Fragment' } });
  const deps = { useState, useRef, useEffect, _testJsx: h, Fragment: 'fragment', t: (s: string) => s, msg: (s: string) => s, fmtDate: String, ACTION_STATUSES, isActionResultUrl, ...adapters };
  const renderComponent = new Function(...Object.keys(deps), `${transformed.code}\nreturn ${name};`)(...Object.values(deps));
  const render = (next = props) => {
    props = next;
    for (let tries = 0; tries < 20; tries++) {
      cursor = 0; dirty = false; effects = []; tree = renderComponent(props);
      for (const effect of effects) effect();
      if (!dirty) return tree;
    }
    throw new Error('Component did not settle');
  };
  const find = (predicate: (element: Element) => boolean) => { const result = all(tree).find(predicate); assert.ok(result, 'Element not found'); return result; };
  render();
  return { render, find, button: (label: string) => find((e) => e.type === 'button' && words(e) === label),
    input: (label: string) => {
      const field = find((e) => e.type === 'label' && words(e).startsWith(label));
      const input = all(field).find((e) => ['input', 'textarea', 'select'].includes(e.type)); assert.ok(input); return input;
    }, text: () => words(tree), elements: () => all(tree) };
}

test('progress refresh preserves the draft and requires an explicit version comparison', async () => {
  const calls: any[] = [];
  const props = { itemId: 'a', progress: baseProgress() };
  const ui = await componentHarness('ActionProgress.tsx', 'ActionProgress', props, { updateActionProgress: async (...args: any[]) => { calls.push(args); return null; } });
  ui.button('Update progress').props.onClick(); ui.render();
  ui.input('Progress note').props.onChange({ target: { value: 'My unsaved note' } }); ui.render();
  ui.render({ ...props, progress: { ...baseProgress(), version: 2, note: 'Remote note' } });
  assert.equal(ui.input('Progress note').props.value, 'My unsaved note');
  assert.equal(ui.button('Save progress').props.disabled, true);
  ui.button('Use this version and keep my edits').props.onClick(); ui.render();
  ui.button('Save progress').props.onClick(); await tick(); ui.render();
  assert.equal(calls[0][1].expectedVersion, 2);
  assert.equal(calls[0][1].note, 'My unsaved note');
  assert.equal(ui.input('Progress note').props.value, 'My unsaved note', 'a failed update keeps the editor');
});

test('saving progress disables the input fieldset and an older response cannot replace a newer version', async () => {
  const pending = defer<ActionProgress>(); const saved: ActionProgress[] = [];
  const props = { itemId: 'a', progress: baseProgress(), onSaved: (p: ActionProgress) => saved.push(p) };
  const ui = await componentHarness('ActionProgress.tsx', 'ActionProgress', props, { updateActionProgress: () => pending.promise });
  ui.button('Update progress').props.onClick(); ui.render();
  ui.input('Progress note').props.onChange({ target: { value: 'Submitted note' } }); ui.render();
  ui.button('Save progress').props.onClick(); ui.render();
  assert.equal(ui.find((e) => e.type === 'fieldset').props.disabled, true);
  ui.render({ ...props, progress: { ...baseProgress(), version: 2, note: 'Newer saved note' } });
  pending.resolve({ ...baseProgress(), version: 1, note: 'Submitted note' }); await tick(); ui.render();
  assert.equal(saved.length, 0);
  assert.equal(ui.input('Progress note').props.value, 'Submitted note');
  assert.equal(ui.button('Save progress').props.disabled, true);
});

test('progress results stop at eight and invalid URLs never submit', async () => {
  let calls = 0;
  const ui = await componentHarness('ActionProgress.tsx', 'ActionProgress', { itemId: 'a', progress: { ...baseProgress(), results: Array.from({ length: 8 }, (_, i) => ({ label: `Result ${i}`, url: 'javascript:alert(1)' })) } }, { updateActionProgress: async () => { calls++; return null; } });
  ui.button('Update progress').props.onClick(); ui.render();
  assert.equal(ui.button('Add result link').props.disabled, true);
  ui.button('Save progress').props.onClick(); await tick(); ui.render();
  assert.equal(calls, 0);
  assert.match(ui.text(), /Give each result a label/);
});

test('agenda refresh keeps unsaved text and saving uses the explicitly chosen version', async () => {
  const calls: any[] = [];
  const props = { projectId: 'p', agenda: { text: 'Old agenda', version: 0, updatedAt: null }, onSaved: () => {}, onRefresh: async () => {} };
  const ui = await componentHarness('ProjectBrief.tsx', 'AgendaEditor', props, { api: async (...args: any[]) => { calls.push(args); throw new Error('Save rejected'); } });
  ui.button('Edit agenda').props.onClick(); ui.render();
  ui.input('Discussion points').props.onChange({ target: { value: 'My draft agenda' } }); ui.render();
  ui.render({ ...props, agenda: { text: 'Remote agenda', version: 3, updatedAt: 1 } });
  assert.equal(ui.input('Discussion points').props.value, 'My draft agenda');
  assert.equal(ui.button('Save agenda').props.disabled, true);
  ui.button('Use this version and keep my edits').props.onClick(); ui.render();
  ui.button('Save agenda').props.onClick(); await tick(); ui.render();
  assert.deepEqual(calls[0][1].body, { text: 'My draft agenda', expectedVersion: 3 });
  assert.equal(ui.input('Discussion points').props.value, 'My draft agenda');
});

test('an agenda response cannot overwrite a newer saved agenda', async () => {
  const pending = defer<{ agenda: ProjectAgenda }>(); const saved: ProjectAgenda[] = [];
  const props = { projectId: 'p', agenda: { text: '', version: 0, updatedAt: null }, onSaved: (a: ProjectAgenda) => saved.push(a), onRefresh: async () => {} };
  const ui = await componentHarness('ProjectBrief.tsx', 'AgendaEditor', props, { api: () => pending.promise });
  ui.button('Edit agenda').props.onClick(); ui.render();
  ui.input('Discussion points').props.onChange({ target: { value: 'Submitted agenda' } }); ui.render();
  ui.button('Save agenda').props.onClick(); ui.render();
  assert.equal(ui.input('Discussion points').props.disabled, true);
  ui.render({ ...props, agenda: { text: 'Newest agenda', version: 2, updatedAt: 2 } });
  pending.resolve({ agenda: { text: 'Submitted agenda', version: 1, updatedAt: 1 } }); await tick(); ui.render();
  assert.equal(saved.length, 0);
  assert.equal(ui.input('Discussion points').props.value, 'Submitted agenda');
});

test('clipboard failure offers the exact prompt and never reports successful copying', async () => {
  const notices: string[] = [];
  const state = { data: { session: { id: 's', title: 'Meeting', project_id: 'p' }, handoff: { id: 'h', status: 'confirmed', items: [], project: { id: 'p', name: 'Project' }, project_mismatch: false, confirmed_at: 1, confirmed_revision: 1, freshness: { stale: false, detail: {} } } }, live: null };
  const ui = await componentHarness('Handoff.tsx', 'HandoffDialog', {}, {
    useStore: (selector: any) => selector(state), api: async () => ({ agents: [] }), AGENT_NAMES,
    loadHandoffDestination: () => 'copy', saveHandoffDestination: () => {},
    continueHandoff: async () => ({ prompt: 'Exact reviewed handoff prompt', launched: false }),
    navigator: { clipboard: { writeText: async () => { throw new Error('Denied'); } } },
    notify: (_level: string, message: string) => notices.push(message), fmtClock: String,
    Dialog: 'dialog', ProjectSelect: 'project-select', ActionProgress: 'action-progress',
    plural: (_n: number, one: string) => one,
  });
  ui.button('Copy instructions').props.onClick(); await tick(); ui.render();
  assert.equal(notices.length, 0);
  assert.equal(ui.input('Handoff instructions').props.value, 'Exact reviewed handoff prompt');
  assert.equal(ui.input('Handoff instructions').props.readOnly, true);
  assert.match(ui.text(), /Clipboard access failed/);
});

test('handoff destination defaults to Codex app, remembers valid choices, and handles unavailable storage', () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('../web/src/handoffDestination.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
  let stored: string | null = null;
  const create = (storage: any) => new Function('localStorage', 'isAgent', `${source}\nreturn { loadHandoffDestination, saveHandoffDestination };`)(storage, (v: string) => Object.keys(AGENT_NAMES).includes(v));
  const pref = create({ getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
  assert.equal(pref.loadHandoffDestination(), 'codex-app');
  pref.saveHandoffDestination('codex'); assert.equal(pref.loadHandoffDestination(), 'codex');
  stored = 'invalid'; assert.equal(pref.loadHandoffDestination(), 'codex-app');
  const unavailable = create({ getItem: () => { throw new Error('Disabled'); }, setItem: () => { throw new Error('Disabled'); } });
  assert.equal(unavailable.loadHandoffDestination(), 'codex-app');
  assert.doesNotThrow(() => unavailable.saveHandoffDestination('copy'));
});
