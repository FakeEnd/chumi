import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { Store } from '../server/db.ts';

function history(store: Store) {
  store.createProject({ id: 'p', name: 'P', workspace: '/tmp/chumi-order' });
  for (const [id, created_at, started_at] of [
    ['mobile', 300, 100], ['later', 200, 200], ['legacy', 250, null], ['z-tie', 60, 200], ['a-tie', 50, 200], ['epoch', 400, 0],
  ] as const) {
    store.createSession({ id, title: 'Meeting', type: 'lab_meeting', audio_source: id === 'mobile' ? 'mobile' : 'mic' });
    store.updateSession(id, { created_at, started_at });
    if (id !== 'legacy') store.assignSession(id, 'p');
    store.addSegment({ session_id: id, t_start: 0, t_end: 1000, text: 'needle', lang: null, source: 'mic', run: 0 });
  }
}

test('history and search sort by recording start, with creation fallback and stable ties', () => {
  const store = new Store(':memory:');
  try {
    history(store);
    for (const query of [undefined, ' ', 'needle']) {
      assert.deepEqual(store.listSessions(query).map((s) => s.id), ['legacy', 'a-tie', 'later', 'z-tie', 'mobile', 'epoch']);
      assert.deepEqual(store.listSessions(query, 'p').map((s) => s.id), ['a-tie', 'later', 'z-tie', 'mobile', 'epoch']);
      assert.deepEqual(store.listSessions(query, 'none').map((s) => s.id), ['legacy']);
    }
  } finally { store.close(); }
});

test('the pet opens the latest recording from the server order, not the most recently synced meeting', async () => {
  const store = new Store(':memory:');
  try {
    history(store);
    // Run the shipped method with the same HTTP stand-in pattern as the web action tests.
    const source = readFileSync(new URL('../web/src/pet/companion.ts', import.meta.url), 'utf8');
    const method = source.slice(source.indexOf('  async loadLatest()'), source.indexOf('  private async load('));
    const code = stripTypeScriptTypes(`class Companion { ${method} }`);
    const loadLatest = new Function('api', `${code}\nreturn Companion.prototype.loadLatest;`)(
      async (path: string) => { assert.equal(path, '/api/sessions'); return { sessions: store.listSessions() }; },
    ) as (this: object) => Promise<void>;
    let loaded: string | null = null;
    await loadLatest.call({ load: async (id: string) => { loaded = id; } });
    assert.equal(loaded, 'legacy');
  } finally { store.close(); }
});
