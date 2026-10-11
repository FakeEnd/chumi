import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FrameRow, Store, SessionRow, SegmentRow } from '../db.ts';
import { AUDIO_DIR } from '../paths.ts';
import { fmtT, log, now, similarity, uid } from '../util.ts';
import { FileCapture, HelperCapture, type AudioInput, type SourceName } from '../audio/capture.ts';
import { Segmenter, type Utterance } from '../audio/vad.ts';
import { Transcriber, type FinalPiece } from '../asr/transcriber.ts';
import type { WhisperServer } from '../asr/whisper.ts';
import type { Assistant, Broadcast } from '../ai/assistant.ts';
import type { AudioSourceMode, SessionType } from '../settings.ts';
import { WavWriter } from './wavwriter.ts';
import { ScreenWatcher } from '../screen/watcher.ts';

export type LiveStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'ending';

interface Run {
  index: number;
  input: AudioInput;
  offsetMs: number;            // session-time of the input clock's zero
  segmenters: Map<SourceName, Segmenter>;
  writers: Map<SourceName, WavWriter>;
  restarts: number;
}

export interface StartOptions { title: string; type: SessionType; source: AudioSourceMode | 'file'; filePath?: string; speed?: number; window?: { id: number; title?: string; app?: string } | null }

/**
 * Owns the live session: audio input → per-source segmenter → transcriber → persisted segments.
 * Transcription never waits on the AI provider; AI work is only *triggered* from here.
 */
export class SessionManager {
  private store: Store;
  private whisper: WhisperServer;
  private assistant: Assistant;
  private broadcast: Broadcast;
  status: LiveStatus = 'idle';
  session: SessionRow | null = null;
  source: AudioSourceMode | 'file' = 'mic';
  private run: Run | null = null;
  private runCount = 0;
  private transcriber: Transcriber;
  private heartbeat: NodeJS.Timeout | null = null;
  private levelAt = new Map<string, number>();
  private pendingMic: Array<{ piece: FinalPiece; due: number; t0: number; t1: number }> = [];
  private dedupeTimer: NodeJS.Timeout | null = null;
  private fileOpts: { path: string; speed: number; posSec: number } | null = null;
  partials = new Map<SourceName, { uttId: number; t: number; text: string }>();
  warnings: Array<{ code: string; message: string; at: number }> = [];
  lastLevels: Record<string, { rms: number; peak: number; at: number }> = {};
  droppedDuplicates = 0;
  screen: ScreenWatcher | null = null;

  constructor(store: Store, whisper: WhisperServer, assistant: Assistant, broadcast: Broadcast) {
    this.store = store; this.whisper = whisper; this.assistant = assistant; this.broadcast = broadcast;
    this.transcriber = this.makeTranscriber();
  }

  private makeTranscriber(): Transcriber {
    const t = new Transcriber(this.whisper, () => {
      const s = this.store.getSettings();
      const sessionTerms = this.session ? this.store.explainedTerms(this.session.id).map((x) => x.term) : [];
      return { language: s.asr.language, glossary: [...s.asr.glossary, ...sessionTerms], chineseScript: s.asr.chineseScript };
    });
    t.on('partial', (source, uttId, startSec, text) => {
      if (!this.session || this.status !== 'recording') return;
      const tt = startSec * 1000;
      this.partials.set(source, { uttId, t: tt, text });
      this.broadcast('partial', { sessionId: this.session.id, source, uttId, t: tt, text });
    });
    t.on('partialClear', (source, uttId) => {
      const p = this.partials.get(source);
      if (p && p.uttId <= uttId) this.partials.delete(source);
      this.broadcast('partial-clear', { sessionId: this.session?.id, source, uttId });
    });
    t.on('final', (pieces) => this.onFinal(pieces));
    t.on('error', (m) => this.notice('warning', 'asr_error', m));
    return t;
  }

  /** Mark sessions left open by a crash/quit as interrupted, with a recorded gap marker. */
  recoverOnBoot(): void {
    for (const s of this.store.openSessions()) {
      const lastT = Math.max(this.store.lastSegment(s.id)?.t_end ?? 0, s.duration_ms, (s.last_activity_at ?? s.started_at ?? s.created_at) - (s.started_at ?? s.created_at));
      this.store.updateSession(s.id, { status: 'interrupted', duration_ms: Math.max(s.duration_ms, lastT) });
      this.store.addTimeline(s.id, lastT, 'interrupted', 'The app stopped while recording. Transcript saved up to this point.');
      log('session', `marked ${s.id} interrupted at ${fmtT(lastT)}`);
    }
  }

  nowT(): number {
    if (!this.session) return 0;
    if (this.run?.input instanceof FileCapture) return this.run.offsetMs + this.run.input.positionSec * 1000;
    if (this.status === 'paused' || this.status === 'idle') return this.store.getSession(this.session.id)?.duration_ms ?? 0;
    return now() - (this.session.started_at ?? this.session.created_at);
  }

  state(): Record<string, unknown> {
    return {
      status: this.status,
      session: this.session ? this.store.getSession(this.session.id) : null,
      source: this.source,
      nowT: this.nowT(),
      serverTime: now(),
      levels: this.lastLevels,
      partials: Object.fromEntries(this.partials),
      warnings: this.warnings.slice(-5),
      asr: { state: this.whisper.state, message: this.whisper.message, latencyMs: this.whisper.lastLatencyMs, backlogSec: Math.round(this.transcriber.backlogSec), pending: this.transcriber.pendingFinals },
      file: this.fileOpts,
      droppedDuplicates: this.droppedDuplicates,
      screen: this.screen && this.screen.status !== 'stopped' ? { windowId: this.screen.windowId, title: this.screen.title, app: this.screen.app, status: this.screen.status, frames: this.screen.frameCount, lastCaptureAt: this.screen.lastCaptureAt } : null,
    };
  }

  private emitState(): void { this.broadcast('live', this.state()); }

  private notice(level: 'info' | 'warning' | 'error', code: string, message: string): void {
    this.warnings.push({ code, message, at: now() });
    if (this.warnings.length > 20) this.warnings.shift();
    this.broadcast('notice', { level, code, message });
  }

  // ------------------------------------------------------------------ lifecycle
  async start(o: StartOptions): Promise<SessionRow> {
    if (this.status !== 'idle') throw new Error('A session is already active. End it first.');
    this.status = 'starting'; this.emitState();
    try {
      await this.whisper.ensure();
    } catch (e) {
      this.status = 'idle'; this.emitState();
      throw new Error(`Speech recognition is not ready: ${(e as Error).message}`);
    }
    const id = uid('s_');
    this.session = this.store.createSession({ id, title: o.title || `Session ${new Date().toLocaleString()}`, type: o.type, audio_source: o.source });
    this.source = o.source;
    this.fileOpts = o.source === 'file' && o.filePath ? { path: o.filePath, speed: o.speed ?? 1, posSec: 0 } : null;
    this.warnings = []; this.partials.clear(); this.droppedDuplicates = 0;
    this.transcriber.reset();
    this.store.addTimeline(id, 0, 'start', o.source);
    try {
      await this.beginRun(0);
    } catch (e) {
      this.store.addTimeline(id, 0, 'error', (e as Error).message);
      this.store.updateSession(id, { status: 'ended', ended_at: now() });
      this.session = null; this.status = 'idle'; this.emitState();
      throw e;
    }
    this.status = 'recording';
    this.startHeartbeat();
    if (o.window) this.setWindow(o.window);
    this.emitState();
    return this.store.getSession(id)!;
  }

  private async beginRun(offsetMs: number): Promise<void> {
    const s = this.store.getSettings();
    let input: AudioInput;
    if (this.source === 'file') {
      if (!this.fileOpts) throw new Error('No audio file given.');
      input = new FileCapture(this.fileOpts.path, this.fileOpts.speed, this.fileOpts.posSec);
    } else {
      input = new HelperCapture({ source: this.source, micDeviceUid: s.audio.micDeviceUid, aec: s.audio.aec });
    }
    const run: Run = { index: ++this.runCount, input, offsetMs, segmenters: new Map(), writers: new Map(), restarts: 0 };
    const seg = (src: SourceName): Segmenter => {
      let sg = run.segmenters.get(src);
      if (!sg) {
        sg = new Segmenter();
        // Convert the input clock to session time now, so late results can't pick up a later run's offset.
        const toSession = (u: Utterance): Utterance => ({ ...u, startSec: u.startSec + run.offsetMs / 1000, endSec: u.endSec + run.offsetMs / 1000 });
        sg.on('progress', (u) => this.transcriber.pushProgress(src, toSession(u)));
        sg.on('final', (u) => this.transcriber.pushFinal(src, toSession(u)));
        sg.on('pause', () => { if (this.session) this.assistant.onActivity(this.session.id, 'pause'); });
        run.segmenters.set(src, sg);
      }
      return sg;
    };
    input.on('frames', (src, ts, samples) => {
      if (this.status !== 'recording' && this.status !== 'starting') return;
      try {
        seg(src).push(ts, samples);
      } catch (e) {
        // Never let a segmentation bug stop the recording: drop this segmenter and start a fresh one.
        log('session', `segmenter error (${src}): ${(e as Error).stack ?? e}`);
        run.segmenters.delete(src);
        this.notice('warning', 'segmenter_reset', 'A transcription hiccup occurred; a fraction of a second of audio may be missing. Recording continues.');
      }
      if (s.audio.saveRawAudio && this.session) {
        let w = run.writers.get(src);
        if (!w) {
          const dir = join(AUDIO_DIR, this.session.id); mkdirSync(dir, { recursive: true });
          w = new WavWriter(join(dir, `run${run.index}-${src}.wav`));
          run.writers.set(src, w);
        }
        w.write(samples);
      }
    });
    input.on('level', (src, rms, peak) => {
      this.lastLevels[src] = { rms, peak, at: now() };
      const last = this.levelAt.get(src) ?? 0;
      if (now() - last >= 120) { this.levelAt.set(src, now()); this.broadcast('level', { source: src, rms, peak }); }
    });
    input.on('helper', (ev) => {
      if (ev.type === 'error') this.notice('error', String(ev.code ?? 'capture_error'), String(ev.message ?? 'Audio capture error'));
      else if (ev.type === 'warning') this.notice('warning', String(ev.code ?? 'capture_warning'), String(ev.message ?? ''));
      else if (ev.type === 'device_changed') this.notice('info', 'device_changed', `Audio ${ev.kind} device changed${ev.name ? ` to ${ev.name}` : ''}.`);
      else if (ev.type === 'ready') { this.broadcast('capture', ev); if (Array.isArray(ev.pending) && ev.pending.length) this.notice('warning', 'system_permission_pending', `Waiting for macOS permission for: ${ev.pending.join(', ')}. Look for a permission dialog and allow it.`); }
      else if (ev.type === 'source_started') this.notice('info', 'source_started', `${ev.source === 'system' ? 'Computer audio' : 'Microphone'} capture started.`);
    });
    input.on('exit', (_code, reason) => {
      if (this.run !== run) return;
      if (input instanceof FileCapture && reason === 'file finished') {
        this.notice('info', 'file_finished', 'The audio file finished playing. End the session to generate the summary.');
        this.fileOpts && (this.fileOpts.posSec = input.positionSec);
        return;
      }
      if (this.status === 'recording' && reason !== 'stopped') {
        const t = this.nowT();
        this.notice('error', 'capture_stopped', `Audio capture stopped unexpectedly (${reason}). Trying to restart…`);
        if (this.session) this.store.addTimeline(this.session.id, t, 'gap', `Audio capture stopped: ${reason}`);
        if (run.restarts++ < 3) setTimeout(() => { if (this.run === run && this.status === 'recording') void run.input.start().catch((e) => this.notice('error', 'capture_restart_failed', (e as Error).message)); }, 1500);
      }
    });
    this.run = run;
    await input.start();
  }

  /** Start, switch or stop window capture (slides / shared screen) for the active session. */
  setWindow(win: { id: number; title?: string; app?: string } | null): void {
    this.screen?.stop();
    this.screen = null;
    if (win && this.session) {
      const w = new ScreenWatcher(this.store, { sessionId: this.session.id, windowId: win.id, title: win.title, app: win.app, nowT: () => this.nowT(), intervalSec: this.store.getSettings().screen.intervalSec });
      w.on('frame', (f) => this.broadcast('frame', publicFrame(f)));
      w.on('notice', (level, code, msg) => this.notice(level, code, msg));
      w.on('state', () => this.emitState());
      this.screen = w;
      if (this.status === 'paused') { w.start(); w.pause(); } else w.start();
      this.store.addTimeline(this.session.id, this.nowT(), 'window', `Capturing window: ${win.app ?? ''}${win.title ? ` — ${win.title}` : ''}`);
    }
    this.emitState();
  }

  /** Frames to show the AI, and an on-demand capture of "now" when a window is being captured. */
  framesFor(sessionId: string, fromT: number, toT: number): FrameRow[] { return this.store.frames(sessionId, fromT, toT); }
  async snapshotNow(sessionId: string): Promise<FrameRow | null> {
    if (!this.screen || this.session?.id !== sessionId || this.status !== 'recording') return null;
    return this.screen.snapshot();
  }

  private async endRun(): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (run.input instanceof FileCapture && this.fileOpts) this.fileOpts.posSec = run.input.positionSec;
    await run.input.stop();
    for (const sg of run.segmenters.values()) sg.flush();
    for (const w of run.writers.values()) w.close();
    this.partials.clear();
  }

  /** App is quitting: keep everything captured so far and mark the session interrupted (resumable later). */
  async suspendForShutdown(): Promise<void> {
    if (!this.session || (this.status !== 'recording' && this.status !== 'paused')) return;
    const id = this.session.id;
    const t = this.nowT();
    this.screen?.stop(); this.screen = null;
    await this.endRun();
    await this.transcriber.drain(4000);
    this.flushMic(true);
    const lastT = Math.max(t, this.store.lastSegment(id)?.t_end ?? 0);
    this.store.updateSession(id, { status: 'interrupted', duration_ms: Math.round(lastT) });
    this.store.addTimeline(id, lastT, 'interrupted', 'The app was closed while recording. Transcript saved up to this point.');
    this.status = 'idle';
  }

  async pause(): Promise<void> {
    if (this.status !== 'recording' || !this.session) throw new Error('Not recording.');
    const t = this.nowT();
    await this.endRun();
    this.store.touchSession(this.session.id, t);
    this.store.updateSession(this.session.id, { status: 'paused', duration_ms: Math.round(t) });
    this.store.addTimeline(this.session.id, t, 'pause');
    this.screen?.pause();
    this.status = 'paused';
    this.emitState();
  }

  async resume(): Promise<void> {
    if (this.status !== 'paused' || !this.session) throw new Error('Not paused.');
    const s = this.store.getSession(this.session.id)!;
    const lastT = Math.max(s.duration_ms, this.store.lastSegment(s.id)?.t_end ?? 0);
    const wallOffset = now() - (s.started_at ?? s.created_at);
    const offset = this.source === 'file' ? lastT + 500 - (this.fileOpts?.posSec ?? 0) * 1000 : Math.max(wallOffset, lastT + 500);
    await this.beginRun(offset);
    this.store.updateSession(s.id, { status: 'recording' });
    this.store.addTimeline(s.id, this.source === 'file' ? lastT + 500 : offset, 'resume');
    this.status = 'recording';
    this.screen?.resume();
    this.emitState();
  }

  /** Continue recording into an interrupted (or ended) session after an app restart; the gap is recorded. */
  async resumeSession(sessionId: string, source: AudioSourceMode | 'file', file?: { path: string; speed: number }): Promise<void> {
    if (this.status !== 'idle') throw new Error('Another session is active.');
    const s = this.store.getSession(sessionId);
    if (!s) throw new Error('Session not found');
    await this.whisper.ensure();
    this.session = s; this.source = source; this.fileOpts = file ? { path: file.path, speed: file.speed, posSec: 0 } : null; this.warnings = []; this.transcriber.reset();
    const lastT = Math.max(s.duration_ms, this.store.lastSegment(s.id)?.t_end ?? 0);
    const offset = Math.max(now() - (s.started_at ?? s.created_at), lastT + 1000);
    this.store.addTimeline(s.id, lastT, 'gap', `Not recorded from ${fmtT(lastT)} to ${fmtT(offset)} (${s.status === 'interrupted' ? 'app restarted' : 'session resumed'}).`);
    this.store.addTimeline(s.id, offset, 'resume', source);
    this.store.updateSession(s.id, { status: 'recording', ended_at: null });
    await this.beginRun(offset);
    this.status = 'recording';
    this.startHeartbeat();
    this.emitState();
  }

  async end(): Promise<{ sessionId: string; summaryId: string | null }> {
    if (!this.session || (this.status !== 'recording' && this.status !== 'paused')) throw new Error('No active session.');
    const id = this.session.id;
    const t = this.nowT();
    this.status = 'ending'; this.emitState();
    this.screen?.stop(); this.screen = null;
    await this.endRun();
    await this.transcriber.drain(90_000);
    this.flushMic(true);
    const lastT = Math.max(t, this.store.lastSegment(id)?.t_end ?? 0);
    this.store.updateSession(id, { status: 'ended', ended_at: now(), duration_ms: Math.round(lastT) });
    this.store.addTimeline(id, lastT, 'stop');
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.run = null;
    this.status = 'idle';
    const summaryId = this.store.segments(id).length ? this.assistant.summary(id) : null;
    this.session = null;
    this.fileOpts = null;
    this.emitState();
    this.broadcast('session-ended', { sessionId: id, summaryId });
    return { sessionId: id, summaryId };
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.session && this.status === 'recording') {
        this.store.touchSession(this.session.id, this.nowT());
        this.broadcast('tick', { nowT: this.nowT(), asr: { backlogSec: Math.round(this.transcriber.backlogSec), latencyMs: this.whisper.lastLatencyMs, state: this.whisper.state } });
      }
    }, 2000);
  }

  // ------------------------------------------------------------------ transcript commit + duplicate suppression
  private onFinal(pieces: FinalPiece[]): void {
    if (!this.session) return;
    for (const p of pieces) {
      const t0 = Math.round(p.startSec * 1000);
      const t1 = Math.round(p.endSec * 1000);
      if (this.source === 'both' && p.source === 'mic') {
        // Hold mic text briefly so it can be compared with computer audio covering the same moment.
        this.pendingMic.push({ piece: p, due: now() + 4000, t0, t1 });
        this.dedupeTimer ??= setInterval(() => this.flushMic(false), 1000);
        continue;
      }
      this.commit(p, t0, t1);
    }
  }

  private flushMic(all: boolean): void {
    const ready = this.pendingMic.filter((m) => all || m.due <= now());
    this.pendingMic = this.pendingMic.filter((m) => !ready.includes(m));
    for (const m of ready) {
      const overlapping = this.session ? this.store.segments(this.session.id, m.t0 - 3000, m.t1 + 3000).filter((s) => s.source === 'system') : [];
      const dup = overlapping.some((s) => similarity(s.text, m.piece.text) > 0.45);
      if (dup) { this.droppedDuplicates++; continue; }
      this.commit(m.piece, m.t0, m.t1);
    }
    if (!this.pendingMic.length && this.dedupeTimer) { clearInterval(this.dedupeTimer); this.dedupeTimer = null; }
  }

  private commit(p: FinalPiece, t0: number, t1: number): void {
    if (!this.session) return;
    const row: SegmentRow = this.store.addSegment({ session_id: this.session.id, t_start: t0, t_end: Math.max(t1, t0 + 200), text: p.text, lang: p.lang, source: p.source, run: this.run?.index ?? 0 });
    this.store.touchSession(this.session.id, t1);
    this.broadcast('segment', row);
    this.assistant.onActivity(this.session.id, 'segment');
  }
}

export function publicFrame(f: FrameRow): Omit<FrameRow, 'path'> {
  const { path: _p, ...rest } = f;
  return rest;
}
