import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIO_DIR, FRAMES_DIR } from '../paths.ts';
import { sessionTitle } from '../i18n.ts';
import type { FrameRow, Store, SessionRow, SegmentRow } from '../db.ts';
import { fmtT, log, now, uid } from '../util.ts';
import { FileCapture, HelperCapture, type AudioInput, type SourceName } from '../audio/capture.ts';
import { Segmenter, type Utterance } from '../audio/vad.ts';
import { Transcriber, type FinalPiece } from '../asr/transcriber.ts';
import { isMicEcho } from './echo.ts';
import { languagePrior } from '../asr/language.ts';
import { preferredLanguage } from '../platform.ts';
import type { SpeechService } from '../asr/speech.ts';
import { publicOutput, type Assistant, type Broadcast } from '../ai/assistant.ts';
import type { AudioSourceMode, SessionType } from '../settings.ts';
import { ScreenWatcher } from '../screen/watcher.ts';
import { SpeakerRecorder, recoverOpenTakes } from '../speakers/audio.ts';

export type LiveStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'ending';

interface Run {
  index: number;
  input: AudioInput;
  capturedToMs: number;
  gapUntilMs: number;
  sourceEnds: Map<SourceName, number>;
  offsetMs: number;            // session-time of the input clock's zero
  segmenters: Map<SourceName, Segmenter>;
  /** Restarts since the input last ran for STABLE_RUN_MS; the pending restart, if one is scheduled. */
  restarts: number;
  startedAt: number;
  restartTimer: NodeJS.Timeout | null;
  lastError: { code: string; message: string } | null;
  /** Timed audio: the session's recording (retained) or a temporary copy for speaker analysis. */
  recorder: SpeakerRecorder | null;
}

/** A capture helper that keeps failing is restarted with backoff, then the session is paused instead of silently not recording. */
const RESTART_LIMIT = 3;
const RESTART_BASE_MS = 1500;
const STABLE_RUN_MS = 60_000;
const PERMANENT_CAPTURE_ERRORS = new Set(['mic_permission_denied', 'no_input_device', 'system_tap_unsupported']);

export interface StartOptions { title: string; type: SessionType; source: AudioSourceMode | 'file'; filePath?: string; speed?: number; window?: { id: number; title?: string; app?: string } | null; projectId?: string | null; recordAudio?: boolean }

/**
 * Owns the live session: audio input → per-source segmenter → transcriber → persisted segments.
 * Transcription never waits on the AI provider; AI work is only *triggered* from here.
 */
/** The system's preferred language, read once (it runs `defaults read` on macOS). */
let systemLanguage: string | undefined;

export class SessionManager {
  private store: Store;
  private speech: SpeechService;
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
  captureHealth: Record<string, { state: 'ok' | 'silent' | 'restarting' | 'failed'; code?: string; message?: string; vars?: Record<string, string | number> }> = {};
  droppedDuplicates = 0;
  screen: ScreenWatcher | null = null;
  /** Optional local processing barrier. It runs after recording ends, before its automatic summary. */
  beforeSummary: ((sessionId: string) => Promise<void> | null) | null = null;
  beforeResume: ((sessionId: string) => Promise<void>) | null = null;
  /** Runs once the session's status has been saved as ended. */
  onEnded: ((sessionId: string) => void) | null = null;
  private stopping = false;
  /** A token per deferred summary, so an old speaker analysis can't start a resumed session's summary. */
  private pendingSpeakerSummaries = new Map<string, symbol>();
  private transcriptionGaps = new Map<string, Array<{ id: number; start: number; end: number }>>();

  invalidateDeferredSummary(sessionId: string): void { this.pendingSpeakerSummaries.delete(sessionId); }

  constructor(store: Store, speech: SpeechService, assistant: Assistant, broadcast: Broadcast) {
    this.store = store; this.speech = speech; this.assistant = assistant; this.broadcast = broadcast;
    this.transcriber = this.makeTranscriber();
  }

  private makeTranscriber(): Transcriber {
    const t = new Transcriber(this.speech, () => {
      const s = this.store.getSettings();
      const sessionTerms = this.session ? this.store.explainedTerms(this.session.id).map((x) => x.term) : [];
      systemLanguage ??= preferredLanguage();
      const prior = languagePrior({ ui: s.ui.language, system: systemLanguage, explanation: this.store.getProfile().explanationLanguage });
      return { language: s.asr.language, glossary: [...s.asr.glossary, ...sessionTerms], chineseScript: s.asr.chineseScript, prior };
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
    t.on('settled', () => this.flushMic(false));
    t.on('retry', () => this.emitState());
    t.on('gap', (id, _source, start, end, reason) => {
      if (id && this.store.getSession(id)) this.transcriptionGap(id, start * 1000, end * 1000, reason);
    });
    return t;
  }

  private transcriptionGap(sessionId: string, start: number, end: number, reason: string): void {
    const gaps = this.transcriptionGaps.get(sessionId) ?? [];
    const adjacent = gaps.filter((g) => {
      const from = Math.min(end, g.end), to = Math.max(start, g.start);
      // Pauses between utterances do not split an outage; successfully transcribed speech does.
      return from >= to || !this.store.segments(sessionId, from, to).some((s) => s.t_start < to && s.t_end > from);
    });
    start = Math.min(start, ...adjacent.map((g) => g.start));
    end = Math.max(end, ...adjacent.map((g) => g.end));
    const detail = `Not transcribed (${fmtT(start)}–${fmtT(end)}): ${reason}. Any saved recording is still available.`;
    const row = adjacent.length ? this.store.mergeTimeline(adjacent.map((g) => g.id), start, detail) : this.store.addTimeline(sessionId, start, 'gap', detail);
    this.transcriptionGaps.set(sessionId, [...gaps.filter((g) => !adjacent.includes(g)), { id: row.id, start, end }]);
    this.broadcast('timeline', { ...row, replaces: adjacent.map((g) => g.id) });
    if (!adjacent.length) this.notice('warning', 'asr_gap', 'Some audio could not be transcribed. Gaps are marked in the timeline; any saved recording is still available.');
  }

  private markTranscriptStale(sessionId: string, reason: string): void {
    for (const output of this.store.outputs(sessionId, ['final_summary', 'handoff'])) {
      if (output.stale_reason === reason) continue;
      this.store.updateOutput(output.id, { stale_reason: reason });
      this.broadcast('ai', publicOutput({ ...output, stale_reason: reason }));
    }
  }

  /** Mark sessions left open by a crash/quit as interrupted, with a recorded gap marker; keep the audio captured so far. */
  recoverOnBoot(): void {
    for (const s of this.store.openSessions()) {
      // The iPhone owns these recordings. Restarting the Mac says nothing about its capture state.
      if (s.audio_source === 'mobile') continue;
      try { if (recoverOpenTakes(s.id)) log('session', `recovered the audio of ${s.id}`); }
      catch (e) { log('session', `could not recover the audio of ${s.id}: ${(e as Error).message}`); }
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
      captureHealth: this.captureHealth,
      partials: Object.fromEntries(this.partials),
      warnings: this.warnings.slice(-5),
      asr: { state: this.speech.state, message: this.speech.message, latencyMs: this.speech.lastLatencyMs, backlogSec: Math.round(this.transcriber.backlogSec), pending: this.transcriber.pendingFinals, retrying: this.transcriber.retrying },
      file: this.fileOpts,
      droppedDuplicates: this.droppedDuplicates,
      screen: this.screen && this.screen.status !== 'stopped' ? { windowId: this.screen.windowId, title: this.screen.title, app: this.screen.app, status: this.screen.status, frames: this.screen.frameCount, capped: this.screen.capped, lastCaptureAt: this.screen.lastCaptureAt } : null,
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
    if (this.stopping) throw new Error('The app is shutting down.');
    if (this.status !== 'idle') throw new Error('A session is already active. End it first.');
    this.status = 'starting'; this.emitState();
    try {
      await this.speech.ensure();
      if (this.stopping) throw new Error('The app is shutting down.');
    } catch (e) {
      this.status = 'idle'; this.emitState();
      throw new Error(`Speech recognition is not ready: ${(e as Error).message}`);
    }
    const id = uid('s_');
    this.session = this.store.createSession({ id, title: o.title?.trim() || sessionTitle(this.store.getSettings().ui.language), type: o.type, audio_source: o.source, record_audio: o.recordAudio ?? this.store.getSettings().audio.saveRawAudio });
    if (o.projectId) { this.store.assignSession(id, o.projectId); this.session = this.store.getSession(id)!; }
    this.source = o.source;
    this.fileOpts = o.source === 'file' && o.filePath ? { path: o.filePath, speed: o.speed ?? 1, posSec: 0 } : null;
    this.warnings = []; this.partials.clear(); this.droppedDuplicates = 0;
    this.transcriber.reset(id);
    this.store.addTimeline(id, 0, 'start', o.source);
    try {
      await this.beginRun(0);
      if (this.stopping) throw new Error('The app is shutting down.');
    } catch (e) {
      if (this.stopping) throw e;  // suspendForShutdown() saves the session as interrupted
      if ((this.run?.capturedToMs ?? 0) > 0) {
        this.store.addTimeline(id, 0, 'error', (e as Error).message);
        this.store.updateSession(id, { status: 'ended', ended_at: now(), duration_ms: Math.round(this.run!.capturedToMs) });
      } else {
        this.store.deleteSession(id);
        for (const dir of [join(AUDIO_DIR, id), join(FRAMES_DIR, id)]) {
          try { rmSync(dir, { recursive: true, force: true }); }
          catch (error) { log('session', `could not remove empty session files: ${(error as Error).message}`); }
        }
      }
      this.session = null; this.run = null; this.fileOpts = null; this.status = 'idle'; this.emitState();
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
    this.captureHealth = Object.fromEntries((this.source === 'both' ? ['mic', 'system'] : [this.source]).map((source) => [source, { state: 'ok' as const }]));
    let input: AudioInput;
    if (this.source === 'file') {
      if (!this.fileOpts) throw new Error('No audio file given.');
      input = new FileCapture(this.fileOpts.path, this.fileOpts.speed, this.fileOpts.posSec);
    } else {
      input = new HelperCapture({ source: this.source, micDeviceUid: s.audio.micDeviceUid, aec: s.audio.aec });
    }
    const retain = !!this.session?.record_audio;
    const run: Run = { index: ++this.runCount, input, offsetMs, capturedToMs: offsetMs, gapUntilMs: offsetMs, sourceEnds: new Map(), segmenters: new Map(), restarts: 0, startedAt: now(), restartTimer: null, lastError: null,
      recorder: (retain || s.asr.diarization) && this.session ? new SpeakerRecorder(this.session.id, retain) : null };
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
      if (this.run !== run) return;
      if (this.status !== 'recording' && this.status !== 'starting') return;
      const blockT = run.offsetMs + ts * 1000, previousEnd = run.sourceEnds.get(src);
      if (input instanceof HelperCapture && previousEnd !== undefined && blockT - previousEnd > 2000 && previousEnd >= run.gapUntilMs - 1000 && this.session) {
        run.gapUntilMs = blockT;
        this.broadcast('timeline', this.store.addTimeline(this.session.id, previousEnd, 'gap', `Audio capture gap from ${fmtT(previousEnd)} to ${fmtT(blockT)} (computer sleep or device interruption).`));
      }
      run.sourceEnds.set(src, run.offsetMs + (ts + samples.length / 16000) * 1000);
      run.capturedToMs = Math.max(run.capturedToMs, run.offsetMs + (ts + samples.length / 16000) * 1000);
      try {
        seg(src).push(ts, samples);
      } catch (e) {
        // Never let a segmentation bug stop the recording: drop this segmenter and start a fresh one.
        log('session', `segmenter error (${src}): ${(e as Error).stack ?? e}`);
        run.segmenters.delete(src);
        this.notice('warning', 'segmenter_reset', 'A transcription hiccup occurred; a fraction of a second of audio may be missing. Recording continues.');
      }
      if (run.recorder) {
        try { run.recorder.write(src, run.offsetMs + ts * 1000, samples); }
        catch (error) {
          try { run.recorder.close(); } catch { /* Preserve transcription even if storage is full. */ }
          run.recorder = null;
          this.notice('warning', 'audio_capture_failed', `Audio could not be saved: ${(error as Error).message}. Transcription continues.`);
        }
      }
    });
    input.on('level', (src, rms, peak) => {
      if (this.run !== run) return;
      if (this.status !== 'recording' && this.status !== 'starting') return;
      this.lastLevels[src] = { rms, peak, at: now() };
      const last = this.levelAt.get(src) ?? 0;
      if (now() - last >= 120) { this.levelAt.set(src, now()); this.broadcast('level', { source: src, rms, peak }); }
    });
    input.on('helper', (ev) => {
      if (this.run !== run) return;
      const code = String(ev.code ?? ''), source = code.startsWith('mic_') ? 'mic' : code.startsWith('system_') ? 'system' : null;
      if (source && (code === `${source}_silent` || code === `${source}_silent_cleared`)) {
        this.captureHealth[source] = code.endsWith('_cleared') ? { state: 'ok' } : { state: 'silent', code, message: String(ev.message ?? ''), vars: ev.vars as Record<string, string | number> | undefined };
        if (code === 'system_silent' && this.source === 'both') this.notice('warning', code, String(ev.message ?? ''));
        this.emitState();
        return;
      }
      if (ev.type === 'error') { if (source) this.captureHealth[source] = { state: 'failed', code, message: String(ev.message ?? '') }; run.lastError = { code: String(ev.code ?? 'capture_error'), message: String(ev.message ?? 'Audio capture error') }; this.notice('error', run.lastError.code, run.lastError.message); }
      else if (ev.type === 'warning') this.notice('warning', String(ev.code ?? 'capture_warning'), String(ev.message ?? ''));
      else if (ev.type === 'device_changed') this.notice('info', 'device_changed', `Audio ${ev.kind} device changed${ev.name ? ` to ${ev.name}` : ''}.`);
      else if (ev.type === 'ready') {
        const restarted = Object.values(this.captureHealth).some((health) => health.state === 'restarting') || this.warnings.some((w) => w.code === 'capture_stopped' || w.code === 'capture_gave_up');
        for (const src of Array.isArray(ev.sources) ? ev.sources : Object.keys(this.captureHealth)) this.captureHealth[String(src)] = { state: 'ok' };
        if (restarted) {
          this.warnings = this.warnings.filter((w) => w.code !== 'capture_stopped' && w.code !== 'capture_gave_up');
          this.notice('info', 'capture_restarted', 'Audio capture restarted. Recording continues.');
        }
        run.lastError = null; this.broadcast('capture', ev); if (Array.isArray(ev.pending) && ev.pending.length) this.notice('warning', 'system_permission_pending', `Waiting for macOS permission for: ${ev.pending.join(', ')}. Look for a permission dialog and allow it.`); }
      else if (ev.type === 'source_started') { this.captureHealth[String(ev.source)] = { state: 'ok' }; this.notice('info', 'source_started', `${ev.source === 'system' ? 'Computer audio' : 'Microphone'} capture started.`); }
      else return;
      this.emitState();
    });
    const captureFailed = (reason: string) => {
      // A helper that exits while restarting also rejects its start(): one failure, one restart.
      if (this.run !== run || this.status !== 'recording' || run.restartTimer) return;
      const t = this.nowT();
      if (run.lastError && PERMANENT_CAPTURE_ERRORS.has(run.lastError.code)) {
        if (this.session) this.broadcast('timeline', this.store.addTimeline(this.session.id, t, 'gap', `${run.lastError.message} Session paused.`));
        void this.captureGaveUp(run.lastError.message, true);
        return;
      }
      if (now() - run.startedAt >= STABLE_RUN_MS) run.restarts = 0; // It had been running fine: not a crash loop.
      const giveUp = run.restarts >= RESTART_LIMIT;
      for (const src of Object.keys(this.captureHealth)) this.captureHealth[src] = { state: giveUp ? 'failed' : 'restarting' };
      this.emitState();
      if (this.session) this.store.addTimeline(this.session.id, t, 'gap', `Audio capture stopped: ${reason}${giveUp ? `. It failed ${RESTART_LIMIT + 1} times in a row, so the session was paused.` : ''}`);
      if (giveUp) { void this.captureGaveUp(reason); return; }
      this.notice('error', 'capture_stopped', `Audio capture stopped unexpectedly (${reason}). Trying to restart…`);
      run.restartTimer = setTimeout(() => {
        run.restartTimer = null;
        if (this.run !== run || this.status !== 'recording') return;
        for (const sg of run.segmenters.values()) sg.flush();
        run.segmenters.clear(); run.sourceEnds.clear();
        run.offsetMs = this.nowT(); // A restarted helper starts its input clock at zero again.
        run.startedAt = now(); run.lastError = null;
        void run.input.start().catch((e) => captureFailed(`restart failed: ${(e as Error).message}`));
      }, RESTART_BASE_MS * 2 ** run.restarts++);
    };
    input.on('exit', (_code, reason) => {
      if (this.run !== run) return;
      if (input instanceof FileCapture && reason === 'file finished') {
        this.notice('info', 'file_finished', 'The audio file finished playing. End the session to generate the summary.');
        this.fileOpts && (this.fileOpts.posSec = input.positionSec);
        return;
      }
      if (reason !== 'stopped') captureFailed(reason);
    });
    this.run = run;
    try { await input.start(); }
    catch (error) { await this.endRun(); throw error; }
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

  /** Restarting did not help: keep everything captured so far and pause, so the session no longer claims to be recording. */
  private async captureGaveUp(reason: string, alreadyReported = false): Promise<void> {
    if (!alreadyReported) this.notice('error', 'capture_gave_up', `Audio capture keeps stopping (${reason}), so the session is paused. Everything captured so far is saved. Check the audio device, then resume.`);
    try { await this.pause(); }
    catch (e) { log('session', `could not pause after capture failed: ${(e as Error).message}`); }
  }

  private async endRun(): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (run.restartTimer) { clearTimeout(run.restartTimer); run.restartTimer = null; }
    if (run.input instanceof FileCapture && this.fileOpts) this.fileOpts.posSec = run.input.positionSec;
    await run.input.stop();
    for (const sg of run.segmenters.values()) sg.flush();
    try { run.recorder?.close(); }
    catch (error) { this.notice('warning', 'audio_capture_failed', `Audio could not be saved: ${(error as Error).message}`); }
    this.partials.clear();
  }

  /** App is quitting: keep everything captured so far and mark the session interrupted (resumable later). */
  async suspendForShutdown(): Promise<void> {
    this.stopping = true;
    this.pendingSpeakerSummaries.clear();
    // Also while starting or ending: an end() still waiting for transcription stops there (see end()).
    if (!this.session || this.status === 'idle') {
      this.flushMic(true);
      this.transcriber.stop();
      return;
    }
    const id = this.session.id;
    const t = this.nowT();
    this.status = 'ending';
    this.screen?.stop(); this.screen = null;
    await this.endRun();
    const complete = await this.transcriber.drain(4000);
    this.flushMic(true);
    const lastT = Math.max(t, this.store.lastSegment(id)?.t_end ?? 0);
    this.store.updateSession(id, { status: 'interrupted', duration_ms: Math.round(lastT) });
    this.store.addTimeline(id, lastT, 'interrupted', complete
      ? 'The app was closed while recording. Transcript saved up to this point.'
      : `The app was closed before transcription finished. Transcript saved up to this point; some audio has not been transcribed.${this.session.record_audio ? ' Any retained audio remains available.' : ' Audio recording was disabled for this session.'}`);
    this.transcriber.stop();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.status = 'idle';
  }

  async pause(): Promise<void> {
    if (this.status !== 'recording' || !this.session) throw new Error('Not recording.');
    const t = this.nowT();
    this.status = 'ending'; this.emitState();
    await this.endRun();
    if (this.stopping) return;
    this.store.touchSession(this.session.id, t);
    this.store.updateSession(this.session.id, { status: 'paused', duration_ms: Math.round(t) });
    this.store.addTimeline(this.session.id, t, 'pause');
    this.screen?.pause();
    this.lastLevels = {};
    this.status = 'paused';
    this.emitState();
  }

  async resume(): Promise<void> {
    if (this.stopping) throw new Error('The app is shutting down.');
    if (this.status !== 'paused' || !this.session) throw new Error('Not paused.');
    const s = this.store.getSession(this.session.id)!;
    const lastT = Math.max(s.duration_ms, this.store.lastSegment(s.id)?.t_end ?? 0);
    const wallOffset = now() - (s.started_at ?? s.created_at);
    const offset = this.source === 'file' ? lastT + 500 - (this.fileOpts?.posSec ?? 0) * 1000 : Math.max(wallOffset, lastT + 500);
    this.status = 'starting'; this.emitState();
    try {
      await this.beginRun(offset);
      if (this.stopping) throw new Error('The app is shutting down.');
    } catch (error) {
      if (!this.stopping) { this.status = 'paused'; this.emitState(); }
      throw error;
    }
    this.store.updateSession(s.id, { status: 'recording' });
    this.store.addTimeline(s.id, this.source === 'file' ? lastT + 500 : offset, 'resume');
    this.status = 'recording';
    this.screen?.resume();
    this.emitState();
  }

  /** Continue recording into an interrupted (or ended) session after an app restart; the gap is recorded. */
  async resumeSession(sessionId: string, source: AudioSourceMode | 'file', file?: { path: string; speed: number }): Promise<void> {
    if (this.stopping) throw new Error('The app is shutting down.');
    if (this.status !== 'idle') throw new Error('Another session is active.');
    const s = this.store.getSession(sessionId);
    if (!s) throw new Error('Session not found');
    if (s.audio_source === 'mobile') throw new Error('Continue this recording on its iPhone.');
    this.invalidateDeferredSummary(sessionId);
    // Reserve the session before cancelling a worker or starting ASR; Quick Start/delete cannot race it.
    this.status = 'starting'; this.session = s; this.source = source; this.emitState();
    let resumed = false;
    try {
      await this.beforeResume?.(sessionId);
      if (this.stopping) throw new Error('The app is shutting down.');
      await this.speech.ensure();
      if (this.stopping) throw new Error('The app is shutting down.');
      this.fileOpts = file ? { path: file.path, speed: file.speed, posSec: 0 } : null; this.warnings = []; this.transcriber.reset(s.id);
      const lastT = Math.max(s.duration_ms, this.store.lastSegment(s.id)?.t_end ?? 0);
      const offset = Math.max(now() - (s.started_at ?? s.created_at), lastT + 1000);
      this.store.addTimeline(s.id, lastT, 'gap', `Not recorded from ${fmtT(lastT)} to ${fmtT(offset)} (${s.status === 'interrupted' ? 'app restarted' : 'session resumed'}).`);
      this.store.addTimeline(s.id, offset, 'resume', source);
      this.store.updateSession(s.id, { status: 'recording', ended_at: null });
      resumed = true;
      await this.beginRun(offset);
      if (this.stopping) throw new Error('The app is shutting down.');
      this.status = 'recording';
      this.startHeartbeat();
      this.emitState();
    } catch (error) {
      if (this.stopping) throw error;  // suspendForShutdown() saves the session as interrupted
      if (resumed) this.store.updateSession(s.id, { status: 'interrupted' });
      this.session = null; this.run = null; this.fileOpts = null; this.status = 'idle'; this.emitState();
      throw error;
    }
  }

  async end(): Promise<{ sessionId: string; summaryId: string | null }> {
    if (this.stopping) throw new Error('The app is shutting down.');
    if (!this.session || (this.status !== 'recording' && this.status !== 'paused')) throw new Error('No active session.');
    const id = this.session.id;
    const t = this.nowT();
    this.status = 'ending'; this.emitState();
    this.screen?.stop(); this.screen = null;
    await this.endRun();
    // Persist the stopped clock before the (possibly long) wait for transcription.
    if (!this.stopping) this.store.touchSession(id, t);
    const complete = await this.transcriber.drain(90_000);
    // The app quit during the wait: suspendForShutdown() has saved the session as interrupted.
    if (this.stopping) return { sessionId: id, summaryId: null };
    this.flushMic(complete, id);
    const lastT = Math.max(t, this.run?.capturedToMs ?? 0, this.transcriber.finalEndSec(id) * 1000, this.store.lastSegment(id)?.t_end ?? 0);
    this.store.updateSession(id, { status: 'ended', ended_at: now(), duration_ms: Math.round(lastT) });
    this.store.addTimeline(id, lastT, 'stop');
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.run = null;
    this.session = null;
    this.fileOpts = null;
    this.status = 'idle';
    // The session is saved and released first: a summary that can't start must not keep it reserved.
    let summaryId: string | null = null;
    try {
      const token = Symbol(id);
      this.pendingSpeakerSummaries.set(id, token);
      const valid = () => !this.stopping && this.pendingSpeakerSummaries.get(id) === token && this.store.getSession(id)?.status === 'ended';
      let incomplete = false;
      const pending = complete ? this.beforeSummary?.(id) : this.transcriber.whenSessionDrained(id).then((drained) => {
        if (!valid()) return;
        if (!drained) { incomplete = true; return; }
        this.flushMic(true, id);
        this.onEnded?.(id);
        return this.beforeSummary?.(id);
      });
      if (pending) {
        void pending.then(() => {
          if (!valid()) return;
          if (incomplete || this.store.segments(id).length) this.assistant.summary(id);
          if (incomplete) {
            this.markTranscriptStale(id, 'transcription_pending');
            this.notice('warning', 'summary_incomplete', 'The summary may be missing the last part. Transcription is still pending; refresh the summary when it finishes.');
          }
          this.pendingSpeakerSummaries.delete(id);
        }).catch((error) => {
          if (!valid()) return;
          this.pendingSpeakerSummaries.delete(id);
          this.notice('warning', 'summary_failed', (error as Error).message);
        });
      } else {
        this.pendingSpeakerSummaries.delete(id);
        if (this.store.segments(id).length) summaryId = this.assistant.summary(id);
      }
    } catch (error) {
      this.pendingSpeakerSummaries.delete(id);
      this.notice('warning', 'summary_failed', `The session was saved, but its summary could not be started: ${(error as Error).message}`);
    }
    this.emitState();
    this.broadcast('session-ended', { sessionId: id, summaryId, transcriptionPending: !complete });
    this.onEnded?.(id);
    return { sessionId: id, summaryId };
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.session && this.status === 'recording') {
        this.store.touchSession(this.session.id, this.nowT());
        this.broadcast('tick', { nowT: this.nowT(), asr: { backlogSec: Math.round(this.transcriber.backlogSec), latencyMs: this.speech.lastLatencyMs, state: this.speech.state } });
      }
    }, 2000);
  }

  // ------------------------------------------------------------------ transcript commit + duplicate suppression
  private onFinal(pieces: FinalPiece[]): void {
    for (const p of pieces) {
      const t0 = Math.round(p.startSec * 1000);
      const t1 = Math.round(p.endSec * 1000);
      const both = p.session === this.session?.id ? this.source === 'both' : !!p.session && this.store.getSession(p.session)?.audio_source === 'both';
      if (both && p.source === 'mic') {
        // Wait for overlapping computer audio, but don't hide genuine mic speech indefinitely.
        this.pendingMic.push({ piece: p, due: now() + 25_000, t0, t1 });
        this.dedupeTimer ??= setInterval(() => this.flushMic(false), 1000);
        continue;
      }
      this.commit(p, t0, t1);
    }
  }

  private flushMic(all: boolean, sessionId?: string): void {
    const ready = this.pendingMic.filter((m) => {
      if (sessionId && m.piece.session !== sessionId) return false;
      if (all || m.due <= now()) return true;
      if (!m.piece.session || this.transcriber.hasPendingFinal(m.piece.session, 'system', m.t0 / 1000, m.t1 / 1000)) return false;
      if (m.piece.session !== this.session?.id || this.status !== 'recording') return true;
      const run = this.run, system = run?.segmenters.get('system');
      return !!run && (run.sourceEnds.get('system') ?? -1) >= m.t1
        && (!system?.isActive || system.activeStartSec! * 1000 + run.offsetMs > m.t1);
    });
    this.pendingMic = this.pendingMic.filter((m) => !ready.includes(m));
    for (const m of ready) {
      const overlapping = m.piece.session ? this.store.segments(m.piece.session, m.t0, m.t1).filter((s) => s.source === 'system') : [];
      const dup = isMicEcho({ text: m.piece.text, t_start: m.t0, t_end: m.t1 }, overlapping);
      if (dup) { this.droppedDuplicates++; continue; }
      this.commit(m.piece, m.t0, m.t1);
    }
    if (!this.pendingMic.length && this.dedupeTimer) { clearInterval(this.dedupeTimer); this.dedupeTimer = null; }
  }

  private commit(p: FinalPiece, t0: number, t1: number): void {
    if (!this.session || p.session !== this.session.id) { this.commitLate(p, t0, t1); return; }
    const row: SegmentRow = this.store.addSegment({ session_id: this.session.id, t_start: t0, t_end: Math.max(t1, t0 + 200), text: p.text, lang: p.lang, source: p.source, run: this.run?.index ?? 0 });
    this.store.touchSession(this.session.id, t1);
    this.broadcast('segment', row);
    this.assistant.onActivity(this.session.id, 'segment');
  }

  /**
   * Text that arrived after its session ended (transcription outlasted the wait in end()), possibly while another
   * session records: it goes into the session it was captured in, never the current one.
   */
  private commitLate(p: FinalPiece, t0: number, t1: number): void {
    const owner = p.session ? this.store.getSession(p.session) : undefined;
    if (!owner) { log('session', 'dropped transcript that arrived after its session was deleted'); return; }
    if (owner.audio_source === 'both' && p.source === 'mic'
      && isMicEcho({ text: p.text, t_start: t0, t_end: t1 }, this.store.segments(owner.id, t0, t1).filter((s) => s.source === 'system'))) { this.droppedDuplicates++; return; }
    const row = this.store.addSegment({ session_id: owner.id, t_start: t0, t_end: Math.max(t1, t0 + 200), text: p.text, lang: p.lang, source: p.source, run: this.store.lastSegment(owner.id)?.run ?? 0 });
    this.store.touchSession(owner.id, t1);
    this.broadcast('segment', row);
    this.markTranscriptStale(owner.id, 'transcript_completed_late');
    log('session', `saved transcript that arrived late for ${owner.id} at ${fmtT(t0)}`);
  }
}

export function publicFrame(f: FrameRow): Omit<FrameRow, 'path'> {
  const { path: _p, ...rest } = f;
  return rest;
}
