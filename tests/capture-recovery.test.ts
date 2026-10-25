import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Store } from '../server/db.ts';
import { SessionManager } from '../server/session/manager.ts';
import { HelperCapture } from '../server/audio/capture.ts';
import type { Transcriber } from '../server/asr/transcriber.ts';
import type { SpeechService } from '../server/asr/speech.ts';
import type { Assistant } from '../server/ai/assistant.ts';

type RunView = { input: HelperCapture; recorder: { write(): void; close(): void } | null };
const turn = async () => { await setImmediate(); await setImmediate(); };

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0;
  let nextStart: ((input: HelperCapture) => Promise<void>) | null = null;
  t.mock.method(HelperCapture.prototype, 'start', async function (this: HelperCapture) {
    starts++;
    const pending = nextStart;
    nextStart = null;
    await pending?.(this);
  });
  t.mock.method(HelperCapture.prototype, 'stop', async () => {});
  const store = new Store(':memory:');
  const live: Array<{ status: string }> = [];
  const speech = { state: 'ready', partials: false, ensure: async () => {}, transcribe: async () => ({
    text: 'The buffered words were preserved.', language: 'en', langProbs: {}, segments: [], ms: 1,
  }) } as unknown as SpeechService;
  const manager = new SessionManager(store, speech, { onActivity() {}, summary() { return null; } } as unknown as Assistant,
    (event, data) => { if (event === 'live') live.push(data as { status: string }); });
  const session = await manager.start({ title: 'Synthetic capture recovery', type: 'other', source: 'mic', recordAudio: false });
  const internal = manager as unknown as { run: RunView; transcriber: Transcriber };
  const input = internal.run.input;
  t.after(async () => { await manager.suspendForShutdown(); store.close(); });
  return {
    manager, store, session, input, internal, live,
    starts: () => starts,
    nextStart: (start: (input: HelperCapture) => Promise<void>) => { nextStart = start; },
    restart: async () => { t.mock.timers.tick(1500); await turn(); },
  };
}

test('exhausted capture restarts pause, flush buffered speech, close audio, and allow an explicit resume', async (t) => {
  const f = await fixture(t);
  let closes = 0, closed = false;
  f.internal.run.recorder = { write() {}, close() { if (!closed) { closed = true; closes++; } } };
  for (let n = 0; n < 3; n++) {
    f.input.emit('exit', 1, 'Synthetic capture failure.');
    await f.restart();
    assert.equal(f.manager.status, 'recording');
  }
  assert.equal(f.starts(), 4);
  // No trailing silence: only the failure cleanup can flush this utterance.
  f.input.emit('frames', 'mic', 0, new Int16Array(16_000).fill(6000));
  f.input.emit('level', 'mic', -20, -10);
  f.input.emit('exit', 1, 'Synthetic final capture failure.');
  await turn();
  assert.equal(f.manager.status, 'paused');
  assert.equal(f.store.getSession(f.session.id)?.status, 'paused');
  assert.equal(closes, 1);
  assert.equal(f.store.segments(f.session.id).length, 1);
  assert.equal(f.store.timeline(f.session.id).filter((r) => r.kind === 'pause').length, 1);
  assert.deepEqual(f.manager.lastLevels, {});
  assert.equal(f.manager.warnings.at(-1)?.code, 'capture_recovery_failed');
  assert.equal(f.live.at(-1)?.status, 'paused');
  await f.restart();
  assert.equal(f.starts(), 4);

  await f.manager.resume();
  assert.equal(f.manager.status, 'recording');
  assert.equal(f.starts(), 5);
  assert.notEqual(f.internal.run.input, f.input);
  await f.manager.end();
});

for (const emitExit of [false, true]) test(`a rejected restart pauses once${emitExit ? ' even when it also emits exit' : ''}`, async (t) => {
  const f = await fixture(t);
  f.nextStart(async (input) => {
    if (emitExit) input.emit('exit', 1, 'The restarted helper exited.');
    throw new Error('The audio device is unavailable.');
  });
  f.input.emit('exit', 1, 'Synthetic initial capture failure.');
  await f.restart();
  assert.equal(f.manager.status, 'paused');
  assert.equal(f.store.getSession(f.session.id)?.status, 'paused');
  assert.equal(f.starts(), 2);
  assert.equal(f.manager.warnings.filter((w) => w.code === 'capture_recovery_failed').length, 1);
  assert.equal(f.store.timeline(f.session.id).filter((r) => r.kind === 'pause').length, 1);
  await f.restart();
  assert.equal(f.starts(), 2);
});

test('a restart reporting ready and exiting in the same turn is still treated as failed', async (t) => {
  const f = await fixture(t);
  f.nextStart(async (input) => { input.emit('exit', 1, 'The restarted helper exited after readiness.'); });
  f.input.emit('exit', 1, 'Synthetic initial capture failure.');
  await f.restart();
  assert.equal(f.manager.status, 'paused');
  assert.equal(f.manager.warnings.at(-1)?.code, 'capture_recovery_failed');
});

for (const action of ['pause', 'end'] as const) test(`manual ${action} cancels a scheduled automatic restart`, async (t) => {
  const f = await fixture(t);
  f.input.emit('exit', 1, 'Synthetic capture failure.');
  await f.manager[action]();
  await f.restart();
  assert.equal(f.starts(), 1);
  assert.equal(f.manager.status, action === 'pause' ? 'paused' : 'idle');
  assert.equal(f.manager.warnings.some((w) => w.code === 'capture_recovery_failed'), false);
});

test('a late restart rejection and frames from an old run cannot pause or contaminate a resumed run', async (t) => {
  const f = await fixture(t);
  let rejectRestart!: (reason: Error) => void;
  f.nextStart(() => new Promise<void>((_resolve, reject) => { rejectRestart = reject; }));
  f.input.emit('exit', 1, 'Synthetic capture failure.');
  await f.restart();
  await f.manager.pause();
  await f.manager.resume();
  const current = f.internal.run.input;
  rejectRestart(new Error('Late failure from the stopped run.'));
  f.input.emit('frames', 'mic', 0, new Int16Array(16_000).fill(6000));
  f.input.emit('level', 'mic', -20, -10);
  f.input.emit('helper', { type: 'error', code: 'obsolete_helper', message: 'Late helper event.' });
  await turn();
  assert.equal(f.manager.status, 'recording');
  assert.equal(f.internal.run.input, current);
  assert.deepEqual(f.manager.lastLevels, {});
  assert.equal(f.manager.warnings.some((w) => w.code === 'capture_recovery_failed' || w.code === 'obsolete_helper'), false);
  await f.manager.end();
  assert.deepEqual(f.store.segments(f.session.id), []);
});

test('ending during an in-flight restart stays ended when the restart later fails', async (t) => {
  const f = await fixture(t);
  let rejectRestart!: (reason: Error) => void;
  f.nextStart(() => new Promise<void>((_resolve, reject) => { rejectRestart = reject; }));
  f.input.emit('exit', 1, 'Synthetic capture failure.');
  await f.restart();
  await f.manager.end();
  rejectRestart(new Error('Late failure after the meeting ended.'));
  await turn();
  assert.equal(f.manager.status, 'idle');
  assert.equal(f.store.getSession(f.session.id)?.status, 'ended');
  assert.equal(f.manager.warnings.some((w) => w.code === 'capture_recovery_failed'), false);
});
