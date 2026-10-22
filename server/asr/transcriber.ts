import { EventEmitter } from 'node:events';
import type { SpeechService } from './speech.ts';
import { cleanSegmentText, keepSegment, langCode, toSimplified } from './clean.ts';
import type { Utterance } from '../audio/vad.ts';
import type { SourceName } from '../audio/capture.ts';
import { log } from '../util.ts';

export interface FinalPiece { source: SourceName; uttId: number; startSec: number; endSec: number; text: string; lang: string | null }

interface Job { kind: 'final' | 'partial'; source: SourceName; utt: Utterance; enqueued: number; depth?: number; retried?: boolean }

/**
 * Schedules speech requests: finals in order (never dropped), partials only when idle and only the newest per source,
 * and none at all for paid services (each partial would bill the utterance again).
 * Partial text for an utterance is replaced by its final text, so revisions never duplicate sentences.
 */
export class Transcriber extends EventEmitter<{
  partial: [source: SourceName, uttId: number, startSec: number, text: string];
  partialClear: [source: SourceName, uttId: number];
  final: [pieces: FinalPiece[]];
  error: [message: string];
  idle: [];
}> {
  private finals: Job[] = [];
  private partials = new Map<SourceName, Job>();
  private busy = false;
  private finalizedUtts = new Map<SourceName, number>(); // highest utterance id already finalized per source
  private lastText = new Map<SourceName, string>();
  stopped = false;
  backlogSec = 0;

  private speech: Pick<SpeechService, 'transcribe' | 'partials'>;
  private cfg: () => { language: string; glossary: string[]; chineseScript: string };
  constructor(speech: Pick<SpeechService, 'transcribe' | 'partials'>, cfg: () => { language: string; glossary: string[]; chineseScript: string }) { super(); this.speech = speech; this.cfg = cfg; }

  pushProgress(source: SourceName, utt: Utterance): void {
    if (this.stopped || !this.speech.partials) return;
    this.partials.set(source, { kind: 'partial', source, utt, enqueued: Date.now() });
    this.pump();
  }

  pushFinal(source: SourceName, utt: Utterance): void {
    if (this.stopped) return;
    const p = this.partials.get(source);
    if (p && p.utt.id <= utt.id) this.partials.delete(source);
    this.finals.push({ kind: 'final', source, utt, enqueued: Date.now() });
    this.backlogSec = this.finals.reduce((s, j) => s + (j.utt.endSec - j.utt.startSec), 0);
    this.pump();
  }

  /** New session: forget per-source context so nothing leaks between sessions. */
  reset(): void {
    this.finals = []; this.partials.clear(); this.lastText.clear(); this.backlogSec = 0; this.stopped = false;
  }

  get pendingFinals(): number { return this.finals.length + (this.busy ? 1 : 0); }

  /** Resolve when every queued final has been transcribed (used when ending a session). */
  async drain(timeoutMs = 60000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.finals.length || this.busy) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  private prompt(source: SourceName): string {
    const { glossary } = this.cfg();
    const parts: string[] = [];
    if (glossary.length) parts.push(`Glossary: ${glossary.slice(0, 40).join(', ')}.`);
    const prev = this.lastText.get(source);
    if (prev) parts.push(prev.slice(-160));
    return parts.join(' ').slice(-600);
  }

  /** A chunk whose language detection is split between English and Mandarin usually spans a speaker turn. */
  private static isMixed(probs: Record<string, number>): boolean {
    const top = Object.entries(probs).sort((a, b) => b[1] - a[1]);
    if (top.length < 2) return false;
    const pair = new Set([top[0][0], top[1][0]]);
    return pair.has('en') && pair.has('zh') && top[0][1] < 0.85 && top[1][1] >= 0.1;
  }

  /** Split at the quietest 200 ms inside the middle 60 % of the chunk. */
  private static split(u: Utterance): [Utterance, Utterance] {
    const fl = 320, n = Math.floor(u.samples.length / fl);
    const e: number[] = [];
    for (let i = 0; i < n; i++) { let s = 0; for (let j = i * fl; j < (i + 1) * fl; j++) s += u.samples[j] * u.samples[j]; e.push(s); }
    let best = Math.floor(n / 2), bestE = Infinity;
    for (let i = Math.floor(n * 0.2); i + 10 <= Math.ceil(n * 0.8); i++) {
      let s = 0; for (let j = i; j < i + 10; j++) s += e[j];
      if (s < bestE) { bestE = s; best = i + 5; }
    }
    const cut = best * fl;
    const a: Utterance = { ...u, samples: u.samples.slice(0, cut), endSec: u.startSec + cut / 16000 };
    const b: Utterance = { ...u, samples: u.samples.slice(cut), startSec: u.startSec + cut / 16000 };
    return [a, b];
  }

  private pump(): void {
    if (this.busy || this.stopped) return;
    let job = this.finals.shift();
    if (!job) {
      // Newest partial across sources; skip if its utterance was already finalized.
      const cands = [...this.partials.values()].sort((a, b) => b.enqueued - a.enqueued);
      job = cands[0];
      if (job) this.partials.delete(job.source);
      if (job && (this.finalizedUtts.get(job.source) ?? 0) >= job.utt.id) job = undefined;
    }
    if (!job) { this.emit('idle'); return; }
    this.busy = true;
    void this.run(job).finally(() => {
      this.busy = false;
      this.backlogSec = this.finals.reduce((s, j) => s + (j.utt.endSec - j.utt.startSec), 0);
      this.pump();
    });
  }

  private async run(job: Job): Promise<void> {
    const { language, glossary } = this.cfg();
    const durSec = job.utt.samples.length / 16000;
    try {
      const res = await this.speech.transcribe(job.utt.samples, { language, prompt: this.prompt(job.source), glossary, timeoutMs: job.kind === 'final' ? 90000 : 20000 });
      const lang = langCode(res.language);
      const fix = (t: string) => (lang === 'zh' && this.cfg().chineseScript === 'simplified' ? toSimplified(t) : t);
      if (job.kind === 'final' && (job.depth ?? 0) < 2 && durSec > 4 && Transcriber.isMixed(res.langProbs)) {
        // Mixed English/Mandarin detection: transcribe each half separately instead of letting Whisper translate one language into the other.
        const [a, b] = Transcriber.split(job.utt);
        this.finals.unshift({ ...job, utt: a, depth: (job.depth ?? 0) + 1 }, { ...job, utt: b, depth: (job.depth ?? 0) + 1 });
        return;
      }
      if (job.kind === 'partial') {
        if ((this.finalizedUtts.get(job.source) ?? 0) >= job.utt.id) return; // final already arrived
        const text = fix(res.segments.map((s) => cleanSegmentText(s.text)).filter((t, i) => keepSegment(res.segments[i], t, durSec)).join(' ').trim());
        if (text) this.emit('partial', job.source, job.utt.id, job.utt.startSec, text);
        return;
      }
      this.finalizedUtts.set(job.source, Math.max(this.finalizedUtts.get(job.source) ?? 0, job.utt.id));
      const pieces: FinalPiece[] = [];
      const segs = res.segments.length ? res.segments : [{ start: 0, end: durSec, text: res.text }];
      for (const s of segs) {
        const text = fix(cleanSegmentText(s.text));
        if (!keepSegment(s, text, durSec)) continue;
        const startSec = job.utt.startSec + Math.max(0, Math.min(durSec, s.start));
        const endSec = job.utt.startSec + Math.max(0, Math.min(durSec, s.end || durSec));
        const last = pieces[pieces.length - 1];
        // Whisper marks a new word with a leading space; without it the segment continues the previous word.
        const continuesWord = !!last && lang !== 'zh' && /^[A-Za-z0-9]/.test(s.text) && /[A-Za-z0-9]$/.test(last.text);
        const sentenceDone = !!last && /[.?!。？！]["”']?$/.test(last.text) && last.text.length >= 120;
        if (last && (continuesWord || (!sentenceDone && last.text.length + text.length < 260))) {
          last.text = `${last.text}${lang === 'zh' || continuesWord ? '' : ' '}${text}`.trim();
          last.endSec = endSec;
        } else pieces.push({ source: job.source, uttId: job.utt.id, startSec, endSec, text, lang });
      }
      this.emit('partialClear', job.source, job.utt.id);
      if (pieces.length) {
        this.lastText.set(job.source, pieces.map((p) => p.text).join(' '));
        this.emit('final', pieces);
      }
    } catch (e) {
      const msg = (e as Error).message;
      log('asr', `${job.kind} transcription failed: ${msg}`);
      if (job.kind === 'final') {
        this.emit('error', `Transcription failed for ${durSec.toFixed(1)} s of audio: ${msg}`);
        // Retry once after the engine restarts; audio is kept in memory until then.
        if (!job.retried) {
          job.retried = true;
          await new Promise((r) => setTimeout(r, 2000));
          this.finals.unshift(job);
        }
      }
    }
  }
}
