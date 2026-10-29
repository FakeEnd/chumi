import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
import { t, tn, setLang } from '../web/src/i18n.ts';
import { TAGS, TOPICS } from '../web/src/pet/tags.ts';

type Element = { type: any; props: Record<string, any>; children: any[] };
const h = (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children: children.flat(Infinity) });
const all = (node: any): Element[] => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(all)];
const words = (node: any): string => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.children ?? []).map(words).join('');

// Use the shipped JSX with small hook/store adapters, as in assistant-ui.test.ts.
async function component(file: string, name: string, adapters: Record<string, any>) {
  const raw = readFileSync(new URL(`../web/src/components/${file}`, import.meta.url), 'utf8');
  const icons = Object.fromEntries([...raw.matchAll(/\bIcon\w+/g)].map(([name]) => [name, name]));
  const source = raw.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const transformed = await transformWithOxc(source, file, { jsx: { runtime: 'classic', pragma: '_testJsx', pragmaFrag: 'Fragment' } });
  const deps = { _testJsx: h, Fragment: 'fragment', t, tn, msg: (s: string) => s, useState: (v: any) => [v, () => {}], useEffect: () => {}, useRef: (current: any) => ({ current }), ...icons, ...adapters };
  return new Function(...Object.keys(deps), `${transformed.code}\nreturn ${name};`)(...Object.values(deps));
}

async function mounted(file: string, name: string, adapters: Record<string, any>) {
  const cells: any[] = [], timers = new Map<number, () => void>();
  let cursor = 0, dirty = false, nextTimer = 0, tree: Element, effects: Array<() => void> = [];
  const useState = (initial: any) => {
    const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [cells[i].value, (v: any) => { cells[i].value = typeof v === 'function' ? v(cells[i].value) : v; dirty = true; }];
  };
  const useRef = (current: any) => { const i = cursor++; return cells[i] ??= { current }; };
  const useEffect = (fn: () => any, deps: any[]) => {
    const i = cursor++, previous = cells[i];
    if (!previous || deps.some((v, j) => !Object.is(v, previous.deps[j]))) {
      effects.push(() => { previous?.cleanup?.(); cells[i] = { deps, cleanup: fn() }; });
    }
  };
  const renderComponent = await component(file, name, { useState, useRef, useEffect,
    setTimeout: (fn: () => void) => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: (id: number) => timers.delete(id), ...adapters });
  const render = () => {
    for (let i = 0; i < 20; i++) {
      cursor = 0; dirty = false; effects = []; tree = renderComponent();
      for (const effect of effects) effect();
      if (!dirty) return;
    }
    throw new Error('Component did not settle');
  };
  render();
  return { render, elements: () => all(tree), tick: () => { const tasks = [...timers.values()]; timers.clear(); tasks.forEach((fn) => fn()); render(); },
    unmount: () => { cells.forEach((c) => c?.cleanup?.()); } };
}

test('Windows settings shows a working Desktop pet navigation entry and the shell’s menu labels', async () => {
  const state: any = { platform: 'win32', appMode: true, settingsTab: 'language', settings: {
    ai: { compatible: { profiles: { default: {} }, preset: 'default' } }, integrations: { mybot: { exportDir: '' } },
    ui: { language: 'en' }, pet: { size: 1, enabled: true, cards: 'latest', tags: TAGS, say: TOPICS },
  } };
  const useStore = (selector: any) => selector(state);
  const settings = await component('SettingsDialog.tsx', 'SettingsDialog', {
    useStore, setState: (patch: any) => Object.assign(state, patch), saveSettings() {}, Dialog: 'dialog', PetSettings: 'pet-settings',
  });
  const pet = all(settings()).find((e) => e.type === 'button' && words(e) === 'Desktop pet');
  assert.ok(pet);
  pet.props.onClick();
  assert.equal(state.settingsTab, 'pet');
  assert.ok(all(settings()).some((e) => e.type === 'pet-settings'));
  const renderPet = await component('PetSettings.tsx', 'PetSettings', { useStore, saveSettings() {}, TAGS, TOPICS });
  for (const lang of ['en', 'zh'] as const) {
    setLang(lang);
    assert.match(words(renderPet()), /窗口 → 桌宠/);
    assert.match(words(renderPet()), /Alt/);
  }
  setLang('en');
  state.platform = 'darwin';
  assert.match(words(renderPet()), /Also in the menu bar: Window → Desktop Pet\./);
  assert.doesNotMatch(words(renderPet()), /Alt/);
});

test('pet size number edits survive pauses and settings events, committing on blur or Enter', async () => {
  const pet = { size: 1, enabled: true, cards: 'latest', tags: TAGS, say: TOPICS }, saved: any[] = [];
  const ui = await mounted('PetSettings.tsx', 'PetSettings', { TAGS, TOPICS,
    useStore: (sel: any) => sel({ platform: 'win32', settings: { pet } }), saveSettings: (patch: any) => saved.push(patch),
  });
  const number = () => ui.elements().find((e) => e.type === 'input' && e.props.type === 'number')!;
  const range = () => ui.elements().find((e) => e.type === 'input' && e.props.type === 'range')!;
  number().props.onFocus();
  for (const value of ['', '1', '12']) {
    number().props.onChange({ target: { value } }); ui.render(); ui.tick();
    assert.equal(number().props.value, value);
    assert.deepEqual(saved, []);
  }
  pet.size = 1.5; ui.render();
  assert.equal(number().props.value, '12', 'a settings event cannot overwrite focused typing');
  number().props.onChange({ target: { value: '122' } }); ui.render();
  number().props.onKeyDown({ key: 'Enter', currentTarget: { blur: () => number().props.onBlur() } }); ui.render();
  assert.equal(number().props.value, '120');
  assert.deepEqual(saved, [{ pet: { size: 1.2 } }]);
  pet.size = 1.2; ui.render();
  number().props.onFocus(); number().props.onChange({ target: { value: '' } }); ui.render(); number().props.onBlur(); ui.render();
  assert.equal(number().props.value, '120'); assert.equal(saved.length, 1);
  range().props.onChange({ target: { value: '130' } }); ui.render();
  range().props.onChange({ target: { value: '140' } }); ui.render();
  assert.equal(saved.length, 1);
  ui.tick();
  assert.deepEqual(saved.at(-1), { pet: { size: 1.4 } });
  ui.unmount();
});

test('closing pet settings without blur saves the number draft or pending slider once', async () => {
  for (const mode of ['number', 'range', 'blur', 'empty', 'unchanged', 'number-after-slider']) {
    const pet = { size: 1, enabled: true, cards: 'latest', tags: TAGS, say: TOPICS }, saved: any[] = [];
    const ui = await mounted('PetSettings.tsx', 'PetSettings', { TAGS, TOPICS,
      useStore: (sel: any) => sel({ platform: 'win32', settings: { pet } }), saveSettings: (patch: any) => saved.push(patch),
    });
    const number = () => ui.elements().find((e) => e.type === 'input' && e.props.type === 'number')!;
    const range = () => ui.elements().find((e) => e.type === 'input' && e.props.type === 'range')!;
    if (mode === 'range' || mode === 'number-after-slider') range().props.onChange({ target: { value: '140' } });
    if (mode !== 'range') {
      number().props.onFocus();
      if (mode !== 'unchanged') number().props.onChange({ target: { value: mode === 'empty' ? '' : '150' } });
      if (mode === 'blur') number().props.onBlur();
    }
    // Escape/outside-click removal may happen before either blur or another render.
    ui.unmount();
    assert.deepEqual(saved, mode === 'empty' || mode === 'unchanged' ? [] : [{ pet: { size: mode === 'range' ? 1.4 : 1.5 } }], mode);
    ui.tick();
    assert.equal(saved.length, mode === 'empty' || mode === 'unchanged' ? 0 : 1, 'cleanup cancels the old timer after flushing');
  }
});

test('vocabulary hints flush on unmount without blur and skip unchanged or pending saves', async () => {
  const glossary = ['Existing'];
  const state = { settings: { asr: { glossary, engine: 'sensevoice' } } }, saved: any[] = [];
  let resolve!: (ok: boolean) => void;
  const adapters = { useStore: (sel: any) => sel(state), speechSettingsBusy: () => false, SpeakerSettings: 'speakers', SpeechEngineSettings: 'engine',
    api: async () => ({ models: [] }), saveSettings: (patch: any) => { saved.push(patch); return new Promise<boolean>((r) => { resolve = r; }); },
  };
  const ui = await mounted('TranscriptionTab.tsx', 'TranscriptionTab', adapters);
  const field = () => ui.elements().find((e) => e.type === 'textarea')!;
  field().props.onBlur(); assert.equal(saved.length, 0);
  field().props.onChange({ target: { value: ' Existing， ' } }); ui.render();
  field().props.onBlur(); assert.equal(saved.length, 0, 'equivalent comma-separated entries do not save');
  field().props.onChange({ target: { value: 'Kaplan-Meier, AUROC，林老师' } }); ui.render();
  ui.unmount();
  assert.deepEqual(saved, [{ asr: { glossary: ['Kaplan-Meier', 'AUROC', '林老师'] } }]);
  resolve(true); await Promise.resolve();
  const next = await mounted('TranscriptionTab.tsx', 'TranscriptionTab', adapters);
  const nextField = () => next.elements().find((e) => e.type === 'textarea')!;
  nextField().props.onChange({ target: { value: 'New hint' } }); next.render();
  nextField().props.onBlur(); next.unmount();
  assert.equal(saved.length, 2, 'blur followed by removal sends only one request');
  resolve(true); await Promise.resolve();
});

test('vocabulary edits made during a save are flushed in order even after removal', async () => {
  const saved: any[] = []; let finish!: (ok: boolean) => void;
  const ui = await mounted('TranscriptionTab.tsx', 'TranscriptionTab', {
    useStore: (sel: any) => sel({ settings: { asr: { glossary: [], engine: 'sensevoice' } } }),
    speechSettingsBusy: () => false, SpeakerSettings: 'speakers', SpeechEngineSettings: 'engine', api: async () => ({ models: [] }),
    saveSettings: (patch: any) => { saved.push(patch); return new Promise<boolean>((resolve) => { finish = resolve; }); },
  });
  const field = () => ui.elements().find((e) => e.type === 'textarea')!;
  field().props.onChange({ target: { value: 'First' } }); ui.render(); field().props.onBlur();
  field().props.onChange({ target: { value: 'First, Second' } }); ui.unmount();
  assert.equal(saved.length, 1);
  finish(true); await Promise.resolve();
  assert.deepEqual(saved[1], { asr: { glossary: ['First', 'Second'] } });
  finish(true); await Promise.resolve();
});
