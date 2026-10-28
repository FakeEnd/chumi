import { t } from './i18n.ts';
import type { LiveState, Settings } from './types.ts';

/** A starting or draining session still owns its speech recognizer. */
export const speechSettingsBusy = (live: Pick<LiveState, 'status'> | null | undefined): boolean => !!live && live.status !== 'idle';

/** Describe transcription separately from optional audio storage and AI assistance. */
export function speechPrivacy(asr: Settings['asr'] | undefined): string {
  if (!asr) return t('The selected speech recognition engine determines where audio is transcribed. Check Transcription in Settings.');
  switch (asr.engine) {
    case 'qwen3': return t('Qwen3-ASR transcribes audio on this computer, with Whisper as a backup. Audio is not uploaded for transcription.');
    case 'whisper': return t('Whisper transcribes audio on this computer. Audio is not uploaded for transcription.');
    case 'elevenlabs': return t('Meeting audio is sent to ElevenLabs for transcription.');
    case 'qwen-cloud': return t('Meeting audio is sent to Alibaba Cloud for transcription at {address}.', { address: asr.qwenCloud.baseUrl });
    case 'qwen-local': return t('Meeting audio is sent to your Qwen3-ASR server at {address} for transcription. Check that server’s routing settings to know whether it forwards audio elsewhere.', { address: asr.qwenLocal.baseUrl });
  }
}
