import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import { saveSettings } from '../actions.ts';
import { api } from '../api.ts';
import { fmtClock } from '../util.ts';
import { t, tn } from '../i18n.ts';

interface RemoteStatus {
  enabled: boolean; port: number; listening: boolean; error: string | null; urls: string[];
  devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt: number | null }>;
  phone: { status: string; source: string; phoneConnected: boolean };
}

/** Settings → Phone: phone access over the local network for the Chumi Android app (android/). */
export function PhoneTab() {
  const settings = useStore((s) => s.settings);
  const [info, setInfo] = useState<RemoteStatus | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number; urls: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => void api<RemoteStatus>('/api/remote').then(setInfo).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, []);
  if (!settings) return null;
  const toggle = async (enabled: boolean) => { setPairing(null); await saveSettings({ remote: { enabled } }); setTimeout(load, 300); };
  const pair = async () => { setError(null); try { setPairing(await api('/api/remote/pairing', { body: {} })); } catch (e) { setError((e as Error).message); } };
  const remove = async (id: string) => { if (confirm(t('Remove this phone? It will need to pair again.'))) setInfo(await api(`/api/remote/devices/${id}`, { method: 'DELETE' })); };
  const live = info?.phone;
  return (
    <section>
      <p className="small">{t('Record a meeting with your Android phone and follow it there: the phone sends the audio to Chumi on this computer, which transcribes it and answers as usual. The phone also opens Chumi\'s full interface.')}</p>
      <label className="field check"><input type="checkbox" checked={settings.remote.enabled} onChange={(e) => void toggle(e.target.checked)} /> {t('Allow paired phones to connect over the network (port {port})', { port: settings.remote.port })}</label>
      <p className="muted small">{t('Off by default. Only phones you pair can connect, and they cannot see API keys. The connection is not encrypted: use it on your own network, or through a VPN such as Tailscale.')}</p>
      {error && <p className="error-text small">{error}</p>}
      {info?.error && <p className="error-text small">{info.error}</p>}
      {settings.remote.enabled && info && (
        <>
          <div className="agent-row">
            <b>{t('Phone access')}</b>
            <span className={`pill ${info.listening ? 'ok' : 'warn'}`}><span className="dot" />{info.listening ? t('listening') : t('not listening')}</span>
            {live?.source === 'phone' && live.status !== 'idle' && <span className={`pill ${live.phoneConnected ? 'ok' : 'warn'}`}><span className="dot" />{live.phoneConnected ? t('a phone is sending audio') : t('waiting for the phone')}</span>}
          </div>
          <div className="btn-row" style={{ marginBottom: 10 }}><button className="btn small primary" onClick={() => void pair()}>{t('Pair a phone')}</button></div>
          {pairing && (
            <div className="agent-card">
              <div>{tn('In the Chumi app on the phone, enter one of these addresses and the code {code}.', { code: <b className="pairing-code">{pairing.code}</b> })}</div>
              {pairing.urls.map((u) => <pre key={u} className="cmd small">{u}</pre>)}
              {!pairing.urls.length && <div className="warn-text small">{t('This computer has no network address. Connect it to Wi-Fi or a VPN first.')}</div>}
              <div className="muted small">{t('The code works once and expires at {time}.', { time: fmtClock(pairing.expiresAt) })}</div>
            </div>
          )}
          <h3>{t('Paired phones')}</h3>
          {!info.devices.length && <p className="muted small">{t('None yet.')}</p>}
          {info.devices.map((d) => (
            <div key={d.id} className="agent-row">
              <b>{d.name}</b>
              <span className="muted small">{d.lastSeenAt ? t('last seen {time}', { time: fmtClock(d.lastSeenAt) }) : t('not seen yet')}</span>
              <span className="spacer" />
              <button className="btn small ghost" onClick={() => void remove(d.id)}>{t('Remove')}</button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
