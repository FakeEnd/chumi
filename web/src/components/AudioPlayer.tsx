import { useEffect, useRef, useState } from 'react';
import { getState, setState, useStore } from '../store.ts';
import { api } from '../api.ts';
import { exportAudio } from '../actions.ts';
import { fmtT } from '../util.ts';
import { t } from '../i18n.ts';
import { toPlayback, toSession, type PlaybackInfo } from '../../../shared/recording.ts';
import type { Segment } from '../types.ts';
import { IconPause, IconPlay } from './icons.tsx';

/** Set while a saved session's player is shown: the transcript's play buttons start playback here. */
let control: { playFrom(t: number): void } | null = null;
export const playFrom = (t: number): void => control?.playFrom(t);

const SPEEDS = [1, 1.25, 1.5, 2];

/** The line being heard: the last one that started at or before t, unless it ended well before. */
function lineAt(segments: Segment[], t: number): number | null {
  let lo = 0, hi = segments.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (segments[mid].t_start <= t) lo = mid + 1; else hi = mid; }
  const seg = segments[lo - 1];
  return seg && t <= seg.t_end + 1500 ? seg.id : null;
}

/** Plays a saved session's recording. Times are session times, the same as the transcript's. */
export function AudioPlayer({ sessionId }: { sessionId: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0); // position in the file, ms
  const [speed, setSpeed] = useState(1);
  const [exporting, setExporting] = useState(false);
  const focus = useStore((s) => s.focus);

  useEffect(() => {
    let alive = true;
    api<PlaybackInfo>(`/api/sessions/${sessionId}/audio/info`).then((i) => { if (alive) setInfo(i); }).catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; setState({ playingSeg: null }); };
  }, [sessionId]);

  const seek = (ms: number, play = false) => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = ms / 1000;
    setPos(ms);
    if (play) void el.play().catch(() => {});
  };

  useEffect(() => {
    if (!info) return;
    control = { playFrom: (t) => seek(toPlayback(info.regions, t), true) };
    return () => { control = null; };
  }, [info]);

  // Opening a cited passage moves the player there too; it keeps playing or stays paused.
  useEffect(() => { if (info && focus) seek(toPlayback(info.regions, focus.t)); }, [focus?.nonce, info]);

  useEffect(() => { if (audio.current) audio.current.playbackRate = audio.current.defaultPlaybackRate = speed; }, [speed, info]);

  const onTime = () => {
    const ms = (audio.current?.currentTime ?? 0) * 1000;
    setPos(ms);
    const id = info ? lineAt(getState().data?.segments ?? [], toSession(info.regions, ms)) : null;
    if (getState().playingSeg !== id) setState({ playingSeg: id });
  };

  if (error) return <span className="muted small" title={error}>{t('The audio recording is unavailable.')}</span>;
  if (!info) return <span className="muted small">{t('Loading audio…')}</span>;
  const toggle = () => { const el = audio.current; if (el) { if (el.paused) void el.play().catch(() => {}); else el.pause(); } };
  return (
    <div className="audio-player" role="group" aria-label={t('Recorded audio')}>
      <audio ref={audio} src={`/api/sessions/${sessionId}/audio?v=${info.version}`} preload="metadata" onTimeUpdate={onTime}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => setError(t('The recording could not be played.'))} />
      <button className="btn small play-btn" onClick={toggle} title={playing ? t('Pause audio') : t('Play audio')} aria-label={playing ? t('Pause audio') : t('Play audio')}>
        {playing ? <IconPause width={13} height={13} /> : <IconPlay width={13} height={13} />}
      </button>
      <button className="btn small" onClick={() => seek(Math.max(0, pos - 10_000))} title={t('Back 10 seconds')}>−10s</button>
      <input className="audio-seek" type="range" min={0} max={Math.round(info.duration_ms)} step={100} value={Math.round(pos)}
        onChange={(e) => seek(Number(e.target.value))} aria-label={t('Playback position')} aria-valuetext={fmtT(toSession(info.regions, pos))} />
      <span className="audio-time small">{fmtT(toSession(info.regions, pos))} / {fmtT(info.regions.at(-1)?.end_ms ?? 0)}</span>
      <select className="audio-speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label={t('Playback speed')}>
        {SPEEDS.map((x) => <option key={x} value={x}>{x}×</option>)}
      </select>
      <button className="btn small" disabled={exporting} onClick={() => { setExporting(true); void exportAudio(sessionId).finally(() => setExporting(false)); }}
        title={t('Download the recording as one audio file')}>{exporting ? t('Preparing…') : t('Export audio')}</button>
    </div>
  );
}
