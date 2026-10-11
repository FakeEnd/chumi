import { useEffect, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { api } from '../api.ts';
import { openSession, quickStart } from '../actions.ts';
import { fmtDate, fmtT, SOURCE_LABEL, typeLabel } from '../util.ts';
import type { Session } from '../types.ts';
import { IconArrow, IconBolt, IconBoth, IconMic, IconMonitor, IconShield, IconSpark, IconText, IconWindow } from './icons.tsx';

const LEVELS = ['new', 'intro', 'working', 'strong', 'expert'];

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function Home() {
  const settings = useStore((s) => s.settings);
  const profile = useStore((s) => s.profile);
  const provider = useStore((s) => s.provider);
  const asr = useStore((s) => s.live?.asr);
  const live = useStore((s) => s.live);
  const hotkey = useStore((s) => s.hotkey);
  const [recent, setRecent] = useState<Session[] | null>(null);
  useEffect(() => { void api<{ sessions: Session[] }>('/api/sessions').then((r) => setRecent(r.sessions.slice(0, 6))).catch(() => setRecent([])); }, [live?.status]);

  const liveSession = live?.session && live.status !== 'idle' ? live.session : null;
  const startWith = (source: string) => {
    if (settings?.audio.source !== source) void api('/api/settings', { method: 'PUT', body: { audio: { source } } }).then((s) => setState({ settings: s }));
    setState({ dialog: 'start' });
  };
  const quickSrc = settings ? (settings.quickStart.source === 'default' ? settings.audio.source : settings.quickStart.source) : 'mic';
  const aiReady = provider?.state === 'ready';
  const topDomains = (profile?.domains ?? []).slice().sort((a, b) => b.level - a.level).slice(0, 6);

  return (
    <div className="home">
      {liveSession && (
        <button className="home-live" onClick={() => void openSession(liveSession.id)}>
          <span className="live-dot" /> {live?.status === 'paused' ? 'Paused' : 'Recording'}: <b>{liveSession.title}</b> <span className="spacer" /> Return to session <IconArrow />
        </button>
      )}

      <section className="hero">
        <img src="/logo.svg" alt="" className="hero-logo" />
        <div className="hero-text">
          <h1>{greeting()}.</h1>
          <p>Chumi listens alongside you, keeps track of the discussion, and explains what you need, right when you need it.</p>
          <div className="hero-status">
            <span className={`pill ${asr?.state === 'ready' ? 'ok' : 'muted'}`}><span className="dot" />Speech engine {asr?.state === 'ready' ? 'ready (on this Mac)' : asr?.state ?? '…'}</span>
            <span className={`pill ${aiReady ? 'ok' : 'warn'}`} onClick={() => setState({ dialog: 'settings', settingsTab: 'ai' })} role="button" tabIndex={0}><span className="dot" />{provider ? `${provider.label.split(' (')[0]}${aiReady ? ` · ${provider.billing === 'subscription' ? 'subscription' : provider.billing}` : ` · ${provider.state.replace('_', ' ')}`}` : 'AI: checking…'}</span>
            {hotkey?.state === 'ready' && <span className="pill accent"><IconBolt width={13} height={13} />{hotkey.shortcut} starts listening from any app</span>}
          </div>
        </div>
      </section>

      <div className="home-grid">
        <div className="home-main">
          <section className="start-row">
            <button className="start-card quick" onClick={() => void quickStart()} disabled={!!liveSession}>
              <span className="start-icon"><IconBolt /></span>
              <span className="start-title">Quick start</span>
              <span className="start-sub">Listen now with {SOURCE_LABEL[quickSrc]?.toLowerCase() ?? quickSrc}. Rename later.</span>
              {hotkey?.state === 'ready' && <span className="kbd big">{hotkey.shortcut}</span>}
            </button>
            <button className="start-card" onClick={() => startWith('mic')} disabled={!!liveSession}>
              <span className="start-icon mic"><IconMic /></span>
              <span className="start-title">In person</span>
              <span className="start-sub">Lab meeting, advisor 1:1 or lecture hall, using the microphone</span>
            </button>
            <button className="start-card" onClick={() => startWith('system')} disabled={!!liveSession}>
              <span className="start-icon sys"><IconMonitor /></span>
              <span className="start-title">Online or video</span>
              <span className="start-sub">Zoom, Teams or recorded lectures, using computer audio (headphones OK)</span>
            </button>
            <button className="start-card" onClick={() => startWith('both')} disabled={!!liveSession}>
              <span className="start-icon both"><IconBoth /></span>
              <span className="start-title">Hybrid</span>
              <span className="start-sub">The room plus remote speakers, with echo-cancelled mic and computer audio</span>
            </button>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Recent sessions</h2>
              <button className="btn small ghost" onClick={() => setState({ dialog: 'history' })}>View all <IconArrow width={13} height={13} /></button>
            </div>
            {recent === null && <p className="muted small pad">Loading…</p>}
            {recent?.length === 0 && (
              <div className="empty-recent">
                <IconSpark width={28} height={28} />
                <p>No sessions yet. Your transcripts, catch-ups and summaries will appear here.</p>
              </div>
            )}
            <ul className="recent-list">
              {recent?.map((s) => (
                <li key={s.id}>
                  <button onClick={() => void openSession(s.id)}>
                    <span className={`type-dot t-${s.type}`} />
                    <span className="recent-main">
                      <span className="recent-title">{s.title}</span>
                      <span className="muted small">{typeLabel(s.type)} · {fmtDate(s.started_at ?? s.created_at)} · {fmtT(s.duration_ms)} · {s.segment_count ?? 0} lines</span>
                    </span>
                    {s.status === 'interrupted' && <span className="tag tag-warn">interrupted</span>}
                    {(s.status === 'recording' || s.status === 'paused') && <span className="tag tag-live">live</span>}
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
              <h2>Your profile</h2>
              <button className="btn small ghost" onClick={() => setState({ dialog: 'profile' })}>Edit</button>
            </div>
            {profile && (
              <>
                <p className="small profile-line">{profile.researchInterests}</p>
                <ul className="domain-bars">
                  {topDomains.map((d) => (
                    <li key={d.name}>
                      <span className="small">{d.name}</span>
                      <span className="bar"><span style={{ width: `${(d.level / 4) * 100}%` }} /></span>
                      <span className="muted tiny">{LEVELS[d.level]}</span>
                    </li>
                  ))}
                </ul>
                <p className="muted tiny">Explanations in {profile.explanationLanguage === 'English' ? 'English' : '中文 (Chinese)'} · default depth {settings?.assist.defaultDepth}</p>
              </>
            )}
          </section>

          <section className="panel tips">
            <h2>Tips</h2>
            <ul>
              <li><IconSpark /><span><b>Lost the thread?</b> Press <b>Catch me up</b> to get the last 2 or 5 minutes, or the whole session so far.</span></li>
              <li><IconText /><span><b>Select any words</b> in the transcript to get an explanation pitched to your background.</span></li>
              <li><IconWindow /><span><b>Capture a window</b> (Zoom share, slides) so answers can see the figure being discussed.</span></li>
              <li><IconShield /><span>Audio stays on this Mac. Only short excerpts go to your AI provider, and only when you ask.</span></li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
