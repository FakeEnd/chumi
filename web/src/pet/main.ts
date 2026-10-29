// The desktop pet page (pet.html). Chumi.app shows it in a transparent panel that floats over other windows:
// the character, its toolbar (start/pause/end a meeting, catch up, ask) and the latest answers (companion.ts).
//
// App → page (window.chumiPet): pointer(x, y) with the cursor in page px, click(x, y, count) and drag(phase, vx) on
// the character, menu() → JSON items for the right-click menu, run(id).
// App → page also: setEnabled(on) from Window → Desktop Pet, and room(px): page px from its top to the screen's bottom.
// Page → app (webkit.messageHandlers.chumiPet):
//   {type: 'layout', enabled, zoom, shareable, height, pet: [rect], ui: [rects]}: whether to show the panel, its scale
//     (Settings → Desktop pet), whether screen shares may see it, its height, and where clicks should land. On the pet
//     the app drags and taps; on ui boxes clicks go to the page as usual; elsewhere they pass through to the windows below.
//     Rects and height are CSS px of the page; the app multiplies them by the zoom.
//   {type: 'open', session?, t?, t2?, dialog?: 'handoff'}: show Chumi's window, optionally at a meeting and a transcript time.
//   {type: 'keyboard', on}: the ask box wants typing (the panel otherwise never takes focus).
// Opened in a browser without the app, the page follows the mouse itself, which is handy for development.

import { api, subscribe } from '../api.ts';
import { setLang } from '../i18n.ts';
import { PetBrain, type Line } from './brain.ts';
import { Companion, type Cards } from './companion.ts';
import { gaze } from './rig.ts';
import { TAGS, TOPICS, type Tag, type Topic } from './tags.ts';
import { PetView } from './view.ts';
import { PetLoop } from './loop.ts';
import './pet.css';

type Native = { postMessage(m: unknown): void; onEvent?(callback: (event: { method: keyof typeof bridge; args: unknown[] }) => void): void };
const windowsNative: Native | undefined = (window as any).chumiPetNative;
const native: Native | undefined = windowsNative ?? (window as any).webkit?.messageHandlers?.chumiPet;
const post = (m: Record<string, unknown>) => native?.postMessage(m);

const app = document.getElementById('app')!;
const view = new PetView(150);
document.getElementById('petArea')!.appendChild(view.el);
const brain = new PetBrain();
const clock = () => performance.now() / 1000;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));

// ------------------------------------------------------------------ Settings → Desktop pet
type PetSettings = { enabled: boolean; size: number; toolbar: boolean; cards: Cards; tags: Tag[]; say: Topic[]; inRecordings: boolean; lowKey: boolean };
let pet: PetSettings = { enabled: true, size: 1, toolbar: true, cards: 'latest', tags: [...TAGS], say: [...TOPICS], inRecordings: false, lowKey: false };
const compact = () => !pet.toolbar && pet.cards === 'none';
function applyPet(p: Partial<PetSettings> | undefined): void {
  if (!p) return;
  pet = { ...pet, ...p };
  const wasLowKey = brain.lowKey;
  brain.lowKey = pet.lowKey;
  if (!wasLowKey && brain.quiet && !said?.important) view.hush(clock());
  app.hidden = !pet.enabled;
  wake();
  companion.configure({ toolbar: pet.enabled && pet.toolbar, cards: pet.cards, tags: pet.tags, lowKey: pet.lowKey });
  report();
}
const savePet = (patch: Partial<PetSettings>) => {
  applyPet(patch);  // at once; the settings event confirms it
  void api('/api/settings', { method: 'PUT', body: { pet: patch } }).catch(() => {});
};

// ------------------------------------------------------------------ speech bubble
let bubbleUntil = 0, said: Line | null = null;
function say(line: Line | null): void {
  wake();
  if (!line || !pet.enabled || !(line.important || pet.say.includes(line.tag ?? 'chatter'))) return;
  const t = clock();
  view.say(line, t); bubbleUntil = t + line.hold; said = line;
  report();
}
view.bubble.classList.add('ui');
view.bubble.addEventListener('click', () => {
  // The answer it announces opens in the pet's own card; anything else (or with the toolbar hidden) in Chumi.
  if (said?.output && !said.dialog && companion.has(said.output)) companion.expand(said.output);
  else if (said?.open) post({ type: 'open', session: said.session, dialog: said.dialog });
  view.hush(clock()); wake(); report();
});

// report()'s state, declared before the companion: it reports its first layout while it is constructed.
let last = '', queued = false;
const companion = new Companion({
  say: (text, tone = 'info', important = false) => say({ text, tone, hold: tone === 'warn' ? 5 : 3, important: important || tone === 'warn' }),
  open: (where) => post({ type: 'open', ...where }),
  keyboard: (on) => post({ type: 'keyboard', on }),
  changed: () => report(),
  setCards: (cards) => savePet({ cards }),
  setTags: (tags) => savePet({ tags }),
});
app.appendChild(companion.el);
window.addEventListener('storage', (e) => { if (e.key === 'chumi.handoffDestination') companion.render(); });

// ------------------------------------------------------------------ size and click regions
const box = (e: Element) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
/** Layout boxes ignore the bubble's pop-in transform, so they are its settled size. */
function layout(): Record<string, unknown> {
  const r = view.rig.el.getBoundingClientRect(), sx = r.width / 200, sy = r.height / 200;
  const petBox = [[r.left + 30 * sx, r.top + 34 * sy, 140 * sx, 158 * sy].map(Math.round)];
  const ui = [...companion.el.querySelectorAll('.ui')].filter((e) => !(e as HTMLElement).hidden && e.getBoundingClientRect().height > 0).map(box);
  if (view.saying) {
    const b = view.bubble, v = view.el.getBoundingClientRect();
    ui.push([v.left + b.offsetLeft - b.offsetWidth / 2, v.top + b.offsetTop, b.offsetWidth, b.offsetHeight + 8].map(Math.round));
  }
  if (!pet.enabled) return { type: 'layout', enabled: false, zoom: pet.size, shareable: pet.inRecordings, height: 0, pet: [], ui: [] };
  return { type: 'layout', enabled: true, zoom: pet.size, shareable: pet.inRecordings, height: Math.ceil(app.getBoundingClientRect().height), pet: petBox, ui };
}
/** Coalesced with a timer, not an animation frame: the app shows the panel only after the first report, and a page
 *  that isn't on screen gets no animation frames. */
function report(): void {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    const m = layout(), json = JSON.stringify(m);
    if (json !== last) { last = json; post(m); }
  }, 16);
}
new ResizeObserver(report).observe(app);
window.addEventListener('resize', () => { last = ''; report(); });

// ------------------------------------------------------------------ the app's events
/** Latest loudness per audio source (mic, system, file); the pet follows the loudest one heard recently. */
const levels = new Map<string, { v: number; at: number }>();
const loudness = (t: number) => { let v = 0; for (const l of levels.values()) if (t - l.at < 0.35) v = Math.max(v, l.v); return v; };
let systemLang: string | undefined;
function language(settings: any): void {
  const ui = settings?.ui?.language;
  brain.lang = ui === 'zh' || ui === 'en' ? ui : systemLang === 'zh' ? 'zh' : 'en';
  setLang(brain.lang);
  companion.render();
}

void api('/api/state').then((s) => {
  systemLang = s.systemLanguage; language(s.settings); applyPet(s.settings?.pet);
  brain.live(s.live, clock()); companion.setLive(s.live);
  if (!s.live?.session) void companion.loadLatest();
  say(brain.hello(clock()));
}).catch(() => say(brain.hello(clock())));

subscribe({
  hello: (d) => { brain.live(d.live, clock()); companion.setLive(d.live); wake(); },
  live: (d) => { say(brain.live(d, clock())); companion.setLive(d); },
  level: (d) => {
    // RMS level in dBFS → 0–1 loudness, roughly −58 dB (room tone) to −18 dB (close speech).
    levels.set(String(d.source), { v: clamp(((Number(d.rms) || -120) + 58) / 40), at: clock() });
    if (brain.status === 'recording' && !pet.lowKey && !motion.matches) wake();
  },
  segment: () => { if (!pet.lowKey) { view.rig.note(clock()); wake(); } },
  ai: (o) => { companion.ai(o); say(brain.ai(o, clock())); },
  'ai-delta': (d) => companion.delta(d),
  notice: (n) => say(brain.notice(n, clock())),
  'session-ended': (d) => say(brain.ended(clock(), !!d?.summaryId)),
  'session-updated': (s) => companion.sessionUpdated(s),
  'session-deleted': (d) => { brain.deleted(String(d?.id)); companion.deleted(String(d?.id)); wake(); },
  handoff: (e) => companion.handoffChanged(e),
  settings: (s) => { language(s); applyPet(s?.pet); },
}, () => {});

// ------------------------------------------------------------------ pointer, clicks, drags
let dragging = false;
const samples: Array<{ t: number; x: number; y: number }> = [];
let pettingSince = -1;

/** Petting: the cursor rubbing back and forth over the head in the last 0.7 s. Also run every frame, so it fades when the cursor stops. */
function updatePetting(t: number): void {
  while (samples.length && t - samples[0].t > 0.7) samples.shift();
  let dist = 0, turns = 0, dir = 0;
  for (let i = 1; i < samples.length; i++) {
    const dx = samples[i].x - samples[i - 1].x;
    dist += Math.hypot(dx, samples[i].y - samples[i - 1].y);
    if (Math.abs(dx) > 2) { const d = Math.sign(dx); if (dir && d !== dir) turns++; dir = d; }
  }
  if (!samples.length) { view.rig.petting = 0; pettingSince = -1; return; }
  const u = view.rig.el.getBoundingClientRect().width / 200;
  view.rig.petting = turns ? clamp(dist / (110 * u)) : 0;
  if (view.rig.petting > 0.5) { if (pettingSince < 0) pettingSince = t; else if (t - pettingSince > 1.2) say(brain.petted(t)); } else pettingSince = -1;
}

const bridge = {
  pointer(x: number, y: number): void {
    const t = clock(), r = view.rig.el.getBoundingClientRect(), u = r.width / 200;
    const ex = r.left + 100 * u, ey = r.top + 129 * u, dx = x - ex, dy = y - ey;
    const look = gaze(dx, dy), prev = view.rig.look;
    view.rig.look = look;
    if (!prev || Math.abs(prev.x - look.x) > 0.003 || Math.abs(prev.y - look.y) > 0.003) wake(0.7);
    if (Math.hypot(dx, dy) < 260) say(brain.activity(t));
    const onHead = !dragging && x > r.left + 50 * u && x < r.left + 150 * u && y > r.top + 72 * u && y < r.top + 138 * u;
    if (onHead) samples.push({ t, x, y }); else samples.length = 0;
    updatePetting(t);
    companion.hover(x, y);
  },
  /** A click on the character itself (the app hands clicks on the toolbar and cards to the page directly). */
  click(_x: number, _y: number, count: number): void {
    const t = clock();
    say(brain.activity(t));
    if (count >= 2) { post({ type: 'open' }); return; }
    view.rig.tap(t); wake(1.6);
    say(brain.tap(t));
  },
  drag(phase: 'start' | 'move' | 'end', vx = 0): void {
    const t = clock();
    if (phase === 'start') { dragging = true; say(brain.activity(t)); }
    if (phase === 'move') view.rig.swing += (clamp(-vx / 900, -1, 1) - view.rig.swing) * 0.35;
    if (phase === 'end') { dragging = false; view.rig.swing = 0; view.rig.land(t); }
    wake(0.5);
  },
  menu(): string { return JSON.stringify(brain.menu(compact())); },
  setEnabled(on: boolean): void { savePet({ enabled: on }); },
  room(px: number): void { companion.setRoom(px); },
  run(id: string): void {
    if (id === 'open') post({ type: 'open' });
    if (id === 'hide') savePet({ enabled: false });
    if (id === 'compact') savePet(compact() ? { toolbar: true, cards: 'latest' } : { toolbar: false, cards: 'none' });
    if (id === 'catchup') {
      const blocked = brain.catchupBlocked();
      if (blocked) { say(blocked); return; }
      void api('/api/ai/catchup', { body: { sessionId: brain.sessionId, scope: '2m' } }).catch(() => say(brain.failed()));
    }
  },
};
(window as any).chumiPet = bridge;

if (windowsNative) {
  windowsNative.onEvent!(({ method, args }) => { Reflect.apply(bridge[method], bridge, args); });
  const onUI = (e: Event) => e.composedPath().some((n) => n instanceof Element && n.classList.contains('ui'));
  let down: { x: number; y: number } | null = null, moved = false;
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || onUI(e)) return;
    down = { x: e.screenX, y: e.screenY }; moved = false;
    (e.target as Element).setPointerCapture(e.pointerId);
    post({ type: 'drag', phase: 'start' });
  });
  document.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (Math.hypot(e.screenX - down.x, e.screenY - down.y) >= 4) moved = true;
    post({ type: 'drag', phase: 'move' });
  });
  const release = () => { if (down) { down = null; post({ type: 'drag', phase: 'end' }); } };
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  document.addEventListener('click', (e) => { if (!onUI(e) && !moved) bridge.click(e.clientX, e.clientY, e.detail); });
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); post({ type: 'menu' }); });
}

if (!native) {
  document.addEventListener('mousemove', (e) => bridge.pointer(e.clientX, e.clientY));
  // The path is taken at dispatch: a card re-rendered by its own click handler is detached by the time this runs.
  document.addEventListener('click', (e) => { if (!e.composedPath().some((n) => n instanceof Element && n.classList.contains('ui'))) bridge.click(e.clientX, e.clientY, e.detail); });
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); bridge.run('catchup'); });
}

// ------------------------------------------------------------------ frames
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
let animateUntil = 0;
function wake(seconds = 0): void {
  animateUntil = Math.max(animateUntil, clock() + seconds);
  if (pet.enabled && !document.hidden) loop.wake(); else loop.stop();
}
const loop = new PetLoop((t) => {
  if (!pet.enabled || document.hidden) return Infinity;
  const mood = dragging ? 'held' : brain.mood(t);
  if (mood !== view.rig.current) animateUntil = Math.max(animateUntil, t + 0.3);
  view.rig.level = brain.status === 'recording' && !pet.lowKey ? loudness(t) : 0;
  if (samples.length || view.rig.petting) updatePetting(t);
  view.rig.setMood(mood, t);
  if (view.saying && t >= bubbleUntil) { view.hush(t); report(); }
  view.draw(t, motion.matches, motion.matches);
  if (!motion.matches) {
    if (!['idle', 'hush', 'paused', 'sleep'].includes(mood) || t < animateUntil || view.hasBubble) return 1 / 30;
    return mood === 'sleep' ? 1 / 15 : 1 / 12;
  }
  // Reduced motion needs no animation loop, but bubbles and temporary moods still expire.
  return Math.min(brain.nextChange(t), view.saying ? bubbleUntil : Infinity) - t;
});
motion.addEventListener('change', () => wake());
document.addEventListener('visibilitychange', () => wake());
report(); wake();
