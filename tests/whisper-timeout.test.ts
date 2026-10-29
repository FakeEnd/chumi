import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { WhisperServer } from '../server/asr/whisper.ts';

function processStub() {
  const signals: string[] = [];
  const proc = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: (signal: string) => { signals.push(signal); return true; } });
  return { proc: proc as unknown as ChildProcess, signals };
}

for (const timeoutMs of [90_000, 20_000]) test(`${timeoutMs} ms inference timeout ${timeoutMs === 90_000 ? 'recycles a stuck final worker before retry' : 'leaves a slow preview worker running'}`, async (t) => {
  const server = new WhisperServer({ model: 'unused', threads: 2 });
  const internal = server as unknown as { proc: ChildProcess | null };
  const first = processStub(), second = processStub();
  internal.proc = first.proc;
  server.state = 'ready';
  t.mock.method(server, 'ensure', async () => { if (!internal.proc) { internal.proc = second.proc; server.state = 'ready'; } });
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => timeout.signal);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    if (++requests > 1) return new Response(JSON.stringify({ text: 'Recovered final.' }), { headers: { 'content-type': 'application/json' } });
    return new Promise<Response>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = server.transcribe(new Int16Array(16000), { language: 'en', timeoutMs });
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  await setImmediate();
  timeout.abort(new DOMException('Inference timed out', 'TimeoutError'));
  await setImmediate();
  if (timeoutMs === 90_000) {
    assert.equal(server.state, 'error');
    assert.equal(internal.proc, null);
    assert.deepEqual(first.signals, ['SIGTERM']);
    t.mock.timers.tick(3000);
    await rejected;
    assert.deepEqual(first.signals, ['SIGTERM', 'SIGKILL']);
    const result = await server.transcribe(new Int16Array(16000), { language: 'en', timeoutMs });
    assert.equal(result.text, 'Recovered final.');
    assert.equal(internal.proc, second.proc);
  } else {
    await rejected;
    assert.equal(server.state, 'ready');
    assert.deepEqual(first.signals, []);
  }
});

test('a timeout from an obsolete request cannot kill its replacement worker', async (t) => {
  const server = new WhisperServer({ model: 'unused', threads: 2 });
  const internal = server as unknown as { proc: ChildProcess | null };
  const old = processStub(), replacement = processStub();
  internal.proc = old.proc;
  server.state = 'ready';
  t.mock.method(server, 'ensure', async () => {});
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => timeout.signal);
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((_resolve, reject) => timeout.signal.addEventListener('abort', () => reject(timeout.signal.reason))));
  const pending = server.transcribe(new Int16Array(10), { language: 'en', timeoutMs: 90_000 });
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  await setImmediate();
  internal.proc = replacement.proc;
  timeout.abort(new DOMException('Timed out', 'TimeoutError'));
  await rejected;
  assert.equal(internal.proc, replacement.proc);
  assert.deepEqual(replacement.signals, []);
  assert.equal(server.state, 'ready');
});
