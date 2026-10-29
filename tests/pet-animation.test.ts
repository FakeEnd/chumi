import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
import { PetBrain } from '../web/src/pet/brain.ts';

class Element {
  children: Element[] = []; dataset: Record<string, string> = {}; attrs = new Map<string, string>(); writes = 0;
  styleWrites = 0;
  style = new Proxy({ setProperty() {} } as any, { set: (o, k, v) => { this.styleWrites++; o[k] = v; return true; } });
  className = ''; textContent = '';
  setAttribute(k: string, v: string) { this.writes++; this.attrs.set(k, v); }
  appendChild(child: Element) { this.children.push(child); }
  get firstElementChild() { return this.children[0]; }
  querySelectorAll() { return this.children; }
  set innerHTML(html: string) {
    const svg = new Element();
    for (const [, key] of html.matchAll(/data-k="([^"]+)"/g)) { const e = new Element(); e.dataset.k = key; svg.children.push(e); }
    this.children = [svg];
  }
}

async function loadClass(file: string, name: string, deps: Record<string, any>) {
  const source = readFileSync(new URL(`../web/src/pet/${file}`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export type \{.*;\r?\n/gm, '').replace(/^export /gm, '');
  const { code } = await transformWithOxc(source, file);
  return new Function(...Object.keys(deps), `${code}\nreturn ${name};`)(...Object.values(deps));
}

test('the rig skips hidden effects and identical attributes, and hidden bubbles write no styles', async () => {
  const document = { createElement: () => new Element(), createElementNS: () => new Element(), head: new Element() };
  const PetRig = await loadClass('rig.ts', 'PetRig', { document });
  const PetView = await loadClass('view.ts', 'PetView', { document, PetRig });
  const rig = new PetRig(), nodes = (rig as any).n as Record<string, Element>;
  rig.draw(10);
  const hidden = ['bar0', 'bar4', 'pencil', 'lines', 'dot0', 'z0', 'heart0', 'sp0'];
  for (const key of hidden) assert.equal(nodes[key].writes, 0, key);
  rig.draw(11);
  for (const key of hidden) assert.equal(nodes[key].writes, 0, key);
  rig.setMood('listen', 12); rig.note(12); rig.draw(12.4);
  assert.ok(nodes.bar0.writes > 0); assert.ok(nodes.pencil.writes > 0);
  rig.setMood('idle', 13); rig.draw(14, true);
  const count = Object.values(nodes).reduce((n, e) => n + e.writes, 0);
  rig.draw(200, true);
  assert.equal(Object.values(nodes).reduce((n, e) => n + e.writes, 0), count, 'still poses make zero attribute writes');
  const view = new PetView();
  const bubble = view.bubble as unknown as Element, initial = bubble.styleWrites;
  view.draw(1, true); view.draw(2, true);
  assert.equal(bubble.styleWrites, initial);
  view.say({ text: 'Hello' }, 3); view.draw(3, true, true);
  assert.equal(bubble.style.opacity, '1.000');
  const shown = bubble.styleWrites; view.draw(4, true, true);
  assert.equal(bubble.styleWrites, shown, 'reduced-motion bubbles do not bob');
  view.hush(5); view.draw(5, true, true);
  assert.equal(bubble.style.visibility, 'hidden'); assert.equal(view.hasBubble, false);
  const hiddenCount = bubble.styleWrites; view.draw(6, true, true);
  assert.equal(bubble.styleWrites, hiddenCount);
});

test('idle and sleep keep moving, and reactions ease into idle, pause and sleep', async () => {
  const document = { createElement: () => new Element(), createElementNS: () => new Element() };
  const PetRig = await loadClass('rig.ts', 'PetRig', { document });
  const rig = new PetRig(), nodes = rig.n as Record<string, Element>;
  const body = new Set(), ears = new Set(), star = new Set(), eyes = new Set();
  for (let i = 0; i < 96; i++) {
    rig.draw(i / 12);
    body.add(nodes.rig.attrs.get('transform')); ears.add(nodes.earL.attrs.get('transform'));
    star.add(nodes.star.attrs.get('transform')); eyes.add(nodes.openL.attrs.get('transform'));
  }
  for (const [name, poses] of [['breathing', body], ['ears', ears], ['star', star], ['blinking', eyes]] as const) assert.ok(poses.size > 1, name);
  rig.setMood('sleep', 8); rig.draw(8.4);
  const z = nodes.z0.attrs.get('y'); rig.draw(8.5);
  assert.notEqual(nodes.z0.attrs.get('y'), z, 'sleeping zzz keep floating');
  for (const mood of ['idle', 'paused', 'sleep']) {
    const r = new PetRig();
    const arm = () => Number(r.n.armL.attrs.get('transform').match(/rotate\(([-\d.]+)\)/)[1]);
    r.setMood('happy', 0); r.draw(2); const start = arm();
    r.setMood(mood, 2); r.draw(2); assert.equal(arm(), start, mood);
    r.draw(2.14); assert.ok(arm() > 10 && arm() < start, `${mood}: halfway through the transition`);
    r.draw(2.3); assert.ok(Math.abs(arm()) < 6, `${mood}: settled arms`);
  }
});

test('the frame scheduler chains time-gated rAF frames, coalesces wakes, and cancels hidden work', async () => {
  const frames = new Map<number, () => void>(), timers = new Map<number, () => void>();
  let id = 0, draws = 0, delay = Infinity, time = 0;
  const setTimeout = (fn: () => void) => { timers.set(++id, fn); return id; };
  const deps = { window: { setTimeout }, clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (fn: () => void) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (id: number) => frames.delete(id), performance: { now: () => time * 1000 },
  };
  const source = readFileSync(new URL('../web/src/pet/loop.ts', import.meta.url), 'utf8').replace('export class', 'class');
  const { code } = await transformWithOxc(source, 'loop.ts');
  const Loop = new Function(...Object.keys(deps), `${code}\nreturn PetLoop;`)(...Object.values(deps));
  const loop = new Loop(() => { draws++; loop.wake(); return delay; });
  const frame = () => { const work = [...frames.values()]; frames.clear(); work.forEach((f) => f()); };
  loop.wake(); loop.wake(); assert.equal(frames.size, 1); frame();
  assert.equal(draws, 1); assert.equal(frames.size, 0); assert.equal(timers.size, 0);
  delay = 90; loop.wake(); frame(); assert.equal(timers.size, 1);
  loop.wake(); assert.equal(timers.size, 0); assert.equal(frames.size, 1);
  loop.stop(); assert.equal(frames.size, 0);
  for (const fps of [30, 12, 15]) {
    delay = 1 / fps; time = 0; draws = 0; loop.wake(); frame();
    for (let i = 1; i <= 60; i++) { time = i / 60; loop.wake(); frame(); }
    assert.equal(draws, fps + 1, `${fps} fps on a 60 Hz display, including the initial draw`);
    assert.equal(timers.size, 0, 'animation does not add a timer before each rAF');
    assert.equal(frames.size, 1, 'incoming levels keep a single animation loop');
    loop.stop(); assert.equal(frames.size, 0); assert.equal(timers.size, 0);
  }
});

test('the page animates idle and sleep at lower rates, eases transitions, and stops for reduced motion', () => {
  const source = readFileSync(new URL('../web/src/pet/main.ts', import.meta.url), 'utf8').split('// ------------------------------------------------------------------ frames')[1];
  let draw!: (t: number) => number, time = 10, wakes = 0, stops = 0;
  const motion = { matches: false, addEventListener: (_: string, fn: () => void) => { events.motion = fn; } };
  const events: Record<string, () => void> = {};
  const brain = new PetBrain(), pet = { enabled: true }, document = { hidden: false, addEventListener: (name: string, fn: () => void) => { events[name] = fn; } };
  const still: boolean[] = [], view = { saying: null as any, hasBubble: false,
    rig: { level: 0, petting: 0, current: 'idle', setMood(mood: string) { this.current = mood; } }, hush() { this.saying = null; },
    draw(_t: number, rigStill: boolean, reduced: boolean) { still.push(rigStill); if (reduced) this.hasBubble = !!this.saying; },
  };
  // The page's frame policy itself is TypeScript-free after stripping its function annotation.
  const code = source.replace('function wake(seconds = 0): void', 'function wake(seconds = 0)');
  const deps = { window: { matchMedia: () => motion }, document, pet, brain, view, clock: () => time, dragging: false, samples: [],
    loudness: () => 0, updatePetting() {}, bubbleUntil: 115, report() {},
    PetLoop: class { constructor(fn: typeof draw) { draw = fn; } wake() { wakes++; } stop() { stops++; } },
  };
  new Function(...Object.keys(deps), code)(...Object.values(deps));
  assert.equal(draw(10), 1 / 12); assert.equal(still.at(-1), false);
  assert.equal(draw(91), 1 / 30, 'transition to sleep stays smooth');
  assert.equal(draw(91.4), 1 / 15, 'sleep keeps breathing and floating zzz');
  brain.tap(92);
  assert.equal(draw(92), 1 / 30);
  assert.equal(draw(93.3), 1 / 30, 'the reaction eases back to idle');
  assert.equal(draw(93.7), 1 / 12);
  brain.live({ status: 'paused' }, 94);
  assert.equal(draw(94), 1 / 30);
  assert.equal(draw(94.4), 1 / 12);
  brain.live({ status: 'recording' }, 100);
  assert.equal(draw(102), 1 / 30); assert.equal(still.at(-1), false);
  motion.matches = true; events.motion();
  assert.equal(draw(103), Infinity); assert.equal(still.at(-1), true);
  view.saying = { text: 'Answer ready' }; view.hasBubble = true;
  assert.equal(draw(112), 3, 'a still bubble schedules only its expiry');
  assert.equal(draw(115), Infinity); assert.equal(view.hasBubble, false);
  document.hidden = true; events.visibilitychange(); assert.ok(stops > 0);
  assert.equal(draw(116), Infinity);
  document.hidden = false; events.visibilitychange(); assert.ok(wakes > 1);
  pet.enabled = false; assert.equal(draw(time), Infinity);
});
