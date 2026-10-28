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
  const windows = useStore((s) => s.platform) === 'win32';
  const download = useStore((s) => s.asrDownload);
  const [mic, setMic] = useState<Mic | null>(null);
  const [helper, setHelper] = useState(true);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState('');

  const loadMic = () => void api<{ microphone: Mic; helper?: string }>('/api/audio/permissions')
    .then((p) => { setMic(p.microphone); setHelper(p.helper !== 'missing'); }).catch(() => setMic('unknown'));
  useEffect(() => {
    loadMic();
    // Permissions change in System Settings, outside the app: check again when the window comes back.
    const onFocus = () => { loadMic(); void refreshProvider(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (!settings || settings.ui.setupDismissed) return null;
  const described = !!profile && !!(profile.background.trim() || profile.researchInterests.trim() || profile.domains.length);
  const localSpeech = settings.asr.engine === 'qwen3' || settings.asr.engine === 'sensevoice' || settings.asr.engine === 'whisper';
  const steps: Step[] = [
    {
      id: 'speech', done: asr?.state === 'ready',
      title: localSpeech ? t('Speech recognition on this computer') : t('Speech recognition'),
      detail: asr?.state === 'ready' ? localSpeech ? t('Ready. Audio never leaves your computer.') : t('Ready. A speech service transcribes your meetings.')
        : download?.status === 'downloading' ? t('Downloading speech model: {progress}', { progress: download.total ? `${Math.round(download.received / download.total * 100)}%` : `${Math.round(download.received / 1048576)} MB` })
          : asr?.state === 'missing_model' ? settings.asr.engine === 'qwen3' ? t('Download Qwen3-ASR, the recommended local engine. Whisper keeps transcribing if its model is installed.') : t('Download the speech model once. Meetings are then transcribed locally.') : asr?.message ?? t('The speech model is not ready yet.'),
      action: asr?.state === 'ready' || download?.status === 'downloading' || asr?.state === 'starting' ? undefined
        : asr?.state === 'missing_model' ? { label: t('Download speech model'), run: () => void api('/api/asr/setup', { body: {} }) }
          : { label: t('Open Transcription settings'), run: () => setState({ dialog: 'settings', settingsTab: 'asr' }) },
    },
    {
      id: 'ai', done: provider?.state === 'ready',
      title: t('Connect the AI you already have'),
      detail: provider?.state === 'ready'
        ? t('{provider} is connected.', { provider: providerShort(provider.label) })
        : provider?.message ? t(provider.message) : t('Use your ChatGPT or Claude subscription, or a local model.'),
      code: provider?.state === 'ready' || windows ? undefined : provider?.setupHint?.match(/(codex login|claude auth login|brew install [\w-]+|npm install -g [\w@/-]+)/)?.[1],
      action: provider?.state === 'ready' ? undefined
        : windows && settings.ai.provider === 'codex' ? { label: t('Sign in with ChatGPT'), run: () => void api('/api/provider/codex/login', { body: {} }) }
          : { label: t('Choose AI'), run: () => setState({ dialog: 'settings', settingsTab: 'ai' }) },
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
      detail: !helper ? windows ? t('The audio component is missing. Reinstall Chumi to restore it.') : t('The audio helper is not built yet. Run bash scripts/setup.sh in the Chumi folder.')
        : mic === 'granted' ? windows ? t('Microphone ready. Computer audio needs no additional permission.') : t('Allowed. macOS asks separately the first time you record computer audio.')
          : windows ? t('Allow desktop apps to access the microphone in Windows Settings → Privacy & security → Microphone.')
          : mic === 'denied' || mic === 'restricted' ? t('Microphone access is turned off for Chumi. Turn it on in System Settings → Privacy & Security → Microphone.')
            : t('macOS asks once. Allow it so Chumi can hear the room.'),
      action: !helper || mic === 'granted' ? undefined
        : windows ? { label: t('Open Microphone settings'), run: () => void api('/api/audio/open-settings', { body: { pane: 'microphone' } }) }
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
