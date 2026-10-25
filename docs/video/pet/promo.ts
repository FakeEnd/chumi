// Desktop-pet promo: the timeline and render(t). See promo.html.
// The desk scenes play live footage of the real pet page (scripts/record-footage.ts); the intro and outro draw the
// character with the app's own rig. Footage is played at real speed where something happens and faster through waits.

import { hash, type Mood } from '../../../web/src/pet/rig.ts';
import { PET_LINES, type Lang } from '../../../web/src/pet/brain.ts';
import { PetView, type Say } from '../../../web/src/pet/view.ts';

const LANG: Lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
document.documentElement.lang = LANG;
const line = (k: keyof typeof PET_LINES) => PET_LINES[k][LANG];

type Clip = { name: string; duration: number; frames: Array<[number, string]>; events: Array<{ t: number; type: string; x?: number; y?: number; name?: string }>; box: { pet: number[] } };
const CLIPS = (window as any).CLIPS as Record<string, Clip>;
const FOOT = (window as any).FOOT as string;
const PS = CLIPS['pet-start'], PCU = CLIPS['pet-catchup'], PE = CLIPS['pet-end'], PH = CLIPS['pet-handoff'];
const mark = (c: Clip, name: string) => { const e = c.events.find((x) => x.type === 'mark' && x.name === name); if (!e) throw new Error(`${c.name}: no ${name} mark`); return e.t; };

const TEXT: Record<string, Record<Lang, string>> = {
  introTitle: { zh: '<b>Chumi</b> 桌宠', en: 'The <b>Chumi</b> desktop pet' },
  introSub: { zh: '开会时，它就在桌面角落陪你听', en: 'It sits in the corner of your screen and listens with you' },
  outroTag: { zh: '开会时的贴心小搭子', en: 'Your meeting buddy, right on the desktop' },
  outroSub: { zh: '组会 · 导师 1:1 · 讲座 · 研讨会', en: 'Lab meetings · advisor 1:1s · lectures · seminars' },
  outroFine: { zh: 'macOS · 语音在本机转写 · 开源 MIT', en: 'macOS · on-device transcription · open source (MIT)' },
  callApp: { zh: '会议', en: 'Meet' }, m1: { zh: '文件', en: 'File' }, m2: { zh: '编辑', en: 'Edit' }, m3: { zh: '显示', en: 'View' }, m4: { zh: '窗口', en: 'Window' },
  clock: { zh: '周五 14:05', en: 'Fri 2:05 PM' },
  callTitle: { zh: '组会 · NLP 实验室', en: 'Lab meeting · NLP group' },
  slideTitle: { zh: '用 DPO 教 7B 模型引用来源', en: 'Teaching a 7B model to cite with DPO' },
  slideWho: { zh: 'Maya · 组会进展汇报', en: 'Maya · progress update' },
  b1: { zh: 'SFT 4 万条 → DPO 6 万偏好对', en: 'SFT on 40k examples → DPO on 60k pairs' },
  b2: { zh: '引用精确率 61% → 74%', en: 'Citation precision 61% → 74%' },
  b3: { zh: '3 个随机种子，波动约 2 个点', en: '3 seeds, spread about 2 points' },
  pi: { zh: '陈老师', en: 'PI' },
};
const BYE: Record<Lang, string> = { zh: '下次开会见～', en: 'See you at the next meeting!' };
const W = 1920, H = 1080;

// ------------------------------------------------------------------ helpers
const $ = (id: string) => document.getElementById(id)!;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const smooth = (u: number) => { const v = clamp(u); return v * v * (3 - 2 * v); };
const inOut = (u: number) => { const v = clamp(u); return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2; };
const outBack = (u: number) => { const v = clamp(u), c = 1.7; return 1 + (c + 1) * (v - 1) ** 3 + c * (v - 1) ** 2; };
const spring = (u: number) => (u <= 0 ? 0 : 1 - Math.exp(-8 * u) * Math.cos(11 * u));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const vis = (t: number, a: number, b: number, fade = 0.25) => Math.min(seg(t, a, a + fade), 1 - seg(t, b - fade, b));
/** Scene time → clip time through [scene time, clip time] keys. */
function remap(keys: number[][], u: number): number {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (u <= keys[i][0]) { const [a0, b0] = keys[i - 1], [a1, b1] = keys[i]; return b0 + (b1 - b0) * (u - a0) / (a1 - a0); }
  return keys.at(-1)![1];
}
/** Keys from [clip time, seconds on screen] steps: each step plays the clip on to that time, in that long. */
function steps(from: number, list: Array<[number, number]>): number[][] {
  const keys = [[0, from]]; let t = 0;
  for (const [ct, secs] of list) { t += Math.max(0.05, secs); keys.push([t, ct]); }
  return keys;
}
function frameAt(c: Clip, ct: number): string {
  const f = c.frames; let lo = 0, hi = f.length - 1;
  if (ct > f[0][0]) while (lo < hi) { const m = (lo + hi + 1) >> 1; if (f[m][0] <= ct) lo = m; else hi = m - 1; }
  return `${FOOT}${c.name}/${f[lo][1]}`;
}
function pointerAt(c: Clip, ct: number): { x: number; y: number; since: number } | null {
  let p: [number, number] | null = null, down = -99;
  for (const e of c.events) { if (e.t > ct) break; if (e.type === 'move' || e.type === 'down') p = [e.x!, e.y!]; if (e.type === 'down') down = e.t; }
  return p && { x: p[0], y: p[1], since: ct - down };
}

// ------------------------------------------------------------------ the footage on the desk
// The captured page is 1140 px wide (the pet page at 3×); on the desk it is FOOT_SCALE of that, top-left at FOOT_AT.
const FOOT_SCALE = 0.33, FOOT_AT = { x: 1520, y: 300 };
const toDesk = (x: number, y: number) => ({ x: FOOT_AT.x + x * FOOT_SCALE, y: FOOT_AT.y + y * FOOT_SCALE });
const petBox = PS.box.pet;  // the character in the captured page: [x, y, w, h]
const petCenter = toDesk(petBox[0] + petBox[2] / 2, petBox[1] + petBox[3] * 0.62);
const petSize = petBox[2] * FOOT_SCALE;  // drawn character width on the desk

// Scene 1, pet-start: hello, the pointer comes in, the meeting starts, listening, a pat on the head.
const s1Start = mark(PS, 'start');
const rub = PS.events.find((e) => e.type === 'move' && e.t > s1Start + 3)?.t ?? s1Start + 4.5;
const K1 = steps(1.2, [[s1Start, s1Start - 1.2], [s1Start + 2.2, 2.2], [rub - 0.4, (rub - 0.4 - s1Start - 2.2) / 1.6], [rub + 3.0, 3.4], [rub + 4.4, 1.4]]);
// Scene 2, pet-catchup: click catch up, the answer streams in, open the card, ask a question, the answer streams in.
const c2Click = mark(PCU, 'click'), c2Done = mark(PCU, 'done'), c2Open = mark(PCU, 'open'), c2Ask = mark(PCU, 'ask'), c2Answered = mark(PCU, 'answered');
const K2 = steps(c2Click - 1.6, [
  [c2Click, 1.6], [c2Done, clamp((c2Done - c2Click) / 3, 3.5, 5.5)], [c2Open, c2Open - c2Done], [c2Open + 2.4, 2.4],
  [c2Ask, (c2Ask - c2Open - 2.4) / 1.4], [c2Answered, clamp((c2Answered - c2Ask) / 3, 3.2, 5)], [c2Answered + 2.2, 2.2],
]);
// Scene 3, pet-end: end the meeting from the toolbar, the summary is written, a celebration.
const c3End = mark(PE, 'end'), c3Summary = mark(PE, 'summary');
const K3 = steps(0.6, [[c3End, c3End - 0.6], [c3End + 2.2, 2.2], [c3Summary, 2.4], [c3Summary + 3.6, 3.6]]);
// Scene 4, pet-handoff: the handoff was confirmed in Chumi; the toolbar continues it in Codex app, and the pet says so.
const c4Go = mark(PH, 'continue'), c4Said = mark(PH, 'said');
const K4 = steps(0.5, [[c4Go - 0.2, c4Go - 0.7], [c4Said, c4Said - c4Go + 0.2], [c4Said + 4.0, 4.0]]);

const INTRO_END = 4.6;
const S1 = [INTRO_END, INTRO_END + K1.at(-1)![0]];
const S2 = [S1[1], S1[1] + K2.at(-1)![0]];
const S3 = [S2[1], S2[1] + K3.at(-1)![0]];
const S4 = [S3[1], S3[1] + K4.at(-1)![0]];
const OUTRO = S4[1];
const DURATION = OUTRO + 5.6;
/** Which clip is on the desk at video time t, and its time. */
function clipAt(t: number): { c: Clip; ct: number } {
  if (t < S1[1]) return { c: PS, ct: remap(K1, t - S1[0]) };
  if (t < S2[1]) return { c: PCU, ct: remap(K2, t - S2[0]) };
  if (t < S3[1]) return { c: PE, ct: remap(K3, t - S3[0]) };
  return { c: PH, ct: remap(K4, t - S4[0]) };
}
/** The video time at which clip c reaches clip time ct (for captions and sounds). */
function at(c: Clip, ct: number): number {
  const [keys, start] = c === PS ? [K1, S1[0]] : c === PCU ? [K2, S2[0]] : c === PE ? [K3, S3[0]] : [K4, S4[0]];
  for (let i = 1; i < keys.length; i++) if (ct <= keys[i][1]) { const [a0, b0] = keys[i - 1], [a1, b1] = keys[i]; return start + a0 + (a1 - a0) * (ct - b0) / (b1 - b0 || 1); }
  return start + keys.at(-1)![0];
}
const T = {
  start: at(PS, s1Start), rub: at(PS, rub), click: at(PCU, c2Click), done: at(PCU, c2Done), open: at(PCU, c2Open), ask: at(PCU, c2Ask),
  answered: at(PCU, c2Answered), end: at(PE, c3End), summary: at(PE, c3Summary), go: at(PH, c4Go), said: at(PH, c4Said),
};

const CAPTIONS: Array<[number, number, Record<Lang, [string, string]>]> = [
  [S1[0] + 0.3, T.start - 0.1, { zh: ['住在你的桌面角落', '浮在会议窗口上面 · 点不到它的地方照常点'], en: ['Lives in the corner of your desktop', 'Above every window · clicks pass right through'] }],
  [T.start, T.rub - 0.2, { zh: ['会议开始，它竖起耳朵认真听', '每一句都记进小本本'], en: ['The meeting starts: ears up', 'Every line goes into its little notebook'] }],
  [T.rub, S1[1], { zh: ['眼睛跟着鼠标转，摸摸头会害羞', ''], en: ['Eyes follow your cursor · loves a pat on the head', ''] }],
  [S2[0] + 0.2, T.click + 1.2, { zh: ['走神了？点工具栏上的 ✦', '帮我跟上'], en: ['Zoned out? Click ✦ on its toolbar', 'Catch me up'] }],
  [T.click + 1.2, T.done + 0.6, { zh: ['回答当场生成，写进卡片', '用的是你自己的 ChatGPT 或 Claude 订阅'], en: ['The answer is written live, into its card', 'On your own ChatGPT or Claude plan'] }],
  [T.done + 0.6, T.ask - 0.3, { zh: ['点开就能看全文', '每一点都标着出处'], en: ['Open it to read everything', 'Every point cites the moment it was said'] }],
  [T.ask - 0.3, S2[1], { zh: ['想问什么，直接问它', ''], en: ['Ask it anything', ''] }],
  [S3[0] + 0.2, T.summary + 0.2, { zh: ['开完会，在工具栏上结束', '总结自动写好'], en: ['End the meeting from its toolbar', 'The summary writes itself'] }],
  [T.summary + 0.2, S3[1], { zh: ['大小、显示什么，都能在设置里调', '设置 → 桌宠'], en: ['Size and what it shows: your choice', 'Settings → Desktop pet'] }],
  [S4[0] + 0.2, T.said, { zh: ['确认交接后，一键交给编程智能体', '在 Chumi 里审核交接 · 默认在 Codex app 里接着做'], en: ['Confirm the handoff, then hand it on in one click', 'Review it in Chumi · it continues in Codex app by default'] }],
  [T.said, OUTRO, { zh: ['交接已经填进 Codex app 的输入框', '你检查后点“发送”，它才开始'], en: ['The handoff waits in Codex app’s composer', 'Nothing starts until you click Send'] }],
];

// The camera: [time, zoom, focus x, focus y], eased between keys; it never shows past the desktop's edges.
// on(z, y): zoom z, centred on the pet page at CSS height y (the character is about 80–230, its toolbar 240–290,
// the cards below), so the card text is readable while it streams in.
const on = (z: number, y: number): [number, number, number] => { const d = toDesk(190 * 3, y * 3); return [z, d.x, d.y]; };
const CAMERA: Array<[number, number, number, number]> = [
  [0, 1, 960, 540], [S1[0] + 2.2, 1, 960, 540], [T.start + 0.3, ...on(1.9, 190)], [T.rub - 0.3, ...on(1.9, 190)], [T.rub + 0.4, ...on(2.6, 150)], [S1[1] - 0.3, ...on(2.6, 150)],
  [S2[0] + 0.6, ...on(2.3, 250)], [T.click + 0.8, ...on(2.3, 290)], [T.done - 0.3, ...on(1.95, 250)], [T.done + 0.9, ...on(1.95, 250)], [T.open + 0.4, ...on(1.75, 400)], [T.ask - 0.5, ...on(1.75, 400)],
  [T.ask + 0.4, ...on(2.1, 330)], [T.answered, ...on(1.75, 420)], [S2[1] - 0.3, ...on(1.75, 420)], [S3[0] + 0.6, ...on(2.3, 230)], [T.summary - 0.4, ...on(2.3, 230)],
  [T.summary + 0.6, ...on(2.6, 160)], [S3[1] - 0.3, ...on(2.6, 160)],
  [S4[0] + 0.5, ...on(2.2, 140)], [OUTRO - 0.6, ...on(2.2, 140)], [OUTRO, 1, 960, 540],
];
function cameraAt(t: number): { z: number; tx: number; ty: number } {
  let [, z, fx, fy] = CAMERA[0];
  for (let i = 1; i < CAMERA.length; i++) {
    const a = CAMERA[i - 1], b = CAMERA[i];
    if (t < a[0]) break;
    const u = inOut(seg(t, a[0], b[0]));
    z = lerp(a[1], b[1], u); fx = lerp(a[2], b[2], u); fy = lerp(a[3], b[3], u);
  }
  return { z, tx: clamp(W / 2 - fx * z, W - W * z, 0), ty: clamp(H / 2 - fy * z, H - H * z, 0) };
}

// ------------------------------------------------------------------ the drawn character (intro and outro)
type Ev = { t: number; run: (v: PetView) => void };
const mood = (t: number, m: Mood): Ev => ({ t, run: (v) => v.rig.setMood(m, t) });
const say = (t: number, s: Say): Ev => ({ t, run: (v) => v.say(s, t) });
const hush = (t: number): Ev => ({ t, run: (v) => v.hush(t) });
const EVENTS: Ev[] = [
  mood(0, 'held'), mood(0.72, 'idle'), { t: 0.72, run: (v: PetView) => v.rig.land(0.72) },
  mood(1.25, 'wave'), say(1.3, { text: line('hello') }), mood(2.9, 'idle'), hush(3.7),
  mood(OUTRO + 0.5, 'happy'), mood(OUTRO + 1.6, 'wave'), say(OUTRO + 1.7, { text: BYE[LANG] }), mood(OUTRO + 3.6, 'happy'),
].sort((a, b) => a.t - b.t);
/** The hero: dropping in at the centre, shrinking onto the desk's pet; and growing back out of it at the end. */
function heroPlace(t: number): { x: number; y: number; size: number; alpha: number } {
  const deskSize = petSize * 150 / 140, deskY = petCenter.y + deskSize * 0.42;
  if (t < 4.1) { const fall = seg(t, 0.25, 0.72); return { x: 960, y: 750 - 1000 * (1 - fall * fall), size: 500, alpha: 1 }; }
  if (t < OUTRO - 0.2) { const u = inOut(seg(t, 4.1, 4.85)); return { x: lerp(960, petCenter.x, u), y: lerp(750, deskY, u), size: lerp(500, deskSize, u), alpha: 1 - seg(t, 4.75, 4.95) }; }
  const u = inOut(seg(t, OUTRO, OUTRO + 0.8));
  return { x: lerp(petCenter.x, 600, u), y: lerp(deskY, 860, u), size: lerp(deskSize, 480, u), alpha: seg(t, OUTRO - 0.2, OUTRO) };
}

let view: PetView;
let applied = 0, lastT = -1;
function freshPet(): void { $('petLayer').innerHTML = ''; view = new PetView(150); $('petLayer').appendChild(view.el); applied = 0; lastT = -1; }
function stepPet(t: number): void {
  while (applied < EVENTS.length && EVENTS[applied].t <= t + 1e-6) EVENTS[applied++].run(view);
  const p = heroPlace(t);
  view.el.style.setProperty('--u', `${p.size / 150}px`);
  view.el.style.left = `${p.x}px`; view.el.style.top = `${p.y}px`; view.el.style.opacity = String(p.alpha);
  view.rig.look = null;
  view.draw(t);
  lastT = t;
}

// ------------------------------------------------------------------ static setup
document.querySelectorAll<HTMLElement>('[data-t]').forEach((e) => { e.textContent = TEXT[e.dataset.t!][LANG]; });
$('introTitle').innerHTML = TEXT.introTitle[LANG];
for (const id of ['introSub', 'outroTag', 'outroSub', 'outroFine']) $(id).textContent = TEXT[id][LANG];
const blobs = $('blobs');
const BLOB_COLORS = ['#f9a8d4', '#c4b5fd', '#a5f3fc', '#fde68a', '#bbf7d0'];
for (let i = 0; i < 16; i++) {
  const b = document.createElement('div');
  b.className = 'blob';
  const s = 40 + 150 * hash(i + 0.1);
  Object.assign(b.style, { width: `${s}px`, height: `${s}px`, background: BLOB_COLORS[i % 5], opacity: String(0.35 + 0.3 * hash(i + 0.4)) });
  blobs.appendChild(b);
}
for (let i = 0; i < 10; i++) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '-10 -10 20 20'); s.setAttribute('class', 'twinkle');
  s.innerHTML = '<path d="M0,-9 Q.9,-.9 9,0 Q.9,.9 0,9 Q-.9,.9 -9,0 Q-.9,-.9 0,-9 Z" fill="#FCD34D" stroke="#fff" stroke-width="1.2"/>';
  blobs.appendChild(s);
}
const foot = $('petFoot') as HTMLImageElement;
foot.src = frameAt(PS, 0);
Object.assign(foot.style, { left: `${FOOT_AT.x}px`, top: `${FOOT_AT.y}px`, width: `${1140 * FOOT_SCALE}px` });

// ------------------------------------------------------------------ render(t)
const style = (id: string, s: Partial<CSSStyleDeclaration>) => Object.assign($(id).style, s);
async function show(img: HTMLImageElement, src: string): Promise<void> { if (img.dataset.src === src) return; img.dataset.src = src; img.src = src; await img.decode().catch(() => {}); }

async function render(t: number): Promise<void> {
  if (!view || t < lastT - 1e-6 || t - lastT > 0.12) { freshPet(); for (let s = 0; s < t - 1e-6; s += 1 / 30) stepPet(s); }
  stepPet(t);

  const cam = cameraAt(t);
  style('camera', { transform: `translate(${cam.tx.toFixed(1)}px, ${cam.ty.toFixed(1)}px) scale(${cam.z.toFixed(4)})` });
  // The desk opens as a circle from the pet and closes back into it.
  const open = inOut(seg(t, 4.1, 4.75)), close = inOut(seg(t, OUTRO - 0.1, OUTRO + 0.55));
  const deskR = t < OUTRO - 0.1 ? open * 2300 : (1 - close) * 2300;
  const irisX = t < 20 ? 960 : petCenter.x, irisY = t < 20 ? 560 : petCenter.y;
  style('desk', { clipPath: `circle(${deskR.toFixed(1)}px at ${irisX}px ${irisY}px)`, visibility: deskR < 1 ? 'hidden' : 'visible' });
  [...$('blobs').children].forEach((b, i) => {
    const sp = 18 + 30 * hash(i + 0.9), x = 1920 * hash(i * 2.3) + 40 * Math.sin(t * 0.5 + i);
    const y = 1080 - ((t * sp + 1080 * hash(i + 0.2)) % 1300);
    (b as HTMLElement).style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(t * 40 * (hash(i) - 0.5)).toFixed(1)}deg) scale(${(0.7 + 0.3 * Math.sin(t * 2 + i)).toFixed(3)})`;
  });
  style('introTitle', { opacity: String(vis(t, 1.9, 4.15, 0.3)), transform: `translateY(${(30 * (1 - outBack(seg(t, 1.9, 2.4)))).toFixed(1)}px) scale(${(0.85 + 0.15 * outBack(seg(t, 1.9, 2.4))).toFixed(3)})` });
  style('introSub', { opacity: String(vis(t, 2.3, 4.15, 0.3)), transform: `translateY(${(24 * (1 - smooth(seg(t, 2.3, 2.7)))).toFixed(1)}px)` });
  const o = (a: number) => ({ opacity: String(seg(t, a, a + 0.35)), transform: `translateY(${(36 * (1 - outBack(seg(t, a, a + 0.45)))).toFixed(1)}px)` });
  style('outroLogo', o(OUTRO + 1.0)); style('outroWord', o(OUTRO + 1.2)); style('outroTag', o(OUTRO + 1.5)); style('outroSub', o(OUTRO + 1.75)); style('outroUrl', o(OUTRO + 2.1)); style('outroFine', o(OUTRO + 2.4));
  style('outro', { visibility: t > OUTRO + 0.2 ? 'visible' : 'hidden' });

  // The real pet on the desk.
  const waits: Promise<void>[] = [];
  const onDesk = t >= 4.75 && t < OUTRO;
  style('petFoot', { opacity: String(onDesk ? Math.min(seg(t, 4.75, 4.95), 1 - seg(t, OUTRO - 0.2, OUTRO)) : 0) });
  const { c, ct } = clipAt(t);
  if (onDesk) waits.push(show(foot, frameAt(c, ct)));

  // Menu bar: recording from the meeting's start to its end.
  const rec = vis(t, T.start, T.end + 0.4, 0.2);
  style('rec', { opacity: String(rec), transform: `scale(${(t < T.start + 0.4 ? outBack(seg(t, T.start, T.start + 0.4)) : 1).toFixed(3)})` });
  const secs = Math.max(0, Math.floor((t - T.start) * 2.5));
  $('recTime').textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  const talk = t > T.start && t < T.end ? 0.3 + 0.6 * Math.abs(Math.sin(t * 6.3)) * (0.55 + 0.45 * Math.sin(t * 1.7 + 1)) : 0;
  style('tMaya', { borderColor: `rgba(74, 222, 128, ${(0.35 + 0.65 * talk).toFixed(2)})`, boxShadow: `0 0 ${(24 * talk).toFixed(1)}px rgba(74,222,128,.45)` });

  // The recorded pointer, drawn where it was on the pet's page.
  const ptr = onDesk ? pointerAt(c, ct) : null;
  if (ptr) {
    const d = toDesk(ptr.x, ptr.y);
    style('cursor', { opacity: '1', transform: `translate(${(d.x - 8).toFixed(1)}px, ${(d.y - 5).toFixed(1)}px)` });
    if (ptr.since >= 0 && ptr.since < 0.45) { const u = ptr.since / 0.45; style('ripple', { opacity: String(1 - u), left: `${d.x - 15}px`, top: `${d.y - 15}px`, transform: `scale(${(0.6 + 2.2 * u).toFixed(3)})` }); }
    else style('ripple', { opacity: '0' });
  } else { style('cursor', { opacity: '0' }); style('ripple', { opacity: '0' }); }

  // Caption sticker.
  const cap = CAPTIONS.find(([a, b]) => t >= a - 0.01 && t < b);
  if (cap) {
    const [a, b, txt] = cap;
    $('capMain').textContent = txt[LANG][0]; $('capSub').textContent = txt[LANG][1];
    const s = spring(t - a) * (1 - smooth(seg(t, b - 0.18, b)));
    style('caption', { opacity: String(Math.min(1, (t - a) * 8) * (1 - seg(t, b - 0.18, b))), transform: `translateX(-50%) rotate(${(-1.5 + 0.6 * Math.sin(t * 1.3)).toFixed(2)}deg) scale(${s.toFixed(3)})` });
  } else style('caption', { opacity: '0' });
  await Promise.all(waits);
}

// Sounds for the soundtrack (scripts/make-pet-video.ts synthesises them).
const downs = (clip: Clip) => clip.events.filter((e) => e.type === 'down').map((e) => at(clip, e.t));
const SFX = ([
  [0.2, 'whoosh'], [0.72, 'boing'], [1.3, 'pop'], [1.95, 'sparkle'], [4.1, 'whoosh'], [S1[0] + 0.3, 'tick'],
  [T.start, 'bling'], [T.start + 0.1, 'pop'], [T.start + 1.6, 'scribble'], [T.rub + 0.6, 'hearts'], [T.rub + 1.6, 'pop'],
  ...downs(PCU).map((x) => [x, 'click']), [T.click + 0.2, 'think'], [T.done - 0.2, 'boing'], [T.done - 0.1, 'sparkle'],
  [T.ask - 1.6, 'scribble'], [T.answered, 'bling'],
  ...downs(PE).map((x) => [x, 'click']), [T.end + 0.3, 'pop'], [T.summary, 'confetti'], [T.summary + 0.1, 'pop'],
  [S4[0] + 0.2, 'tick'], ...downs(PH).map((x) => [x, 'click']), [T.said, 'bling'], [T.said + 0.05, 'pop'],
  [OUTRO, 'whoosh'], [OUTRO + 0.6, 'boing'], [OUTRO + 1.2, 'sparkle'], [OUTRO + 1.7, 'pop'],
] as Array<[number, string]>).sort((a, b) => a[0] - b[0]);
Object.assign(window, {
  render, DURATION, SFX, W, H,
  // The music: the groove starts as the desk opens, and the final chord lands with the outro's title.
  MUSIC: { groove: 4, end: OUTRO + 1.4 },
  POSTER_T: +(T.done + 0.3).toFixed(2),
  PREVIEW_T: [1.8, 4.4, S1[0] + 1.5, T.start + 1, T.rub + 1.2, T.click - 0.4, (T.click + T.done) / 2, T.done + 0.4, T.open + 1.5, (T.ask + T.answered) / 2, T.answered + 1.2, T.end + 0.8, T.summary + 1, T.go - 0.3, T.said + 1, OUTRO + 3].map((x) => +x.toFixed(2)),
});
void render(0);
