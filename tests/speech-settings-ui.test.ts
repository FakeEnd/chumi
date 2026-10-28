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
