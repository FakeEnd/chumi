import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isModelMirror, MODEL_BASE_URL, MODEL_MIRROR_URL } from '../shared/model-source.ts';

for (const [baseUrl, fromEnvironment, canSwitch] of [[MODEL_BASE_URL, false, true], [MODEL_MIRROR_URL, false, false], [MODEL_BASE_URL, true, false]] as const) test('Home shows download errors and offers retry and mirror recovery', () => {
  const source = readFileSync(new URL('../web/src/components/SetupChecklist.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const steps: Step[] = '), end = source.indexOf('\n  const left', start);
  const steps = source.slice(start, end).replace('const steps: Step[]', 'const steps');
  const requests: string[] = [];
  const speech = new Function('settings', 'asr', 'download', 't', 'api', 'source', 'isModelMirror', `const localSpeech = true, provider = null, described = false, helper = true, mic = null, windows = false; ${steps}; return steps[0];`)(
    { asr: { engine: 'whisper' }, ai: { provider: 'codex' } }, { state: 'missing_model' }, { status: 'error', error: 'HTTP 503' },
    (text: string, vars: Record<string, string> = {}) => text.replace(/\{(\w+)\}/g, (_, key) => vars[key]), (path: string) => requests.push(path), { baseUrl, fromEnvironment }, isModelMirror,
  );
  assert.equal(speech.detail, 'Download failed: HTTP 503');
  assert.equal(speech.action.label, 'Retry');
  assert.equal(speech.retryMirror, canSwitch);
  speech.action.run();
  assert.deepEqual(requests, ['/api/asr/setup']);
});
