import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
import { canContinue, placeLabel, placeName } from '../web/src/pet/handoff.ts';
import { cardTitle, listed, preview, recent, tagCounts, when } from '../web/src/pet/recent.ts';
import { projectContextOn, setProjectContext } from '../web/src/projectContext.ts';
import { splitCategory } from '../shared/question-category.ts';
import { TAGS, tagOf } from '../web/src/pet/tags.ts';
import { fmtT } from '../web/src/util.ts';

// Drive the shipped companion methods with explicit HTTP, host and rendering adapters.
async function harness() {
  const raw = readFileSync(new URL('../web/src/pet/companion.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const { code } = await transformWithOxc(raw, 'companion.ts');
  const opened: any[] = [], saved: any[] = [], calls: any[] = [], warnings: string[] = [];
  const frames: Array<() => void> = [];
  let place = 'copy', response: any = {}, fresh: any = undefined, draws = 0, time = 100_000;
  let pointed: () => Node | null = () => null;
  const deps = { listed, recent, canContinue, placeLabel, placeName, projectContextOn, TAGS, tagOf, cardTitle, preview, tagCounts, when, splitCategory, locale: () => 'en',
    document: { createElement: () => new Node(), elementFromPoint: () => pointed() }, renderMd: (s: string) => `<p>${s}</p>`, requestAnimationFrame: (fn: () => void) => frames.push(fn), msg: (s: string) => s, t: (s: string) => s, CSS: { escape: (s: string) => s },
    loadHandoffDestination: () => place, isAgent: () => false, fmtT, Date: { now: () => time }, setTimeout() {},
    window: { setInterval: () => 1 }, clearInterval() {},
    api: async (path: string, options: any) => { calls.push({ path, ...options }); return path.endsWith('/handoff') ? { handoff: fresh === undefined ? c.handoff : fresh } : response; },
  };
  const Class = new Function(...Object.keys(deps), `${code}\nreturn Companion;`)(...Object.values(deps));
  const c = Object.assign(Object.create(Class.prototype), {
    sessionId: 'b', status: 'recording', cards: new Map(), expanded: new Set(), revealed: null, peek: false,
    streamDirty: new Set(), cardNodes: new Map(), drawQueued: false, fullDraw: false, listHeight: 0,
    cardsMode: 'latest', tags: TAGS, listEl: { querySelector: () => null }, continuing: false, toolbar: true, lowKey: false,
    host: { open: (where: any) => opened.push(where), setCards: (mode: any) => saved.push(mode), say: (s: string) => warnings.push(s), keyboard() {} },
    render: () => draws++,
  });
  return { c, opened, saved, calls, warnings, point: (fn: typeof pointed) => { pointed = fn; }, frame: () => { frames.splice(0).forEach((fn) => fn()); }, draws: () => draws, time: (t: number) => { time = t; }, place: (p: string) => { place = p; }, response: (r: any) => { response = r; }, fresh: (r: any) => { fresh = r; } };
}
const card = (id: string, created_at: number, kind = 'answer') => ({ id, created_at, kind, status: 'done', session_id: 'b' });

test('low-key toolbar keeps one layout and neutral icon set through idle and every live phase', async () => {
  const h = await harness(), c = h.c;
  c.bar = new Node(); c.tip = new Node(); c.clock = { nowT: 754_000, at: 100_000 };
  const configure = (lowKey: boolean) => c.configure({ toolbar: true, cards: 'latest', tags: TAGS, lowKey });
  const visible = () => c.bar.innerHTML.replace(/<[^>]*>/g, '');
  let shape = '';
  c.handoff = { status: 'confirmed', freshness: { stale: true } };
  for (const status of ['idle', 'starting', 'recording', 'ending', 'paused', 'starting', 'recording', 'ending', 'idle']) {
    c.status = status;
    c.sessionId = status === 'idle' ? null : 'b';
    const draws = h.draws(); configure(true);
    assert.equal(h.draws(), draws + 1, 'lowKey alone invalidates the toolbar');
    c.renderBar();
    const label = ({ idle: 'Quick start', starting: 'Starting… · 12:34', recording: 'Pause · 12:34', paused: 'Resume · 12:34', ending: 'Ending… · 12:34' } as Record<string, string>)[status];
    assert.ok(c.bar.innerHTML.includes(`data-tip="${label}"`));
    assert.doesNotMatch(c.bar.innerHTML, /class="(?:clock|rec|paused|dot|spin)"/);
    assert.doesNotMatch(c.bar.innerHTML, / disabled|data-act="continue"|M9 6v12|M8 5.5v13|<rect x="6"/);
    assert.equal(visible(), '', 'no text outside hover tips');
    assert.deepEqual([...c.bar.innerHTML.matchAll(/data-act="([^"]*)"/g)].map((m: RegExpMatchArray) => m[1]), ['toggle', 'catchup', 'ask', 'end', 'list']);
    const nextShape = c.bar.innerHTML.replace(/ data-tip="[^"]*"/g, '');
    if (shape) assert.equal(nextShape, shape, `${status}: only tooltips change`); else shape = nextShape;
    assert.equal(c.showing, false, 'cards wait for an explicit peek');
    configure(false); c.renderBar();
    if (status === 'recording' || status === 'paused') {
      assert.equal(visible(), '12:34');
      assert.match(c.bar.innerHTML, status === 'recording' ? /class="rec"/ : /class="paused"/);
    } else if (status !== 'idle') assert.match(c.bar.innerHTML, /class="spin"/);
  }
  c.status = 'idle'; configure(true); c.renderBar();
  assert.match(c.bar.innerHTML, /data-act="toggle"/);
  assert.doesNotMatch(c.bar.innerHTML, /12:34/);
});

test('low-key keeps the End confirmation icon-only, neutral and two-click, with an updating hover clock', async () => {
  const h = await harness(), c = h.c;
  c.bar = new Node(); c.tip = new Node(); c.clock = { nowT: 754_000, at: 100_000 }; c.lowKey = true;
  await c.act('end'); c.renderBar();
  assert.equal(h.calls.length, 0);
  assert.match(c.bar.innerHTML, /data-tip="Click again to end" class="quiet-confirm"/);
  assert.equal(c.bar.innerHTML.replace(/<[^>]*>/g, ''), '');
  h.time(103_100); await c.act('end');
  assert.equal(h.calls.length, 0, 'an expired confirmation needs another first click');
  await c.act('end');
  assert.equal(h.calls.at(-1)!.path, '/api/session/end');
  const button = { dataset: { tip: 'Pause · 12:34' } };
  c.bar.querySelector = (selector: string) => selector === '[data-act="toggle"]' ? button : null;
  c.hovered = button; h.time(105_000); c.updateClock();
  assert.equal(button.dataset.tip, 'Pause · 12:39');
  assert.equal(c.tip.textContent, 'Pause · 12:39', 'a stationary hover keeps the clock current');
  c.lowKey = false; c.confirmEnd = 108_000; c.renderBar();
  assert.match(c.bar.innerHTML, /class="confirm"/);
  assert.match(c.bar.innerHTML, />End meeting\?</);
});

test('low-key toolbar actions follow state without disabled buttons or invalid requests', async () => {
  const h = await harness(), c = h.c; c.lowKey = true;
  for (const status of ['idle', 'starting', 'ending']) {
    c.status = status; await c.act('catchup'); await c.act('end');
    assert.equal(h.calls.length, 0);
    if (status !== 'idle') await c.act('toggle');
    assert.equal(h.calls.length, 0);
  }
  assert.deepEqual(h.warnings, ['Start a meeting first', 'Start a meeting first']);
  for (const [status, path] of [['idle', 'quick-start'], ['recording', 'pause'], ['paused', 'resume']]) {
    c.status = status; await c.act('toggle');
    assert.equal(h.calls.at(-1)!.path, `/api/session/${path}`);
  }
  c.status = 'recording'; await c.act('catchup');
  assert.equal(h.calls.at(-1)!.path, '/api/ai/catchup');
  c.sessionId = null;
  const before = h.calls.length;
  for (const act of ['ask', 'list', 'end', 'catchup']) await c.act(act);
  assert.equal(h.calls.length, before);
  assert.deepEqual(h.warnings.slice(-4), Array(4).fill('Start a meeting first'));
});

test('click replies pass through the page host and bubble filter even with chatter off', async () => {
  const source = readFileSync(new URL('../web/src/pet/main.ts', import.meta.url), 'utf8');
  const raw = source.slice(source.indexOf('let bubbleUntil ='), source.indexOf("view.bubble.classList.add('ui')"))
    + source.slice(source.indexOf('const companion = new Companion('), source.indexOf('app.appendChild(companion.el)'));
  const { code } = await transformWithOxc(raw, 'main.ts');
  const shown: any[] = [];
  const deps = { pet: { enabled: true, say: [] }, view: { say: (line: any) => shown.push(line) }, clock: () => 0,
    wake() {}, report() {}, post() {}, savePet() {}, Companion: class { host: any; constructor(host: any) { this.host = host; } },
  };
  const host = new Function(...Object.keys(deps), `${code}\nreturn companion.host;`)(...Object.values(deps));
  host.say('Ordinary chatter'); assert.equal(shown.length, 0);
  const h = await harness(), c = h.c;
  c.lowKey = true; c.status = 'idle'; c.sessionId = null; c.host.say = host.say;
  for (const act of ['catchup', 'end', 'ask', 'list']) await c.act(act);
  assert.equal(shown.length, 4);
  for (const line of shown) {
    assert.equal(line.text, 'Start a meeting first');
    assert.equal(line.important, true); assert.equal(line.tone, 'info');
  }
});

test('low-key catch-up progress changes only the tooltip from click through pending and streaming', async () => {
  const h = await harness(), c = h.c;
  c.bar = toolbarNode(); c.tip = new Node(); c.el = new Node(); c.lowKey = true;
  c.clock = { nowT: 754_000, at: 100_000 }; c.render = () => c.renderBar(); c.render();
  const shape = () => c.bar.innerHTML.replace(/ data-tip="[^"]*"/g, '');
  const initial = shape();
  const tip = () => c.bar.querySelector('[data-act="catchup"]').dataset.tip;
  h.point(() => c.bar.querySelector('[data-act="catchup"]')); c.hover(1, 1);
  let finish!: (value: { id: string }) => void;
  h.response(new Promise((resolve) => { finish = resolve; }));
  const request = c.act('catchup');
  assert.equal(tip(), 'Catching up…'); assert.equal(c.tip.textContent, 'Catching up…');
  assert.equal(shape(), initial, 'no visible class, icon or layout changes');
  finish({ id: 'catchup' }); await request;
  assert.equal(tip(), 'Catching up…', 'the HTTP response may arrive before the output event');
  for (const status of ['pending', 'streaming']) {
    c.ai({ ...card('catchup', 1, 'catchup'), status }); h.frame();
    assert.equal(tip(), 'Catching up…'); assert.equal(shape(), initial);
  }
  for (const status of ['done', 'error', 'cancelled', 'suppressed']) {
    c.ai({ ...card('catchup', 1, 'catchup'), status: 'pending' }); h.frame();
    assert.equal(tip(), 'Catching up…');
    c.ai({ ...card('catchup', 1, 'catchup'), status }); h.frame();
    assert.equal(tip(), 'Catch me up'); assert.equal(shape(), initial);
  }
  h.response(Promise.reject(new Error('Synthetic failure'))); await c.act('catchup');
  assert.equal(tip(), 'Catch me up'); assert.equal(h.warnings.at(-1), 'Synthetic failure');
  c.ai({ ...card('other', 2, 'catchup'), session_id: 'other', status: 'pending' }); h.frame();
  assert.equal(tip(), 'Catch me up', 'another meeting cannot set this button’s progress');
  c.lowKey = false; c.ai({ ...card('normal', 3, 'catchup'), status: 'pending' }); h.frame();
  assert.equal(tip(), 'Catch me up', 'normal mode keeps its existing tooltip');
});

test('End confirmation restores its tooltip under a stationary pointer after rendering', async () => {
  const h = await harness(), c = h.c;
  c.bar = toolbarNode(); c.tip = new Node(); c.el = new Node(); c.lowKey = true;
  c.clock = { nowT: 754_000, at: 100_000 };
  c.render = () => c.renderBar(); c.render();
  h.point(() => c.bar.querySelector('[data-act="end"]'));
  c.hover(1, 1);
  const old = c.hovered;
  assert.equal(c.tip.textContent, 'End meeting');
  await c.act('end');
  assert.notEqual(c.hovered, old);
  assert.equal(c.hovered.dataset.act, 'end');
  assert.equal(c.tip.textContent, 'Click again to end');
  assert.equal(c.tip.classList.contains('on'), true);
  assert.equal(c.hovered.classList.contains('hov'), true);
  h.point(() => c.bar.querySelector('[data-act="ask"]'));
  h.time(104_000); c.render();
  assert.equal(c.hovered, null, 'do not restore hover to a button that moved away');
  assert.equal(c.tip.classList.contains('on'), false);
});

test('opening a bubble only expands a listed local card and never saves the Cards preference', async () => {
  const h = await harness();
  h.c.cards.set('old', card('old', 1)); h.c.cards.set('new', card('new', 2)); h.c.cards.set('handoff', card('handoff', 3, 'handoff'));
  assert.equal(h.c.has('other-meeting'), false);
  assert.equal(h.c.has('handoff'), false);
  h.c.expand('other-meeting'); h.c.expand('handoff');
  assert.equal(h.draws(), 0);
  h.c.expand('old');
  assert.equal(h.c.revealed, 'old');
  assert.equal(h.c.list, true);
  assert.equal(h.c.cardsMode, 'latest');
  assert.deepEqual(h.saved, []);
  h.c.status = 'idle'; h.c.expand('other-meeting');
  assert.equal(h.c.peek, false);
  h.c.expand('new'); assert.equal(h.c.peek, true);
  h.c.cardsMode = 'none'; assert.equal(h.c.has('new'), false);
});

test('bubble clicks route other meetings and handoffs to their own window destination', () => {
  const source = readFileSync(new URL('../web/src/pet/main.ts', import.meta.url), 'utf8');
  const body = source.match(/view\.bubble\.addEventListener\('click', \(\) => \{([\s\S]*?)\n\}\);/)![1];
  const click = new Function('said', 'companion', 'post', 'view', 'clock', 'report', 'wake', body);
  const opened: any[] = [], expanded: string[] = [];
  const companion = { has: (id: string) => id === 'here', expand: (id: string) => expanded.push(id) };
  const run = (said: any) => click(said, companion, (o: any) => opened.push(o), { hush() {} }, () => 0, () => {}, () => {});
  run({ open: true, output: 'here', session: 'b' });
  run({ open: true, output: 'elsewhere', session: 'a' });
  run({ open: true, output: 'draft', session: 'a', dialog: 'handoff' });
  assert.deepEqual(expanded, ['here']);
  assert.deepEqual(opened, [{ type: 'open', session: 'a', dialog: undefined }, { type: 'open', session: 'a', dialog: 'handoff' }]);
});

test('copy, failed clipboard and stale handoffs open the handoff dialog', async () => {
  const h = await harness();
  h.c.handoff = { id: 'h', session_id: 'b', status: 'confirmed', project: {}, freshness: { stale: false } };
  await h.c.act('continue');
  h.place('deepseek-harness'); h.response({ launched: true, paste: { copied: false } });
  await h.c.act('continue');
  h.c.handoff.freshness.stale = true;
  await h.c.act('continue');
  assert.equal(h.calls.filter((c) => c.path.endsWith('/continue')).length, 1, 'stale and copy destinations never launch an agent');
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.opened, Array.from({ length: 3 }, () => ({ session: 'b', dialog: 'handoff' })));
});

test('only confirmed handoffs expose or respond to Continue, even when a draft is stale', async () => {
  const h = await harness(), c = h.c;
  c.status = 'idle'; c.bar = new Node(); c.tip = new Node();
  for (const status of ['draft', 'error', 'generating', 'confirmed']) {
    for (const stale of [false, true]) {
      c.handoff = { id: 'h', session_id: 'b', status, project: {}, freshness: { stale } };
      c.renderBar();
      assert.equal(c.bar.innerHTML.includes('data-act="continue"'), status === 'confirmed', `${status}, stale=${stale}`);
      const before = h.opened.length;
      await c.act('continue');
      assert.equal(h.opened.length - before, status === 'confirmed' ? 1 : 0);
    }
  }
  assert.deepEqual(h.calls, [], 'unconfirmed rows never fetch or launch; confirmed copy destinations open Chumi');
});

test('the shell opens a handoff only after its meeting loads, and never over a different meeting', async () => {
  const source = stripTypeScriptTypes(readFileSync(new URL('../web/src/shell.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
  let finish!: () => void, state: any = { viewId: 'b', data: { session: { id: 'b' } } };
  const opened: any[] = [], window: any = { chumiShell: {} };
  const deps = { window, getState: () => state, setState: (patch: any) => Object.assign(state, patch),
    openSession: (...args: any[]) => { opened.push(args); return new Promise<void>((resolve) => { finish = resolve; }); },
  };
  new Function(...Object.keys(deps), `${source}\nstartShellBridge();`)(...Object.values(deps));
  window.chumiOpen({ session: 'a', dialog: 'handoff', t: 10 });
  assert.equal(state.dialog, undefined);
  state = { viewId: 'a', data: { session: { id: 'a' } } }; finish(); await Promise.resolve();
  assert.equal(state.dialog, 'handoff');
  assert.deepEqual(opened[0], ['a', { t: 10, t2: undefined }]);
  state.dialog = null;
  window.chumiOpen({ session: 'b', dialog: 'handoff' }); finish(); await Promise.resolve();
  assert.equal(state.dialog, null);
});

test('pet questions use the meeting’s saved context switch only while it has a project', async () => {
  const storage = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k),
  } });
  try {
    const h = await harness();
    h.response({ session: { project_id: 'p' }, outputs: [] });
    await h.c.load('b');
    h.response({ id: 'answer' }); h.c.input = { value: '' };
    const ask = async () => { h.c.input.value = 'Did we try this?'; await h.c.submit(); return h.calls.at(-1).body; };
    assert.equal((await ask()).projectContext, false);
    setProjectContext('b', true);
    assert.equal((await ask()).projectContext, true);
    h.c.sessionUpdated({ id: 'other', project_id: null });
    assert.equal((await ask()).projectContext, true);
    h.c.sessionUpdated({ id: 'b', project_id: null });
    assert.equal((await ask()).projectContext, false);
    h.c.sessionUpdated({ id: 'b', project_id: 'new-project' });
    setProjectContext('b', false);
    assert.equal((await ask()).projectContext, false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete (globalThis as any).localStorage;
  }
});

// A small DOM stand-in with node identity and text-dependent height, for selection/layout regressions.
class Node {
  className = ''; dataset: Record<string, string> = {}; style: Record<string, string> = {};
  children: Node[] = []; parent: Node | null = null; textContent = ''; innerHTML = ''; scrollTop = 0; offsetTop = 20; hidden = false;
  private classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name), contains: (name: string) => this.classes.has(name) };
  append(...children: any[]) { for (const c of children) if (c instanceof Node) { this.children.push(c); c.parent = this; } }
  replaceChildren(...children: Node[]) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this.append(...children); }
  setAttribute() {}
  get lastElementChild() { return this.children.at(-1)!; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  matches(selector: string): boolean {
    const attr = selector.match(/^(?:button)?\[data-(act|tip|tag)(?:="([^"]*)")?\]$/);
    if (attr) return this.dataset[attr[1]] !== undefined && (attr[2] === undefined || this.dataset[attr[1]] === attr[2]);
    return selector.split(', ').some((s) => s.split('.').filter(Boolean).every((k) => this.className.split(' ').includes(k)));
  }
  closest(selector: string): Node | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  querySelectorAll(selector: string): Node[] {
    const [parent, child] = selector.split(' ');
    if (child && !selector.includes(',')) return this.querySelectorAll(parent).flatMap((c) => c.querySelectorAll(child));
    return this.children.flatMap((c) => [(selector === '.card:not(.empty)' ? c.matches('.card') && !c.matches('.empty') : c.matches(selector)) ? c : null, ...c.querySelectorAll(selector)].filter(Boolean) as Node[]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  get scrollHeight(): number { return this.children.length ? this.children.reduce((n, c) => n + c.getBoundingClientRect().height, 0) : Math.max(20, Math.ceil((this.textContent || this.innerHTML).length / 30) * 20); }
  getBoundingClientRect() { return { left: 0, width: 44, top: 0, height: Math.min(this.scrollHeight, parseFloat(this.style.maxHeight) || Infinity) }; }
}

function toolbarNode(): Node {
  const bar = new Node(); let html = '';
  Object.defineProperty(bar, 'innerHTML', { get: () => html, set: (value: string) => {
    html = value;
    bar.replaceChildren(...[...html.matchAll(/<button[^>]*data-act="([^"]*)" data-tip="([^"]*)"[^>]*>/g)].map((m) => {
      const button = new Node(); button.dataset = { act: m[1], tip: m[2] }; return button;
    }));
  } });
  return bar;
}

test('low-key cards wait for a peek, omit automatic explanations, and keep an explicit peek across live transitions', async () => {
  const h = await harness(), c = h.c;
  c.lowKey = true; c.cardsMode = 'recent'; c.room = 1200;
  c.el = new Node(); c.listEl = new Node(); c.el.append(c.listEl);
  c.cards.set('manual', { ...card('manual', 1), content: 'Requested answer' });
  c.ai({ ...card('auto', 2, 'auto_explain'), question: 'Private term', content: 'Automatic explanation' });
  assert.ok(c.cards.has('auto'), 'the output still updates in memory');
  for (const status of ['idle', 'starting', 'recording', 'ending', 'paused', 'recording', 'ending', 'idle']) {
    c.setLive({ status, session: { id: 'b' } }); c.renderCards();
    assert.equal(c.listEl.hidden, true); assert.equal(c.cardNodes.size, 0);
  }
  c.setLive({ status: 'recording', session: { id: 'b' } });
  await c.act('list'); c.renderCards();
  assert.equal(c.peek, true); assert.equal(c.has('auto'), false);
  assert.deepEqual([...c.cardNodes.keys()], ['manual']);
  c.revealed = 'auto'; c.expanded.add('auto'); c.renderCards();
  assert.deepEqual([...c.cardNodes.keys()], ['manual'], 'revealed and expanded cannot bypass the filter');
  assert.equal(c.listEl.querySelectorAll('.chip').length, 1, 'hidden auto terms do not contribute tag chips');
  for (const status of ['ending', 'paused', 'starting', 'recording', 'ending', 'idle']) {
    c.setLive({ status, session: { id: 'b' } }); c.renderCards();
    assert.equal(c.peek, true); assert.equal(c.listEl.hidden, false);
  }
  await c.act('list'); c.renderCards(); assert.equal(c.listEl.hidden, true);
  assert.deepEqual(h.saved, [], 'peeking never changes the saved card mode');
  c.lowKey = false; c.status = 'recording'; c.renderCards();
  assert.equal(c.has('auto'), true); assert.equal(c.cardNodes.has('auto'), true, 'normal mode still lists automatic explanations');
});

test('low-key never shows an empty card and bubble clicks or questions can reveal manual answers', async () => {
  const h = await harness(), c = h.c;
  c.lowKey = true; c.cardsMode = 'recent'; c.room = 1200; c.peek = true;
  c.el = new Node(); c.listEl = new Node(); c.el.append(c.listEl);
  c.renderCards(); assert.equal(c.listEl.children.length, 0);
  c.lowKey = false; c.renderCards(); assert.equal(c.listEl.querySelectorAll('.card.empty').length, 1);
  c.lowKey = true; c.peek = false; c.cardsMode = 'latest';
  c.cards.set('manual', { ...card('manual', 1), content: 'Answer' });
  c.expand('manual'); c.renderCards();
  assert.equal(c.peek, true); assert.equal(c.cardNodes.has('manual'), true);
  await c.act('list'); assert.equal(c.peek, false);
  h.response({ id: 'asked' }); c.input = { value: 'A question', blur() {} }; c.ask = new Node(); c.asking = true;
  await c.submit(); assert.equal(c.peek, true); assert.equal(c.expanded.has('asked'), true);
  c.cardsMode = 'none'; c.renderCards(); assert.equal(c.listEl.hidden, true);
});

test('low-key keeps tag chips and Open in Chumi when the user filters every listed card out', async () => {
  const h = await harness(), c = h.c, saved: string[][] = [];
  c.lowKey = true; c.cardsMode = 'recent'; c.peek = true; c.room = 1200;
  c.el = new Node(); c.listEl = new Node(); c.el.append(c.listEl);
  c.host.setTags = (tags: string[]) => saved.push(tags);
  c.render = () => c.renderCards();
  c.cards.set('answer', { ...card('answer', 1), content: 'An answer' });
  c.render(); assert.equal(c.cardNodes.size, 1);
  const chip = () => c.listEl.querySelector('button[data-tag="meeting"]');
  c.cardClick({ target: chip() });
  assert.equal(c.cardNodes.size, 0);
  assert.ok(chip(), 'the disabled tag remains clickable');
  assert.equal(c.listEl.querySelector('.open').textContent, 'Open in Chumi');
  assert.equal(c.listEl.querySelector('.empty'), null);
  c.cardClick({ target: chip() });
  assert.equal(c.cardNodes.size, 1);
  assert.deepEqual(saved, [TAGS.filter((tag) => tag !== 'meeting'), TAGS]);
  c.cards.clear(); c.cards.set('unlisted', card('unlisted', 2, 'handoff')); c.render();
  assert.equal(c.listEl.hidden, true, 'unlisted outputs alone do not create a header');
});

test('streaming updates preserve other card nodes and scrolling, and skip layout for unchanged height', async () => {
  const h = await harness(), c = h.c;
  c.cardsMode = 'recent'; c.room = 1200; c.el = new Node(); c.listEl = new Node(); c.el.append(c.listEl);
  c.cards.set('old', { ...card('old', 1), content: 'Select this sentence.' });
  c.cards.set('stream', { ...card('stream', 2), status: 'streaming', stream: 'Hello' });
  c.expanded.add('old'); c.expanded.add('stream');
  c.renderCards();
  const old = c.cardNodes.get('old'), selected = old.querySelector('.md'); selected.scrollTop = 24;
  const streaming = c.cardNodes.get('stream'), body = streaming.querySelector('.md'); body.scrollTop = 12;
  let layouts = 0; c.host.changed = () => layouts++;
  c.delta({ id: 'stream', delta: ' there' }); c.delta({ id: 'stream', delta: '!' });
  h.frame();
  assert.equal(c.cardNodes.get('old'), old);
  assert.equal(old.querySelector('.md'), selected, 'the selected text node stays attached');
  assert.equal(selected.scrollTop, 24);
  assert.equal(streaming.querySelector('.md'), body);
  assert.equal(body.scrollTop, 12);
  assert.match(body.innerHTML, /Hello there!/);
  assert.equal(layouts, 0, 'same-line tokens do not repeat the height budget or host layout');
  c.delta({ id: 'stream', delta: ' more text'.repeat(30) }); h.frame();
  assert.equal(layouts, 1);
  assert.equal(c.cardNodes.get('old'), old);
  assert.ok(parseFloat(body.style.maxHeight) > 48, 'the streaming body can grow from its first line');
});

test('Continue rechecks freshness so a meeting resumed after confirmation never launches silently', async () => {
  const h = await harness();
  h.c.handoff = { id: 'h', session_id: 'b', status: 'confirmed', project: {}, freshness: { stale: false } };
  h.place('codex-app'); h.fresh({ ...h.c.handoff, freshness: { stale: true } });
  await h.c.act('continue');
  assert.deepEqual(h.calls.map((c) => c.path), ['/api/sessions/b/handoff']);
  assert.deepEqual(h.opened, [{ session: 'b', dialog: 'handoff' }]);
});

test('an older bubble’s card remains visible even when the screen fits only one card', async () => {
  const h = await harness(), c = h.c;
  c.cardsMode = 'recent'; c.room = 120; c.el = new Node(); c.listEl = new Node(); c.el.append(c.listEl);
  for (let i = 0; i < 10; i++) c.cards.set(String(i), { ...card(String(i), i), content: 'Answer text' });
  c.revealed = '0'; c.expanded.add('0'); c.renderCards();
  assert.ok(c.cardNodes.has('0'));
  assert.equal(c.cardNodes.size, 1);
});

test('a project change during session loading wins over the older snapshot', async () => {
  const h = await harness();
  let finish!: (value: any) => void;
  h.response(new Promise((resolve) => { finish = resolve; }));
  const loading = h.c.load('b');
  h.c.sessionUpdated({ id: 'b', project_id: null });
  finish({ session: { project_id: 'old-project' }, outputs: [] });
  await loading;
  assert.equal(h.c.projectId, null);
});
