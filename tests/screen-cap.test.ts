import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store, FrameRow } from '../server/db.ts';

const root = mkdtempSync(join(tmpdir(), 'chumi-screen-cap-'));
process.env.CHUMI_DATA_DIR = root;
const { ScreenWatcher } = await import('../server/screen/watcher.ts');
test.after(() => rmSync(root, { force: true, recursive: true }));

test('the slide cap emits one notice, persists in state, and still allows on-demand snapshots', async (t) => {
  const frames: FrameRow[] = [];
  const store = { frames: () => Array(399), addFrame: (row: FrameRow) => { const frame = { ...row, id: frames.length + 1 }; frames.push(frame); return frame; } } as unknown as Store;
  const watcher = new ScreenWatcher(store, { sessionId: 'session', windowId: 1, nowT: () => 1000, intervalSec: 5 });
  const notices: string[] = [], states: boolean[] = [];
  watcher.on('notice', (_level, code) => notices.push(code));
  watcher.on('state', () => states.push(watcher.capped));
  const internal = watcher as unknown as { tick(): Promise<void>; capture(): Promise<unknown> };
  t.mock.method(internal, 'capture', async () => { writeFileSync(watcher.latestPath, 'image'); return { mean: 100, thumb: Buffer.from([100]).toString('base64') }; });
  assert.equal(watcher.capped, false);
  await internal.tick();
  assert.equal(watcher.capped, true);
  assert.deepEqual(notices, ['screen_capped']);
  assert.deepEqual(states, [true]);
  await internal.tick();
  assert.equal(frames.length, 1);
  assert.equal((await watcher.snapshot())?.kind, 'snapshot');
  assert.equal(frames.length, 2);
  assert.deepEqual(notices, ['screen_capped']);
  watcher.stop();
});
