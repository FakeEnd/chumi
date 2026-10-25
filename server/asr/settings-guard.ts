import type { Settings } from '../settings.ts';

type SpeechSettings = Settings['asr'];

/** Only the selected service's address/model affects currently queued audio. */
export function speechEngineChanged(before: SpeechSettings, after: SpeechSettings): boolean {
  if (before.engine !== after.engine) return true;
  const config = (s: SpeechSettings) => s.engine === 'qwen-cloud' ? s.qwenCloud : s.engine === 'qwen-local' ? s.qwenLocal : null;
  const a = config(before), b = config(after);
  return a?.baseUrl !== b?.baseUrl || a?.model !== b?.model;
}

/** These changes stop/restart a service or change where the remaining audio is sent. */
export function speechRestartRequired(before: SpeechSettings, after: SpeechSettings): boolean {
  return before.model !== after.model || before.threads !== after.threads || speechEngineChanged(before, after);
}
