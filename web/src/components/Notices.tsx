import { useEffect, useState } from 'react';
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
  const health = useStore((s) => s.live?.status === 'recording' ? s.live.captureHealth : undefined);
  const sourceMode = useStore((s) => s.live?.source);
  const asr = useStore((s) => s.live?.asr);
  const connected = useStore((s) => s.connected);
  const loaded = useStore((s) => s.loaded);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    if (connected) return;
    const timer = setTimeout(() => setWaited(true), 10000);
    return () => clearTimeout(timer);
  }, [connected]);
  return (
    <div className="notices" role="status" aria-live="polite">
      {!connected && (loaded || waited) && <div className="notice error"><span>{waited ? t("Chumi's server isn't responding. Recording may have stopped.") : t('Reconnecting to Chumi… Recording status is unknown.')}</span>{waited && <button className="btn small" onClick={() => location.reload()}>{t('Reload')}</button>}</div>}
      {Object.entries(health ?? {}).filter(([source, h]) => h.state === 'silent' && !(source === 'system' && sourceMode === 'both')).map(([source, h]) => <div key={source} className="notice warning"><span>{t(h.message ?? '', h.vars)}</span>{h.code && PERMISSION_HELP[h.code] && <button className="btn small" onClick={() => void api('/api/audio/open-settings', { body: { pane: PERMISSION_HELP[h.code!] } })}>{t('Open System Settings')}</button>}</div>)}
      {asr?.retrying && <div className="notice warning">{t('Speech recognition is unavailable. Retrying; {seconds} s of audio waiting.', { seconds: Math.round(asr.backlogSec) })}</div>}
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.level}`}>
          <span>{t(n.message, n.vars)}</span>
          {PERMISSION_HELP[n.code] && <button className="btn small" onClick={() => void api('/api/audio/open-settings', { body: { pane: PERMISSION_HELP[n.code] } })}>{t('Open System Settings')}</button>}
          <button className="link-btn" onClick={() => dismiss(n.id)} aria-label={t('Dismiss')}>✕</button>
        </div>
      ))}
    </div>
  );
}
