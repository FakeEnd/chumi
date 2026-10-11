import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { WindowInfo } from '../types.ts';
import { t, tn } from '../i18n.ts';

/** Lists capturable windows (Zoom, browser with a lecture video, slides…) and handles the Screen Recording permission. */
export function WindowPicker({ value, onChange }: { value: WindowInfo | null; onChange: (w: WindowInfo | null) => void }) {
  const [state, setS] = useState<{ loading: boolean; permission?: string; windows: WindowInfo[]; error?: string; message?: string; toolBuilt?: boolean }>({ loading: true, windows: [] });
  const load = () => {
    setS((s) => ({ ...s, loading: true }));
    void api('/api/screen/windows').then((r) => setS({ loading: false, ...r })).catch((e) => setS({ loading: false, windows: [], error: 'failed', message: (e as Error).message }));
  };
  useEffect(load, []);
  if (state.loading) return <p className="muted small">{t('Looking for windows…')}</p>;
  if (state.toolBuilt === false) return <p className="error-text small">{tn("The window-capture tool isn't built. Run {cmd}.", { cmd: <code>bash native/build.sh screen</code> })}</p>;
  if (state.error === 'permission' || state.permission === 'not_granted') {
    return (
      <div className="warn-box small">
        <p style={{ margin: '0 0 6px' }}>{tn('Window capture needs {perm} permission. Allow it for Chumi (or the terminal app running {cmd}), then reopen this list. macOS may ask you to restart Chumi.', { perm: <b>{t('Screen Recording')}</b>, cmd: <code>npm start</code> })}</p>
        <div className="btn-row">
          <button className="btn small" onClick={() => void api('/api/screen/request', { body: {} }).then(load)}>{t('Ask macOS for permission')}</button>
          <button className="btn small" onClick={() => void api('/api/audio/open-settings', { body: { pane: 'screen' } })}>{t('Open Screen Recording settings')}</button>
          <button className="btn small" onClick={load}>{t('Check again')}</button>
        </div>
      </div>
    );
  }
  if (state.error) return <p className="error-text small">{state.message ?? state.error} <button className="link-btn" onClick={load}>{t('Retry')}</button></p>;
  return (
    <div className="window-picker">
      <div className="field-row" style={{ marginBottom: 4 }}>
        <select className="grow" value={value?.id ?? ''} onChange={(e) => onChange(state.windows.find((w) => w.id === Number(e.target.value)) ?? null)}>
          <option value="">{t('Choose a window…')}</option>
          {state.windows.map((w) => <option key={w.id} value={w.id}>{w.app}{w.title ? ` · ${w.title.slice(0, 70)}` : ''}{w.onScreen ? '' : ` ${t('(hidden)')}`}</option>)}
        </select>
        <button className="btn small" onClick={load} title={t('Refresh the window list')}>↻</button>
      </div>
      {!state.windows.length && <p className="muted small">{t('No windows found. Open Zoom, Teams or the browser tab with the video, then refresh.')}</p>}
    </div>
  );
}
