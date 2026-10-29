import { EventEmitter } from 'node:events';
import type { SpeechService } from './speech.ts';
import { cleanSegmentText, keepSegment, langCode, mostlyHan, stripPromptEcho, termSentence, toSimplified } from './clean.ts';
import { decideLanguage, isSpoken, type Spoken } from './language.ts';
import type { Utterance } from '../audio/vad.ts';
import type { SourceName } from '../audio/capture.ts';
import { log } from '../util.ts';

/** `session`: the session the audio was captured in, which may have ended (or been followed by another) by the time the text arrives. */
/**
 * language: 'auto' | 'en' | 'zh'. prior: the language a meeting most likely opens in (language.ts), used with 'auto'.
 * guard: false turns the Mandarin/English policy off, so scripts/asr-eval.ts can measure detection without it.
 */
export interface TranscriberConfig { language: string; glossary: string[]; chineseScript: string; prior?: Spoken; guard?: boolean }

export interface FinalPiece { session: string | null; source: SourceName; uttId: number; startSec: number; endSec: number; text: string; lang: string | null }

interface Context { lastText: Map<SourceName, string>; recentLang: Map<SourceName, Spoken> }
interface Job { kind: 'final' | 'partial'; session: string | null; context: Context; source: SourceName; utt: Utterance; enqueued: number; depth?: number; attempts?: number; retryAt?: number; failedAt?: number }

/**
 * Schedules speech requests: finals in order with bounded retries and explicit gaps, partials only when idle and only the newest per source,
 * and none at all for paid services (each partial would bill the utterance again).
 * Partial text for an utterance is replaced by its final text, so revisions never duplicate sentences.
 */
export class Transcriber extends EventEmitter<{
  partial: [source: SourceName, uttId: number, startSec: number, text: string];
  partialClear: [source: SourceName, uttId: number];
  final: [pieces: FinalPiece[]];
  error: [message: string];
  idle: [];
  settled: [];
  retry: [];
  gap: [session: string | null, source: SourceName, startSec: number, endSec: number, reason: string];
  stopped: [];
}> {
  private finals: Job[] = [];
  private retries: Job[] = [];
  private partials = new Map<SourceName, Job>();
  private busy = false;
  private retryTimer: NodeJS.Timeout | null = null;
  get retrying(): boolean { return this.retries.length > 0 || (this.active?.kind === 'final' && !!this.active.attempts); }
  private active: Job | null = null;
  /** Bumped on shutdown: work still in flight from before then must not touch a closed store. */
  private generation = 0;
  private lastPartialAt = new Map<SourceName, number>();
  private finalizedUtts = new Map<SourceName, number>(); // highest utterance id already finalized per source
  private context: Context = { lastText: new Map(), recentLang: new Map() };
  private session: string | null = null;
  stopped = false;
  backlogSec = 0;

  private speech: Pick<SpeechService, 'transcribe' | 'partials'> & Partial<Pick<SpeechService, 'partialIntervalMs'>>;
  private cfg: () => TranscriberConfig;
  constructor(speech: Pick<SpeechService, 'transcribe' | 'partials'> & Partial<Pick<SpeechService, 'partialIntervalMs'>>, cfg: () => TranscriberConfig) { super(); this.speech = speech; this.cfg = cfg; }

  pushProgress(source: SourceName, utt: Utterance): void {
    if (this.stopped || !this.speech.partials) return;
    this.partials.set(source, { kind: 'partial', session: this.session, context: this.context, source, utt, enqueued: Date.now() });
    this.pump();
  }

  pushFinal(source: SourceName, utt: Utterance): void {
    if (this.stopped) return;
    const p = this.partials.get(source);
    if (p && p.utt.id <= utt.id) this.partials.delete(source);
    this.finals.push({ kind: 'final', session: this.session, context: this.context, source, utt, enqueued: Date.now() });
    this.backlogSec = this.queuedFinals().reduce((s, j) => s + (j.utt.endSec - j.utt.startSec), 0);
    this.pump();
  }

  /**
   * New session: forget per-source context so nothing leaks between sessions. Queued and in-flight finals
   * keep their own context and finish for the session they were captured in.
   */
  reset(session: string | null = null): void {
    this.partials.clear(); this.lastPartialAt.clear(); this.finalizedUtts.clear(); this.context = { lastText: new Map(), recentLang: new Map() }; this.backlogSec = this.queuedFinals().reduce((s, j) => s + (j.utt.endSec - j.utt.startSec), 0); this.stopped = false;
    this.session = session;
  }

  /** Finals queued or being transcribed; an optional preview in flight does not count. */
  get pendingFinals(): number { return this.finals.length + this.retries.length + (this.active?.kind === 'final' ? 1 : 0); }

  pendingFor(session: string): boolean { return this.queuedFinals().some((j) => j.session === session) || (this.active?.kind === 'final' && this.active.session === session); }

  hasPendingFinal(session: string, source: SourceName, fromSec: number, toSec: number): boolean {
    return [...this.queuedFinals(), ...(this.active ? [this.active] : [])].some((j) => j.kind === 'final' && j.session === session && j.source === source && j.utt.startSec <= toSec && j.utt.endSec >= fromSec);
  }

  finalEndSec(session: string): number {
    return Math.max(0, ...this.queuedFinals().filter((j) => j.session === session).map((j) => j.utt.endSec), this.active?.kind === 'final' && this.active.session === session ? this.active.utt.endSec : 0);
  }

  /** Another meeting can start while these finals finish; its work must not delay this barrier. */
  whenSessionDrained(session: string, timeoutMs = 20 * 60_000): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (!this.pendingFor(session)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (complete: boolean) => { clearTimeout(timer); this.off('settled', check); this.off('stopped', stopped); resolve(complete); };
      const check = () => { if (!this.pendingFor(session)) finish(true); };
      const stopped = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.on('settled', check); this.on('stopped', stopped);
    });
  }

  /** Stop scheduling work on shutdown, and invalidate callbacks before their store is closed. */
  stop(): void {
    this.stopped = true; this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const job of [...this.queuedFinals(), ...(this.active?.kind === 'final' ? [this.active] : [])]) this.gap(job, 'the app closed before transcription finished');
    this.finals = []; this.retries = []; this.active = null; this.busy = false; this.backlogSec = 0;
    this.partials.clear();
    this.emit('stopped');
  }

  /** Wait for fresh finals. Failed audio keeps retrying in the background rather than holding End open. */
  drain(timeoutMs = 60000): Promise<boolean> {
    this.partials.clear();
    if (!this.pendingFinals) return Promise.resolve(true);
    if (this.stopped || this.onlyRetries()) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (complete: boolean) => { clearTimeout(timer); this.off('settled', onIdle); this.off('idle', onIdle); this.off('stopped', onStop); resolve(complete); };
      const onIdle = () => { if (!this.pendingFinals) finish(true); else if (this.onlyRetries()) finish(false); };
      const onStop = () => finish(false);
      const timer = setTimeout(() => finish(!this.pendingFinals), timeoutMs);
      this.on('settled', onIdle); this.on('idle', onIdle);
      this.on('stopped', onStop);
    });
  }

  /**
   * Whisper reads the prompt as the transcript just before this audio: the glossary as a sentence in the language being spoken,
   * then the latest text. Qwen3-ASR gets the same text as context; ElevenLabs ignores it and takes the glossary as keyterms.
   */
  private prompt(source: SourceName, context: Context): { text: string; terms: string[]; chinese: boolean; prev: string } {
    const { glossary, language, prior } = this.cfg();
    const terms = glossary.slice(0, 40);
    const prev = context.lastText.get(source)?.slice(-160) ?? '';
    // Before anything was said, the glossary sentence is written in the language the meeting most likely opens in.
    const chinese = prev ? mostlyHan(prev) : language === 'zh' || (language === 'auto' && prior === 'zh');
    return { text: [termSentence(terms, chinese), prev].filter(Boolean).join(' ').slice(-600), terms, chinese, prev };
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

  private gap(job: Job, reason: string): void {
    this.emit('gap', job.session, job.source, job.utt.startSec, job.utt.endSec, reason);
  }

  private queuedFinals(): Job[] { return [...this.finals, ...this.retries]; }

  private onlyRetries(): boolean {
    return !this.finals.length && this.retrying && !(this.active?.kind === 'final' && !this.active.attempts);
  }

  private limitRetries(): void {
    // Bound only failed audio. A healthy engine can accumulate a large backlog during fast file imports.
    let samples = this.retries.reduce((n, j) => n + j.utt.samples.length, 0);
    while (samples > 900 * 16000 && this.retries.length) {
      const job = this.retries.shift()!;
      samples -= job.utt.samples.length;
      this.gap(job, 'the failed-audio retry queue reached its limit');
    }
  }

  private pump(): void {
    if (this.busy || this.stopped) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const expired = this.retries.filter((j) => Date.now() - j.failedAt! >= 15 * 60_000);
    this.retries = this.retries.filter((j) => !expired.includes(j));
    for (const job of expired) this.gap(job, 'speech recognition could not complete this audio within fifteen minutes');
    if (expired.length) { this.backlogSec = this.queuedFinals().reduce((s, j) => s + j.utt.endSec - j.utt.startSec, 0); this.emit('retry'); this.emit('settled'); }
    // Fresh audio always gets a turn before a previously failed clip, including audio from a new meeting.
    let job = this.finals.shift();
    if (!job) {
      this.retries.sort((a, b) => a.retryAt! - b.retryAt!);
      if (this.retries[0]?.retryAt! <= Date.now()) job = this.retries.shift();
    }
    if (!job && !this.retries.length) {
      // Newest partial across sources; skip if its utterance was already finalized.
      const cands = [...this.partials.values()].filter((p) => Date.now() - (this.lastPartialAt.get(p.source) ?? 0) >= (this.speech.partialIntervalMs ?? 0)).sort((a, b) => b.enqueued - a.enqueued);
      job = cands[0];
      if (job) this.partials.delete(job.source);
      if (job && (this.finalizedUtts.get(job.source) ?? 0) >= job.utt.id) job = undefined;
    }
    if (!job) {
      if (this.retries.length) this.retryTimer = setTimeout(() => { this.retryTimer = null; this.pump(); }, Math.max(0, this.retries[0].retryAt! - Date.now()));
      this.emit('idle');
      return;
    }
    if (job.kind === 'partial') this.lastPartialAt.set(job.source, Date.now());
    this.busy = true;
    this.active = job;
    const generation = this.generation;
    void this.run(job, generation).finally(() => {
      if (generation !== this.generation) return;
      const retrying = this.retrying;
      this.busy = false; this.active = null;
      this.backlogSec = this.queuedFinals().reduce((s, j) => s + (j.utt.endSec - j.utt.startSec), 0);
      if (retrying || this.retrying) this.emit('retry');
      this.emit('settled');
      this.pump();
    });
  }

  private async run(job: Job, generation: number): Promise<void> {
    const { language, glossary, prior, guard } = this.cfg();
    const durSec = job.utt.samples.length / 16000;
    const current = () => job.context === this.context;
    try {
      const prompt = this.prompt(job.source, job.context);
      let res = await this.speech.transcribe(job.utt.samples, { language, prompt: prompt.text, glossary, timeoutMs: job.kind === 'final' ? 90000 : 20000 });
      if (generation !== this.generation) return;
      // A chosen language is the label: whisper-server reports what it detected even when told which language to use.
      let lang = language === 'zh' || language === 'en' ? language : langCode(res.language);
      if (language === 'auto' && guard !== false) {
        // Mandarin and English only (language.ts): relabel Chinese text detected as another language, or transcribe it again.
        const decision = decideLanguage({ lang, probs: res.langProbs, text: res.text }, job.context.recentLang.get(job.source) ?? null, prior ?? 'en');
        if (decision.action === 'relabel') lang = decision.lang;
        else if (decision.action === 'retry') {
          if (job.kind === 'partial') return; // the final will be transcribed again; a preview in the wrong language would only flash
          res = await this.speech.transcribe(job.utt.samples, { language: decision.lang, prompt: prompt.text, glossary, timeoutMs: 90000 });
          if (generation !== this.generation) return;
          lang = decision.lang;
        }
      }
      const fix = (t: string) => (lang === 'zh' && this.cfg().chineseScript === 'simplified' ? toSimplified(t) : t);
      // Every engine's text is checked: a service that fails hands the same prompt to local Whisper, and Qwen3-ASR reads it too.
      const clean = (t: string) => stripPromptEcho(cleanSegmentText(t), prompt);
      if (job.kind === 'final' && current() && (job.depth ?? 0) < 2 && durSec > 4 && Transcriber.isMixed(res.langProbs)) {
        // Mixed English/Mandarin detection: transcribe each half separately instead of letting Whisper translate one language into the other.
        const [a, b] = Transcriber.split(job.utt);
        this.finals.unshift({ ...job, utt: a, depth: (job.depth ?? 0) + 1 }, { ...job, utt: b, depth: (job.depth ?? 0) + 1 });
        return;
      }
      if (job.kind === 'partial') {
        if (!current() || (this.finalizedUtts.get(job.source) ?? 0) >= job.utt.id) return; // final already arrived, or another session's
        const text = fix(res.segments.map((s) => clean(s.text)).filter((t, i) => keepSegment(res.segments[i], t, durSec)).join(' ').trim());
        if (text) this.emit('partial', job.source, job.utt.id, job.utt.startSec, text);
        return;
      }
      // (Utterance ids restart with each session: another session's must not hide this one's previews.)
      if (current()) this.finalizedUtts.set(job.source, Math.max(this.finalizedUtts.get(job.source) ?? 0, job.utt.id));
      const pieces: FinalPiece[] = [];
      const segs = res.segments.length ? res.segments : [{ start: 0, end: durSec, text: res.text }];
      for (const s of segs) {
        const text = fix(clean(s.text));
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
        } else pieces.push({ session: job.session, source: job.source, uttId: job.utt.id, startSec, endSec, text, lang });
      }
      if (current()) this.emit('partialClear', job.source, job.utt.id);
      if (pieces.length) {
        job.context.lastText.set(job.source, pieces.map((p) => p.text).join(' '));
        if (isSpoken(lang)) job.context.recentLang.set(job.source, lang);
        this.emit('final', pieces);
      }
    } catch (e) {
      if (generation !== this.generation) return;
      const msg = (e as Error).message;
      log('asr', `${job.kind} transcription failed: ${msg}`);
      if (job.kind === 'final') {
        job.failedAt ??= Date.now();
        job.attempts = (job.attempts ?? 0) + 1;
        if (job.attempts >= 3) this.gap(job, 'speech recognition failed three times for this audio');
        else {
          job.retryAt = Date.now() + (job.attempts === 1 ? 2000 : 30_000);
          this.retries.push(job);
          this.limitRetries();
        }
      }
    }
  }
}
