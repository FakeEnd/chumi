import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the textarea's actual save expression without mounting the settings dialog.
const source = readFileSync(new URL('../web/src/components/TranscriptionTab.tsx', import.meta.url), 'utf8');
const expression = source.match(/glossary: (glossary\.split\(.+?\.filter\(Boolean\))/)![1];
const split = new Function('glossary', `return ${expression}`) as (text: string) => string[];

test('vocabulary hints accept Chinese enumeration commas and both semicolons', () => {
  assert.deepEqual(split('贝叶斯优化、高斯过程；林教授; CRISPR, MPRA，张三\n李四'), ['贝叶斯优化', '高斯过程', '林教授', 'CRISPR', 'MPRA', '张三', '李四']);
  assert.deepEqual(split(' 、；; \nGaussian process,  Bayesian optimization '), ['Gaussian process', 'Bayesian optimization']);
});
