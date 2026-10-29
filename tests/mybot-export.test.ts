import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportMybotSessions } from '../server/mybot-export.ts';
import { deepMerge } from '../server/util.ts';
import { componentHarness, tick } from './helpers/web-ui.ts';
import { DEFAULT_SETTINGS } from '../server/settings.ts';
import { Store } from '../server/db.ts';

test('bulk export defers work, yields between meetings, and stops after settings change', async () => {
  const store = new Store(':memory:');
  store.saveSettings(deepMerge(store.getSettings(), { integrations: { mybot: { enabled: true } } }));
  for (let i = 0; i < 3; i++) store.createSession({ id: String(i), title: 'Synthetic', type: 'other', audio_source: 'mic' });
  const calls: string[] = [];
  const job = exportMybotSessions(store, { dir: '/tmp/synthetic', sync: (id) => { calls.push(id); setImmediate(() => store.saveSettings(deepMerge(store.getSettings(), { integrations: { mybot: { enabled: false } } }))); return true; } });
  assert.deepEqual(calls, []);
  try { assert.equal((await job).exported, 1); assert.equal(calls.length, 1); }
  finally { store.close(); }
});


test('the integrations tab refreshes its count when a deferred export finishes', async () => {
  const state = { settings: DEFAULT_SETTINGS, settingsTab: 'integrations', mybotExportRev: 0 };
  const icons = Object.fromEntries(['Bolt', 'Bulb', 'Folder', 'Globe', 'Link', 'Mic', 'Pet', 'Shield', 'Spark', 'Terminal', 'Wave', 'Window'].map((name) => [`Icon${name}`, name]));
  let files = 0, reads = 0;
  const ui = await componentHarness('SettingsDialog.tsx', 'SettingsDialog', {}, {
    ...icons, saveSettings: async () => true, Dialog: 'dialog', MybotServerSettings: 'server-settings', tn: (s: string, vars: Record<string, unknown>) => s.replace('{count}', String(vars.count ?? '')), plural: (n: number) => `${n} files`,
    useStore: (select: (s: unknown) => unknown) => select(state), api: async (path: string) => { assert.equal(path, '/api/integrations/mybot'); reads++; return { files, dir: '/tmp/synthetic' }; },
  });
  await tick(); ui.render(); assert.match(ui.text(), /0 files/);
  files = 3; state.mybotExportRev++; ui.render(); await tick(); ui.render();
  assert.equal(reads, 2); assert.match(ui.text(), /3 files/);
});
