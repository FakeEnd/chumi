import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Assistant } from '../server/ai/assistant.ts';
import type { SpeechService } from '../server/asr/speech.ts';

const root = mkdtempSync(join(tmpdir(), 'chumi-capture-restart-'));
process.env.CHUMI_DATA_DIR = root;
const { Store } = await import('../server/db.ts');
const { SessionManager } = await import('../server/session/manager.ts');
const { HelperCapture } = await import('../server/audio/capture.ts');
test.after(() => rmSync(root, { recursive: true, force: true }));

/** A live microphone session whose capture helper starts instantly; the test makes it crash. */
async function recording(t: TestContext) {
  const starts = t.mock.method(HelperCapture.prototype, 'start', async () => {});
  t.mock.method(HelperCapture.prototype, 'stop', async () => {});
  const store = new Store(':memory:');
  const notices: Array<{ code: string; message: string }> = [];
  const manager = new SessionManager(store, { ensure: async () => {}, state: 'ready' } as unknown as SpeechService, { onActivity: () => {} } as unknown as Assistant,
    (event, data) => { if (event === 'notice') notices.push(data as { code: string; message: string }); });
  const session = await manager.start({ title: 'Long meeting', type: 'other', source: 'mic' });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  t.after(async () => { t.mock.timers.reset(); await manager.end(); store.close(); });
  const input = (manager as unknown as { run: { input: InstanceType<typeof HelperCapture> } }).run.input;
  const crash = () => input.emit('exit', 1, 'helper exited (code 1)');
  const gaps = () => store.timeline(session.id).filter((e) => e.kind === 'gap');
  return { store, manager, session, notices, starts, crash, gaps };
}

test('a capture helper that keeps crashing is retried with backoff, then the session is paused with a gap marker', { timeout: 5000 }, async (t) => {
  const { store, manager, session, notices, starts, crash, gaps } = await recording(t);
  for (const delay of [1500, 3000, 6000]) {
    crash();
    assert.match(notices.at(-1)!.message, /Trying to restart/);
    t.mock.timers.tick(delay - 1);
    const before = starts.mock.callCount();
    t.mock.timers.tick(1);
    assert.equal(starts.mock.callCount(), before + 1, `restarted after ${delay} ms`);
  }
  crash();
  await setImmediate();
  assert.equal(manager.status, 'paused');
  assert.equal(store.getSession(session.id)!.status, 'paused');
  assert.equal(notices.at(-1)!.code, 'capture_gave_up');
  assert.doesNotMatch(notices.at(-1)!.message, /Trying to restart/);
  assert.equal(gaps().length, 4);
  assert.match(gaps().at(-1)!.detail!, /paused/);
  assert.ok(store.timeline(session.id).some((e) => e.kind === 'pause'));
});

test('a capture helper that ran stably before crashing gets a fresh set of restarts', { timeout: 5000 }, async (t) => {
  const { manager, starts, crash } = await recording(t);
  for (let i = 0; i < 6; i++) {
    crash();
    const before = starts.mock.callCount();
    t.mock.timers.tick(1500);
    assert.equal(starts.mock.callCount(), before + 1, 'the first, shortest backoff again');
    t.mock.timers.tick(61_000); // A Bluetooth headset reconnecting every minute or so.
  }
  assert.equal(manager.status, 'recording');
});
