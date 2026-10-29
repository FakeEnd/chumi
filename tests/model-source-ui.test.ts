import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../server/settings.ts';
import { MODEL_BASE_URL, MODEL_MIRROR_URL, modelSourceName, normalizeModelBaseUrl } from '../shared/model-source.ts';
import { transcriptionHarness } from './helpers/transcription-ui.ts';
import { tick, words } from './helpers/web-ui.ts';

test('Transcription names the effective source, lets a saved mirror be replaced, and discards partial downloads', async () => {
  for (const [baseUrl, fromEnvironment] of [[MODEL_MIRROR_URL, false], ['https://models.example.test/whisper', true]] as const) {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.asr.modelBaseUrl = fromEnvironment ? MODEL_BASE_URL : baseUrl;
    const list = { source: { baseUrl, fromEnvironment }, models: [{ id: 'model.bin', name: 'Test model', sizeMB: 10, speed: 1, accuracy: 1, minRamGB: 1, note: { en: 'test', zh: '测试' }, installed: false, active: false, partial: true }], download: null };
    const calls: unknown[] = [], prompts: string[] = [];
    const ui = await transcriptionHarness({ settings, live: null, asrDownload: null }, {
      saveSettings: async (patch: unknown) => { calls.push(patch); return true; },
      api: async (path: string, options: unknown) => { calls.push({ path, options }); return list; },
      confirm: (prompt: string) => { prompts.push(prompt); return true; },
    });
    await tick(); ui.render(); calls.length = 0;
    const select = ui.find((node) => node.type === 'select' && node.props.value === baseUrl);
    assert.ok(select);
    assert.equal(select.props.disabled, fromEnvironment);
    if (!fromEnvironment) {
      select.props.onChange({ target: { value: MODEL_BASE_URL } });
      assert.deepEqual(calls.shift(), { asr: { modelBaseUrl: MODEL_BASE_URL } });
    } else assert.match(ui.text(), /Set by CHUMI_MODEL_BASE_URL/);
    const download = ui.find((node) => node.type === 'button' && words(node).startsWith('Download ·'));
    download.props.onClick();
    assert.ok(prompts[0].includes(`from ${modelSourceName(baseUrl)}?`), prompts[0]);
    const discard = ui.button('Discard partial download');
    discard.props.onClick();
    assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify({ path: '/api/asr/models/model.bin', options: { method: 'DELETE' } })));
    await tick(); ui.unmount();
  }
});

test('model sources accept HTTP mirrors and reject malformed URLs and embedded credentials', () => {
  assert.equal(normalizeModelBaseUrl(`${MODEL_MIRROR_URL}/`), MODEL_MIRROR_URL);
  for (const value of ['not a URL', 'file:///tmp/models', 'https://user:secret@example.test/models', 'https://example.test/?key=secret', null]) assert.throws(() => normalizeModelBaseUrl(value), /HTTP\(S\)/);
});
