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

interface Job { kind: 'final' | 'partial'; session: string | null; source: SourceName; utt: Utterance; enqueued: number; depth?: number; retried?: boolean }

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
  stopped: [];
}> {
  private finals: Job[] = [];
  private partials = new Map<SourceName, Job>();
  private busy = false;
  private active: Job | null = null;
  /** Bumped on shutdown: work still in flight from before then must not touch a closed store. */
  private generation = 0;
  private finalizedUtts = new Map<SourceName, number>(); // highest utterance id already finalized per source
  private lastText = new Map<SourceName, string>();
  /** The language each source last spoke, for choosing between Mandarin and English when detection names neither. */
  private recentLang = new Map<SourceName, Spoken>();
  private session: string | null = null;
  stopped = false;
  backlogSec = 0;

  private speech: Pick<SpeechService, 'transcribe' | 'partials'>;
  private cfg: () => TranscriberConfig;
  constructor(speech: Pick<SpeechService, 'transcribe' | 'partials'>, cfg: () => TranscriberConfig) { super(); this.speech = speech; this.cfg = cfg; }

  pushProgress(source: SourceName, utt: Utterance): void {
    if (this.stopped || !this.speech.partials) return;
    this.partials.set(source, { kind: 'partial', session: this.session, source, utt, enqueued: Date.now() });
    this.pump();
  }

  pushFinal(source: SourceName, utt: Utterance): void {
    if (this.stopped) return;
    const p = this.partials.get(source);
    if (p && p.utt.id <= utt.id) this.partials.delete(source);
    this.finals.push({ kind: 'final', session: this.session, source, utt, enqueued: Date.now() });
    this.backlogSec = this.finals.reduce((s, j) => s + (j.utt.endSec - j.utt.startSec), 0);
    this.pump();
  }

  /**
   * New session: forget per-source context so nothing leaks between sessions. A request still in flight
   * finishes for the session it was captured in: its text is tagged with that session and changes nothing here.
   */
  reset(session: string | null = null): void {
    this.finals = []; this.partials.clear(); this.finalizedUtts.clear(); this.lastText.clear(); this.recentLang.clear(); this.backlogSec = 0; this.stopped = false;
    this.session = session;
  }

  /** Finals queued or being transcribed; an optional preview in flight does not count. */
  get pendingFinals(): number { return this.finals.length + (this.active?.kind === 'final' ? 1 : 0); }

  /** Stop scheduling work on shutdown, and invalidate callbacks before their store is closed. */
  stop(): void {
    this.stopped = true; this.generation++;
    this.partials.clear();
    this.emit('stopped');
  }

  /** Wait for finals, not optional previews (used when ending a session). Resolves true when none are left. */
  drain(timeoutMs = 60000): Promise<boolean> {
    this.partials.clear();
    if (!this.pendingFinals) return Promise.resolve(true);
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (complete: boolean) => { clearTimeout(timer); this.off('idle', onIdle); this.off('stopped', onStop); resolve(complete); };
      const onIdle = () => { if (!this.pendingFinals) finish(true); };
      const onStop = () => finish(false);
      const timer = setTimeout(() => finish(!this.pendingFinals), timeoutMs);
      this.on('idle', onIdle);
      this.on('stopped', onStop);
    });
  }

  /**
   * Whisper reads the prompt as the transcript just before this audio: the glossary as a sentence in the language being spoken,
   * then the latest text. Qwen3-ASR gets the same text as context; ElevenLabs ignores it and takes the glossary as keyterms.
   */
  private prompt(source: SourceName): { text: string; terms: string[]; chinese: boolean; prev: string } {
    const { glossary, language, prior } = this.cfg();
    const terms = glossary.slice(0, 40);
    const prev = this.lastText.get(source)?.slice(-160) ?? '';
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
    this.active = job;
    const generation = this.generation;
    void this.run(job, generation).finally(() => {
      if (generation !== this.generation) return;
      this.busy = false; this.active = null;
      this.backlogSec = this.finals.reduce((s, j) => s + (j.utt.endSec - j.utt.startSec), 0);
      this.pump();
    });
  }

  private async run(job: Job, generation: number): Promise<void> {
    const { language, glossary, prior, guard } = this.cfg();
    const durSec = job.utt.samples.length / 16000;
    const current = () => job.session === this.session;
    try {
      const prompt = this.prompt(job.source);
      let res = await this.speech.transcribe(job.utt.samples, { language, prompt: prompt.text, glossary, timeoutMs: job.kind === 'final' ? 90000 : 20000 });
      if (generation !== this.generation) return;
      let lang = langCode(res.language);
      if (language === 'auto' && guard !== false) {
        // Mandarin and English only (language.ts): relabel Chinese text detected as another language, or transcribe it again.
        const decision = decideLanguage({ lang, probs: res.langProbs, text: res.text }, this.recentLang.get(job.source) ?? null, prior ?? 'en');
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
      if (!current()) { if (pieces.length) this.emit('final', pieces); return; }
      this.emit('partialClear', job.source, job.utt.id);
      if (pieces.length) {
        this.lastText.set(job.source, pieces.map((p) => p.text).join(' '));
        if (isSpoken(lang)) this.recentLang.set(job.source, lang);
        this.emit('final', pieces);
      }
    } catch (e) {
      if (generation !== this.generation) return;
      const msg = (e as Error).message;
      log('asr', `${job.kind} transcription failed: ${msg}`);
      // Another session is being transcribed now: don't report into it or hold its queue up with a retry.
      if (job.kind === 'final' && current()) {
        this.emit('error', `Transcription failed for ${durSec.toFixed(1)} s of audio: ${msg}`);
        // Retry once after the engine restarts; audio is kept in memory until then.
        if (!job.retried) {
          job.retried = true;
          await new Promise((r) => setTimeout(r, 2000));
          if (generation !== this.generation) return;
          this.finals.unshift(job);
        }
      }
    }
  }
}
