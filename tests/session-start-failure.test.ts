import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeechService } from '../server/asr/speech.ts';
import type { Assistant } from '../server/ai/assistant.ts';

const root = mkdtempSync(join(tmpdir(), 'chumi-start-failure-'));
process.env.CHUMI_DATA_DIR = root;
const { SessionManager } = await import('../server/session/manager.ts');
const { HelperCapture } = await import('../server/audio/capture.ts');
const { Store } = await import('../server/db.ts');
const { AUDIO_DIR, FRAMES_DIR } = await import('../server/paths.ts');
test.after(() => rmSync(root, { recursive: true, force: true }));

for (const received of [false, true]) test(`failed first Start ${received ? 'preserves captured audio' : 'removes the empty session and its files'}`, async (t) => {
  const store = new Store(':memory:');
  const manager = new SessionManager(store, { ensure: async () => {}, state: 'ready' } as unknown as SpeechService, { onActivity: () => {} } as unknown as Assistant, () => {});
  let id = '';
  t.mock.method(HelperCapture.prototype, 'start', async function (this: InstanceType<typeof HelperCapture>) {
    id = manager.session!.id;
    if (received) this.emit('frames', 'mic', 0, new Int16Array(16000));
    for (const base of [AUDIO_DIR, FRAMES_DIR]) { const dir = join(base, id); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'fixture'), 'owned file'); }
    throw new Error('No microphone found.');
  });
  t.mock.method(HelperCapture.prototype, 'stop', async () => {});
  t.after(async () => { await manager.suspendForShutdown(); store.close(); });
  await assert.rejects(manager.start({ title: 'Failed start', type: 'other', source: 'mic' }), /No microphone/);
  assert.equal(manager.status, 'idle');
  assert.equal(manager.session, null);
  assert.equal(store.listSessions().length, received ? 1 : 0);
  if (received) assert.equal(store.getSession(id)?.duration_ms, 1000);
  else assert.deepEqual(store.timeline(id), []);
  for (const base of [AUDIO_DIR, FRAMES_DIR]) assert.equal(existsSync(join(base, id)), received);
});
