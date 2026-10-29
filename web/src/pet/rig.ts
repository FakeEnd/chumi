// The Chumi mascot: an SVG character and the rig that animates it. Shared by the desktop pet (web/pet.html) and the
// pet promo video (docs/video/pet/), so both show the same character.
//
// Every frame is a function of the time passed to draw(t) and of the events stamped with that same clock (setMood,
// tap, land, note). Nothing reads Date.now() or Math.random(), so the video renders identically every time.

import type { Mood } from './mood.ts';

export type { Mood };
type Eye = 'open' | 'happy' | 'closed' | 'x' | 'wide';
type Mouth = 'cat' | 'open' | 'o' | 'wavy' | 'tiny';

interface Pose {
  x: number; y: number; sx: number; sy: number; rot: number;   // body: offset, squash/stretch about the feet, tilt (deg)
  earL: number; earR: number; earS: number;                    // ear tilt outwards (deg) and length
  open: number; lookX: number; lookY: number; blush: number;   // eyelids 0–1, gaze −1…1
  armL: number; armR: number; footL: number; footR: number;    // raise outwards (deg)
  starY: number; starRot: number; starS: number; glow: number; starA: number;
  bars: number; pause: number; notepad: number; dots: number; zzz: number; sweat: number; hearts: number; sparkles: number; confetti: number; bang: number;
  eye: Eye; mouth: Mouth;
}
type Num = Exclude<keyof Pose, 'eye' | 'mouth'>;

const REST: Pose = {
  x: 0, y: 0, sx: 1, sy: 1, rot: 0, earL: 16, earR: 16, earS: 1, open: 1, lookX: 0, lookY: 0, blush: 0.5,
  armL: 0, armR: 0, footL: 0, footR: 0, starY: 0, starRot: 0, starS: 1, glow: 0, starA: 1,
  bars: 0, pause: 0, notepad: 0, dots: 0, zzz: 0, sweat: 0, hearts: 0, sparkles: 0, confetti: 0, bang: 0, eye: 'open', mouth: 'cat',
};
const NUMS = (Object.keys(REST) as Array<keyof Pose>).filter((k): k is Num => typeof REST[k] === 'number');
/** Moods that keep following the cursor with their eyes. */
const LOOKS: Partial<Record<Mood, number>> = { idle: 1, listen: 0.7, paused: 0.8, happy: 0.5, wave: 0.4, worried: 0.3 };

const TAU = Math.PI * 2;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (u: number) => { const v = clamp(u); return v * v * (3 - 2 * v); };
/** Deterministic noise in [0, 1). */
export const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
/** A hop that lasts `len` seconds: anticipation squash, flight, landing squash. Returns height (0–1) and squash. */
function hop(u: number, len: number): { h: number; squash: number } {
  if (u < 0 || u > len + 0.28) return { h: 0, squash: 0 };
  const pre = 0.09;
  if (u < pre) return { h: 0, squash: 0.1 * Math.sin((Math.PI / 2) * (u / pre)) };
  if (u < len) { const p = (u - pre) / (len - pre); return { h: Math.sin(Math.PI * p), squash: -0.07 * Math.sin(Math.PI * p) }; }
  const p = (u - len) / 0.28; return { h: 0, squash: 0.13 * Math.sin(Math.PI * p) * (1 - p * 0.4) };
}
/** Gaze (−1…1) towards a point `dx`, `dy` px from the eyes: saturates smoothly, so a far cursor still gets a sideways look. */
export const gaze = (dx: number, dy: number) => ({ x: clamp((dx / (Math.abs(dx) + 140)) * 1.35, -1, 1), y: clamp((dy / (Math.abs(dy) + 110)) * 1.3, -1, 1) });
/** Eyelids: a blink every few seconds, sometimes a double blink. */
function blink(t: number): number {
  const period = 3.7, k = Math.floor(t / period), d = t - k * period - hash(k) * (period - 0.6);
  const shut = (x: number) => (x >= 0 && x < 0.17 ? 1 - Math.sin(Math.PI * x / 0.17) : 1);
  return Math.min(shut(d), hash(k + 0.5) > 0.72 ? shut(d - 0.26) : 1);
}

function pose(mood: Mood, t: number, u: number, s: RigState): Pose {
  const p: Pose = { ...REST };
  const breath = Math.sin(TAU * t / 3.4);
  p.sy = 1 + 0.02 * breath; p.sx = 1 - 0.012 * breath;
  p.earL = 16 + 3 * Math.sin(t * 1.3); p.earR = 16 + 3 * Math.sin(t * 1.3 + 1.2);
  // Now and then one ear flicks.
  const fk = Math.floor(t / 6.5), fd = t - fk * 6.5 - hash(fk + 9) * 5;
  if (fd > 0 && fd < 0.35) { const f = 14 * Math.sin(Math.PI * fd / 0.35); if (hash(fk + 3) > 0.5) p.earL -= f; else p.earR -= f; }
  p.starY = 3 * Math.sin(t * 1.6); p.starRot = 8 * Math.sin(t * 0.9);
  p.armL = 3 * Math.sin(t * 1.7); p.armR = 3 * Math.sin(t * 1.7 + 0.8);
  // Idle eyes wander when nobody is pointing at Chumi.
  const wk = Math.floor(t / 3.1), wu = ease((t - wk * 3.1) / 0.5);
  const wx = (k: number) => (hash(k * 2.1) - 0.5) * 1.5 * (hash(k + 0.33) > 0.35 ? 1 : 0), wy = (k: number) => (hash(k * 3.7) - 0.6) * 0.8;
  p.lookX = wx(wk - 1) + (wx(wk) - wx(wk - 1)) * wu; p.lookY = wy(wk - 1) + (wy(wk) - wy(wk - 1)) * wu;

  switch (mood) {
    case 'idle': break;
    case 'sleep': {
      const b = Math.sin(TAU * t / 4.6);
      p.sy = 1 + 0.035 * b; p.sx = 1 - 0.022 * b; p.y = 2; p.rot = 3;
      p.eye = 'closed'; p.mouth = 'tiny'; p.earL = 50 + 2 * b; p.earR = 54 + 2 * b; p.earS = 0.95;
      p.starA = 0.45; p.starY = 12 + 2 * b; p.starRot = 10 * Math.sin(t * 0.3); p.zzz = 1; p.blush = 0.35;
      p.lookX = 0; p.lookY = 0.3; p.armL = 2 * b; p.armR = 2 * b; break;
    }
    case 'listen': {
      const lv = s.level;
      p.y = -lv * 3.5 * Math.abs(Math.sin(t * 7.5)); p.rot = 2.5 * Math.sin(t * 3.6) * (0.4 + lv);
      p.earL = 6 + lv * 7 * Math.sin(t * 21); p.earR = 6 + lv * 7 * Math.sin(t * 19 + 1); p.earS = 1.07;
      p.bars = 1;
      if (t - s.noteAt < 2.2) {  // a new line was transcribed: jot it down
        p.notepad = 1; p.lookX = 0.15; p.lookY = 0.95; p.armL = -38; p.armR = -32 + 6 * Math.sin(t * 16);
      }
      break;
    }
    case 'paused': p.open = 0.55; p.pause = 1; p.earL = 26; p.earR = 28; p.lookY = 0.25; break;
    case 'think': {
      p.starS = 1.25; p.starRot = u * 320; p.glow = 0.75 + 0.25 * Math.sin(t * 5); p.starY = -5 + 2 * Math.sin(t * 3);
      p.lookX = 0.55; p.lookY = -0.85; p.dots = 1; p.mouth = 'tiny'; p.rot = -4 + 1.5 * Math.sin(t * 2);
      p.armR = -48; p.earL = 12; p.earR = 9 + 3 * Math.sin(t * 7); break;
    }
    case 'happy': {
      const j = hop(u, 0.58);
      p.y = -24 * j.h; p.sy -= j.squash; p.sx += j.squash * 0.75;
      p.eye = 'happy'; p.mouth = 'open'; p.blush = 0.95; p.earL = 9 + 6 * Math.sin(t * 9); p.earR = 9 + 6 * Math.sin(t * 9 + 1);
      p.armL = 62 + 14 * Math.sin(t * 11); p.armR = 62 + 14 * Math.sin(t * 11 + 1.4); p.sparkles = clamp(1.8 - u * 0.6); break;
    }
    case 'celebrate': {
      const j = hop(u % 0.78, 0.5);
      p.y = -20 * j.h; p.sy -= j.squash; p.sx += j.squash * 0.75; p.rot = 6 * Math.sin(u * 4);
      p.eye = 'happy'; p.mouth = 'open'; p.blush = 1; p.confetti = 1; p.sparkles = 1;
      p.armL = 95 + 30 * Math.sin(t * 12); p.armR = 95 + 30 * Math.sin(t * 12 + Math.PI); p.earL = 8; p.earR = 8; p.starS = 1.2; p.glow = 0.6; break;
    }
    case 'worried': {
      p.x = u < 0.5 ? 1.2 * Math.sin(t * 46) * (1 - u * 2) : 0; p.sweat = 1; p.mouth = 'wavy'; p.open = 0.92;
      p.earL = 36; p.earR = 38; p.armL = -18; p.armR = -18; p.blush = 0.3; break;
    }
    case 'held': {
      p.sy = 1.07; p.sx = 0.95; p.y = -3; p.rot = clamp(s.swing, -1, 1) * 14 + 3 * Math.sin(t * 5);
      p.footL = 20 * Math.sin(t * 9); p.footR = -20 * Math.sin(t * 9 + 0.6); p.eye = 'x'; p.mouth = 'o';
      p.armL = 42 + 24 * Math.sin(t * 14); p.armR = 42 + 24 * Math.sin(t * 14 + 1.1); p.earL = 30 + 10 * Math.sin(t * 12); p.earR = 30 + 10 * Math.sin(t * 12 + 2); break;
    }
    case 'wave': {
      p.armR = 150 + 24 * Math.sin(u * 11); p.eye = 'happy'; p.mouth = 'open'; p.rot = 3 * Math.sin(u * 5.5); p.blush = 0.8;
      p.earL = 12; p.earR = 10; break;
    }
    case 'surprised': {
      const j = hop(u, 0.36);
      p.y = -12 * j.h; p.sy -= j.squash; p.sx += j.squash * 0.7; p.bang = clamp(u * 6); p.eye = 'wide'; p.mouth = 'o';
      p.earL = 3; p.earR = 3; p.earS = 1.12; p.armL = 34; p.armR = 34; break;
    }
  }
  return p;
}

export interface RigState { level: number; noteAt: number; swing: number }

const SPARKLES = [[34, 62], [170, 104], [52, 40], [160, 150]];
const OUT = '#2E2A78', INK = '#221D5C';
const svg = (id: string) => `
<svg class="chumi-pet" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" overflow="visible">
  <defs>
    <linearGradient id="${id}-body" x1=".15" y1="0" x2=".85" y2="1"><stop offset="0" stop-color="#9497FF"/><stop offset=".55" stop-color="#7C8CF8"/><stop offset="1" stop-color="#45C8DD"/></linearGradient>
    <linearGradient id="${id}-limb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8B95FB"/><stop offset="1" stop-color="#5BB8E6"/></linearGradient>
    <linearGradient id="${id}-star" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF3B0"/><stop offset="1" stop-color="#FBBF24"/></linearGradient>
    <radialGradient id="${id}-glow"><stop offset="0" stop-color="#FDE68A" stop-opacity=".95"/><stop offset="1" stop-color="#FDE68A" stop-opacity="0"/></radialGradient>
    <linearGradient id="${id}-wave" x1="0" x2="1"><stop offset="0" stop-color="#6366F1"/><stop offset="1" stop-color="#06B6D4"/></linearGradient>
  </defs>
  <ellipse data-k="shadow" cx="100" cy="182" rx="44" ry="6.5" fill="${INK}" opacity=".16"/>
  <g data-k="confetti"></g>
  <g data-k="rig">
    <g data-k="earL"><ellipse cx="0" cy="-25" rx="19" ry="27" fill="url(#${id}-limb)" stroke="${OUT}" stroke-width="3.2"/><ellipse cx="0" cy="-23" rx="10" ry="16.5" fill="#FFB9D6"/></g>
    <g data-k="earR"><ellipse cx="0" cy="-25" rx="19" ry="27" fill="url(#${id}-limb)" stroke="${OUT}" stroke-width="3.2"/><ellipse cx="0" cy="-23" rx="10" ry="16.5" fill="#FFB9D6"/></g>
    <path d="M100,80 C138,80 160,104 160,138 C160,167 137,179 100,179 C63,179 40,167 40,138 C40,104 62,80 100,80 Z" fill="url(#${id}-body)" stroke="${OUT}" stroke-width="3.2"/>
    <ellipse cx="100" cy="160" rx="31" ry="15" fill="#fff" opacity=".2"/>
    <ellipse cx="70" cy="101" rx="12" ry="6.5" fill="#fff" opacity=".55" transform="rotate(-32 70 101)"/>
    <circle cx="86" cy="91" r="3" fill="#fff" opacity=".55"/>
    <g data-k="face">
      <ellipse data-k="blushL" cx="64" cy="144" rx="9.5" ry="5.2" fill="#FF7EB0"/>
      <ellipse data-k="blushR" cx="136" cy="144" rx="9.5" ry="5.2" fill="#FF7EB0"/>
      ${['L', 'R'].map((s) => `<g data-k="eye${s}">
        <g data-k="open${s}"><ellipse cx="0" cy="0" rx="8.6" ry="10.8" fill="${INK}"/><circle cx="3" cy="-4.2" r="3.4" fill="#fff"/><circle cx="-2.9" cy="3.8" r="1.6" fill="#fff" opacity=".85"/></g>
        <path data-k="happy${s}" d="M-7.5,2.5 Q0,-7.5 7.5,2.5" fill="none" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/>
        <path data-k="closed${s}" d="M-7.5,-1 Q0,6 7.5,-1" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>
        <path data-k="x${s}" d="${s === 'L' ? 'M-6,-6.5 L5.5,0 L-6,6.5' : 'M6,-6.5 L-5.5,0 L6,6.5'}" fill="none" stroke="${INK}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
      </g>`).join('')}
      <g data-k="mouth">
        <path data-k="m-cat" d="M-6.5,-1.5 Q-3.2,3.2 0,-0.6 Q3.2,3.2 6.5,-1.5" fill="none" stroke="${INK}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <g data-k="m-open"><path d="M-6.5,-2 Q0,-0.5 6.5,-2 Q5.5,8.5 0,8.5 Q-5.5,8.5 -6.5,-2 Z" fill="#7A2453" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M-3.4,6.2 Q0,3.6 3.4,6.2 Q0,8.6 -3.4,6.2 Z" fill="#FF8FB5"/></g>
        <ellipse data-k="m-o" cx="0" cy="2" rx="3.6" ry="4.4" fill="#7A2453" stroke="${INK}" stroke-width="2"/>
        <path data-k="m-wavy" d="M-7,1.5 Q-3.5,-2.2 0,1.5 Q3.5,5.2 7,1.5" fill="none" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>
        <ellipse data-k="m-tiny" cx="0" cy="1" rx="2.2" ry="2.5" fill="#7A2453"/>
      </g>
    </g>
    <g data-k="notepad">
      <rect x="80" y="146" width="40" height="27" rx="4" fill="#fff" stroke="${OUT}" stroke-width="2.6"/>
      <path data-k="lines" stroke-dasharray="26 40" d="M87,155 H112 M87,161 H108 M87,167 H104" stroke="#A5B4FC" stroke-width="2.2" stroke-linecap="round"/>
      <g data-k="pencil"><rect x="-2.6" y="-15" width="5.2" height="17" rx="1.4" fill="#FCD34D" stroke="${OUT}" stroke-width="1.8"/><path d="M-2.6,2 L0,6.5 L2.6,2 Z" fill="${OUT}"/><rect x="-2.6" y="-18" width="5.2" height="4" rx="1.4" fill="#F9A8D4" stroke="${OUT}" stroke-width="1.8"/></g>
    </g>
    <g data-k="armL"><ellipse cx="0" cy="11" rx="9.5" ry="13" fill="url(#${id}-limb)" stroke="${OUT}" stroke-width="3"/></g>
    <g data-k="armR"><ellipse cx="0" cy="11" rx="9.5" ry="13" fill="url(#${id}-limb)" stroke="${OUT}" stroke-width="3"/></g>
    <g data-k="footL"><ellipse cx="0" cy="0" rx="13.5" ry="7.5" fill="url(#${id}-limb)" stroke="${OUT}" stroke-width="3"/></g>
    <g data-k="footR"><ellipse cx="0" cy="0" rx="13.5" ry="7.5" fill="url(#${id}-limb)" stroke="${OUT}" stroke-width="3"/></g>
  </g>
  <g data-k="star">
    <circle data-k="glow" r="26" fill="url(#${id}-glow)"/>
    <g data-k="spark"><path d="M0,-14 Q1.4,-1.4 14,0 Q1.4,1.4 0,14 Q-1.4,1.4 -14,0 Q-1.4,-1.4 0,-14 Z" fill="url(#${id}-star)" stroke="#E58E0B" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="10.5" cy="-10.5" r="2.6" fill="#FDE68A"/></g>
  </g>
  <g data-k="bubble">
    <path d="M14,82 H46 Q58,82 58,94 V104 Q58,116 46,116 H34 L27,124 L27,116 H14 Q2,116 2,104 V94 Q2,82 14,82 Z" fill="#fff" stroke="${OUT}" stroke-width="2.6" stroke-linejoin="round"/>
    <g data-k="bars">${[0, 1, 2, 3, 4].map((i) => `<rect data-k="bar${i}" x="${12.5 + i * 7.5}" width="4.6" rx="2.3" fill="url(#${id}-wave)"/>`).join('')}</g>
    <g data-k="pauseGlyph"><rect x="22.5" y="91" width="5" height="16" rx="2" fill="${OUT}"/><rect x="32.5" y="91" width="5" height="16" rx="2" fill="${OUT}"/></g>
  </g>
  <g data-k="dots">${[[148, 96, 3.2], [159, 81, 4.6], [173, 63, 7]].map(([x, y, r], i) => `<circle data-k="dot${i}" cx="${x}" cy="${y}" r="${r}" fill="#fff" stroke="${OUT}" stroke-width="2.2"/>`).join('')}</g>
  <g data-k="zzz">${[0, 1, 2].map((i) => `<text data-k="z${i}" font-family="ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', sans-serif" font-weight="800" fill="#6366F1" stroke="#fff" stroke-width="3" paint-order="stroke">z</text>`).join('')}</g>
  <g data-k="hearts">${[0, 1, 2].map((i) => `<path data-k="heart${i}" d="M0,3.5 C-6,-1 -6,-7 -2.2,-7 C-0.6,-7 0,-5.6 0,-4.8 C0,-5.6 0.6,-7 2.2,-7 C6,-7 6,-1 0,3.5 Z" fill="#FF6FA5" stroke="#fff" stroke-width="1.4"/>`).join('')}</g>
  <g data-k="sweat"><path d="M0,-9 C4,-3 6,1 6,4 A6,6 0 0 1 -6,4 C-6,1 -4,-3 0,-9 Z" fill="#A5DCFF" stroke="${OUT}" stroke-width="2"/></g>
  <g data-k="sparkles">${SPARKLES.map(([x, y], i) => `<path data-k="sp${i}" transform="translate(${x} ${y})" d="M0,-7 Q.7,-.7 7,0 Q.7,.7 0,7 Q-.7,.7 -7,0 Q-.7,-.7 0,-7 Z" fill="#FCD34D" stroke="#fff" stroke-width="1"/>`).join('')}</g>
  <g data-k="bang"><circle r="11" fill="#FB7185" stroke="${OUT}" stroke-width="2.4"/><rect x="-2" y="-7" width="4" height="8.5" rx="2" fill="#fff"/><circle cy="4.8" r="2.1" fill="#fff"/></g>
</svg>`;

const CONFETTI = ['#F472B6', '#FBBF24', '#34D399', '#60A5FA', '#A78BFA', '#FB7185'];
let instances = 0;

export class PetRig {
  readonly el: SVGSVGElement;
  /** Inputs the caller keeps current: smoothed audio level (0–1), gaze towards the cursor (or null), petting (0–1). */
  level = 0;
  look: { x: number; y: number } | null = null;
  petting = 0;
  swing = 0;
  private mood: Mood = 'idle';
  private prev: Mood = 'idle';
  private since = -10;
  private noteAt = -99;
  private tapAt = -99;
  private landAt = -99;
  private heartsAt = -99;
  private last = 0;
  private sm = { lookX: 0, lookY: 0, petting: 0, level: 0 };
  private attributes = new WeakMap<Element, Map<string, string>>();
  private n: Record<string, SVGElement> = {};

  constructor() {
    const host = document.createElement('div');
    host.innerHTML = svg(`chumi${++instances}`);
    this.el = host.firstElementChild as SVGSVGElement;
    this.el.querySelectorAll<SVGElement>('[data-k]').forEach((e) => { this.n[e.dataset.k!] = e; });
    const conf = this.n.confetti;
    for (let i = 0; i < 18; i++) {
      const r = document.createElementNS('http://www.w3.org/2000/svg', i % 3 ? 'rect' : 'circle');
      if (i % 3) { r.setAttribute('x', '-3'); r.setAttribute('y', '-1.8'); r.setAttribute('width', '6'); r.setAttribute('height', '3.6'); r.setAttribute('rx', '1'); } else r.setAttribute('r', '2.4');
      r.setAttribute('fill', CONFETTI[i % CONFETTI.length]);
      conf.appendChild(r);
    }
  }

  get current(): Mood { return this.mood; }
  setMood(mood: Mood, t: number): void {
    if (mood === this.mood) return;
    this.prev = this.mood; this.mood = mood; this.since = t;
  }
  /** A new transcript line: Chumi jots it in its notepad while listening. */
  note(t: number): void { this.noteAt = t; }
  tap(t: number): void { this.tapAt = t; this.heartsAt = t; }
  land(t: number): void { this.landAt = t; }

  draw(t: number, still = false): void {
    if (still) {
      const p = pose(this.mood, 0, 10, { level: 0, noteAt: -99, swing: 0 });
      if (this.look && LOOKS[this.mood]) { p.lookX = this.look.x; p.lookY = this.look.y; }
      this.sm = { lookX: p.lookX, lookY: p.lookY, petting: 0, level: 0 }; this.last = t;
      this.apply(p, 0);
      return;
    }
    const dt = clamp(t - this.last, 0, 0.1); this.last = t;
    const k = (rate: number) => 1 - Math.exp(-rate * dt);
    this.sm.level += (this.level - this.sm.level) * k(10);
    this.sm.petting += (this.petting - this.sm.petting) * k(this.petting > this.sm.petting ? 6 : 2.5);
    const state: RigState = { level: clamp(this.sm.level), noteAt: this.noteAt, swing: this.swing };
    const u = t - this.since, w = ease(u / 0.28);
    const a = pose(this.prev, t, u + 10, state), b = pose(this.mood, t, u, state);
    const p: Pose = { ...b };
    for (const key of NUMS) p[key] = a[key] + (b[key] - a[key]) * w;
    if (w < 0.5) { p.eye = a.eye; p.mouth = a.mouth; }

    // Gaze: towards the cursor in moods that look around, smoothed so the eyes glide.
    const lookW = (LOOKS[this.mood] ?? 0) * (p.notepad > 0.5 ? 0 : 1);
    if (this.look && lookW) { p.lookX += (clamp(this.look.x, -1, 1) - p.lookX) * lookW; p.lookY += (clamp(this.look.y, -1, 1) - p.lookY) * lookW; }
    this.sm.lookX += (p.lookX - this.sm.lookX) * k(9); this.sm.lookY += (p.lookY - this.sm.lookY) * k(9);
    p.lookX = this.sm.lookX; p.lookY = this.sm.lookY;

    // Petting: happy eyes, ears back, blushing, hearts.
    const pet = this.sm.petting;
    if (pet > 0.02 && this.mood !== 'held' && this.mood !== 'sleep') {
      if (pet > 0.45 && (p.eye === 'open' || p.eye === 'wide')) p.eye = 'happy';
      p.blush = Math.max(p.blush, 0.5 + pet * 0.5); p.earL += pet * 22; p.earR += pet * 22; p.hearts = Math.max(p.hearts, pet);
      p.rot += pet * 3 * Math.sin(t * 4); p.sy -= pet * 0.03;
    }
    const tu = t - this.tapAt;
    if (tu < 0.45) { const s = 0.12 * Math.sin(Math.PI * tu / 0.45) * (1 - tu); p.sy -= s; p.sx += s * 0.8; }
    if (t - this.heartsAt < 1.6) p.hearts = Math.max(p.hearts, 1 - (t - this.heartsAt) / 1.6);
    const lu = t - this.landAt;
    if (lu < 0.42) { const s = 0.16 * Math.sin(Math.PI * lu / 0.42) * (1 - lu * 1.2); p.sy -= s; p.sx += s * 0.8; }
    if (p.eye === 'open' || p.eye === 'wide') p.open *= blink(t);

    this.apply(p, t);
  }

  private set(e: Element, key: string, value: string | number): void {
    let attrs = this.attributes.get(e);
    if (!attrs) { attrs = new Map(); this.attributes.set(e, attrs); }
    const text = String(value);
    if (attrs.get(key) === text) return;
    attrs.set(key, text); e.setAttribute(key, text);
  }

  private apply(p: Pose, t: number): void {
    const n = this.n, set = (e: Element, k: string, v: string | number) => this.set(e, k, v);
    const f = (v: number) => v.toFixed(2);
    const show = (e: SVGElement, v: number) => { const opacity = f(clamp(v)); set(e, 'opacity', opacity); return opacity !== '0.00'; };
    set(n.rig, 'transform', `translate(${f(p.x)} ${f(p.y)}) translate(100 179) rotate(${f(p.rot)}) scale(${f(p.sx)} ${f(p.sy)}) translate(-100 -179)`);
    set(n.shadow, 'transform', `translate(100 182) scale(${f(clamp(1 + p.y / 60, 0.55, 1.1) * p.sx)} 1) translate(-100 -182)`);
    show(n.shadow, 0.16 * clamp(1 + p.y / 50, 0.4, 1));
    set(n.earL, 'transform', `translate(72 94) rotate(${f(-p.earL)}) scale(1 ${f(p.earS)})`);
    set(n.earR, 'transform', `translate(128 94) rotate(${f(p.earR)}) scale(1 ${f(p.earS)})`);
    set(n.armL, 'transform', `translate(47 138) rotate(${f(p.armL)})`);
    set(n.armR, 'transform', `translate(153 138) rotate(${f(-p.armR)})`);
    set(n.footL, 'transform', `translate(79 177) rotate(${f(p.footL)})`);
    set(n.footR, 'transform', `translate(121 177) rotate(${f(p.footR)})`);
    set(n.face, 'transform', `translate(${f(p.lookX * 3.4)} ${f(p.lookY * 2.6)})`);
    for (const s of ['L', 'R'] as const) {
      set(n[`eye${s}`], 'transform', `translate(${f((s === 'L' ? 79 : 121) + p.lookX * 1.6)} ${f(129 + p.lookY * 1.4)})`);
      const wide = p.eye === 'wide' ? 1.16 : 1;
      if (show(n[`open${s}`], p.eye === 'open' || p.eye === 'wide' ? 1 : 0)) set(n[`open${s}`], 'transform', `scale(${f(wide)} ${f(Math.max(0.08, p.open) * wide)})`);
      show(n[`happy${s}`], p.eye === 'happy' ? 1 : 0); show(n[`closed${s}`], p.eye === 'closed' ? 1 : 0); show(n[`x${s}`], p.eye === 'x' ? 1 : 0);
      show(n[`blush${s}`], p.blush * 0.62);
    }
    set(n.mouth, 'transform', `translate(100 ${f(145 + p.lookY * 0.8)})`);
    for (const m of ['cat', 'open', 'o', 'wavy', 'tiny']) show(n[`m-${m}`], p.mouth === m ? 1 : 0);

    // The star floats above the head and follows it as the body squashes.
    const headTop = 179 - 99 * p.sy + p.y;
    set(n.star, 'transform', `translate(${f(100 + p.x + p.rot * 0.9)} ${f(headTop - 27 + p.starY)})`);
    set(n.spark, 'transform', `rotate(${f(p.starRot)}) scale(${f(p.starS)})`);
    show(n.spark, p.starA); if (show(n.glow, p.glow)) set(n.glow, 'transform', `scale(${f(0.85 + 0.15 * Math.sin(t * 6))})`);

    // Listening bubble: the logo's speech bubble, its bars following the room's audio level.
    if (show(n.bubble, Math.max(p.bars, p.pause))) set(n.bubble, 'transform', `translate(${f(p.x * 0.6)} ${f(p.y * 0.5 + 2 * Math.sin(t * 2.2))})`);
    const lv = clamp(this.sm.level);
    show(n.pauseGlyph, p.pause * (1 - p.bars));
    if (show(n.bars, p.bars)) for (let i = 0; i < 5; i++) {
      const env = [0.55, 0.8, 1, 0.8, 0.55][i];
      const h = 4 + 20 * env * clamp(0.16 + 0.08 * Math.sin(t * 3.1 + i * 1.3) + lv * (0.55 + 0.45 * Math.sin(t * (9 + i * 2.3) + i * 1.7)));
      set(n[`bar${i}`], 'height', f(h)); set(n[`bar${i}`], 'y', f(99 - h / 2));
    }

    if (show(n.notepad, p.notepad)) {
      set(n.pencil, 'transform', `translate(${f(102 + 9 * Math.sin(t * 13))} ${f(160 + 2.5 * Math.sin(t * 26))}) rotate(28)`);
      set(n.lines, 'stroke-dashoffset', f(26 - 26 * clamp(((t - this.noteAt) / 1.8) % 1.2)));
    }

    if (show(n.dots, p.dots)) for (let i = 0; i < 3; i++) show(n[`dot${i}`], (t * 1.5) % 1.2 > i * 0.3 ? 1 : 0.15);

    if (show(n.zzz, p.zzz)) for (let i = 0; i < 3; i++) {
      const q = (t * 0.42 + i / 3) % 1, z = n[`z${i}`];
      set(z, 'x', f(142 + 22 * q + 3 * Math.sin(q * 9))); set(z, 'y', f(98 - 52 * q)); set(z, 'font-size', f(11 + 13 * q));
      show(z, Math.sin(Math.PI * q));
    }
    if (show(n.hearts, p.hearts)) for (let i = 0; i < 3; i++) {
      const q = (t * 0.7 + i / 3) % 1, x = [62, 104, 142][i] + 8 * Math.sin(q * 7 + i);
      set(n[`heart${i}`], 'transform', `translate(${f(x)} ${f(headTop + 8 - 50 * q)}) scale(${f(0.9 + 0.6 * q)})`);
      show(n[`heart${i}`], Math.sin(Math.PI * q));
    }
    if (show(n.sweat, p.sweat)) set(n.sweat, 'transform', `translate(${f(150 + p.x)} ${f(headTop + 30 + 5 * ((t * 0.9) % 1))})`);
    if (show(n.sparkles, p.sparkles)) for (let i = 0; i < SPARKLES.length; i++) {
      const [x, y] = SPARKLES[i];
      set(n[`sp${i}`], 'transform', `translate(${x} ${y}) scale(${f(0.35 + 0.65 * Math.abs(Math.sin(t * 4 + i * 1.9)))})`);
    }
    if (show(n.bang, p.bang)) set(n.bang, 'transform', `translate(${f(150 + p.x)} ${f(headTop - 6)}) scale(${f(ease(p.bang * 1.4) * (1 + 0.15 * Math.sin(t * 14) * p.bang))})`);

    if (show(n.confetti, p.confetti)) {
      [...n.confetti.children].forEach((c, i) => {
        const speed = 0.35 + 0.3 * hash(i + 0.3), q = (t * speed + hash(i + 0.7)) % 1;
        const x = 12 + 176 * hash(i * 1.7) + 10 * Math.sin(t * 2 + i), y = -12 + 196 * q;
        set(c, 'transform', `translate(${f(x)} ${f(y)}) rotate(${f(t * 260 * (hash(i + 2.2) - 0.5))})`);
        set(c, 'opacity', f(Math.min(1, (1 - q) * 3)));
      });
    }
  }
}
