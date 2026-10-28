import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideLanguage, isSpoken, languagePrior, type LanguageDecision, type Spoken } from '../server/asr/language.ts';

const priors = [
  { name: 'Chinese UI', ui: 'zh', system: 'en-US', explanation: 'English', expected: 'zh' },
  { name: 'automatic UI with a Chinese system', ui: 'auto', system: 'zh-Hans-CN', explanation: 'English', expected: 'zh' },
  { name: 'English UI overrides the Chinese system', ui: 'en', system: 'zh-Hans-CN', explanation: 'English', expected: 'en' },
  { name: 'Chinese explanation language', ui: 'en', system: 'en-US', explanation: 'Simplified Chinese', expected: 'zh' },
  { name: 'English defaults', ui: 'auto', system: 'en-US', explanation: 'English', expected: 'en' },
  { name: 'other system and explanation languages', ui: 'auto', system: 'ja-JP', explanation: 'Japanese', expected: 'en' },
];

for (const { name, expected, ...input } of priors) {
  test(`languagePrior: ${name}`, () => {
    assert.equal(languagePrior(input), expected);
  });
}

test('isSpoken accepts only zh and en', () => {
  assert.equal(isSpoken('zh'), true);
  assert.equal(isSpoken('en'), true);
  for (const lang of [null, '', 'ko', 'ja', 'es', 'ru', 'chinese', 'english', 'ZH']) {
    assert.equal(isSpoken(lang), false, `language: ${lang}`);
  }
});

interface DecisionCase {
  name: string;
  lang: string | null;
  text: string;
  probs?: Record<string, number>;
  recent?: Spoken | null;
  prior?: Spoken;
  expected: LanguageDecision;
}

const decisions: DecisionCase[] = [
  { name: 'keeps Mandarin despite conflicting probabilities', lang: 'zh', text: '这是中文。', probs: { en: 1 }, expected: { action: 'keep' } },
  { name: 'keeps English despite conflicting probabilities', lang: 'en', text: 'This is English.', probs: { zh: 1 }, expected: { action: 'keep' } },
  { name: 'keeps empty text', lang: 'ko', text: '', expected: { action: 'keep' } },
  { name: 'keeps whitespace with no detected language', lang: null, text: ' \n\t ', expected: { action: 'keep' } },
  { name: 'relabels Chinese marked as Korean', lang: 'ko', text: '但是未来肯定是肯定的', expected: { action: 'relabel', lang: 'zh' } },
  { name: 'retries Japanese containing Han and kana', lang: 'ja', text: '未来の計画について話します', expected: { action: 'retry', lang: 'en' } },
  {
    name: 'English probability wins over recent Mandarin and its prior', lang: 'es', text: '¿Dios, qué no pasa?',
    probs: { es: 0.6, en: 0.2, zh: 0.1 }, recent: 'zh', prior: 'zh', expected: { action: 'retry', lang: 'en' },
  },
  {
    name: 'Mandarin probability wins over recent English and its prior', lang: 'es', text: '¿Dios, qué no pasa?',
    probs: { es: 0.6, en: 0.1, zh: 0.2 }, recent: 'en', prior: 'en', expected: { action: 'retry', lang: 'zh' },
  },
  {
    name: 'close probabilities use recent Mandarin over English prior', lang: 'es', text: '¿Dios, qué no pasa?',
    probs: { zh: 0.3, en: 0.34 }, recent: 'zh', prior: 'en', expected: { action: 'retry', lang: 'zh' },
  },
  {
    name: 'close probabilities use recent English over Mandarin prior', lang: 'es', text: '¿Dios, qué no pasa?',
    probs: { zh: 0.34, en: 0.3 }, recent: 'en', prior: 'zh', expected: { action: 'retry', lang: 'en' },
  },
  {
    name: 'close probabilities without history use Mandarin prior', lang: 'es', text: '¿Dios, qué no pasa?',
    probs: { zh: 0.3, en: 0.34 }, prior: 'zh', expected: { action: 'retry', lang: 'zh' },
  },
  {
    name: 'close probabilities without history use English prior', lang: 'es', text: '¿Dios, qué no pasa?',
    probs: { zh: 0.34, en: 0.3 }, prior: 'en', expected: { action: 'retry', lang: 'en' },
  },
  {
    name: 'missing probabilities use recent language', lang: 'es', text: '¿Dios, qué no pasa?',
    recent: 'en', prior: 'zh', expected: { action: 'retry', lang: 'en' },
  },
  { name: 'retries Cyrillic text', lang: 'ru', text: 'Привет, мир.', prior: 'zh', expected: { action: 'retry', lang: 'zh' } },
];

for (const { name, lang, text, probs = {}, recent = null, prior = 'en', expected } of decisions) {
  test(`decideLanguage: ${name}`, () => {
    assert.deepEqual(decideLanguage({ lang, text, probs }, recent, prior), expected);
  });
}

test('the label follows the written text between Mandarin and English', () => {
  assert.deepEqual(decideLanguage({ lang: 'en', probs: {}, text: '我们接下来讨论实验结果' }, null, 'en'), { action: 'relabel', lang: 'zh' });
  assert.deepEqual(decideLanguage({ lang: 'en', probs: {}, text: 'We use CRISPR 筛选' }, null, 'zh'), { action: 'keep' });
  assert.deepEqual(decideLanguage({ lang: 'zh', probs: {}, text: 'Sounds good to me.' }, null, 'zh'), { action: 'relabel', lang: 'en' });
  assert.deepEqual(decideLanguage({ lang: 'zh', probs: {}, text: '用 CRISPR 做筛选' }, null, 'en'), { action: 'keep' });
});
