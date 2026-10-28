import { test } from 'node:test';
import { once } from 'node:events';
import { Transcriber } from '../server/asr/transcriber.ts';
import assert from 'node:assert/strict';
import { Store } from '../server/db.ts';
import { DEFAULT_SETTINGS } from '../server/settings.ts';
import { qwenHotwords, qwenLanguage } from '../server/asr/qwen3.ts';

test('Qwen3 language labels compare Han characters with English words', () => {
  assert.equal(qwenLanguage('我们用 ATAC-seq 分析染色质。'), 'zh');
  assert.equal(qwenLanguage('We trained a model.'), 'en');
  assert.equal(qwenLanguage('中 English'), 'en');
  assert.equal(qwenLanguage('中文 English'), 'zh');
  assert.equal(qwenLanguage(''), 'en');
});

test('Qwen3 hotwords use ASCII comma separated phrases, including meeting terms', () => {
  assert.equal(qwenHotwords(['ATAC-seq', ' transcription factor ', '会议术语', 'ATAC-seq', '甲，乙\n丙']),
    'ATAC-seq,transcription factor,会议术语,甲,乙,丙');
});

test('fresh and unchanged legacy installs follow the Qwen3 default; explicit choices persist', () => {
  const store = new Store(':memory:');
  try {
    assert.equal(DEFAULT_SETTINGS.asr.engine, 'qwen3');
    assert.equal(store.getSettings().asr.engine, 'qwen3');
    store.setKV('settings', { asr: { engine: 'whisper' } });
    assert.equal(store.getSettings().asr.engine, 'qwen3');
    store.setKV('settings', { asr: { engine: 'elevenlabs' } });
    assert.equal(store.getSettings().asr.engine, 'elevenlabs');
    const settings = store.getSettings();
    settings.asr.engine = 'whisper';
    store.saveSettings(settings);
    assert.equal(store.getSettings().asr.engine, 'whisper');
    store.saveSettings(store.getSettings());
    assert.equal(store.getSettings().asr.engine, 'whisper');
  } finally { store.close(); }
});


test('Qwen3 preview cooldown skips repeated previews while finals still run immediately', async () => {
  const calls: number[] = [];
  const speech = {
    partials: true, partialIntervalMs: 5000,
    transcribe: async (_samples: Int16Array, options: { timeoutMs?: number }) => {
      calls.push(options.timeoutMs!);
      return { text: 'A real sentence.', language: 'en', langProbs: {}, segments: [], ms: 1 };
    },
  };
  const t = new Transcriber(speech, () => ({ language: 'auto', glossary: [], chineseScript: 'simplified' }));
  const utterance = { id: 1, samples: new Int16Array(32000), startSec: 0, endSec: 2, final: false };
  let idle = once(t, 'idle');
  t.pushProgress('file', utterance);
  await idle;
  idle = once(t, 'idle');
  t.pushProgress('file', { ...utterance, id: 2 });
  await idle;
  t.pushFinal('file', { ...utterance, id: 2, final: true });
  assert.equal(await t.drain(), true);
  assert.deepEqual(calls, [20000, 90000]);
  t.stop();
});
