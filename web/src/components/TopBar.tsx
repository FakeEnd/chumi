import { useEffect, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { endSession, openSession, pauseSession, quickStart, renameSession, resumeLive, saveProfile, saveSettings } from '../actions.ts';
import { fmtT, SESSION_TYPES, SOURCE_LABEL } from '../util.ts';
import type { Depth } from '../types.ts';
import { IconBolt, IconClock, IconGear, IconSpark, IconUser, IconWindow } from './icons.tsx';

function Meter({ label, source }: { label: string; source: string }) {
  const lvl = useStore((s) => s.levels[source]);
  const fresh = lvl && Date.now() - lvl.at < 1500;
  const pct = fresh ? Math.max(0, Math.min(100, ((lvl.rms + 60) / 50) * 100)) : 0;
  return (
    <div className="meter" title={fresh ? `${label}: ${lvl.rms.toFixed(0)} dBFS` : `${label}: no signal (silence, or nothing playing)`}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar"><span style={{ width: `${pct}%` }} className={pct > 85 ? 'hot' : ''} /></span>
    </div>
  );
}

function Clock() {
  const live = useStore((s) => s.live);
  const at = useStore((s) => s.liveReceivedAt);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 500); return () => clearInterval(t); }, []);
  if (!live) return null;
  const speed = live.file?.speed ?? 1;
  const t = live.status === 'recording' ? live.nowT + (Date.now() - at) * speed : live.nowT;
  return <span className="clock">{fmtT(t)}</span>;
}

export function ProviderBadge() {
  const p = useStore((s) => s.provider);
  if (!p) return <button className="badge muted" onClick={() => setState({ dialog: 'settings', settingsTab: 'ai' })}>AI: checking…</button>;
  const maxUsed = Math.max(0, ...(p.quota.windows ?? []).map((w) => w.usedPercent));
  const nearLimit = p.state === 'ready' && maxUsed >= 80;
  const cls = p.state === 'ready' ? (p.billing === 'api' || p.billing === 'credits' || nearLimit ? 'badge warn' : 'badge ok') : p.state === 'quota_blocked' ? 'badge warn' : 'badge bad';
  const reset = p.quota.windows?.find((w) => w.usedPercent >= 100)?.resetsAt;
  const name = p.label.split(' (')[0].replace(' plan', '');
  const text = p.state === 'ready' ? `${name} · ${p.billing === 'subscription' ? 'subscription' : p.billing === 'api' ? 'paid API' : p.billing === 'credits' ? 'credits' : p.billing}${nearLimit ? ` · ${maxUsed}% used` : ''}`
    : p.state === 'quota_blocked' ? `AI paused: limit${reset ? ` · resets ${new Date(reset).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}`
    : p.state === 'signed_out' ? 'AI: not signed in' : p.state === 'disabled' ? 'AI: disabled' : 'AI: unavailable';
  return <button className={cls} title={`${p.label}\n${p.billingLabel}\n${p.quota.summary}${p.message ? `\n${p.message}` : ''}`} onClick={() => setState({ dialog: 'settings', settingsTab: 'ai' })}><span className="dot" />{text}</button>;
}

function AsrBadge() {
  const asr = useStore((s) => s.live?.asr);
  if (!asr) return null;
  const label = asr.state === 'ready' ? `Speech${asr.latencyMs ? ` · ${(asr.latencyMs / 1000).toFixed(1)}s` : ''}${asr.backlogSec > 3 ? ` · ${asr.backlogSec}s behind` : ''}`
    : asr.state === 'starting' ? 'Speech: loading…' : asr.state === 'missing_model' || asr.state === 'missing_binary' ? 'Speech: not installed' : asr.state === 'error' ? 'Speech: restarting…' : 'Speech: idle';
  const cls = asr.state === 'ready' ? (asr.backlogSec > 10 ? 'badge warn' : 'badge ok') : asr.state === 'starting' || asr.state === 'stopped' ? 'badge muted' : 'badge bad';
  return <span className={cls} title={asr.message ?? 'Local speech recognition (whisper.cpp). No audio leaves this Mac.'}><span className="dot" />{label}</span>;
}

/** Tier 1: brand, session, recording controls, status, navigation. */
export function TopBar() {
  const live = useStore((s) => s.live);
  const data = useStore((s) => s.data);
  const hotkey = useStore((s) => s.hotkey);
  const status = live?.status ?? 'idle';
  const activeSession = live?.session;
  const viewingLive = !!activeSession && data?.session.id === activeSession.id;
  const [title, setTitle] = useState('');
  useEffect(() => { setTitle(data?.session.title ?? ''); }, [data?.session.id, data?.session.title]);
  const recording = status === 'recording';
  const goHome = () => setState({ viewId: null, data: null, deltas: {}, focus: null, attached: null });

  return (
    <header className="topbar">
      <button className="brand" onClick={goHome} title="Home"><img src="/logo.svg" alt="" />Chumi</button>
      <div className="session-meta">
        {data ? (
          <>
            <span className="crumb-sep">/</span>
            <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== data.session.title && renameSession(data.session.id, { title })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label="Session title" />
            <select className="type-select" value={data.session.type} onChange={(e) => renameSession(data.session.id, { type: e.target.value })} aria-label="Session type">
              {SESSION_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </>
        ) : <><span className="crumb-sep">/</span><span className="crumb">Home</span></>}
      </div>

      <div className="controls">
        {status === 'idle' && data && (
          <>
            <button className="btn primary" onClick={() => void quickStart()} title={hotkey?.state === 'ready' ? `Start listening now, or press ${hotkey.shortcut} from any app` : 'Start listening now'}>
              <IconBolt width={14} height={14} /> Quick start{hotkey?.state === 'ready' ? <span className="kbd">{hotkey.shortcut}</span> : null}
            </button>
            <button className="btn" onClick={() => setState({ dialog: 'start' })}>Start session…</button>
          </>
        )}
        {status === 'starting' && <span className="status-pill">Starting…</span>}
        {status === 'ending' && <span className="status-pill">Saving…</span>}
        {(recording || status === 'paused') && (
          <>
            <span className={`status-pill ${recording ? 'rec' : 'paused'}`}>{recording ? <span className="live-dot" /> : '❚❚'} {recording ? 'REC' : 'Paused'} <Clock /></span>
            {recording ? <button className="btn" onClick={() => pauseSession()}>Pause</button> : <button className="btn" onClick={() => resumeLive()}>Resume</button>}
            <button className="btn danger" onClick={() => { if (confirm('End this session? The transcript is saved and the final summary will be generated.')) void endSession(); }}>End</button>
            {!viewingLive && <button className="btn link" onClick={() => activeSession && void openSession(activeSession.id)}>Back to live</button>}
          </>
        )}
      </div>

      <div className="right">
        <AsrBadge />
        <ProviderBadge />
        <nav className="nav-icons" aria-label="Main">
          <button className="icon-btn" onClick={() => setState({ dialog: 'profile' })} title="Knowledge profile" aria-label="Knowledge profile"><IconUser /></button>
          <button className="icon-btn" onClick={() => setState({ dialog: 'history' })} title="Session history" aria-label="Session history"><IconClock /></button>
          <button className="icon-btn" onClick={() => setState({ dialog: 'settings' })} title="Settings" aria-label="Settings"><IconGear /></button>
        </nav>
      </div>
    </header>
  );
}

/** Tier 2 (session view): audio levels, window capture, and the assistance controls. */
export function SessionToolbar() {
  const live = useStore((s) => s.live);
  const data = useStore((s) => s.data);
  const settings = useStore((s) => s.settings);
  const profile = useStore((s) => s.profile);
  if (!data || !settings) return null;
  const status = live?.status ?? 'idle';
  const isLive = live?.session?.id === data.session.id && (status === 'recording' || status === 'paused');
  const src = live?.source ?? settings.audio.source;
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        {isLive ? (
          <>
            <span className="source-label">{SOURCE_LABEL[src] ?? src}</span>
            {(src === 'mic' || src === 'both') && <Meter label="Mic" source="mic" />}
            {(src === 'system' || src === 'both') && <Meter label="Computer" source="system" />}
            {src === 'file' && <Meter label="File" source="file" />}
            <button className={`btn small ${live?.screen ? 'win-on' : ''}`} onClick={() => setState({ dialog: 'window' })} title="Capture a window (slides, shared screen, video)">
              <IconWindow width={14} height={14} /> {live?.screen ? `${live.screen.app}${live.screen.frames ? ` · ${live.screen.frames}` : ''}` : 'Capture window'}
            </button>
          </>
        ) : <span className="muted small">Saved session · ask questions, explain passages or regenerate the summary</span>}
      </div>
      <div className="toolbar-right">
        <label className="switch" title="Automatically show short background cards for unfamiliar concepts">
          <input type="checkbox" checked={settings.assist.autoExplain} onChange={(e) => saveSettings({ assist: { autoExplain: e.target.checked } })} />
          <span className="slider" /> <IconSpark width={13} height={13} /> Auto-explain
        </label>
        <div className="seg-control" role="group" aria-label="Default explanation depth" title="Default explanation depth (does not change your profile)">
          {(['quick', 'standard', 'deep'] as Depth[]).map((d) => (
            <button key={d} className={settings.assist.defaultDepth === d ? 'on' : ''} onClick={() => saveSettings({ assist: { defaultDepth: d } })}>{d === 'quick' ? 'Quick' : d === 'standard' ? 'Standard' : 'Deep'}</button>
          ))}
        </div>
        {profile && (
          <div className="seg-control" role="group" aria-label="Explanation language" title="Language for explanations, catch-ups and summaries">
            {([['Simplified Chinese', '中文'], ['English', 'EN']] as const).map(([v, l]) => (
              <button key={v} className={profile.explanationLanguage === v ? 'on' : ''} onClick={() => profile.explanationLanguage !== v && void saveProfile({ ...profile, explanationLanguage: v }, true)}>{l}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
