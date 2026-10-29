import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { Store } from '../server/db.ts';

const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
const source = stripTypeScriptTypes(main.slice(main.indexOf("route('DELETE', '/api/sessions/:id'"), main.indexOf('// ---------------------------------------------------------------- recorded audio')));
for (const failed of ['audio', 'frames', 'mybot', 'none']) {
  test(`deletion stays successful and tries all cleanup when ${failed} removal fails`, async () => {
    const store = new Store(':memory:');
    store.createSession({ id: 's', title: 'Synthetic', type: 'other', audio_source: 'mic' });
    let remove!: (req: unknown, res: unknown, params: { id: string }) => Promise<any>;
    const events: Array<{ name: string; data: any }> = [], removed: string[] = [], logs: string[] = [];
    const deps = {
      store, join, FRAMES_DIR: '/tmp/frames', AUDIO_DIR: '/tmp/audio', HttpError: Error,
      manager: { session: null, invalidateDeferredSummary() {} }, speakers: { cancel: async () => {} }, assistant: { cancelSession() {} },
      route: (_m: string, _p: string, handler: typeof remove) => { remove = handler; },
      broadcast: (name: string, data: unknown) => { assert.equal(store.getSession('s'), undefined); events.push({ name, data }); },
      log: (_scope: string, text: string) => logs.push(text),
      mybot: { dir: '/tmp/mybot', remove: () => { removed.push('mybot'); if (failed === 'mybot') throw new Error('EPERM'); } },
      rm: async (path: string, options: unknown) => {
        assert.deepEqual(options, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        assert.equal(events[0].name, 'session-deleted');
        removed.push(path); if (path.includes(failed)) throw new Error('EBUSY');
      },
    };
    new Function(...Object.keys(deps), source)(...Object.values(deps));
    try {
      assert.deepEqual(await remove(null, null, { id: 's' }), { ok: true });
      assert.deepEqual(removed, ['mybot', '/tmp/frames/s', '/tmp/audio/s']);
      assert.equal(events.filter((e) => e.name === 'session-deleted').length, 1);
      assert.equal(logs.length, failed === 'none' ? 0 : 1);
      if (failed !== 'none') { assert.equal(events[1].data.code, 'session_cleanup_failed'); assert.match(events[1].data.vars.paths, new RegExp(failed)); }
    } finally { store.close(); }
  });
}
