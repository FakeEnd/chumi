import { useEffect, useState } from 'react';
import { setState, useStore } from '../store.ts';
import { assignProject, catchup, endSession, goHome, openSession, pauseSession, quickStart, renameSession, resumeLive, saveProfile, saveSettings, setCompact, summarize } from '../actions.ts';
import { ProjectSelect } from './Projects.tsx';
import { SessionTypeSelect } from './SessionTypes.tsx';
import { fmtDate, fmtT, sourceLabel } from '../util.ts';
import { locale, msg, t } from '../i18n.ts';
import type { Depth } from '../types.ts';
import { IconBolt, IconClock, IconCompact, IconExpand, IconGear, IconSpark, IconUser, IconWave, IconWindow } from './icons.tsx';
import { AudioPlayer } from './AudioPlayer.tsx';
import { HandoffButton } from './Handoff.tsx';
import { compactShortcutLabel, inMacShell } from '../compactMode.ts';
import { onEnter } from '../keys.ts';

export const DEPTH_LABEL: Record<Depth, string> = { quick: msg('Quick'), standard: msg('Standard'), deep: msg('Deep') };

function Meter({ label, source }: { label: string; source: string }) {
  const lvl = useStore((s) => s.levels[source]);
  const fresh = lvl && Date.now() - lvl.at < 1500;
  const pct = fresh ? Math.max(0, Math.min(100, ((lvl.rms + 60) / 50) * 100)) : 0;
  return (
    <div className="meter" title={fresh ? `${label}: ${lvl.rms.toFixed(0)} dBFS` : t('{label}: no signal (silence, or nothing playing)', { label })}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar"><span style={{ width: `${pct}%` }} className={pct > 85 ? 'hot' : ''} /></span>
    </div>
  );
}

function Clock() {
  const live = useStore((s) => s.live);
  const at = useStore((s) => s.liveReceivedAt);
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 500); return () => clearInterval(i); }, []);
  if (!live) return null;
  const speed = live.file?.speed ?? 1;
  const ms = live.status === 'recording' ? live.nowT + (Date.now() - at) * speed : live.nowT;
  return <span className="clock">{fmtT(ms)}</span>;
}

function RecPill({ recording }: { recording: boolean }) {
  return <span className={`status-pill ${recording ? 'rec' : 'paused'}`}>{recording ? <span className="live-dot" /> : '❚❚'} {recording ? 'REC' : t('Paused')} <Clock /></span>;
}

const BILLING: Record<string, string> = { subscription: msg('subscription'), api: msg('paid API'), credits: msg('credits'), none: msg('no cost') };
export const billingWord = (b: string): string => (BILLING[b] ? t(BILLING[b]) : b);
/** Short provider name for badges: "ChatGPT plan (Codex)" → "ChatGPT". */
export const providerShort = (label: string): string => label.split(' (')[0].replace(' plan', '');

export function ProviderBadge() {
  const p = useStore((s) => s.provider);
  if (!p) return <button className="badge muted" onClick={() => setState({ dialog: 'settings', settingsTab: 'ai' })}>{t('AI: checking…')}</button>;
  const maxUsed = Math.max(0, ...(p.quota.windows ?? []).map((w) => w.usedPercent));
  const nearLimit = p.state === 'ready' && maxUsed >= 80;
  const cls = p.state === 'ready' ? (p.billing === 'api' || p.billing === 'credits' || nearLimit ? 'badge warn' : 'badge ok') : p.state === 'quota_blocked' ? 'badge warn' : 'badge bad';
  const reset = p.quota.windows?.find((w) => w.usedPercent >= 100)?.resetsAt;
  const name = providerShort(p.label);
  // The billing word can be hidden when the header is crowded; the tooltip keeps it.
  const text = p.state === 'ready' ? <>{name}<span className="badge-extra"> · {billingWord(p.billing)}</span>{nearLimit ? ` · ${t('{n}% used', { n: maxUsed })}` : ''}</>
    : p.state === 'quota_blocked' ? `${t('AI paused: limit')}${reset ? ` · ${t('resets {date}', { date: new Date(reset).toLocaleDateString(locale(), { month: 'short', day: 'numeric' }) })}` : ''}`
    : p.state === 'signed_out' ? t('AI: not signed in') : p.state === 'disabled' ? t('AI: disabled') : t('AI: unavailable');
  return <button className={cls} title={`${p.label}\n${p.billingLabel}\n${p.quota.summary}${p.message ? `\n${p.message}` : ''}`} onClick={() => setState({ dialog: 'settings', settingsTab: 'ai' })}><span className="dot" /><span className="badge-label">{text}</span></button>;
}

function AsrBadge() {
  const asr = useStore((s) => s.live?.asr);
  const local = useStore((s) => !s.settings || s.settings.asr.engine === 'qwen3' || s.settings.asr.engine === 'whisper');
  if (!asr) return null;
  const label = asr.state === 'ready' ? `${t('Speech')}${asr.latencyMs ? ` · ${(asr.latencyMs / 1000).toFixed(1)}s` : ''}${asr.backlogSec > 3 ? ` · ${t('{n}s behind', { n: asr.backlogSec })}` : ''}`
    : asr.state === 'starting' ? t('Speech: loading…') : asr.state === 'missing_model' || asr.state === 'missing_binary' ? t('Speech: not installed')
    : asr.state === 'missing_key' ? t('Speech: API key needed') : asr.state === 'error' ? local ? t('Speech: restarting…') : t('Speech: service error') : t('Speech: idle');
  const cls = asr.state === 'ready' ? (asr.backlogSec > 10 ? 'badge warn' : 'badge ok') : asr.state === 'starting' || asr.state === 'stopped' ? 'badge muted' : 'badge bad';
  return <span className={`${cls} speech-badge`} aria-label={label} title={asr.message ?? (local ? t('Local speech recognition. No audio leaves this computer.') : t('A speech service transcribes the meeting (Settings → Transcription).'))}><span className="dot" /><span className="badge-label">{label}</span></span>;
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

  return (
    <header className={`topbar ${data ? 'in-session' : ''}`}>
      <button className="brand" onClick={goHome} title={t('Home')}><img src="/logo.svg" alt="" /><span className="brand-name">Chumi</span></button>
      <div className="session-meta">
        {data ? (
          <>
            <span className="crumb-sep">/</span>
            <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== data.session.title && renameSession(data.session.id, { title })} onKeyDown={onEnter((e) => (e.target as HTMLInputElement).blur())} aria-label={t('Session title')} />
            <SessionTypeSelect className="type-select" value={data.session.type} manage onChange={(type) => void renameSession(data.session.id, { type })} />
            <ProjectSelect className="type-select project-select" value={data.session.project_id ?? null}
              onChange={(id) => { if (!data.handoff?.items.length || confirm(t('Move this meeting to another project? Its handoff will need to be reviewed again for the new project.'))) void assignProject(data.session.id, id); }} />
          </>
        ) : <><span className="crumb-sep">/</span><span className="crumb">{t('Home')}</span></>}
      </div>

      <div className="topbar-actions">
        <div className="controls">
          {status === 'idle' && data && (
            <>
              <button className="btn" onClick={() => void quickStart()} title={hotkey?.state === 'ready' ? t('Start listening now, or press {key} from any app', { key: hotkey.shortcut }) : t('Start listening now')}>
                <IconBolt width={14} height={14} /> {t('Quick start')}{hotkey?.state === 'ready' ? <span className="kbd">{hotkey.shortcut}</span> : null}
              </button>
              <button className="btn" onClick={() => setState({ dialog: 'start' })}>{t('Start session…')}</button>
            </>
          )}
          {status === 'starting' && <span className="status-pill">{t('Starting…')}</span>}
          {status === 'ending' && <span className="status-pill" role="status">{t('Saving…')}</span>}
          {(recording || status === 'paused') && (
            <>
              <RecPill recording={recording} />
              {recording ? <button className="btn" onClick={() => pauseSession()}>{t('Pause')}</button> : <button className="btn" onClick={() => resumeLive()}>{t('Resume')}</button>}
              <button className="btn danger" onClick={() => { if (confirm(t('End this session? The transcript is saved and the final summary will be generated.'))) void endSession(); }}>{t('End')}</button>
              {!viewingLive && <button className="btn link" onClick={() => activeSession && void openSession(activeSession.id)}>{t('Back to live')}</button>}
            </>
          )}
        </div>

        <SessionActions />

        <div className="right">
          <AsrBadge />
          <ProviderBadge />
          <nav className="nav-icons" aria-label={t('Main')}>
            <button className="icon-btn" onClick={() => setState({ dialog: 'profile' })} title={t('Knowledge profile')} aria-label={t('Knowledge profile')}><IconUser /></button>
            <button className="icon-btn" onClick={() => setState({ dialog: 'history' })} title={t('Session history')} aria-label={t('Session history')}><IconClock /></button>
            <button className="icon-btn" onClick={() => setState({ dialog: 'settings' })} title={t('Settings')} aria-label={t('Settings')}><IconGear /></button>
          </nav>
        </div>
      </div>
    </header>
  );
}

/** Compact view's only chrome: the way back. In Chumi.app a slim top bar stays, because it is also the window's title bar
 *  (window buttons, dragging), and shows whether a session is recording. In a browser the button floats in a corner. */
export function CompactBar() {
  const status = useStore((s) => s.live?.status);
  const platform = useStore((s) => s.platform);
  const label = t('Exit compact view ({key})', { key: compactShortcutLabel(platform) });
  const exit = (floating: boolean) => <button className={`icon-btn compact-exit ${floating ? 'floating' : ''}`} onClick={() => setCompact(false)} title={label} aria-label={label}><IconExpand /></button>;
  if (!inMacShell()) return exit(true);
  return (
    <header className="topbar compact">
      {(status === 'recording' || status === 'paused') && <RecPill recording={status === 'recording'} />}
      {exit(false)}
    </header>
  );
}

/** Catch-up and handoff for the open session, so the assistant column is left to questions and answers.
 *  Rendered in the header next to the recording controls and in the toolbar; CSS shows the toolbar copy only when the header is too narrow. */
function SessionActions({ sep }: { sep?: boolean }) {
  const data = useStore((s) => s.data);
  const scope = useStore((s) => s.catchupScope);
  if (!data) return null;
  return (
    <div className="session-actions">
      <button className="btn small catchup" onClick={() => catchup(scope)} disabled={!data.segments.length}>{t('Catch me up')}</button>
      <div className="seg-control small" role="group" aria-label={t('Catch-up scope')}>
        {([['2m', msg('2 min'), msg('The last 2 minutes')], ['5m', msg('5 min'), msg('The last 5 minutes')], ['all', msg('So far'), msg('The whole session so far')]] as const).map(([k, l, tip]) => <button key={k} className={scope === k ? 'on' : ''} title={t(tip)} onClick={() => setState({ catchupScope: k })}>{t(l)}</button>)}
      </div>
      <HandoffButton />
      {sep && <span className="toolbar-sep" aria-hidden="true" />}
    </div>
  );
}

/** Tier 2 (session view): audio levels, window capture, and the assistance controls. */
export function SessionToolbar({ hidden = false }: { hidden?: boolean }) {
  const live = useStore((s) => s.live);
  const data = useStore((s) => s.data);
  const settings = useStore((s) => s.settings);
  const profile = useStore((s) => s.profile);
  const platform = useStore((s) => s.platform);
  if (!data || !settings) return null;
  const status = live?.status ?? 'idle';
  const isLive = live?.session?.id === data.session.id && (status === 'recording' || status === 'paused');
  // While a session is starting or ending its audio is still being written; the player waits until it is saved.
  const active = live?.session?.id === data.session.id && status !== 'idle';
  const src = live?.source ?? settings.audio.source;
  const ended = data.session.status === 'ended' || data.session.status === 'interrupted';
  const saved = `${t('Saved session')} · ${fmtDate(data.session.started_at ?? data.session.created_at)} · ${fmtT(data.session.duration_ms)}${data.session.status === 'interrupted' ? ` · ${t('recording was interrupted (see gap markers)')}` : ''}`;
  const canSummarize = live?.session?.id !== data.session.id && ended && data.segments.length > 0 && !data.outputs.some((o) => o.kind === 'final_summary' && o.status !== 'error');
  return (
    <div className="toolbar" hidden={hidden}>
      <div className={`toolbar-left ${!isLive && !data.hasAudio ? 'text-only' : ''}`}>
        {isLive ? (
          <>
            <span className="source-label">{sourceLabel(src)}</span>
            {(src === 'mic' || src === 'both') && <Meter label={t('Mic')} source="mic" />}
            {(src === 'system' || src === 'both') && <Meter label={t('Computer')} source="system" />}
            {src === 'file' && <Meter label={t('File')} source="file" />}
            {!!data.session.record_audio && <span className="tag tag-muted audio-tag" title={t('This meeting’s audio is saved on this computer, so you can play it back and export it after it ends.')}><IconWave width={11} height={11} /> {t('Saving audio')}</span>}
            <button className={`btn small ${live?.screen ? 'win-on' : ''}`} onClick={() => setState({ dialog: 'window' })} title={t('Capture a window (slides, shared screen, video)')}>
              <IconWindow width={14} height={14} /> {live?.screen ? `${live.screen.app}${live.screen.frames ? ` · ${live.screen.frames}` : ''}` : t('Capture window')}
            </button>
          </>
        ) : !active && (
          <>
            <span className="saved-info" title={saved}>{saved}</span>
            {data.hasAudio && <AudioPlayer key={data.session.id} sessionId={data.session.id} />}
          </>
        )}
      </div>
      <div className="toolbar-right">
        <SessionActions sep />
        {canSummarize && <><button className="btn small" onClick={() => summarize()}>{t('Generate final summary')}</button><span className="toolbar-sep" aria-hidden="true" /></>}
        <label className="switch" title={t('Automatically show short background cards for unfamiliar concepts')}>
          <input type="checkbox" checked={settings.assist.autoExplain} onChange={(e) => saveSettings({ assist: { autoExplain: e.target.checked } })} />
          <span className="slider" /> <IconSpark width={13} height={13} /> {t('Auto-explain')}
        </label>
        <div className="seg-control" role="group" aria-label={t('Default explanation depth')} title={t('Default explanation depth (does not change your profile)')}>
          {(['quick', 'standard', 'deep'] as Depth[]).map((d) => (
            <button key={d} className={settings.assist.defaultDepth === d ? 'on' : ''} onClick={() => saveSettings({ assist: { defaultDepth: d } })}>{t(DEPTH_LABEL[d])}</button>
          ))}
        </div>
        {profile && (
          <div className="seg-control" role="group" aria-label={t('AI answer language')} title={t('Language of AI explanations, catch-ups and summaries')}>
            {([['Simplified Chinese', '中文'], ['English', 'EN']] as const).map(([v, l]) => (
              <button key={v} className={profile.explanationLanguage === v ? 'on' : ''} onClick={() => profile.explanationLanguage !== v && void saveProfile({ ...profile, explanationLanguage: v }, true)}>{l}</button>
            ))}
          </div>
        )}
        <span className="toolbar-sep" aria-hidden="true" />
        <button className="icon-btn compact-enter" onClick={() => setCompact(true)} title={t('Compact view: only the transcript and the assistant ({key})', { key: compactShortcutLabel(platform) })} aria-label={t('Compact view')}><IconCompact /></button>
      </div>
    </div>
  );
}
