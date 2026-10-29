import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endpointDirty, endpointDraftReducer as reduce, newEndpointDraft } from '../web/src/endpointDraft.ts';
import { speechPrivacy, speechSettingsBusy } from '../web/src/speechSettings.ts';
import { setLang } from '../web/src/i18n.ts';
import type { LiveState, Settings, SpeechEngineId } from '../web/src/types.ts';

const original = { baseUrl: 'http://localhost:8000/v1', model: 'original' };
const submitted = { baseUrl: 'http://localhost:9000/v1/', model: 'submitted' };
const normalized = { ...submitted, baseUrl: 'http://localhost:9000/v1' };

test('a settings event updates clean fields without replacing unsaved endpoint edits', () => {
  let state = newEndpointDraft(original);
  state = reduce(state, { type: 'edit', value: { ...original, model: 'unsaved' } });
  state = reduce(state, { type: 'saved', value: normalized });
  assert.deepEqual(state.value, { baseUrl: normalized.baseUrl, model: 'unsaved' });
  assert.equal(endpointDirty(state.value, state.saved), true);
});

for (const eventFirst of [true, false]) {
  test(`save preserves newer edits when the settings event arrives ${eventFirst ? 'before' : 'after'} the response`, () => {
    let state = newEndpointDraft(original);
    state = reduce(state, { type: 'edit', value: submitted });
    state = reduce(state, { type: 'submit', value: submitted });
    state = reduce(state, { type: 'edit', value: { ...submitted, model: 'typed while saving' } });
    if (eventFirst) state = reduce(state, { type: 'saved', value: normalized });
    state = reduce(state, { type: 'settled', value: normalized });
    if (!eventFirst) state = reduce(state, { type: 'saved', value: normalized });
    assert.deepEqual(state.value, { ...normalized, model: 'typed while saving' });
    assert.deepEqual(state.saved, normalized);
    assert.equal(state.submitted, null);
    assert.equal(endpointDirty(state.value, state.saved), true);
  });
}

test('a successful save adopts server normalization when the submitted draft is untouched', () => {
  let state = newEndpointDraft(original);
  state = reduce(state, { type: 'edit', value: submitted });
  state = reduce(state, { type: 'submit', value: submitted });
  state = reduce(state, { type: 'saved', value: normalized });
  state = reduce(state, { type: 'settled', value: normalized });
  assert.deepEqual(state.value, normalized);
  assert.equal(endpointDirty(state.value, state.saved), false);
});

test('editing back to the original value during a save is still a newer draft', () => {
  let state = newEndpointDraft(original);
  state = reduce(state, { type: 'edit', value: submitted });
  state = reduce(state, { type: 'submit', value: submitted });
  state = reduce(state, { type: 'edit', value: { ...submitted, model: original.model } });
  state = reduce(state, { type: 'saved', value: original });
  assert.deepEqual(state.value, { ...submitted, model: original.model });
  state = reduce(state, { type: 'saved', value: normalized });
  state = reduce(state, { type: 'settled', value: normalized });
  assert.deepEqual(state.value, { ...normalized, model: original.model });
  assert.equal(endpointDirty(state.value, state.saved), true);
});

test('a failed save preserves both the submission and further edits; discard uses the current saved settings', () => {
  let state = newEndpointDraft(original);
  state = reduce(state, { type: 'edit', value: submitted });
  state = reduce(state, { type: 'submit', value: submitted });
  const newer = { ...submitted, baseUrl: 'http://localhost:10000/v1' };
  state = reduce(state, { type: 'edit', value: newer });
  state = reduce(state, { type: 'settled', value: null });
  assert.deepEqual(state.value, newer);
  assert.equal(state.submitted, null);
  state = reduce(state, { type: 'saved', value: normalized });
  state = reduce(state, { type: 'discard' });
  assert.deepEqual(state.value, normalized);
});

test('speech settings stay locked throughout startup, recording, pause and transcription drain', () => {
  for (const status of ['starting', 'recording', 'paused', 'ending'] as LiveState['status'][]) {
    assert.equal(speechSettingsBusy({ status }), true, status);
  }
  assert.equal(speechSettingsBusy({ status: 'idle' }), false);
  assert.equal(speechSettingsBusy(null), false);
});

test('privacy text identifies each configured transcription destination in both interface languages', () => {
  const asr = (engine: SpeechEngineId, baseUrl = 'http://localhost:8000/v1') => ({
    engine, qwenCloud: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3-asr-flash' },
    qwenLocal: { baseUrl, model: 'Qwen/Qwen3-ASR-1.7B' },
  }) as Settings['asr'];
  try {
    for (const lang of ['en', 'zh'] as const) {
      setLang(lang);
      assert.match(speechPrivacy(asr('sensevoice')), /SenseVoice/);
      assert.match(speechPrivacy(asr('qwen3')), /Qwen3/);
      assert.match(speechPrivacy(asr('whisper')), /Whisper/);
      assert.match(speechPrivacy(asr('elevenlabs')), /ElevenLabs/);
      assert.match(speechPrivacy(asr('qwen-cloud')), /dashscope-intl\.aliyuncs\.com/);
      for (const baseUrl of ['http://localhost:8000/v1', 'https://speech.example.org/v1']) {
        const message = speechPrivacy(asr('qwen-local', baseUrl));
        assert.ok(message.includes(baseUrl));
        assert.match(message, lang === 'en' ? /forwards audio elsewhere/ : /转发到其他地方/);
      }
      assert.match(speechPrivacy(undefined), lang === 'en' ? /selected speech recognition engine/ : /所选语音识别引擎/);
    }
  } finally { setLang('en'); }
});


test('thread drafts restore empty input and round and clamp only when committed', async () => {
  const { threadDraftValue, maxAsrThreads } = await import('../shared/asr-threads.ts');
  for (const draft of ['', ' ', 'NaN']) assert.equal(threadDraftValue(draft, 6, 10), 6);
  for (const [draft, expected] of [['1', 2], ['12', 10], ['99', 10], ['2.5', 3], ['6', 6]] as const) assert.equal(threadDraftValue(draft, 6, 10), expected);
  assert.equal(maxAsrThreads(32), 16);
  assert.equal(maxAsrThreads(1), 2);
});

test('typing a thread count sends no saves until blur or Enter and unchanged values stay idle', async () => {
  const { componentHarness, tick } = await import('./component-harness.ts');
  const { DEFAULT_SETTINGS } = await import('../server/settings.ts');
  const { threadDraftValue, maxAsrThreads } = await import('../shared/asr-threads.ts');
  const state = { settings: { ...DEFAULT_SETTINGS, asr: { ...DEFAULT_SETTINGS.asr, threads: 6 } }, live: null };
  const calls: unknown[] = [];
  const ui = await componentHarness('TranscriptionTab.tsx', 'TranscriptionTab', {}, {
    useStore: (select: (s: unknown) => unknown) => select(state), speechSettingsBusy, threadDraftValue, maxAsrThreads,
    SpeakerSettings: 'speakers', SpeechEngineSettings: 'engine', getLang: () => 'en', tn: (s: string) => s,
    api: async () => ({ hardware: { cores: 10 }, models: [] }),
    saveSettings: async (patch: { asr: { threads: number } }) => { calls.push(patch); state.settings.asr.threads = patch.asr.threads; return true; },
  });
  await tick(); ui.render();
  const input = () => ui.find((e) => e.type === 'input' && e.props.type === 'number');
  for (const draft of ['', '1', '12']) { input().props.onChange({ target: { value: draft } }); ui.render(); }
  assert.deepEqual(calls, []);
  input().props.onKeyDown({ key: 'Enter', currentTarget: { blur: () => input().props.onBlur() } }); await tick(); ui.render();
  assert.deepEqual(calls, [{ asr: { threads: 10 } }]);
  input().props.onBlur(); await tick(); ui.render();
  assert.equal(calls.length, 1);
  input().props.onChange({ target: { value: '' } }); ui.render(); input().props.onBlur(); ui.render();
  assert.equal(input().props.value, '10'); assert.equal(calls.length, 1);
});
