import { randomUUID } from 'node:crypto';
import type { Store } from '../db.ts';
import type { SpeakerRuntime, SpeakerTurn, SpeakerView } from '../../shared/speakers.ts';
import { AUDIO_DIR } from '../paths.ts';
import { discardSpeakerAudio, mapSpeakerTurns, prepareSpeakerInputs, speakerAudioAvailable } from './audio.ts';
import { runDiarization, speakerRuntime } from './runtime.ts';
import { log } from '../util.ts';

interface Job { sessionId: string; generation: string; controller: AbortController; done: Promise<void>; resolve: () => void }
interface Options {
  audioRoot?: string;
  runtime?: () => SpeakerRuntime;
  run?: typeof runDiarization;
}

/** A single local worker, independent of live transcription and the chosen AI provider. */
export class SpeakerService {
  private store: Store;
  private changed: (sessionId: string) => void;
  private root: string;
  private runtime: () => SpeakerRuntime;
  private run: typeof runDiarization;
  private jobs = new Map<string, Job>();
  private processing = false;
  private stopping = false;

  constructor(store: Store, changed: (sessionId: string) => void, options: Options = {}) {
    this.store = store; this.changed = changed;
    this.root = options.audioRoot ?? AUDIO_DIR;
    this.runtime = options.runtime ?? speakerRuntime;
    this.run = options.run ?? runDiarization;
  }

  view(sessionId: string): SpeakerView {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error('Session not found.');
    const runtime = this.runtime();
    const audioAvailable = speakerAudioAvailable(sessionId, this.root);
    return {
      speakers: this.store.speakers(sessionId), analysis: this.store.speakerAnalysis(sessionId), runtime, audioAvailable,
      canRun: !this.stopping && runtime.ready && audioAvailable && !this.jobs.has(sessionId) && ['ended', 'interrupted'].includes(session.status),
    };
  }

  /** Returned promise settles after cleanup; failures are persisted for the UI and don't prevent a summary. */
  analyze(sessionId: string): Promise<void> {
    const previous = this.jobs.get(sessionId);
    if (previous) return previous.done;
    const view = this.view(sessionId);
    if (!view.canRun) throw new Error(!view.runtime.ready ? view.runtime.reason ?? 'Speaker runtime is unavailable.'
      : !view.audioAvailable ? 'No audio is available for speaker analysis. Enable speaker labeling before the next recording.'
        : 'End the session before analyzing speakers.');
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const job: Job = { sessionId, generation: randomUUID(), controller: new AbortController(), done, resolve };
    this.jobs.set(sessionId, job);
    this.update(job, 'queued');
    void this.pump();
    return done;
  }

  async cancel(sessionId: string): Promise<void> {
    const job = this.jobs.get(sessionId);
    if (!job) { discardSpeakerAudio(sessionId, this.root); return; }
    job.controller.abort();
    // A queued job can be removed immediately; the running worker finishes cleanup in its finally block.
    if (this.store.speakerAnalysis(sessionId).status === 'queued') {
      this.jobs.delete(sessionId);
      discardSpeakerAudio(sessionId, this.root);
      this.update(job, 'cancelled');
      job.resolve();
    }
    await job.done;
  }

  recover(): void {
    for (const { id } of this.store.db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>) {
      const analysis = this.store.speakerAnalysis(id);
      if (analysis.status === 'queued' || analysis.status === 'running') {
        this.store.setSpeakerAnalysis(id, { ...analysis, status: 'failed', error: 'Speaker analysis was interrupted. Temporary audio has been removed.', updated_at: Date.now() });
      }
      discardSpeakerAudio(id, this.root);
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)));
    // Includes unprocessed captures from a recording interrupted by quitting the app.
    for (const { id } of this.store.db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>) discardSpeakerAudio(id, this.root);
  }

  private update(job: Job, status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled', error: string | null = null): void {
    if (!this.store.getSession(job.sessionId)) return;
    this.store.setSpeakerAnalysis(job.sessionId, { status, generation: job.generation, error, updated_at: Date.now() });
    this.changed(job.sessionId);
  }

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.jobs.size && !this.stopping) {
        const job = this.jobs.values().next().value!;
        const { sessionId, controller } = job;
        try {
          controller.signal.throwIfAborted();
          this.update(job, 'running');
          const inputs = await prepareSpeakerInputs(sessionId, controller.signal, this.root);
          const turns: SpeakerTurn[] = [];
          for (const input of inputs) {
            const result = await this.run(input.path, { signal: controller.signal });
            controller.signal.throwIfAborted();
            turns.push(...mapSpeakerTurns(input, result));
          }
          const session = this.store.getSession(sessionId);
          if (!session || !['ended', 'interrupted'].includes(session.status)) throw new Error('The meeting changed while speakers were being analyzed.');
          // Records "done" in the same transaction; the finally block below tells the UI once.
          if (!this.store.applySpeakerTurns(sessionId, job.generation, turns, inputs.flatMap((input) => input.mapping.map((span) => ({ source: input.source, start_ms: span.start_ms, end_ms: span.end_ms })))))
            log('speakers', `analysis for ${sessionId} was superseded; its result was not applied`);
        } catch (error) {
          // A superseded job must not overwrite the state of the job that replaced it.
          if (this.store.speakerAnalysis(sessionId).generation === job.generation) {
            this.store.setSpeakerAnalysis(sessionId, { status: controller.signal.aborted ? 'cancelled' : 'failed', generation: job.generation, error: controller.signal.aborted ? null : (error as Error).message, updated_at: Date.now() });
          }
        } finally {
          discardSpeakerAudio(sessionId, this.root);
          this.jobs.delete(sessionId);
          // Availability changes after temporary audio is removed; refresh the UI once more.
          if (this.store.getSession(sessionId)) this.changed(sessionId);
          job.resolve();
        }
      }
    } finally { this.processing = false; }
  }
}
