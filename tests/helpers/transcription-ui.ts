import { maxAsrThreads, threadDraftValue } from '../../shared/asr-threads.ts';
import { MODEL_BASE_URL, MODEL_MIRROR_URL, modelSourceName } from '../../shared/model-source.ts';
import { getLang, t, tn } from '../../web/src/i18n.ts';
import { speechSettingsBusy } from '../../web/src/speechSettings.ts';
import { componentHarness } from './web-ui.ts';

// Supply imported helpers while letting the component own its hook order and model-list state.
export function transcriptionHarness(state: Record<string, any>, adapters: Record<string, any> = {}) {
  return componentHarness('TranscriptionTab.tsx', 'TranscriptionTab', {}, {
    maxAsrThreads, threadDraftValue, MODEL_BASE_URL, MODEL_MIRROR_URL, modelSourceName,
    getLang, t, tn, speechSettingsBusy, SpeakerSettings: 'speakers', SpeechEngineSettings: 'engine',
    useStore: (select: (s: any) => unknown) => select(state),
    api: async () => ({ source: { baseUrl: MODEL_BASE_URL, fromEnvironment: false }, models: [], download: null }),
    ...adapters,
  });
}
