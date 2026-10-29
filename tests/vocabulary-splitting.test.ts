import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../server/settings.ts';
import { transcriptionHarness } from './helpers/transcription-ui.ts';
import { tick } from './helpers/web-ui.ts';

test('vocabulary hints accept Chinese enumeration commas and both semicolons', async () => {
  const saved: unknown[] = [];
  const ui = await transcriptionHarness({ settings: structuredClone(DEFAULT_SETTINGS), live: null }, {
    saveSettings: async (patch: unknown) => { saved.push(patch); return true; },
  });
  const field = () => ui.find((e) => e.type === 'textarea');
  for (const text of ['贝叶斯优化、高斯过程；林教授; CRISPR, MPRA，张三\n李四', ' 、；; \nGaussian process,  Bayesian optimization ']) {
    field().props.onChange({ target: { value: text } }); ui.render(); field().props.onBlur(); await tick(); ui.render();
  }
  assert.deepEqual(saved, [
    { asr: { glossary: ['贝叶斯优化', '高斯过程', '林教授', 'CRISPR', 'MPRA', '张三', '李四'] } },
    { asr: { glossary: ['Gaussian process', 'Bayesian optimization'] } },
  ]);
  ui.unmount();
});
