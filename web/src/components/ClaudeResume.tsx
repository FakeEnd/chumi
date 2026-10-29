import { useState } from 'react';
import { api } from '../api.ts';
import { setState } from '../store.ts';
import { t } from '../i18n.ts';
import type { ProviderStatus } from '../types.ts';

export function ClaudeResume() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const resume = async () => {
    if (!confirm(t('Resume Claude requests? If your plan limit has not reset and extra usage is enabled in Claude, the next request may be billed.'))) return;
    setBusy(true); setError('');
    try { setState({ provider: await api<ProviderStatus>('/api/provider/claude/clear-overage', { body: {} }) }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not resume Claude requests.'); }
    finally { setBusy(false); }
  };
  return <div>
    <button className="btn small" disabled={busy} onClick={() => void resume()}>{busy ? t('Resuming…') : t('Resume Claude requests')}</button>
    {error && <p className="small warn-text" role="alert">{t(error)}</p>}
  </div>;
}
