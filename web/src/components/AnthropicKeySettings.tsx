import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { setState, useStore } from '../store.ts';
import { t } from '../i18n.ts';
import type { ProviderStatus } from '../types.ts';

export function AnthropicKeySettings() {
  const windows = useStore((s) => s.platform) === 'win32';
  const [key, setKey] = useState('');
  const [stored, setStored] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let current = true;
    void api<{ stored: boolean }>('/api/provider/anthropic-key').then((result) => { if (current) setStored(result.stored); })
      .catch((e: unknown) => { if (current) setError(e instanceof Error ? e.message : 'Could not check the saved API key.'); })
      .finally(() => { if (current) setChecking(false); });
    return () => { current = false; };
  }, []);
  const act = async (remove: boolean) => {
    if (remove && !confirm(t('Remove the saved Anthropic API key?'))) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const provider = await api<ProviderStatus>('/api/provider/anthropic-key', remove ? { method: 'DELETE' } : { body: { key: key.trim() } });
      setState({ provider });
      setKey(''); setStored(!remove);
      setNotice(remove ? t('API key removed.') : windows ? t('API key saved for your Windows account.') : t('API key saved in macOS Keychain.'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update the API key.'); }
    finally { setBusy(false); }
  };
  return <div className="field">
    <div className="field-row">
      <input type="password" aria-label={t('API key')} placeholder={windows ? t('sk-ant-… (encrypted for your Windows account)') : t('sk-ant-… (stored in macOS Keychain)')} value={key} onChange={(e) => setKey(e.target.value)} disabled={busy || checking} autoComplete="off" />
      <button className="btn small" disabled={busy || checking || !key.trim()} onClick={() => void act(false)}>{busy ? t('Saving…') : t('Save key')}</button>
      {stored && <button className="btn small" disabled={busy || checking} onClick={() => void act(true)}>{t('Remove key')}</button>}
    </div>
    {checking && <p className="small muted" role="status">{t('Checking saved key…')}</p>}
    {notice && <p className="small ok-text" role="status">{notice}</p>}
    {error && <p className="small warn-text" role="alert">{t(error)}</p>}
  </div>;
}
