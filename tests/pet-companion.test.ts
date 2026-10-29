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

// Drive the shipped companion methods with explicit HTTP, host and rendering adapters.
async function harness() {
  const raw = readFileSync(new URL('../web/src/pet/companion.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const { code } = await transformWithOxc(raw, 'companion.ts');
  const opened: any[] = [], saved: any[] = [], calls: any[] = [], warnings: string[] = [];
  const frames: Array<() => void> = [];
  let place = 'copy', response: any = {}, fresh: any = undefined, draws = 0;
  const deps = { listed, recent, canContinue, placeLabel, placeName, projectContextOn, TAGS, tagOf, cardTitle, preview, tagCounts, when, splitCategory, locale: () => 'en',
    document: { createElement: () => new Node() }, renderMd: (s: string) => `<p>${s}</p>`, requestAnimationFrame: (fn: () => void) => frames.push(fn), msg: (s: string) => s, t: (s: string) => s, CSS: { escape: (s: string) => s },
    loadHandoffDestination: () => place, isAgent: () => false,
    api: async (path: string, options: any) => { calls.push({ path, ...options }); return path.endsWith('/handoff') ? { handoff: fresh === undefined ? c.handoff : fresh } : response; },
  };
  const Class = new Function(...Object.keys(deps), `${code}\nreturn Companion;`)(...Object.values(deps));
  const c = Object.assign(Object.create(Class.prototype), {
    sessionId: 'b', status: 'recording', cards: new Map(), expanded: new Set(), revealed: null, peek: false,
    streamDirty: new Set(), cardNodes: new Map(), drawQueued: false, fullDraw: false, listHeight: 0,
    cardsMode: 'latest', tags: TAGS, listEl: { querySelector: () => null }, continuing: false,
    host: { open: (where: any) => opened.push(where), setCards: (mode: any) => saved.push(mode), say: (s: string) => warnings.push(s) },
    render: () => draws++,
  });
  return { c, opened, saved, calls, warnings, frame: () => { frames.splice(0).forEach((fn) => fn()); }, draws: () => draws, place: (p: string) => { place = p; }, response: (r: any) => { response = r; }, fresh: (r: any) => { fresh = r; } };
}
const card = (id: string, created_at: number, kind = 'answer') => ({ id, created_at, kind, status: 'done', session_id: 'b' });

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
  classList = { remove() {} };
  append(...children: any[]) { for (const c of children) if (c instanceof Node) { this.children.push(c); c.parent = this; } }
  replaceChildren(...children: Node[]) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this.append(...children); }
  setAttribute() {}
  get lastElementChild() { return this.children.at(-1)!; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  matches(selector: string): boolean { return selector.split(', ').some((s) => s.split('.').filter(Boolean).every((k) => this.className.split(' ').includes(k))); }
  querySelectorAll(selector: string): Node[] {
    const [parent, child] = selector.split(' ');
    if (child && !selector.includes(',')) return this.querySelectorAll(parent).flatMap((c) => c.querySelectorAll(child));
    return this.children.flatMap((c) => [(selector === '.card:not(.empty)' ? c.matches('.card') && !c.matches('.empty') : c.matches(selector)) ? c : null, ...c.querySelectorAll(selector)].filter(Boolean) as Node[]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  get scrollHeight(): number { return this.children.length ? this.children.reduce((n, c) => n + c.getBoundingClientRect().height, 0) : Math.max(20, Math.ceil((this.textContent || this.innerHTML).length / 30) * 20); }
  getBoundingClientRect() { return { top: 0, height: Math.min(this.scrollHeight, parseFloat(this.style.maxHeight) || Infinity) }; }
}

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
