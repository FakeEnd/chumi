import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isModelMirror, MODEL_BASE_URL, MODEL_MIRROR_URL } from '../shared/model-source.ts';
import { DEFAULT_SETTINGS } from '../server/settings.ts';
import { providerSetupCommand } from '../web/src/providerSetup.ts';
import { t } from '../web/src/i18n.ts';
import { componentHarness, tick, words } from './helpers/web-ui.ts';

for (const [baseUrl, fromEnvironment, canSwitch] of [[MODEL_BASE_URL, false, true], [MODEL_MIRROR_URL, false, false], [MODEL_BASE_URL, true, false]] as const) test('Home shows download errors and offers retry and mirror recovery', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.asr.engine = 'whisper'; settings.asr.modelBaseUrl = baseUrl;
  const state = { settings, live: { asr: { state: 'missing_model' } }, asrDownload: { status: 'error', error: 'HTTP 503' } };
  const requests: unknown[] = [];
  const ui = await componentHarness('SetupChecklist.tsx', 'SetupChecklist', {}, {
    useStore: (select: (s: unknown) => unknown) => select(state),
    api: async (path: string) => {
      if (path === '/api/asr/models') return { source: { baseUrl, fromEnvironment } };
      if (path === '/api/audio/permissions') return { microphone: 'granted' };
      requests.push(path);
    },
    saveSettings: async (patch: unknown) => { requests.push(patch); return true; },
    window: { addEventListener() {}, removeEventListener() {} },
    t, providerSetupCommand, isModelMirror, MODEL_MIRROR_URL,
  });
  await tick(); ui.render();
  const speech = ui.find((e) => e.type === 'li' && words(e).includes('Speech recognition on this computer'));
  assert.match(words(speech), /Download failed: HTTP 503/);
  ui.button('Retry').props.onClick();
  assert.deepEqual(requests, ['/api/asr/setup']);
  const mirror = ui.elements().find((e) => e.type === 'button' && words(e) === 'Use the hf-mirror.com copy');
  assert.equal(!!mirror, canSwitch);
  if (mirror) {
    requests.length = 0; mirror.props.onClick(); await tick();
    assert.deepEqual(requests, [{ asr: { modelBaseUrl: MODEL_MIRROR_URL } }, '/api/asr/setup']);
  }
  ui.unmount();
});
