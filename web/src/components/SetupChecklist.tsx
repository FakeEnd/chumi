import { useEffect, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { api } from '../api.ts';
import { refreshProvider, saveSettings } from '../actions.ts';
import { t } from '../i18n.ts';
import { providerShort } from './TopBar.tsx';

type Mic = 'granted' | 'denied' | 'restricted' | 'not_determined' | 'unknown' | string;
interface Step { id: string; done: boolean; title: string; detail: string; action?: { label: string; run: () => void }; code?: string }

/**
 * Getting started on Home, until everything needed is ready or the user hides it: the speech engine, an AI
 * connection, the user's own background (explanations are pitched to it), and microphone access.
 */
export function SetupChecklist() {
  const settings = useStore((s) => s.settings);
  const asr = useStore((s) => s.live?.asr);
  const provider = useStore((s) => s.provider);
  const profile = useStore((s) => s.profile);
  const [mic, setMic] = useState<Mic | null>(null);
  const [helper, setHelper] = useState(true);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState('');

  const loadMic = () => void api<{ microphone: Mic; helper?: string }>('/api/audio/permissions')
    .then((p) => { setMic(p.microphone); setHelper(p.helper !== 'missing'); }).catch(() => setMic('unknown'));
  useEffect(() => {
    loadMic();
    // Permissions change in System Settings, outside the app: check again when the window comes back.
    const onFocus = () => loadMic();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (!settings || settings.ui.setupDismissed) return null;
  const described = !!profile && !!(profile.background.trim() || profile.researchInterests.trim() || profile.domains.length);
  const steps: Step[] = [
    {
      id: 'speech', done: asr?.state === 'ready',
      title: t('Speech recognition on this Mac'),
      detail: asr?.state === 'ready' ? t('Ready. Audio never leaves your Mac.') : asr?.message ?? t('The speech model is not ready yet.'),
      action: asr?.state === 'ready' ? undefined : { label: t('Open Transcription settings'), run: () => setState({ dialog: 'settings', settingsTab: 'asr' }) },
    },
    {
      id: 'ai', done: provider?.state === 'ready',
      title: t('Connect the AI you already have'),
      detail: provider?.state === 'ready'
        ? t('{provider} is connected.', { provider: providerShort(provider.label) })
        : provider?.message ? t(provider.message) : t('Use your ChatGPT or Claude subscription, or a local model.'),
      code: provider?.state === 'ready' ? undefined : provider?.setupHint?.match(/(codex login|claude auth login|brew install [\w-]+|npm install -g [\w@/-]+)/)?.[1],
      action: provider?.state === 'ready' ? undefined : { label: t('Choose AI'), run: () => setState({ dialog: 'settings', settingsTab: 'ai' }) },
    },
    {
      id: 'profile', done: described,
      title: t('Tell Chumi about your background'),
      detail: described ? t('Explanations are pitched to your profile. You can change it any time.')
        : t('Explanations are pitched to what you already know, field by field. It takes a minute.'),
      action: described ? undefined : { label: t('Describe your background'), run: () => setState({ dialog: 'profile' }) },
    },
    {
      id: 'mic', done: mic === 'granted',
      title: t('Allow the microphone'),
      detail: !helper ? t('The audio helper is not built yet. Run bash scripts/setup.sh in the Chumi folder.')
        : mic === 'granted' ? t('Allowed. macOS asks separately the first time you record computer audio.')
          : mic === 'denied' || mic === 'restricted' ? t('Microphone access is turned off for Chumi. Turn it on in System Settings → Privacy & Security → Microphone.')
            : t('macOS asks once. Allow it so Chumi can hear the room.'),
      action: !helper || mic === 'granted' ? undefined
        : mic === 'denied' || mic === 'restricted' ? { label: t('Open System Settings'), run: () => void api('/api/audio/open-settings', { body: { pane: 'microphone' } }) }
          : { label: t('Allow microphone'), run: () => void api('/api/audio/request-mic', { body: {} }).finally(loadMic) },
    },
  ];
  const left = steps.filter((s) => !s.done).length;
  if (!left) return null;
  const recheck = async () => { setChecking(true); loadMic(); await refreshProvider(); setChecking(false); };
  const copy = (code: string) => { void navigator.clipboard?.writeText(code).then(() => { setCopied(code); setTimeout(() => setCopied(''), 1500); }); };

  return (
    <section className="panel setup-checklist" aria-label={t('Get Chumi ready')}>
      <div className="panel-head">
        <h2>{t('Get Chumi ready')}</h2>
        <span className="muted small">{t('{done} of {total} ready', { done: steps.length - left, total: steps.length })}</span>
        <span className="spacer" />
        <button className="btn small" disabled={checking} onClick={() => void recheck()}>{checking ? t('Checking…') : t('Check again')}</button>
        <button className="link-btn small" onClick={() => void saveSettings({ ui: { setupDismissed: true } })}>{t('Hide')}</button>
      </div>
      <ol className="setup-steps">
        {steps.map((s) => (
          <li key={s.id} className={s.done ? 'done' : ''}>
            <span className="setup-mark" aria-hidden="true">{s.done ? '✓' : ''}</span>
            <div className="setup-body">
              <div className="setup-title">{s.title}</div>
              <div className="muted small">{s.detail}</div>
              {s.code && <div className="setup-code"><code>{s.code}</code><button className="link-btn small" onClick={() => copy(s.code!)}>{copied === s.code ? t('Copied') : t('Copy')}</button><span className="muted small">{t('Run it in Terminal, then click Check again.')}</span></div>}
            </div>
            {s.action && <button className="btn small primary" onClick={s.action.run}>{s.action.label}</button>}
          </li>
        ))}
      </ol>
      <p className="muted small setup-optional">{t('Optional: continue meetings in Claude Code or Codex.')} <button className="link-btn small" onClick={() => setState({ dialog: 'settings', settingsTab: 'agents' })}>{t('Connect a coding agent')}</button></p>
    </section>
  );
}
