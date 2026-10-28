import { join } from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { Transcriber } from '../server/asr/transcriber.ts';
import assert from 'node:assert/strict';
import { defaultLocalEngine, localEngineOrder } from '../server/asr/engines.ts';
import { Store } from '../server/db.ts';
import { DEFAULT_SETTINGS } from '../server/settings.ts';
import { qwenHotwords, qwenLanguage, senseVoiceLanguage, sherpaConfig } from '../server/asr/sherpa-config.ts';

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
    store.saveSettings({ ...store.getSettings(), asr: { ...store.getSettings().asr, engine: 'sensevoice' } });
    assert.equal(store.getSettings().asr.engine, 'sensevoice');
    store.saveSettings(store.getSettings());
    assert.equal(store.getSettings().asr.engine, 'sensevoice');
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


test('SenseVoice language tags preserve the detected language for the existing policy', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko', 'yue', 'nospeech']) {
    assert.equal(senseVoiceLanguage(`<|${lang}|>`), lang);
    assert.equal(senseVoiceLanguage(lang), lang);
  }
  assert.equal(senseVoiceLanguage(''), null);
  assert.equal(senseVoiceLanguage(undefined), null);
});

test('shared sherpa configuration enables SenseVoice ITN with the requested language', () => {
  for (const language of ['auto', 'zh', 'en']) {
    const cfg = sherpaConfig('sensevoice', '/models/sensevoice', 4, language);
    assert.equal(cfg.featConfig.featureDim, 80);
    assert.ok('senseVoice' in cfg.modelConfig);
    assert.equal(cfg.modelConfig.senseVoice?.language, language);
    assert.equal(cfg.modelConfig.senseVoice?.useInverseTextNormalization, 1);
    assert.equal(cfg.modelConfig.tokens, join('/models/sensevoice', 'tokens.txt'));
    assert.equal(cfg.modelConfig.senseVoice?.model, join('/models/sensevoice', 'model.int8.onnx'));
    assert.equal(cfg.modelConfig.numThreads, 4);
    assert.equal('qwen3Asr' in cfg.modelConfig, false);
  }
  assert.equal(sherpaConfig('qwen3', '/models/qwen3', 4).featConfig.featureDim, 128);
});

test('the local default and fallback order stay centralized', () => {
  assert.equal(defaultLocalEngine(), 'qwen3');
  assert.equal(DEFAULT_SETTINGS.asr.engine, defaultLocalEngine());
  assert.deepEqual(localEngineOrder('qwen3'), ['qwen3', 'sensevoice', 'whisper']);
  assert.deepEqual(localEngineOrder('sensevoice'), ['sensevoice', 'qwen3', 'whisper']);
  assert.deepEqual(localEngineOrder('qwen-cloud'), ['qwen3', 'sensevoice', 'whisper']);
  assert.deepEqual(localEngineOrder('whisper'), ['whisper']);
});
