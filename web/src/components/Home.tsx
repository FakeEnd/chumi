import { useEffect, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { api } from '../api.ts';
import { openSession, quickStart } from '../actions.ts';
import { sourceLabel } from '../util.ts';
import { getLang, msg, t, tn } from '../i18n.ts';
import type { Session } from '../types.ts';
import { billingWord, DEPTH_LABEL, providerShort } from './TopBar.tsx';
import { SessionMeta, SessionTitle } from './SessionLabel.tsx';
import { IconArrow, IconBolt, IconBoth, IconMic, IconMonitor, IconShield, IconSpark, IconText, IconWindow } from './icons.tsx';

const LEVELS = [msg('new'), msg('intro'), msg('working'), msg('strong'), msg('expert')];
const PROVIDER_STATE: Record<string, string> = { checking: msg('checking'), signed_out: msg('not signed in'), quota_blocked: msg('limit reached'), not_installed: msg('not installed'), disabled: msg('disabled'), error: msg('unavailable') };
const ASR_STATE: Record<string, string> = { starting: msg('loading…'), stopped: msg('idle'), error: msg('restarting…'), missing_model: msg('model not installed'), missing_binary: msg('not installed') };

function greeting(): string {
  const h = new Date().getHours();
  return t(h < 5 ? msg('Working late') : h < 12 ? msg('Good morning') : h < 18 ? msg('Good afternoon') : msg('Good evening'));
}

export function Home() {
  const settings = useStore((s) => s.settings);
  const profile = useStore((s) => s.profile);
  const provider = useStore((s) => s.provider);
  const asr = useStore((s) => s.live?.asr);
  const live = useStore((s) => s.live);
  const hotkey = useStore((s) => s.hotkey);
  const [recent, setRecent] = useState<Session[] | null>(null);
  const sessionsRev = useStore((s) => s.sessionsRev);
  useEffect(() => { void api<{ sessions: Session[] }>('/api/sessions').then((r) => setRecent(r.sessions.slice(0, 6))).catch(() => setRecent([])); }, [live?.status, sessionsRev]);

  const liveSession = live?.session && live.status !== 'idle' ? live.session : null;
  const startWith = (source: string) => {
    if (settings?.audio.source !== source) void api('/api/settings', { method: 'PUT', body: { audio: { source } } }).then((s) => setState({ settings: s }));
    setState({ dialog: 'start' });
  };
  const quickSrc = settings ? (settings.quickStart.source === 'default' ? settings.audio.source : settings.quickStart.source) : 'mic';
  const aiReady = provider?.state === 'ready';
  const topDomains = (profile?.domains ?? []).slice().sort((a, b) => b.level - a.level).slice(0, 6);
  const srcName = getLang() === 'zh' ? sourceLabel(quickSrc) : sourceLabel(quickSrc).toLowerCase();

  return (
    <div className="home">
      {liveSession && (
        <button className="home-live" onClick={() => void openSession(liveSession.id)}>
          <span className="live-dot" /> {live?.status === 'paused' ? t('Paused') : t('Recording')}: <b>{liveSession.title}</b> <span className="spacer" /> {t('Return to session')} <IconArrow />
        </button>
      )}

      <section className="hero">
        <img src="/logo.svg" alt="" className="hero-logo" />
        <div className="hero-text">
          <h1>{greeting()}{getLang() === 'zh' ? '' : '.'}</h1>
          <p>{t('Chumi listens alongside you, keeps track of the discussion, and explains what you need, right when you need it.')}</p>
          <div className="hero-status">
            <span className={`pill ${asr?.state === 'ready' ? 'ok' : 'muted'}`}><span className="dot" />{t('Speech engine')} {asr?.state === 'ready' ? t('ready (on this Mac)') : asr?.state ? t(ASR_STATE[asr.state] ?? asr.state) : '…'}</span>
            <span className={`pill ${aiReady ? 'ok' : 'warn'}`} onClick={() => setState({ dialog: 'settings', settingsTab: 'ai' })} role="button" tabIndex={0}><span className="dot" />{provider ? `${providerShort(provider.label)} · ${aiReady ? billingWord(provider.billing) : t(PROVIDER_STATE[provider.state] ?? provider.state)}` : t('AI: checking…')}</span>
            {hotkey?.state === 'ready' && <span className="pill accent"><IconBolt width={13} height={13} />{t('{key} starts listening from any app', { key: hotkey.shortcut })}</span>}
          </div>
        </div>
      </section>

      <div className="home-grid">
        <div className="home-main">
          <section className="start-row">
            <button className="start-card quick" onClick={() => void quickStart()} disabled={!!liveSession}>
              <span className="start-icon"><IconBolt /></span>
              <span className="start-title">{t('Quick start')}</span>
              <span className="start-sub">{t('Listen now with {source}. Rename later.', { source: srcName })}</span>
              {hotkey?.state === 'ready' && <span className="kbd big">{hotkey.shortcut}</span>}
            </button>
            <button className="start-card" onClick={() => startWith('mic')} disabled={!!liveSession}>
              <span className="start-icon mic"><IconMic /></span>
              <span className="start-title">{t('In person')}</span>
              <span className="start-sub">{t('Lab meeting, advisor 1:1 or lecture hall, using the microphone')}</span>
            </button>
            <button className="start-card" onClick={() => startWith('system')} disabled={!!liveSession}>
              <span className="start-icon sys"><IconMonitor /></span>
              <span className="start-title">{t('Online or video')}</span>
              <span className="start-sub">{t('Zoom, Teams or recorded lectures, using computer audio (headphones OK)')}</span>
            </button>
            <button className="start-card" onClick={() => startWith('both')} disabled={!!liveSession}>
              <span className="start-icon both"><IconBoth /></span>
              <span className="start-title">{t('Hybrid')}</span>
              <span className="start-sub">{t('The room plus remote speakers, with echo-cancelled mic and computer audio')}</span>
            </button>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>{t('Recent sessions')}</h2>
              <button className="btn small ghost" onClick={() => setState({ dialog: 'history' })}>{t('View all')} <IconArrow width={13} height={13} /></button>
            </div>
            {recent === null && <p className="muted small pad">{t('Loading…')}</p>}
            {recent?.length === 0 && (
              <div className="empty-recent">
                <IconSpark width={28} height={28} />
                <p>{t('No sessions yet. Your transcripts, catch-ups and summaries will appear here.')}</p>
              </div>
            )}
            <ul className="recent-list">
              {recent?.map((s) => (
                <li key={s.id}>
                  <button onClick={() => void openSession(s.id)}>
                    <span className={`type-dot t-${s.type}`} />
                    <span className="recent-main">
                      <span className="recent-title session-title"><SessionTitle s={s} /></span>
                      <span className="muted small"><SessionMeta s={s} /></span>
                    </span>
                    <IconArrow width={14} height={14} className="recent-arrow" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="home-side">
          <section className="panel">
            <div className="panel-head">
              <h2>{t('Your profile')}</h2>
              <button className="btn small ghost" onClick={() => setState({ dialog: 'profile' })}>{t('Edit')}</button>
            </div>
            {profile && (
              <>
                <p className="small profile-line">{profile.researchInterests}</p>
                <ul className="domain-bars">
                  {topDomains.map((d) => (
                    <li key={d.name}>
                      <span className="small">{d.name}</span>
                      <span className="bar"><span style={{ width: `${(d.level / 4) * 100}%` }} /></span>
                      <span className="muted tiny">{t(LEVELS[d.level])}</span>
                    </li>
                  ))}
                </ul>
                <p className="muted tiny">{t('AI answers in {lang} · default depth {depth}', { lang: profile.explanationLanguage === 'English' ? 'English' : '中文', depth: t(DEPTH_LABEL[settings?.assist.defaultDepth ?? 'standard']) })}</p>
              </>
            )}
          </section>

          <section className="panel tips">
            <h2>{t('Tips')}</h2>
            <ul>
              <li><IconSpark /><span>{tn('{b1} Press {b2} to get the last 2 or 5 minutes, or the whole session so far.', { b1: <b>{t('Lost the thread?')}</b>, b2: <b>{t('Catch me up')}</b> })}</span></li>
              <li><IconText /><span>{tn('{b} in the transcript to get an explanation pitched to your background.', { b: <b>{t('Select any words')}</b> })}</span></li>
              <li><IconWindow /><span>{tn('{b} (Zoom share, slides) so answers can see the figure being discussed.', { b: <b>{t('Capture a window')}</b> })}</span></li>
              <li><IconShield /><span>{t('Audio stays on this Mac. Only short excerpts go to your AI provider, and only when you ask.')}</span></li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
