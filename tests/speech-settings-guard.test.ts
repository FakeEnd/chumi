import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { MODEL_CATALOG } from '../server/asr/models.ts';
import { Store } from '../server/db.ts';
import { deepMerge } from '../server/util.ts';
import { EFFORTS, PET_TAGS, isProviderId, type Settings } from '../server/settings.ts';
import { validateCompatibleSettings } from '../shared/compatible-provider.ts';
import { MODEL_MIRROR_URL, normalizeModelBaseUrl } from '../shared/model-source.ts';
import { isSpeechEngine, normalizeLocalAsrUrl, normalizeQwenCloudUrl, speechModelId } from '../server/asr/engines.ts';
import { speechEngineChanged, speechRestartRequired } from '../server/asr/settings-guard.ts';
import { validateMybotDirectory } from '../server/mybot-export.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveStatus } from '../server/session/manager.ts';

// Exercise the actual settings mutation boundary with an in-memory store and inert service adapters.
// It must reject before either saving configuration or restarting a service.
const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
const source = stripTypeScriptTypes(main.slice(main.indexOf('function applySettingsPatch('), main.indexOf('// ---------------------------------------------------------------- routes')));
// A fixed CPU limit, so the thread checks don't depend on how many cores the test machine has (CI runners have 3).
const THREAD_LIMIT = 16;
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function fixture(status: LiveStatus, initial: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const store = new Store(':memory:');
  store.saveSettings(deepMerge(store.getSettings(), initial) as Settings);
  const calls: string[] = [];
  const deps = {
    ASR_THREAD_LIMIT: THREAD_LIMIT, MODEL_CATALOG, store, manager: { status }, deepMerge, isProviderId, validateCompatibleSettings, EFFORTS, PET_TAGS, isInstalled: () => true,
    HttpError, isSpeechEngine, normalizeLocalAsrUrl, normalizeQwenCloudUrl, speechModelId, normalizeModelBaseUrl,
    downloader: { discardPartials: () => calls.push('discardPartials') },
    speechEngineChanged, speechRestartRequired, speakerRuntime: () => ({ ready: true }), DEV: true,
    assistant: { setAutoExplain: () => {} }, whisper: { configure: () => calls.push('whisper') },
    speech: { configure: () => calls.push('speech') }, hotkey: { configure: () => {} }, mybot: { exportAll: () => {} },
    registry: { status: async () => {} }, broadcast: () => calls.push('settings'),
    validateMybotDirectory, exportMybotSessions: async () => {}, mybotExportFailed: () => {}, ...overrides,
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
    assert.deepEqual(f.calls, ['discardPartials', 'speech', 'settings']);
    f.calls.length = 0;
    const model = f.store.getSettings().asr.model === 'ggml-small-q5_1.bin' ? 'ggml-base-q5_1.bin' : 'ggml-small-q5_1.bin';
    assert.equal(f.apply({ asr: { model } }).asr.model, model);
    assert.deepEqual(f.calls, ['discardPartials', 'whisper', 'settings']);
  } finally { f.store.close(); }
});

test('changing the download source validates it without restarting speech or discarding resumable bytes', () => {
  const f = fixture('recording');
  try {
    const before = f.store.getSettings();
    assert.throws(() => f.apply({ asr: { modelBaseUrl: 'file:///tmp/models' } }), (e: unknown) => e instanceof HttpError && e.status === 400);
    assert.deepEqual(f.store.getSettings(), before);
    assert.deepEqual(f.calls, []);
    assert.equal(f.apply({ asr: { modelBaseUrl: `${MODEL_MIRROR_URL}/` } }).asr.modelBaseUrl, MODEL_MIRROR_URL);
    assert.deepEqual(f.calls, ['settings']);
  } finally { f.store.close(); }
});


test('invalid thread counts never save or restart speech, and unchanged counts do not restart', () => {
  const f = fixture('idle'), before = f.store.getSettings();
  try {
    for (const threads of [0, 1, 2.5, THREAD_LIMIT + 1, 99, '', '4', null]) {
      assert.throws(() => f.apply({ asr: { threads } }), (e: unknown) => e instanceof HttpError && e.status === 400);
      assert.deepEqual(f.store.getSettings(), before);
      assert.deepEqual(f.calls, []);
    }
    f.apply({ asr: { threads: before.asr.threads } });
    assert.deepEqual(f.calls, ['settings']);
  } finally { f.store.close(); }
});


test('mybot rejects invalid folders before saving or broadcasting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-mybot-settings-'));
  writeFileSync(join(dir, 'file'), 'not a folder');
  const f = fixture('idle'), before = f.store.getSettings();
  try {
    for (const exportDir of ['', 'relative/path', join(dir, 'file', 'child')]) {
      assert.throws(() => f.apply({ integrations: { mybot: { enabled: true, exportDir } } }), (e: unknown) => e instanceof HttpError && e.status === 400);
      assert.deepEqual(f.store.getSettings(), before);
      assert.deepEqual(f.calls, []);
    }
  } finally { f.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a deferred mybot failure cannot turn a saved setting into a failed request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-mybot-settings-')), events: string[] = [];
  const f = fixture('idle', {}, { broadcast: () => events.push('settings'), exportMybotSessions: async () => { events.push('export'); throw new Error('disk removed'); }, mybotExportFailed: () => events.push('warning') });
  try {
    const saved = f.apply({ integrations: { mybot: { enabled: true, exportDir: ` ${dir} ` } } });
    assert.equal(saved.integrations.mybot.exportDir, dir);
    assert.equal(f.store.getSettings().integrations.mybot.enabled, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['settings', 'export', 'warning']);
  } finally { f.store.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('automatic mybot export broadcasts its completion after the saved settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-mybot-settings-')), events: string[] = [];
  let finish!: (result: { exported: number; dir: string }) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  const f = fixture('idle', {}, { broadcast: (event: string) => events.push(event), exportMybotSessions: () => pending });
  try {
    f.apply({ integrations: { mybot: { enabled: true, exportDir: dir } } });
    assert.deepEqual(events, ['settings']);
    finish({ exported: 3, dir }); await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['settings', 'mybot-exported']);
  } finally { f.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
