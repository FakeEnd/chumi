import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_SETTINGS } from '../server/settings.ts';
import { MODEL_BASE_URL, MODEL_MIRROR_URL, modelSourceName, normalizeModelBaseUrl } from '../shared/model-source.ts';

const source = readFileSync(new URL('../web/src/components/TranscriptionTab.tsx', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const { code } = await transformWithOxc(source, 'transcription.tsx', { jsx: { runtime: 'classic' } });
function elements(node: React.ReactNode): React.ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const el = node as React.ReactElement<any>;
  return [el, ...elements(el.props.children)];
}

test('Transcription names the effective source, lets a saved mirror be replaced, and discards partial downloads', async () => {
  for (const [baseUrl, fromEnvironment] of [[MODEL_MIRROR_URL, false], ['https://models.example.test/whisper', true]] as const) {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.asr.modelBaseUrl = fromEnvironment ? MODEL_BASE_URL : baseUrl;
    const list = { source: { baseUrl, fromEnvironment }, models: [{ id: 'model.bin', name: 'Test model', sizeMB: 10, speed: 1, accuracy: 1, minRamGB: 1, note: { en: 'test', zh: '测试' }, installed: false, active: false, partial: true }], download: null };
    const calls: unknown[] = [], prompts: string[] = [];
    let stateIndex = 0;
    const deps = {
      React, MODEL_BASE_URL, MODEL_MIRROR_URL, modelSourceName,
      useStore: (select: (s: unknown) => unknown) => select({ settings, live: null, asrDownload: null }),
      useState: (initial: unknown) => [stateIndex++ === 0 ? list : initial, () => {}], useEffect: () => {},
      saveSettings: async (patch: unknown) => { calls.push(patch); return true; },
      api: async (path: string, options: unknown) => { calls.push({ path, options }); return list; },
      confirm: (prompt: string) => { prompts.push(prompt); return true; },
      t: (text: string, vars: Record<string, string> = {}) => text.replace(/\{(\w+)\}/g, (_, key) => vars[key]), tn: (s: string) => s, getLang: () => 'en',
      SpeakerSettings: () => null, SpeechEngineSettings: () => null, speechSettingsBusy: () => false,
    };
    const Component = new Function('deps', `const { ${Object.keys(deps).join(', ')} } = deps; ${code}; return TranscriptionTab;`)(deps);
    const tree = Component() as React.ReactElement;
    const nodes = elements(tree);
    const select = nodes.find((node) => node.type === 'select' && node.props.value === baseUrl)!;
    assert.ok(select);
    assert.equal(select.props.disabled, fromEnvironment);
    if (!fromEnvironment) {
      select.props.onChange({ target: { value: MODEL_BASE_URL } });
      assert.deepEqual(calls.shift(), { asr: { modelBaseUrl: MODEL_BASE_URL } });
    } else assert.match(renderToStaticMarkup(tree), /Set by CHUMI_MODEL_BASE_URL/);
    const download = nodes.find((node) => node.type === 'button' && Array.isArray(node.props.children) && node.props.children[0] === 'Download')!;
    download.props.onClick();
    assert.ok(prompts[0].includes(`from ${modelSourceName(baseUrl)}?`), prompts[0]);
    const discard = nodes.find((node) => node.type === 'button' && node.props.children === 'Discard partial download')!;
    discard.props.onClick();
    assert.ok(calls.some((call) => JSON.stringify(call) === JSON.stringify({ path: '/api/asr/models/model.bin', options: { method: 'DELETE' } })));
  }
});

test('model sources accept HTTP mirrors and reject malformed URLs and embedded credentials', () => {
  assert.equal(normalizeModelBaseUrl(`${MODEL_MIRROR_URL}/`), MODEL_MIRROR_URL);
  for (const value of ['not a URL', 'file:///tmp/models', 'https://user:secret@example.test/models', 'https://example.test/?key=secret', null]) assert.throws(() => normalizeModelBaseUrl(value), /HTTP\(S\)/);
});
