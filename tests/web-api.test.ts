import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { setLang, t } from '../web/src/i18n.ts';

const source = stripTypeScriptTypes(readFileSync(new URL('../web/src/api.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''));
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function browser(shared = true) {
  const streams: Stream[] = [], channels = new Set<Channel>();
  const posts: Array<{ sender: Channel; data: any }> = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  class Stream {
    static CLOSED = 2;
    readyState = 0;
    onopen = () => {};
    onerror = () => {};
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor(_url: string) { streams.push(this); }
    addEventListener(name: string, f: (event: { data: string }) => void) { this.listeners.set(name, f); }
    close() { this.readyState = 2; }
    open() { this.readyState = 1; this.onopen(); }
    fail(state = Stream.CLOSED) { this.readyState = state; this.onerror(); }
    emit(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  }
  class Channel {
    onmessage = (_event: { data: any }) => {};
    constructor(_name: string) { channels.add(this); }
    postMessage(data: unknown) {
      posts.push({ sender: this, data });
      for (const peer of channels) if (peer !== this) queueMicrotask(() => { if (channels.has(peer)) peer.onmessage({ data }); });
    }
    close() { channels.delete(this); }
  }
  let busy = false;
  const queue: Array<() => void> = [];
  const locks = { request: (_name: string, { signal }: { signal: AbortSignal }, fn: () => Promise<void>) => new Promise<void>((resolve, reject) => {
    let granted = false;
    const start = () => {
      if (signal.aborted) { queue.shift()?.(); return; }
      granted = true; busy = true;
      void fn().then(resolve, reject).finally(() => { busy = false; queue.shift()?.(); });
    };
    signal.addEventListener('abort', () => { if (!granted) reject(new Error('Aborted')); }, { once: true });
    if (busy) queue.push(start); else start();
  }) };
  const tab = (names = ['live'], hidden = false, handle?: (event: string, data: unknown) => void) => {
    const documentEvents = new Map<string, () => void>(), windowEvents = new Map<string, () => void>();
    const document = { visibilityState: hidden ? 'hidden' : 'visible', addEventListener: (name: string, f: () => void) => documentEvents.set(name, f), removeEventListener: (name: string) => documentEvents.delete(name) };
    const received: Array<[string, unknown]> = [], connections: boolean[] = [];
    const adapters = {
      EventSource: Stream, BroadcastChannel: shared ? Channel : undefined, navigator: { locks: shared ? locks : undefined }, document,
      window: { addEventListener: (name: string, f: () => void) => windowEvents.set(name, f), removeEventListener: (name: string) => windowEvents.delete(name) },
      setTimeout: (fn: () => void, ms: number) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
      clearTimeout: (id: number) => timers.delete(id), t,
    };
    const subscribe = new Function(...Object.keys(adapters), `${source}\nreturn subscribe;`)(...Object.values(adapters));
    const stop = subscribe(Object.fromEntries(names.map((name) => [name, (data: unknown) => { received.push([name, data]); handle?.(name, data); }])), (ok: boolean) => connections.push(ok));
    return { received, connections, stop, documentEvents, windowEvents,
      visible: (on: boolean) => { document.visibilityState = on ? 'visible' : 'hidden'; documentEvents.get('visibilitychange')?.(); },
      page: (event: string) => (windowEvents.get(event) ?? documentEvents.get(event))!(),
    };
  };
  return { streams, tab, timers, posts, active: () => streams.filter((s) => s.readyState !== Stream.CLOSED),
    retry: () => { const [id, timer] = timers.entries().next().value!; timers.delete(id); timer.fn(); },
  };
}

test('many Chumi tabs share one stream and receive their own event types', async () => {
  const b = browser(), tabs = Array.from({ length: 8 }, (_, i) => b.tab([i % 2 ? 'segment' : 'live']));
  await settle(); assert.equal(b.active().length, 1);
  b.active()[0].open(); await settle();
  assert.ok(tabs.every((tab) => tab.connections.at(-1) === true));
  b.active()[0].emit('live', { status: 'recording' }); b.active()[0].emit('segment', { text: 'Hello' }); await settle();
  tabs.forEach((tab, i) => assert.deepEqual(tab.received, i % 2 ? [['segment', { text: 'Hello' }]] : [['live', { status: 'recording' }]]));
  const newcomer = b.tab(['asr-download']); await settle();
  assert.equal(newcomer.connections.at(-1), true);
  b.active()[0].emit('asr-download', { status: 'done' }); await settle();
  assert.deepEqual(newcomer.received, [['asr-download', { status: 'done' }]]);
  for (const tab of [...tabs, newcomer]) { tab.visible(false); tab.visible(true); }
  await settle();
  assert.equal(b.streams.length, 1);
  for (const tab of [...tabs, newcomer]) assert.deepEqual(tab.connections, [true], 'other tabs joining or switching must not trigger another resync');
  [...tabs, newcomer].forEach((tab) => tab.stop()); await settle(); assert.equal(b.active().length, 0);
});

test('freezing or closing the stream owner hands ownership to another tab, even in the background', async () => {
  const b = browser(), first = b.tab(), second = b.tab(), third = b.tab();
  await settle(); b.active()[0].open(); await settle();
  second.visible(false); third.visible(false);
  first.page('freeze'); await settle(); assert.equal(b.active().length, 1); assert.equal(b.streams.length, 2);
  b.active()[0].open(); await settle(); assert.equal(second.connections.at(-1), true);
  second.stop(); await settle(); assert.equal(b.active().length, 1); assert.equal(b.streams.length, 3);
  third.stop(); await settle(); assert.equal(b.active().length, 0);
  first.page('resume'); await settle(); assert.equal(b.active().length, 1);
  first.stop(); await settle();
  assert.equal(first.documentEvents.size, 0); assert.equal(first.windowEvents.size, 0);
});

test('a frozen waiting tab cancels its lock request and back-forward navigation resumes a stream', async () => {
  const b = browser(), first = b.tab(), second = b.tab();
  second.page('freeze'); first.page('pagehide'); await settle(); assert.equal(b.active().length, 0);
  second.page('resume'); await settle(); assert.equal(b.active().length, 1);
  second.page('pagehide'); await settle(); assert.equal(b.active().length, 0);
  first.page('pageshow'); await settle(); assert.equal(b.active().length, 1);
  first.stop(); second.stop(); await settle();
});

test('a lone background tab keeps notices and hotkey-started meetings without false disconnections', async () => {
  const b = browser(), tab = b.tab(['notice', 'live'], true);
  await settle(); assert.equal(b.active().length, 1);
  b.active()[0].open(); await settle();
  const live = { session: { id: 'hotkey-meeting' }, status: 'recording' };
  for (const code of ['quick_start_failed', 'asr_fallback', 'window_closed', 'screen_permission', 'internal_error']) b.active()[0].emit('notice', { code });
  b.active()[0].emit('live', live);
  tab.visible(true); tab.visible(false); await settle();
  assert.equal(tab.received.length, 6); assert.deepEqual(tab.received.at(-1), ['live', live]);
  assert.deepEqual(tab.connections, [true]); assert.equal(b.streams.length, 1);
  assert.equal(b.posts.filter((p) => p.data.type === 'hello').length, 1, 'startup sends hello once');
  b.active()[0].fail(); await settle(); b.retry();
  assert.equal(b.active().length, 1, 'a hidden tab still retries a permanently closed stream');
  b.active()[0].open(); await settle(); assert.deepEqual(tab.connections, [true, false, true]);
  tab.stop(); await settle();
});

test('without cross-tab APIs streams survive hiding but pause on pagehide and resume on pageshow', () => {
  const b = browser(false), tab = b.tab(['live'], true);
  assert.equal(b.active().length, 1);
  b.active()[0].open(); assert.equal(tab.connections.at(-1), true);
  tab.visible(true); tab.visible(false); assert.equal(b.active().length, 1); assert.deepEqual(tab.connections, [true]);
  const old = b.active()[0]; tab.page('pagehide'); assert.equal(b.active().length, 0);
  old.emit('live', { stale: true }); assert.deepEqual(tab.received, []);
  tab.page('pageshow'); assert.equal(b.active().length, 1);
  tab.stop(); assert.equal(b.active().length, 0);
  old.open(); assert.equal(tab.connections.at(-1), false);
});

test('an owner handler failure cannot keep the event from reaching followers', async () => {
  const b = browser(), owner = b.tab(['notice'], false, () => { throw new Error('Owner UI failed'); }), follower = b.tab(['notice']);
  await settle(); b.active()[0].open(); await settle();
  assert.throws(() => b.active()[0].emit('notice', { code: 'asr_fallback' }), /Owner UI failed/);
  await settle(); assert.deepEqual(follower.received, [['notice', { code: 'asr_fallback' }]]);
  owner.stop(); follower.stop(); await settle();
});

test('a suspended follower ignores queued status messages and resyncs once when resumed', async () => {
  const b = browser(), first = b.tab(), second = b.tab();
  await settle(); b.active()[0].open(); await settle();
  second.page('freeze'); const third = b.tab(); await settle();
  assert.deepEqual(second.connections, [true, false]);
  second.page('resume'); await settle();
  assert.deepEqual(second.connections, [true, false, true]);
  assert.deepEqual(first.connections, [true]); assert.equal(b.streams.length, 1);
  first.stop(); second.stop(); third.stop(); await settle();
});

test('a permanently closed stream retries with capped backoff and resets the delay after recovery', () => {
  const b = browser(false), tab = b.tab();
  b.active()[0].open();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    b.active()[0].fail();
    assert.equal(tab.connections.at(-1), false);
    assert.equal([...b.timers.values()][0].ms, delay);
    b.retry(); assert.equal(b.active().length, 1);
  }
  b.active()[0].open(); assert.equal(tab.connections.at(-1), true);
  b.active()[0].fail(); assert.equal([...b.timers.values()][0].ms, 1000);
  tab.stop(); assert.equal(b.timers.size, 0);
});

test('native EventSource retries are left alone and late errors cannot restart a frozen or closed tab', () => {
  const b = browser(false), tab = b.tab();
  b.active()[0].fail(0); assert.equal(b.timers.size, 0); assert.equal(b.streams.length, 1);
  const old = b.active()[0]; old.fail(); assert.equal(b.timers.size, 1);
  tab.page('freeze'); assert.equal(b.timers.size, 0);
  old.fail(); assert.equal(b.timers.size, 0);
  tab.page('resume'); assert.equal(b.active().length, 1);
  const current = b.active()[0]; tab.stop(); current.fail(); assert.equal(b.timers.size, 0);
});

test('shared stream recovery notifies every tab, and a closing owner cancels its retry', async () => {
  const b = browser(), first = b.tab(), second = b.tab(); await settle();
  b.active()[0].open(); await settle();
  b.active()[0].fail(); await settle(); assert.equal(second.connections.at(-1), false);
  b.retry(); b.active()[0].open(); await settle(); assert.equal(second.connections.at(-1), true);
  b.active()[0].fail(); first.stop(); await settle();
  assert.equal(b.timers.size, 0); assert.equal(b.active().length, 1);
  second.stop(); await settle();
});

test('HTTP network failures are translated without claiming that an action was never sent', async () => {
  const api = (fetch: (...args: any[]) => Promise<any>) => new Function('fetch', 't', `${source}\nreturn api;`)(fetch, t);
  try {
    for (const lang of ['en', 'zh'] as const) {
      setLang(lang);
      for (const fetch of [async () => { throw new TypeError('Failed to fetch'); }, async () => ({ text: async () => { throw new TypeError('Load failed'); } })]) {
        await assert.rejects(api(fetch)('/api/session/end', { body: {} }), (error: any) => {
          assert.equal(error.status, 0);
          assert.equal(error.message, t("Chumi's server isn't reachable. Check the current state before trying again."));
          return true;
        });
      }
    }
    const aborted = Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    await assert.rejects(api(async () => { throw aborted; })('/api/state'), (error: unknown) => error === aborted);
    await assert.rejects(api(async () => ({ ok: false, status: 503, text: async () => '{"error":"Shutting down"}' }))('/api/state'), { status: 503, message: 'Shutting down' });
    const circular: any = {}; circular.self = circular;
    await assert.rejects(api(async () => { throw new Error('Must not send invalid JSON'); })('/api/settings', { body: circular }), TypeError);
  } finally { setLang('en'); }
});
