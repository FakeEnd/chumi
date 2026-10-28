import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Transcriber, type FinalPiece, type TranscriberConfig } from '../server/asr/transcriber.ts';
import type { SpeechService } from '../server/asr/speech.ts';
import type { WhisperResult } from '../server/asr/whisper.ts';
import type { Utterance } from '../server/audio/vad.ts';

type SpeechOptions = Parameters<SpeechService['transcribe']>[1];

const utterance = (id: number, final = true): Utterance => ({
  id, startSec: id, endSec: id + 1, samples: new Int16Array(16_000), final,
});
const result = (text: string, language: string, langProbs: Record<string, number> = {}): WhisperResult => ({
  text, language, langProbs, segments: [{ start: 0, end: 1, text }], ms: 1,
});
const spanish = () => result('¿Dios, qué no pasa?', 'spanish');

function fixture(t: TestContext, reply: (call: number, options: SpeechOptions) => WhisperResult, config: Partial<TranscriberConfig> = {}) {
  const calls: Array<{ samples: Int16Array; options: SpeechOptions }> = [];
  const speech: Pick<SpeechService, 'transcribe' | 'partials'> = {
    partials: true,
    async transcribe(samples, options) {
      calls.push({ samples, options });
      return reply(calls.length, options);
    },
  };
  const transcriber = new Transcriber(speech, () => ({
    language: 'auto', glossary: [], chineseScript: 'simplified', prior: 'en', ...config,
  }));
  transcriber.reset('meeting');
  const finals: FinalPiece[][] = [], partials: string[] = [], errors: string[] = [];
  transcriber.on('final', (pieces) => { finals.push(pieces); });
  transcriber.on('partial', (_source, _id, _start, text) => { partials.push(text); });
  transcriber.on('error', (error) => { errors.push(error); });
  t.after(() => {
    transcriber.stop();
    assert.deepEqual(errors, []);
  });
  return { transcriber, calls, finals, partials };
}

test('automatic final relabels Chinese detected as Korean without another request', { timeout: 5000 }, async (t) => {
  const text = '但是未来肯定是肯定的';
  const { transcriber, calls, finals, partials } = fixture(t, () => result(text, 'korean'));
  transcriber.pushFinal('mic', utterance(1));
  assert.equal(await transcriber.drain(), true);
  assert.deepEqual(calls.map((c) => c.options.language), ['auto']);
  assert.deepEqual(finals, [[{ session: 'meeting', source: 'mic', uttId: 1, startSec: 1, endSec: 2, text, lang: 'zh' }]]);
  assert.deepEqual(partials, []);
});

for (const lang of ['en', 'zh'] as const) {
  test(`automatic final retries Spanish exactly once in ${lang} and uses the new text`, { timeout: 5000 }, async (t) => {
    const text = lang === 'zh' ? '我们接下来讨论实验结果。' : 'We will discuss the experimental results next.';
    const { transcriber, calls, finals } = fixture(t, (call) => call === 1
      ? result('¿Dios, qué no pasa?', 'spanish', { es: 0.6, en: lang === 'en' ? 0.2 : 0.1, zh: lang === 'zh' ? 0.2 : 0.1 })
      : result(text, 'spanish'), { prior: lang === 'en' ? 'zh' : 'en' });
    const utt = utterance(1);
    transcriber.pushFinal('mic', utt);
    assert.equal(await transcriber.drain(), true);
    assert.deepEqual(calls.map((c) => c.options.language), ['auto', lang]);
    assert.equal(calls[0].samples, utt.samples);
    assert.equal(calls[1].samples, utt.samples);
    assert.deepEqual(finals, [[{ session: 'meeting', source: 'mic', uttId: 1, startSec: 1, endSec: 2, text, lang }]]);
  });
}

test('automatic Spanish preview emits no transcript and makes no retry request', { timeout: 5000 }, async (t) => {
  const { transcriber, calls, finals, partials } = fixture(t, spanish);
  const cleared: number[] = [];
  transcriber.on('partialClear', (_source, id) => { cleared.push(id); });
  const idle = once(transcriber, 'idle');
  transcriber.pushProgress('mic', utterance(1, false));
  await idle;
  assert.deepEqual(calls.map((c) => c.options.language), ['auto']);
  assert.deepEqual(partials, []);
  assert.deepEqual(finals, []);
  assert.deepEqual(cleared, []);
});

test('forced Mandarin never retries, and labels the result Mandarin whatever the engine detected', { timeout: 5000 }, async (t) => {
  const text = '但是未来肯定是肯定的';
  const { transcriber, calls, finals } = fixture(t, () => result(text, 'korean'), { language: 'zh' });
  transcriber.pushFinal('mic', utterance(1));
  assert.equal(await transcriber.drain(), true);
  assert.deepEqual(calls.map((c) => c.options.language), ['zh']);
  assert.deepEqual(finals, [[{ session: 'meeting', source: 'mic', uttId: 1, startSec: 1, endSec: 2, text, lang: 'zh' }]]);
});

for (const prior of ['zh', 'en'] as const) {
  test(`first automatic prompt uses the ${prior} prior for its glossary sentence`, { timeout: 5000 }, async (t) => {
    const glossary = ['CRISPR', 'MPRA'];
    const { transcriber, calls } = fixture(t, () => result('The experiment begins today.', 'english'), { prior, glossary });
    transcriber.pushFinal('mic', utterance(1));
    assert.equal(await transcriber.drain(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.prompt, prior === 'zh' ? '我们讨论了CRISPR、MPRA。' : 'We talked about CRISPR and MPRA.');
    assert.deepEqual(calls[0].options.glossary, glossary);
  });
}

test('automatic retries use each audio source’s own recent language', { timeout: 5000 }, async (t) => {
  const en = 'The next experiment will start tomorrow.', zh = '下一个实验将在明天开始。';
  const { transcriber, calls, finals } = fixture(t, (call, options) => {
    if (call === 1) return result(en, 'english');
    if (call === 2) return result(zh, 'chinese');
    if (options.language === 'auto') return spanish();
    return result(options.language === 'zh' ? zh : en, options.language);
  }, { prior: 'zh' });
  for (const source of ['mic', 'system'] as const) {
    transcriber.pushFinal(source, utterance(1));
    assert.equal(await transcriber.drain(), true);
  }
  for (const source of ['mic', 'system'] as const) {
    transcriber.pushFinal(source, utterance(2));
    assert.equal(await transcriber.drain(), true);
  }
  assert.deepEqual(calls.map((c) => c.options.language), ['auto', 'auto', 'auto', 'en', 'auto', 'zh']);
  assert.deepEqual(finals.map((pieces) => pieces.map(({ source, lang, text }) => ({ source, lang, text }))), [
    [{ source: 'mic', lang: 'en', text: en }],
    [{ source: 'system', lang: 'zh', text: zh }],
    [{ source: 'mic', lang: 'en', text: en }],
    [{ source: 'system', lang: 'zh', text: zh }],
  ]);
});

test('reset clears recent language so the next session retries using its prior', { timeout: 5000 }, async (t) => {
  const text = '新会话使用中文。';
  const { transcriber, calls, finals } = fixture(t, (call, options) => {
    if (call === 1) return result('The first meeting is in English.', 'english');
    return options.language === 'auto' ? spanish() : result(text, 'chinese');
  }, { prior: 'zh' });
  transcriber.pushFinal('mic', utterance(1));
  assert.equal(await transcriber.drain(), true);
  transcriber.reset('next-meeting');
  transcriber.pushFinal('mic', utterance(1));
  assert.equal(await transcriber.drain(), true);
  assert.deepEqual(calls.map((c) => c.options.language), ['auto', 'auto', 'zh']);
  assert.deepEqual(finals.map((pieces) => pieces.map(({ session, lang, text }) => ({ session, lang, text }))), [
    [{ session: 'meeting', lang: 'en', text: 'The first meeting is in English.' }],
    [{ session: 'next-meeting', lang: 'zh', text }],
  ]);
});
