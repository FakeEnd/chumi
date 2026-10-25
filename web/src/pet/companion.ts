// The desktop pet's toolbar and cards: start, pause or end a meeting, catch up, ask, and read the latest answers
// and explanations without opening Chumi's window. Lives under the character in pet.html.

import { api } from '../api.ts';
import { locale, msg, t } from '../i18n.ts';
import { fmtT, renderMd } from '../util.ts';
import type { Output } from '../types.ts';
import { splitCategory } from '../../../shared/question-category.ts';
import { cardTitle, focusOf, preview, recent, tagCounts, when } from './recent.ts';
import { TAGS, tagOf, type Tag } from './tags.ts';

export interface CompanionHost {
  /** Speak through the pet (errors, hints). */
  say(text: string, tone?: 'info' | 'warn'): void;
  /** Bring Chumi's window forward, optionally at a meeting and a transcript time. */
  open(where?: { session: string; t?: number; t2?: number }): void;
  /** The ask box wants the keyboard (the panel normally never takes focus). */
  keyboard(on: boolean): void;
  /** Size or clickable areas changed. */
  changed(): void;
  /** The ⌄ button switched between the latest card and the recent ones (saved in Settings → Desktop pet). */
  setCards(cards: Cards): void;
  /** A tag chip above the cards was switched (saved in Settings → Desktop pet). */
  setTags(tags: Tag[]): void;
}

const TAG_LABEL: Record<Tag, string> = { meeting: msg('Meeting'), tangent: msg('Tangent'), background: msg('Background'), summary: msg('Summary') };

export type Cards = 'none' | 'latest' | 'recent';

type Card = Output & { stream?: string };

const svg = (body: string, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${extra}>${body}</svg>`;
const ICON = {
  wave: svg('<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>'),
  play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>'),
  spark: svg('<path d="M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z"/><path d="M19 15.5c.25 1.6.9 2.25 2.5 2.5-1.6.25-2.25.9-2.5 2.5-.25-1.6-.9-2.25-2.5-2.5 1.6-.25 2.25-.9 2.5-2.5z"/>'),
  pencil: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/>'),
  chevron: svg('<path d="M6 9l6 6 6-6"/>'),
  spin: svg('<circle cx="12" cy="12" r="9" stroke-opacity=".2"/><path d="M21 12a9 9 0 0 0-9-9"/>', ' class="spin"'),
};

export class Companion {
  readonly el = document.createElement('div');
  /** The live meeting, or the latest one when nothing is recording. */
  sessionId: string | null = null;
  private status = 'idle';
  private clock = { nowT: 0, at: 0 };
  private cards = new Map<string, Card>();
  private expanded = new Set<string>();
  private toolbar = true;
  private cardsMode: Cards = 'latest';
  private tags: Tag[] = [...TAGS];
  /** No meeting is on: cards are hidden unless the user asked to see the last meeting's (⌄, a bubble, a question). */
  private peek = false;
  /** Page px from the top of the page to the bottom of the screen (the app reports it); cards stop before it. */
  private room = 10_000;
  private get list(): boolean { return this.cardsMode === 'recent' || (this.peek && !this.live()); }
  private get showing(): boolean { return this.cardsMode !== 'none' && (this.live() || this.peek); }
  private asking = false;
  private confirmEnd = 0;
  private hovered: HTMLElement | null = null;
  private tick = 0;
  /** A click on an open card's text folds it after the double-click time, unless a second click selects a word. */
  private foldTimer = 0;
  private drawQueued = false;
  private bar = document.createElement('div');
  private ask = document.createElement('form');
  private input = document.createElement('input');
  private listEl = document.createElement('div');
  private tip = document.createElement('div');

  constructor(private host: CompanionHost) {
    this.el.className = 'companion';
    this.bar.className = 'bar ui';
    this.ask.className = 'ask ui';
    this.ask.hidden = true;
    this.input.maxLength = 2000;
    const send = document.createElement('button');
    send.type = 'submit';
    this.ask.append(this.input, send);
    this.listEl.className = 'cards ui';
    this.tip.className = 'tip';
    this.el.append(this.bar, this.ask, this.listEl, this.tip);

    this.bar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
      if (b && !b.disabled) void this.act(b.dataset.act!);
    });
    this.ask.addEventListener('submit', (e) => { e.preventDefault(); void this.submit(); });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeAsk(); });
    this.listEl.addEventListener('click', (e) => this.cardClick(e));
    this.render();
  }

  // ------------------------------------------------------------------ data
  setLive(live: { status?: string; session?: { id?: string } | null; nowT?: number } | null | undefined): void {
    const was = this.live();
    this.status = live?.status ?? 'idle';
    if (was !== this.live()) this.peek = false;
    this.clock = { nowT: Number(live?.nowT) || 0, at: Date.now() };
    const id = live?.session?.id;
    if (id && id !== this.sessionId) void this.load(id);
    clearInterval(this.tick);
    if (this.status === 'recording') this.tick = window.setInterval(() => this.updateClock(), 1000);
    this.render();
  }

  /** Nothing is recording: show the latest meeting's cards. */
  async loadLatest(): Promise<void> {
    try {
      const { sessions } = await api<{ sessions: Array<{ id: string; created_at: number }> }>('/api/sessions');
      const latest = [...sessions].sort((a, b) => b.created_at - a.created_at)[0];
      if (latest) await this.load(latest.id); else { this.sessionId = null; this.cards.clear(); this.render(); }
    } catch { /* the server is restarting; the next live event brings us back */ }
  }

  private async load(id: string): Promise<void> {
    this.sessionId = id;
    this.cards.clear();
    try {
      const d = await api<{ outputs: Output[] }>(`/api/sessions/${encodeURIComponent(id)}`);
      if (this.sessionId !== id) return;
      for (const o of d.outputs) this.cards.set(o.id, o);
    } catch { /* deleted meanwhile */ }
    this.render();
  }

  ai(o: Output): void {
    if (o.session_id !== this.sessionId) return;
    const prev = this.cards.get(o.id);
    this.cards.set(o.id, { ...o, stream: o.content ? undefined : prev?.stream });
    this.draw();
  }

  delta(d: { id: string; delta: string }): void {
    const c = this.cards.get(d.id);
    if (!c) return;
    c.stream = (c.stream ?? '') + d.delta;
    this.draw();
  }

  deleted(id: string): void { if (id === this.sessionId) { this.sessionId = null; this.cards.clear(); void this.loadLatest(); } }

  /** What Settings → Desktop pet shows under the pet. */
  configure(o: { toolbar: boolean; cards: Cards; tags: Tag[] }): void {
    if (o.toolbar === this.toolbar && o.cards === this.cardsMode && o.tags.join() === this.tags.join()) return;
    this.toolbar = o.toolbar; this.cardsMode = o.cards; this.tags = [...o.tags];
    if (!o.toolbar) this.closeAsk();
    this.render();
  }

  /** The app: how far the screen reaches below the top of the page. */
  setRoom(px: number): void { if (px > 0 && px !== this.room) { this.room = px; this.render(); } }

  get showsCards(): boolean { return this.cardsMode !== 'none'; }

  /** Open a card (the pet's bubble points at it). */
  expand(id: string): void {
    this.expanded.add(id);
    if (!this.live()) this.peek = true;
    else if (recent(this.cards.values(), 1, this.tags, (o) => this.expanded.has(o.id))[0]?.id !== id && !this.list) { this.cardsMode = 'recent'; this.host.setCards('recent'); }
    this.render();
    this.listEl.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ actions
  private live(): boolean { return this.status === 'recording' || this.status === 'paused'; }

  private async act(a: string): Promise<void> {
    const fail = (e: unknown) => this.host.say((e as Error).message || t('Something went wrong'), 'warn');
    switch (a) {
      case 'start': this.status = 'starting'; this.render(); await api('/api/session/quick-start', { body: {} }).catch((e) => { this.status = 'idle'; this.render(); fail(e); }); break;
      case 'pause': case 'resume': await api(`/api/session/${a}`, { body: {} }).catch(fail); break;
      case 'end':
        if (Date.now() < this.confirmEnd) { this.confirmEnd = 0; await api('/api/session/end', { body: {} }).catch(fail); break; }
        this.confirmEnd = Date.now() + 3000; this.render(); setTimeout(() => this.render(), 3100); break;
      case 'catchup': if (this.sessionId) await api('/api/ai/catchup', { body: { sessionId: this.sessionId, scope: '2m' } }).catch(fail); break;
      case 'ask': if (this.asking) this.closeAsk(); else this.openAsk(); break;
      case 'list':
        if (!this.live()) this.peek = !this.peek;
        else { this.cardsMode = this.list ? 'latest' : 'recent'; this.host.setCards(this.cardsMode); }
        this.render(); break;
    }
  }

  private openAsk(): void {
    this.asking = true; this.ask.hidden = false; this.render();
    this.host.keyboard(true);
    setTimeout(() => this.input.focus(), 60);  // after the panel has become key
  }

  private closeAsk(): void {
    if (!this.asking) return;
    this.asking = false; this.ask.hidden = true; this.input.blur(); this.render();
    this.host.keyboard(false);
  }

  private async submit(): Promise<void> {
    const question = this.input.value.trim();
    if (!question || !this.sessionId) return;
    try {
      const { id } = await api<{ id: string }>('/api/ai/ask', { body: { sessionId: this.sessionId, question } });
      this.expanded.add(id);
      if (!this.live()) this.peek = true;
      this.input.value = '';
      this.closeAsk();
    } catch (e) { this.host.say((e as Error).message, 'warn'); }
  }

  private cardClick(e: MouseEvent): void {
    const el = e.target as HTMLElement;
    const chip = el.closest<HTMLButtonElement>('button[data-tag]');
    if (chip) {
      const k = chip.dataset.tag as Tag;
      this.tags = this.tags.includes(k) ? this.tags.filter((x) => x !== k) : TAGS.filter((x) => x === k || this.tags.includes(x));
      this.host.setTags(this.tags); this.render();
      return;
    }
    const ref = el.closest<HTMLButtonElement>('button.ref');
    const card = el.closest<HTMLElement>('.card');
    const o = card?.dataset.id ? this.cards.get(card.dataset.id) : undefined;
    if (ref && this.sessionId) { this.host.open({ session: this.sessionId, t: Number(ref.dataset.t), t2: ref.dataset.t2 ? Number(ref.dataset.t2) : undefined }); return; }
    if (el.closest('button.open')) { if (this.sessionId) this.host.open({ session: this.sessionId, ...(o ? focusOf(o) : {}) }); return; }
    if (!o || el.closest('a')) return;
    clearTimeout(this.foldTimer);
    if (el.closest('.md')) {
      // A click on an open card's text folds it too, but text stays selectable: a drag or a double-click selects instead.
      if (e.detail > 1 || !document.getSelection()?.isCollapsed) return;
      this.foldTimer = window.setTimeout(() => { if (document.getSelection()?.isCollapsed) this.toggle(o.id); }, 250);
      return;
    }
    this.toggle(o.id);
  }

  private toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
    this.render();
  }

  /** Tooltips follow the app's cursor reports: the panel is never focused, so the page gets no hover of its own. */
  hover(x: number, y: number): void {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-tip]') ?? null;
    if (el === this.hovered) return;
    this.hovered?.classList.remove('hov');
    this.hovered = el;
    if (!el) { this.tip.classList.remove('on'); return; }
    el.classList.add('hov');
    this.tip.textContent = el.dataset.tip!;
    const r = el.getBoundingClientRect(), box = this.el.getBoundingClientRect();
    this.tip.style.left = `${r.left + r.width / 2 - box.left}px`;
    this.tip.style.top = `${r.top - box.top - 6}px`;
    this.tip.classList.add('on');
  }

  // ------------------------------------------------------------------ drawing
  private meetingTime(): string {
    return fmtT(this.clock.nowT + (this.status === 'recording' ? Date.now() - this.clock.at : 0));
  }

  private updateClock(): void { const c = this.bar.querySelector('.clock'); if (c) c.textContent = this.meetingTime(); }

  /** Coalesce streaming updates into one render per frame. */
  private draw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => { this.drawQueued = false; this.render(); });
  }

  render(): void {
    this.bar.hidden = !this.toolbar;
    this.renderBar();
    this.renderCards();
    this.input.placeholder = t('Ask about this meeting…');
    (this.ask.lastElementChild as HTMLButtonElement).textContent = t('Ask');
    this.host.changed();
  }

  private renderBar(): void {
    const b = (act: string, html: string, tip: string, cls = '', disabled = false) =>
      `<button type="button" data-act="${act}" data-tip="${tip}" class="${cls}"${disabled ? ' disabled' : ''}>${html}</button>`;
    const parts: string[] = [];
    const s = this.status;
    if (s === 'idle') parts.push(b('start', ICON.wave, t('Quick start')));
    else if (s === 'recording') parts.push(b('pause', `<i class="dot"></i><span class="clock">${this.meetingTime()}</span>`, t('Pause'), 'rec'));
    else if (s === 'paused') parts.push(b('resume', `${ICON.play}<span class="clock">${this.meetingTime()}</span>`, t('Resume'), 'paused'));
    else parts.push(b('', ICON.spin, s === 'ending' ? t('Ending…') : t('Starting…'), '', true));
    if (this.live()) parts.push(b('catchup', ICON.spark, t('Catch me up')));
    parts.push(b('ask', ICON.pencil, t('Ask'), this.asking ? 'on' : '', !this.sessionId));
    if (this.live()) {
      const sure = Date.now() < this.confirmEnd;
      parts.push(b('end', sure ? `<span>${t('End meeting?')}</span>` : ICON.stop, sure ? t('Click again to end') : t('End meeting'), sure ? 'confirm' : ''));
    }
    const listTip = this.live() ? (this.list ? t('Show less') : t('Recent answers')) : (this.peek ? t('Hide answers') : t('Last meeting’s answers'));
    if (this.cardsMode !== 'none') parts.push(b('list', ICON.chevron, listTip, (this.live() ? this.list : this.peek) ? 'flip' : '', !this.sessionId));
    const html = parts.join('<span class="sep"></span>');
    if (this.bar.innerHTML !== html) { this.bar.innerHTML = html; this.hovered = null; this.tip.classList.remove('on'); }
  }

  private renderCards(): void {
    // Rebuilding resets the scroll of open cards; keep it.
    const inner = new Map([...this.listEl.querySelectorAll<HTMLElement>('.card')].map((c) => [c.dataset.id!, c.querySelector('.md')?.scrollTop ?? 0]));
    const items = this.showing ? recent(this.cards.values(), this.list ? 6 : 1, this.tags, (o) => this.expanded.has(o.id)) : [];
    const nodes: HTMLElement[] = [];
    if (this.showing && this.list) {
      // Tag chips with counts, as above the cards in Chumi's window.
      const head = document.createElement('div');
      head.className = 'list-head';
      const chips = document.createElement('div');
      chips.className = 'chips';
      const counts = tagCounts(this.cards.values());
      for (const k of TAGS) {
        if (!counts.has(k)) continue;
        const c = document.createElement('button');
        c.type = 'button'; c.className = `chip tag-${k}`; c.dataset.tag = k; c.setAttribute('aria-pressed', String(this.tags.includes(k)));
        c.innerHTML = '<i></i>';
        c.append(t(TAG_LABEL[k]), Object.assign(document.createElement('span'), { className: 'n', textContent: String(counts.get(k)) }));
        chips.append(c);
      }
      head.append(chips);
      if (this.sessionId) { const open = document.createElement('button'); open.className = 'open'; open.textContent = t('Open in Chumi'); head.append(open); }
      nodes.push(head);
      if (!items.length) { const empty = document.createElement('div'); empty.className = 'card empty'; empty.textContent = t('Catch-ups, answers and explanations from the meeting appear here.'); nodes.push(empty); }
    }
    for (const o of items) nodes.push(this.card(o));
    this.listEl.replaceChildren(...nodes);
    this.listEl.hidden = !nodes.length;
    // Stop before the bottom of the screen: drop the oldest cards that don't fit (always keep one).
    const budget = this.room - this.listEl.getBoundingClientRect().top - 16;
    while (this.listEl.querySelectorAll('.card:not(.empty)').length > 1 && this.listEl.getBoundingClientRect().height > budget) this.listEl.lastElementChild!.remove();
    for (const c of this.listEl.querySelectorAll<HTMLElement>('.card')) { const md = c.querySelector('.md'); if (md) md.scrollTop = inner.get(c.dataset.id!) ?? 0; }
  }

  private card(o: Card): HTMLElement {
    const open = this.expanded.has(o.id);
    // While an answer streams, its first line may be the model's [[meeting]] / [[tangent]] marker.
    const text = o.content ?? (o.stream != null ? (o.kind === 'answer' ? splitCategory(o.stream, true).body : o.stream) : '');
    const working = o.status === 'pending' || o.status === 'streaming';
    const c = document.createElement('div');
    c.className = `card${open ? ' open' : ''}`;
    c.dataset.id = o.id;
    const head = document.createElement('div');
    head.className = 'head';
    // A spinner while it is written; otherwise its tag's colour, as the stripe on Chumi's cards.
    head.innerHTML = working ? ICON.spin : `<i class="tag tag-${tagOf(o) ?? 'meeting'}"></i>`;
    const title = document.createElement('b');
    title.textContent = cardTitle(o);
    const time = document.createElement('span');
    time.className = 'tm';
    time.textContent = `· ${when(o.completed_at ?? o.created_at, Date.now(), locale())}`;
    head.append(title, time);
    c.append(head);
    const body = document.createElement('div');
    if (o.status === 'error') { body.className = 'prev err'; body.textContent = o.error ?? t('Something went wrong'); }
    else if (open && text) { body.className = 'md'; body.innerHTML = renderMd(text); }
    else { body.className = 'prev'; body.textContent = preview(text) || t('Thinking…'); }
    c.append(body);
    if (open && !working) { const foot = document.createElement('div'); foot.className = 'foot'; const b = document.createElement('button'); b.className = 'open'; b.textContent = `${t('Open in Chumi')} →`; foot.append(b); c.append(foot); }
    return c;
  }
}
