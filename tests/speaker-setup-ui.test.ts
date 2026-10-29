import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(new URL('../web/src/components/Speakers.tsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('function RuntimeSetup('), source.indexOf('export function SpeakerSettings'));
const { code: compiled } = await transformWithOxc(component, 'speakers.tsx', { jsx: { runtime: 'classic' } });

test('installed Windows shows the limitation without offering a developer setup command', () => {
  for (const [platform, appMode, ready] of [['win32', true, false], ['darwin', true, false], ['win32', false, false], ['win32', true, true]] as const) {
    const state = { platform, appMode };
    const RuntimeSetup = new Function('React', 'useStore', 't', 'tn', `${compiled}; return RuntimeSetup;`)(React,
      (select: (s: typeof state) => unknown) => select(state), (s: string) => s, (s: string) => s);
    const html = renderToStaticMarkup(React.createElement(RuntimeSetup, { runtime: { ready, reason: 'Missing runtime', setupCommand: 'npm run setup:speakers' } }));
    if (platform === 'win32' && appMode && !ready) {
      assert.match(html, /not available in the Windows app yet/);
      assert.doesNotMatch(html, /Chumi folder|Missing runtime/);
    } else if (ready) assert.match(html, /model is ready/);
    else assert.match(html, /Chumi folder/);
  }
});
