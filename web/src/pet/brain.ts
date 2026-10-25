// What the desktop pet feels and says, from Chumi's live events. No DOM here, so tests can drive it with a fake clock.

import type { Mood } from './mood.ts';
import { tagOf, type Topic } from './tags.ts';

export type Lang = 'en' | 'zh';
export interface Line {
  text: string; action?: string; tone?: 'info' | 'warn'; /** seconds on screen */ hold: number;
  /** A click opens Chumi's window… */ open?: boolean;
  /** …or, when the pet shows it, this answer's card. */ output?: string;
  /** Shown whatever the bubble filter says: something failed, or the reply to something you just did. */ important?: boolean;
  /** What it is about, for the bubble filter (Settings → Desktop pet). Lines without one are chatter. */ tag?: Topic;
}
export interface PetOutput { id: string; kind: string; status: string; question?: string | null; session_id?: string; data?: { category?: unknown } | null }
export interface MenuItem { id: string; label: string; enabled: boolean }

/** Everything Chumi says. The promo video (docs/video/pet/) uses the same lines. */
export const PET_LINES = {
  hello: { en: "Hi! I'm Chumi.", zh: '嗨，我是 Chumi！' },
  listening: { en: "I'm listening!", zh: '竖起耳朵，开始听啦！' },
  paused: { en: 'Taking a little break', zh: '先歇一会儿～' },
  resumed: { en: 'Back to listening!', zh: '继续听！' },
  ended: { en: 'Good meeting! Writing it up…', zh: '辛苦啦！我来写总结…' },
  endedQuiet: { en: 'Good meeting!', zh: '辛苦啦！' },
  look: { en: 'Click to see →', zh: '点我看看 →' },
  catchup: { en: "Here's what you missed!", zh: '刚才讲的，帮你理好啦！' },
  answer: { en: 'Found an answer!', zh: '答案找到啦！' },
  explain: { en: 'Explained: {term}', zh: '解释好啦：{term}' },
  autoExplain: { en: 'New term: {term}', zh: '新词：{term}' },
  recap: { en: 'Recap is up to date', zh: '概要更新好啦' },
  summary: { en: 'The meeting summary is ready!', zh: '会议总结写好啦！' },
  handoff: { en: 'The handoff draft is ready', zh: '交接草稿写好啦' },
  failed: { en: "Hmm, that didn't work", zh: '呜，这次没成功…' },
  problem: { en: 'Something went wrong', zh: '好像出了点问题' },
  noMeeting: { en: 'Start a meeting first', zh: '先开始一场会议吧' },
  wake: { en: 'Huh? Was I napping?', zh: '唔…我睡着了吗？' },
  petted: { en: 'That feels nice~', zh: '好舒服～' },
  menuCatchup: { en: 'Catch Me Up', zh: '帮我跟上' },
  menuOpen: { en: 'Open Chumi', zh: '打开 Chumi' },
  menuHide: { en: 'Hide Desktop Pet', zh: '先把我藏起来' },
  menuCompact: { en: 'Pet Only', zh: '只显示桌宠' },
  menuFull: { en: 'Show Toolbar', zh: '显示工具栏' },
} satisfies Record<string, Record<Lang, string>>;
const TAPS: Record<Lang, string[]> = { en: ['Hehe~', "I'm here!", 'That tickles!', 'Boop!'], zh: ['嘿嘿～', '我在呢！', '好痒呀～', '戳到我啦！'] };
const TAPS_LIVE: Record<Lang, string[]> = { en: ['Shh, listening…', 'Taking notes!'], zh: ['嘘，我在认真听', '我在记笔记呢！'] };

/** Outputs someone asked for. Background work (rolling recaps, digests) never interrupts. */
const MANUAL = new Set(['catchup', 'answer', 'explain', 'final_summary', 'handoff']);
const isManual = (o: PetOutput) => MANUAL.has(o.kind) || (o.kind === 'overview' && !!o.question);
/** With nothing going on and nobody around, Chumi dozes off after this long (seconds). */
export const SLEEP_AFTER = 90;
/** Stop thinking about an answer that never reported back after this long (seconds). */
const BUSY_MAX = 15 * 60;

export class PetBrain {
  lang: Lang = 'en';
  status = 'idle';
  sessionId: string | null = null;
  /** The last status other than 'starting', which a resume also passes through. */
  private settled = 'idle';
  private busy = new Map<string, { session?: string; since: number }>();
  private announced = new Set<string>();
  private transient: { mood: Mood; until: number } | null = null;
  private activeAt = 0;
  private taps = 0;
  private pettedAt = -99;
  private noticeAt = -99;

  private s(key: keyof typeof PET_LINES, term?: string): string { return PET_LINES[key][this.lang].replace('{term}', term ?? ''); }
  private feel(mood: Mood, t: number, secs: number): void { this.transient = { mood, until: t + secs }; }

  mood(t: number): Mood {
    if (this.transient && t < this.transient.until) return this.transient.mood;
    for (const [id, b] of this.busy) if (t - b.since > BUSY_MAX) this.busy.delete(id);
    if (this.busy.size) return 'think';
    switch (this.status) {
      case 'recording': return 'listen';
      case 'paused': return 'paused';
      case 'starting': return 'surprised';
      case 'ending': return 'think';
    }
    return t - this.activeAt > SLEEP_AFTER ? 'sleep' : 'idle';
  }

  hello(t: number): Line { this.activeAt = t; this.feel('wave', t, 2.4); return { text: this.s('hello'), hold: 3.4 }; }

  /** Someone is around (cursor nearby, a click, a drag). Wakes Chumi up. */
  activity(t: number): Line | null {
    const asleep = this.mood(t) === 'sleep';
    this.activeAt = t;
    if (!asleep) return null;
    this.feel('surprised', t, 0.9);
    return { text: this.s('wake'), hold: 2.4 };
  }

  live(state: { status?: string; session?: { id?: string } | null } | null | undefined, t: number): Line | null {
    const next = state?.status ?? 'idle', prev = this.settled;
    const changed = next !== this.status;
    this.status = next; this.sessionId = state?.session?.id ?? null;
    if (next !== 'starting') this.settled = next;
    if (!changed || next === 'starting' || next === prev) return null;
    this.activeAt = t;
    if (next === 'recording' && prev === 'paused') return { text: this.s('resumed'), hold: 2.6 };
    if (next === 'recording') { this.feel('surprised', t, 0.9); return { text: this.s('listening'), hold: 3 }; }
    if (next === 'paused') return { text: this.s('paused'), hold: 3 };
    return null;
  }

  /** `summarizing`: the summary has started. An empty meeting gets none (and one waiting for speaker labels starts later). */
  ended(t: number, summarizing: boolean): Line {
    this.activeAt = t; this.feel('wave', t, 2.6);
    return { text: this.s(summarizing ? 'ended' : 'endedQuiet'), hold: summarizing ? 4.5 : 3, tag: summarizing ? 'summary' : 'chatter' };
  }

  /** A deleted meeting's work is cancelled without a final update, so stop waiting for it. */
  deleted(sessionId: string): void {
    for (const [id, b] of this.busy) if (b.session === sessionId) this.busy.delete(id);
  }

  ai(o: PetOutput, t: number): Line | null {
    if (o.status === 'pending' || o.status === 'streaming') { if (isManual(o) && !this.busy.has(o.id)) this.busy.set(o.id, { session: o.session_id, since: t }); return null; }
    this.busy.delete(o.id);
    if (this.announced.has(o.id)) return null;
    if (o.status === 'done') {
      if (o.kind === 'auto_explain') {
        this.announced.add(o.id); this.activeAt = t; this.feel('surprised', t, 1.1);
        return { text: this.s('autoExplain', o.question ?? ''), action: this.s('look'), hold: 8, open: true, output: o.id, tag: 'background' };
      }
      if (!isManual(o)) return null;
      this.announced.add(o.id); this.activeAt = t;
      const final = o.kind === 'final_summary';
      this.feel(final ? 'celebrate' : 'happy', t, final ? 3.6 : 2.2);
      const key = o.kind === 'catchup' ? 'catchup' : o.kind === 'answer' ? 'answer' : o.kind === 'explain' ? 'explain' : final ? 'summary' : o.kind === 'handoff' ? 'handoff' : 'recap';
      return { text: this.s(key, o.question ?? ''), action: this.s('look'), hold: final ? 12 : 10, open: true, output: o.id, tag: tagOf(o) ?? 'meeting' };
    }
    if (o.status === 'error' && isManual(o)) {
      this.announced.add(o.id); this.activeAt = t; this.feel('worried', t, 3);
      return { text: this.s('failed'), action: this.s('look'), tone: 'warn', hold: 6, open: true, output: o.id, important: true };
    }
    return null;
  }

  notice(n: { level?: string } | null | undefined, t: number): Line | null {
    if (n?.level !== 'error' || t - this.noticeAt < 20) return null;
    this.noticeAt = t; this.activeAt = t; this.feel('worried', t, 3);
    return { text: this.s('problem'), action: this.s('look'), tone: 'warn', hold: 6, open: true, important: true };
  }

  /** A click on Chumi: a happy hop, and a word every other time. */
  tap(t: number): Line | null {
    this.activeAt = t; this.feel('happy', t, 1.2);
    const n = this.taps++;
    if (n % 2) return null;
    const lines = this.status === 'recording' && n % 4 === 2 ? TAPS_LIVE[this.lang] : TAPS[this.lang];
    return { text: lines[Math.floor(n / 2) % lines.length], hold: 1.8 };
  }

  /** Sustained petting earns a word now and then. */
  petted(t: number): Line | null {
    this.activeAt = t;
    if (t - this.pettedAt < 10) return null;
    this.pettedAt = t;
    return { text: this.s('petted'), hold: 2 };
  }

  /** Why a catch-up can't start right now, or null if it can. */
  catchupBlocked(): Line | null {
    return this.sessionId && (this.status === 'recording' || this.status === 'paused') ? null : { text: this.s('noMeeting'), hold: 2.6, important: true };
  }

  failed(): Line { return { text: this.s('failed'), tone: 'warn', hold: 4, important: true }; }

  /** `compact`: only the character is showing, without its toolbar and cards. */
  menu(compact = false): MenuItem[] {
    return [
      { id: 'catchup', label: this.s('menuCatchup'), enabled: !this.catchupBlocked() },
      { id: 'open', label: this.s('menuOpen'), enabled: true },
      { id: '-', label: '', enabled: false },
      { id: 'compact', label: this.s(compact ? 'menuFull' : 'menuCompact'), enabled: true },
      { id: 'hide', label: this.s('menuHide'), enabled: true },
    ];
  }
}
