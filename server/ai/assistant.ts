import type { FrameRow, OutputRow, SegmentRow, Store } from '../db.ts';
import type { Depth, Effort } from '../settings.ts';
import { AsyncQueue, fmtT, log, parseT, termKey, uid } from '../util.ts';
import {
  digests, keywords, latestOverview, renderDigests, renderOverview, renderSegments, retrieve, totalChars, undigestedChunks,
  RECENT_WINDOW_MS, TOTAL_RAW_BUDGET, type OverviewData,
} from './context.ts';
import {
  askInstructions, autoExplainInstructions, AUTO_EXPLAIN_SCHEMA, baseRules, catchupInstructions, digestInstructions,
  explainInstructions, handoffInstructions, HANDOFF_SCHEMA, languageRule, overviewInstructions, OVERVIEW_SCHEMA, renderProfile, summaryInstructions,
} from './prompts.ts';
import { ProviderError, parseJsonLoose, type CompletionRequest } from './provider.ts';
import type { ProviderRegistry } from './registry.ts';
import { sessionStyle, sessionTypeName } from '../../shared/session-types.ts';
import { splitCategory } from '../../shared/question-category.ts';
import type { HandoffSource } from '../projects/handoff-model.ts';

export type Broadcast = (event: string, data: unknown) => void;
export type CatchupScope = '2m' | '5m' | 'all';
export interface Selection { fromT: number; toT: number; text: string }

interface Built {
  instructions: string; input: string; coveredFrom: number | null; coveredTo: number | null;
  schema?: Record<string, unknown>; effort: CompletionRequest['effort']; extra?: Record<string, unknown>;
  /** If set, no model call is needed: this is the final content. */
  direct?: string;
  images?: Array<{ path: string; label: string }>;
}

export interface VisualSource {
  framesFor(sessionId: string, fromT: number, toT: number): FrameRow[];
  snapshotNow(sessionId: string): Promise<FrameRow | null>;
}
type ImagePick = { kind: 'ids'; ids: number[] } | { kind: 'around'; fromT: number; toT: number } | { kind: 'now' } | { kind: 'range'; fromT: number; toT: number } | { kind: 'spread'; max: number };

const PRIO = { manual: 10, summary: 8, overview: 2, auto: 1 };
/** Cards in the assistant column, which records the meeting time each was asked at. */
const TIMELINE_KINDS = new Set(['catchup', 'answer', 'explain', 'final_summary']);
const AUTO_FREQ = { low: { cooldownMs: 180_000, maxPer10: 2 }, medium: { cooldownMs: 90_000, maxPer10: 4 }, high: { cooldownMs: 45_000, maxPer10: 6 } } as const;

export function publicOutput(o: OutputRow): Record<string, unknown> {
  const parse = (s: string | null) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
  return { ...o, selection: parse(o.selection_json), data: parse(o.data_json), selection_json: undefined, data_json: undefined };
}

const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
const REF_RE = new RegExp(String.raw`\[(${TIME}(?:\s*[–—-]\s*${TIME})?(?:\s*[,;，、]\s*${TIME}(?:\s*[–—-]\s*${TIME})?)*)\]`, 'g');

/** Find citations ([m:ss], [m:ss–m:ss], or comma-separated groups) and check each time points at real transcript. */
export function checkRefs(text: string, segs: SegmentRow[]): { total: number; invalid: string[] } {
  const invalid: string[] = [];
  let total = 0;
  for (const m of text.matchAll(REF_RE)) {
    for (const part of m[1].split(/\s*[,;，、]\s*/)) {
      total++;
      for (const t of part.split(/\s*[–—-]\s*/)) {
        const ms = parseT(t);
        if (ms === null || !segs.some((s) => ms >= s.t_start - 15_000 && ms <= s.t_end + 15_000)) invalid.push(t);
      }
    }
  }
  return { total, invalid };
}

export class Assistant {
  private store: Store;
  private registry: ProviderRegistry;
  private broadcast: Broadcast;
  private queue = new AsyncQueue(2);
  private controllers = new Map<string, AbortController>();
  private pendingSettlers = new Map<string, () => void>();
  private autoEpoch = 0;
  private autoInflight: AbortController | null = null;
  private autoCheck = new Map<string, { wall: number; t: number }>();
  private autoCardWalls: number[] = [];
  private overviewInflight = new Map<string, Set<symbol>>();
  private lastOverviewWall = new Map<string, number>();
  private backoffUntil = 0;
  /** Counters exposed for tests and the UI. */
  stats = { suppressedAuto: 0, autoRequests: 0 };
  /** Called when any output finishes (used by integrations such as the mybot export). */
  onOutputDone: (row: OutputRow) => void = () => {};
  /** Window captures (slides / shared screen); set by the server once the session manager exists. */
  visual: VisualSource | null = null;
  /** Earlier agent sessions in the meeting's project (through mybot), for questions asked with project context on. */
  projectContext: ((sessionId: string, query: string, signal: AbortSignal) => Promise<{ text: string; meta: unknown }>) | null = null;
  /** The session clock while the session is being recorded; null otherwise. */
  clock: ((sessionId: string) => number | null) | null = null;

  constructor(store: Store, registry: ProviderRegistry, broadcast: Broadcast) {
    this.store = store; this.registry = registry; this.broadcast = broadcast;
  }

  private settings() { return this.store.getSettings(); }
  /**
   * Reasoning effort: background work uses the (low) background setting; your requests use the per-request
   * choice, else the default from Settings; 'auto' keeps fast per-task defaults.
   */
  private effort(kind: 'catchup' | 'answer' | 'explain' | 'summary' | 'background', depth?: Depth | null, override?: Effort | 'auto' | null): Effort {
    const ai = this.settings().ai;
    if (kind === 'background') return ai.backgroundEffort;
    const pick = override && override !== 'auto' ? override : ai.effort;
    if (pick !== 'auto') return pick;
    if (kind === 'summary') return 'medium';
    if (kind === 'catchup') return 'low';
    return depth === 'quick' ? 'low' : 'medium';
  }
  private profile() { return this.store.getProfile(); }
  private system(sessionId: string, task: string): string {
    const s = this.store.getSession(sessionId);
    const p = this.profile();
    return [baseRules(sessionStyle(this.settings().sessionTypes, s?.type)), task, renderProfile(p), languageRule(p)].join('\n\n');
  }
  private header(sessionId: string): string {
    const s = this.store.getSession(sessionId);
    return `SESSION: "${s?.title ?? ''}" — ${sessionTypeName(this.settings().sessionTypes, s?.type)}`;
  }

  // ------------------------------------------------------------------ generic runner
  private start(o: {
    sessionId: string; kind: string; prio: number; question?: string | null; selection?: Selection | null; scope?: string | null;
    depth?: Depth | null; parentId?: string | null; build: (signal: AbortSignal) => Promise<Built>;
    finalize?: (text: string, built: Built) => { content: string; data?: Record<string, unknown> };
    after?: (row: OutputRow) => void;
    onSettled?: () => void;
  }): string {
    const id = uid('o_');
    // Where the meeting was when the user asked; not recorded for requests made after it (reviewing).
    const askedT = TIMELINE_KINDS.has(o.kind) ? this.clock?.(o.sessionId) ?? null : null;
    const asked = askedT != null ? { askedT } : {};
    const row = this.store.insertOutput({
      id, session_id: o.sessionId, kind: o.kind, status: 'pending', question: o.question ?? null,
      selection_json: o.selection ? JSON.stringify(o.selection) : null, scope: o.scope ?? null, depth: o.depth ?? null, parent_id: o.parentId ?? null,
      data_json: askedT != null ? JSON.stringify(asked) : null,
    });
    this.broadcast('ai', publicOutput(row));
    const controller = new AbortController();
    this.controllers.set(id, controller);
    // Queued cancellations settle immediately; the queue callback must not settle a replacement again.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      this.controllers.delete(id);
      this.pendingSettlers.delete(id);
      o.onSettled?.();
    };
    this.pendingSettlers.set(id, settle);
    this.queue.push(async () => {
      let pendingDelta = '';
      let flushTimer: NodeJS.Timeout | null = null;
      const flush = () => {
        if (pendingDelta && !controller.signal.aborted) this.broadcast('ai-delta', { id, delta: pendingDelta });
        pendingDelta = ''; flushTimer = null;
      };
      try {
        if (controller.signal.aborted) return;
        this.pendingSettlers.delete(id);
        this.update(id, { status: 'streaming' });
        const built = await o.build(controller.signal);
        if (controller.signal.aborted) throw new ProviderError('aborted', 'Request cancelled.');
        let text: string;
        let meta = { provider: 'local', model: null as string | null, billing: 'none', effort: null as string | null };
        if (built.direct !== undefined) text = built.direct;
        else {
          const r = await this.registry.complete({
            task: o.kind, instructions: built.instructions, input: built.input, jsonSchema: built.schema, effort: built.effort, signal: controller.signal, images: built.images,
            onDelta: built.schema ? undefined : (d) => { if (!controller.signal.aborted) { pendingDelta += d; flushTimer ??= setTimeout(flush, 120); } },
          });
          text = r.text; meta = { provider: r.provider, model: r.model, billing: r.billing, effort: r.effort !== undefined ? r.effort : built.effort ?? null };
        }
        if (controller.signal.aborted) throw new ProviderError('aborted', 'Request cancelled.');
        if (flushTimer) { clearTimeout(flushTimer); flush(); }
        const fin = o.finalize ? o.finalize(text, built) : { content: text };
        const segs = built.coveredFrom != null ? this.store.segments(o.sessionId) : [];
        const refCheck = checkRefs(fin.content, segs);
        this.update(id, {
          status: 'done', content: fin.content, covered_from: built.coveredFrom, covered_to: built.coveredTo,
          data_json: JSON.stringify({ ...asked, ...(built.extra ?? {}), ...(fin.data ?? {}), refCheck, effort: meta.effort }),
          provider: meta.provider, model: meta.model, billing: meta.billing, completed_at: Date.now(),
        });
        this.backoffUntil = 0;
        o.after?.(this.store.getOutput(id)!);
        this.onOutputDone(this.store.getOutput(id)!);
      } catch (e) {
        if (flushTimer) clearTimeout(flushTimer);
        const err = e as ProviderError;
        const kind = err instanceof ProviderError ? err.kind : 'bad_response';
        const message = kind === 'aborted' ? 'Cancelled.' : `${err.message}${['quota', 'quota_gate', 'auth', 'network', 'unavailable'].includes(kind) ? ' Transcription continues and nothing captured is lost.' : ''}`;
        if (['quota', 'quota_gate', 'auth', 'unavailable', 'network'].includes(kind)) this.backoffUntil = Date.now() + 120_000;
        log('ai', `${o.kind} failed (${kind}): ${err.message}`);
        this.update(id, { status: kind === 'aborted' ? 'cancelled' : 'error', error: message, data_json: JSON.stringify({ ...asked, errorKind: kind }), completed_at: Date.now() });
      } finally {
        settle();
      }
    }, o.prio);
    return id;
  }

  private update(id: string, patch: Partial<OutputRow>): void {
    this.store.updateOutput(id, patch);
    const row = this.store.getOutput(id);
    if (row) this.broadcast('ai', publicOutput(row));
  }

  cancel(id: string): boolean {
    const c = this.controllers.get(id);
    if (!c) return false;
    c.abort();
    const row = this.store.getOutput(id);
    if (row && row.status === 'pending') this.update(id, { status: 'cancelled', error: 'Cancelled.', completed_at: Date.now() });
    this.pendingSettlers.get(id)?.();
    return true;
  }

  private complete(req: CompletionRequest) { return this.registry.complete(req); }

  private speakerRevision(sessionId: string): number {
    return (this.store.db.prepare("SELECT COALESCE(MAX(id), 0) AS revision FROM timeline WHERE session_id = ? AND kind = 'speaker_labels_changed'").get(sessionId) as { revision: number }).revision;
  }

  // ------------------------------------------------------------------ digests (rolling memory for long sessions)
  /** Summarise transcript chunks that have no digest yet, so long sessions never send the full transcript. */
  private async ensureDigests(sessionId: string, upTo: number, signal: AbortSignal): Promise<void> {
    for (const chunk of undigestedChunks(this.store, sessionId, upTo)) {
      if (signal.aborted) throw new ProviderError('aborted', 'Request cancelled.');
      const speakerRevision = this.speakerRevision(sessionId);
      const r = renderSegments(chunk, 16_000);
      const res = await this.complete({ task: 'digest', instructions: this.system(sessionId, digestInstructions()), input: `${this.header(sessionId)}\n\nTRANSCRIPT CHUNK:\n${r.text}`, effort: this.effort('background'), signal });
      if (speakerRevision !== this.speakerRevision(sessionId)) throw new ProviderError('aborted', 'Speaker labels changed. Regenerate the response to use the updated names.');
      this.store.insertOutput({ id: uid('o_'), session_id: sessionId, kind: 'digest', status: 'done', content: res.text.trim(), covered_from: chunk[0].t_start, covered_to: chunk[chunk.length - 1].t_end, provider: res.provider, model: res.model, billing: res.billing, completed_at: Date.now() });
    }
  }

  /**
   * Choose screen captures to show the model. Returns the images plus a text block describing them
   * (or explaining why none were sent), and the frame ids used (shown on the answer card).
   */
  private async pickImages(sessionId: string, pick: ImagePick): Promise<{ images: Array<{ path: string; label: string }>; text: string; used: Array<{ id: number; t: number }> }> {
    const none = { images: [], text: '', used: [] as Array<{ id: number; t: number }> };
    if (!this.visual) return none;
    const all = this.visual.framesFor(sessionId, -1e15, 1e15);
    const capturing = pick.kind === 'now' || pick.kind === 'range';
    if (!all.length && !capturing) return none;
    if (!this.settings().screen.sendImagesToAI) return all.length ? { ...none, text: 'SCREEN CAPTURES: some exist for this session but sending images is turned off in Settings, so visuals are not available to you.' } : none;
    if (!this.registry.active.supportsImages) return all.length ? { ...none, text: 'SCREEN CAPTURES: some exist for this session but the selected AI provider cannot receive images, so visuals are not available to you.' } : none;
    let chosen: FrameRow[] = [];
    if (pick.kind === 'ids') chosen = all.filter((f) => pick.ids.includes(f.id)).slice(0, 3);
    else if (pick.kind === 'around') chosen = all.filter((f) => f.t >= pick.fromT - 180_000 && f.t <= pick.toT + 15_000).slice(-2);
    else if (pick.kind === 'spread') {
      const slides = all.filter((f) => f.kind === 'slide');
      const n = Math.min(pick.max, slides.length);
      chosen = Array.from({ length: n }, (_, i) => slides[Math.floor((i * slides.length) / n)]);
    } else {
      const snap = await this.visual.snapshotNow(sessionId).catch(() => null);
      const fresh = this.visual.framesFor(sessionId, -1e15, 1e15);
      const pool = pick.kind === 'range' ? fresh.filter((f) => f.t >= pick.fromT && f.t <= pick.toT + 5000) : fresh.slice(-3);
      chosen = pool.filter((f) => f.id !== snap?.id && f.kind === 'slide').slice(snap ? -1 : -2);
      if (snap) chosen.push(snap);
    }
    if (!chosen.length) return none;
    const images = chosen.map((f, i) => ({ path: f.path, label: `${i + 1}. [${fmtT(f.t)}] ${f.app ?? ''}${f.window_title ? ` — “${f.window_title}”` : ''}${f.kind === 'snapshot' ? ' (captured just now)' : ' (screen changed here)'}` }));
    return {
      images,
      text: `SCREEN CAPTURES ATTACHED (shown to you as images, in this order):\n${images.map((im) => im.label).join('\n')}`,
      used: chosen.map((f) => ({ id: f.id, t: f.t })),
    };
  }

  private earlierNotes(sessionId: string, beforeT: number, maxChars = 6000): string {
    const ov = latestOverview(this.store, sessionId);
    const ds = renderDigests(digests(this.store, sessionId), beforeT);
    let notes = `${renderOverview(ov?.data)}${ds ? `\nNotes on earlier parts:\n${ds}` : ''}`;
    if (notes.length > maxChars) notes = notes.slice(notes.length - maxChars);
    return notes;
  }

  private liveEnd(sessionId: string): number {
    return this.store.lastSegment(sessionId)?.t_end ?? 0;
  }

  // ------------------------------------------------------------------ catch-up
  catchup(sessionId: string, scope: CatchupScope, parentId?: string, effortOverride?: Effort | 'auto' | null): string {
    const eff = () => this.effort('catchup', null, effortOverride);
    return this.start({
      sessionId, kind: 'catchup', prio: PRIO.manual, scope, parentId,
      question: scope === 'all' ? 'What has been covered so far?' : `What happened in the last ${scope === '2m' ? 'two' : 'five'} minutes?`,
      build: async (signal) => {
        const end = this.liveEnd(sessionId);
        const all = this.store.segments(sessionId);
        if (!all.length) return { instructions: '', input: '', coveredFrom: null, coveredTo: null, effort: 'low', direct: 'Nothing has been transcribed yet.' };
        if (scope === 'all') {
          const vis = await this.pickImages(sessionId, { kind: 'range', fromT: end - 300_000, toT: end });
          if (totalChars(all) <= TOTAL_RAW_BUDGET) {
            const r = renderSegments(all, TOTAL_RAW_BUDGET);
            return { instructions: this.system(sessionId, catchupInstructions()), input: `${this.header(sessionId)}\nScope: the whole session so far.${vis.text ? `\n\n${vis.text}` : ''}\n\nTRANSCRIPT [${fmtT(r.from!)}–${fmtT(r.to!)}]:\n${r.text}`, coveredFrom: all[0].t_start, coveredTo: end, effort: eff(), images: vis.images, extra: { images: vis.used } };
          }
          const recentFrom = end - RECENT_WINDOW_MS;
          await this.ensureDigests(sessionId, recentFrom, signal);
          const recent = renderSegments(this.store.segments(sessionId, recentFrom, end), 14_000);
          return {
            instructions: this.system(sessionId, catchupInstructions()),
            input: `${this.header(sessionId)}\nScope: the whole session so far.${vis.text ? `\n\n${vis.text}` : ''}\n\nNOTES ON EARLIER PARTS (AI-generated digests with times):\n${renderDigests(digests(this.store, sessionId), recentFrom)}\n\nMOST RECENT TRANSCRIPT [${fmtT(recent.from ?? recentFrom)}–${fmtT(end)}]:\n${recent.text}`,
            coveredFrom: all[0].t_start, coveredTo: end, effort: eff(), images: vis.images, extra: { usedDigests: true, images: vis.used },
          };
        }
        const win = scope === '2m' ? 120_000 : 300_000;
        const from = Math.max(0, end - win);
        const segs = this.store.segments(sessionId, from, end);
        if (!segs.length) return { instructions: '', input: '', coveredFrom: from, coveredTo: end, effort: 'low', direct: `Nothing was transcribed between [${fmtT(from)}] and [${fmtT(end)}].` };
        const r = renderSegments(segs, 16_000);
        const vis = await this.pickImages(sessionId, { kind: 'range', fromT: from, toT: end });
        const earlierRaw = digests(this.store, sessionId).length ? '' : renderSegments(this.store.segments(sessionId, from - 300_000, from - 1).filter((s) => s.t_end < from), 5000).text;
        return {
          instructions: this.system(sessionId, catchupInstructions()),
          input: `${this.header(sessionId)}\nScope: the last ${win / 60000} minutes.\n\nEARLIER DISCUSSION (for connections only):\n${this.earlierNotes(sessionId, from)}${earlierRaw ? `\nEarlier transcript (verbatim):\n${earlierRaw}` : ''}${vis.text ? `\n\n${vis.text}` : ''}\n\nTRANSCRIPT TO CATCH UP ON [${fmtT(segs[0].t_start)}–${fmtT(end)}]:\n${r.text}`,
          coveredFrom: segs[0].t_start, coveredTo: end, effort: eff(), images: vis.images, extra: { images: vis.used },
        };
      },
    });
  }

  // ------------------------------------------------------------------ questions & explanations
  private contextFor(sessionId: string, query: string, selection: Selection | null): { text: string; from: number; to: number; retrieved: number[] } {
    const end = this.liveEnd(sessionId);
    const parts: string[] = [];
    let from: number, to: number;
    if (selection) {
      from = Math.max(0, selection.fromT - 90_000); to = Math.min(end, selection.toT + 60_000);
      const around = renderSegments(this.store.segments(sessionId, from, to), 9000);
      parts.push(`TRANSCRIPT AROUND THE SELECTION [${fmtT(around.from ?? from)}–${fmtT(around.to ?? to)}]:\n${around.text}`);
      if (end - to > 30_000) {
        const recent = renderSegments(this.store.segments(sessionId, Math.max(to, end - 180_000), end), 5000);
        parts.push(`MOST RECENT TRANSCRIPT (the conversation has moved on):\n${recent.text}`);
      }
      parts.push(`SELECTED PASSAGE (highlighted by the user) [${fmtT(selection.fromT)}–${fmtT(selection.toT)}]:\n"${selection.text.slice(0, 3000)}"`);
    } else {
      from = Math.max(0, end - 300_000); to = end;
      const recent = renderSegments(this.store.segments(sessionId, from, to), 12_000);
      parts.push(`RECENT TRANSCRIPT [${fmtT(recent.from ?? from)}–${fmtT(end)}]:\n${recent.text}`);
    }
    const older = retrieve(this.store, sessionId, `${query} ${selection?.text ?? ''}`, [from, to], 8);
    if (older.length) parts.unshift(`RELEVANT EARLIER PASSAGES (keyword matches):\n${renderSegments(older, 4000).text}`);
    parts.unshift(`EARLIER DISCUSSION NOTES (AI-generated, may be imperfect):\n${this.earlierNotes(sessionId, from, 4000)}`);
    return { text: parts.join('\n\n'), from, to, retrieved: older.map((s) => s.t_start) };
  }

  /** `opts.projectContext`: also search the project's earlier agent sessions (scope 'project' keeps it on retry). */
  ask(sessionId: string, question: string, selection: Selection | null, depth: Depth, frameIds: number[] = [], effortOverride?: Effort | 'auto' | null, opts: { projectContext?: boolean } = {}): string {
    const withProject = !!opts.projectContext && !!this.projectContext;
    return this.start({
      sessionId, kind: 'answer', prio: PRIO.manual, question, selection, depth, scope: withProject ? 'project' : null,
      finalize: (text) => {
        const { category, body } = splitCategory(text);
        return { content: body, data: category ? { category } : undefined };
      },
      build: async (signal) => {
        const c = this.contextFor(sessionId, question, selection);
        if (c.to <= 0 && !selection && !frameIds.length && !withProject) return { instructions: '', input: '', coveredFrom: null, coveredTo: null, effort: 'low', direct: 'Nothing has been transcribed yet, so there is no context to answer from.' };
        const [vis, project] = await Promise.all([
          this.pickImages(sessionId, frameIds.length ? { kind: 'ids', ids: frameIds } : selection ? { kind: 'around', fromT: selection.fromT, toT: selection.toT } : { kind: 'now' }),
          withProject ? this.projectContext!(sessionId, `${question} ${selection?.text.slice(0, 200) ?? ''}`, signal) : null,
        ]);
        if (c.to <= 0 && !selection && !frameIds.length && !project?.text) return { instructions: '', input: '', coveredFrom: null, coveredTo: null, effort: 'low', direct: 'Nothing has been transcribed yet, and no related earlier sessions were found in this project, so there is no context to answer from.', extra: { projectContext: project?.meta } };
        return { instructions: this.system(sessionId, askInstructions(depth)), input: `${this.header(sessionId)}\n\n${c.text}${vis.text ? `\n\n${vis.text}` : ''}${project?.text ? `\n\n${project.text}` : ''}\n\nUSER QUESTION: ${question}`, coveredFrom: c.from, coveredTo: c.to, effort: this.effort('answer', depth, effortOverride), images: vis.images, extra: { retrieved: c.retrieved, images: vis.used, ...(project ? { projectContext: project.meta } : {}) } };
      },
    });
  }

  explain(sessionId: string, term: string, selection: Selection | null, depth: Depth, parentId?: string, effortOverride?: Effort | 'auto' | null): string {
    this.store.addExplainedTerm(sessionId, termKey(term), term, null, selection?.fromT ?? null, 'manual');
    return this.start({
      sessionId, kind: 'explain', prio: PRIO.manual, question: term, selection, depth, parentId,
      build: async () => {
        const c = this.contextFor(sessionId, term, selection);
        const vis = await this.pickImages(sessionId, selection ? { kind: 'around', fromT: selection.fromT, toT: selection.toT } : { kind: 'now' });
        return { instructions: this.system(sessionId, explainInstructions(depth)), input: `${this.header(sessionId)}\n\n${c.text}${vis.text ? `\n\n${vis.text}` : ''}\n\nTERM TO EXPLAIN: ${term}`, coveredFrom: c.from, coveredTo: c.to, effort: this.effort('explain', depth, effortOverride), images: vis.images, extra: { term, images: vis.used } };
      },
    });
  }

  /** Re-run a catch-up / recap with the same parameters up to "now" (explicit user action). */
  refresh(outputId: string): string | null {
    const o = this.store.getOutput(outputId);
    if (!o) return null;
    if (o.kind === 'catchup') return this.catchup(o.session_id, (o.scope as CatchupScope) ?? '2m', o.id);
    if (o.kind === 'overview') return this.overview(o.session_id, true);
    if (o.kind === 'final_summary') return this.summary(o.session_id);
    if (o.kind === 'answer') return this.ask(o.session_id, o.question ?? '', o.selection_json ? JSON.parse(o.selection_json) : null, (o.depth as Depth) ?? 'standard', [], null, { projectContext: o.scope === 'project' });
    if (o.kind === 'explain' || o.kind === 'auto_explain') return this.explain(o.session_id, o.question ?? '', o.selection_json ? JSON.parse(o.selection_json) : null, (o.depth as Depth) ?? 'standard', o.id);
    return null;
  }

  // ------------------------------------------------------------------ running overview
  overview(sessionId: string, manual = false): string {
    const token = Symbol('overview');
    const inflight = this.overviewInflight.get(sessionId) ?? new Set<symbol>();
    inflight.add(token);
    this.overviewInflight.set(sessionId, inflight);
    this.lastOverviewWall.set(sessionId, Date.now());
    return this.start({
      sessionId, kind: 'overview', prio: manual ? PRIO.manual : PRIO.overview, question: manual ? 'Recap now' : null,
      build: async (signal) => {
        const prev = latestOverview(this.store, sessionId);
        const sinceT = prev?.covered_to ?? -1;
        let fresh = this.store.segmentsAfter(sessionId, sinceT);
        if (!fresh.length) {
          if (prev) return { instructions: '', input: '', coveredFrom: prev.covered_from, coveredTo: prev.covered_to, effort: 'low', direct: prev.content ?? '', extra: { ...prev.data, unchanged: true } };
          return { instructions: '', input: '', coveredFrom: null, coveredTo: null, effort: 'low', direct: 'Nothing has been transcribed yet.', extra: { current_topic: '', overview: [], topics: [], open_question: '' } };
        }
        if (totalChars(fresh) > 16_000) {
          // Too much new text (e.g. overview was off): digest the older part first.
          const cut = fresh[fresh.length - 1].t_end - 5 * 60_000;
          await this.ensureDigests(sessionId, cut, signal);
          fresh = fresh.filter((s) => s.t_start >= cut);
        }
        const r = renderSegments(fresh, 16_000);
        const first = this.store.firstSegment(sessionId)!;
        return {
          instructions: this.system(sessionId, overviewInstructions()),
          input: `${this.header(sessionId)}\n\nPREVIOUS OVERVIEW:\n${renderOverview(prev?.data)}\n\nNOTES ON EARLIER PARTS:\n${renderDigests(digests(this.store, sessionId), fresh[0].t_start).slice(-5000) || '(none)'}\n\nNEW TRANSCRIPT [${fmtT(fresh[0].t_start)}–${fmtT(fresh[fresh.length - 1].t_end)}]:\n${r.text}`,
          coveredFrom: first.t_start, coveredTo: fresh[fresh.length - 1].t_end, schema: OVERVIEW_SCHEMA as unknown as Record<string, unknown>, effort: this.effort('background'),
          extra: { chunkFrom: fresh[0].t_start, speakerRevision: this.speakerRevision(sessionId) },
        };
      },
      finalize: (text, built) => {
        if (built.direct !== undefined) return { content: text, data: built.extra };
        const d = parseJsonLoose<OverviewData>(text);
        if (!d || typeof d.current_topic !== 'string' || !Array.isArray(d.overview)) throw new ProviderError('bad_response', 'The model returned an overview in an unexpected format.', true);
        const md = `**${d.current_topic}**\n\n${d.overview.map((b) => `- ${b}`).join('\n')}${d.open_question ? `\n\n*Open question:* ${d.open_question}` : ''}`;
        if (d.digest && built.extra?.chunkFrom != null && built.extra.speakerRevision === this.speakerRevision(sessionId)) {
          this.store.insertOutput({ id: uid('o_'), session_id: sessionId, kind: 'digest', status: 'done', content: d.digest, covered_from: built.extra.chunkFrom as number, covered_to: built.coveredTo, completed_at: Date.now() });
        }
        return { content: md, data: d as unknown as Record<string, unknown> };
      },
      onSettled: () => {
        inflight.delete(token);
        if (!inflight.size && this.overviewInflight.get(sessionId) === inflight) this.overviewInflight.delete(sessionId);
      },
    });
  }

  /** Called for each committed transcript segment and at meaningful pauses. */
  onActivity(sessionId: string, reason: 'segment' | 'pause'): void {
    const s = this.settings();
    if (Date.now() < this.backoffUntil) return;
    const st = this.registry.cachedStatus();
    if (st && !st.ready) return;
    if (s.assist.autoOverview && !this.overviewInflight.has(sessionId)) {
      const prev = latestOverview(this.store, sessionId);
      const fresh = this.store.segmentsAfter(sessionId, prev?.covered_to ?? -1);
      const chars = totalChars(fresh);
      const since = Date.now() - (this.lastOverviewWall.get(sessionId) ?? 0);
      const firstOne = !prev && chars >= 400;
      const shifted = chars >= 800 && since >= 45_000 && this.topicShift(sessionId);
      if ((reason === 'pause' && chars >= 500 && since >= 45_000) || (chars >= 2500 && since >= 60_000) || (firstOne && since >= 30_000) || shifted) {
        this.overview(sessionId);
      }
    }
    if (reason === 'segment') this.maybeAutoExplain(sessionId);
  }

  /** Cheap topic-change signal: the last minute shares few keywords with the three minutes before it. */
  private topicShift(sessionId: string): boolean {
    const end = this.liveEnd(sessionId);
    const recent = this.store.segments(sessionId, end - 60_000, end).map((x) => x.text).join(' ');
    const before = this.store.segments(sessionId, end - 240_000, end - 60_000).map((x) => x.text).join(' ');
    if (recent.length < 300 || before.length < 600) return false;
    const a = new Set(keywords(recent, 25).map((k) => k.toLowerCase()));
    const b = new Set(keywords(before, 40).map((k) => k.toLowerCase()));
    let shared = 0;
    for (const k of a) if (b.has(k)) shared++;
    return a.size >= 5 && shared / a.size < 0.15;
  }

  // ------------------------------------------------------------------ automatic background explanations
  get autoExplainEpoch(): number { return this.autoEpoch; }

  /** Turning auto-explain off invalidates queued and in-flight work: late results are dropped, never shown. */
  setAutoExplain(enabled: boolean): void {
    this.autoEpoch++;
    if (!enabled && this.autoInflight) { this.autoInflight.abort(); this.autoInflight = null; }
  }

  maybeAutoExplain(sessionId: string, force = false): boolean {
    const s = this.settings();
    if (!s.assist.autoExplain || this.autoInflight) return false;
    const freq = AUTO_FREQ[s.assist.autoExplainFrequency] ?? AUTO_FREQ.medium;
    const last = this.autoCheck.get(sessionId) ?? { wall: 0, t: -1 };
    const now = Date.now();
    this.autoCardWalls = this.autoCardWalls.filter((w) => now - w < 600_000);
    if (!force) {
      if (now - last.wall < freq.cooldownMs) return false;
      if (this.autoCardWalls.length >= freq.maxPer10) return false;
    }
    const end = this.liveEnd(sessionId);
    const fresh = this.store.segmentsAfter(sessionId, last.t);
    if (!force && totalChars(fresh) < 300) return false;
    if (!fresh.length) return false;
    this.autoCheck.set(sessionId, { wall: now, t: end });
    const epoch = this.autoEpoch;
    const controller = new AbortController();
    this.autoInflight = controller;
    this.stats.autoRequests++;
    const maxCards = Math.max(1, Math.min(2, freq.maxPer10 - this.autoCardWalls.length));
    this.queue.push(async () => {
      const stale = () => epoch !== this.autoEpoch || !this.settings().assist.autoExplain || controller.signal.aborted;
      try {
        if (stale()) { this.stats.suppressedAuto++; return; }
        const known = [...this.store.explainedTerms(sessionId).map((t) => t.term), ...this.profile().knownConcepts];
        const ctxFrom = Math.max(fresh[0].t_start - 20_000, end - 180_000);
        const r = renderSegments(this.store.segments(sessionId, ctxFrom, end), 7000);
        const ov = latestOverview(this.store, sessionId);
        const res = await this.complete({
          task: 'auto_explain', instructions: this.system(sessionId, autoExplainInstructions(maxCards)), effort: this.effort('background'), signal: controller.signal,
          jsonSchema: AUTO_EXPLAIN_SCHEMA as unknown as Record<string, unknown>,
          input: `${this.header(sessionId)}\nCurrent topic: ${ov?.data.current_topic ?? 'unknown'}\n\nALREADY EXPLAINED OR KNOWN (skip these and synonyms): ${known.join('; ') || '(none)'}\n\nNEW TRANSCRIPT [${fmtT(r.from ?? ctxFrom)}–${fmtT(end)}]:\n${r.text}`,
        });
        const parsed = parseJsonLoose<{ cards: Array<{ term: string; why_it_matters: string; importance: number; explanation_md: string; evidence_time: string }> }>(res.text);
        const cards = (parsed?.cards ?? []).filter((c) => c && c.term && c.explanation_md);
        for (const c of cards) {
          const key = termKey(c.term);
          const knownKeys = known.map(termKey);
          const dup = knownKeys.some((k) => k === key || (k.length > 3 && (k.includes(key) || key.includes(k))));
          const t = parseT(c.evidence_time ?? '') ?? end;
          if (stale()) {
            // Arrived after the switch was turned off: keep an audit row, never show it.
            this.stats.suppressedAuto++;
            this.store.insertOutput({ id: uid('o_'), session_id: sessionId, kind: 'auto_explain', status: 'suppressed', question: c.term, content: c.explanation_md, auto_epoch: epoch, covered_from: t, covered_to: t, completed_at: Date.now() });
            continue;
          }
          if (dup || (c.importance ?? 0) < 3) continue;
          if (!this.store.addExplainedTerm(sessionId, key, c.term, null, t, 'auto')) continue;
          this.autoCardWalls.push(Date.now());
          const row = this.store.insertOutput({
            id: uid('o_'), session_id: sessionId, kind: 'auto_explain', status: 'done', question: c.term, depth: 'quick',
            content: c.explanation_md, auto_epoch: epoch, covered_from: t, covered_to: t,
            data_json: JSON.stringify({ term: c.term, why: c.why_it_matters, importance: c.importance, evidence_time: c.evidence_time }),
            provider: res.provider, model: res.model, billing: res.billing, completed_at: Date.now(),
          });
          this.broadcast('ai', publicOutput(row));
        }
      } catch (e) {
        const err = e as ProviderError;
        if (err.kind === 'aborted') { this.stats.suppressedAuto++; return; }
        if (['quota', 'quota_gate', 'auth', 'network', 'unavailable'].includes(err.kind)) this.backoffUntil = Date.now() + 120_000;
        log('ai', `auto-explain failed: ${err.message}`);
      } finally {
        if (this.autoInflight === controller) this.autoInflight = null;
      }
    }, PRIO.auto);
    return true;
  }

  // ------------------------------------------------------------------ final summary
  summary(sessionId: string, effortOverride?: Effort | 'auto' | null): string {
    return this.start({
      sessionId, kind: 'final_summary', prio: PRIO.summary, question: 'Final summary',
      build: async (signal) => {
        const s = this.store.getSession(sessionId)!;
        const all = this.store.segments(sessionId);
        if (!all.length) return { instructions: '', input: '', coveredFrom: null, coveredTo: null, effort: 'low', direct: 'No transcript was captured in this session, so there is nothing to summarise.' };
        const end = all[all.length - 1].t_end;
        const gaps = this.store.timeline(sessionId).filter((e) => ['pause', 'gap', 'interrupted'].includes(e.kind))
          .map((e) => `- ${e.kind} at [${fmtT(e.t)}]${e.detail ? ` (${e.detail})` : ''}`).join('\n');
        let body: string;
        let usedDigests = false;
        if (totalChars(all) <= 60_000) {
          body = `FULL TRANSCRIPT [${fmtT(all[0].t_start)}–${fmtT(end)}]:\n${renderSegments(all, 62_000).text}`;
        } else {
          const recentFrom = end - RECENT_WINDOW_MS;
          await this.ensureDigests(sessionId, recentFrom, signal);
          usedDigests = true;
          body = `NOTES ON THE SESSION (AI-generated digests of the transcript, with times):\n${renderDigests(digests(this.store, sessionId), recentFrom)}\n\nFINAL ${RECENT_WINDOW_MS / 60000} MINUTES (verbatim):\n${renderSegments(this.store.segments(sessionId, recentFrom, end), 16_000).text}`;
        }
        const vis = await this.pickImages(sessionId, { kind: 'spread', max: 6 });
        return {
          instructions: this.system(sessionId, summaryInstructions(sessionStyle(this.settings().sessionTypes, s.type))),
          input: `${this.header(sessionId)}\n${gaps ? `RECORDING GAPS / PAUSES:\n${gaps}\n` : ''}${vis.text ? `\n${vis.text}\n` : ''}\n${body}`,
          coveredFrom: all[0].t_start, coveredTo: end, effort: this.effort('summary', null, effortOverride), images: vis.images, extra: { usedDigests, images: vis.used },
        };
      },
    });
  }

  // ------------------------------------------------------------------ project handoff draft
  /**
   * Draft the decisions, actions and open questions a meeting implies (structured JSON). The caller turns
   * the result into reviewable handoff items; nothing here is shown to an agent before the user confirms it.
   */
  handoffDraft(sessionId: string, o: { onResult: (row: OutputRow, parsed: unknown, captures: Array<{ id: number; t: number }>, source: HandoffSource) => void; onFail: (row: OutputRow) => void }): string {
    let captures: Array<{ id: number; t: number }> = [];
    let source: HandoffSource;
    const id = this.start({
      sessionId, kind: 'handoff', prio: PRIO.manual, question: 'Handoff draft',
      build: async (signal) => {
        const session = this.store.getSession(sessionId);
        if (!session) throw new ProviderError('aborted', 'The meeting was deleted.');
        const all = this.store.segments(sessionId);
        if (!all.length) throw new ProviderError('bad_response', 'This meeting has no transcript yet, so there is nothing to hand off.');
        source = { revision: session.revision, segmentMax: this.store.maxSegmentId(sessionId), projectId: session.project_id, capturedAt: Date.now() };
        const project = source.projectId ? this.store.getProject(source.projectId) : null;
        const end = all[all.length - 1].t_end;
        let body: string;
        if (totalChars(all) <= 60_000) body = `FULL TRANSCRIPT [${fmtT(all[0].t_start)}–${fmtT(end)}]:\n${renderSegments(all, 62_000).text}`;
        else {
          const recentFrom = end - RECENT_WINDOW_MS;
          await this.ensureDigests(sessionId, recentFrom, signal);
          body = `NOTES ON THE SESSION (AI-generated digests of the transcript, with times):\n${renderDigests(digests(this.store, sessionId), recentFrom)}\n\nFINAL ${RECENT_WINDOW_MS / 60000} MINUTES (verbatim):\n${renderSegments(all.filter((s) => s.t_end >= recentFrom), 16_000).text}`;
        }
        const vis = await this.pickImages(sessionId, { kind: 'spread', max: 4 });
        captures = vis.used;
        return {
          instructions: this.system(sessionId, handoffInstructions(project?.name ?? null)),
          input: `${this.header(sessionId)}\n${vis.text ? `\n${vis.text}\n` : ''}\n${body}`,
          coveredFrom: all[0].t_start, coveredTo: end, schema: HANDOFF_SCHEMA as unknown as Record<string, unknown>,
          effort: this.effort('summary'), images: vis.images, extra: { images: vis.used, handoffSource: source },
        };
      },
      finalize: (text) => {
        const parsed = parseJsonLoose<{ decisions?: unknown[]; actions?: unknown[]; open_questions?: unknown[] }>(text);
        if (!parsed) throw new ProviderError('bad_response', 'The AI provider returned a handoff that could not be read. Try again.');
        return { content: `Handoff draft: ${parsed.decisions?.length ?? 0} decision(s), ${parsed.actions?.length ?? 0} action(s), ${parsed.open_questions?.length ?? 0} open question(s).`, data: { handoff: parsed } };
      },
      after: (row) => o.onResult(row, JSON.parse(row.data_json ?? '{}').handoff, captures, source),
      onSettled: () => { const row = this.store.getOutput(id); if (row && row.status !== 'done') o.onFail(row); },
    });
    return id;
  }
}
