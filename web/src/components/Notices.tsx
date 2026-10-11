import { api } from '../api.ts';
import { dismiss, useStore } from '../store.ts';
import { t } from '../i18n.ts';

const PERMISSION_HELP: Record<string, string> = {
  mic_permission_denied: 'microphone',
  system_silent: 'audio-capture',
  system_tap_failed: 'audio-capture',
  system_permission_pending: 'audio-capture',
  mic_start_pending: 'microphone',
};

export function Notices() {
  const notices = useStore((s) => s.notices);
  const connected = useStore((s) => s.connected);
  return (
    <div className="notices" role="status" aria-live="polite">
      {!connected && <div className="notice error">{t('Lost connection to the Chumi server. Reconnecting… Recording and transcription continue on the server side.')}</div>}
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.level}`}>
          <span>{t(n.message)}</span>
          {PERMISSION_HELP[n.code] && <button className="btn small" onClick={() => void api('/api/audio/open-settings', { body: { pane: PERMISSION_HELP[n.code] } })}>{t('Open System Settings')}</button>}
          <button className="link-btn" onClick={() => dismiss(n.id)} aria-label={t('Dismiss')}>✕</button>
        </div>
      ))}
    </div>
  );
}
