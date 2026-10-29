import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { CodexProvider } from '../server/ai/codex.ts';
import type { CompletionRequest, ProviderStatus } from '../server/ai/provider.ts';

type Json = Record<string, unknown>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  assert.ok(check(), 'the simulated provider did not reach the expected stage');
}

/** Only the app-server transport is replaced; complete() and notification handling are real. */
function fixture(t: TestContext, delays: { ensure?: Promise<void>; thread?: Promise<Json>; turn?: Promise<Json> } = {}) {
  const provider = new CodexProvider(() => ({ model: 'fixture-model', allowCredits: false }));
  const transport = provider as unknown as {
    ensure(): Promise<void>;
    request(method: string, params: Json): Promise<Json>;
    onMessage(line: string): void;
    turns: Map<string, unknown>;
  };
  const ready: ProviderStatus = {
    id: 'codex', label: 'Fixture', state: 'ready', ready: true, billing: 'subscription', billingLabel: 'Fixture',
    checkedAt: Date.now(), quota: { known: false, summary: 'Fixture' },
  };
  const status = t.mock.method(provider, 'status', async () => ready);
  const ensure = t.mock.method(transport, 'ensure', async () => { await delays.ensure; });
  const calls: Array<{ method: string; params: Json }> = [];
  t.mock.method(transport, 'request', async (method: string, params: Json) => {
    calls.push({ method, params });
    if (method === 'thread/start') return delays.thread ?? { thread: { id: 'fixture-thread' } };
    if (method === 'turn/start') return delays.turn ?? { turn: { id: 'fixture-turn' } };
    return {};
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const deltas: string[] = [];
  const start = (effort?: CompletionRequest['effort']) => provider.complete({ effort, task: 'answer', instructions: 'Fixture instructions', input: 'Synthetic meeting text', signal: controller.signal, onDelta: (d) => deltas.push(d) });
  const notify = (method: string, params: Json) => transport.onMessage(JSON.stringify({ method, params: { threadId: 'fixture-thread', ...params } }));
  const methods = () => calls.map((c) => c.method);
  const cleaned = () => {
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(transport.turns.size, 0);
  };
  return { provider, controller, calls, methods, status, ensure, deltas, start, notify, cleaned };
}

test('Codex does not initialize an already cancelled request', async (t) => {
  const f = fixture(t);
  f.controller.abort();
  await assert.rejects(f.start(), { kind: 'aborted' });
  assert.equal(f.status.mock.callCount(), 0);
  assert.equal(f.ensure.mock.callCount(), 0);
  assert.deepEqual(f.methods(), []);
  f.cleaned();
});

test('Codex cancellation while initializing settles immediately and never creates a thread', async (t) => {
  const gate = deferred<void>();
  const f = fixture(t, { ensure: gate.promise });
  const rejected = assert.rejects(f.start(), { kind: 'aborted' });
  await until(() => f.ensure.mock.callCount() === 1);
  f.controller.abort();
  await rejected;
  gate.resolve();
  await tick();
  assert.deepEqual(f.methods(), []);
  f.cleaned();
});

test('Codex cancellation during thread/start cleans up its late thread without sending the meeting', async (t) => {
  const gate = deferred<Json>();
  const f = fixture(t, { thread: gate.promise });
  const rejected = assert.rejects(f.start(), { kind: 'aborted' });
  await until(() => f.methods().includes('thread/start'));
  f.controller.abort();
  await rejected;
  f.cleaned();
  gate.resolve({ thread: { id: 'fixture-thread' } });
  await until(() => f.methods().includes('thread/unsubscribe'));
  assert.deepEqual(f.methods(), ['thread/start', 'thread/unsubscribe']);
  f.cleaned();
});

test('Codex cancellation during turn/start interrupts its late turn id and suppresses later notifications', async (t) => {
  const gate = deferred<Json>();
  const f = fixture(t, { turn: gate.promise });
  const rejected = assert.rejects(f.start(), { kind: 'aborted' });
  await until(() => f.methods().includes('turn/start'));
  f.controller.abort();
  await rejected;
  f.cleaned();
  f.notify('item/agentMessage/delta', { delta: 'Late answer' });
  gate.resolve({ turn: { id: 'fixture-turn' } });
  await until(() => f.methods().includes('turn/interrupt'));
  assert.deepEqual(f.calls.find((c) => c.method === 'turn/interrupt')!.params, { threadId: 'fixture-thread', turnId: 'fixture-turn' });
  assert.equal(f.methods().filter((m) => m === 'turn/interrupt').length, 1);
  assert.equal(f.methods().filter((m) => m === 'thread/unsubscribe').length, 1);
  assert.deepEqual(f.deltas, []);
  f.cleaned();
});

test('Codex timeout interrupts the running turn and releases its abort listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const rejected = assert.rejects(f.start(), { kind: 'network' });
  await until(() => f.methods().includes('turn/start'));
  await tick();
  t.mock.timers.tick(300_000);
  await rejected;
  assert.equal(f.methods().filter((m) => m === 'turn/interrupt').length, 1);
  f.cleaned();
});

test('Codex successful completion still streams text and removes cancellation state', async (t) => {
  const f = fixture(t);
  const result = f.start();
  await until(() => f.methods().includes('turn/start'));
  f.notify('item/agentMessage/delta', { delta: 'Fixture answer' });
  f.notify('turn/completed', { turn: { id: 'fixture-turn', status: 'completed' } });
  assert.deepEqual(await result, { text: 'Fixture answer', provider: 'codex', model: 'fixture-model', billing: 'subscription', effort: 'low' });
  f.controller.abort();
  assert.deepEqual(f.deltas, ['Fixture answer']);
  assert.deepEqual(f.methods(), ['thread/start', 'turn/start', 'thread/unsubscribe']);
  f.cleaned();
});


test('Codex thread progress resets idle time, but unrelated notifications do not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const result = f.start('high');
  const rejected = assert.rejects(result, /stopped sending progress/);
  await until(() => f.methods().includes('turn/start'));
  for (const method of ['item/started', 'item/reasoning/summaryTextDelta', 'item/agentMessage/delta']) {
    t.mock.timers.tick(240_000);
    f.notify(method, { delta: 'progress' });
  }
  t.mock.timers.tick(240_000);
  f.notify('item/started', { threadId: 'unrelated-thread' });
  t.mock.timers.tick(60_000);
  await rejected;
  f.cleaned();
});

test('Codex high effort tolerates long reasoning and still enforces an overall ceiling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const result = f.start('max');
  const rejected = assert.rejects(result, /time limit for this effort/);
  await until(() => f.methods().includes('turn/start'));
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(300_000);
    f.notify('item/reasoning/summaryTextDelta', { delta: 'thinking' });
  }
  t.mock.timers.tick(300_000);
  await rejected;
  f.cleaned();
});
