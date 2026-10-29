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
async function recording(t: TestContext, source: 'mic' | 'system' | 'both' = 'mic') {
  const starts = t.mock.method(HelperCapture.prototype, 'start', async () => {});
  t.mock.method(HelperCapture.prototype, 'stop', async () => {});
  const store = new Store(':memory:');
  const notices: Array<{ code: string; message: string }> = [];
  const manager = new SessionManager(store, { ensure: async () => {}, state: 'ready' } as unknown as SpeechService, { onActivity: () => {} } as unknown as Assistant,
    (event, data) => { if (event === 'notice') notices.push(data as { code: string; message: string }); });
  const session = await manager.start({ title: 'Long meeting', type: 'other', source });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  t.after(async () => { t.mock.timers.reset(); await manager.end(); store.close(); });
  const input = (manager as unknown as { run: { input: InstanceType<typeof HelperCapture> } }).run.input;
  const crash = () => input.emit('exit', 1, 'helper exited (code 1)');
  const gaps = () => store.timeline(session.id).filter((e) => e.kind === 'gap');
  return { store, manager, session, notices, starts, input, crash, gaps };
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

for (const code of ['mic_permission_denied', 'no_input_device', 'system_tap_unsupported']) {
  test(`${code} pauses once with the original remedy and no crash retries`, async (t) => {
    const { manager, input, starts, crash, gaps, notices } = await recording(t);
    input.emit('helper', { type: 'error', code, message: 'Allow microphone access in System Settings.' });
    crash();
    await setImmediate();
    t.mock.timers.tick(60_000);
    assert.equal(manager.status, 'paused');
    assert.equal(starts.mock.callCount(), 1);
    assert.equal(gaps().length, 1);
    assert.match(gaps()[0].detail!, /Allow microphone access/);
    assert.deepEqual(notices.map((n) => n.code), [code]);
  });
}

test('capture health persists through silence and clears on signal or a successful restart', async (t) => {
  const { manager, input, crash, notices } = await recording(t);
  input.emit('helper', { type: 'warning', code: 'mic_silent', message: 'Microphone has no signal.' });
  assert.equal(manager.captureHealth.mic.state, 'silent');
  t.mock.timers.tick(30_000);
  assert.equal(manager.captureHealth.mic.state, 'silent');
  assert.ok(!notices.some((n) => n.code === 'mic_silent'), 'silence is persistent state, not a timed toast');
  input.emit('helper', { type: 'info', code: 'mic_silent_cleared', source: 'mic' });
  assert.equal(manager.captureHealth.mic.state, 'ok');
  crash();
  assert.equal(manager.captureHealth.mic.state, 'restarting');
  t.mock.timers.tick(1500);
  input.emit('helper', { type: 'ready', sources: ['mic'] });
  assert.equal(manager.captureHealth.mic.state, 'ok');
  assert.equal(notices.at(-1)?.code, 'capture_restarted');
});

test('manual pause and resume also clear an earlier restart warning once capture is ready', async (t) => {
  const { manager, crash, notices } = await recording(t);
  crash();
  await manager.pause();
  await manager.resume();
  const input = (manager as unknown as { run: { input: InstanceType<typeof HelperCapture> } }).run.input;
  input.emit('helper', { type: 'ready', sources: ['mic'] });
  assert.equal(notices.at(-1)?.code, 'capture_restarted');
  assert.equal(manager.warnings.some((w) => w.code === 'capture_stopped'), false);
});


for (const source of ['both', 'system'] as const) test(`system silence in ${source} mode has the appropriate notice lifetime`, async (t) => {
  const { manager, input, notices } = await recording(t, source);
  input.emit('helper', { type: 'warning', code: 'system_silent', message: 'No system audio signal for 15 s.' });
  assert.equal(manager.captureHealth.system.state, 'silent');
  assert.equal(notices.some((n) => n.code === 'system_silent'), source === 'both', 'only normal computer-audio lulls use a dismissible toast');
  const message = 'The microphone "{device}" has delivered digital silence (all zeros) for {seconds} s.';
  input.emit('helper', { type: 'warning', code: 'mic_silent', message, vars: { device: 'USB Audio', seconds: 10 } });
  assert.equal(manager.captureHealth.mic.message, message);
  assert.deepEqual(manager.captureHealth.mic.vars, { device: 'USB Audio', seconds: 10 });
  input.emit('helper', { type: 'info', code: 'system_silent_cleared' });
  assert.equal(manager.captureHealth.system.state, 'ok');
});
