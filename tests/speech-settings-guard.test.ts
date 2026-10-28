import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { QWEN_MODEL_ID } from '../server/asr/models.ts';
import { Store } from '../server/db.ts';
import { deepMerge } from '../server/util.ts';
import { EFFORTS, PET_TAGS, isProviderId, type Settings } from '../server/settings.ts';
import { validateCompatibleSettings } from '../shared/compatible-provider.ts';
import { isSpeechEngine, normalizeLocalAsrUrl, normalizeQwenCloudUrl, speechModelId } from '../server/asr/engines.ts';
import { speechEngineChanged, speechRestartRequired } from '../server/asr/settings-guard.ts';
import type { LiveStatus } from '../server/session/manager.ts';

// Exercise the actual settings mutation boundary with an in-memory store and inert service adapters.
// It must reject before either saving configuration or restarting a service.
const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
const source = stripTypeScriptTypes(main.slice(main.indexOf('function applySettingsPatch('), main.indexOf('// ---------------------------------------------------------------- routes')));
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function fixture(status: LiveStatus, initial: Record<string, unknown> = {}) {
  const store = new Store(':memory:');
  store.saveSettings(deepMerge(store.getSettings(), initial) as Settings);
  const calls: string[] = [];
  const deps = {
    QWEN_MODEL_ID, store, manager: { status }, deepMerge, isProviderId, validateCompatibleSettings, EFFORTS, PET_TAGS, isInstalled: () => true,
    HttpError, isSpeechEngine, normalizeLocalAsrUrl, normalizeQwenCloudUrl, speechModelId,
    speechEngineChanged, speechRestartRequired, speakerRuntime: () => ({ ready: true }), DEV: true,
    assistant: { setAutoExplain: () => {} }, whisper: { configure: () => calls.push('whisper') },
    speech: { configure: () => calls.push('speech') }, hotkey: { configure: () => {} }, mybot: { exportAll: () => {} },
    registry: { status: async () => {} }, broadcast: () => calls.push('settings'),
  };
  const apply = new Function(...Object.keys(deps), source + '\nreturn applySettingsPatch;')(...Object.values(deps)) as (patch: Record<string, unknown>) => Settings;
  return { store, calls, apply };
}

test('all active lifecycle phases reject changes that restart speech before touching settings or services', () => {
  for (const status of ['starting', 'recording', 'paused', 'ending'] as const) {
    const f = fixture(status), before = f.store.getSettings();
    try {
      for (const patch of [{ asr: { model: 'other-model.bin' } }, { asr: { threads: before.asr.threads === 8 ? 4 : 8 } }, { asr: { engine: 'qwen-local' } }]) {
        assert.throws(() => f.apply(patch), (e: unknown) => e instanceof HttpError && e.status === 409, status);
        assert.deepEqual(f.store.getSettings(), before);
        assert.deepEqual(f.calls, []);
      }
    } finally { f.store.close(); }
  }
});

test('ending also protects the selected service endpoint and model', () => {
  for (const engine of ['qwen-cloud', 'qwen-local'] as const) {
    const f = fixture('ending', { asr: { engine } });
    try {
      const field = engine === 'qwen-cloud' ? 'qwenCloud' : 'qwenLocal';
      assert.throws(() => f.apply({ asr: { [field]: { model: 'other-model' } } }), (e: unknown) => e instanceof HttpError && e.status === 409);
      if (engine === 'qwen-local') assert.throws(() => f.apply({ asr: { qwenLocal: { baseUrl: 'http://127.0.0.1:9000/v1' } } }), /finish before changing/);
      assert.deepEqual(f.calls, []);
    } finally { f.store.close(); }
  }
});

test('unrelated speech hints and inactive service configuration remain editable without a restart', () => {
  const f = fixture('recording');
  try {
    const saved = f.apply({ asr: { language: 'zh', glossary: ['Synthetic term'], qwenLocal: { model: 'future-model' } } });
    assert.equal(saved.asr.language, 'zh');
    assert.equal(saved.asr.qwenLocal.model, 'future-model');
    assert.deepEqual(f.calls, ['settings']);
  } finally { f.store.close(); }
});

test('idle changes save and reconfigure exactly the relevant speech service', () => {
  const f = fixture('idle');
  try {
    const threads = f.store.getSettings().asr.threads === 8 ? 4 : 8;
    assert.equal(f.apply({ asr: { threads } }).asr.threads, threads);
    assert.deepEqual(f.calls, ['whisper', 'speech', 'settings']);
    f.calls.length = 0;
    assert.equal(f.apply({ asr: { engine: 'qwen-local' } }).asr.engine, 'qwen-local');
    assert.deepEqual(f.calls, ['speech', 'settings']);
  } finally { f.store.close(); }
});
