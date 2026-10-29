import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';

type Element = { type: any; props: Record<string, any>; children: any[] };
const jsx = (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children: children.flat(Infinity) });
const all = (node: any): Element[] => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(all)];
const words = (node: any): string => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.children ?? []).map(words).join('');
const source = readFileSync(new URL('../web/src/components/Transcript.tsx', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const transformed = await transformWithOxc(source, 'Transcript.tsx', { jsx: { runtime: 'classic', pragma: '_testJsx', pragmaFrag: 'Fragment' } });

// Exercise the actual handlers and effects, including browser scroll events after layout changes.
function harness() {
  let cursor = 0, selection: any = null, tree: Element, now = 10000, playbackScrolls = 0;
  const slots: any[] = [], effects: Array<() => void> = [], cleanups: Array<() => void> = [];
  const listeners = new Map<string, () => void>();
  const copied: string[] = [];
  const line = { id: 1, t_start: 0, t_end: 1000, text: 'Selected sentence' };
  const state: any = { data: { session: { id: 's' }, segments: [line], timeline: [], frames: [] }, live: { session: { id: 's' } }, partials: {}, focus: null, playingSeg: null };
  class Node {
    dataset = { t: '0', tend: '1000' };
    closest() { return this; }
  }
  const node = new Node();
  const host = {
    scrollTop: 100, scrollHeight: 200, clientHeight: 100,
    contains: (n: unknown) => n === node,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, left: 0, width: 600 }),
    querySelector: () => null as any,
  };
  const effect = (fn: () => void | (() => void), deps: unknown[]) => {
    const i = cursor++, old = slots[i];
    if (!old || deps.some((v, j) => v !== old[j])) {
      slots[i] = deps;
      effects.push(() => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); });
    }
  };
  const adapters = {
    _testJsx: jsx, Fragment: 'fragment', memo: (f: any) => f,
    useStore: (f: any) => f(state), getState: () => state,
    useRef: (value: any) => slots[cursor++] ??= { current: value },
    useState: (value: any) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value;
      return [slots[i], (next: any) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useEffect: effect, useLayoutEffect: effect,
    useCallback: (fn: any, deps: any[]) => {
      const i = cursor++, old = slots[i];
      if (!old || deps.some((d, j) => d !== old.deps[j])) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useMemo: (f: any) => f(),
    requestAnimationFrame: (f: () => void) => effects.push(f),
    window: { getSelection: () => selection, addEventListener: (name: string, f: () => void) => listeners.set(name, f), removeEventListener: (name: string) => listeners.delete(name) },
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    Element: Node, Date: { now: () => now }, t: (s: string, vars: Record<string, unknown> = {}) => s.replace(/\{(\w+)\}/g, (_, key) => String(vars[key])), msg: (s: string) => s, fmtT: String,
    SpeakersPanel: 'speakers', SpeakerControl: 'speaker', IconPlay: 'play',
  };
  const renderComponent = new Function(...Object.keys(adapters), `${transformed.code}\nreturn Transcript;`)(...Object.values(adapters));
  const render = () => {
    cursor = 0; tree = renderComponent();
    all(tree).find((e) => e.props.ref)!.props.ref.current = host;
    while (effects.length) effects.shift()!();
  };
  const scroller = () => all(tree).find((e) => e.props.role === 'log')!;
  render(); render();
  return {
    state, host, render, scroller, copied, release: (event = 'pointerup') => listeners.get(event)!(),
    advance: (ms: number) => { now += ms; },
    play: (id: number) => {
      host.querySelector = () => ({ getBoundingClientRect: () => ({ top: -50, bottom: -10 }), scrollIntoView: () => { playbackScrolls++; } });
      state.playingSeg = id; render();
    },
    playbackScrolls: () => playbackScrolls,
    toolbar: () => all(tree).find((e) => e.props.className === 'sel-toolbar'),
    returnLive: () => all(tree).find((e) => e.props.className === 'return-live'),
    select: () => { selection = { isCollapsed: false, anchorNode: node, focusNode: node, rangeCount: 1, toString: () => line.text, getRangeAt: () => ({ getBoundingClientRect: () => ({ top: 80, left: 20 }) }), removeAllRanges: () => { selection = null; } }; },
    selection: () => selection,
    clearSelection: () => { selection = null; },
    grow: (final = false) => {
      host.scrollHeight += 100;
      if (final) state.data.segments = [...state.data.segments, { ...line, id: state.data.segments.length + 1 }];
      else state.partials = { mic: { t: 1000, text: 'More words' } };
      render();
    },
    cleanup: () => cleanups.forEach((f) => f()),
  };
}

test('live updates pause during a selection drag and resume after release outside the transcript', () => {
  const h = harness();
  h.scroller().props.onPointerDown();
  const top = h.host.scrollTop;
  h.grow(); assert.equal(h.host.scrollTop, top);
  h.release(); h.grow(); assert.equal(h.host.scrollTop, h.host.scrollHeight);
  h.cleanup();
});

test('selected live text stays still and its toolbar survives scroll events', () => {
  const h = harness();
  h.select(); h.scroller().props.onMouseUp(); h.render();
  const toolbar = h.toolbar(); assert.ok(toolbar);
  const top = h.host.scrollTop;
  h.grow(); assert.equal(h.host.scrollTop, top);
  h.scroller().props.onScroll(); h.render();
  assert.deepEqual(h.toolbar()?.props.style, toolbar.props.style);
  h.clearSelection(); h.grow(); assert.equal(h.host.scrollTop, top, 'the open toolbar still holds the passage in place');
  h.scroller().props.onMouseUp(); h.render(); h.grow(); assert.equal(h.host.scrollTop, h.host.scrollHeight);
  h.cleanup();
});

test('Copy clears the selection and resumes following without inflating the later new-lines count', () => {
  const h = harness();
  h.select(); h.scroller().props.onMouseUp(); h.render();
  const top = h.host.scrollTop;
  h.grow(true); h.grow(true); assert.equal(h.host.scrollTop, top);
  all(h.toolbar()).find((e) => e.type === 'button' && words(e) === 'Copy')!.props.onClick();
  h.render(); h.release('blur');
  assert.deepEqual(h.copied, ['[0] Selected sentence']); assert.equal(h.selection(), null); assert.equal(h.toolbar(), undefined);
  h.grow(true); assert.equal(h.host.scrollTop, h.host.scrollHeight);
  h.host.scrollTop = 20; h.scroller().props.onScroll(); h.render();
  assert.equal(words(h.returnLive()), 'Return to live ↓', 'the held lines were already caught up');
  h.grow(true); h.render(); assert.equal(words(h.returnLive()), '1 new line · Return to live ↓');
  h.cleanup();
});

test('a lingering selection without an open toolbar cannot silently suspend live following', () => {
  const h = harness();
  h.select(); h.grow(true); assert.equal(h.host.scrollTop, h.host.scrollHeight);
  h.cleanup();
});

test('opening another meeting clears the old selection toolbar and its follow hold', () => {
  const h = harness();
  h.select(); h.scroller().props.onMouseUp(); h.render(); assert.ok(h.toolbar());
  h.state.data.session = { id: 'next' }; h.state.live.session = { id: 'next' };
  h.render(); h.render(); h.grow(true);
  assert.equal(h.toolbar(), undefined); assert.equal(h.host.scrollTop, h.host.scrollHeight);
  h.cleanup();
});

test('cancelled pointer gestures do not leave live following suspended', () => {
  for (const event of ['pointercancel', 'blur']) {
    const h = harness();
    h.scroller().props.onPointerDown(); h.grow();
    h.release(event); h.grow(); assert.equal(h.host.scrollTop, h.host.scrollHeight);
    h.cleanup();
  }
});

test('scrollbar drags and middle-click autoscroll pause playback following for four seconds', () => {
  const h = harness();
  assert.equal(h.scroller().props.tabIndex, 0);
  h.host.scrollTop = 20; h.scroller().props.onScroll(); h.render();
  h.advance(3000); h.play(1); assert.equal(h.playbackScrolls(), 0);
  h.advance(1001); h.play(2); assert.equal(h.playbackScrolls(), 1);
  h.cleanup();
});

test('live auto-scroll and smooth playback scrolling do not count as reader scrolling', () => {
  const h = harness();
  h.grow(); h.scroller().props.onScroll(); h.render();
  h.play(1); assert.equal(h.playbackScrolls(), 1);
  h.host.scrollTop = 30; h.scroller().props.onScroll(); h.render();
  h.advance(1500); h.play(2); assert.equal(h.playbackScrolls(), 2);
  h.cleanup();
});

test('grabbing the scrollbar interrupts a programmatic jump and pauses follow until released', () => {
  const h = harness();
  h.play(1); assert.equal(h.playbackScrolls(), 1);
  h.scroller().props.onPointerDown();
  h.host.scrollTop = 20; h.scroller().props.onScroll(); h.render();
  h.advance(5000); h.play(2); assert.equal(h.playbackScrolls(), 1);
  h.release(); h.play(3); assert.equal(h.playbackScrolls(), 2);
  h.cleanup();
});
