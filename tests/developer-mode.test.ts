import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentHarness } from './component-harness.ts';
import { DEFAULT_SETTINGS } from '../server/settings.ts';

test('turning off developer mode replaces only the offline test provider in the same save', async () => {
  for (const provider of ['mock', 'codex', 'claude-cli']) {
    const patches: unknown[] = [];
    const state = { settings: { ...DEFAULT_SETTINGS, devMode: true, ai: { ...DEFAULT_SETTINGS.ai, provider } }, settingsTab: 'assist' };
    const icons = Object.fromEntries(['Bolt', 'Bulb', 'Folder', 'Globe', 'Link', 'Mic', 'Pet', 'Shield', 'Spark', 'Terminal', 'Wave', 'Window'].map((name) => [`Icon${name}`, name]));
    const ui = await componentHarness('SettingsDialog.tsx', 'SettingsDialog', {}, { ...icons, Dialog: 'dialog', useStore: (select: (s: unknown) => unknown) => select(state), saveSettings: async (patch: unknown) => { patches.push(patch); return true; } });
    ui.input(' Developer mode').props.onChange({ target: { checked: false } });
    assert.deepEqual(patches, [provider === 'mock' ? { devMode: false, ai: { provider: 'codex' } } : { devMode: false }]);
  }
});
